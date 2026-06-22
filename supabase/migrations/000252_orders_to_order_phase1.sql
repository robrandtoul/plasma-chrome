-- 000252_orders_to_order_phase1.sql
--
-- Orders page overhaul, phase 1 (the in-house "To order" hand-off). Schema
-- foundation only; the page redesign, the Dropbox folder read, and the
-- "Mark as ordered" note hand-off build on these columns.
--
-- The page reframes paid orders from "to fulfil" (which Stock Control owns)
-- to "to order" — compile + place into production (in-house) or with a
-- supplier. Phase 1 wires the in-house route: posting the structured
-- production note onto the customer's Help Scout thread, which the existing
-- helpscout-inhouse-order webhook ingests into Stock Control. The supplier
-- (outsourced-email) route + the suppliers config land in phase 2.

-- Per-material routing. in_house = the order is placed by posting the
-- production note (phase 1). supplier = the outsourced-email route (phase 2);
-- those orders are shown as "supplier — coming soon" until that ships.
-- Default in_house; the known outsourced families (metal, full-colour plastic)
-- are flipped to 'supplier' from Admin once the per-material routing UI ships.
alter table proofs.materials
  add column if not exists production_route text not null default 'in_house'
    check (production_route in ('in_house', 'supplier'));

-- Order-placement fields, all set on the Orders page when the order is compiled.
alter table proofs.orders
  -- The production deadline shown in the note. In-house = today + material lead
  -- time; supplier = that minus the supplier's shipping days (phase 2). Stored
  -- as a date the designer can override.
  add column if not exists date_required date,
  -- The order's Dropbox folder (named "<number> - <project>") — both the home
  -- of the prepped source artwork and the source of the order identity. The
  -- gate: an order can't be placed until this is linked.
  add column if not exists dropbox_folder_url text,
  -- Read from the Dropbox folder name. stock_order_number is the number Stock
  -- Control keys on (it reads it from the Help Scout subject "Order <number> -
  -- <project>"); project_name is the rest of the folder name. Both drive the
  -- auto-set subject + the production note.
  add column if not exists stock_order_number text,
  add column if not exists project_name text;

comment on column proofs.orders.dropbox_folder_url is
  'Order''s Dropbox folder (named "<number> - <project>"): prepped source artwork + order identity. Required before an order can be placed.';
comment on column proofs.orders.stock_order_number is
  'Stock Control order number, read from the Dropbox folder name. Drives the Help Scout subject the helpscout-inhouse-order webhook keys on.';
