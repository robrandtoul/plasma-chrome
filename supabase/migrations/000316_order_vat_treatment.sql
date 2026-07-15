-- 000316_order_vat_treatment.sql
-- Manual VAT-treatment override on orders + order groups (Ordering & checkout).
--
-- Automatic zero-rating now covers ANY GBP order delivering outside the UK VAT
-- area (a direct export Plasma ships and holds proof of export for), not just
-- the Channel Islands — see _shared/ukVatArea.ts / src/lib/ukVatArea.ts. This
-- column is the designer's manual override for the rare case the destination
-- alone gets it wrong:
--   'auto'     — decide from the delivery destination (the default)
--   'export'   — force VAT-free (zero-rated export) regardless of destination
--   'standard' — force UK VAT even on a non-UK delivery
--
-- Consumed by create-order + create-checkout-session (pricing), stripe-webhook
-- and retry-order-invoice (Xero tax treatment via isGbpOrderVatFree), and the
-- customer pay pages. The pay pages read it through public_get_order /
-- public_get_order_group, which serialise the whole row via to_jsonb(o) /
-- to_jsonb(g) — so a new column is exposed automatically and neither RPC needs
-- editing. Only meaningful for GBP orders; EUR/USD are VAT-free by the house
-- rule regardless.
--
-- No grants block: ALTER TABLE ADD COLUMN inherits the table's existing grant
-- matrix (grants are table-level, not column-level), so the frontend CRUD +
-- service-role access from 000176 already cover this column. Existing rows
-- default to 'auto', which reproduces today's destination-driven behaviour, so
-- the change is inert until a designer picks an override.

alter table proofs.orders
  add column if not exists vat_treatment text not null default 'auto'
    check (vat_treatment in ('auto', 'export', 'standard'));

alter table proofs.order_groups
  add column if not exists vat_treatment text not null default 'auto'
    check (vat_treatment in ('auto', 'export', 'standard'));
