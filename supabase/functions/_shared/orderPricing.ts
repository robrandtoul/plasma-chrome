// Server-authoritative order pricing for the checkout (Ordering &
// checkout, Step 4 grid path). This is the SINGLE source of truth for
// what a grid-priced order is charged — the client never computes money;
// it hands the order id + token to create-checkout-session, which prices
// it here and builds the Stripe session.
//
// The interpolation logic is intentionally a faithful copy of
// src/lib/quote/interpolation.ts (the Quote-compiler engine) so the
// figure a designer was quoted matches what the customer is charged.
// Two copies because Vite (src/) and Deno (functions/) can't share a
// module cleanly; the test below mirrors the src interpolation tests to
// guard against drift. If you change one, change both.

export interface PricingConfig {
  upwardWeighting: number
  roundUpToIncrement: number
}

// PROVISIONAL — must match src/lib/quote/interpolation.ts
// DEFAULT_INTERPOLATION_CONFIG until both move to admin config.
export const DEFAULT_PRICING_CONFIG: PricingConfig = {
  upwardWeighting: 0.05,
  roundUpToIncrement: 1,
}

export function roundUpTo(value: number, increment: number): number {
  if (increment <= 0) return value
  return Math.ceil(value / increment) * increment
}

export function interpolateValue(
  qLow: number,
  vLow: number,
  qHigh: number,
  vHigh: number,
  q: number,
  config: PricingConfig = DEFAULT_PRICING_CONFIG,
): number {
  if (qHigh <= qLow) return vLow
  const linear = vLow + ((vHigh - vLow) * (q - qLow)) / (qHigh - qLow)
  // Weight only the INCREMENT above the lower tier, not the whole price, so
  // the curve is continuous at a tier boundary (one card past a listed
  // quantity rises by pennies, not by the full weighting on the base price).
  // Must match src/lib/quote/interpolation.ts.
  const weighted = vLow + (linear - vLow) * (1 + config.upwardWeighting)
  const rounded = roundUpTo(weighted, config.roundUpToIncrement)
  return Math.min(Math.max(rounded, vLow), vHigh)
}

export interface Tier {
  quantity: number
  total_price: number
}

// ── Flat pricing above the top listed tier ──────────────────────────
// Mirror of src/lib/quote/interpolation.ts (Vite and Deno can't share a
// module). Some materials have no volume discount past their top listed
// quantity (metal + carbon fibre at 1000), so above the top tier we hold
// that tier's per-card rate flat: 1500 = the 1000 per-card rate × 1500.
// Opt-in per material via pricesFlatAboveTopTier; every other material
// keeps returning null above its top tier. If you change one, change both.

// Which materials price flat above their top listed tier (metal all
// finishes + carbon fibre plain/CNC). Detected by material code. Mirror of
// interpolation.ts pricesFlatAboveTopTier — add a code in both places.
export function pricesFlatAboveTopTier(code: string | null | undefined): boolean {
  const c = code ?? ''
  return c.startsWith('metal_') || c === 'carbon_fibre' || c === 'carbon_fibre_cnc'
}

// Customer-facing sanity cap on a self-chosen quantity (a designer can
// lock any quantity; a customer typing their own number is bounded).
export const MAX_ONLINE_FLAT_QUANTITY = 5000

export function flatUnitTotal(topQuantity: number, topValue: number, quantity: number): number {
  if (topQuantity <= 0) return 0
  return Math.round((topValue / topQuantity) * quantity * 100) / 100
}

export function flatTopTierTotal(tiers: readonly Tier[], quantity: number): number | null {
  if (tiers.length === 0) return null
  let top = tiers[0]
  for (const t of tiers) if (t.quantity > top.quantity) top = t
  if (quantity <= top.quantity) return null
  return flatUnitTotal(top.quantity, top.total_price, quantity)
}

// Base card total for a quantity from a variant's tiers: exact tier, or
// interpolated between the two bracketing tiers. Returns null below the
// lowest tier or above the highest — the caller treats that as "can't
// price online". EXCEPTION: when opts.flatAboveTop is set (metal), a
// quantity above the top tier is priced flat at the top tier's per-card
// rate rather than returning null.
export function cardTotalForQuantity(
  tiers: readonly Tier[],
  quantity: number,
  config: PricingConfig = DEFAULT_PRICING_CONFIG,
  opts?: { flatAboveTop?: boolean },
): number | null {
  if (tiers.length === 0) return null
  const sorted = [...tiers].sort((a, b) => a.quantity - b.quantity)
  const exact = sorted.find((t) => t.quantity === quantity)
  if (exact) return exact.total_price
  let lower: Tier | null = null
  let upper: Tier | null = null
  for (const t of sorted) {
    if (t.quantity < quantity) lower = t
    else if (t.quantity > quantity) { upper = t; break }
  }
  if (lower && upper) {
    return interpolateValue(lower.quantity, lower.total_price, upper.quantity, upper.total_price, quantity, config)
  }
  if (opts?.flatAboveTop) return flatTopTierTotal(sorted, quantity)
  return null
}

