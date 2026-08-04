// The pay pages' delivery-postcode gate — the model behind the "which
// postcode is right?" panel both OrderPayPage and OrderGroupPayPage show
// before confirmPayment when the Stripe Address Element's value disagrees
// with the destination the order was rated for (the ORD-F41E36FAE8 bug:
// Stripe's autocomplete matched "4 Hughes Lane" to the wrong county and the
// wrong postcode won silently).
//
// Pure resolution only — the comparison rules live in shipDestCheck.ts (the
// twin the stripe-webhook backstop also runs), so the client gate and the
// server hold decision cannot drift.

import { compareShipDest, normalisePostcode, type ShipDest } from './shipDestCheck'
import { SHIP_COUNTRIES } from './shipCountries'
import type { StripeAddressValue } from './stripeJs'

export interface AddressGateState {
  // Ask-once identity for this exact (rated, entered) pair — a card decline
  // after "deliver to this address" must not re-ask the same question.
  key: string
  // Display values, as the customer knows them (raw, not normalised).
  ratedPostcode: string
  ratedCountry: string
  entered: { country: string; postcode: string; line1: string; city: string }
  // The full element value, kept so a reprice can re-seed the remounted
  // Address Element via defaultValues.
  enteredValue: StripeAddressValue
  // The entered address is in a different pricing band (country / NI /
  // Crown dependency), so the quoted total is wrong and the order must be
  // re-rated before payment can proceed.
  repriceNeeded: boolean
  // Coarse = visibly different part of the world (different GB area / US ZIP
  // prefix / country). Recorded with the ack; the webhook holds coarse
  // mismatches even when confirmed.
  coarse: boolean
}

export function gateKey(rated: ShipDest, entered: ShipDest): string {
  return [
    (rated.country ?? '').trim().toUpperCase(),
    normalisePostcode(rated.postcode),
    (entered.country ?? '').trim().toUpperCase(),
    normalisePostcode(entered.postcode),
  ].join('|')
}

// Null = nothing to ask (values agree, or there's nothing comparable).
export function resolveAddressGate(
  rated: ShipDest,
  value: StripeAddressValue | null | undefined,
): AddressGateState | null {
  const addr = value?.address
  if (!addr) return null
  const entered: ShipDest = { country: addr.country ?? '', postcode: addr.postal_code ?? '' }
  const cmp = compareShipDest(rated, entered)
  if (!cmp.mismatch) return null
  return {
    key: gateKey(rated, entered),
    ratedPostcode: (rated.postcode ?? '').trim(),
    ratedCountry: (rated.country ?? '').trim().toUpperCase(),
    entered: {
      country: (addr.country ?? '').trim().toUpperCase(),
      postcode: (addr.postal_code ?? '').trim(),
      line1: (addr.line1 ?? '').trim(),
      city: (addr.city ?? '').trim(),
    },
    enteredValue: value ?? {},
    repriceNeeded: cmp.repriceNeeded,
    coarse: cmp.coarse,
  }
}

export function countryName(code: string): string {
  const c = (code ?? '').trim().toUpperCase()
  return SHIP_COUNTRIES.find((s) => s.code === c)?.name ?? c
}
