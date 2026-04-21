-- Migration 000066: schema prep for the option 2 customer approve flow
--
-- Adds four nullable columns to proof_versions so the customer page
-- can later be upgraded from read-only (option 1) to interactive
-- approval (option 2) without a retrofit. All four stay null in
-- option 1; they're written by the future Approve edge function.
--
-- Deliberately not done here:
--   * No indexes. Query volume will be low; revisit if we end up
--     listing "recently approved" on a dashboard.
--   * No format constraints on IP or user-agent. The edge function
--     formats and truncates; this table just stores what it receives.
--   * No audit event. The lifecycle event (proof_approved or
--     similar) arrives with the Approve action itself.
--   * No changes to public_proof_versions. The view will be extended
--     at the same time the UI starts reading these columns.

begin;

alter table proof_versions
  add column approved_at       timestamptz null,
  add column approved_by_name  text null,
  add column approved_from_ip  text null,
  add column approved_from_ua  text null;

comment on column proof_versions.approved_at       is 'Timestamp customer clicked Approve on the proof page. Null until option 2 is wired up.';
comment on column proof_versions.approved_by_name  is 'Name customer typed to confirm approval. Null until option 2 is wired up.';
comment on column proof_versions.approved_from_ip  is 'Client IP at time of approval. Null until option 2 is wired up.';
comment on column proof_versions.approved_from_ua  is 'Client user-agent at time of approval. Null until option 2 is wired up.';

commit;
