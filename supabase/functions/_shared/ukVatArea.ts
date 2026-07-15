// UK VAT area rules for the Ordering & checkout money paths.
//
// The UK VAT area is the United Kingdom (GB — England, Scotland, Wales and
// Northern Ireland) PLUS the Isle of Man (IM), which operates UK VAT under
// its own administration. A GBP order delivering ANYWHERE OUTSIDE that area
// is a zero-rated export — the Channel Islands (Jersey JE, Guernsey GG), the
// EU and the rest of the world alike. (This relief used to be wired only for
// the Channel Islands; it now covers any export we ship, e.g. a UK company
// having us post the cards straight to an overseas office, for which we hold
// proof of export.)
//
// GBP prices are VAT-inclusive (house rule, seed.sql), so a VAT-free GBP order
// is charged the price-list figure with the VAT element removed (÷ 1.20,
// rounded to the penny at the strip point) and its Xero invoice books with no
// VAT. The Isle of Man is deliberately NOT VAT-free — UK VAT applies there
// exactly as on the mainland; it differs from GB only in shipping (FedEx-rated,
// since the DPD mainland flat rate doesn't serve it).
//
// The automatic decision is by destination (isVatFreeGbpDestination);
// isGbpOrderVatFree layers the designer's per-order manual override on top.
//
// Twin of src/lib/ukVatArea.ts (Vite and Deno can't share a module cleanly
// — if you change one, change the other). ukVatArea.test.ts imports BOTH
// copies and fails on any drift.

export const UK_VAT_RATE = 0.2

// Inside the UK VAT area (GB + Isle of Man): UK VAT applies, and the invoice's
// shipping line books to the domestic (VAT-bearing) Xero item rather than the
// zero-rated international one.
const UK_VAT_AREA_COUNTRIES = new Set(['GB', 'IM'])

export function isUkVatAreaCountry(country: string | null | undefined): boolean {
  return UK_VAT_AREA_COUNTRIES.has((country ?? '').trim().toUpperCase())
}

// Whether a GBP order's DESTINATION makes it VAT-free: the goods are delivered
// outside the UK VAT area, so it's a zero-rated export — the Channel Islands,
// the EU and the rest of the world alike. An unknown / blank destination
// returns false: we never zero-rate without knowing where the goods go. This
// is the automatic rule; isGbpOrderVatFree layers the designer's manual
// override on top.
export function isVatFreeGbpDestination(country: string | null | undefined): boolean {
  const c = (country ?? '').trim().toUpperCase()
  if (!c) return false
  return !isUkVatAreaCountry(c)
}

// The three VAT treatments an order (or order group) can carry.
export type VatTreatment = 'auto' | 'export' | 'standard'

// Whether a GBP order should be charged + invoiced VAT-free, honouring the
// designer's manual override:
//   'export'   — force zero-rating (a direct export we ship and hold proof of
//                export for), even if the destination looks domestic or unknown
//   'standard' — force UK VAT even on a non-UK delivery
//   'auto'     — decide from the delivery destination (isVatFreeGbpDestination)
// The caller still gates on currency === 'GBP'; EUR/USD are VAT-free by the
// house rule regardless, so the override is only meaningful for GBP.
export function isGbpOrderVatFree(
  treatment: string | null | undefined,
  country: string | null | undefined,
): boolean {
  const t = (treatment ?? 'auto').trim().toLowerCase()
  if (t === 'export') return true
  if (t === 'standard') return false
  return isVatFreeGbpDestination(country)
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
