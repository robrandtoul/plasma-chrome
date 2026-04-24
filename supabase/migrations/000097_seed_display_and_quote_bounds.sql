-- Migration 000097: seed display_quantities and quote bounds
--
-- Populates the three columns added by migration 000095
-- (display_quantities, quote_min_quantity, quote_max_quantity)
-- on the 17 seeded materials. Values are the curated tier-map
-- report reviewed and locked by Rob.
--
-- Straight overwrite per row, no null-guard, because this seed
-- represents the intentional starting state. Subsequent per-
-- material tweaks happen via the admin content modal
-- (AdminMaterialContentModal) — those saves write with an audit
-- log entry. This migration is deliberately audit-silent: it's
-- infrastructure, not a user edit.
--
-- Only the seeded catalogue is addressed. Any custom materials
-- created through admin since 000009 stay null on these columns
-- until the admin curates them explicitly.

begin;

update materials set
  display_quantities  = '{50,75,100,150,200,250,500,750,1000}'::int[],
  quote_min_quantity  = 50,
  quote_max_quantity  = 1000
  where code = 'metal_steel';

update materials set
  display_quantities  = '{50,75,100,150,200,250,500,750,1000}'::int[],
  quote_min_quantity  = 50,
  quote_max_quantity  = 1000
  where code = 'metal_gold';

update materials set
  display_quantities  = '{50,75,100,150,200,250,500,750,1000}'::int[],
  quote_min_quantity  = 50,
  quote_max_quantity  = 1000
  where code = 'metal_copper';

update materials set
  display_quantities  = '{50,75,100,150,200,250,500,750,1000}'::int[],
  quote_min_quantity  = 50,
  quote_max_quantity  = 1000
  where code = 'metal_gun_metal';

update materials set
  display_quantities  = '{50,75,100,150,200,250,500,750,1000}'::int[],
  quote_min_quantity  = 50,
  quote_max_quantity  = 1000
  where code = 'metal_matte_black';

update materials set
  display_quantities  = '{50,75,100,150,200,250,500,750,1000}'::int[],
  quote_min_quantity  = 50,
  quote_max_quantity  = 1000
  where code = 'metal_matte_white';

update materials set
  display_quantities  = '{50,75,100,150,200,250,500,750,1000}'::int[],
  quote_min_quantity  = 50,
  quote_max_quantity  = 1000
  where code = 'metal_mini_steel';

-- Titanium: unique 25-tier floor, tighter 500-ceiling per Rob's
-- curation (premium small-batch profile).
update materials set
  display_quantities  = '{25,50,75,100,150,200,250,500}'::int[],
  quote_min_quantity  = 25,
  quote_max_quantity  = 500
  where code = 'metal_titanium';

update materials set
  display_quantities  = '{50,75,100,150,200,250,500,750,1000}'::int[],
  quote_min_quantity  = 50,
  quote_max_quantity  = 1000
  where code = 'carbon_fibre';

update materials set
  display_quantities  = '{50,75,100,150,200,250,500,750,1000}'::int[],
  quote_min_quantity  = 50,
  quote_max_quantity  = 1000
  where code = 'wood';

update materials set
  display_quantities  = '{50,75,100,150,200,250,500,750,1000}'::int[],
  quote_min_quantity  = 50,
  quote_max_quantity  = 1000
  where code = 'acrylic';

update materials set
  display_quantities  = '{100,250,500,750,1000,1500,2000,2500,3000,5000}'::int[],
  quote_min_quantity  = 100,
  quote_max_quantity  = 5000
  where code = 'plastic_translucent';

update materials set
  display_quantities  = '{100,250,500,750,1000,1500,2000,2500,3000,5000}'::int[],
  quote_min_quantity  = 100,
  quote_max_quantity  = 5000
  where code = 'plastic_tinted';

update materials set
  display_quantities  = '{100,250,500,750,1000,1500,2000,2500,3000,5000}'::int[],
  quote_min_quantity  = 100,
  quote_max_quantity  = 5000
  where code = 'plastic_satin';

update materials set
  display_quantities  = '{100,250,500,750,1000,1500,2000,2500,3000,5000}'::int[],
  quote_min_quantity  = 100,
  quote_max_quantity  = 5000
  where code = 'plastic_full_colour';

-- Letterpress caps at 2000 in source pricing data.
update materials set
  display_quantities  = '{100,150,200,250,500,750,1000,1500,2000}'::int[],
  quote_min_quantity  = 100,
  quote_max_quantity  = 2000
  where code = 'paper_letterpress';

update materials set
  display_quantities  = '{100,250,500,750,1000,1500,2000,2500,3000,5000}'::int[],
  quote_min_quantity  = 100,
  quote_max_quantity  = 5000
  where code = 'paper_standard';

commit;
