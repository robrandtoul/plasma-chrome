-- Migration 000078: orphan reconciliation for proof_name_approvals
--
-- Two triggers that keep proof_name_approvals in sync with its
-- underlying entities when those change in-place. Version deletes
-- already cascade via the existing FK (ON DELETE CASCADE), so only
-- in-place edits need trigger coverage:
--
--   Trigger 1 — names reconciliation
--     Fires AFTER UPDATE on proof_versions when names[] changes.
--     Deletes approval rows whose name is no longer in the new
--     names[]. Guards against accidentally nuking the sentinel by
--     excluding rows with name = '__shared__'.
--
--   Trigger 2 — shared reconciliation
--     Fires AFTER UPDATE OR DELETE on proof_version_images. Only
--     does work when a shared image (associated_name IS NULL) was
--     deleted or had its associated_name set to non-null. If no
--     shared images remain for the version, deletes the
--     '__shared__' approval row for that version.
--
-- Both trigger functions are SECURITY DEFINER so they can INSERT
-- into audit_log, which has no INSERT policy (writes normally go
-- via the log_audit_event / log_customer_event SECURITY DEFINER
-- RPCs per 000043). auth.uid() inside the trigger resolves to the
-- designer making the edit; NULL when the edit arrives from a
-- service-role or other non-session context, which reads as a
-- "system" event in the audit view.

begin;

-- ── Trigger 1: names reconciliation ──────────────────────────────────────────

create or replace function reconcile_name_approvals_on_names_change()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_proof_id uuid;
begin
  -- Resolve the parent proof_id once for audit entries. Cheap
  -- lookup via primary key; the version row we're firing on has
  -- proof_id directly on it.
  v_proof_id := new.proof_id;

  -- Delete orphaned per-name approval rows and capture them for
  -- audit logging in one CTE. The '__shared__' guard is essential
  -- — the shared sentinel row shouldn't be touched by this trigger,
  -- which only cares about the names[] array.
  with deleted as (
    delete from proof_name_approvals
    where proof_version_id = new.id
      and name <> '__shared__'
      and name <> all(new.names)
    returning *
  )
  insert into audit_log (
    actor_id, action, target_type, target_id, target_label,
    before_value, metadata
  )
  select
    auth.uid(),
    'approval.orphan_cleanup',
    'proof_version_name_approval',
    d.id::text,
    format('v%s / %s', new.version_number, d.name),
    to_jsonb(d),
    jsonb_build_object(
      'reason', 'name_removed',
      'proof_version_id', new.id,
      'proof_id', v_proof_id
    )
  from deleted d;

  return new;
end;
$$;

create trigger proof_versions_reconcile_name_approvals
  after update on proof_versions
  for each row
  when (old.names is distinct from new.names)
  execute function reconcile_name_approvals_on_names_change();

-- ── Trigger 2: shared reconciliation ─────────────────────────────────────────

create or replace function reconcile_shared_approval_on_images_change()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_version_id uuid;
  v_version_number int;
  v_proof_id uuid;
  v_still_has_shared boolean;
begin
  -- Guard 1: only fire if the changed row was shared before. If
  -- OLD.associated_name was non-null, this operation can't orphan
  -- the shared sentinel.
  if old.associated_name is not null then
    return coalesce(new, old);
  end if;

  -- Guard 2: for UPDATE, skip if the row is still shared after the
  -- change. image_path / sort_order edits on a shared image don't
  -- affect shared presence.
  if tg_op = 'UPDATE' and new.associated_name is null then
    return new;
  end if;

  v_version_id := old.proof_version_id;

  -- Check whether any shared images remain for this version. If
  -- any do, nothing to reconcile. If none, the '__shared__' row
  -- (if it exists) is an orphan and gets deleted.
  select exists (
    select 1 from proof_version_images
    where proof_version_id = v_version_id
      and associated_name is null
  ) into v_still_has_shared;

  if v_still_has_shared then
    return coalesce(new, old);
  end if;

  -- Resolve version_number + proof_id for audit. The version might
  -- have just been deleted in a cascade scenario (version DELETE
  -- cascades to its images before we fire here), but since the
  -- proof_name_approvals row cascades from the same FK, the
  -- DELETE below would be a no-op in that case — audit included
  -- only when the version still exists.
  select version_number, proof_id
    into v_version_number, v_proof_id
    from proof_versions
    where id = v_version_id;

  if v_version_number is null then
    -- Version already gone. Cascade handles the approval row;
    -- skip audit and exit cleanly.
    return coalesce(new, old);
  end if;

  with deleted as (
    delete from proof_name_approvals
    where proof_version_id = v_version_id
      and name = '__shared__'
    returning *
  )
  insert into audit_log (
    actor_id, action, target_type, target_id, target_label,
    before_value, metadata
  )
  select
    auth.uid(),
    'approval.orphan_cleanup',
    'proof_version_name_approval',
    d.id::text,
    format('v%s / Shared', v_version_number),
    to_jsonb(d),
    jsonb_build_object(
      'reason', 'shared_images_removed',
      'proof_version_id', v_version_id,
      'proof_id', v_proof_id
    )
  from deleted d;

  return coalesce(new, old);
end;
$$;

create trigger proof_version_images_reconcile_shared_approval
  after update or delete on proof_version_images
  for each row
  execute function reconcile_shared_approval_on_images_change();

-- ── One-shot cleanup of pre-existing orphans ─────────────────────────────────
-- Silent — no audit rows for pre-migration state. Separate audit
-- noise for "system bootstrap deletion" would muddy the log
-- without adding debugging value.

delete from proof_name_approvals a
where a.name <> '__shared__'
  and not exists (
    select 1 from proof_versions v
    where v.id = a.proof_version_id
      and a.name = any(v.names)
  );

delete from proof_name_approvals a
where a.name = '__shared__'
  and not exists (
    select 1 from proof_version_images i
    where i.proof_version_id = a.proof_version_id
      and i.associated_name is null
  );

commit;
