-- Migration 000105: fill the USD letterpress price-tier gap.
--
-- The original USD letterpress CSV only carried tiers from 100 to
-- 200 (in 25-quantity steps). Plasma's published USD chart provides
-- headline tiers at 250, 500, 750, 1000, 1500, 2000 — the curated
-- display_quantities set the customer page uses by default. Without
-- those tiers, USD letterpress proofs at the curated quantities
-- render as empty cells on the customer's price grid.
--
-- This migration inserts 48 new rows: 6 quantities × 4 ink counts
-- × 2 materials (plain paper_letterpress and gilded
-- paper_letterpress_gilded). The 100-quantity row already exists
-- from the original CSV and is intentionally skipped.
--
-- Plain totals come from the published chart. Gilded totals are
-- plain base + the published gilded surcharge per quantity:
--   qty 250: +120,  500: +180,  750: +230
--   qty 1000: +340, 1500: +470, 2000: +590
--
-- Unit price = total / quantity, rounded to 4 decimal places to
-- match the existing seed convention.
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
  -- Plain paper_letterpress, USD.
  ('paper_letterpress',        '1_ink', 'USD',  250,  219.00, 0.8760),
  ('paper_letterpress',        '2_ink', 'USD',  250,  269.00, 1.0760),
  ('paper_letterpress',        '3_ink', 'USD',  250,  299.00, 1.1960),
  ('paper_letterpress',        '4_ink', 'USD',  250,  349.00, 1.3960),
  ('paper_letterpress',        '1_ink', 'USD',  500,  269.00, 0.5380),
  ('paper_letterpress',        '2_ink', 'USD',  500,  319.00, 0.6380),
  ('paper_letterpress',        '3_ink', 'USD',  500,  399.00, 0.7980),
  ('paper_letterpress',        '4_ink', 'USD',  500,  499.00, 0.9980),
  ('paper_letterpress',        '1_ink', 'USD',  750,  329.00, 0.4387),
  ('paper_letterpress',        '2_ink', 'USD',  750,  399.00, 0.5320),
  ('paper_letterpress',        '3_ink', 'USD',  750,  499.00, 0.6653),
  ('paper_letterpress',        '4_ink', 'USD',  750,  599.00, 0.7987),
  ('paper_letterpress',        '1_ink', 'USD', 1000,  399.00, 0.3990),
  ('paper_letterpress',        '2_ink', 'USD', 1000,  499.00, 0.4990),
  ('paper_letterpress',        '3_ink', 'USD', 1000,  599.00, 0.5990),
  ('paper_letterpress',        '4_ink', 'USD', 1000,  699.00, 0.6990),
  ('paper_letterpress',        '1_ink', 'USD', 1500,  589.00, 0.3927),
  ('paper_letterpress',        '2_ink', 'USD', 1500,  699.00, 0.4660),
  ('paper_letterpress',        '3_ink', 'USD', 1500,  799.00, 0.5327),
  ('paper_letterpress',        '4_ink', 'USD', 1500,  899.00, 0.5993),
  ('paper_letterpress',        '1_ink', 'USD', 2000,  699.00, 0.3495),
  ('paper_letterpress',        '2_ink', 'USD', 2000,  799.00, 0.3995),
  ('paper_letterpress',        '3_ink', 'USD', 2000,  899.00, 0.4495),
  ('paper_letterpress',        '4_ink', 'USD', 2000,  999.00, 0.4995),

  -- Gilded paper_letterpress_gilded, USD.
  -- Total = plain base (above) + gilded surcharge per quantity.
  ('paper_letterpress_gilded', '1_ink', 'USD',  250,  339.00, 1.3560),
  ('paper_letterpress_gilded', '2_ink', 'USD',  250,  389.00, 1.5560),
  ('paper_letterpress_gilded', '3_ink', 'USD',  250,  419.00, 1.6760),
  ('paper_letterpress_gilded', '4_ink', 'USD',  250,  469.00, 1.8760),
  ('paper_letterpress_gilded', '1_ink', 'USD',  500,  449.00, 0.8980),
  ('paper_letterpress_gilded', '2_ink', 'USD',  500,  499.00, 0.9980),
  ('paper_letterpress_gilded', '3_ink', 'USD',  500,  579.00, 1.1580),
  ('paper_letterpress_gilded', '4_ink', 'USD',  500,  679.00, 1.3580),
  ('paper_letterpress_gilded', '1_ink', 'USD',  750,  559.00, 0.7453),
  ('paper_letterpress_gilded', '2_ink', 'USD',  750,  629.00, 0.8387),
  ('paper_letterpress_gilded', '3_ink', 'USD',  750,  729.00, 0.9720),
  ('paper_letterpress_gilded', '4_ink', 'USD',  750,  829.00, 1.1053),
  ('paper_letterpress_gilded', '1_ink', 'USD', 1000,  739.00, 0.7390),
  ('paper_letterpress_gilded', '2_ink', 'USD', 1000,  839.00, 0.8390),
  ('paper_letterpress_gilded', '3_ink', 'USD', 1000,  939.00, 0.9390),
  ('paper_letterpress_gilded', '4_ink', 'USD', 1000, 1039.00, 1.0390),
  ('paper_letterpress_gilded', '1_ink', 'USD', 1500, 1059.00, 0.7060),
  ('paper_letterpress_gilded', '2_ink', 'USD', 1500, 1169.00, 0.7793),
  ('paper_letterpress_gilded', '3_ink', 'USD', 1500, 1269.00, 0.8460),
  ('paper_letterpress_gilded', '4_ink', 'USD', 1500, 1369.00, 0.9127),
  ('paper_letterpress_gilded', '1_ink', 'USD', 2000, 1289.00, 0.6445),
  ('paper_letterpress_gilded', '2_ink', 'USD', 2000, 1389.00, 0.6945),
  ('paper_letterpress_gilded', '3_ink', 'USD', 2000, 1489.00, 0.7445),
  ('paper_letterpress_gilded', '4_ink', 'USD', 2000, 1589.00, 0.7945)
) as t(material_code, variant_code, currency, quantity, total_price, unit_price)
  on m.code = t.material_code and mv.code = t.variant_code
on conflict (material_variant_id, currency, quantity) do nothing;

commit;
