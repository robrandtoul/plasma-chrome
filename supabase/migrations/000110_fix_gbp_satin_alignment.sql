-- 000110_fix_gbp_satin_alignment.sql
--
-- Aligns GBP Satin Plastic price_tiers with GBP Translucent Plastic.
--
-- Background: Satin and Translucent share one pricing schedule by design
-- (confirmed by Rob 2026-04-26 during the site-vs-DB pricing audit).
-- EUR and USD Satin already align with their Translucent twins in the DB.
--
-- GBP Satin drifted below GBP Translucent on roughly 708 of the fine-
-- grained (qty 2025-5000) interpolated tiers because the original seed
-- pulled GBP Satin from a slightly different CSV than GBP Translucent.
-- The drift breaks down as:
--   * 468 cells in 1/2/3/4-ink (the original seed-level disagreement
--     surfaced by the Cowork audit on 2026-04-26)
--   * 240 cells in 5-ink and 6-ink (a downstream ripple — 000109
--     extrapolated 5/6-ink GBP Satin from the wrong 3/4-ink base; this
--     migration corrects them by joining onto Translucent's 5/6-ink
--     rows, which are themselves correct)
-- The audit's original 468 figure missed the 240 ripple because it
-- diffed against a pre-000109 seed where 5/6-ink rows didn't yet exist.
-- The variant_code JOIN below correctly picks up both groups in one
-- statement.
--
-- 7-ink and 8-ink GBP Satin carry the same drift but are NOT touched
-- here because Translucent has no 7/8-ink rows to copy from. They are
-- handled by 000113, which re-extrapolates from the 3/4-ink base
-- corrected by this migration.
--
-- The public-facing pricing pages on plasmadesign.co.uk are correct
-- (Satin = Translucent everywhere) — this migration brings the DB into
-- line.
--
-- Idempotent: re-running the UPDATE simply re-asserts the alignment.
-- After this migration, a sanity query of the form
--   select count(*)
--   from price_tiers pt_t
--   join price_tiers pt_s
--     on pt_s.currency = pt_t.currency
--    and pt_s.quantity = pt_t.quantity
--    and pt_t.material_variant_id in (select id from material_variants mv
--          join materials m on m.id = mv.material_id where m.code = 'plastic_translucent')
--    and pt_s.material_variant_id in (select id from material_variants mv
--          join materials m on m.id = mv.material_id where m.code = 'plastic_satin'
--          and mv.code = (select mv2.code from material_variants mv2 where mv2.id = pt_t.material_variant_id))
--   where pt_t.currency = 'GBP' and pt_t.total_price <> pt_s.total_price;
-- should return 0.

-- Note on shape: PostgreSQL UPDATE-FROM forbids referencing the target
-- table inside a JOIN's ON clause within the FROM list. We therefore
-- compute the full target set inside a second CTE (`satin_targets`),
-- which is a SELECT (where the scoping is permissive), and then drive
-- the UPDATE off that CTE keyed by primary key.

begin;

with translucent_prices as (
  select
    pt.currency,
    pt.quantity,
    mv.code as variant_code,
    pt.total_price,
    pt.unit_price
  from price_tiers pt
  join material_variants mv on mv.id = pt.material_variant_id
  join materials m on m.id = mv.material_id
  where m.code = 'plastic_translucent'
    and pt.currency = 'GBP'
    and pt.quantity between 2025 and 5000
),
satin_targets as (
  select
    pt.id as price_tier_id,
    tp.total_price as new_total_price,
    tp.unit_price  as new_unit_price
  from price_tiers pt
  join material_variants mv on mv.id = pt.material_variant_id
  join materials m on m.id = mv.material_id
  join translucent_prices tp
    on tp.variant_code = mv.code
   and tp.currency  = pt.currency
   and tp.quantity  = pt.quantity
  where m.code = 'plastic_satin'
    and pt.currency = 'GBP'
    and pt.quantity between 2025 and 5000
    and (pt.total_price <> tp.total_price
         or pt.unit_price <> tp.unit_price)
)
update price_tiers pt
set total_price = st.new_total_price,
    unit_price  = st.new_unit_price
from satin_targets st
where pt.id = st.price_tier_id;

commit;
