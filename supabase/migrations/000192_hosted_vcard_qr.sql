-- Migration 000192: hosted-vCard QR codes on proof_version_images.
--
-- Plasma's hosted vCard product (https://qcrd.uk/<slug>) prints a QR
-- code that points at a short URL rather than encoding the contact
-- details inline. A printed-on-the-card QR therefore decodes to nothing
-- more useful than a slug; the actual contact details live in the vCard
-- app's database. The customer can't verify "what does this QR
-- actually do" by reading the decoded data.
--
-- This migration adds a new QR kind, `hosted_vcard`, so the proof
-- viewer can persist the slug alongside the existing decoded URL.
-- The customer page reads the slug, fetches the contact fields live
-- from the vCard app's anon RPCs, and renders them in the existing
-- QR-confirmation panel.
--
-- ── What this migration does ────────────────────────────────────────
--
-- 1. Adds `qr_vcard_slug text` (nullable) to proof_version_images.
--
-- 2. Drops and re-adds the qr-consistency CHECK constraint so that
--    qr_kind can be 'hosted_vcard' and `qr_vcard_slug` is populated
--    iff qr_kind = 'hosted_vcard'. The eight pre-existing qr_kind
--    values (vcard | url | wifi | mecard | email | phone | sms |
--    text) are preserved, all with qr_vcard_slug forced null. No
--    data backfill required — every existing row trivially satisfies
--    the rewritten check at default values.
--
-- 3. Drops + recreates public_proof_version_images to expose the new
--    column. Restates `revoke select … from anon, public` and
--    `grant select … to authenticated` after the recreate — drop +
--    recreate silently wipes view grants in PostgreSQL, the exact
--    footgun that bit 000168 and was remediated in 000174.
--
-- The customer-proof-images edge function uses `select *` from this
-- view under service-role, so the new column flows through to the
-- browser automatically once the view is rebuilt. The
-- _finalize_proof_if_complete predicate from 000169 already treats
-- any is_qr_code = true row as a QR for the slot, so hosted-vCard QRs
-- inherit the existing qr_confirmed_at approval gate without a
-- function rewrite.
--
-- The public_get_customer_proof RPC is intentionally untouched: it
-- doesn't carry per-image rows (images flow through the
-- customer-proof-images edge function which `select *`s the view), so
-- nothing in its return shape needs widening for this feature.

begin;

-- ── 1. New column ───────────────────────────────────────────────────

alter table proof_version_images
  add column qr_vcard_slug text;

comment on column proof_version_images.qr_vcard_slug is
  'For hosted-vCard QR rows (qr_kind = ''hosted_vcard''), the slug of '
  'the Plasma vCard the QR points at — the customer page uses it to '
  'fetch the live contact details from the vCard app''s anon RPCs and '
  'render them in the QR-confirmation panel. Null for every other QR '
  'kind and for non-QR rows; the CHECK constraint enforces that the '
  'column is populated iff qr_kind = ''hosted_vcard''.';

-- ── 2. Updated consistency CHECK ────────────────────────────────────

alter table proof_version_images
  drop constraint proof_version_images_qr_consistency_chk;

alter table proof_version_images
  add constraint proof_version_images_qr_consistency_chk
  check (
    (is_qr_code = false
      and qr_decoded_data is null
      and qr_kind is null
      and qr_vcard_slug is null)
    or (
      is_qr_code = true
      and qr_decoded_data is not null
      and qr_kind in (
        'vcard', 'url', 'wifi', 'mecard',
        'email', 'phone', 'sms',  'text',
        'hosted_vcard'
      )
      and (
        (qr_kind =  'hosted_vcard' and qr_vcard_slug is not null)
        or (qr_kind <> 'hosted_vcard' and qr_vcard_slug is null)
      )
    )
  );

-- ── 3. Rebuilt public_proof_version_images view ─────────────────────
--
-- Append-only column addition; PostgreSQL's create-or-replace can't
-- change a view's column list, so this is a drop + recreate. Body
-- matches the 000168 definition with `qr_vcard_slug` appended after
-- `qr_kind` (keeping all pre-existing columns in their declared
-- order so existing typed consumers don't shift column offsets).

drop view if exists public_proof_version_images;

create view public_proof_version_images as
  select
    id,
    proof_version_id,
    image_path,
    sort_order,
    material_option,
    original_filename,
    associated_name,
    side,
    round_variant_id,
    is_qr_code,
    qr_decoded_data,
    qr_kind,
    qr_vcard_slug
  from proof_version_images;

-- Restate the anon revoke (000162 / 000174) and the authenticated
-- grant (000168). Drop + recreate wipes both silently; without this
-- block, the view would default-grant select to anon between this
-- migration and any later remediation. Belt-and-braces ordering:
-- revoke first so a typo in the grant can't briefly widen anon's
-- access if the migration is interrupted between the two statements.
revoke select on public_proof_version_images from anon, public;
grant  select on public_proof_version_images to authenticated;

-- security_invoker = on per 000181 — drop + recreate resets view
-- options. Re-pin so the new view runs with the querying user's RLS
-- context rather than the owner's, matching every other public_*
-- view post-000181.
alter view public_proof_version_images set (security_invoker = on);

commit;
