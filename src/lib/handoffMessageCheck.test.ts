// Unit tests for handoffMessageCheck.ts
// Run with: npx tsx src/lib/handoffMessageCheck.test.ts
//
// The check is the sole client-side guard (mirrored server-side) on a freely-
// edited order hand-off: it must let a normal edit through while refusing one
// that would break Stock Control's first-wins ingester. The cases below are the
// exact failure modes the 2026-06-30 adversarial review surfaced — a substring
// false-negative (Qty: 50 hidden by Qty: 500), a prepended conflicting spec
// block, and a stray "name — N" split line — plus the happy paths.

import { checkEditedMessage } from './handoffMessageCheck'

// ── Harness ─────────────────────────────────────────────────────────────────

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

function assertEqual<T>(actual: T, expected: T, message?: string) {
  if (actual !== expected) {
    throw new Error(message ?? `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

// A representative supplier-route spec block (the lines place-order generates).
const SUPPLIER_CRITICAL = [
  'Qty: 2250',
  'Material: Full colour plastic',
  'Type: Satin Plastic',
  'Thickness: 800um',
  'Finish: Matte',
  'Must ship by: 13 Jul 2026',
  'Artwork: https://www.dropbox.com/scl/fo/abc?rlkey=xyz-123&dl=0',
]

// The full composed supplier message (template prose + the spec block).
const SUPPLIER_MESSAGE = [
  'Hi,',
  '',
  'Please produce the following order for The Medical Lounge:',
  '',
  ...SUPPLIER_CRITICAL,
  '',
  'Many thanks.',
].join('\n')

// An in-house split order (the spec lines live directly in the message).
const SPLIT_CRITICAL = [
  'Qty: 100',
  'Card: Stainless Steel',
  'Date required: 30 Jun 2026',
  'Joe — 50',
  'Jane — 50',
  'Artwork: https://www.dropbox.com/scl/fo/def?rlkey=q&dl=0',
]
const SPLIT_MESSAGE = SPLIT_CRITICAL.join('\n')

// ── Happy paths ───────────────────────────────────────────────────────────────

test('an untouched composed message passes', () => {
  assertEqual(checkEditedMessage(SUPPLIER_MESSAGE, SUPPLIER_CRITICAL).length, 0)
})

test('editing only the prose around the spec block passes', () => {
  const edited = SUPPLIER_MESSAGE
    .replace('Hi,', 'Hi team,')
    .replace('Many thanks.', 'Many thanks — rush job, please prioritise.')
  assertEqual(checkEditedMessage(edited, SUPPLIER_CRITICAL).length, 0)
})

test('a plain-prose note line that is not spec-shaped passes', () => {
  const edited = SUPPLIER_MESSAGE.replace('Many thanks.', 'Please use the matte stock.\n\nMany thanks.')
  assertEqual(checkEditedMessage(edited, SUPPLIER_CRITICAL).length, 0)
})

test('extra blank lines / surrounding whitespace do not trip the check', () => {
  const edited = `\n\n${SUPPLIER_MESSAGE}\n\n`
  assertEqual(checkEditedMessage(edited, SUPPLIER_CRITICAL).length, 0)
})

test('a genuine split order passes', () => {
  assertEqual(checkEditedMessage(SPLIT_MESSAGE, SPLIT_CRITICAL).length, 0)
})

// ── Dropped lines ─────────────────────────────────────────────────────────────

test('deleting a spec line is flagged', () => {
  const edited = SUPPLIER_MESSAGE.replace('Material: Full colour plastic\n', '')
  const problems = checkEditedMessage(edited, SUPPLIER_CRITICAL)
  assertEqual(problems.length, 1)
  assertEqual(problems[0].includes('Material: Full colour plastic'), true)
})

test('the substring false-negative is caught: replacing "Qty: 2250" with "Qty: 22500" is flagged (old .includes() would have passed it)', () => {
  // The old substring check passed because "Qty: 22500" contains "Qty: 2250".
  // Whole-line matching flags the genuine line as missing AND the wrong line as
  // a rogue spec line the parser would read instead.
  const edited = SUPPLIER_MESSAGE.replace('Qty: 2250', 'Qty: 22500')
  assertEqual(edited.includes('Qty: 2250'), true) // proves the old check would pass
  const problems = checkEditedMessage(edited, SUPPLIER_CRITICAL)
  assertEqual(problems.some((p) => p.includes('Missing required line') && p.includes('Qty: 2250')), true)
  assertEqual(problems.some((p) => p.includes('misread') && p.includes('Qty: 22500')), true)
})

test('a mid-sentence number in prose is NOT spec-shaped and passes', () => {
  const edited = SUPPLIER_MESSAGE.replace('Many thanks.', 'NB we also quoted 22500 separately.\n\nMany thanks.')
  assertEqual(checkEditedMessage(edited, SUPPLIER_CRITICAL).length, 0)
})

// ── Added / conflicting lines ───────────────────────────────────────────────────

test('a prepended conflicting Qty block is flagged even though the genuine line survives', () => {
  // First-wins parser would read the prepended Qty: 50; the genuine Qty: 2250
  // still "passes" a presence test — so the added line must itself be caught.
  const edited = ['Qty: 50', 'Material: Gold', SUPPLIER_MESSAGE].join('\n')
  const problems = checkEditedMessage(edited, SUPPLIER_CRITICAL)
  assertEqual(problems.some((p) => p.includes('Qty: 50')), true)
  assertEqual(problems.some((p) => p.includes('Material: Gold')), true)
})

test('a stray "name — N" split line added to an in-house order is flagged', () => {
  const edited = `${SPLIT_MESSAGE}\nBob — 999`
  const problems = checkEditedMessage(edited, SPLIT_CRITICAL)
  assertEqual(problems.length, 1)
  assertEqual(problems[0].includes('Bob — 999'), true)
})

test('a colon/hyphen split-shaped prose line ("Ref: 4521") is flagged', () => {
  const edited = SUPPLIER_MESSAGE.replace('Many thanks.', 'Ref: 4521\n\nMany thanks.')
  const problems = checkEditedMessage(edited, SUPPLIER_CRITICAL)
  assertEqual(problems.some((p) => p.includes('Ref: 4521')), true)
})

test('a duplicate of the SAME spec line is harmless (matches a critical line, not flagged)', () => {
  const edited = SUPPLIER_MESSAGE.replace('Qty: 2250', 'Qty: 2250\nQty: 2250')
  assertEqual(checkEditedMessage(edited, SUPPLIER_CRITICAL).length, 0)
})

test('the Dropbox URL line (which contains a hyphen-digit run) is not self-flagged', () => {
  // "...xyz-123&dl=0" matches the split shape, but it is a genuine critical line
  // so the exemption must hold.
  assertEqual(checkEditedMessage(SUPPLIER_MESSAGE, SUPPLIER_CRITICAL).length, 0)
})

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
