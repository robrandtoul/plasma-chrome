// Unit tests for setConsistency.ts
// Run with: npx tsx src/lib/setConsistency.test.ts
//
// Each of the three findings is reconstructed from the live proof that
// prompted it, so a regression fails against the real shape rather
// than an invented one. The silence cases matter just as much: this
// renders on every save, and a check that cries wolf on the ordinary
// "shared front, personal backs" layout would be ignored within a
// week — which would cost more than it ever caught.

import { reviewSet, type SetImage } from './setConsistency.ts'

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

function img(
  associatedName: string | null,
  side: 'front' | 'back' | null,
  materialOption: string | null = null,
): SetImage {
  return { associatedName, side, materialOption }
}

const SOURDOUGH = ['William Delamore', 'Lyndon Short', 'James Gunns']

console.log('\nthe ordinary layouts stay silent')

test('shared front + a back each — the house standard', () => {
  const out = reviewSet({
    names: SOURDOUGH,
    images: [
      img(null, 'front'),
      img('William Delamore', 'back'),
      img('Lyndon Short', 'back'),
      img('James Gunns', 'back'),
    ],
  })
  assert(out.length === 0, `expected silence, got: ${out.map((f) => f.message).join(' / ')}`)
})

test('one-sided: a card each, no sides recorded anywhere', () => {
  // The 11 live rows in this shape are harmless — front is the only
  // thing an unlabelled image can be — so nagging would be noise.
  const out = reviewSet({
    names: ['Craig', 'Harry', 'Joseph'],
    images: [img('Craig', null), img('Harry', null), img('Joseph', null)],
  })
  assert(out.length === 0, 'a one-sided set should not be asked about sides')
})

test('a full two-sided card each, no shared artwork at all', () => {
  const out = reviewSet({
    names: ['Asha', 'Ben'],
    images: [
      img('Asha', 'front'), img('Asha', 'back'),
      img('Ben', 'front'), img('Ben', 'back'),
    ],
  })
  assert(out.length === 0, 'symmetrical set should be silent')
})

test('option tabs are judged one at a time, and a tabless image counts on every tab', () => {
  const out = reviewSet({
    names: ['Asha', 'Ben'],
    images: [
      img(null, 'front'),                 // no tab → covers both tabs
      img('Asha', 'back', 'natural'), img('Ben', 'back', 'natural'),
      img('Asha', 'back', 'brushed'), img('Ben', 'back', 'brushed'),
    ],
  })
  assert(out.length === 0, `expected silence, got: ${out.map((f) => f.message).join(' / ')}`)
})

test('shapes with a different slot model are left alone', () => {
  const lopsided = [img('Asha', 'front'), img('Ben', 'back')]
  assert(reviewSet({ names: ['Asha', 'Ben'], images: lopsided, isVariantRound: true }).length === 0,
    'a Selection round prices per direction — not a set')
  assert(reviewSet({ names: ['Asha', 'Ben'], images: lopsided, shape: 'set_collection' }).length === 0,
    'a collection keys slots on layouts, not names')
  assert(reviewSet({ names: [], images: lopsided }).length === 0, 'no roster, no set')
  assert(reviewSet({ names: ['Asha'], images: [] }).length === 0, 'no artwork yet, nothing to say')
})

console.log('\nunlabelled side — The Sourdough Company')

test('names the person whose artwork carries no side', () => {
  const out = reviewSet({
    names: SOURDOUGH,
    images: [
      img(null, 'front'),
      img('Lyndon Short', 'back'),
      img('William Delamore', 'back'),
      img('James Gunns', null),
    ],
  })
  const f = out.find((x) => x.kind === 'unlabelled-side')
  assert(!!f, `expected an unlabelled-side finding, got: ${out.map((x) => x.kind).join(',')}`)
  assert(f!.message.includes('James Gunns'), `should name him: ${f!.message}`)
  assert(!f!.message.includes('Lyndon'), `should not name the correct ones: ${f!.message}`)
})

