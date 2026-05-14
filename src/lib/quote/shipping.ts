// Pure shipping helpers shared by the Quote compiler card and the
// copy-paste formatter. Mirrors leadTime.ts in shape: one resolver
// turns the various input gates into a state union, plus a couple
// of bare arithmetic helpers so the card and copy paths apply the
// same maths.

import type { Currency } from '../types'

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

// State union driving the ShippingCard render. Mirrors the lead-time
// shape (string-kind discriminator + payload) so the card render
// reads as a clean switch.
//
//   * not_ready — inputs aren't complete yet (e.g. no destination,
//     no quantity, spread mode, custom-quote bailout). Card hides.
//   * loading   — fetch is in flight. Card shows a placeholder.
//   * quoted    — rate came back, render the breakdown.
//   * unavailable — FedEx didn't offer either of the preferred
//     services for the lane. Card shows the unavailable affordance.
//   * error     — fetch failed. Card shows the error affordance.
export type ShippingState =
  | { kind: 'not_ready' }
  | { kind: 'loading' }
  | { kind: 'quoted'; rate: ShippingRate }
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
  loading: boolean
  rate: ShippingRate | null
  error: string | null
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
  if (inputs.loading) return { kind: 'loading' }
  if (inputs.error) return { kind: 'error', message: inputs.error }
  if (inputs.rate) {
    if (!inputs.rate.available) return { kind: 'unavailable' }
    return { kind: 'quoted', rate: inputs.rate }
  }
  return { kind: 'not_ready' }
}
