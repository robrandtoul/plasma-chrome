-- Migration 000040: remove stale permissive policies on pricing tables
--
-- Migration 000010 pre-emptively added open "authenticated insert/update/
-- delete" policies with qual = true, long before RLS was actually enabled
-- on those tables. 000037 turned RLS on and layered admin-only policies on
-- top — but because multiple policies are OR-ed, the old permissive ones
-- still let any signed-in designer edit prices. Drop them here so only the
-- admin policies remain. SELECT stays open to authenticated via the
-- "authenticated read" / "authenticated select" policies (both match).

begin;

drop policy if exists "materials: authenticated insert"        on materials;
drop policy if exists "materials: authenticated update"        on materials;
drop policy if exists "materials: authenticated delete"        on materials;

drop policy if exists "material_variants: authenticated insert" on material_variants;
drop policy if exists "material_variants: authenticated update" on material_variants;
drop policy if exists "material_variants: authenticated delete" on material_variants;

drop policy if exists "price_tiers: authenticated insert"      on price_tiers;
drop policy if exists "price_tiers: authenticated update"      on price_tiers;
drop policy if exists "price_tiers: authenticated delete"      on price_tiers;

drop policy if exists "add_ons: authenticated insert"          on add_ons;
drop policy if exists "add_ons: authenticated update"          on add_ons;
drop policy if exists "add_ons: authenticated delete"          on add_ons;

drop policy if exists "add_on_prices: authenticated insert"    on add_on_prices;
drop policy if exists "add_on_prices: authenticated update"    on add_on_prices;
drop policy if exists "add_on_prices: authenticated delete"    on add_on_prices;

-- Duplicate SELECT policies from 000010 and 000037 coexist harmlessly
-- (both are "authenticated, using (true)"), so leave both in place.

commit;
