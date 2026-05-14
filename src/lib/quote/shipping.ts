// Pure shipping helpers shared by the Quote compiler card and the
// copy-paste formatter. Mirrors leadTime.ts in shape: one resolver
// turns the various input gates into a state union, plus a couple
// of bare arithmetic helpers so the card and copy paths apply the
// same maths.
//
// Two shipping flavours feed through this module:
//   * International — FedEx rate via the fedex-rate edge function
//     (migration 000178), always denominated in GBP regardless of
//     compiler currency. Conversion happens at render.
//   * Domestic UK — DPD flat rates (migration 000179) sourced
//     directly from settings (mainland / Northern Ireland). No
//     edge function involved; the resolver returns the right one
//     based on postcode prefix.

import type { Currency } from '../types'
import type { ShippingSettings } from '../shippingSettings'

// Single canonical surcharge shape the card and copy formatter both
// consume. Label is the human-readable description from FedEx
// (e.g. "Out of Delivery Area", "Ancillary Fee") and the amount is
// in the same currency the rate was requested in.
export interface ShippingOtherSurcharge {
  label: string
  amount: number
}

// Edge-function response shape — kept here so consumers can import
// the type without reaching into the function code. Mirrors the
// ParsedRate shape returned by supabase/functions/_shared/fedex.ts
// plus the cached/quotedAt envelope the edge function adds.
export interface ShippingRate {
  available: boolean
  service: string | null
  serviceName: string | null
  currency: Currency | null
  netCharge: number | null
  baseCharge: number | null
  discountAmount: number | null
  discountPercent: number | null
  fuelSurcharge: number | null
  fuelPercent: number | null
  otherSurcharges: ShippingOtherSurcharge[]
  cached: boolean
  quotedAt: string
}

// Resolve a derived parcel weight in grams. (variantWeight × qty)
// + box tare. Defensive: an undefined or invalid variant weight
// resolves to null rather than NaN propagating through the rate
// request, so the card can show its waiting state.
export function deriveParcelWeightGrams(
  variantWeightGrams: number | null | undefined,
  quantity: number | null | undefined,
  boxWeightGrams: number,
): number | null {
  if (variantWeightGrams == null || variantWeightGrams <= 0) return null
  if (quantity == null || quantity <= 0) return null
  const cards = variantWeightGrams * quantity
  return Math.round(cards + Math.max(0, boxWeightGrams))
}

// Apply the admin-set international adjustment percentage. Lives
// frontend-side at render so changing the percentage in admin takes
// effect on the next render with no cache invalidation needed. A
// 0 adjustment is the identity; positive marks up, negative marks
// down.
export function applyIntlAdjustment(amount: number, adjustPercent: number): number {
  return amount * (1 + adjustPercent / 100)
}

// Domestic flat-rate result (migration 000179). Always GBP VAT-
// inclusive at the base — display-side conversion to EUR / USD
// uses the live ECB rate, same as international.
export type DomesticRegion = 'uk_mainland' | 'uk_ni'

export interface DomesticRate {
  region: DomesticRegion
  /** VAT-inclusive flat rate in GBP. */
  totalGbp: number
}

// Northern Ireland detection. BT-prefix postcodes followed by a
// digit cover the actual NI postcode area (BT1–BT94). Test on the
// upper-cased, whitespace-stripped string so "bt7 1aa" and
// "BT7 1AA" resolve identically. Returns false for stub entries
// like "BT" with no digit so we don't flip-flop while the
// designer's still typing.
export function isNorthernIrelandPostcode(postcode: string): boolean {
  const cleaned = postcode.replace(/\s+/g, '').toUpperCase()
  return /^BT\d/.test(cleaned)
}

export function resolveDomesticRate(
  postcode: string,
  settings: ShippingSettings,
): DomesticRate {
  const region: DomesticRegion = isNorthernIrelandPostcode(postcode) ? 'uk_ni' : 'uk_mainland'
  return {
    region,
    totalGbp: region === 'uk_ni'
      ? settings.domesticNiRateGbp
      : settings.domesticMainlandRateGbp,
  }
}

// State union driving the ShippingCard render. Mirrors the lead-time
// shape (string-kind discriminator + payload) so the card render
// reads as a clean switch.
//
//   * not_ready — inputs aren't complete yet (e.g. no destination,
//     no quantity, spread mode, custom-quote bailout). Card hides.
//   * loading   — fetch is in flight. Card shows a placeholder.
//   * quoted    — international (FedEx) rate came back, render
//     the breakdown.
//   * domestic  — UK flat rate, no fetch involved.
//   * unavailable — FedEx didn't offer either of the preferred
//     services for the lane. Card shows the unavailable affordance.
//   * error     — fetch failed. Card shows the error affordance.
export type ShippingState =
  | { kind: 'not_ready' }
  | { kind: 'loading' }
  | { kind: 'quoted'; rate: ShippingRate }
  | { kind: 'domestic'; rate: DomesticRate }
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string }

