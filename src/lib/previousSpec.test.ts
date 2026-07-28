// Tests for the "same as last time" guidance rules + copy (migration 000364).
// Run with: npx tsx src/lib/previousSpec.test.ts  (pnpm test:previous-spec)
//
// Locks three things: (1) the matching rules — badge only when the previous
// option is genuinely offered, difference note only after a different pick,
// no-longer-offered note only when we can name the old option; (2) the exact
// customer-facing copy, so both pay pages read identically and a wording
// change is a deliberate edit here, not an accident; (3) client-parser ↔
// server-sanitiser agreement — like the ukVatArea twins, the client's
// parsePreviousSpec and the server's sanitisePreviousSpec are separate
// modules (Vite and Deno can't share one), so this test feeds both the same
// payloads and fails on drift.

import {
  parsePreviousSpec,
  chooserGuidance,
  quantityHint,
  previousBadgeText,
  type PreviousSpec,
} from './previousSpec'
import { sanitisePreviousSpec } from '../../supabase/functions/_shared/previousSpec.ts'

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

function assertEqual(actual: unknown, expected: unknown, label = '') {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`${label ? `${label}: ` : ''}expected ${e}, got ${a}`)
}

const SPEC: PreviousSpec = {
  variant_id: 'v-500',
  variant_label: '500 microns',
  option_id: 'o-brushed',
  option_label: 'Brushed',
  quantity: 500,
  label: 'March 2022',
  source: 'auto',
}

const OFFERED_VARIANTS = ['v-300', 'v-500', 'v-800']
const OFFERED_FINISHES = ['o-natural', 'o-brushed', 'o-mirror']

console.log('parsePreviousSpec')

test('round-trips a well-formed spec', () => {
  assertEqual(parsePreviousSpec({ ...SPEC }), SPEC)
})

test('null/garbage/array/empty-object all parse to null', () => {
  assertEqual(parsePreviousSpec(null), null)
  assertEqual(parsePreviousSpec(undefined), null)
  assertEqual(parsePreviousSpec('spec'), null)
  assertEqual(parsePreviousSpec([SPEC]), null)
  assertEqual(parsePreviousSpec({}), null)
})

test('a bare date label with no spec fields is null — it guides nobody', () => {
  assertEqual(parsePreviousSpec({ label: 'March 2022', source: 'auto' }), null)
})

test('quantity alone is enough; bad quantities drop to null', () => {
  const spec = parsePreviousSpec({ quantity: 250 })
  assertEqual(spec?.quantity, 250)
  assertEqual(parsePreviousSpec({ quantity: -5 }), null)
  assertEqual(parsePreviousSpec({ quantity: 2.5 }), null)
  assertEqual(parsePreviousSpec({ quantity: 'lots' }), null)
})

test('whitespace-only strings read as null; unknown source falls back to manual', () => {
  const spec = parsePreviousSpec({ variant_id: '  v-500  ', variant_label: '   ', source: 'guess' })
  assertEqual(spec?.variant_id, 'v-500')
  assertEqual(spec?.variant_label, null)
  assertEqual(spec?.source, 'manual')
})

console.log('client parser ↔ server sanitiser parity')

// The server additionally caps string lengths (its output is what gets
// stored); on realistic payloads the two must agree exactly.
const PARITY_CASES: unknown[] = [
  { ...SPEC },
  { quantity: 250 },
  { variant_id: 'v-800', variant_label: '800 microns', source: 'manual' },
  { option_id: 'o-mirror', option_label: 'Mirror', label: 'June 2019' },
  { label: 'March 2022' },
  {},
  null,
  'garbage',
  [1, 2, 3],
  { quantity: 0 },
  { quantity: '500' },
  { variant_id: '   ', option_label: '  Brushed ' },
]

test('both sides agree on every realistic payload', () => {
  for (const c of PARITY_CASES) {
    assertEqual(sanitisePreviousSpec(c), parsePreviousSpec(c), JSON.stringify(c))
  }
})

test('both sides cap oversized strings identically', () => {
  const long = 'x'.repeat(500)
  const stored = sanitisePreviousSpec({ variant_id: long, variant_label: long, label: long })
  assertEqual(stored?.variant_id?.length, 64)
  assertEqual(stored?.variant_label?.length, 120)
  assertEqual(stored?.label?.length, 60)
  assertEqual(parsePreviousSpec(stored), stored, 'stored shape must round-trip through the client parser')
  // The client parser must enforce the same caps itself — orders are
  // designer-writable under RLS, so the anon page can't trust the column to
  // have come through create-order's sanitiser.
  assertEqual(parsePreviousSpec({ variant_id: long, variant_label: long, label: long }), stored)
  assertEqual(parsePreviousSpec({ quantity: 2_000_000 }), null, 'client must bound quantity too')
})

