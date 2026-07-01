// Price interpolation for non-standard (in-between) quantities.
//
// Part of the Ordering & checkout feature — see
// docs/ordering-checkout-spec.md, "Non-standard quantities (price
// interpolation)". The price-tier grid only lists discrete quantities
// (e.g. 50, 75); customers routinely want a quantity in between (60).
// Historically staff did this by hand: take the two listed prices
// either side and weight slightly upward. This module makes that
// deterministic and shared, so the figure a designer quotes on the
// Quote compiler is the same figure the customer pays at checkout.
//
// SCOPE: designer-only / ordering surfaces only (the Quote compiler
// and, later, the customer pay-page). The proof page and the
// marketing price-list keep snapping to listed tiers — they advertise
// published prices and must never show an interpolated figure.

// ── Provisional configuration ───────────────────────────────────────
// These knobs are Rob's commercial calls and are NOT yet finalised.
// They ship as PLACEHOLDERS with conservative defaults and are
// destined to become admin-editable (see the spec's "Decisions to
// lock before autonomous build"). Do NOT treat these as signed-off
// business values — calibrate them on the Quote compiler before any
// customer sees an interpolated price.
export interface InterpolationConfig {
  // Extra fraction added to the INCREMENT above the lower tier (not the
  // whole price) — the "weight slightly upward" instinct, applied so it
  // can't create a step at a tier boundary. 0.05 = +5%. PROVISIONAL.
  upwardWeighting: number
  // Round the interpolated total UP to the nearest multiple of this,
  // in major currency units. 1 = nearest whole £/$/€. PROVISIONAL.
  roundUpToIncrement: number
}

export const DEFAULT_INTERPOLATION_CONFIG: InterpolationConfig = {
  // PROVISIONAL — calibrate on the Quote compiler, then move to admin config.
  upwardWeighting: 0.05,
  roundUpToIncrement: 1,
}

// Minimum order quantity. PROVISIONAL, and intentionally NOT enforced
// in the pricing maths here — interpolation never extrapolates below
// the lowest listed tier regardless (interpolateValue is only ever
// called for a quantity strictly inside the tier range). MOQ
// enforcement — blocking an order placed below it — belongs to the
// order / pay-page flow, a later build step. Kept here so there's a
// single home for it when that lands. null = "use the variant's
// lowest listed tier".
export const PROVISIONAL_MIN_ORDER_QUANTITY: number | null = null

// Round a value UP to the nearest `increment` (major currency units).
// increment <= 0 is treated as "no rounding" so a misconfigured
// increment can never divide-by-zero or strip the price to nothing.
export function roundUpTo(value: number, increment: number): number {
  if (increment <= 0) return value
  return Math.ceil(value / increment) * increment
}

// ── Flat pricing above the top listed tier (metal only) ─────────────
// Metal card prices stop dropping at the top listed quantity (1000):
// there's no further volume discount past it. So above the top tier we
// hold that tier's per-card rate flat — the price for 1500 is simply the
// 1000 per-card rate × 1500. This is a deliberate metal-only rule; every
// other material keeps returning "no price" above its top tier (its price
// is still curving down there, so extrapolating would mis-charge).
//
// Mirrored verbatim in supabase/functions/_shared/orderPricing.ts (Vite
// and Deno can't share a module) so the pay-page figure equals the server
// charge. If you change one, change both.

// Customer-facing sanity cap: a designer can lock any quantity, but a
// customer typing their own number on the pay page is bounded so a
// fat-finger 50,000 can't auto-price. Above this the pay page shows the
// "reply to us" hint and the server refuses a customer-chosen quantity.
// PROVISIONAL — Rob's commercial call.
export const MAX_ONLINE_FLAT_QUANTITY = 5000

