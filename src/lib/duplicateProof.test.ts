// Unit tests for the pure mappers behind duplicateProof.ts
// Run with: npx tsx src/lib/duplicateProof.test.ts
//
// The orchestration itself is exercised against the live app; these tests
// pin the field-mapping invariants where a silent bug would live — a QR
// column dropped in the copy, a stale change-note carried onto v1, or a
// round-variant/layout id left pointing at the SOURCE version's children.

import {
  duplicateImagePath,
  duplicateVersionInsert,
  duplicateImageInsert,
  type SourceVersion,
  type SourceImage,
} from './duplicateProofMapping.ts'

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

function assertEqual<T>(actual: T, expected: T, label = '') {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`${label} expected ${e}, got ${a}`)
}

// ── duplicateImagePath ─────────────────────────────────────────────────────

test('keeps the source extension (jpg artwork)', () => {
  assertEqual(duplicateImagePath('new-proof', 'old-proof/abc.jpg', 'u1'), 'new-proof/u1.jpg')
})

test('keeps png (scanner-found QR) and svg (hosted-vCard QR)', () => {
  assertEqual(duplicateImagePath('np', 'op/qr.png', 'u2'), 'np/u2.png')
  assertEqual(duplicateImagePath('np', 'op/vcard.SVG', 'u3'), 'np/u3.svg')
})

test('falls back to jpg when the source path has no extension', () => {
  assertEqual(duplicateImagePath('np', 'op/legacy-file', 'u4'), 'np/u4.jpg')
})

// ── duplicateVersionInsert ─────────────────────────────────────────────────

const baseVersion: SourceVersion = {
  id: 'v-src',
  material_id: 'mat-1',
  material_display: 'Stainless Steel',
  ink_names: ['Black', 'Red'],
  currency: 'GBP',
  displayed_variant_ids: ['var-1'],
  material_options: ['brushed'],
  custom_quote: true,
  names: ['Valentina Ring'],
  card_type: 'business',
  shape: 'recipients',
  is_variant_round: false,
  is_per_direction_pricing: false,
  has_personalisation: false,
  team_sharing_enabled: true,
  front_colour_id: null,
  core_colour_id: null,
  back_colour_id: null,
  shipping_note: 'Ships worldwide',
}

test('copies the design fields verbatim onto the new proof', () => {
  const row = duplicateVersionInsert(baseVersion, 'p-new')
  assertEqual(row.proof_id, 'p-new')
  assertEqual(row.material_id, 'mat-1')
  assertEqual(row.material_display, 'Stainless Steel')
  assertEqual(row.ink_names, ['Black', 'Red'])
  assertEqual(row.currency, 'GBP')
  assertEqual(row.material_options, ['brushed'])
  assertEqual(row.custom_quote, true)
  assertEqual(row.names, ['Valentina Ring'])
  assertEqual(row.card_type, 'business')
  assertEqual(row.shape, 'recipients')
  assertEqual(row.team_sharing_enabled, true)
  assertEqual(row.shipping_note, 'Ships worldwide')
})

test('records clone lineage and drops the change notes', () => {
  const row = duplicateVersionInsert(baseVersion, 'p-new')
  assertEqual(row.cloned_from_version_id, 'v-src')
  assertEqual(row.change_notes, null)
})

test('null-tolerant on legacy array columns', () => {
  const row = duplicateVersionInsert(
    { ...baseVersion, ink_names: null, names: null, material_options: null, displayed_variant_ids: null },
    'p-new',
  )
  assertEqual(row.ink_names, [])
  assertEqual(row.names, [])
  assertEqual(row.material_options, [])
  assertEqual(row.displayed_variant_ids, [])
})

test('per-direction selection copies with null material and currency', () => {
  const row = duplicateVersionInsert(
    {
      ...baseVersion,
      material_id: null,
      currency: null,
      material_display: 'Per-direction pricing',
      is_variant_round: true,
      is_per_direction_pricing: true,
      shape: 'selection',
    },
    'p-new',
  )
  assertEqual(row.material_id, null)
  assertEqual(row.currency, null)
  assertEqual(row.is_variant_round, true)
  assertEqual(row.is_per_direction_pricing, true)
})

// ── duplicateImageInsert ───────────────────────────────────────────────────

const baseImage: SourceImage = {
  image_path: 'p-old/img.jpg',
  sort_order: 3,
  material_option: 'brushed',
  original_filename: 'front.jpg',
  associated_name: 'Valentina Ring',
  side: 'back',
  round_variant_id: null,
  layout_id: null,
  is_qr_code: false,
  qr_decoded_data: null,
  qr_kind: null,
  qr_vcard_slug: null,
}

test('copies slot fields and stamps the new path + version', () => {
  const row = duplicateImageInsert(baseImage, 'v-new', 'p-new/u.jpg', new Map(), new Map())
  assertEqual(row.proof_version_id, 'v-new')
  assertEqual(row.image_path, 'p-new/u.jpg')
  assertEqual(row.sort_order, 3)
  assertEqual(row.material_option, 'brushed')
  assertEqual(row.original_filename, 'front.jpg')
  assertEqual(row.associated_name, 'Valentina Ring')
  assertEqual(row.side, 'back')
})

test('normalises a legacy null side to front', () => {
  const row = duplicateImageInsert({ ...baseImage, side: null }, 'v', 'p/u.jpg', new Map(), new Map())
  assertEqual(row.side, 'front')
})

test('carries the full QR column set together (000168/000192 CHECK)', () => {
  const row = duplicateImageInsert(
    {
      ...baseImage,
      is_qr_code: true,
      qr_decoded_data: 'https://qcrd.uk/7k2nq8x',
      qr_kind: 'hosted_vcard',
      qr_vcard_slug: '7k2nq8x',
    },
    'v',
    'p/u.svg',
    new Map(),
    new Map(),
  )
  assertEqual(row.is_qr_code, true)
  assertEqual(row.qr_decoded_data, 'https://qcrd.uk/7k2nq8x')
  assertEqual(row.qr_kind, 'hosted_vcard')
  assertEqual(row.qr_vcard_slug, '7k2nq8x')
})

test('remaps round_variant_id and layout_id through the new children', () => {
  const row = duplicateImageInsert(
    { ...baseImage, round_variant_id: 'rv-old', layout_id: 'lay-old' },
    'v',
    'p/u.jpg',
    new Map([['rv-old', 'rv-new']]),
    new Map([['lay-old', 'lay-new']]),
  )
  assertEqual(row.round_variant_id, 'rv-new')
  assertEqual(row.layout_id, 'lay-new')
})

test('an unknown child id degrades to null, never a dangling reference', () => {
  const row = duplicateImageInsert(
    { ...baseImage, round_variant_id: 'rv-mystery', layout_id: 'lay-mystery' },
    'v',
    'p/u.jpg',
    new Map(),
    new Map(),
  )
  assertEqual(row.round_variant_id, null)
  assertEqual(row.layout_id, null)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
