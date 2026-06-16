// Unit tests for calculate.ts (price resolution + interpolation)
// Run with: npx tsx src/lib/quote/calculate.test.ts

import { calculate, type PriceTier, type QuoteSelection } from './calculate'
import type { InterpolationConfig } from './interpolation'

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

// Two tiers: 50 @ £100, 75 @ £127.50.
const TIERS: PriceTier[] = [
  { variantId: 'v1', quantity: 50, totalPrice: 100 },
  { variantId: 'v1', quantity: 75, totalPrice: 127.5 },
]

// Deterministic configs so tests don't track the provisional defaults.
const NO_WEIGHT: InterpolationConfig = { upwardWeighting: 0, roundUpToIncrement: 0 }
const W5_R1: InterpolationConfig = { upwardWeighting: 0.05, roundUpToIncrement: 1 }

function sel(overrides: Partial<QuoteSelection>): QuoteSelection {
  return {
    variantId: 'v1',
    quantity: null,
    currency: 'GBP',
    names: 1,
    perExtraNameSurcharge: null,
    finishSurcharge: 0,
    personalisationSurcharge: 0,
    discountPercent: 0,
    ...overrides,
  }
}

// ── Exact tier: behaviour unchanged ─────────────────────────────────

test('exact tier resolves to the listed price, not interpolated', () => {
  const r = calculate(sel({ quantity: 50 }), TIERS)
  assertEqual(r.total, 100)
  assertEqual(r.baseTotal, 100)
  assertEqual(r.validTier, true)
  assertEqual(r.interpolated, false)
})

// ── Mid-band interpolation ──────────────────────────────────────────

test('in-between quantity interpolates (no weighting/rounding)', () => {
  const r = calculate(sel({ quantity: 60 }), TIERS, NO_WEIGHT)
  assertEqual(r.baseTotal, 111)
  assertEqual(r.total, 111)
  assertEqual(r.validTier, false)
  assertEqual(r.interpolated, true)
  assertEqual(r.snap.lower?.quantity, 50)
  assertEqual(r.snap.upper?.quantity, 75)
})

test('in-between quantity weights the increment then rounds up', () => {
  const r = calculate(sel({ quantity: 60 }), TIERS, W5_R1)
  // increment 11 × 1.05 = 11.55 → 100 + 11.55 = 111.55 → round up → 112
  assertEqual(r.baseTotal, 112)
  assertEqual(r.total, 112)
  assertEqual(r.interpolated, true)
})

test('interpolation clamps to the upper tier near the top of the band', () => {
  const r = calculate(sel({ quantity: 74 }), TIERS, W5_R1)
  assertEqual(r.baseTotal, 127.5)
  assertEqual(r.interpolated, true)
})

// ── Ends: no extrapolation ──────────────────────────────────────────

test('below the lowest tier returns no price (snap up only)', () => {
  const r = calculate(sel({ quantity: 25 }), TIERS)
  assertEqual(r.total, null)
  assertEqual(r.interpolated, false)
  assertEqual(r.validTier, false)
  assertEqual(r.snap.lower, null)
  assertEqual(r.snap.upper?.quantity, 50)
})

test('above the highest tier returns no price (snap down only)', () => {
  const r = calculate(sel({ quantity: 200 }), TIERS)
  assertEqual(r.total, null)
  assertEqual(r.interpolated, false)
  assertEqual(r.snap.lower?.quantity, 75)
  assertEqual(r.snap.upper, null)
})

// ── Surcharges + discount ride interpolation ────────────────────────

test('interpolation adds split-name + finish surcharges to the base', () => {
  const r = calculate(
    sel({ quantity: 60, names: 2, perExtraNameSurcharge: 39, finishSurcharge: 10 }),
    TIERS,
    NO_WEIGHT,
  )
  // base 111 + (2-1)×39 split-name + 10 finish = 160
  assertEqual(r.baseTotal, 111)
  assertEqual(r.splitNameSurcharge, 39)
  assertEqual(r.finishSurcharge, 10)
  assertEqual(r.total, 160)
})

test('interpolation applies the internal discount last', () => {
  const r = calculate(sel({ quantity: 60, discountPercent: 10 }), TIERS, NO_WEIGHT)
  const subtotal = 111
  const discountAmount = subtotal * (10 / 100)
  const total = subtotal - discountAmount
  assertEqual(r.subtotal, subtotal)
  assertEqual(r.discountAmount, discountAmount)
  assertEqual(r.total, total)
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
