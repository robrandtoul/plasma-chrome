-- Migration 000128: implicit Shared in auto-finalize predicate.
--
-- Background. 000126 installed maybe_finalize_proof_status(), a
-- trigger on proof_name_approvals that flips proof.status to
-- 'approved' once every required slot on the current version is
-- approved. Required slots = names[] + the '__shared__' sentinel
-- iff the current version has any associated_name=null images.
--
-- That model assumed Shared on a split-name project would be
-- approved by the customer hitting an Approve button in the shared
-- section. Phase 2.5 of the customer page (see
-- src/lib/sharedApproval.ts and CustomerProofPage.renderSharedInfoBand)
-- removes that button — the shared back/section is now approved-by-
-- implication once every named recipient approves. The __shared__
-- approval row is no longer written on split-name projects.
--
-- Without this migration, the trigger never sees __shared__ approved
-- on split-name+shared projects, so v_approved_slots stays one short
-- of v_required_slots and proof.status never flips. Designer "Mark
-- as approved" regresses from belt-and-braces to required-again.
--
-- Change. __shared__ counts as a required slot only when the current
-- version has zero names — the all-shared one-off path, where the
-- customer Approve button on the shared section is still live and
-- still writes the __shared__ row with the approved_* columns. For
-- split-name projects (names non-empty), __shared__ rows are
-- excluded from both the required-slot count and the approved-slot
-- count; Shared completion is implicit in the names predicate.
--
-- Refactor. The check-and-flip logic is lifted out of the trigger
-- into _finalize_proof_if_complete(uuid). The trigger function is
-- now a thin wrapper that resolves proof_id from NEW and PERFORMs
-- the helper; the backfill at the bottom iterates candidate proofs
-- and calls the same helper. One source of truth for the predicate.

begin;

-- ── Helper: per-proof check + flip ───────────────────────────────
create or replace function _finalize_proof_if_complete(p_proof_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current_version_id  uuid;
  v_current_names       text[];
  v_has_shared          boolean;
  v_names_count         int;
  v_required_slots      int;
  v_approved_slots      int;
  v_proof_status        text;
begin
  -- Only finalize in_progress / dormant proofs
  select status
    into v_proof_status
    from proofs
    where id = p_proof_id;

  if v_proof_status not in ('in_progress', 'dormant') then
    return;
  end if;

  -- Load current version
  select id, names
    into v_current_version_id, v_current_names
    from proof_versions
    where proof_id = p_proof_id and is_current = true
    limit 1;

  if v_current_version_id is null then
    return;
  end if;

  v_names_count := coalesce(array_length(v_current_names, 1), 0);

  -- Shared images on the current version
  select exists (
    select 1
      from proof_version_images
      where proof_version_id = v_current_version_id
        and associated_name is null
  ) into v_has_shared;

  -- Required slots:
  --   * one per name, always
  --   * plus '__shared__' iff has_shared AND names is empty
  --     (the all-shared one-off path)
  -- Split-name + shared projects: Shared is approved-by-implication
  -- once every name approves, so we don't add it as a required slot.
  v_required_slots := v_names_count
    + case when v_has_shared and v_names_count = 0 then 1 else 0 end;

  if v_required_slots = 0 then
    return;
  end if;

  -- Approved-slot count uses the same exclusion rule on '__shared__':
  -- only counts when names is empty. Carry-forwards count toward
  -- completeness; rows whose name is no longer a slot on the current
  -- version are ignored (defensive against drift).
  select count(*)
    into v_approved_slots
    from proof_name_approvals pna
    where pna.proof_version_id = v_current_version_id
      and pna.state = 'approved'
      and (
        (pna.name = '__shared__' and v_has_shared and v_names_count = 0)
        or (pna.name = any(v_current_names))
      );

  if v_approved_slots >= v_required_slots then
    update proofs
      set status = 'approved',
          approved_at = now()
      where id = p_proof_id
        and status in ('in_progress', 'dormant');
  end if;
end;
$$;

comment on function _finalize_proof_if_complete(uuid) is
  'Per-proof slot-completeness check used by the auto-finalize trigger '
  'and its sibling backfills. __shared__ counts as a required slot only '
  'when the current version has no named recipients (the all-shared '
  'one-off path); for split-name projects Shared is approved-by-implication.';

-- ── Trigger function: thin wrapper ───────────────────────────────
create or replace function maybe_finalize_proof_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_proof_id uuid;
begin
  select pv.proof_id
    into v_proof_id
    from proof_versions pv
    where pv.id = new.proof_version_id;

  if v_proof_id is null then
    return new;
  end if;

  perform _finalize_proof_if_complete(v_proof_id);
  return new;
end;
$$;

comment on function maybe_finalize_proof_status() is
  'After a direct customer approval on proof_name_approvals, defer to '
  '_finalize_proof_if_complete() to flip the parent proof to approved if '
  'every required slot on the current version is approved. Skips carry-'
  'forward writes (designer-driven) and never overrides abandoned or '
  'already-approved proofs.';

-- Trigger spec is identical to 000126's. Re-create for completeness
-- so this migration is self-contained.
drop trigger if exists trg_maybe_finalize_proof_status on proof_name_approvals;
create trigger trg_maybe_finalize_proof_status
  after insert or update of state on proof_name_approvals
  for each row
  when (new.state = 'approved' and new.carried_from_version_id is null)
  execute function maybe_finalize_proof_status();

-- ── Backfill ─────────────────────────────────────────────────────
-- Iterate candidate proofs and run the helper for each. Catches
-- split-name+shared proofs that are stuck in_progress under 000126's
-- old rule (every name approved, but no __shared__ row written under
-- the new customer flow) — they should now flip immediately.
do $$
declare
  r record;
begin
  for r in
    select p.id
      from proofs p
     where p.status in ('in_progress', 'dormant')
  loop
    perform _finalize_proof_if_complete(r.id);
  end loop;
end$$;

commit;
