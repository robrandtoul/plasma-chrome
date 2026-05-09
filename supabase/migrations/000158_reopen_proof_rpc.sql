-- Migration 000158: reopen_proof RPC — atomic status flip + clear of
-- per-recipient approval state.
--
-- Bug fix:
--   handleReopen used to do a client-side UPDATE of proofs.status
--   only, leaving proof_name_approvals untouched. The carry-forward
--   block in NewVersionPage then picked up v1's still-'approved' rows
--   when the designer added v2 and INSERTed them onto v2 with
--   carried_from_version_id=v1, so the customer page treated v2 as
--   pre-approved and hid the action buttons. Reopen is supposed to
--   mean "fresh start, customer should see this again", so the
--   carry-forward defeated the intent.
--
-- Why an RPC and not two client-side calls:
--   The two writes aren't independent. UPDATE-success-without-DELETE-
--   success leaves status='in_progress' but with stale 'approved'
--   rows on v1, which re-creates the bug on the next v2 add.
--   Atomicity matters here. Same precedent as 000031's
--   delete_proof_cascade — single-statement (function-level)
--   atomicity, future safety checks in one place.
--
-- Why security invoker:
--   The UPDATE on proofs is allowed for authenticated under the
--   existing 'proofs: authenticated update' policy
--   (20260419000003_create_proofs.sql). The DELETE on
--   proof_name_approvals is allowed for authenticated under
--   'proof_name_approvals: authenticated delete' (000077). No
--   elevation needed; the caller's own RLS context is sufficient.
--
-- Returns:
--   integer — the count of proof_name_approvals rows cleared. Used
--   by handleReopen to populate the proof.reopened audit row's
--   afterValue.approvals_cleared so the audit log carries a
--   structured signal of how many approvals were wiped (useful for
--   debugging "did this reopen actually do what I expected?").
--   Zero on a proof with no approvals (abandoned-without-approval,
--   no-versions, fresh proof).

begin;

create or replace function reopen_proof(p_proof_id uuid)
returns integer
language plpgsql
security invoker
as $$
declare
  v_cleared integer;
begin
  if not exists (select 1 from proofs where id = p_proof_id) then
    raise exception 'Proof not found';
  end if;

  -- Status flip: clears both terminal timestamps so the same RPC
  -- reopens approved AND abandoned proofs (the previous client-side
  -- code did this; preserved here).
  update proofs
  set status = 'in_progress',
      approved_at = null,
      abandoned_at = null
  where id = p_proof_id;

  -- Clear per-recipient approval state across every version of this
  -- proof. Includes state='approved' (the carry-forward source) AND
  -- state='changes_requested' (variant-round selections, manual
  -- override notes); reopen = "fresh start", so all current-state
  -- rows go. Historical events on proof_events are unaffected — the
  -- audit trail of who approved / requested changes lives there.
  delete from proof_name_approvals
  where proof_version_id in (
    select id from proof_versions where proof_id = p_proof_id
  );

  get diagnostics v_cleared = row_count;
  return v_cleared;
end;
$$;

grant execute on function reopen_proof(uuid) to authenticated;

commit;
