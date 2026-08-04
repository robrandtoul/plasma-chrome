// Delivery-postcode mismatch rules for the Ordering & checkout money paths.
//
// The pay page collects the delivery postcode twice: once for RATING (the
// destination mini-form → create-checkout-session → ship_dest_country /
// ship_dest_postcode) and again inside Stripe's Address Element, which rides
// confirmPayment and lands in ship_to_address. Stripe's address autocomplete
// sometimes resolves to the wrong place entirely — ORD-F41E36FAE8 matched
// "4 Hughes Lane" to Maldon CM9 6UA instead of Malpas SY14 7FB — and nothing
// reconciled the two, so the wrong postcode won silently.
//
// This module is the ONE definition of "do these two destinations agree":
//   * the pay pages call compareShipDest before confirmPayment and ask the
//     customer which is right on a mismatch;
//   * stripe-webhook calls backstopHoldDecision at the sent → paid flip and
//     puts the order on hold (000377) when the mismatch is unexplained or
//     coarse.
// Nothing here ever changes how shipping is priced — only when a human is
// asked to confirm.
//
// Twin of supabase/functions/_shared/shipDestCheck.ts (Vite and Deno can't share a module
// cleanly — if you change one, change the other). shipDestCheck.test.ts
// imports BOTH copies and fails on any drift, exactly like ukVatArea.

import { normaliseShipDestination } from './ukVatArea'
import { isNorthernIrelandPostcode } from './quote/shipping'

export interface ShipDest {
  country: string | null | undefined
  postcode: string | null | undefined
}

// Uppercase, all whitespace stripped (which subsumes trimming): 'sy14 7fb'
// and 'SY147FB' are the same postcode.
export function normalisePostcode(postcode: string | null | undefined): string {
  return (postcode ?? '').toUpperCase().replace(/\s+/g, '')
}

// The primary 5-digit ZIP from a normalised US postcode, ZIP+4 tolerated
// ('60639-3803' and '606393803' → '60639'). Null when it isn't ZIP-shaped.
function zip5(normalised: string): string | null {
  const m = /^(\d{5})(?:-?\d{4})?$/.exec(normalised)
  return m ? m[1] : null
}

// The GB postcode AREA — the leading letters of the outward code ('SY147FB' →
// 'SY', 'G24BL' → 'G'). Null when the string doesn't start like a GB postcode.
function gbArea(normalised: string): string | null {
  const m = /^([A-Z]{1,2})\d/.exec(normalised)
  return m ? m[1] : null
}

// The form a postcode is COMPARED in: normalised, and for the US collapsed to
// the primary ZIP so 60639 vs 60639-3803 is the same place, not a mismatch.
export function comparablePostcode(
  postcode: string | null | undefined,
  country: string | null | undefined,
): string {
  const norm = normalisePostcode(postcode)
  if ((country ?? '').trim().toUpperCase() === 'US') {
    const z = zip5(norm)
    if (z) return z
  }
  return norm
}

// The pricing band a destination falls in. Two destinations in different
// bands are priced differently (DPD mainland vs NI flat rates, FedEx lanes,
// VAT treatment), so a mismatch across bands means the quoted total is wrong
// and the order must be re-rated before payment. normaliseShipDestination
// already maps GB + a JE/GY/IM postcode to the island's own code.
export function shipBand(dest: ShipDest): string {
  const country = normaliseShipDestination(dest.country ?? '', dest.postcode ?? '')
  if (country === 'GB') {
    return isNorthernIrelandPostcode(dest.postcode ?? '') ? 'GB-NI' : 'GB'
  }
  return country
}

// A COARSE mismatch is one where the two values point at visibly different
// parts of the world — the kind that costs a full reship if the wrong one
// wins — as opposed to a same-area typo the customer plausibly meant:
//   * country differs → always coarse;
//   * GB: the alphabetic area of the outward code differs (SY14 vs CM9 →
//     SY vs CM → coarse; TW13 6BG vs TW13 6BL → both TW → not coarse);
//   * US: the first digit of the primary ZIP differs (10001 vs 33308 →
//     coarse);
//   * everywhere else → not coarse (Denmark 5000 vs 5270 is a fine-grained
//     difference we can't judge remotely).
// A GB/US value that can't be parsed at all is treated as coarse — when the
// two already disagree, "unreadable" is not evidence of a near-miss, and the
// cost of being wrong is a reship while the cost of holding is seconds.
export function isCoarseMismatch(rated: ShipDest, entered: ShipDest): boolean {
  const ratedCountry = normaliseShipDestination(rated.country ?? '', rated.postcode ?? '')
  const enteredCountry = normaliseShipDestination(entered.country ?? '', entered.postcode ?? '')
  if (!ratedCountry || !enteredCountry) return false
  if (ratedCountry !== enteredCountry) return true
  const ratedPc = comparablePostcode(rated.postcode, ratedCountry)
  const enteredPc = comparablePostcode(entered.postcode, enteredCountry)
  if (!ratedPc || !enteredPc || ratedPc === enteredPc) return false
  if (ratedCountry === 'GB') {
    const a = gbArea(ratedPc)
    const b = gbArea(enteredPc)
    if (!a || !b) return true
    return a !== b
  }
  if (ratedCountry === 'US') {
    const a = zip5(ratedPc)
    const b = zip5(enteredPc)
    if (!a || !b) return true
    return a[0] !== b[0]
  }
  return false
}