export interface ShippingStateInputs {
  spreadMode: boolean
  customQuote: boolean
  currency: Currency | null
  quantity: number | null
  destCountry: string | null
  destPostcode: string | null
  variantWeightGrams: number | null
  // International (FedEx) inputs.
  loading: boolean
  rate: ShippingRate | null
  error: string | null
  // Shipping settings — required for resolving domestic flat rates.
  shippingSettings: ShippingSettings | null
}

// Map a raw error string from the fedex-rate edge function (or the
// supabase-js wrapper) to a human sentence the designer can act on.
// The raw string is FedEx's own message after the edge function's
// extractFedExErrorMessage helper has pulled it out of the upstream
// JSON, or our edge function's 400/500 validation messages, or
// (worst case) supabase-js's generic "Edge Function returned a
// non-2xx status code".
//
// Patterns are heuristic — FedEx's error catalogue is large and not
// publicly documented in full, so we match keywords rather than
// trying to enumerate. Anything that doesn't match a known pattern
// passes through as the raw message (still much better than the
// generic wrapper string) unless the input is itself the generic
// wrapper, in which case we substitute a polite catch-all.
export function toFriendlyShippingError(raw: string): string {
  const text = raw.trim()
  const lower = text.toLowerCase()

  // Postcode / postal code rejected by FedEx.
  if (/postal|postcode|zip/.test(lower) && /(invalid|not valid|incorrect|format|unknown|not.*recogn)/.test(lower)) {
    return "That postcode doesn't look right for the destination country. Double-check it and try again."
  }
  // Country code rejected.
  if (/country/.test(lower) && /(invalid|not.*support|not.*recogn|unknown)/.test(lower)) {
    return "FedEx doesn't recognise that destination country."
  }
  // FedEx-side rate limit.
  if (/rate.?limit|too.?many|throttl/.test(lower)) {
    return 'FedEx is rate-limiting requests — wait a few seconds and try again.'
  }
  // Auth / credentials problems on our side.
  if (/credentials? not configured/.test(lower)) {
    return "FedEx credentials aren't configured. Set FEDEX_API_KEY, FEDEX_API_SECRET and FEDEX_ACCOUNT_NUMBER in the Supabase dashboard."
  }
  if (/(unauthori[sz]ed|forbidden|invalid.*credential|401|403)/.test(lower)) {
    return "Couldn't authenticate with FedEx — check the API credentials in admin."
  }
  // FedEx unreachable / token endpoint errors.
  if (/token error|unreachable|gateway/.test(lower)) {
    return 'Could not reach FedEx — try again in a moment.'
  }
  // Generic supabase-js wrapper with no useful detail.
  if (
    text === ''
    || text === 'Edge Function returned a non-2xx status code'
    || text === 'Empty response from shipping rate service'
  ) {
    return "Couldn't fetch a shipping rate — check the destination details and try again."
  }
  // Last resort: pass the underlying message through. It's at least
  // specific, even if not pretty.
  return text
}

export function resolveShippingState(inputs: ShippingStateInputs): ShippingState {
  // Spread mode and the custom-quote bailout are explicit "no
  // shipping card" states from the brief. Bail before any of the
  // other checks so a half-filled form in either of those modes
  // still hides the card cleanly.
  if (inputs.spreadMode || inputs.customQuote) return { kind: 'not_ready' }
  if (
    !inputs.currency
    || !inputs.quantity
    || !inputs.destCountry
    || !inputs.destPostcode
    || inputs.variantWeightGrams == null
  ) {
    return { kind: 'not_ready' }
  }
  // Domestic UK path takes precedence over the FedEx path. No
  // network round-trip; the rate is a lookup into settings.
  if (inputs.destCountry === 'GB') {
    if (!inputs.shippingSettings) return { kind: 'loading' }
    return { kind: 'domestic', rate: resolveDomesticRate(inputs.destPostcode, inputs.shippingSettings) }
  }
  if (inputs.loading) return { kind: 'loading' }
  if (inputs.error) return { kind: 'error', message: inputs.error }
  if (inputs.rate) {
    if (!inputs.rate.available) return { kind: 'unavailable' }
    return { kind: 'quoted', rate: inputs.rate }
  }
  return { kind: 'not_ready' }
}
