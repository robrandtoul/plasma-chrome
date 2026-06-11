-- 000218 — finalize a proof when an already-approved version is promoted.
--
-- "Set as current" (VersionDetailModal.handleSetCurrent) and the delete
-- auto-promote both do a bare `update proof_versions set is_current = true`.
-- The finalization check (_finalize_proof_if_complete) only runs off
-- proof_name_approvals changes (the 000126 trigger), NOT off an is_current
-- flip. So promoting a superseded-but-already-approved version leaves the
-- proof stuck in_progress: the current version is fully approved, but nothing
-- re-evaluated it, and every "Approved" surface keys off proofs.status. The
-- designer sees the approval "vanish" (it's intact in proof_name_approvals —
-- just not reflected in status).
--
-- Fix: an AFTER UPDATE OF is_current trigger that re-runs the same
-- finalization check whenever a version BECOMES current. Same function the
-- approval-row path already uses, so the rules (slots, shared, QR gating,
-- set-collection) stay identical — this only adds a second moment at which
-- the check runs.
--
-- SECURITY DEFINER: _finalize_proof_if_complete had EXECUTE revoked from
-- authenticated (000182), so the trigger function must run as its owner to
-- call it — same reason the 000126 trigger function is DEFINER.
--
-- Trigger NAME is load-bearing: AFTER-row triggers fire in alphabetical
-- order, and proof_versions_unset_siblings must flip the *other* versions to
-- is_current=false BEFORE we read "the current version". The z-prefix sorts
-- this trigger after proof_versions_unset_siblings so finalize sees a single
-- current version. The WHEN clause keeps it to the false→true promotion edge,
-- so the sibling-unset sub-updates (true→false) don't re-fire it.

create or replace function proofs.finalize_on_version_promotion()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'proofs', 'public', 'extensions', 'pg_temp'
as $function$
begin
  perform proofs._finalize_proof_if_complete(new.proof_id);
  return null;
end;
$function$;

-- Internal trigger plumbing — not part of the callable API surface (000182
-- pattern). Nothing in src/ or supabase/functions/ calls it directly.
revoke execute on function proofs.finalize_on_version_promotion() from public, anon, authenticated;

drop trigger if exists proof_versions_zfinalize_on_promotion on proofs.proof_versions;
create trigger proof_versions_zfinalize_on_promotion
after update of is_current on proofs.proof_versions
for each row
when (new.is_current and not old.is_current)
execute function proofs.finalize_on_version_promotion();

-- One-time heal for proofs already stuck in this state (a version was
-- promoted before this trigger existed, so the proof never finalized). Scoped
-- to in_progress/dormant proofs whose current version carries an approval;
-- _finalize_proof_if_complete applies the full slot/QR rules and only flips
-- those that are genuinely complete, so this is idempotent and safe to replay.
do $$
declare
  r record;
begin
  for r in
    select distinct p.id
    from proofs.proofs p
    join proofs.proof_versions pv on pv.proof_id = p.id and pv.is_current
    join proofs.proof_name_approvals pna
      on pna.proof_version_id = pv.id and pna.state = 'approved'
    where p.status in ('in_progress', 'dormant')
  loop
    perform proofs._finalize_proof_if_complete(r.id);
  end loop;
end $$;
