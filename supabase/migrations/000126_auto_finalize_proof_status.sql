-- Auto-finalize proof.status to 'approved' when every required name
-- slot on the proof's current version has a customer approval.
--
-- Background. A proof's project-level status was previously only
-- ever flipped to 'approved' by the designer hitting the "Mark as
-- approved" button on /proofs/:id. Customer per-name approvals
-- (proof_name_approvals + proof_events) recorded the per-recipient
-- state but the project pill stayed 'In progress' until a designer
-- closed it manually. For single-name projects (the common case)
-- that double-tap was redundant.
--
-- This migration installs a Postgres trigger that fires after every
-- INSERT or UPDATE on proof_name_approvals where the new row is a
-- direct customer approval (state='approved' AND carried_from_version_id
-- IS NULL). The trigger:
--
--   1. Resolves the proof_id from the approval's version.
--   2. Bails unless the proof is currently in_progress or dormant
--      (never overrides 'abandoned' or already-'approved').
--   3. Loads the proof's CURRENT version (is_current = true) — the
--      only version the customer is allowed to act on, and the only
--      version whose slot completeness drives project status.
--   4. Computes required slots: pv.names[] plus the '__shared__'
--      sentinel iff the current version has any associated_name=null
--      images (mirrors the UI rule in CustomerProofPage.tsx — see
--      currentSlotIdentities).
--   5. Counts proof_name_approvals rows on the current version with
--      state='approved' whose name matches one of those slots —
--      includes carry-forward rows (counts toward completeness) but
--      ignores stale rows whose name no longer corresponds to a slot
--      on the current version (defensive against drift).
--   6. If every slot is approved, UPDATE proofs SET status='approved',
--      approved_at = now() for that proof.
--
-- Carry-forward writes are deliberately excluded from triggering the
-- check (NEW.carried_from_version_id IS NULL guard) — creating a new
-- version with carried approvals is a designer action and should
-- never short-circuit the designer's review of the new version.
-- The check itself, however, COUNTS carry-forwards toward completeness,
-- so a customer approving the last open slot on a version where other
-- slots already had carry-forward approvals still triggers the flip.
--
-- A backfill UPDATE at the bottom flips any proof whose current
-- version is already fully approved as of this migration — catches
-- the historical case where the trigger didn't yet exist.

create or replace function maybe_finalize_proof_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_proof_id            uuid;
  v_current_version_id  uuid;
  v_current_names       text[];
  v_has_shared          boolean;
  v_required_slots      int;
  v_approved_slots      int;
  v_proof_status        text;
begin
  -- 1. Resolve proof_id
  select pv.proof_id
    into v_proof_id
    from proof_versions pv
    where pv.id = new.proof_version_id;

  if v_proof_id is null then
    return new;
  end if;

  -- 2. Only finalize in_progress / dormant proofs
  select status
    into v_proof_status
    from proofs
    where id = v_proof_id;

  if v_proof_status not in ('in_progress', 'dormant') then
    return new;
  end if;

  -- 3. Load current version
  select id, names
    into v_current_version_id, v_current_names
    from proof_versions
    where proof_id = v_proof_id and is_current = true
    limit 1;

  if v_current_version_id is null then
    return new;
  end if;

  -- 4. Compute required slot count: names[] + shared if any
  --    associated_name=null images on the current version
  select exists (
    select 1
      from proof_version_images
      where proof_version_id = v_current_version_id
        and associated_name is null
  ) into v_has_shared;

  v_required_slots := coalesce(array_length(v_current_names, 1), 0)
    + case when v_has_shared then 1 else 0 end;

  if v_required_slots = 0 then
    return new;
  end if;

  -- 5. Count approved slots on the current version (including
  --    carry-forwards) that match an active slot identity
  select count(*)
    into v_approved_slots
    from proof_name_approvals pna
    where pna.proof_version_id = v_current_version_id
      and pna.state = 'approved'
      and (
        (pna.name = '__shared__' and v_has_shared)
        or (pna.name = any(v_current_names))
      );

  -- 6. Flip if complete
  if v_approved_slots >= v_required_slots then
    update proofs
      set status = 'approved',
          approved_at = now()
      where id = v_proof_id
        and status in ('in_progress', 'dormant');
  end if;

  return new;
end;
$$;

comment on function maybe_finalize_proof_status() is
  'After a direct customer approval on proof_name_approvals, flip the '
  'parent proof to status=approved if every required slot on the current '
  'version is approved. Mirrors the UI gate in CustomerProofPage. Skips '
  'carry-forward writes (designer-driven) and never overrides abandoned '
  'or already-approved proofs.';

drop trigger if exists trg_maybe_finalize_proof_status on proof_name_approvals;

create trigger trg_maybe_finalize_proof_status
  after insert or update of state on proof_name_approvals
  for each row
  when (new.state = 'approved' and new.carried_from_version_id is null)
  execute function maybe_finalize_proof_status();

-- ── Backfill ─────────────────────────────────────────────────────────────
-- Flip any in_progress / dormant proof whose current version already
-- meets the completeness rule. This catches approvals that landed
-- before the trigger existed.
with current_versions as (
  select pv.id            as version_id,
         pv.proof_id      as proof_id,
         pv.names         as names,
         exists (
           select 1 from proof_version_images pvi
            where pvi.proof_version_id = pv.id
              and pvi.associated_name is null
         )                as has_shared
    from proof_versions pv
    join proofs p on p.id = pv.proof_id
   where pv.is_current = true
     and p.status in ('in_progress', 'dormant')
),
slot_counts as (
  select cv.proof_id,
         cv.version_id,
         coalesce(array_length(cv.names, 1), 0)
           + case when cv.has_shared then 1 else 0 end as required_slots,
         (
           select count(*)
             from proof_name_approvals pna
            where pna.proof_version_id = cv.version_id
              and pna.state = 'approved'
              and (
                (pna.name = '__shared__' and cv.has_shared)
                or (pna.name = any(cv.names))
              )
         ) as approved_slots
    from current_versions cv
)
update proofs p
   set status = 'approved',
       approved_at = now()
  from slot_counts sc
 where p.id = sc.proof_id
   and sc.required_slots > 0
   and sc.approved_slots >= sc.required_slots;
