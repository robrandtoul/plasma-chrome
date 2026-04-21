-- Migration 000067: every new proof must carry either a Help Scout
-- conversation link or a documented reason for not having one
--
-- Context: the new-proof form looks up the customer email against
-- Help Scout and auto-links any matching conversation. Until now
-- the link was optional, which means a chunk of proofs have no
-- thread to post back to when the Phase 2 customer approve flow
-- lands. We can't fix that retroactively without a backfill
-- project, but we can stop the gap from growing.
--
-- Enforcement via a check constraint on the proofs row itself:
--   helpscout_conversation_url is not null
--   OR helpscout_override_reason is not null
--
-- The new helpscout_override_reason column captures the designer's
-- documented reason when the email lookup returns zero matches and
-- they want to create the proof anyway. Minimum length is enforced
-- client-side, not at the DB, so we can iterate on the threshold
-- without a migration.
--
-- NOT VALID is important: existing proofs may carry null for both
-- columns, and scanning them during the ALTER would fail. NOT VALID
-- enforces the constraint on new inserts and on updates that touch
-- either column, while leaving historical rows in their existing
-- null/null state. No backfill is expected or needed.

begin;

alter table proofs
  add column helpscout_override_reason text null;

comment on column proofs.helpscout_override_reason is
  'Designer-supplied reason when a proof is created without a Help '
  'Scout conversation link. Paired with the check constraint below: '
  'every proof must carry either a helpscout_conversation_url or '
  'a helpscout_override_reason. Designer-facing only; never shown '
  'to customers.';

alter table proofs
  add constraint proofs_helpscout_link_or_override_chk
    check (
      helpscout_conversation_url is not null
      or helpscout_override_reason is not null
    )
    not valid;

commit;
