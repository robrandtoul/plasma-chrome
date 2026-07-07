// EU VAT-area membership, for the Xero tax treatment on VAT-free invoices.
//
// A VAT-free order (EUR/USD always; GBP delivering to the Channel Islands)
// used to book every invoice line as "No VAT" (TaxType NONE). The books
// want the export filed against the right zero rate instead: deliveries
// into the EU VAT area book to the org's "0% EU" tax rate, everywhere else
// to "0% ROW". The TaxType codes behind those names are org-specific and
// admin-editable (settings.xero_eu_tax_type / xero_row_tax_type, migration
// 000306); while unset the invoice keeps the old NoTax treatment.
//
// Server-side only — the pay page never shows tax codes, so unlike
// ukVatArea.ts this has no src/lib twin.

import { isUkVatAreaCountry } from './ukVatArea.ts'

// The 27 EU member states (ISO-3166 alpha-2) plus Monaco, which is part of
// the French VAT territory. Greece is GR (EL appears only on VAT numbers).
// Northern Ireland ships as GB with a BT postcode and stays inside the UK
// VAT treatment, so it never reaches this classification.
export const EU_VAT_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR',
  'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL',
  'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'MC',
])

export function isEuVatCountry(country: string | null | undefined): boolean {
  return EU_VAT_COUNTRIES.has((country ?? '').trim().toUpperCase())
}

// Which zero-rated rate a VAT-free invoice books to: 'eu' | 'row', or null
// to keep the plain NoTax treatment. The delivery country wins when known —
// a EUR order to Switzerland is ROW, a GBP Channel Islands order is ROW —
// and an unknown destination falls back on the currency (EUR sells only
// into Europe; USD everywhere else). UK VAT-area destinations return null:
// a VAT-free invoice there is an anomaly this labelling must not paper
// over, so it stays visibly "No VAT".
export function zeroRatedRegion(
  country: string | null | undefined,
  currency: string,
): 'eu' | 'row' | null {
  const c = (country ?? '').trim().toUpperCase()
  if (c) {
    if (isUkVatAreaCountry(c)) return null
    return isEuVatCountry(c) ? 'eu' : 'row'
  }
  const cur = (currency ?? '').trim().toUpperCase()
  if (cur === 'EUR') return 'eu'
  if (cur === 'USD') return 'row'
  return null
}
