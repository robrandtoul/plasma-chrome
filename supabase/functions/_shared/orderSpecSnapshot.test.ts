// Unit tests for orderSpecSnapshot.ts (the durable order spec snapshot builder).
// Run with: npx tsx supabase/functions/_shared/orderSpecSnapshot.test.ts
//
// Covers the cases the parallel mapping flagged as easy to get wrong:
// finish-from-variant (metal Brushed/Mirror), custom-quote (null material),
// and letterpress with no layer colours (gilded / non-letterpress).

import {
  buildOrderSpecSnapshot,
  resolveFinishDisplay,
  type OrderSpecSnapshotInput,
} from './orderSpecSnapshot.ts'

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

const BASE: OrderSpecSnapshotInput = {
  materialCode: 'metal_steel',
  materialDisplay: 'Stainless Steel',
  variantDisplay: '300 micron',
  variantType: 'thickness',
  optionDisplay: null,
  inkNames: null,
  letterpressFront: null,
  letterpressCore: null,
  letterpressBack: null,
  quantity: 500,
  personQuantities: null,
  hasPersonalisation: false,
  customQuoteTotal: null,
  contactEmail: 'a@b.com',
  contactName: 'Anna Telford',
  companyName: 'Advanced Chiropractic',
  stage: 'create',
  capturedBy: 'user-1',
  capturedAt: '2026-06-24T00:00:00.000Z',
}

console.log('resolveFinishDisplay')
test('option wins when set', () => {
  assertEqual(resolveFinishDisplay('Brushed', 'finish', 'Mirror'), 'Brushed')
})
test('finish-dimension variant becomes the finish when no option', () => {
  assertEqual(resolveFinishDisplay(null, 'finish', 'Brushed'), 'Brushed')
})
test('thickness variant is NOT a finish', () => {
  assertEqual(resolveFinishDisplay(null, 'thickness', '300 micron'), null)
})

console.log('buildOrderSpecSnapshot')
test('standard order: material + variant, no finish', () => {
  const s = buildOrderSpecSnapshot(BASE)
  assertEqual(s.material, { code: 'metal_steel', display_name: 'Stainless Steel' })
  assertEqual(s.variant, { display_name: '300 micron' })
  assertEqual(s.finish, null)
  assertEqual(s.letterpress, null)
  assertEqual(s.custom_quote, false)
})

test('metal Brushed: finish resolves from the variant, not a material_option', () => {
  const s = buildOrderSpecSnapshot({
    ...BASE,
    variantDisplay: 'Brushed',
    variantType: 'finish',
    optionDisplay: null,
  })
  // The bug the mapping flagged: without finish-from-variant this would be null.
  assertEqual(s.finish, { display_name: 'Brushed' })
})

test('custom quote: null material/variant, custom_quote flag + total set', () => {
  const s = buildOrderSpecSnapshot({
    ...BASE,
    materialCode: null,
    materialDisplay: null,
    variantDisplay: null,
    variantType: null,
    customQuoteTotal: 1234.56,
  })
  assertEqual(s.material, null)
  assertEqual(s.variant, null)
  assertEqual(s.finish, null)
  assertEqual(s.custom_quote, true)
  assertEqual(s.custom_quote_total, 1234.56)
})

test('letterpress: three layer colours captured', () => {
  const s = buildOrderSpecSnapshot({
    ...BASE,
    materialCode: 'paper_letterpress',
    materialDisplay: 'Letterpress',
    variantType: 'default',
    variantDisplay: null,
    letterpressFront: 'Ebony',
    letterpressCore: 'Fuchsia',
    letterpressBack: 'Ebony',
  })
  assertEqual(s.letterpress, { front: 'Ebony', core: 'Fuchsia', back: 'Ebony' })
})

test('gilded / non-letterpress: no layer colours -> letterpress is null', () => {
  const s = buildOrderSpecSnapshot({
    ...BASE,
    materialCode: 'paper_letterpress_gilded',
    materialDisplay: 'Letterpress with gilding',
    letterpressFront: null,
    letterpressCore: null,
    letterpressBack: null,
  })
  assertEqual(s.letterpress, null)
})

test('ink names are trimmed + empties dropped; empty -> []', () => {
  assertEqual(buildOrderSpecSnapshot({ ...BASE, inkNames: ['  Gold ', '', '  ', 'Back: White'] }).ink_names, ['Gold', 'Back: White'])
  assertEqual(buildOrderSpecSnapshot({ ...BASE, inkNames: null }).ink_names, [])
})

test('person split passed through; empty array -> null', () => {
  const split = [{ name: 'Anna', quantity: 250 }, { name: 'Ben', quantity: 250 }]
  assertEqual(buildOrderSpecSnapshot({ ...BASE, personQuantities: split }).person_quantities, split)
  assertEqual(buildOrderSpecSnapshot({ ...BASE, personQuantities: [] }).person_quantities, null)
})

test('company null when no company name', () => {
  assertEqual(buildOrderSpecSnapshot({ ...BASE, companyName: null }).company, null)
  assertEqual(buildOrderSpecSnapshot(BASE).company, { name: 'Advanced Chiropractic' })
})

test('provenance carried through', () => {
  const s = buildOrderSpecSnapshot({ ...BASE, stage: 'place', capturedBy: 'user-9', capturedAt: '2026-07-01T12:00:00.000Z' })
  assertEqual(s.stage, 'place')
  assertEqual(s.captured_by, 'user-9')
  assertEqual(s.captured_at, '2026-07-01T12:00:00.000Z')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
