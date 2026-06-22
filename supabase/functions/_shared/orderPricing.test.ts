// Unit tests for orderPricing.ts (server-authoritative order pricing).
// Run with: npx tsx supabase/functions/_shared/orderPricing.test.ts
//
// The interpolation cases mirror src/lib/quote/interpolation.test.ts so
// the server charge can't drift from the Quote-compiler quote.

import {
  cardTotalForQuantity,
  computeOrderTotal,
  interpolateValue,
  resolveUsTariff,
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
