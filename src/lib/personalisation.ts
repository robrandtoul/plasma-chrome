// Personalisation pricing helper (migration 000172).
//
// Personalisation prices unique-per-card data (member numbers, names,
// etc.) layered on top of the base price grid. Distinct from the
// split-name tooling surcharge which prices multi-name batches that
// share a single design.
//
// Pricing rule, per currency:
//
//   surcharge(qty) = max(min_charge, qty * per_card_rate)
//
// The rate and floor are admin-editable from the Settings page and
// live in personalisation_pricing. They are NEVER snapshotted onto
// proof_versions — the customer page reads live values via
// public_get_customer_proof every load, so a rate change applies
// immediately to every personalised proof. Breakeven for the seeded
// values: GBP 250 cards, USD 200, EUR 200.

import type { PersonalisationPricing } from './types'

// Returns the per-card surcharge at a given quantity, in major
// currency units. Always >= min_charge.
export function personalisationSurchargeForQty(
  qty: number,
  pricing: PersonalisationPricing,
): number {
  const linear = qty * pricing.per_card_rate
  return linear < pricing.min_charge ? pricing.min_charge : linear
}

// Compiler output. Computes a per-qty surcharge map across a list of
// visible quantities for the proof's currency. Empty map is returned
// when pricing is unavailable so the caller can spread {} into the
// PricingTable props without conditional logic.
//
// The brief is explicit: do NOT fold these into base price cells.
// The customer page renders this map as separate rows beneath the
// pricing grid.
export function compilePersonalisationSurcharges(
  quantities: readonly number[],
  pricing: PersonalisationPricing | null | undefined,
): Record<number, number> {
  if (!pricing) return {}
  const out: Record<number, number> = {}
  for (const q of quantities) {
    out[q] = personalisationSurchargeForQty(q, pricing)
  }
  return out
}

// Quantity at which the per-card linear ramp meets the floor.
// surcharge(qty) = qty * rate when qty * rate >= min_charge, so the
// breakeven is min_charge / rate. Used in the "Minimum charge applies
// below {N} cards" footnote on the customer page. Rounded up to the
// next whole card; below the breakeven the floor is biting.
export function personalisationBreakeven(pricing: PersonalisationPricing): number {
  if (pricing.per_card_rate <= 0) return 0
  return Math.ceil(pricing.min_charge / pricing.per_card_rate)
}
