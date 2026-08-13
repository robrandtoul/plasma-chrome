// Unit tests for currentVersionArtwork.ts
// Run with: npx tsx src/lib/currentVersionArtwork.test.ts
//
// The proof detail page used to show the first front and the first back of the
// current version and nothing else. On the Brownies Tree wood proof — six
// species as a Selection round, every image stamped side='front' — that meant
// ONE unlabelled picture of Walnut, on a project the customer had chosen Maple
// for. The order went out as Black Walnut.
//
// So the cases below lean hardest on two things: that nothing is dropped, and
// that a caption is never allowed to assert something the data does not say.
// A label part appears only when it distinguishes; two tiles never read the
// same; and `side` is reported, never trusted as structure (all 34 images
// across the five live set_collections are stamped 'front', backs included).

import {
  buildCurrentVersionArtwork,
  artworkGridColumns,
  type ArtworkImageRow,
} from './currentVersionArtwork.ts'

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

function assertLabels(actual: (string | null)[], expected: (string | null)[], label: string) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`)
}

// ── Fixture builder ───────────────────────────────────────────────────────────

let seq = 0
function img(overrides: Partial<ArtworkImageRow> = {}): ArtworkImageRow {
  seq += 1
  return {
    id: `img-${String(seq).padStart(2, '0')}`,
    image_path: `path/${seq}.jpg`,
    side: 'front',
    sort_order: seq - 1,
    associated_name: null,
    material_option: null,
    original_filename: null,
    variant_name: null,
    layout_title: null,
    ...overrides,
  }
}

const labels = (rows: ArtworkImageRow[], opts?: Map<string, string>) =>
  buildCurrentVersionArtwork(rows, opts).map((r) => r.label)

// ── Nothing is dropped ────────────────────────────────────────────────────────

console.log('\nEvery image survives')

test('a six-direction Selection round returns all six, not one', () => {
  seq = 0
  const rows = ['Walnut', 'Oak', 'Birch', 'Cherry', 'Bamboo', 'Maple'].map((v) =>
    img({ variant_name: v }),
  )
  const out = buildCurrentVersionArtwork(rows)
  assert(out.length === 6, `expected 6 images, got ${out.length}`)
  assertLabels(out.map((r) => r.label), ['Walnut', 'Oak', 'Birch', 'Cherry', 'Bamboo', 'Maple'], 'species')
})

test('an eighteen-image collection returns all eighteen', () => {
  seq = 0
  const rows: ArtworkImageRow[] = []
  for (let i = 0; i < 9; i++) {
    rows.push(img({ layout_title: `Layout ${i}`, original_filename: `L${i}_front.jpg` }))
    rows.push(img({ layout_title: `Layout ${i}`, original_filename: `L${i}_back.jpg` }))
  }
  assert(buildCurrentVersionArtwork(rows).length === 18, 'expected all 18 images')
})

test('no images returns an empty set rather than throwing', () => {
  assert(buildCurrentVersionArtwork([]).length === 0, 'expected []')
})

// ── A part appears only when it distinguishes ─────────────────────────────────

console.log('\nLabels say only what tells the cards apart')

test("today's front/back pair still reads Front / Back", () => {
  seq = 0
  assertLabels(labels([img({ side: 'front' }), img({ side: 'back' })]), ['Front', 'Back'], 'pair')
})

test('a lone image carries no label at all', () => {
  seq = 0
  assertLabels(labels([img({ side: 'front' })]), [null], 'single')
})

test('a one-sided set is not stamped "Front" six times', () => {
  seq = 0
  const rows = ['Walnut', 'Oak', 'Birch'].map((v) => img({ variant_name: v, side: 'front' }))
  assertLabels(labels(rows), ['Walnut', 'Oak', 'Birch'], 'one-sided')
})

test('a single recipient is not repeated on every tile', () => {
  seq = 0
  const rows = [
    img({ associated_name: 'Christos Bantzos', side: 'front' }),
    img({ associated_name: 'Christos Bantzos', side: 'back' }),
  ]
  assertLabels(labels(rows), ['Front', 'Back'], 'single recipient')
})

test('two recipients plus a shared front name the people', () => {
  seq = 0
  const rows = [
    img({ associated_name: null, side: 'front' }),
    img({ associated_name: 'Hank Scorpio', side: 'back' }),
    img({ associated_name: 'Frank Grimes', side: 'back' }),
  ]
  assertLabels(labels(rows), ['Front', 'Hank Scorpio · Back', 'Frank Grimes · Back'], 'roster')
})

test('option tabs resolve their display name, and fall back to the raw code', () => {
  seq = 0
  const rows = [
    img({ material_option: 'black_walnut' }),
    img({ material_option: 'canadian_maple' }),
    img({ material_option: 'unmapped_code' }),
  ]
  const opts = new Map([
    ['black_walnut', 'Black Walnut'],
    ['canadian_maple', 'Canadian Maple'],
  ])
  assertLabels(labels(rows, opts), ['Black Walnut', 'Canadian Maple', 'unmapped_code'], 'options')
})

test('a two-axis version names both the tab and the side', () => {
  seq = 0
  const rows = [
    img({ material_option: 'natural', side: 'front' }),
    img({ material_option: 'natural', side: 'back' }),
    img({ material_option: 'mirror', side: 'front' }),
    img({ material_option: 'mirror', side: 'back' }),
  ]
  const opts = new Map([['natural', 'Natural'], ['mirror', 'Mirror']])
  assertLabels(
    labels(rows, opts),
    ['Natural · Front', 'Natural · Back', 'Mirror · Front', 'Mirror · Back'],
    'two axes',
  )
})

// ── Two tiles never read the same ─────────────────────────────────────────────

console.log('\nNo two tiles claim to be the same card')

test('a face uploaded once per direction is told apart by its filename', () => {
  // The live Gun Metal shape: the same back re-uploaded under each variant,
  // every row stamped side='front', so nothing else separates them.
  seq = 0
  const rows = [
    img({ variant_name: 'Pantone Silver', original_filename: 'Proof01B_Back_GunM.jpg' }),
    img({ variant_name: 'Pantone Silver', original_filename: 'Proof01A_Front_GunM.jpg' }),
    img({ variant_name: 'Bronze', original_filename: 'Proof01B_Back_GunM.jpg' }),
    img({ variant_name: 'Bronze', original_filename: 'Proof02_Bronze.jpg' }),
  ]
  assertLabels(
    labels(rows),
    [
      'Proof01B_Back_GunM · Pantone Silver',
      'Proof01A_Front_GunM · Pantone Silver',
      'Proof01B_Back_GunM · Bronze',
      'Proof02_Bronze · Bronze',
    ],
    'collision',
  )
})

test('the part that differs survives truncation — it leads, it does not trail', () => {
  // The live 18-image collection. Captions are one truncating line, so a
  // tiebreak appended at the end is the first thing lost: both faces used to
  // render "METHANE · Proof01A_METHANE_" and read as the same card.
  seq = 0
  const rows = [
    img({ layout_title: 'METHANE', original_filename: 'Proof01A_METHANE_FCP.jpg' }),
    img({ layout_title: 'METHANE', original_filename: 'Proof01A_METHANE_FCP_Back.jpg' }),
  ]
  const out = labels(rows).map((l) => l ?? '')
  assert(out[0] !== out[1], 'labels must differ')
  // ~27 uppercase glyphs fit the caption box at the widest measured layout.
  assert(
    out[0].slice(0, 27) !== out[1].slice(0, 27),
    `must differ within the visible head, got "${out[0].slice(0, 27)}" twice`,
  )
})

test('a filename that contradicts the stored side withdraws the side claim', () => {
  // Five live versions store backs as side='front'. Captioning three backs
  // "Front" is worse than saying nothing — the filenames are the designer's
  // own words, the column is a form field they never see.
  seq = 0
  const rows = [
    img({ material_option: 'natural', side: 'front', original_filename: 'Proof01_Back_Natural.jpg' }),
    img({ material_option: 'natural', side: 'back', original_filename: 'Proof02_Back_Natural.jpg' }),
  ]
  const opts = new Map([['natural', 'Natural']])
  const out = labels(rows, opts).map((l) => l ?? '')
  assert(!out.some((l) => /Front|Back$/.test(l.split(' · ').pop() ?? '')), `no side may be claimed: ${JSON.stringify(out)}`)
  assert(out[0] !== out[1], 'the two must still be told apart')
})

test('a filename with no side word leaves the side claim standing', () => {
  seq = 0
  const rows = [
    img({ side: 'front', original_filename: 'Proof01_Backdrop_Study.jpg' }),
    img({ side: 'back', original_filename: 'Proof02_Study.jpg' }),
  ]
  assertLabels(labels(rows), ['Front', 'Back'], 'no contradiction')
})

test('a value every image shares is dropped, even with nothing to replace it', () => {
  // Two images on one direction: the direction name is context, not a
  // distinction, and there is no filename to fall back on. Two bare tiles is
  // the honest answer — the data genuinely does not tell them apart.
  seq = 0
  const rows = [img({ variant_name: 'Option A' }), img({ variant_name: 'Option A' })]
  assertLabels(labels(rows), [null, null], 'no filename')
})

test('unlabelled duplicates fall back to filenames rather than showing nothing', () => {
  seq = 0
  const rows = [
    img({ side: 'front', original_filename: 'Proof01_Front.jpg' }),
    img({ side: 'front', original_filename: 'Proof02_Front.jpg' }),
  ]
  assertLabels(labels(rows), ['Proof01_Front', 'Proof02_Front'], 'bare duplicates')
})

// ── side is data, not structure ───────────────────────────────────────────────

console.log('\nside is reported, never trusted')

test('a wholly mis-stamped collection claims no side, and keeps its stored order', () => {
  // All five live set_collections stamp every image 'front', backs included.
  // Nothing may print "Front" on the strength of that, and the pair falls back
  // to the designer's own filenames — which is where the word "Back" legitimately
  // survives, as data rather than as our claim.
  seq = 0
  const rows = [
    img({ id: 'i-back', sort_order: 0, layout_title: 'ROCKWOOD', side: 'front', original_filename: 'Proof01E_ROCKWOOD_Back.jpg' }),
    img({ id: 'i-front', sort_order: 1, layout_title: 'ROCKWOOD', side: 'front', original_filename: 'Proof02E_ROCKWOOD.jpg' }),
  ]
  const out = buildCurrentVersionArtwork(rows)
  assertLabels(out.map((r) => r.label), ['Proof01E_ROCKWOOD_Back', 'Proof02E_ROCKWOOD'], 'collection')
  assert(!out.some((r) => / · (Front|Back)$/.test(r.label ?? '')), 'no side may be claimed')
  assert(out[0].id === 'i-back', 'stored order must be preserved, not re-sorted by side')
})

test('sort_order wins over side, and ties break stably on id', () => {
  seq = 0
  const back = img({ id: 'img-b', side: 'back', sort_order: 0 })
  const front = img({ id: 'img-a', side: 'front', sort_order: 1 })
  const out = buildCurrentVersionArtwork([front, back])
  assert(out[0].id === 'img-b', `designer order must win; got ${out[0].id} first`)
})

test('a null sort_order does not throw the order into disarray', () => {
  seq = 0
  const rows = [img({ id: 'img-z', sort_order: null }), img({ id: 'img-a', sort_order: null })]
  const out = buildCurrentVersionArtwork(rows)
  assert(out[0].id === 'img-a' && out[1].id === 'img-z', 'expected a stable id tiebreak')
})

// ── Grid ──────────────────────────────────────────────────────────────────────

console.log('\nGrid columns')

test('one image fills the panel, a pair sits two up, a comparison set goes three', () => {
  assert(artworkGridColumns(0) === 1, '0 → 1')
  assert(artworkGridColumns(1) === 1, '1 → 1')
  assert(artworkGridColumns(2) === 2, '2 → 2')
  assert(artworkGridColumns(4) === 2, '4 → 2')
  assert(artworkGridColumns(6) === 3, '6 → 3')
  assert(artworkGridColumns(18) === 3, '18 → 3')
})

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
