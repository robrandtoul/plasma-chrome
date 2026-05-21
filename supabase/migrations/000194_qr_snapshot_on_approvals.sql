-- Migration 000194: hosted-vCard approval snapshot on proof_name_approvals.
--
-- A hosted-vCard QR (migration 000192) points at a Plasma vCard whose
-- contact data is fetched live from the vCard app. The QR-confirmation
-- gate from 000169 records when the customer ticked the verification
-- box, but the data they confirmed stays editable on the vCard side
-- indefinitely. So what the customer approved can drift from what the
-- printed QR resolves to.
--
-- This migration captures a permanent snapshot at approval time. The
-- proof-action edge function (Phase 4) fetches each hosted-vCard QR's
-- contact data via the vCard app's anon RPCs and writes a JSONB blob,
-- keyed by qr_vcard_slug, into proof_name_approvals.qr_snapshot
-- alongside the existing qr_confirmed_at stamp.
--
-- Shape (one entry per hosted-vCard QR on the slot):
--   {
--     "<slug>": {
--       "captured_at": "2026-05-21T11:22:33Z",
--       "card_id": "uuid",
--       "card_slug": "<slug>",
--       "target_type": "vcard" | "external_url" | null,
--       "external_url": "https://example.com/...",
--       "first_name": "...", "last_name": "...", "nickname": "...",
--       "job_title": "...", "company": "...",
--       "primary_email": "...", "email_label": "...",
--       "primary_phone": "...", "phone_label": "...",
--       "bio": "...", "birthday": "YYYY-MM-DD",
--       "address_street": "...", "address_city": "...",
--       "address_region": "...", "address_postcode": "...",
--       "address_country": "...",
--       "links": [{ "url": "...", "label": "...", "icon_slug": "...", "sort_order": 0 }, ...],
--       "contact_methods": [{ "method_type": "email"|"phone", "value": "...", "label": "...", "sort_order": 0 }, ...]
--     },
--     ...
--   }
--
-- A Plasma vCard is either a contact card ('vcard', the default) or
-- a URL redirect ('external_url'). The contact-field block is null
-- on redirect cards because the underlying app stores no contact
-- data for them; the meaningful payload is external_url. The
-- designer-side display branches on target_type so a redirect card
-- shows "Redirects to: <url>" instead of an empty contact panel.
-- target_type may be null on legacy entries snapshotted before this
-- field was added; the display treats null the same as 'vcard'.
--
-- Designer-side only. The customer never reads the snapshot — they
-- approve against the live data — so no public_* view or customer RPC
-- needs to change. proof_name_approvals's existing grants (service-
-- role write via the edge function, authenticated read via the
-- designer surfaces) cover the new column without further config.
--
-- Null on every row that doesn't carry a hosted-vCard QR at approval
-- time, including the entire backfill of legacy rows. The edge
-- function leaves the column null when no hosted-vCard QRs are
-- visible to the slot, when the vCard app is unreachable, or when no
-- slug resolves to a card.

begin;

alter table proof_name_approvals
  add column qr_snapshot jsonb;

comment on column proof_name_approvals.qr_snapshot is
  'Captured at approval time for slots whose current version has one '
  'or more hosted-vCard QR rows (qr_kind = ''hosted_vcard''). Object '
  'keyed by qr_vcard_slug; each value holds the contact fields the '
  'customer page renders in HostedVcardView at that moment (name, '
  'nickname, job title, company, primary phone/email plus secondary '
  'contact methods, address, birthday, bio, links). Styling fields '
  '(profile / cover image, theme) are excluded - they are not part '
  'of the proof''s contractual content. The live vCard stays '
  'editable; this column is the permanent audit record of what was '
  'approved. Null when the slot has no hosted-vCard QRs, when the '
  'vCard app was unreachable at action time, or on legacy approval '
  'rows that predate this feature.';

commit;
