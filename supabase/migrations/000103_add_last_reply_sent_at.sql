-- Migration 000103: denormalised last-reply timestamp on proof_versions.
--
-- Powers the Customer reply section on the proof detail page (Ship 3
-- of intervention 3). Designers can see whether a reply has been sent
-- for the current version without querying audit_log, which is admin-
-- only via RLS (migration 000043).
--
-- Updated from the send-helpscout-reply edge function on a successful
-- HS POST using the service-role client. Multiple sends for the same
-- version overwrite the column; full per-send history continues to
-- live in audit_log under action='proof.reply_sent' for the activity
-- feed and any future analytics.
--
-- No RLS changes needed: the column inherits proof_versions' existing
-- designer-readable policies, which is what we want.

begin;

alter table proof_versions
  add column last_reply_sent_at timestamptz;

comment on column proof_versions.last_reply_sent_at is
  'Timestamp of the most recent send-helpscout-reply success against '
  'this version. Denormalised hot-path indicator for the proof detail '
  'page''s Customer reply section so designers can see send state '
  'without a query against audit_log (admin-only via RLS). Updated '
  'from the send-helpscout-reply edge function using the service-role '
  'client. Multiple sends for the same version overwrite the column; '
  'full per-send history lives in audit_log.';

commit;
