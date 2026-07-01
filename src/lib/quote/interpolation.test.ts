// Unit tests for interpolation.ts
// Run with: npx tsx src/lib/quote/interpolation.test.ts

import {
  roundUpTo,
  interpolateValue,
  interpolateScheduleAt,
  flatTopTierTotal,
  flatUnitTotal,
  pricesFlatAboveTopTier,
  type InterpolationConfig,
} from './interpolation'

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

const NO_WEIGHT: InterpolationConfig = { upwardWeighting: 0, roundUpToIncrement: 0 }
const W5_R1: InterpolationConfig = { upwardWeighting: 0.05, roundUpToIncrement: 1 }

// ── roundUpTo ───────────────────────────────────────────────────────

test('roundUpTo rounds up to the nearest £1', () => {
  assertEqual(roundUpTo(116.55, 1), 117)
})

test('roundUpTo rounds up to the nearest £5', () => {
  assertEqual(roundUpTo(116.55, 5), 120)
})

test('roundUpTo leaves an exact multiple untouched', () => {
  assertEqual(roundUpTo(120, 5), 120)
})

test('roundUpTo with increment 0 returns the value unchanged', () => {
  assertEqual(roundUpTo(116.55, 0), 116.55)
})

test('roundUpTo with a negative increment returns the value unchanged', () => {
  assertEqual(roundUpTo(116.55, -1), 116.55)
})

// ── interpolateValue ────────────────────────────────────────────────

test('interpolateValue: straight-line midpoint, no weighting/rounding', () => {
  // 50 @ £100, 75 @ £127.50, ask 60 → 100 + 27.5 × (10/25) = 111
  assertEqual(interpolateValue(50, 100, 75, 127.5, 60, NO_WEIGHT), 111)
})

test('interpolateValue: weights the increment then rounds up to £1', () => {
  // increment 11 × 1.05 = 11.55 → 100 + 11.55 = 111.55 → round up → 112
  assertEqual(interpolateValue(50, 100, 75, 127.5, 60, W5_R1), 112)
})

test('interpolateValue: clamps to the upper tier near the top of the band', () => {
  // 74: increment 26.4 × 1.05 = 27.72 → 100 + 27.72 = 127.72 → round up 128 → clamp to 127.5
  assertEqual(interpolateValue(50, 100, 75, 127.5, 74, W5_R1), 127.5)
})

test('interpolateValue: never below the lower tier', () => {
  // Just above the lower anchor, weighting can only push up, never below 100
  const v = interpolateValue(50, 100, 75, 127.5, 51, W5_R1)
  if (v < 100) throw new Error(`expected >= 100, got ${v}`)
})

test('interpolateValue: degenerate qHigh <= qLow returns vLow', () => {
  assertEqual(interpolateValue(50, 100, 50, 127.5, 60, W5_R1), 100)
})

// ── interpolateScheduleAt ───────────────────────────────────────────

test('interpolateScheduleAt: exact key returns its value', () => {
  assertEqual(interpolateScheduleAt({ 25: 39, 50: 39, 100: 45 }, 50), 39)
})

test('interpolateScheduleAt: between keys interpolates linearly (no weighting)', () => {
  // 50 @ 40, 100 @ 60, ask 75 → 40 + 20 × (25/50) = 50
  assertEqual(interpolateScheduleAt({ 50: 40, 100: 60 }, 75), 50)
})

test('interpolateScheduleAt: below the lowest key holds the lowest value', () => {
  assertEqual(interpolateScheduleAt({ 50: 40, 100: 60 }, 25), 40)
})

test('interpolateScheduleAt: above the highest key holds the highest value', () => {
  assertEqual(interpolateScheduleAt({ 50: 40, 100: 60 }, 200), 60)
})

test('interpolateScheduleAt: empty schedule returns 0', () => {
  assertEqual(interpolateScheduleAt({}, 60), 0)
})

test('interpolateScheduleAt: null/undefined schedule returns 0', () => {
  assertEqual(interpolateScheduleAt(null, 60), 0)
  assertEqual(interpolateScheduleAt(undefined, 60), 0)
})

// ── flat-above-top (metal) — mirrors orderPricing.test.ts ───────────

test('flatUnitTotal: holds the per-unit rate flat, rounded to the penny', () => {
  // 2299 / 1000 = 2.299 per card × 1500 = 3448.5 (World Youth Bank example)
  assertEqual(flatUnitTotal(1000, 2299, 1500), 3448.5)
})

test('flatTopTierTotal: above the top tier uses the top per-card rate', () => {
  // top tier 75 @ 127.5 → 1.7 per card × 100 = 170
  assertEqual(flatTopTierTotal([{ quantity: 50, total_price: 100 }, { quantity: 75, total_price: 127.5 }], 100), 170)
})

test('flatTopTierTotal: at/below the top tier returns null (not its job)', () => {
  const tiers = [{ quantity: 50, total_price: 100 }, { quantity: 75, total_price: 127.5 }]
  assertEqual(flatTopTierTotal(tiers, 75), null)
  assertEqual(flatTopTierTotal(tiers, 25), null)
})

test('flatTopTierTotal: empty tiers returns null', () => {
  assertEqual(flatTopTierTotal([], 100), null)
})

test('pricesFlatAboveTopTier: metal + carbon fibre true, others false', () => {
  assertEqual(pricesFlatAboveTopTier('metal_gold'), true)
  assertEqual(pricesFlatAboveTopTier('carbon_fibre'), true)
  assertEqual(pricesFlatAboveTopTier('carbon_fibre_cnc'), true)
  assertEqual(pricesFlatAboveTopTier('plastic_satin'), false)
  assertEqual(pricesFlatAboveTopTier(null), false)
  assertEqual(pricesFlatAboveTopTier(undefined), false)
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
