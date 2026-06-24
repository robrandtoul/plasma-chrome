-- 000262_order_pay_link_opened.sql
-- Record the MOST RECENT time a customer opened a payment link (the anonymous
-- /order/:id?token=… pay page), so it can be surfaced on the Orders "awaiting
-- payment" row and the dashboard "Latest activity" feed.
--
-- Minimal surface by design: the new column auto-flows to the anon pay page via
-- public_get_order (which returns to_jsonb(o) - 'token'), and is directly
-- selectable by authenticated designers (OrdersPage / DashboardPage) under the
-- existing RLS — so no view changes are needed. The only new objects are the
-- column and a token-validated setter the anon page calls.

-- 1. The timestamp. Nullable; null = never opened. Adding a column to an existing
--    proofs-schema table inherits the table's grants (no grant statement needed).
alter table proofs.orders
  add column if not exists pay_link_opened_at timestamptz;

-- 2. Token-validated setter for the anonymous pay page. anon has no write grant
--    on proofs.orders (deliberately — see 000162 / 000230), so the stamp goes
--    through a SECURITY DEFINER RPC gated on the same secret token as
--    public_get_order. Only stamps a still-payable ('sent') order, and overwrites
--    on every call so the column always holds the MOST RECENT open (a customer
--    revisiting a paid/expired link won't move the clock).
create or replace function proofs.record_order_pay_link_opened(p_order_id uuid, p_token text)
returns void
language sql
security definer
set search_path to 'proofs', 'public', 'extensions', 'pg_temp'
as $$
  update proofs.orders
     set pay_link_opened_at = now()
   where id = p_order_id
     and token = p_token
     and status = 'sent';
$$;

revoke execute on function proofs.record_order_pay_link_opened(uuid, text) from public;
grant  execute on function proofs.record_order_pay_link_opened(uuid, text) to anon, authenticated;
