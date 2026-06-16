-- 000236: order shipping destination + per-order discount (Ordering & checkout).
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via the dashboard SQL editor / an MCP apply_migration. Do NOT
-- use `supabase db push`.
--
-- AUTHORED, NOT YET APPLIED — for Rob's review before applying.
--
-- The 'full_cost' and 'goodwill' shipping treatments are now live at checkout:
-- create-checkout-session computes the carriage (UK flat DPD rate, or a FedEx
-- account rate for international) and adds it as a Stripe line item. Two inputs
-- the designer sets when building the order drive that:
--
--   * ship_dest_country / ship_dest_postcode — the destination the rate is
--     quoted against (Plasma's origin is fixed). Required for full_cost /
--     goodwill; the actual delivery address is still collected on Stripe.
--   * shipping_discount_percent — Rob's decision 2026-06-15: goodwill is a
--     per-order percentage off the computed rate, set by the designer issuing
--     the link (not a fixed per-zone cap). full_cost = 0% off; free = 100% off
--     (modelled as its own treatment); manual = a fixed figure (unchanged).
--
-- Additive only. authenticated already has full CRUD on proofs.orders (000229)
-- and these columns inherit it; service_role (the checkout edge function) reads
-- them. No view/RPC re-grant needed — orders is read by token-scoped RPC +
-- service role only, never anon.

alter table proofs.orders
  add column if not exists ship_dest_country text
    check (ship_dest_country is null or ship_dest_country ~ '^[A-Z]{2}$'),
  add column if not exists ship_dest_postcode text,
  add column if not exists shipping_discount_percent numeric(5,2)
    check (shipping_discount_percent is null
           or (shipping_discount_percent >= 0 and shipping_discount_percent <= 100));
