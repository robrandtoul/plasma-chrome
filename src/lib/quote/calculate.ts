import type { Currency } from '../types'

// One row from price_tiers, normalised into the shape calculate
// needs. The hook in src/lib/quote/usePricing.ts is responsible
// for filtering to (material, currency) and bucketing by variant
// before handing tiers down to this function.
export interface PriceTier {
  variantId: string
  quantity: number
  totalPrice: number
}

export interface QuoteSelection {
  variantId: string | null
  quantity: number | null
  currency: Currency | null
  // Number of unique recipient names (split-name tooling). 1 means
  // "every card has the same details" — no surcharge applies. n > 1
  // bills (n - 1) × perExtraNameSurcharge on top of the base price.
  names: number
  // Currency-resolved per-extra-name surcharge from
  // materials.split_name_surcharge_{gbp,eur,usd}. Null when the
  // material has no surcharge configured for the active currency
  // (today: wood species). Acrylic, carbon fibre, and standard
  // paper joined the surcharging set in migration 000146 — extra
  // names on those materials now bill the configured rate.
  perExtraNameSurcharge: number | null
  // Finish (or other material_option) surcharge resolved at the
  // chosen quantity, in major currency units. Zero for the base
  // option (Steel/Gold's Natural) or any material with no option
  // surcharge schedule. Non-zero for Steel/Gold Brushed/Mirror.
  // The page resolves this from PricingData.surchargesByOptionId
  // before calling calculate, since the surcharge varies per
  // quantity and we already have the qty in scope.
  finishSurcharge: number
  // Migration 000172. Personalisation surcharge at the chosen
  // quantity in major currency units. Zero when personalisation
  // is off or the material doesn't support it. The page resolves
  // this with `max(min_charge, qty * per_card_rate)` before calling
  // calculate — same pattern as finishSurcharge.
  personalisationSurcharge: number
}

// Two tier hints surfaced when the typed quantity doesn't match a
// row. Either or both can be null at the edges of the tier range
// (typing a value below the smallest tier => only an upper hint;
// typing above the largest tier => only a lower hint).
export interface SnapHint {
  quantity: number
  totalPrice: number
}

export interface QuoteResult {
  // Inclusive total at the requested quantity — base price plus
  // any finish + split-name tooling surcharge. Null when no tier
  // matches; QuantityInput surfaces the snap suggestions in that
  // case rather than guessing a number.
  total: number | null
  // Base tier price before any surcharge, kept around so the
  // breakdown lines can render "£X base + N × £Y" without the
  // headline-price component having to subtract.
  baseTotal: number | null
  // Total surcharge applied for split-name tooling: (names - 1)
  // × perExtraNameSurcharge, capped at zero when names <= 1 or
  // the material has no surcharge configured. Null mirrors total
  // when no tier matches.
  splitNameSurcharge: number | null
  // Finish surcharge applied for the active option at the active
  // quantity, in major currency units. Zero for the base option
  // and for any material with no option surcharge schedule. Null
  // mirrors total when no tier matches.
  finishSurcharge: number | null
  // Migration 000172. Personalisation surcharge applied at the
  // active quantity. Zero when personalisation is off; non-zero
  // when on (always >= min_charge by the floor rule). Null mirrors
  // total when no tier matches.
  personalisationSurcharge: number | null
  // Inclusive unit price (total / quantity). Reflects what the
  // customer actually pays per card, including any split-name
  // surcharge spread across the run.
  unitPrice: number | null
  // True iff the selection's quantity is in the variant's tier
  // set for the active currency. Useful for the headline-price
  // component to decide between "show the price" vs "show the
  // 'pick a valid quantity' placeholder".
  validTier: boolean
  // Currency carried through so the price components don't have
  // to re-thread it.
  currency: Currency | null
  // Snap-to suggestions: at most one below, one above the typed
  // quantity. Empty array when the quantity is already valid (no
  // hint needed) or when the variant has no tier data yet.
  snap: { lower: SnapHint | null; upper: SnapHint | null }
}

