-- 000234: order fulfilment + delivery address (Ordering & checkout, Step 6).
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via the dashboard SQL editor / an MCP apply_migration. Do NOT
-- use `supabase db push`.
--
-- AUTHORED, NOT YET APPLIED — for Rob's review before applying. Step 6 turns a
-- paid order into a "go print this" signal for the team and lets a designer
-- mark it shipped. This adds:
--   * the fulfilment audit columns (when, by whom),
--   * the delivery address the customer entered on Stripe. The stripe-webhook
--     already PARSES that address (to pick the shipping item + populate the
--     Xero contact); now it also PERSISTS it here so the fulfilment surface can
--     show the team where each order ships.
--
-- Additive only. No new grants needed: authenticated already has full CRUD on
-- proofs.orders (000229) and new columns inherit it; service_role (the webhook)
-- writes them under its existing grant.

alter table proofs.orders
  add column if not exists fulfilled_at    timestamptz,
  add column if not exists fulfilled_by    uuid references auth.users(id),
  add column if not exists ship_to_name    text,
  add column if not exists ship_to_email   text,
  -- Structured delivery address: { line1, line2, city, region, postal_code,
  -- country }. jsonb (not split columns) because it's display-only here — the
  -- canonical address of record stays on the Stripe payment + the Xero invoice.
  add column if not exists ship_to_address jsonb;

-- Partial index for the fulfilment queue: paid orders awaiting dispatch,
-- newest first. Keeps the queue query off a full table scan as orders grow.
create index if not exists orders_awaiting_fulfilment_idx
  on proofs.orders(paid_at desc)
  where status = 'paid';
