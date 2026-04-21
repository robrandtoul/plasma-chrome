-- Migration 000071: per-image name association + side label
--
-- Extends proof_version_images so each uploaded file can carry
-- (a) the name of the recipient it belongs to, drawn from the
-- version's names chip list, or NULL for "shared across all
-- names", and (b) a front/back side label, NULL when neither
-- applies. Both drive the customer page's new grouped-image
-- rendering — Shared section first, then one section per name,
-- with front → back ordering inside each group.
--
-- Why text (not FK) for associated_name:
--   proof_versions.names is a text[] snapshot. There's no target
--   table to FK against, and the snapshot intentionally outlives
--   any chip-list edits so historical images keep their recipient
--   label even if the designer later tweaks the chips. A plain
--   text column matches the shape of the source data.
--
-- Why check on side (not enum):
--   Low ceremony, easy to extend later with something like 'edge'
--   or 'inside' without a TYPE migration.
--
-- No backfill. Existing rows stay null/null, which renders as
-- "shared, side unknown" on the customer page — identical to
-- today's behaviour before the grouping logic cares about these
-- columns.

begin;

alter table proof_version_images
  add column associated_name text null,
  add column side            text null
    check (side in ('front', 'back'));

comment on column proof_version_images.associated_name is
  'Name of the recipient this image belongs to, drawn from the '
  'version''s names chip list. Null = shared across all names.';
comment on column proof_version_images.side is
  'Front / back side of the printed artefact this image depicts. '
  'Null when the image is shared, single-sided, or not yet labelled.';

-- Extend the customer-facing view so the grouped rendering has
-- both columns to read. material_option + original_filename stay
-- in their existing positions; the two new columns append.
drop view if exists public_proof_version_images;
create view public_proof_version_images as
  select
    id,
    proof_version_id,
    image_path,
    label,
    sort_order,
    material_option,
    original_filename,
    associated_name,
    side
  from proof_version_images;
grant select on public_proof_version_images to anon, authenticated;

commit;
