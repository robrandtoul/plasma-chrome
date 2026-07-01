// Unit tests for orderPricing.ts (server-authoritative order pricing).
// Run with: npx tsx supabase/functions/_shared/orderPricing.test.ts
//
// The interpolation cases mirror src/lib/quote/interpolation.test.ts so
// the server charge can't drift from the Quote-compiler quote.

import {
  cardTotalForQuantity,
  computeOrderTotal,
  interpolateValue,
  resolveCardDiscount,
  resolveUsTariff,
  flatTopTierTotal,
  flatUnitTotal,
  pricesFlatAboveTopTier,
  type Tier,
  type PricingConfig,
} from './orderPricing.ts'

let passed = 0
let failed = 0

function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (err) {
    console.log(`  ✗ ${name}`)
    console.log(`    ${(err as Error).message}`)
    failed++
  }
}

function assertEqual(actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`expected ${e}, got ${a}`)
}

const NO_WEIGHT: PricingConfig = { upwardWeighting: 0, roundUpToIncrement: 0 }
const W5_R1: PricingConfig = { upwardWeighting: 0.05, roundUpToIncrement: 1 }

const TIERS: Tier[] = [
  { quantity: 50, total_price: 100 },
  { quantity: 75, total_price: 127.5 },
]

// ── interpolateValue parity with the frontend engine ────────────────

test('interpolateValue: midpoint, no weighting/rounding', () => {
  assertEqual(interpolateValue(50, 100, 75, 127.5, 60, NO_WEIGHT), 111)
})

test('interpolateValue: weights the increment then rounds up to £1', () => {
  // increment 11 × 1.05 = 11.55 → 100 + 11.55 = 111.55 → round up → 112
  assertEqual(interpolateValue(50, 100, 75, 127.5, 60, W5_R1), 112)
})

test('interpolateValue: clamps to the upper tier near the top', () => {
  assertEqual(interpolateValue(50, 100, 75, 127.5, 74, W5_R1), 127.5)
})

// ── cardTotalForQuantity ────────────────────────────────────────────

test('cardTotalForQuantity: exact tier returns its price', () => {
  assertEqual(cardTotalForQuantity(TIERS, 50, W5_R1), 100)
})

test('cardTotalForQuantity: in-between interpolates', () => {
  assertEqual(cardTotalForQuantity(TIERS, 60, NO_WEIGHT), 111)
})

test('cardTotalForQuantity: below lowest tier is null (no price)', () => {
  assertEqual(cardTotalForQuantity(TIERS, 25, W5_R1), null)
})

test('cardTotalForQuantity: above highest tier is null (no price)', () => {
  assertEqual(cardTotalForQuantity(TIERS, 200, W5_R1), null)
})

// ── flat-above-top (metal) ──────────────────────────────────────────

test('flatUnitTotal: holds the per-unit rate flat, rounded to the penny', () => {
  // 2299 / 1000 = 2.299 per card × 1500 = 3448.5 (World Youth Bank example)
  assertEqual(flatUnitTotal(1000, 2299, 1500), 3448.5)
})

test('pricesFlatAboveTopTier: true for metal + carbon fibre, false otherwise', () => {
  assertEqual(pricesFlatAboveTopTier('metal_gold'), true)
  assertEqual(pricesFlatAboveTopTier('metal_steel'), true)
  assertEqual(pricesFlatAboveTopTier('carbon_fibre'), true)
  assertEqual(pricesFlatAboveTopTier('carbon_fibre_cnc'), true)
  assertEqual(pricesFlatAboveTopTier('plastic_satin'), false)
  assertEqual(pricesFlatAboveTopTier('paper_standard'), false)
  assertEqual(pricesFlatAboveTopTier('acrylic'), false)
  assertEqual(pricesFlatAboveTopTier(null), false)
  assertEqual(pricesFlatAboveTopTier(undefined), false)
})

test('flatTopTierTotal: above the top tier uses the top per-card rate', () => {
  // top tier 75 @ 127.5 → 1.7 per card × 100 = 170
  assertEqual(flatTopTierTotal(TIERS, 100), 170)
})

test('flatTopTierTotal: at/below the top tier returns null (not its job)', () => {
  assertEqual(flatTopTierTotal(TIERS, 75), null)
  assertEqual(flatTopTierTotal(TIERS, 25), null)
})

test('cardTotalForQuantity: flatAboveTop prices above the top tier flat', () => {
  assertEqual(cardTotalForQuantity(TIERS, 100, W5_R1, { flatAboveTop: true }), 170)
})

test('cardTotalForQuantity: flatAboveTop still null below the minimum', () => {
  assertEqual(cardTotalForQuantity(TIERS, 25, W5_R1, { flatAboveTop: true }), null)
})

test('cardTotalForQuantity: flatAboveTop leaves in-range interpolation untouched', () => {
  assertEqual(cardTotalForQuantity(TIERS, 60, NO_WEIGHT, { flatAboveTop: true }), 111)
})

test('computeOrderTotal: flatAboveTop lets a metal order price above the top tier', () => {
  const tiers: Tier[] = [{ quantity: 1000, total_price: 2299 }]
  const r = computeOrderTotal({
    tiers,
    quantity: 1500,
    perExtraNameSurcharge: null,
    namesCount: 1,
    personalisation: null,
    flatAboveTop: true,
    shipping: 0,
  })
  if (!r.ok) throw new Error('expected ok')
  assertEqual(r.cards, 3448.5)
  assertEqual(r.total, 3448.5)
})

