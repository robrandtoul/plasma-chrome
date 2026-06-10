-- Add proofs.proof_versions.last_reply_sent_by — which designer sent the
-- reply that last_reply_sent_at records. Companion to created_by (which
-- already exists on live with default auth.uid(), FK auth.users — added
-- during the 2026-06-08 consolidation; this migration mirrors that
-- shape). Powers the designer attribution on the proof detail page's
-- Activity timeline: "Donna Lambe sent a reply for v2".
--
-- Why a column rather than reading audit_log: audit_log SELECT is
-- admin-only by RLS ("audit_log: admin read" / is_admin()), so plain
-- designers could never see the names. Attribution is a fact about the
-- version row, denormalised onto it the same way last_reply_sent_at is.
--
-- Writers (deployed alongside this migration):
--   * send-helpscout-reply — stamps the authenticated caller's id
--     (requireDesigner's callerId) next to last_reply_sent_at.
--   * send-nudges — stamps NULL explicitly: an automated reminder
--     re-stamps last_reply_sent_at, and leaving the previous manual
--     sender's id in place would attribute the nudge to the wrong
--     person. NULL renders as the unattributed "Reply sent for vN".
--
-- Backfill: latest proof.reply_sent audit row per version
-- (metadata->>'version_id'), matching the column's "latest send"
-- semantics. Older versions whose replies predate reply auditing stay
-- NULL and render unattributed.
--
-- Grants/RLS: none needed — a new column inherits proof_versions'
-- existing table grants, and RLS is row-level. The customer-facing
-- views (public_proof_versions, public_get_customer_proof) enumerate
-- their columns explicitly, so nothing leaks to anon.

begin;

alter table proofs.proof_versions
  add column if not exists last_reply_sent_by uuid references auth.users(id) on delete set null;

comment on column proofs.proof_versions.last_reply_sent_by is
  'Designer (auth.users id) who sent the reply recorded by '
  'last_reply_sent_at. Stamped by send-helpscout-reply (caller id) and '
  'cleared to NULL by send-nudges (automated sends are unattributed). '
  'Read via a client-side join to proofs.profiles for the Activity '
  'timeline — audit_log holds the same fact but is admin-only by RLS.';

update proofs.proof_versions v
set last_reply_sent_by = a.actor_id
from (
  select distinct on (metadata->>'version_id')
    metadata->>'version_id' as version_id,
    actor_id
  from proofs.audit_log
  where action = 'proof.reply_sent'
    and metadata->>'version_id' is not null
  order by metadata->>'version_id', created_at desc
) a
where v.id::text = a.version_id
  and v.last_reply_sent_at is not null
  and v.last_reply_sent_by is null;

commit;
