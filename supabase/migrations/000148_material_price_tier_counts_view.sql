-- Migration 000148: aggregate (material_id, tier_count) view.
--
-- The admin pricing index used to fetch every row in price_tiers
-- (24,006 rows live) and roll them up client-side, which silently
-- truncated to the supabase-js default 1000-row cap and made every
-- material past the first three look like it had zero tiers. This
-- view does the rollup on the database side so the admin index
-- can issue one tiny query that returns one row per material.
--
-- Grants: admin pages query under an authenticated session, so
-- `authenticated` is sufficient. We don't expose this to anon —
-- there's no customer-facing need.

create or replace view material_price_tier_counts as
  select
    mv.material_id,
    count(pt.id)::int as tier_count
  from material_variants mv
  left join price_tiers pt on pt.material_variant_id = mv.id
  group by mv.material_id;

grant select on material_price_tier_counts to authenticated;
