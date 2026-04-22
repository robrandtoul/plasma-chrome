-- Migration 000075: indexes to support Dashboard hot queries
--
-- The Projects dashboard runs two full-table sorts on every page load:
--
--   1. proofs.order('last_activity_at', desc)     — whole-table sort for
--      the grouped project list
--   2. proof_versions.order('created_at', desc).limit(50) — Recent
--      projects feed
--
-- Both were seq-scan + sort prior to this migration. At 50-row scale
-- neither is felt, but the cost grows linearly with row count and these
-- indexes are cheap to add now. Plain descending btrees match the query
-- shape exactly; no partial predicate needed because the queries don't
-- filter alongside the sort.
--
-- Pure-additive. No data migration. No lock contention beyond a brief
-- ShareLock at index create.

begin;

create index if not exists proofs_last_activity_at_idx
  on proofs (last_activity_at desc);

create index if not exists proof_versions_created_at_idx
  on proof_versions (created_at desc);

commit;
