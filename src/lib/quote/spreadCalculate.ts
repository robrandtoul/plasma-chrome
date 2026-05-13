import type { Currency } from '../types'
import type { PriceTier } from './calculate'
import { clampDiscountPercent, splitNameSurchargeFor } from './calculate'

// One row of the spread-quote results table. Either valid (all
// fields populated) or invalid (the typed quantity isn't a tier
// for the active variant, or the active finish option's surcharge
// schedule is missing the matching row). Invalid rows surface as
// inline warnings with manual-swap buttons rather than empty
// numeric cells.
export interface SpreadRow {
  quantity: number
  // Base tier total (no surcharges) at this quantity, in major
  // currency units. Null when isValidBase is false.
  baseTotal: number | null
  // Finish surcharge resolved at this quantity. Zero when no
  // finish surcharge schedule is active. Null when the finish
  // schedule exists but has no row at this quantity.
  finishSurcharge: number | null
  // Migration 000172. Personalisation surcharge at this quantity:
  // max(min_charge, qty * per_card_rate) when personalisation is
  // on, zero otherwise. Always defined (no neighbour resolution
  // needed since the formula is closed-form across every qty).
  personalisationSurcharge: number
  // Per-row pre-discount subtotal = baseTotal + finishSurcharge +
  // personalisation + splitNameSurcharge. Null mirrors total when
  // the base or finish tier is missing.
  subtotal: number | null
  // Absolute discount amount applied to this row in major currency
  // units (subtotal × discountPercent / 100). Zero when no discount
  // is set; null mirrors total when the row is invalid.
  discountAmount: number | null
  // Per-row final total = subtotal − discountAmount. Includes every
  // surcharge AND the internal discount, so the table cells and copy
  // output read as the final post-discount figure. Quantity-
  // independent items (split-name tooling) are folded in here too,
  // since the discount applies across the whole subtotal.
  total: number | null
  // total / quantity. Null when total is null.
  unitPrice: number | null
  isValidBase: boolean
  isValidFinish: boolean
  // Nearest base-tier neighbours, used by the manual-swap UI when
  // isValidBase is false. Either side may be null at the edges of
  // the variant's tier range.
  baseLower: number | null
  baseUpper: number | null
  // Nearest finish-surcharge neighbours, used by the manual-swap
  // UI when the base tier exists but the finish schedule has no
  // matching row. Today the seeded data keeps base + finish tier
  // sets aligned, so this rarely fires — defensive only.
  finishLower: number | null
  finishUpper: number | null
}

export interface SpreadResult {
  rows: SpreadRow[]
  // Whether ALL rows validated cleanly. Drives whether the copy
  // button enables and whether the savings column has data to
  // populate. Mixed validity (some valid, some invalid) still
  // shows the table — invalid rows just don't contribute.
  allValid: boolean
  // Whether at least one row validated cleanly. False = nothing
  // useful to render in the table.
  anyValid: boolean
}

const EMPTY: SpreadResult = { rows: [], allValid: false, anyValid: false }

// Quantity-independent additions, computed once per spread
// quote. Today this is just the split-name tooling surcharge,
// but the shape leaves room for future flat add-ons without
// the table layout changing.
export interface QuantityIndependentItems {
  splitName: number
  // Raw inputs surfaced for caller-side narration ("(names - 1) ×
  // £39"). Caller decides whether to render the breakdown.
  names: number
  perExtraNameSurcharge: number | null
}

export function quantityIndependentItems(
  names: number,
  perExtraNameSurcharge: number | null,
): QuantityIndependentItems {
  return {
    splitName: splitNameSurchargeFor(names, perExtraNameSurcharge),
    names,
    perExtraNameSurcharge,
  }
}