test('a cap landing inside an emoji never leaves a lone surrogate (jsonb would reject it)', () => {
  // 'x' × 119 + 😀 (a surrogate pair at indices 119–120): slice(0, 120) cuts
  // the pair in half. Both sides must drop the orphan half.
  const straddling = 'x'.repeat(119) + '😀'
  const stored = sanitisePreviousSpec({ variant_label: straddling })
  assertEqual(stored?.variant_label, 'x'.repeat(119))
  assertEqual(parsePreviousSpec({ variant_label: straddling }), stored, 'client mirrors the surrogate handling')
  // An emoji safely inside the cap survives whole.
  const inside = 'x'.repeat(100) + '😀'
  assertEqual(sanitisePreviousSpec({ variant_label: inside })?.variant_label, inside)
})

console.log('previousBadgeText')

test('with and without a date label', () => {
  assertEqual(previousBadgeText(SPEC), 'Your last order · March 2022')
  assertEqual(previousBadgeText({ ...SPEC, label: null }), 'Your last order')
})

console.log('chooserGuidance — thickness')

test('previous variant offered, nothing chosen yet → badge only, catalogue badges stand down', () => {
  const g = chooserGuidance('thickness', SPEC, OFFERED_VARIANTS, null)
  assertEqual(g, {
    badgeId: 'v-500',
    badgeText: 'Your last order · March 2022',
    suppressCatalogueBadges: true,
    note: null,
  })
})

test('customer picks the same again → badge, no note', () => {
  const g = chooserGuidance('thickness', SPEC, OFFERED_VARIANTS, 'v-500')
  assertEqual(g.note, null)
  assertEqual(g.badgeId, 'v-500')
})

test('customer picks differently → the conscious-change note names the old spec', () => {
  const g = chooserGuidance('thickness', SPEC, OFFERED_VARIANTS, 'v-800')
  assertEqual(g.badgeId, 'v-500')
  assertEqual(
    g.note,
    'Just so you know — this is a different thickness from your last order (you had 500 microns).',
  )
})

test('difference note without a frozen label stays honest but nameless', () => {
  const g = chooserGuidance('thickness', { ...SPEC, variant_label: null }, OFFERED_VARIANTS, 'v-800')
  assertEqual(g.note, 'Just so you know — this is a different thickness from your last order.')
})

test('previous option not offered here → honest explainer, no badge, catalogue badges keep working', () => {
  // "isn't available on this order", never "we no longer offer" — the chooser
  // is scoped to this proof's tabs/currency, so the old option may be absent
  // while still very much in the catalogue.
  const g = chooserGuidance('thickness', SPEC, ['v-300', 'v-800'], null)
  assertEqual(g, {
    badgeId: null,
    badgeText: null,
    suppressCatalogueBadges: false,
    note: 'Your last order was 500 microns, which isn’t available on this order — the thicknesses above are the current options.',
  })
})

test('retired AND unnameable → silence, not a vague warning', () => {
  const g = chooserGuidance('thickness', { ...SPEC, variant_label: null }, ['v-300', 'v-800'], null)
  assertEqual(g, { badgeId: null, badgeText: null, suppressCatalogueBadges: false, note: null })
})

test('no previous thickness at all → no guidance (finish-only specs leave this chooser alone)', () => {
  const finishOnly = { ...SPEC, variant_id: null, variant_label: null }
  assertEqual(chooserGuidance('thickness', finishOnly, OFFERED_VARIANTS, 'v-800'), {
    badgeId: null,
    badgeText: null,
    suppressCatalogueBadges: false,
    note: null,
  })
})

test('null spec → no guidance', () => {
  const g = chooserGuidance('thickness', null, OFFERED_VARIANTS, 'v-800')
  assertEqual(g.badgeId, null)
  assertEqual(g.note, null)
})

console.log('chooserGuidance — finish')

test('reads the option fields and words the copy for finishes', () => {
  const g = chooserGuidance('finish', SPEC, OFFERED_FINISHES, 'o-mirror')
  assertEqual(g.badgeId, 'o-brushed')
  assertEqual(
    g.note,
    'Just so you know — this is a different finish from your last order (you had Brushed).',
  )
})

test('unavailable finish explainer', () => {
  const g = chooserGuidance('finish', SPEC, ['o-natural', 'o-mirror'], null)
  assertEqual(
    g.note,
    'Your last order was Brushed, which isn’t available on this order — the finishes above are the current options.',
  )
})

console.log('quantityHint')

test('single, split and no-label variants', () => {
  assertEqual(quantityHint(SPEC), 'Last time you ordered 500 — March 2022.')
  assertEqual(quantityHint(SPEC, { split: true }), 'Last time you ordered 500 in total — March 2022.')
  assertEqual(quantityHint({ ...SPEC, label: null }), 'Last time you ordered 500.')
  assertEqual(quantityHint({ ...SPEC, quantity: null }), null)
  assertEqual(quantityHint(null), null)
})

test('large quantities are formatted with separators', () => {
  assertEqual(quantityHint({ ...SPEC, quantity: 10000, label: null }), 'Last time you ordered 10,000.')
})

console.log('')
if (failed > 0) {
  console.error(`${failed} test(s) failed (${passed} passed)`)
  process.exit(1)
} else {
  console.log(`All ${passed} previous-spec tests passed`)
}
