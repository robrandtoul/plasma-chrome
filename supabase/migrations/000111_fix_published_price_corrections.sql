-- 000111_fix_published_price_corrections.sql
--
-- Brings DB price_tiers into line with customer-facing prices on
-- plasmadesign.co.uk where the two had drifted. Customers anchor on the
-- published pages, so the public site is treated as source of truth and
-- the DB is updated to match.
--
-- Surfaced by the 2026-04-26 pricing audit (pricing-audit/AUDIT-REPORT.md
-- in this repo's working notes). Eight cells in total across three
-- materials and two currencies.
--
--   GBP Tinted Plastic Cards, qty 3000 (4 cells, all ink counts)
--   USD Wood, qty 50 + qty 75 (2 cells)
--   USD Standard Paper, qty 1000, UV spot + foiling (2 cells)
--
-- Idempotent — re-running re-asserts the same totals.

begin;

-- GBP Tinted Plastic Cards, qty 3000 — DB was overshooting site
update price_tiers pt
set total_price = v.total_price,
    unit_price  = v.unit_price
from material_variants mv
join materials m on m.id = mv.material_id
join (values
  ('1_ink', 759.00,  0.2530),
  ('2_ink', 924.00,  0.3080),
  ('3_ink', 1099.00, 0.3663),
  ('4_ink', 1449.00, 0.4830)
) as v(variant_code, total_price, unit_price) on v.variant_code = mv.code
where pt.material_variant_id = mv.id
  and m.code = 'plastic_tinted'
  and pt.currency = 'GBP'
  and pt.quantity = 3000;

-- USD Wood, qty 50 + qty 75 — DB was undershooting site
-- Note on shape: PostgreSQL UPDATE-FROM forbids referencing the target
-- table (`pt`) inside a JOIN's ON clause. The other two UPDATE blocks in
-- this file join the values list on `mv.code` (a non-target column), so
-- they're fine. The wood block keys by quantity, which lives on `pt`,
-- so it uses CROSS JOIN with the predicate in the outer WHERE.
update price_tiers pt
set total_price = v.total_price,
    unit_price  = v.unit_price
from material_variants mv
join materials m on m.id = mv.material_id
cross join (values
  (50, 199.00, 3.9800),
  (75, 229.00, 3.0533)
) as v(quantity, total_price, unit_price)
where pt.material_variant_id = mv.id
  and v.quantity = pt.quantity
  and m.code = 'wood'
  and mv.code = 'default'
  and pt.currency = 'USD'
  and pt.quantity in (50, 75);

-- USD Standard Paper, qty 1000 — UV spot and foiling each off in
-- opposite directions
update price_tiers pt
set total_price = v.total_price,
    unit_price  = v.unit_price
from material_variants mv
join materials m on m.id = mv.material_id
join (values
  ('uv_spot', 329.00, 0.3290),
  ('foiling', 399.00, 0.3990)
) as v(variant_code, total_price, unit_price) on v.variant_code = mv.code
where pt.material_variant_id = mv.id
  and m.code = 'paper_standard'
  and pt.currency = 'USD'
  and pt.quantity = 1000;

commit;
