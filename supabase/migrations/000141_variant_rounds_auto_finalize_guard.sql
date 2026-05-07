-- Migration 000141: variant rounds — defensive guard in
-- maybe_finalize_proof_status (build-plan step 6).
--
-- The trigger from 000126 (refactored in 000128) flips proof.status
-- to 'approved' once every required slot on the current version is
-- approved. The trigger fires only `when (new.state = 'approved' and
-- new.carried_from_version_id is null)`. Variant rounds (000138)
-- emit `state='changes_requested'` exclusively — the proof-action
-- edge function rejects 'approve' on variant-round versions — so the
-- trigger logically can't fire on a variant round today.
--
-- This migration installs an early-return at the top of the trigger
-- function as defence in depth: if a future schema drift, hand-edit,
-- or designer-override path were to leak an `approved` row into a
-- variant round, the guard prevents the rest of the function from
-- treating that row as a real per-recipient approval and (worst
-- case) flipping the project to status='approved'. The check is one
-- by-id lookup on proof_versions — no measurable overhead on the
-- hot path for standard versions.
--
-- Function body is otherwise identical to the 000128 definition; the
-- early-return lands above the existing proof_id resolution. Trigger
-- spec is unchanged from 000128.

begin;

create or replace function maybe_finalize_proof_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_proof_id uuid;
begin
  -- ── Variant-round defensive guard (000141) ──────────────────────
  -- The trigger's WHEN clause restricts firings to direct customer
  -- approvals (state='approved', carried_from_version_id IS NULL).
  -- Variant rounds never produce that shape today (000138 + the
  -- proof-action edge function reject 'approve'), but if a future
  -- code path or hand-edit ever did, finalising the proof against
  -- per-recipient slot logic would be wrong: variant rounds have
  -- empty names[] so the slot computation collapses and could leak
  -- an unintended status flip. Bail early.
  if exists (
    select 1 from proof_versions
    where id = new.proof_version_id and is_variant_round = true
  ) then
    return new;
  end if;

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
  '_finalize_proof_if_complete() to flip the parent proof to approved '
  'if every required slot on the current version is approved. Skips '
  'carry-forward writes (designer-driven) and never overrides abandoned '
  'or already-approved proofs. Variant-round versions (000138) bail '
  'before the slot logic — defence in depth even though the trigger''s '
  'WHEN clause already filters out the only event_type they can produce.';

-- Trigger spec is unchanged from 000128, but re-stated here so this
-- migration is self-contained and idempotent.
drop trigger if exists trg_maybe_finalize_proof_status on proof_name_approvals;
create trigger trg_maybe_finalize_proof_status
  after insert or update of state on proof_name_approvals
  for each row
  when (new.state = 'approved' and new.carried_from_version_id is null)
  execute function maybe_finalize_proof_status();

commit;
