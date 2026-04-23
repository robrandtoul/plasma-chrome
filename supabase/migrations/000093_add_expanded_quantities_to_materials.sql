-- Migration 000093: expanded_quantities on materials
--
-- Drives the customer-facing "show more" reveal on the pricing
-- table. Separate from featured_quantities (which stays as the
-- default 5-row view added in migration 000012). Nullable —
-- customer page falls back to the first 10 tiers ascending from
-- the version's pricing snapshot when this column is null for
-- the material.
--
-- Seeded null for all existing materials. Plasma will curate
-- per-material in a later pass. The fallback has to work
-- standalone on launch day.
--
-- No index. The column is small (a short int[] per material
-- row) and only read through the per-material lookup path that
-- already has a primary-key hit via pv.material_id → m.id.

begin;

alter table materials
  add column expanded_quantities int[] null;

commit;
