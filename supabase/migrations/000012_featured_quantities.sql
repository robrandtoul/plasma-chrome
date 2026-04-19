-- Migration 000012: add featured_quantities to materials
--
-- Controls which quantity rows are shown by default on the customer proof page.
-- All tiers remain visible via a "Show all quantities" toggle.
-- The Add Version form is unaffected and always shows the full list.

alter table materials
  add column featured_quantities int[] not null default '{100,250,500,750,1000}'::int[];

-- Per-material overrides (matched by code, which is stable)
update materials set featured_quantities = '{25,50,100,250,500}'   where code = 'metal_steel';
update materials set featured_quantities = '{25,50,100,250,500}'   where code = 'metal_gold';
update materials set featured_quantities = '{25,50,100,250,500}'   where code = 'metal_copper';
update materials set featured_quantities = '{25,50,100,250,500}'   where code = 'metal_gun_metal';
update materials set featured_quantities = '{25,50,100,250,500}'   where code = 'metal_matte_black';
update materials set featured_quantities = '{25,50,100,250,500}'   where code = 'metal_matte_white';
update materials set featured_quantities = '{50,75,100,250,500}'   where code = 'wood';
update materials set featured_quantities = '{50,100,150,250,500}'  where code = 'carbon_fibre';
update materials set featured_quantities = '{50,75,100,250,500}'   where code = 'acrylic';
update materials set featured_quantities = '{250,500,1000,2000,3000}' where code = 'paper_standard';

-- Mini Steel, Titanium, plastics, and Letterpress keep the column default.
