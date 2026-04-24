-- Migration 000095: replace featured_quantities / expanded_quantities
--
-- New model: a single display_quantities list per material,
-- flexible length, curated by the designer via the admin content
-- modal. Plus two quote bounds (min / max) that constrain the
-- customer-facing quantity lookup input to a sensible commercial
-- range. Replaces the 000012 + 000093 two-column setup.
--
-- display_quantities: nullable int[]. Null means no curation; the
-- customer page falls back to the first 10 tiers ascending from
-- the version's pricing snapshot. Populated means "show exactly
-- these rows (intersected with the snapshot) and no more".
--
-- quote_min_quantity / quote_max_quantity: nullable int. Null
-- means unbounded on that side. When set, the customer lookup
-- returns a "please get in touch for small runs" / "large runs"
-- message instead of a tier row when the typed quantity falls
-- outside the band. Bounds are evaluated before snapshot-range
-- fallbacks so the designer can suppress quoting for small or
-- large runs independently of whether a snapshot tier exists
-- for that quantity.
--
-- The public_proof_versions view is dropped here because Postgres
-- refuses to drop columns a view projects. Recreated in the
-- paired 000096 migration. Both land in one `supabase db push`
-- batch so the intermediate no-view state is momentary.
--
-- No seed data. Every material starts with all three columns
-- null; fallback behaviour on the customer page handles
-- null-everywhere cleanly until the designer curates per
-- material via admin.
--
-- Designer-side consumers (NewVersionPage, EditVersionPage,
-- ProofDetailPage, VersionDetailModal) now read display_quantities
-- in place of featured_quantities; the DEFAULT_FEATURED_QUANTITIES
-- constant is renamed to DEFAULT_DISPLAY_QUANTITIES in
-- src/lib/constants.ts. Done in lockstep with this migration so
-- the app compiles after the push.

begin;

drop view if exists public_proof_versions;

alter table materials
  drop column featured_quantities,
  drop column expanded_quantities,
  add column display_quantities int[] null,
  add column quote_min_quantity int null,
  add column quote_max_quantity int null;

commit;
