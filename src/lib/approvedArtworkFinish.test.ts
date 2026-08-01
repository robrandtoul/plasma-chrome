// Unit tests for approvedArtworkFinish.ts
// Run with: npx tsx src/lib/approvedArtworkFinish.test.ts
//
// The rule decides which files reach PRODUCTION, so the tests are weighted
// toward the two directions it can be wrong in, which are not symmetrical:
//
//   1. Over-listing — the bug this module exists to fix. A three-finish metal
//      proof handed six files to production when the customer bought two, and
//      nothing on the page said which four to ignore.
//
//   2. Under-listing — the failure a naive fix introduces. Narrowing on a
//      finish code that matches nothing must fall back to the whole set with a
//      flag, never to an empty list. A production hand-off that quietly loses
//      a file is worse than one that shows too much and says so.
//
// Plus the case that must NOT narrow at all: a version with no finish tabs,
// where a null material_option is the real image rather than an orphan.

import {
  scopeToOrderedFinish,
  finishScopeIsUncertain,
  type FinishScopeOutcome,
} from './approvedArtworkFinish.ts'

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

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message)
}

function assertEquals<T>(actual: T, expected: T, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`)
  }
}

interface Img {
  name: string
  material_option: string | null
}

const img = (name: string, material_option: string | null): Img => ({ name, material_option })

// The live shape of the order that prompted this module: one recipient, two
// sides, three finish tabs — six images where the order bought two.
const THREE_FINISH_METAL: Img[] = [
  img('Proof02_Front_Natural.jpg', 'natural'),
  img('Proof03_Back_Natural.jpg', 'natural'),
  img('Proof02_Front_Brushed.jpg', 'brushed'),
  img('Proof03_Back_Brushed.jpg', 'brushed'),
  img('Proof02_Front_Mirror.jpg', 'mirror'),
  img('Proof03_Back_Mirror.jpg', 'mirror'),
]
const METAL_TABS = ['natural', 'brushed', 'mirror']

const names = (r: { images: Img[] }) => r.images.map((i) => i.name)

console.log('\napprovedArtworkFinish\n')

test('narrows a three-finish proof to the finish the order was bought against', () => {
  const r = scopeToOrderedFinish(THREE_FINISH_METAL, METAL_TABS, 'natural')
  assertEquals(r.outcome, 'scoped' as FinishScopeOutcome, 'outcome')
  assertEquals(names(r), ['Proof02_Front_Natural.jpg', 'Proof03_Back_Natural.jpg'], 'only the Natural files')
})

test('narrowing keeps both sides — front and back of the ordered finish', () => {
  const r = scopeToOrderedFinish(THREE_FINISH_METAL, METAL_TABS, 'mirror')
  assertEquals(names(r), ['Proof02_Front_Mirror.jpg', 'Proof03_Back_Mirror.jpg'], 'Mirror front + back')
})

test('a version with no finish tabs is left completely alone', () => {
  // The common case: 326 live versions carry null-option images that ARE the
  // artwork. Narrowing here would empty the hand-off.
  const shared = [img('front.jpg', null), img('back.jpg', null)]
  const r = scopeToOrderedFinish(shared, [], null)
  assertEquals(r.outcome, 'no-tabs' as FinishScopeOutcome, 'outcome')
  assertEquals(names(r), ['front.jpg', 'back.jpg'], 'every image kept')
})

test('no tabs + an ordered finish still keeps everything (preference-only finishes)', () => {
  // Full Colour Plastic gloss/matte (migration 000303): the order carries a
  // finish, but the proof never grew tabs because the artwork is identical
  // across it. Narrowing on 'gloss' here would hand production nothing.
  const shared = [img('front.jpg', null), img('back.jpg', null)]
  const r = scopeToOrderedFinish(shared, [], 'gloss')
  assertEquals(r.outcome, 'no-tabs' as FinishScopeOutcome, 'outcome')
  assertEquals(names(r), ['front.jpg', 'back.jpg'], 'every image kept')
})

test('tabs present but the order records no finish → full set, flagged', () => {
  const r = scopeToOrderedFinish(THREE_FINISH_METAL, METAL_TABS, null)
  assertEquals(r.outcome, 'finish-unknown' as FinishScopeOutcome, 'outcome')
  assertEquals(r.images.length, 6, 'falls back to the full set rather than guessing')
  assert(finishScopeIsUncertain(r.outcome), 'must be reported as uncertain')
})

test('an ordered finish matching no image → full set, flagged (never empty)', () => {
  // A finish retired from the proof after the order was placed, or an order
  // belonging to a different material's version.
  const r = scopeToOrderedFinish(THREE_FINISH_METAL, METAL_TABS, 'gun_metal')
  assertEquals(r.outcome, 'finish-missing' as FinishScopeOutcome, 'outcome')
  assertEquals(r.images.length, 6, 'falls back to the full set')
  assert(finishScopeIsUncertain(r.outcome), 'must be reported as uncertain')
})

test('an orphan null-option image is dropped when the version has tabs', () => {
  // Matches the customer page's own filter: with tabs present, every image the
  // customer saw carries one, so a null is a carry-forward they never saw.
  const withOrphan = [...THREE_FINISH_METAL, img('orphan.jpg', null)]
  const r = scopeToOrderedFinish(withOrphan, METAL_TABS, 'natural')
  assert(!names(r).includes('orphan.jpg'), 'orphan must not reach production')
  assertEquals(r.images.length, 2, 'still just the ordered finish')
})

test('a single-tab version scopes cleanly rather than reporting uncertainty', () => {
  const oneTab = [img('front.jpg', 'natural'), img('back.jpg', 'natural')]
  const r = scopeToOrderedFinish(oneTab, ['natural'], 'natural')
  assertEquals(r.outcome, 'scoped' as FinishScopeOutcome, 'outcome')
  assert(!finishScopeIsUncertain(r.outcome), 'not uncertain')
})

test('blank and whitespace inputs degrade to the safe branches, not a bad filter', () => {
  // A '' or '   ' code must read as "no finish recorded", not as a code that
  // matches nothing — the two land on different outcomes and both must be
  // safe, but only one is honest.
  assertEquals(
    scopeToOrderedFinish(THREE_FINISH_METAL, METAL_TABS, '  ').outcome,
    'finish-unknown' as FinishScopeOutcome,
    'whitespace code',
  )
  assertEquals(
    scopeToOrderedFinish(THREE_FINISH_METAL, ['', '  '], 'natural').outcome,
    'no-tabs' as FinishScopeOutcome,
    'blank tab codes are no tabs',
  )
  assertEquals(
    scopeToOrderedFinish(THREE_FINISH_METAL, null, 'natural').outcome,
    'no-tabs' as FinishScopeOutcome,
    'null tabs',
  )
})

test('an empty image list never reports a confident scope', () => {
  const r = scopeToOrderedFinish([] as Img[], METAL_TABS, 'natural')
  assertEquals(r.outcome, 'finish-missing' as FinishScopeOutcome, 'outcome')
  assertEquals(r.images.length, 0, 'nothing to show either way')
})

test('does not mutate or reorder the caller’s array', () => {
  const input = [...THREE_FINISH_METAL]
  const r = scopeToOrderedFinish(input, METAL_TABS, 'brushed')
  assertEquals(input.length, 6, 'input untouched')
  assertEquals(names(r), ['Proof02_Front_Brushed.jpg', 'Proof03_Back_Brushed.jpg'], 'source order preserved')
})

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
