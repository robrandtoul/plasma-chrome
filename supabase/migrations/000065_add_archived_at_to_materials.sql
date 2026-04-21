-- Migration 000065: soft-archive for materials
--
-- Adds archived_at as the material-level soft-delete signal and
-- extends the SELECT RLS on materials, material_variants and
-- price_tiers so that non-admins can't see rows belonging to an
-- archived material. Admins continue to see everything.
--
-- Why archived_at instead of a boolean:
--   keeping the archive timestamp lets us answer "when was this
--   archived?" in the audit log and the Settings page without an
--   extra column. Null means active.
--
-- Scope decisions baked in (see the Phase 4 prompt):
--   * Archive auto-unpublishes. The archive handler in the admin UI
--     writes is_published = false in the same UPDATE so we can't
--     leave a row "archived but still visible to designers".
--   * Unarchive leaves is_published = false. The admin has to
--     re-publish explicitly.
--   * add_ons / add_on_prices policies are NOT updated here. Add-ons
--     aren't owned by a single material; their applies_to_material_codes
--     array is a restriction list, not a foreign key, so there's no
--     sensible cascade. If a specific add-on needs archive support
--     later it'll be a separate feature.
--   * material_options is left as-is for the same "not a clean
--     cascade" reason. Customer pages read options via proof
--     snapshots, not by re-querying materials, so existing proofs
--     stay intact when the parent material is archived.

begin;

-- ── Column + index ──────────────────────────────────────────────────────────

alter table materials
  add column archived_at timestamptz null;

-- Partial index: most rows are active so indexing only the archived
-- ones keeps it tiny. Useful for the admin "Show archived" list.
create index materials_archived_at_idx
  on materials (archived_at)
  where archived_at is not null;

-- ── Archive-aware SELECT on materials ───────────────────────────────────────

-- 000010 and 000037 both added permissive SELECT policies on materials
-- (`using (true)`). Drop both so the new archive-aware policy is the
-- only SELECT in play.
drop policy if exists "materials: authenticated select" on materials;
drop policy if exists "materials: authenticated read"   on materials;

create policy "materials: read non-archived or admin"
  on materials for select
  to authenticated
  using (archived_at is null or is_admin());

-- ── Cascade through material_variants ──────────────────────────────────────

drop policy if exists "material_variants: authenticated select" on material_variants;
drop policy if exists "material_variants: authenticated read"   on material_variants;

create policy "material_variants: read non-archived-parent or admin"
  on material_variants for select
  to authenticated
  using (
    is_admin()
    or exists (
      select 1
        from materials m
        where m.id = material_variants.material_id
          and m.archived_at is null
    )
  );

-- ── Cascade through price_tiers ────────────────────────────────────────────

drop policy if exists "price_tiers: authenticated select" on price_tiers;
drop policy if exists "price_tiers: authenticated read"   on price_tiers;

create policy "price_tiers: read non-archived-parent or admin"
  on price_tiers for select
  to authenticated
  using (
    is_admin()
    or exists (
      select 1
        from material_variants v
        join materials m on m.id = v.material_id
        where v.id = price_tiers.material_variant_id
          and m.archived_at is null
    )
  );

commit;
