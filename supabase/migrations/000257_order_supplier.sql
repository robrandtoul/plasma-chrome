-- 000257_order_supplier.sql
--
-- Records which supplier an OUTSOURCED order was sent to (Phase 2). When a
-- designer places a supplier-route order, place-order emails the supplier (a new
-- Help Scout conversation that Stock Control's helpscout-outsourced-order webhook
-- ingests). We stamp the chosen supplier + the email's conversation id on the
-- order for the queue display, records, and to guard against a double-send.
--
-- supplier_id references public.outsourced_suppliers.id (Stock Control's schema)
-- but carries no FK — it's a different schema and the proofs side only mirrors it
-- for display. public_get_order returns to_jsonb(orders) so the column is exposed
-- automatically; orders already grants authenticated + service_role.

alter table proofs.orders
  add column if not exists supplier_id uuid,
  add column if not exists supplier_name text,
  add column if not exists supplier_helpscout_conversation_id text;