export interface OrderPriceInputs {
  tiers: readonly Tier[]
  quantity: number
  // Per-extra-name split-name surcharge for the active currency (from
  // materials.split_name_surcharge_*). Null when the material has none.
  perExtraNameSurcharge: number | null
  namesCount: number
  // Personalisation rate + minimum for the active currency, when the
  // order has personalisation; null otherwise.
  personalisation: { perCardRate: number; minCharge: number } | null
  // Material-option surcharge already resolved for this quantity (e.g. metal
  // Brushed/Mirror finish, interpolated from material_option_surcharges the
  // same way base cards are). 0 / omitted for the base option or no finish.
  optionSurcharge?: number
  // Resolved shipping figure (free = 0, manual = the set amount). The
  // address-dependent treatments are rejected before we get here.
  shipping: number
  // Metal only: price a quantity above the top listed tier flat at the top
  // tier's per-card rate instead of returning no_card_price.
  flatAboveTop?: boolean
  config?: PricingConfig
}

export type OrderPriceResult =
  | {
      ok: true
      cards: number
      splitName: number
      personalisation: number
      finish: number
      shipping: number
      goods: number // cards + splitName + personalisation + finish
      total: number // goods + shipping
    }
  | { ok: false; reason: 'no_card_price' }

// Compose the authoritative order total. Mirrors the Quote compiler's
// calculate.ts composition: base (tier/interpolated) + split-name
// tooling + personalisation + finish surcharge, then shipping on top.
export function computeOrderTotal(inp: OrderPriceInputs): OrderPriceResult {
  const config = inp.config ?? DEFAULT_PRICING_CONFIG
  const cards = cardTotalForQuantity(inp.tiers, inp.quantity, config, { flatAboveTop: inp.flatAboveTop })
  if (cards == null) return { ok: false, reason: 'no_card_price' }

  const splitName =
    inp.perExtraNameSurcharge && inp.namesCount > 1
      ? (inp.namesCount - 1) * inp.perExtraNameSurcharge
      : 0
  const personalisation = inp.personalisation
    ? Math.max(inp.personalisation.minCharge, inp.quantity * inp.personalisation.perCardRate)
    : 0
  const finish = inp.optionSurcharge ?? 0
  const round2 = (n: number) => Math.round(n * 100) / 100
  const goods = round2(cards + splitName + personalisation + finish)
  const shipping = round2(inp.shipping)
  const total = round2(goods + shipping)
  return { ok: true, cards, splitName, personalisation, finish, shipping, goods, total }
}

// Designer-set per-order discount on the CARDS line only (mirrors the shipping
// subsidy pattern: a type + value stored on the order). Returns the discount
// amount in major units, capped so it can never exceed the cards figure (cards −
// discount >= 0) and never goes negative. 'none' / a missing or non-positive
// value / a zero cards base all yield 0. Pure so the checkout charge, the
// pay-page mirror, and the invoice line can't drift.
export function resolveCardDiscount(
  type: string | null | undefined,
  value: number | null | undefined,
  cardsAmount: number,
): number {
  if (type !== 'percent' && type !== 'fixed') return 0
  const v = Number(value)
  if (!Number.isFinite(v) || v <= 0) return 0
  const base = Number.isFinite(cardsAmount) && cardsAmount > 0 ? cardsAmount : 0
  if (base <= 0) return 0
  const raw = type === 'percent' ? base * (v / 100) : v
  const capped = Math.min(Math.max(raw, 0), base)
  return Math.round(capped * 100) / 100
}

// US tariff & customs handling — a flat per-order service added by default to
// US-bound orders (the US ended the $800 de-minimis import exemption on
// 2025-08-29). It rides ON TOP of goods + shipping as its own line (like
// shipping), NOT folded into the goods sum. The customer can opt out, after
// which they deal with US Customs directly and the charge is zero.
//
// destCountry is the resolved delivery country (customer-entered ?? the order's
// stored hint); feeForCurrency is settings.us_tariff_fee_<currency> for the
// order currency. A fee of 0 (or non-US, or opted out) yields 0 — the caller
// only emits a line when this is > 0, so a zero fee cleanly disables the
// service. Pure so the pay-page mirror and the server charge can't drift.
export function resolveUsTariff(
  destCountry: string | null | undefined,
  feeForCurrency: number | null | undefined,
  optedOut: boolean,
): number {
  if (optedOut) return 0
  if ((destCountry ?? '').trim().toUpperCase() !== 'US') return 0
  const fee = Number(feeForCurrency ?? 0)
  if (!Number.isFinite(fee) || fee <= 0) return 0
  return Math.round(fee * 100) / 100
}
