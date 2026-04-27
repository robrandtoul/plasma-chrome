-- Migration 000117: anon-readable price_tiers view (Phase 2).
--
-- Phase 2 flips the customer-facing proof page from a snapshot read
-- to a live pricing read. Until now the customer's pricing grid came
-- from proof_versions.pricing_snapshot — frozen at version creation,
-- protecting historical proofs from later price-tier edits. From
-- this commit on, the grid is computed live from price_tiers, so a
-- pricing change in Admin → Pricing flows through to every open
-- customer proof page within their next refresh.
--
-- This is a deliberate commercial choice: commercial protection over
-- price stability. The customer always sees today's prices, never
-- yesterday's; the trade-off is that an old quote can shift
-- underneath a customer between view and approval. The proof_events
-- audit trail (000116) snapshots total_price_at_action when the
-- customer acts, so the price they actually agreed to is recorded
-- regardless of any subsequent edit.
--
-- The note in 000106's header — "historical proofs are protected by
-- the pricing_snapshot model" — becomes outdated from this commit.
-- pricing_snapshot stays on proof_versions as a historical record
-- (and as the audit source for total_price_at_action when the
-- customer acts), but it stops being the customer-facing display.
-- NewVersionPage stops writing the column on insert in this same
-- commit; existing rows keep their populated snapshots untouched.
--
-- ── What this migration adds ─────────────────────────────────────
--
-- public_price_tiers — the pricing rows themselves. Mirrors
-- public_material_option_surcharges (000025): a thin SELECT of the
-- pricing data with anon SELECT granted, no extra columns.
--
-- public_material_variants — the variant display metadata. The
-- customer page needs each tier row's variant display_name and
-- variant_type to render the column header (e.g. "300 micron",
-- "Default") — the snapshot used to carry these inline as
-- variant.display, but a flat tiers view doesn't. material_variants
-- itself is RLS-gated to authenticated (000010), so a parallel
-- public view is the minimum surface needed to make the live read
-- work for anon. Mirrors the public_material_options +
-- public_material_option_surcharges paired pattern.
--
-- Both views filter to active + published + non-archived materials
-- and active variants, so unpublished or archived materials don't
-- leak prices to anon. A side-effect: a customer holding a proof
-- for a material that's later archived will see an empty grid
-- rather than the last-known prices — consistent with the live-
-- pricing philosophy ("don't quote prices for things we no longer
-- sell") and with the proof_events audit field that captures the
-- price the customer saw at the moment they acted.
--
-- DROP+CREATE rather than CREATE OR REPLACE because PostgreSQL's
-- CREATE OR REPLACE VIEW won't allow column reorder or a different
-- column set, and re-applying this migration is a no-op anyway via
-- the DROP IF EXISTS guard.
--
-- ── proof_versions.pricing_snapshot becomes nullable ─────────────
--
-- Originally NOT NULL because every version was guaranteed a
-- snapshot at insert time. Now that NewVersionPage stops writing
-- the column, new rows must be allowed to insert without one. The
-- existing populated snapshots stay populated (no data is touched);
-- only the constraint relaxes. Idempotent via DROP NOT NULL — a
-- second apply is a no-op.

begin;

alter table proof_versions
  alter column pricing_snapshot drop not null;

drop view if exists public_price_tiers;
create view public_price_tiers as
  select
    pt.id,
    pt.material_variant_id,
    pt.currency,
    pt.quantity,
    pt.total_price,
    pt.unit_price
  from price_tiers pt
  join material_variants mv on mv.id = pt.material_variant_id
  join materials m on m.id = mv.material_id
  where m.is_active = true
    and m.is_published = true
    and m.archived_at is null
    and mv.is_active = true;

grant select on public_price_tiers to anon, authenticated;

drop view if exists public_material_variants;
create view public_material_variants as
  select
    mv.id,
    mv.material_id,
    mv.display_name,
    mv.variant_type,
    mv.sort_order
  from material_variants mv
  join materials m on m.id = mv.material_id
  where m.is_active = true
    and m.is_published = true
    and m.archived_at is null
    and mv.is_active = true
  order by mv.sort_order;

grant select on public_material_variants to anon, authenticated;

commit;
