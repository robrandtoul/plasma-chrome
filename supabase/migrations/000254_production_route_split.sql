-- 000254_production_route_split.sql
--
-- Correct materials.production_route (added in 000252 with an in_house default
-- on every row). Only the materials Plasma cuts/produces in-house exist in the
-- Stock Control catalogue (public.materials): plastics, acrylic, tinted /
-- translucent plastic, wood and letterpress. Everything else — all metals,
-- carbon fibre (+ CNC), full colour plastic and standard paper — is bought in
-- from a supplier, so it routes to the outsourced (supplier) hand-off, not the
-- in-house production note.
--
-- This drives the Orders page route badge + the "Mark as ordered" hand-off:
-- in_house posts the production note onto the Help Scout thread (which Stock
-- Control's helpscout-inhouse-order webhook ingests against public.materials);
-- supplier is the phase-2 outsourced-email route.

update proofs.materials
set production_route = 'supplier'
where category in ('metal', 'carbon_fibre')
   or code in ('plastic_full_colour', 'paper_standard');

update proofs.materials
set production_route = 'in_house'
where code in (
  'acrylic',
  'plastic_satin',
  'plastic_tinted',
  'plastic_translucent',
  'wood',
  'paper_letterpress',
  'paper_letterpress_gilded'
);