export interface ShipDestComparison {
  // The two destinations name different places (after normalisation).
  mismatch: boolean
  // The entered destination is in a different pricing band, so the quoted
  // total no longer applies — re-rate before taking payment.
  repriceNeeded: boolean
  // See isCoarseMismatch.
  coarse: boolean
}

const NO_MISMATCH: ShipDestComparison = { mismatch: false, repriceNeeded: false, coarse: false }

// The gate's question: does the address the customer just typed agree with
// the destination their order was rated for?
//
// Deliberate skips (all covered by the parity suite):
//   * either country unknown → no comparison (Stripe always supplies one, so
//     this is the malformed-data guard);
//   * either postcode blank → the countries are still compared, but a blank
//     postcode cannot disagree with anything. This is also the free/manual-
//     shipping limitation: the designer's stored hint has no postcode, so
//     that branch can only ever catch a COUNTRY change — a fine-grained
//     postcode error on a free-shipping order is invisible by design.
export function compareShipDest(rated: ShipDest, entered: ShipDest): ShipDestComparison {
  const ratedCountry = normaliseShipDestination(rated.country ?? '', rated.postcode ?? '')
  const enteredCountry = normaliseShipDestination(entered.country ?? '', entered.postcode ?? '')
  if (!ratedCountry || !enteredCountry) return NO_MISMATCH
  if (ratedCountry !== enteredCountry) {
    // A different country is always a different band and always coarse.
    return { mismatch: true, repriceNeeded: true, coarse: true }
  }
  const ratedPc = comparablePostcode(rated.postcode, ratedCountry)
  const enteredPc = comparablePostcode(entered.postcode, enteredCountry)
  if (!ratedPc || !enteredPc || ratedPc === enteredPc) return NO_MISMATCH
  return {
    mismatch: true,
    repriceNeeded: shipBand(rated) !== shipBand(entered),
    coarse: isCoarseMismatch(rated, entered),
  }
}

// ── The webhook's hold decision ─────────────────────────────────────────────

export interface BackstopInput {
  rated: ShipDest
  entered: ShipDest
  // The stored orders.ship_dest_ack / order_groups.ship_dest_ack jsonb,
  // untrusted shape (it is authenticated-writable under RLS).
  ack: unknown
}

export interface BackstopDecision {
  mismatch: boolean
  coarse: boolean
  // The ack vouches for EXACTLY this (rated, entered) pair — a stale ack for
  // an address the customer later changed covers nothing.
  ackCoversEntered: boolean
  hold: boolean
}

const NO_HOLD: BackstopDecision = { mismatch: false, coarse: false, ackCoversEntered: false, hold: false }

// Rob's rule (2026-08-04): hold every unexplained mismatch; an acked mismatch
// escapes the hold ONLY when it is fine-grained. The ack is trustworthy — the
// dialog named both values — but the downside is lopsided: a cross-area
// mismatch that turns out wrong costs a reship and a missed date, clearing a
// hold costs seconds.
//
//   ack recorded | coarse | hold
//   no           | either | yes
//   yes          | no     | no
//   yes          | yes    | yes
export function backstopHoldDecision({ rated, entered, ack }: BackstopInput): BackstopDecision {
  const cmp = compareShipDest(rated, entered)
  if (!cmp.mismatch) return NO_HOLD
  const ackCoversEntered = ackCovers(ack, rated, entered)
  return {
    mismatch: true,
    coarse: cmp.coarse,
    ackCoversEntered,
    hold: !ackCoversEntered || cmp.coarse,
  }
}

function ackCovers(ack: unknown, rated: ShipDest, entered: ShipDest): boolean {
  if (!ack || typeof ack !== 'object' || Array.isArray(ack)) return false
  const a = ack as Record<string, unknown>
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  const sameCountry = (c1: string, p1: string, c2: string | null | undefined, p2: string | null | undefined) =>
    normaliseShipDestination(c1, p1) === normaliseShipDestination(c2 ?? '', p2 ?? '')
  const ackEnteredCountry = str(a.entered_country)
  const ackEnteredPc = str(a.entered_postcode)
  const ackRatedCountry = str(a.rated_country)
  const ackRatedPc = str(a.rated_postcode)
  return (
    comparablePostcode(ackEnteredPc, ackEnteredCountry) === comparablePostcode(entered.postcode, entered.country) &&
    comparablePostcode(ackRatedPc, ackRatedCountry) === comparablePostcode(rated.postcode, rated.country) &&
    sameCountry(ackEnteredCountry, ackEnteredPc, entered.country, entered.postcode) &&
    sameCountry(ackRatedCountry, ackRatedPc, rated.country, rated.postcode)
  )
}