// Flat total at a fixed per-unit rate: (topValue / topQuantity) × quantity,
// rounded to the penny. Used for both the base cards and the (per-card,
// flat) metal finish surcharge above the top tier.
export function flatUnitTotal(topQuantity: number, topValue: number, quantity: number): number {
  if (topQuantity <= 0) return 0
  return Math.round((topValue / topQuantity) * quantity * 100) / 100
}

// Flat card total above the top listed tier: the top tier's per-card rate
// held flat. Returns null when there are no tiers, or when the quantity is
// at/below the top tier (in-range quantities are the interpolator's job,
// and below-minimum stays unpriceable).
export function flatTopTierTotal(
  tiers: readonly { quantity: number; total_price: number }[],
  quantity: number,
): number | null {
  if (tiers.length === 0) return null
  let top = tiers[0]
  for (const t of tiers) if (t.quantity > top.quantity) top = t
  if (quantity <= top.quantity) return null
  return flatUnitTotal(top.quantity, top.total_price, quantity)
}

// Interpolate a value for `q` strictly between two anchor points
// (qLow, vLow) and (qHigh, vHigh): straight-line interpolation, with the
// upward weighting applied to the increment above vLow, rounded up, then
// clamped into [vLow, vHigh]. The
// guardrails guarantee:
//   - never below vLow (a bigger quantity never costs less),
//   - never above vHigh (so ordering more is never cheaper — the trap
//     a naive marginal-rate method falls into near the top of a band),
//   - clamp is applied AFTER rounding so a round-up near the top can't
//     push the figure past the upper tier's real price.
// Returns vLow when qHigh <= qLow (degenerate) so it can't blow up.
export function interpolateValue(
  qLow: number,
  vLow: number,
  qHigh: number,
  vHigh: number,
  q: number,
  config: InterpolationConfig = DEFAULT_INTERPOLATION_CONFIG,
): number {
  if (qHigh <= qLow) return vLow
  const linear = vLow + ((vHigh - vLow) * (q - qLow)) / (qHigh - qLow)
  // Weight only the INCREMENT above the lower tier, not the whole price.
  // This keeps the curve continuous at a tier boundary — one card past a
  // listed quantity rises by pennies, not by the full weighting applied to
  // the base price (which used to make e.g. 76 jump £10 above the 75 price).
  const weighted = vLow + (linear - vLow) * (1 + config.upwardWeighting)
  const rounded = roundUpTo(weighted, config.roundUpToIncrement)
  return Math.min(Math.max(rounded, vLow), vHigh)
}

// Resolve a per-quantity surcharge schedule (e.g. the metal
// Brushed/Mirror finish grid) at an arbitrary quantity. Schedules are
// keyed by their own listed quantities, so an in-between quantity has
// no exact row — without this the surcharge would silently drop to
// zero while the base price interpolated (the "surcharge wrinkle" from
// the spec). Behaviour:
//   - exact key present → that value,
//   - strictly between two keys → straight-line interpolation, with NO
//     upward weighting and NO rounding (the weighting lives on the
//     headline base price; the surcharge is a precise additive part),
//   - below the lowest / above the highest key → the nearest end value
//     (a flat hold, never an extrapolation),
//   - empty / missing schedule → 0.
export function interpolateScheduleAt(
  schedule: Record<number, number> | null | undefined,
  q: number,
): number {
  if (!schedule) return 0
  const exact = schedule[q]
  if (exact != null) return exact
  const qtys = Object.keys(schedule)
    .map((k) => Number(k))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b)
  if (qtys.length === 0) return 0
  let lower: number | null = null
  let upper: number | null = null
  for (const k of qtys) {
    if (k < q) lower = k
    else if (k > q) { upper = k; break }
  }
  // Below the lowest key → hold the lowest; above the highest → hold
  // the highest. Neither extrapolates.
  if (lower == null) return schedule[upper as number]
  if (upper == null) return schedule[lower]
  const vLow = schedule[lower]
  const vHigh = schedule[upper]
  return vLow + ((vHigh - vLow) * (q - lower)) / (upper - lower)
}
