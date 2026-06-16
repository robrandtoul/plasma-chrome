-- 000240 — record why a paid order's Xero invoice could not be created.
--
-- The Stripe webhook creates the Xero invoice on a best-effort basis (Step
-- 5b): a rejection must never fail the customer's payment, so it was only
-- logged and left `xero_invoice_id` null. That made a failed invoice
-- invisible — the only way to spot one was to check Xero by hand (which is
-- exactly how the first USD order's miss was found: the Demo Company is
-- GBP-only, so Xero rejected the foreign-currency invoice).
--
-- This column captures Xero's rejection text (or the caught exception) so the
-- Orders page can flag the miss and a designer can retry it. Cleared back to
-- null whenever an invoice is successfully created (live webhook or the
-- retry-order-invoice function), so a stale error never lingers on a row that
-- has since invoiced.
--
-- Additive and nullable; inherits the orders table grants (no new grant
-- needed). Designers already have SELECT on orders (000229); the column rides
-- the existing authenticated CRUD that the webhook/service-role and the
-- Orders page rely on.

alter table proofs.orders
  add column if not exists xero_invoice_error text;

comment on column proofs.orders.xero_invoice_error is
  'Xero rejection text / exception from the last failed invoice-create attempt; null once an invoice is successfully created. Surfaced on the Orders page as an "Invoice failed" flag with a Retry action.';
