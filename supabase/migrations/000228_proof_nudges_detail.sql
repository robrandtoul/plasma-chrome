-- 000228_proof_nudges_detail.sql
--
-- Give the follow-up reminder ledger a place to explain itself.
--
-- When the sender (send-nudges edge function) skips or fails a reminder for a
-- reason a human has to resolve, the row currently carries only a short code in
-- `outcome` (e.g. 'recipient_mismatch'). The dashboard Outbox panel humanises
-- that into a category label ("email mismatch — review") but cannot show the
-- specifics — and for the email-mismatch case the specifics (the Help Scout
-- email vs the proof contact email) are only known live at decision time and
-- are thrown away, so they can't be reconstructed afterwards.
--
-- This column lets the sender record a one-line, human-readable explanation at
-- the moment it makes the decision (e.g. "Help Scout will email a@x, but this
-- proof's contact is b@x — make them match"), which the panel renders under the
-- row. Nullable: pre-existing rows and benign self-resolving skips leave it null
-- and the panel simply shows nothing extra.
--
-- No grant changes: table-level GRANT SELECT on proofs.proof_nudges (000214)
-- covers new columns automatically; the sender writes as service_role.

alter table proofs.proof_nudges
  add column if not exists detail text;

comment on column proofs.proof_nudges.detail is
  'Optional human-readable explanation of a skip/failure outcome, written by the sender at decision time and shown on the dashboard Outbox "Needs you"/"Failed" rows. Null for benign self-resolving skips and pre-000228 rows.';
