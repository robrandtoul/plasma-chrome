-- 000289_orders_stock_colour.sql
-- Relay the specific plastic/acrylic STOCK COLOUR from proof-viewer to Stock
-- Control.
--
-- Proof-viewer records only the GENERIC material for satin / tinted / acrylic
-- cards (e.g. "Satin Plastic") because the colour isn't a price factor and the
-- designer doesn't pick it at proof time. Stock Control, though, stocks each
-- colour as its own public.materials row (Satin Black / Satin White / Satin
-- Navy …) and must allocate the right one. Today the in-house hand-off note's
-- "Card:" line is just the generic name, so Stock Control can't disambiguate
-- and bounces the order back for a human to name the colour.
--
-- The To-order card now captures the specific colour when staff compile the
-- paid order — sourced LIVE from Stock Control's own catalogue, so the value we
-- store is the verbatim public.materials.name its in-house parser resolves
-- against — and place-order emits it on the "Card:" line.
--
-- One nullable text column on the existing proofs.orders table. No grants
-- needed: a new column inherits proofs.orders' existing grant matrix (000176),
-- so authenticated keeps full CRUD and the service-role edge functions keep
-- access. Backward-compatible: existing orders are NULL, which place-order
-- treats exactly as today (emit the generic material name).

alter table proofs.orders
  add column if not exists stock_colour text;

comment on column proofs.orders.stock_colour is
  'Specific Stock Control colour for plastic/acrylic cards (verbatim public.materials.name, e.g. "Satin Black Plastic"), captured on the To-order card and sourced live from public.materials. NULL when the material''s colour is unambiguous (translucent), printed (full colour) or carried elsewhere (letterpress/wood/metal).';