test('computeOrderTotal: without flatAboveTop, above the top tier is unpriceable', () => {
  const tiers: Tier[] = [{ quantity: 1000, total_price: 2299 }]
  const r = computeOrderTotal({
    tiers,
    quantity: 1500,
    perExtraNameSurcharge: null,
    namesCount: 1,
    personalisation: null,
    shipping: 0,
  })
  assertEqual(r.ok, false)
})

// ── computeOrderTotal ───────────────────────────────────────────────

test('computeOrderTotal: exact tier + split-name + free shipping', () => {
  // 100 cards @ tier 100, 2 recipients × £39 split-name, free shipping
  const tiers: Tier[] = [{ quantity: 100, total_price: 500 }]
  const r = computeOrderTotal({
    tiers,
    quantity: 100,
    perExtraNameSurcharge: 39,
    namesCount: 2,
    personalisation: null,
    shipping: 0,
  })
  if (!r.ok) throw new Error('expected ok')
  assertEqual(r.cards, 500)
  assertEqual(r.splitName, 39)
  assertEqual(r.personalisation, 0)
  assertEqual(r.total, 539)
})

test('computeOrderTotal: personalisation uses the min-charge floor', () => {
  const tiers: Tier[] = [{ quantity: 100, total_price: 500 }]
  // 100 × £0.20 = £20, below the £50 minimum → £50
  const r = computeOrderTotal({
    tiers,
    quantity: 100,
    perExtraNameSurcharge: null,
    namesCount: 1,
    personalisation: { perCardRate: 0.2, minCharge: 50 },
    shipping: 0,
  })
  if (!r.ok) throw new Error('expected ok')
  assertEqual(r.personalisation, 50)
  assertEqual(r.total, 550)
})

test('computeOrderTotal: manual shipping is added on top', () => {
  const tiers: Tier[] = [{ quantity: 100, total_price: 500 }]
  const r = computeOrderTotal({
    tiers,
    quantity: 100,
    perExtraNameSurcharge: null,
    namesCount: 1,
    personalisation: null,
    shipping: 12.9,
  })
  if (!r.ok) throw new Error('expected ok')
  assertEqual(r.total, 512.9)
})

test('computeOrderTotal: quantity out of range cannot be priced', () => {
  const r = computeOrderTotal({
    tiers: TIERS,
    quantity: 5000,
    perExtraNameSurcharge: null,
    namesCount: 1,
    personalisation: null,
    shipping: 0,
  })
  assertEqual(r.ok, false)
})

// ── resolveCardDiscount ─────────────────────────────────────────────

test('resolveCardDiscount: percent off the cards', () => {
  // 10% off £500 cards → £50
  assertEqual(resolveCardDiscount('percent', 10, 500), 50)
})

test('resolveCardDiscount: percent over 100 is capped to the cards figure', () => {
  assertEqual(resolveCardDiscount('percent', 150, 500), 500)
})

test('resolveCardDiscount: fixed amount off the cards', () => {
  assertEqual(resolveCardDiscount('fixed', 100, 500), 100)
})

test('resolveCardDiscount: fixed amount over the cards is capped (never negative)', () => {
  assertEqual(resolveCardDiscount('fixed', 600, 500), 500)
})

test('resolveCardDiscount: none / zero / missing value → 0', () => {
  assertEqual(resolveCardDiscount('none', 10, 500), 0)
  assertEqual(resolveCardDiscount('percent', 0, 500), 0)
  assertEqual(resolveCardDiscount('fixed', null, 500), 0)
})

test('resolveCardDiscount: percent rounds to the penny', () => {
  // 12.5% off £99.99 = 12.49875 → 12.50
  assertEqual(resolveCardDiscount('percent', 12.5, 99.99), 12.5)
})

test('computeOrderTotal goods uses full cards; discount is applied by the caller', () => {
  // The cards-only discount is resolved + applied at checkout against the
  // folded amount_cards, not inside computeOrderTotal — so goods stays full
  // here and the caller subtracts resolveCardDiscount() from the charged total.
  const tiers: Tier[] = [{ quantity: 100, total_price: 500 }]
  const r = computeOrderTotal({
    tiers, quantity: 100, perExtraNameSurcharge: 39, namesCount: 2, personalisation: null, shipping: 0,
  })
  if (!r.ok) throw new Error('expected ok')
  const discount = resolveCardDiscount('percent', 10, r.cards) // 10% of 500 = 50
  assertEqual(discount, 50)
  assertEqual(Math.round((r.total - discount) * 100) / 100, 489) // 539 − 50
})

// ── resolveUsTariff ─────────────────────────────────────────────────

test('resolveUsTariff: US destination, not opted out → the fee', () => {
  assertEqual(resolveUsTariff('US', 39, false), 39)
})

test('resolveUsTariff: case/whitespace-insensitive on the country', () => {
  assertEqual(resolveUsTariff(' us ', 39, false), 39)
})

test('resolveUsTariff: opted out → 0 even for a US order', () => {
  assertEqual(resolveUsTariff('US', 39, true), 0)
})

test('resolveUsTariff: non-US destination → 0', () => {
  assertEqual(resolveUsTariff('GB', 39, false), 0)
})

test('resolveUsTariff: null/zero/negative fee → 0 (disables the service)', () => {
  assertEqual(resolveUsTariff('US', null, false), 0)
  assertEqual(resolveUsTariff('US', 0, false), 0)
  assertEqual(resolveUsTariff('US', -5, false), 0)
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
