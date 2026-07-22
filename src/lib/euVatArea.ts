// EU VAT-area membership — the pay page's twin of the country set in
// supabase/functions/_shared/euVatArea.ts.
//
// The server file owns the full "0% EU" / "0% ROW" invoice tax-rate
// classification (zeroRatedRegion) and stays server-only. The pay page needs
// just one thing from it: is a delivery going to the EU? — to decide whether to
// offer the optional VAT / EORI field at checkout (migration 000341). So only
// the country membership is mirrored here; supabase/functions/_shared/
// euVatArea.test.ts imports both copies and fails on any drift between them.

// The 27 EU member states (ISO-3166 alpha-2) plus Monaco, which is part of the
// French VAT territory. Greece is GR (EL appears only on VAT numbers). Northern
// Ireland ships as GB with a BT postcode and stays inside the UK VAT treatment,
// so it never reaches this classification. Keep in lockstep with the server set.
export const EU_VAT_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR',
  'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL',
  'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'MC',
])

export function isEuVatCountry(country: string | null | undefined): boolean {
  return EU_VAT_COUNTRIES.has((country ?? '').trim().toUpperCase())
}
