// Tests for the artwork-check spend maths.
// Run with: npx tsx src/lib/aiModelPricing.test.ts  (pnpm test:ai-pricing)
//
// These figures end up on an admin page as money, so the two things worth
// pinning are (a) the cache multipliers, which are the easiest thing to get
// silently wrong, and (b) that an unknown model reads as unpriced rather than
// free — a silent 0 would understate the total with nothing on screen to
// suggest anything was missing.

import {
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_MULTIPLIER,
  MODEL_RATES,
  estimateRunCost,
  fmtGbp,
  fmtUsd,
  rateFor,
  totalSpend,
} from './aiModelPricing'

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

function eq(actual: unknown, expected: unknown, label = '') {
  if (actual !== expected) {
    throw new Error(`${label} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

function close(actual: number, expected: number, label = '', tol = 1e-9) {
  if (Math.abs(actual - expected) > tol) {
    throw new Error(`${label} expected ~${expected}, got ${actual}`)
  }
}

const TODAY = '2026-07-27'

console.log('\naiModelPricing')

test('plain input + output priced at the published per-MTok rates', () => {
  // Opus 4.8: $5/MTok in, $25/MTok out.
  const cost = estimateRunCost('claude-opus-4-8', { input_tokens: 1_000_000, output_tokens: 1_000_000 }, TODAY)
  close(cost!, 30, 'opus 4.8 1M in + 1M out')
})

test('cache writes bill at 1.25x the input rate (5-minute TTL)', () => {
  const cost = estimateRunCost('claude-opus-4-8', { cache_write_tokens: 1_000_000 }, TODAY)
  close(cost!, 5 * CACHE_WRITE_MULTIPLIER, 'cache write')
  close(cost!, 6.25, 'cache write in dollars')
})

test('cache reads bill at 0.1x the input rate', () => {
  const cost = estimateRunCost('claude-opus-4-8', { cache_read_tokens: 1_000_000 }, TODAY)
  close(cost!, 5 * CACHE_READ_MULTIPLIER, 'cache read')
  close(cost!, 0.5, 'cache read in dollars')
})

test('cache multipliers key off INPUT price, not output', () => {
  // Fable 5 has a 5x output/input ratio, so an output-rate bug shows up here.
  const cost = estimateRunCost('claude-fable-5', { cache_read_tokens: 1_000_000 }, TODAY)
  close(cost!, 1.0, 'fable cache read = 10 * 0.1')
})

test('all four token buckets sum', () => {
  const cost = estimateRunCost(
    'claude-opus-5',
    { input_tokens: 100_000, output_tokens: 20_000, cache_write_tokens: 40_000, cache_read_tokens: 200_000 },
    TODAY,
  )
  const expected = 0.1 * 5 + 0.02 * 25 + 0.04 * 5 * 1.25 + 0.2 * 5 * 0.1
  close(cost!, expected, 'mixed buckets')
})

test('missing / null token fields count as zero, not NaN', () => {
  const cost = estimateRunCost('claude-opus-5', { input_tokens: null, output_tokens: undefined }, TODAY)
  eq(cost, 0, 'all-null run')
  const partial = estimateRunCost('claude-opus-5', { input_tokens: 1_000_000, cache_read_tokens: null }, TODAY)
  close(partial!, 5, 'null cache field ignored')
})

test('an unknown model is unpriced (null), never free (0)', () => {
  eq(estimateRunCost('some-future-model', { input_tokens: 5_000_000 }, TODAY), null, 'unknown model')
  eq(estimateRunCost('(unrecorded)', { input_tokens: 5_000_000 }, TODAY), null, 'pre-ledger bucket')
})

test('Sonnet 5 introductory pricing applies through its end date, standard after', () => {
  const intro = MODEL_RATES['claude-sonnet-5'].intro!
  eq(rateFor('claude-sonnet-5', intro.through)!.inputPerMTok, 2, 'on the final promo day')
  eq(rateFor('claude-sonnet-5', '2026-09-01')!.inputPerMTok, 3, 'day after the promo')
  eq(rateFor('claude-sonnet-5', '2026-09-01')!.outputPerMTok, 15, 'standard output rate')
})

test('models without a promotion price the same on any date', () => {
  eq(rateFor('claude-opus-4-8', '2026-01-01')!.inputPerMTok, 5, 'past')
  eq(rateFor('claude-opus-4-8', '2027-01-01')!.inputPerMTok, 5, 'future')
})

test('totalSpend sums priced models and reports unpriced ones separately', () => {
  const out = totalSpend(
    [
      { model: 'claude-opus-4-8', runs: 10, input_tokens: 1_000_000 },
      { model: 'claude-opus-5', runs: 5, output_tokens: 1_000_000 },
      { model: '(unrecorded)', runs: 56, input_tokens: 9_000_000 },
    ],
    TODAY,
  )
  close(out.usd, 5 + 25, 'priced total excludes the unpriced bucket')
  eq(out.unpricedModels.length, 1, 'one unpriced model')
  eq(out.unpricedModels[0], '(unrecorded)')
  eq(out.unpricedRuns, 56, 'unpriced run count surfaced')
})

test('sub-cent amounts do not render as zero', () => {
  eq(fmtUsd(0.004), '<$0.01', 'tiny usd')
  eq(fmtGbp(0.004), '<£0.01', 'tiny gbp')
  eq(fmtUsd(0), '$0.00', 'exact zero stays zero')
  eq(fmtUsd(1234.5), '$1,234.50', 'thousands separator')
})

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
