-- 000256_order_payment_method.sql
--
-- How an order is paid. 'online' (default) is the Stripe pay-link flow;
-- 'offline' is recorded by the designer for a customer paying by bank transfer
-- etc. — create-order builds an offline order already 'paid' (price breakdown
-- stamped, no Stripe, no Xero) so it flows straight into the To-order queue.
-- Existing rows default to 'online' (they were all pay-link orders).
--
-- public_get_order returns to_jsonb(orders) so the pay page sees the column
-- automatically (harmless); orders already grants authenticated + service_role.

alter table proofs.orders
  add column if not exists payment_method text not null default 'online'
    check (payment_method in ('online', 'offline'));
