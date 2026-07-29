// Unit tests for selectionShapeLoss.ts
// Run with: npx tsx src/lib/selectionShapeLoss.test.ts
//
// The guard that stops a Recipients version silently losing its whole set when
// a designer switches it to Selection.
//
// The headline case is the last block: the real proof this was written for.
// An 8-name carbon-fibre set was rebuilt as a 2-direction "pick one" holding
// one person's card, with no warning of any kind — the other seven vanished
// from the current version and the reply went to the customer four minutes
// later. Every case below leans on "must warn" rather than the quiet path,
// because a false silence is what caused the incident.

import { selectionShapeLoss } from './selectionShapeLoss.ts'

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

const NAMES_8 = [
  'Rick Hendrick',
  'Mike Desmond',
  'Jeff Gordon',
  'Marshall Carlson',
  'Dale Ledbetter',
  'Hendrick Carlson',
  'Anthony P. Hilger',
  'Jeff Brown',
]

console.log('\nselectionShapeLoss — the quiet path (must NOT nag)\n')

test('a brand-new Selection with nothing in the form is not destructive', () => {
  const r = selectionShapeLoss({ names: [], carriedImageCount: 0, uploadedImageCount: 0 })
  assert(r.destructive === false, 'expected not destructive')
  assert(r.message === null, 'expected no confirm message')
})

test('a continuation carrying neither names nor artwork is not destructive', () => {
  // Reached when the source version was itself a Selection: the wizard seeds
  // an empty roster, so re-picking Selection loses nothing.
  const r = selectionShapeLoss({ names: [], carriedImageCount: 0, uploadedImageCount: 0 })
  assert(r.destructive === false, 'expected not destructive')
})

console.log('\nselectionShapeLoss — names at risk\n')

test('a roster with no images still warns', () => {
  // The roster alone is real work: it drives the split-name tooling surcharge
  // and the per-recipient approval slots.
  const r = selectionShapeLoss({ names: NAMES_8, carriedImageCount: 0, uploadedImageCount: 0 })
  assert(r.destructive === true, 'expected destructive')
  assert(r.nameCount === 8, `expected nameCount 8, got ${r.nameCount}`)
  assert(/8-name set/.test(r.message ?? ''), `message should name the roster size: ${r.message}`)
  assert(!/image/.test(r.message ?? ''), 'message should not claim images when there are none')
})

test('a single recipient reads as "1-name set", not "1-names"', () => {
  const r = selectionShapeLoss({ names: ['Rick Hendrick'], carriedImageCount: 0, uploadedImageCount: 0 })
  assert(/the 1-name set/.test(r.message ?? ''), `bad singular: ${r.message}`)
})

console.log('\nselectionShapeLoss — images at risk\n')

test('carried and uploaded images are counted together', () => {
  // Both buckets are dropped by the variant-round save path, so a warning that
  // counted only one of them would understate the loss.
  const r = selectionShapeLoss({ names: [], carriedImageCount: 14, uploadedImageCount: 4 })
  assert(r.imageCount === 18, `expected 18 images, got ${r.imageCount}`)
  assert(/18 images/.test(r.message ?? ''), `message should total both buckets: ${r.message}`)
})

test('uploaded-only images warn even with an empty roster', () => {
  // A Set (single) being switched to Selection: no names, but real artwork.
  const r = selectionShapeLoss({ names: [], carriedImageCount: 0, uploadedImageCount: 2 })
  assert(r.destructive === true, 'expected destructive')
  // Match the roster phrase specifically — a bare /set/ also hits the standing
  // copy "the directions you set up below".
  assert(!/-name set/.test(r.message ?? ''), 'message should not claim a roster when there is none')
})

test('one image reads as "1 image", not "1 images"', () => {
  const r = selectionShapeLoss({ names: [], carriedImageCount: 1, uploadedImageCount: 0 })
  assert(/ 1 image\b/.test(r.message ?? ''), `bad singular: ${r.message}`)
})

console.log('\nselectionShapeLoss — the incident (Experience Auto Group v7 → v8)\n')

test('the 8-name carbon-fibre set switching to Selection warns, naming both losses', () => {
  // v7: 8 recipients, 16 images (front + back each). This is the exact input
  // that produced no warning at all before this guard existed.
  const r = selectionShapeLoss({ names: NAMES_8, carriedImageCount: 16, uploadedImageCount: 0 })
  assert(r.destructive === true, 'THE INCIDENT: this must warn')
  assert(r.nameCount === 8, `expected 8 names, got ${r.nameCount}`)
  assert(r.imageCount === 16, `expected 16 images, got ${r.imageCount}`)
  const msg = r.message ?? ''
  assert(/8-name set/.test(msg), `must name the roster: ${msg}`)
  assert(/16 images/.test(msg), `must name the image count: ${msg}`)
  assert(/pick one direction/.test(msg), `must explain why: ${msg}`)
})

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
