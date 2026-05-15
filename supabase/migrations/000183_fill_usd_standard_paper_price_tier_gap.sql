-- Migration 000183: fill the USD Standard Paper price-tier gap.
--
-- The GBP and EUR price-list pages show Standard Paper at quantities
-- 250, 500, 1000, 2000, 3000, 5000 and 10000. The USD price-list page
-- shows the same seven quantities, but the USD price_tiers only carry
-- the first three (250, 500, 1000) -- the upper four tiers were never
-- seeded for paper_standard in USD.
--
-- Surfaced by the 2026-05-15 CommonNinja vs Supabase parity audit:
-- across all three currency pages (1,248 cells) every cell reconciled
-- exactly except these 12 USD cells, which had no price_tiers row at
-- all. GBP and EUR paper_standard already carry the full quantity
-- range; only USD was short.
--
-- This migration inserts 12 new rows: 4 quantities (2000, 3000, 5000,
-- 10000) x 3 finish variants (standard, uv_spot, foiling) for
-- paper_standard, currency USD.
--
-- Totals are taken from the live US price list on plasmadesign.co.uk,
-- which is treated as source of truth where it and the DB diverge
-- (same stance as 000111). Unit price = total / quantity, rounded to
-- 4 decimal places to match the existing seed convention.
--
-- ON CONFLICT DO NOTHING guards against double-application
-- (price_tiers has a unique constraint on
-- (material_variant_id, currency, quantity)). The migration is
-- idempotent: running it a second time inserts nothing new.

begin;

insert into price_tiers (material_variant_id, currency, quantity, total_price, unit_price)
select mv.id, t.currency, t.quantity, t.total_price, t.unit_price
from materials m
join material_variants mv on mv.material_id = m.id
join (values
  -- Standard finish, USD
  ('paper_standard', 'standard', 'USD',  2000,  399.00, 0.1995),
  ('paper_standard', 'standard', 'USD',  3000,  599.00, 0.1997),
  ('paper_standard', 'standard', 'USD',  5000,  799.00, 0.1598),
  ('paper_standard', 'standard', 'USD', 10000, 1299.00, 0.1299),
  -- With UV Spot finish, USD
  ('paper_standard', 'uv_spot',  'USD',  2000,  499.00, 0.2495),
  ('paper_standard', 'uv_spot',  'USD',  3000,  749.00, 0.2497),
  ('paper_standard', 'uv_spot',  'USD',  5000, 1099.00, 0.2198),
  ('paper_standard', 'uv_spot',  'USD', 10000, 1749.00, 0.1749),
  -- With Foiling finish, USD
  ('paper_standard', 'foiling',  'USD',  2000,  549.00, 0.2745),
  ('paper_standard', 'foiling',  'USD',  3000,  799.00, 0.2663),
  ('paper_standard', 'foiling',  'USD',  5000, 1199.00, 0.2398),
  ('paper_standard', 'foiling',  'USD', 10000, 1899.00, 0.1899)
) as t(material_code, variant_code, currency, quantity, total_price, unit_price)
  on m.code = t.material_code and mv.code = t.variant_code
on conflict (material_variant_id, currency, quantity) do nothing;

commit;