// Resolve a list of typed quantities against the variant's tier
// set + the active finish option's surcharge schedule. Pure — no
// React, no Supabase. Sorts results ascending by quantity (the
// brief's "regardless of input order" rule), but de-duplicates
// nothing: if the designer types 100, 100, 250 we render two
// "100" rows so they can see what they typed and decide.
//
// `splitNameSurcharge` is the per-order constant that applies
// regardless of quantity, e.g. (names - 1) × per-extra-name
// surcharge. It gets baked into every row's total here so the
// table reads as the all-in price and the savings-vs-previous
// percentages reflect what the customer actually pays per card.
// Caller passes 0 (or omits) when no split-name surcharge
// applies.
export function spreadCalculate(
  quantities: readonly number[],
  variantTiers: readonly PriceTier[],
  finishSurchargesByQty: Record<number, number> | null,
  currency: Currency | null,
  splitNameSurcharge: number = 0,
  // Migration 000172. Per-qty resolver for the personalisation
  // surcharge. Returns 0 when personalisation is off (the default
  // identity), or `max(min_charge, qty * per_card_rate)` when on.
  // Closed-form, so no validation / neighbour columns — every qty
  // has a well-defined value.
  personalisationAt: (qty: number) => number = () => 0,
  // Internal discount percentage (0–100). Applied to every row's
  // subtotal so the table cells render the post-discount figure
  // the customer will see. Zero (the default) leaves the maths
  // identical to its pre-discount behaviour.
  discountPercent: number = 0,
): SpreadResult {
  if (!currency || quantities.length === 0) return EMPTY
  const safeDiscount = clampDiscountPercent(discountPercent)

  const sortedTiers = [...variantTiers].sort((a, b) => a.quantity - b.quantity)
  const tierByQty = new Map<number, PriceTier>()
  for (const t of sortedTiers) tierByQty.set(t.quantity, t)

  // Finish-surcharge tier set. Empty Map iff the active option
  // has no surcharge schedule (base option, or a non-surcharging
  // dimension like wood species). In that case every row's
  // finishSurcharge defaults to 0 and isValidFinish stays true.
  const finishHasSchedule =
    finishSurchargesByQty != null && Object.keys(finishSurchargesByQty).length > 0
  const finishQtys = finishHasSchedule
    ? Object.keys(finishSurchargesByQty!).map(Number).sort((a, b) => a - b)
    : []

  const rows: SpreadRow[] = quantities.map((q) => {
    const tier = tierByQty.get(q)
    const isValidBase = tier !== undefined

    // Base-tier neighbour resolution. Used by the manual-swap UI
    // when the typed quantity isn't a base tier.
    let baseLower: number | null = null
    let baseUpper: number | null = null
    for (const t of sortedTiers) {
      if (t.quantity < q) baseLower = t.quantity
      else if (t.quantity > q) { baseUpper = t.quantity; break }
    }

    // Finish-surcharge neighbour resolution. Only meaningful when
    // a schedule exists at all; without one, the row's finish is
    // a no-op zero and there's nothing to swap to.
    let finishLower: number | null = null
    let finishUpper: number | null = null
    let finishSurcharge: number | null = 0
    let isValidFinish = true
    if (finishHasSchedule) {
      const direct = finishSurchargesByQty![q]
      if (direct !== undefined) {
        finishSurcharge = direct
      } else {
        finishSurcharge = null
        isValidFinish = false
        for (const fq of finishQtys) {
          if (fq < q) finishLower = fq
          else if (fq > q) { finishUpper = fq; break }
        }
      }
    }

    const baseTotal = isValidBase ? tier!.totalPrice : null
    const personalisationSurcharge = personalisationAt(q)
    const subtotal =
      baseTotal != null && finishSurcharge != null
        ? baseTotal + finishSurcharge + splitNameSurcharge + personalisationSurcharge
        : null
    const discountAmount = subtotal != null ? subtotal * (safeDiscount / 100) : null
    const total = subtotal != null && discountAmount != null ? subtotal - discountAmount : null
    const unitPrice = total != null && q > 0 ? total / q : null

    return {
      quantity: q,
      baseTotal,
      finishSurcharge,
      personalisationSurcharge,
      subtotal,
      discountAmount,
      total,
      unitPrice,
      isValidBase,
      isValidFinish,
      baseLower,
      baseUpper,
      finishLower,
      finishUpper,
    }
  })

  rows.sort((a, b) => a.quantity - b.quantity)

  let allValid = true
  let anyValid = false
  for (const r of rows) {
    const ok = r.isValidBase && r.isValidFinish
    if (ok) anyValid = true
    else allValid = false
  }

  return { rows, allValid, anyValid }
}

// Percentage drop in unit price between consecutive valid rows.
// First row (or first valid row) returns null — caller renders
// "-" placeholder. Negative result means unit price went UP at
// the higher quantity (rare, but possible if a tier's headline
// price isn't strictly decreasing per card). Returned as a
// fraction, e.g. 0.12 means 12% saving; caller formats.
export function unitPriceSavingFraction(
  prevUnit: number | null,
  thisUnit: number | null,
): number | null {
  if (prevUnit == null || thisUnit == null || prevUnit <= 0) return null
  return (prevUnit - thisUnit) / prevUnit
}
