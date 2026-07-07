// UK VAT area rules for the Ordering & checkout money paths.
//
// The UK VAT area is the United Kingdom (GB — England, Scotland, Wales and
// Northern Ireland) PLUS the Isle of Man (IM), which operates UK VAT under
// its own administration. The Channel Islands — Jersey (JE) and the
// Bailiwick of Guernsey (GG, which also covers Alderney, Sark and Herm) —
// are OUTSIDE the UK VAT area even though they use sterling and UK-format
// postcodes: goods delivered there are zero-rated exports.
//
// GBP prices are VAT-inclusive (house rule, seed.sql), so a GBP order
// delivering to the Channel Islands is charged the price-list figure with
// the VAT element removed (÷ 1.20, rounded to the penny at the strip point)
// and its Xero invoice books with no VAT. The Isle of Man is deliberately
// NOT VAT-free — UK VAT applies there exactly as on the mainland; it
// differs from GB only in shipping (FedEx-rated, since the DPD mainland
// flat rate doesn't serve it).
//
// Twin of src/lib/ukVatArea.ts (Vite and Deno can't share a module cleanly
// — if you change one, change the other). ukVatArea.test.ts imports BOTH
// copies and fails on any drift.

export const UK_VAT_RATE = 0.2

// Countries whose GBP orders are VAT-free (charged ex-VAT, invoiced NoTax).
const VAT_FREE_GBP_COUNTRIES = new Set(['JE', 'GG'])

// Inside the UK VAT area (GB + Isle of Man): the invoice's shipping line
// books to the domestic (VAT-bearing) Xero item rather than the zero-rated
// international one.
const UK_VAT_AREA_COUNTRIES = new Set(['GB', 'IM'])

export function isVatFreeGbpDestination(country: string | null | undefined): boolean {
  return VAT_FREE_GBP_COUNTRIES.has((country ?? '').trim().toUpperCase())
}

export function isUkVatAreaCountry(country: string | null | undefined): boolean {
  return UK_VAT_AREA_COUNTRIES.has((country ?? '').trim().toUpperCase())
}

// Customers in the Crown dependencies habitually pick "United Kingdom" and
// type their JE / GY / IM postcode (they're UK-format). Map GB + such a
// postcode to the island's own ISO code so VAT, the shipping rating (FedEx,
// not the mainland DPD flat rate) and the invoice all agree on where the
// order is really going. Mirrors the Northern Ireland BT-postcode detection
// in shipping.ts; any other input passes through unchanged.
export function normaliseShipDestination(
  country: string | null | undefined,
  postcode: string | null | undefined,
): string {
  const c = (country ?? '').trim().toUpperCase()
  if (c !== 'GB') return c
  const p = (postcode ?? '').replace(/\s+/g, '').toUpperCase()
  if (/^JE\d/.test(p)) return 'JE'
  if (/^GY\d/.test(p)) return 'GG'
  if (/^IM\d/.test(p)) return 'IM'
  return c
}

// Strip the VAT element from a VAT-inclusive GBP figure, rounded to the
// penny AT THE STRIP POINT. Relief is applied to the pricing INPUTS (tier
// totals, tooling surcharge, personalisation rates) before any
// interpolation — never to a computed result, because the interpolation's
// round-up-to-£1 step isn't scale-invariant — so every stripped input is a
// clean 2 dp money figure and the server charge, the stamped amount_*
// breakdown and the pay-page mirror all run identical maths.
export function exVat(amountIncVat: number): number {
  return Math.round((amountIncVat / (1 + UK_VAT_RATE)) * 100) / 100
}
