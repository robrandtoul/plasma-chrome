-- Migration 000168: QR-code fields on proof_version_images.
--
-- Customers very often include a QR code on a card — vCard data,
-- a URL, or occasionally wifi / phone / sms. The verification step
-- we used to do by emailing a separate JPEG of the QR (so the
-- customer could scan and check the contents) is moving into
-- proof-viewer. The designer uploads the JPEG, the upload pipeline
-- decodes it client-side via jsQR, and the decoded payload is
-- stored alongside the image for the customer page to display in
-- plain English (with type-specific formatters — vCard contact
-- card, URL, wifi panel, etc.).
--
-- ── Why these columns on proof_version_images rather than a
-- ── sibling table ───────────────────────────────────────────────────
--
-- A QR-with-decoded-data is just an image that's been classified at
-- upload and had its contents extracted. Modelling it as a flag +
-- two metadata columns reuses every existing piece of plumbing:
--   * storage paths + the proof-images bucket
--   * RLS on the underlying table
--   * the customer-proof-images edge function
--   * per-recipient assignment via associated_name (000071)
--   * per-variant assignment via round_variant_id (000138/000139)
--   * per-option assignment via material_option (000025)
--   * the proof_version_images_qr_consistency_chk CHECK below keeps
--     QR rows and non-QR rows from drifting into invalid states.
--
-- The customer page splits rendering on is_qr_code: the existing
-- image grid stays on is_qr_code = false, the new QR panel reads
-- is_qr_code = true. Carry-forward identity (image_path-based) is
-- unaffected by this migration: a changed QR is a changed file is
-- a changed storage path is a broken carry, which is exactly the
-- behaviour we want.
--
-- ── What this migration does ────────────────────────────────────────
--
-- 1. Adds three columns on proof_version_images: is_qr_code (bool,
--    default false), qr_decoded_data (text, nullable), qr_kind
--    (text, nullable).
--
-- 2. Adds a CHECK constraint enforcing the invariant: QR fields are
--    populated iff is_qr_code = true. Non-QR rows must have both
--    nulls; QR rows must have both populated, with qr_kind drawn
--    from the classifier's eight outputs.
--
-- 3. Adds a partial index on (proof_version_id) where is_qr_code =
--    true. Supports the customer-page QR panel's per-version
--    filter without scanning every non-QR row in the table.
--
-- 4. Drops and recreates public_proof_version_images to expose the
--    three new columns. The customer-proof-images edge function
--    uses select * from this view (under service-role, which
--    bypasses grants), so the new columns flow through to the
--    customer page automatically. Re-grants authenticated select
--    for designer-side reads; anon stays revoked per 000162.
--
-- No data backfill required: every existing row defaults to
-- is_qr_code = false with null QR metadata, which satisfies the
-- CHECK trivially.

begin;

-- ── 1. New columns ───────────────────────────────────────────────────

alter table proof_version_images
  add column is_qr_code      boolean not null default false,
  add column qr_decoded_data text,
  add column qr_kind          text;

comment on column proof_version_images.is_qr_code is
  'True for images that the upload pipeline classified as QR codes '
  'and decoded. False for ordinary artwork images. CHECK constraint '
  'enforces that qr_decoded_data and qr_kind are populated iff this '
  'is true.';

comment on column proof_version_images.qr_decoded_data is
  'Raw decoded payload from the QR code — exact bytes of the encoded '
  'string. Customer page renders this verbatim (no URL expansion, no '
  'normalisation) so the customer sees what the QR literally contains.';

comment on column proof_version_images.qr_kind is
  'Classifier output for the decoded payload. Drives the per-kind '
  'renderer on the customer page: vcard | url | wifi | mecard | '
  'email | phone | sms | text. CHECK constraint enforces the enum.';

-- ── 2. Consistency CHECK ─────────────────────────────────────────────

alter table proof_version_images
  add constraint proof_version_images_qr_consistency_chk
  check (
    (is_qr_code = false and qr_decoded_data is null and qr_kind is null)
    or (
      is_qr_code = true
      and qr_decoded_data is not null
      and qr_kind in (
        'vcard', 'url', 'wifi', 'mecard',
        'email', 'phone', 'sms',  'text'
      )
    )
  );

-- ── 3. Partial index for the customer-page QR panel filter ──────────

create index proof_version_images_qr_idx
  on proof_version_images (proof_version_id)
  where is_qr_code = true;

-- ── 4. public_proof_version_images view ─────────────────────────────
--
-- Drop + recreate rather than create-or-replace; PostgreSQL's
-- create-or-replace can't change the column list of a view, and
-- this is an append-only column addition. Matches the pattern
-- established by 000139 (variant rounds) and 000162 (anon revoke).

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
    qr_kind
  from proof_version_images;

-- Anon stays revoked per 000162; the customer-proof-images edge
-- function reads under service-role and bypasses grants entirely.
-- Re-grant authenticated for designer-side reads (NewVersionPage,
-- EditVersionPage, VersionDetailModal, ProofDetailPage).
grant select on public_proof_version_images to authenticated;

commit;
