-- Migration 000083: provenance column on proof_name_approvals
--
-- Adds carried_from_version_id to proof_name_approvals so carried-
-- forward approvals are distinguishable from fresh approvals at
-- read time. Populated only on INSERT inside the carry-forward
-- branch of NewVersionPage's save handler; other INSERT paths
-- (modal designer toggle, future customer RPC) leave it null.
-- State-change UPDATEs preserve it. Clearing an approval deletes
-- the row; re-approving creates a new row with null provenance.
--
-- FK uses ON DELETE SET NULL rather than CASCADE so deleting the
-- source version doesn't cascade-drop downstream approvals that
-- are themselves still valid. The provenance pointer just
-- detaches silently, and the UI's "Carried from vN" pill stops
-- rendering for that approval (resolver falls back silently when
-- it can't find the referenced version).
--
-- Partial index on non-null rows only — the table's unique (
-- proof_version_id, name) + non-null filtered selectivity make
-- this tiny, and most rows over time will be null (fresh
-- approvals dominate in steady state).

begin;

alter table proof_name_approvals
  add column carried_from_version_id uuid null
    references proof_versions(id) on delete set null;

comment on column proof_name_approvals.carried_from_version_id is
  'Non-null when this approval row was created as part of a '
  'carry-forward during new-version save. Records provenance at '
  'INSERT time. State changes via UPDATE preserve it. Clearing '
  'and re-approving creates a new row with NULL provenance.';

create index proof_name_approvals_carried_from_idx
  on proof_name_approvals (carried_from_version_id)
  where carried_from_version_id is not null;

commit;