const EMPTY_SNAP: QuoteResult['snap'] = { lower: null, upper: null }

// Resolve the split-name surcharge for a given names count.
// Centralised so calculate() and the comparison strips share the
// same formula — surcharge is constant across qty + variant, so
// every cell just adds the same number.
export function splitNameSurchargeFor(
  names: number,
  perExtraNameSurcharge: number | null,
): number {
  if (!perExtraNameSurcharge || names <= 1) return 0
  return (names - 1) * perExtraNameSurcharge
}

// Pure pricing math. No React, no Supabase, no side effects. Takes
// a selection plus the tier rows for the *chosen variant only* (in
// the active currency) and returns the resolved total + snap
// suggestions when the quantity falls between tiers.
//
// Tiers do not need to be pre-sorted; the function copies into a
// local array and sorts ascending by quantity.
export function calculate(
  selection: QuoteSelection,
  variantTiers: readonly PriceTier[],
): QuoteResult {
  const { quantity, currency, names, perExtraNameSurcharge } = selection

  if (variantTiers.length === 0 || quantity == null || !currency) {
    return {
      total: null,
      baseTotal: null,
      splitNameSurcharge: null,
      finishSurcharge: null,
      personalisationSurcharge: null,
      unitPrice: null,
      validTier: false,
      currency,
      snap: EMPTY_SNAP,
    }
  }

  const sorted = [...variantTiers].sort((a, b) => a.quantity - b.quantity)
  const exact = sorted.find((t) => t.quantity === quantity)
  if (exact) {
    const splitName = splitNameSurchargeFor(names, perExtraNameSurcharge)
    const finishSurcharge = selection.finishSurcharge
    const personalisationSurcharge = selection.personalisationSurcharge
    const total = exact.totalPrice + splitName + finishSurcharge + personalisationSurcharge
    return {
      total,
      baseTotal: exact.totalPrice,
      splitNameSurcharge: splitName,
      finishSurcharge,
      personalisationSurcharge,
      unitPrice: total / quantity,
      validTier: true,
      currency,
      snap: EMPTY_SNAP,
    }
  }

  // Snap hints — find the nearest tier on each side. Either side
  // may be null when the typed value is past the end of the tier
  // range.
  let lower: SnapHint | null = null
  let upper: SnapHint | null = null
  for (const t of sorted) {
    if (t.quantity < quantity) {
      lower = { quantity: t.quantity, totalPrice: t.totalPrice }
    } else if (t.quantity > quantity) {
      upper = { quantity: t.quantity, totalPrice: t.totalPrice }
      break
    }
  }
  return {
    total: null,
    baseTotal: null,
    splitNameSurcharge: null,
    finishSurcharge: null,
    personalisationSurcharge: null,
    unitPrice: null,
    validTier: false,
    currency,
    snap: { lower, upper },
  }
}

// Helper: nearest valid tier strictly above or below a given
// quantity. Used by QuantityInput's arrow-key stepping. Returns
// null at the ends of the range. When `from` is null, returns the
// smallest (direction='up') / largest (direction='down') tier — so
// arrow-up from an empty input lands on the lowest tier.
export function stepTier(
  variantTiers: readonly PriceTier[],
  from: number | null,
  direction: 'up' | 'down',
): number | null {
  if (variantTiers.length === 0) return null
  const sorted = [...variantTiers].sort((a, b) => a.quantity - b.quantity)
  if (from == null) {
    return direction === 'up' ? sorted[0].quantity : sorted[sorted.length - 1].quantity
  }
  if (direction === 'up') {
    const next = sorted.find((t) => t.quantity > from)
    return next?.quantity ?? null
  } else {
    const prev = [...sorted].reverse().find((t) => t.quantity < from)
    return prev?.quantity ?? null
  }
}
