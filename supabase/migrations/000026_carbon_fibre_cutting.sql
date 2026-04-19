-- Migration 000026: carbon fibre CNC cutting option
--
-- Adds an optional CNC cutting service as a two-option dimension on carbon
-- fibre. The base "Without cutting" option carries no surcharge; "Optional
-- CNC cutting" has quantity-dependent surcharges across all three currencies.
-- Reuses the existing material_options / material_option_surcharges tables,
-- so no frontend work is required — the switcher picks up the new rows.

begin;

-- 1. Set the switcher label for carbon fibre.
update materials
  set option_label = 'Cutting'
  where code = 'carbon_fibre';

-- 2. Seed the two options. "Without cutting" as the base, "Optional CNC
--    cutting" as the surcharged variant.
insert into material_options (material_id, code, display_name, is_base, sort_order)
select m.id, v.code, v.display_name, v.is_base, v.sort_order
from materials m
cross join (values
  ('without_cutting', 'Without cutting',       true,  0),
  ('cnc_cutting',     'Optional CNC cutting',  false, 1)
) as v(code, display_name, is_base, sort_order)
where m.code = 'carbon_fibre';

-- 3. Seed the CNC cutting surcharges — 39 quantity tiers × 3 currencies.
--    No rows for "Without cutting"; it's the base and the grid shows as-is.
with cnc as (
  select mo.id as material_option_id
  from material_options mo
  join materials m on m.id = mo.material_id
  where m.code = 'carbon_fibre' and mo.code = 'cnc_cutting'
)
insert into material_option_surcharges (material_option_id, currency, quantity, surcharge)
select cnc.material_option_id, v.currency, v.quantity, v.surcharge
from cnc
cross join (values
  -- GBP
  ('GBP'::char(3),  50,  50.00), ('GBP'::char(3),  75,  62.00), ('GBP'::char(3), 100,  75.00), ('GBP'::char(3), 125,  88.00),
  ('GBP'::char(3), 150, 100.00), ('GBP'::char(3), 175, 112.00), ('GBP'::char(3), 200, 125.00), ('GBP'::char(3), 225, 138.00),
  ('GBP'::char(3), 250, 150.00), ('GBP'::char(3), 275, 162.00), ('GBP'::char(3), 300, 175.00), ('GBP'::char(3), 325, 188.00),
  ('GBP'::char(3), 350, 200.00), ('GBP'::char(3), 375, 212.00), ('GBP'::char(3), 400, 225.00), ('GBP'::char(3), 425, 238.00),
  ('GBP'::char(3), 450, 250.00), ('GBP'::char(3), 475, 262.00), ('GBP'::char(3), 500, 275.00), ('GBP'::char(3), 525, 292.00),
  ('GBP'::char(3), 550, 310.00), ('GBP'::char(3), 575, 328.00), ('GBP'::char(3), 600, 345.00), ('GBP'::char(3), 625, 362.00),
  ('GBP'::char(3), 650, 380.00), ('GBP'::char(3), 675, 398.00), ('GBP'::char(3), 700, 415.00), ('GBP'::char(3), 725, 432.00),
  ('GBP'::char(3), 750, 450.00), ('GBP'::char(3), 775, 465.00), ('GBP'::char(3), 800, 480.00), ('GBP'::char(3), 825, 495.00),
  ('GBP'::char(3), 850, 510.00), ('GBP'::char(3), 875, 525.00), ('GBP'::char(3), 900, 540.00), ('GBP'::char(3), 925, 555.00),
  ('GBP'::char(3), 950, 570.00), ('GBP'::char(3), 975, 585.00), ('GBP'::char(3),1000, 600.00),
  -- EUR
  ('EUR'::char(3),  50,  50.00), ('EUR'::char(3),  75,  60.00), ('EUR'::char(3), 100,  70.00), ('EUR'::char(3), 125,  82.00),
  ('EUR'::char(3), 150,  95.00), ('EUR'::char(3), 175, 108.00), ('EUR'::char(3), 200, 120.00), ('EUR'::char(3), 225, 130.00),
  ('EUR'::char(3), 250, 140.00), ('EUR'::char(3), 275, 151.00), ('EUR'::char(3), 300, 162.00), ('EUR'::char(3), 325, 173.00),
  ('EUR'::char(3), 350, 184.00), ('EUR'::char(3), 375, 195.00), ('EUR'::char(3), 400, 206.00), ('EUR'::char(3), 425, 217.00),
  ('EUR'::char(3), 450, 228.00), ('EUR'::char(3), 475, 239.00), ('EUR'::char(3), 500, 250.00), ('EUR'::char(3), 525, 268.00),
  ('EUR'::char(3), 550, 285.00), ('EUR'::char(3), 575, 302.00), ('EUR'::char(3), 600, 320.00), ('EUR'::char(3), 625, 338.00),
  ('EUR'::char(3), 650, 355.00), ('EUR'::char(3), 675, 372.00), ('EUR'::char(3), 700, 390.00), ('EUR'::char(3), 725, 408.00),
  ('EUR'::char(3), 750, 425.00), ('EUR'::char(3), 775, 438.00), ('EUR'::char(3), 800, 450.00), ('EUR'::char(3), 825, 462.00),
  ('EUR'::char(3), 850, 475.00), ('EUR'::char(3), 875, 488.00), ('EUR'::char(3), 900, 500.00), ('EUR'::char(3), 925, 512.00),
  ('EUR'::char(3), 950, 525.00), ('EUR'::char(3), 975, 538.00), ('EUR'::char(3),1000, 550.00),
  -- USD
  ('USD'::char(3),  50,  50.00), ('USD'::char(3),  75,  62.00), ('USD'::char(3), 100,  75.00), ('USD'::char(3), 125,  87.00),
  ('USD'::char(3), 150, 100.00), ('USD'::char(3), 175, 115.00), ('USD'::char(3), 200, 130.00), ('USD'::char(3), 225, 145.00),
  ('USD'::char(3), 250, 160.00), ('USD'::char(3), 275, 171.00), ('USD'::char(3), 300, 183.00), ('USD'::char(3), 325, 194.00),
  ('USD'::char(3), 350, 206.00), ('USD'::char(3), 375, 217.00), ('USD'::char(3), 400, 229.00), ('USD'::char(3), 425, 240.00),
  ('USD'::char(3), 450, 252.00), ('USD'::char(3), 475, 263.00), ('USD'::char(3), 500, 275.00), ('USD'::char(3), 525, 295.00),
  ('USD'::char(3), 550, 315.00), ('USD'::char(3), 575, 335.00), ('USD'::char(3), 600, 355.00), ('USD'::char(3), 625, 375.00),
  ('USD'::char(3), 650, 395.00), ('USD'::char(3), 675, 415.00), ('USD'::char(3), 700, 435.00), ('USD'::char(3), 725, 455.00),
  ('USD'::char(3), 750, 475.00), ('USD'::char(3), 775, 497.00), ('USD'::char(3), 800, 520.00), ('USD'::char(3), 825, 542.00),
  ('USD'::char(3), 850, 565.00), ('USD'::char(3), 875, 587.00), ('USD'::char(3), 900, 610.00), ('USD'::char(3), 925, 632.00),
  ('USD'::char(3), 950, 655.00), ('USD'::char(3), 975, 677.00), ('USD'::char(3),1000, 700.00)
) as v(currency, quantity, surcharge);

commit;
