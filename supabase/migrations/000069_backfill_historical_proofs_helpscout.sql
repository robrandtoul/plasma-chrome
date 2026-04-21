-- Migration 000069: fix 000067's NOT VALID trap
--
-- 000067 added a check constraint requiring helpscout_conversation_url
-- or helpscout_override_reason to be non-null. It shipped with
-- NOT VALID on the assumption that would mean "don't touch existing
-- rows", which was wrong: NOT VALID skips the initial scan but
-- still enforces the constraint on every subsequent INSERT and
-- UPDATE, regardless of which columns change. The knock-on effect
-- was that historical proofs carrying null/null couldn't be
-- approved, abandoned, or otherwise touched — bump_proof_activity
-- alone was enough to trip the check.
--
-- This migration drops that constraint, backfills every historical
-- row so the invariant holds, and re-adds the constraint FULLY
-- VALID so Postgres verifies the whole table. If any row still
-- fails after the backfill, the re-add will raise and the whole
-- migration rolls back, which is what we want — silent gaps here
-- would recreate the same problem later.
--
-- Discovery counts at time of writing (2 proofs total):
--   satisfied                         0
--   legacy-mirror (thread_url only)   0
--   null/null                         2
--   already has override              0
--
-- The legacy-mirror step is a no-op on this DB. It's kept as a
-- WHERE-gated UPDATE so the migration reads correctly against any
-- environment that might carry pre-000028 rows.

begin;

-- 1. Drop the NOT VALID constraint from 000067.
alter table proofs
  drop constraint proofs_helpscout_link_or_override_chk;

-- 2. Legacy-mirror recovery: if a proof has the URL in the legacy
--    helpscout_thread_url column but not in helpscout_conversation_url,
--    copy it across. The real link data exists — just on the wrong
--    column — so this gives the most accurate recovery.
update proofs
set helpscout_conversation_url = helpscout_thread_url
where helpscout_conversation_url is null
  and helpscout_thread_url is not null;

-- 3. Genuine null/null recovery: stamp a documented reason so the
--    constraint is satisfied. Uses a stock string that reads clearly
--    in the detail-page Internal panel ("Help Scout override:
--    Predates Help Scout link requirement…"). No audit log event —
--    thousands of synthetic entries would clutter the activity log
--    without adding meaning.
update proofs
set helpscout_override_reason = 'Predates Help Scout link requirement (introduced 2026-04-21).'
where helpscout_conversation_url is null
  and helpscout_override_reason is null;

-- 4. Re-add the constraint FULLY VALID. If any row slipped through
--    the backfill, this ALTER raises and the whole transaction rolls
--    back — loud failure, no quiet gaps.
alter table proofs
  add constraint proofs_helpscout_link_or_override_chk
    check (
      helpscout_conversation_url is not null
      or helpscout_override_reason is not null
    );

commit;
