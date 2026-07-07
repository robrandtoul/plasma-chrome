-- 000306: Xero zero-rated tax rates for non-UK invoices ("0% EU" / "0% ROW").
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via the dashboard SQL editor / an MCP apply_migration.
--
-- VAT-free invoices (EUR/USD always; GBP delivering to the Channel Islands)
-- have booked every line as "No VAT" (TaxType NONE) since checkout shipped.
-- The books want the export filed against the org's own zero rates instead:
-- deliveries into the EU VAT area should read "0% EU", everywhere else
-- "0% ROW". These two columns hold the Xero TaxType codes behind those rate
-- names. The invoice writers (stripe-webhook / retry-order-invoice via
-- _shared/xero.ts + _shared/euVatArea.ts) book every line of a VAT-free
-- invoice to the matching code; while a column is NULL they keep the old
-- NoTax treatment, so an unset value can never block an invoice. Editable
-- under Admin → Settings (the rate list loads from Xero once the connection
-- carries the new accounting.settings.read scope — one reconnect).
--
-- The seeded values are the LIVE org's codes, read from its tax-rate list on
-- 2026-07-07: "0% EU" = TAX004, "0% ROW" = TAX003. Seeding makes the fix
-- live the moment this applies. A fresh replay elsewhere seeds the same
-- codes into its (empty) settings row; an org that rejects an unknown code
-- degrades to the existing summary-line fallback and the admin page can
-- re-pick at any time.

alter table proofs.settings
  add column if not exists xero_eu_tax_type text,
  add column if not exists xero_row_tax_type text;

comment on column proofs.settings.xero_eu_tax_type is
  'Xero TaxType code of the zero-rated rate EU-bound VAT-free invoices book to (the org''s "0% EU" rate; TAX004 on the live org). NULL = book lines as "No VAT" (legacy NoTax treatment).';
comment on column proofs.settings.xero_row_tax_type is
  'Xero TaxType code of the zero-rated rate rest-of-world VAT-free invoices book to (the org''s "0% ROW" rate; TAX003 on the live org). NULL = book lines as "No VAT" (legacy NoTax treatment).';

update proofs.settings
set xero_eu_tax_type = coalesce(xero_eu_tax_type, 'TAX004'),
    xero_row_tax_type = coalesce(xero_row_tax_type, 'TAX003')
where id = 1;
