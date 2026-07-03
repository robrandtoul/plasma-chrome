-- 000302: durable openness flag for QUANTITY, completing the 000298 pattern.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via the dashboard SQL editor / an MCP apply_migration.
--
-- The bug (hit live on ORD-6FD6D17937, 2026-07-03): create-checkout-session
-- persists the customer's chosen quantity onto orders.quantity at
-- PaymentIntent time (so the Stripe→Xero webhook invoices the paid figure).
-- That write destroyed the only marker of "customer chooses" (quantity IS
-- NULL), so on a revisit / "Edit order details" the pay page treated the
-- first pick as designer-locked and hid the quantity field entirely.
-- thickness_open / finish_open (000298) were given durable flags for exactly
-- this reason; quantity predates them and never got one.
--
-- quantity_open mirrors those flags: openness is a property of the order,
-- resolvedness a property of the column. create-order stamps it at creation;
-- create-checkout-session prefers the request body while it is set
-- (request-wins) and keeps persisting the latest pick for the webhook.
--
-- Backfill: an order was created quantity-open iff its creation-time spec
-- snapshot recorded no quantity (buildOrderSpecSnapshot stamps the CREATE
-- state; a later checkout persist never touches it) — that catches rows whose
-- quantity has since been frozen by the bug, including ORD-6FD6D17937.
-- Rows still carrying quantity IS NULL are trivially open. Scoped to online
-- production grid orders — the only kind whose pay page offers a quantity.

alter table proofs.orders
  add column if not exists quantity_open boolean not null default false;

comment on column proofs.orders.quantity_open is
  'Customer chooses the quantity on the pay page. Durable (survives create-checkout-session persisting the chosen figure onto quantity for the webhook/invoice) — the pay page and checkout treat the request''s quantity as authoritative while set. Mirrors thickness_open/finish_open (000298).';

update proofs.orders o
set quantity_open = true
where o.custom_quote_total is null
  and coalesce(o.order_kind, 'production') = 'production'
  and coalesce(o.payment_method, 'online') = 'online'
  and (
    o.quantity is null
    or (o.order_spec_snapshot is not null and o.order_spec_snapshot -> 'quantity' = 'null'::jsonb)
  );
