-- 000242 — Xero Stripe clearing-account code, for marking order invoices paid.
--
-- By default the ordering app only CREATES the Xero invoice and lets the
-- Stripe→Xero bank feed reconcile it (~a day later), leaving the invoice
-- "awaiting payment" in the meantime. Setting this column to the code of the
-- Stripe clearing/bank account in Xero (the account that receives Stripe funds)
-- switches on instant payment recording: the stripe-webhook applies a payment
-- to the invoice into this account, so it's marked PAID immediately — exactly
-- like Xero's own Pay-now flow. When the real Stripe transaction later arrives
-- via the Stripe account feed, Xero matches it against this payment rather than
-- double-counting (which is why the account must be the Stripe CLEARING account,
-- not the real bank).
--
-- Null (default) = unchanged behaviour: create-only, feed reconciles later.
-- Admin sets it from Admin → Settings (a dropdown of the connected org's bank
-- accounts). Differs between the Demo org and live, so it's a value, not code.

alter table proofs.settings
  add column if not exists xero_stripe_account_code text;

comment on column proofs.settings.xero_stripe_account_code is
  'Xero account code of the Stripe clearing/bank account. When set, the stripe-webhook records a payment to the order invoice into this account so it is marked PAID instantly (the Stripe feed later reconciles against it). Null = create invoice only, feed reconciles later.';