test('one mistake is reported once, not twice', () => {
  // He is both "unlabelled" and, strictly, "has no back". Saying both
  // reads as two problems and sends the designer looking for a second
  // one that isn't there.
  const out = reviewSet({
    names: SOURDOUGH,
    images: [
      img(null, 'front'),
      img('Lyndon Short', 'back'),
      img('William Delamore', 'back'),
      img('James Gunns', null),
    ],
  })
  assert(out.length === 1, `expected exactly one finding, got ${out.length}: ${out.map((f) => f.message).join(' / ')}`)
})

test('shared artwork with no side is reported without naming anyone', () => {
  const out = reviewSet({
    names: ['Asha', 'Ben'],
    images: [img(null, null), img('Asha', 'back'), img('Ben', 'back')],
  })
  const f = out.find((x) => x.kind === 'unlabelled-side')
  assert(!!f, 'shared unlabelled artwork should still be raised')
  assert(f!.message.toLowerCase().includes('shared'), `should say it is the shared one: ${f!.message}`)
})

console.log('\nmissing a side')

test('a two-sided set where one person has no back', () => {
  const out = reviewSet({
    names: ['Asha', 'Ben'],
    images: [
      img('Asha', 'front'), img('Asha', 'back'),
      img('Ben', 'front'),
    ],
  })
  const f = out.find((x) => x.kind === 'missing-side')
  assert(!!f, 'should notice Ben has no back')
  assert(f!.message.includes('Ben') && f!.message.includes('back'), f!.message)
  assert(!f!.message.includes('Asha'), `Asha is complete: ${f!.message}`)
})

test('several people short the same side are named in one sentence', () => {
  const out = reviewSet({
    names: ['Asha', 'Ben', 'Cara'],
    images: [
      img(null, 'front'),
      img('Asha', 'back'),
    ],
  })
  const f = out.find((x) => x.kind === 'missing-side')
  assert(!!f, 'should notice the two without backs')
  assert(f!.message.includes('Ben') && f!.message.includes('Cara'), f!.message)
  assert(out.filter((x) => x.kind === 'missing-side').length === 1, 'one sentence, not one each')
})

test('a gap on ONE option tab is still caught', () => {
  const out = reviewSet({
    names: ['Asha', 'Ben'],
    images: [
      img(null, 'front'),
      img('Asha', 'back', 'natural'), img('Ben', 'back', 'natural'),
      img('Asha', 'back', 'brushed'),  // Ben missing on brushed
    ],
  })
  assert(out.some((x) => x.kind === 'missing-side' && x.message.includes('Ben')),
    `the brushed tab is short a card: ${out.map((f) => f.message).join(' / ')}`)
})

console.log('\ntwo designs under one name — MKC Wealth')

test('a recipient slot holding two images is flagged', () => {
  const out = reviewSet({
    names: ['Jed Wilson', 'Charles Follis'],
    images: [
      img('Jed Wilson', 'front'),
      img('Jed Wilson', 'front'),   // the Imperial Blue alternative
      img('Charles Follis', 'front'),
    ],
  })
  const f = out.find((x) => x.kind === 'doubled-slot')
  assert(!!f, 'should notice the doubled slot')
  assert(f!.message.includes('Jed Wilson'), f!.message)
  assert(!f!.message.includes('Charles'), `Charles has one: ${f!.message}`)
})

test('shared artwork may hold several images without complaint', () => {
  // No approval points at a shared slot in particular, so there is no
  // decision to lose — and showing a common design more than one way
  // is ordinary.
  const out = reviewSet({
    names: ['Asha', 'Ben'],
    images: [
      img(null, 'front'), img(null, 'front'),
      img('Asha', 'back'), img('Ben', 'back'),
    ],
  })
  assert(out.length === 0, `shared duplicates are fine: ${out.map((f) => f.message).join(' / ')}`)
})

test('the same person on two different tabs is not a doubled slot', () => {
  const out = reviewSet({
    names: ['Asha', 'Ben'],
    images: [
      img('Asha', 'front', 'natural'), img('Asha', 'front', 'brushed'),
      img('Ben', 'front', 'natural'),  img('Ben', 'front', 'brushed'),
    ],
  })
  assert(out.length === 0, `one card per tab is the point of tabs: ${out.map((f) => f.message).join(' / ')}`)
})

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
