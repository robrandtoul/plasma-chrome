// Unit tests for matchMaterial.ts
// Run with: npx tsx src/lib/matchMaterial.test.ts
//
// The fixture is the real published material catalogue, and every case is an
// actual direction label taken from live per-direction-pricing variant rounds
// (plus a few constructed edge cases). The key property under test is
// "conservative": ambiguous labels must return null, never a wrong guess.

import { matchMaterialByLabel, tokeniseLabel } from './matchMaterial'
import type { MaterialLike } from './matchMaterial'

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

// The 18 published materials the new-version picker offers (Titanium is
// unpublished, so it is deliberately absent — a "Titanium" label must
// therefore return null because the material isn't selectable).
const CATALOGUE: MaterialLike[] = [
  { id: 'm-acrylic',        code: 'acrylic',                  display_name: 'Acrylic (Perspex)' },
  { id: 'm-carbon',         code: 'carbon_fibre',             display_name: 'Carbon Fibre' },
  { id: 'm-carbon-cnc',     code: 'carbon_fibre_cnc',         display_name: 'Carbon Fibre with CNC' },
  { id: 'm-copper',         code: 'metal_copper',             display_name: 'Copper Metal' },
  { id: 'm-gold',           code: 'metal_gold',               display_name: 'Gold Metal' },
  { id: 'm-gun',            code: 'metal_gun_metal',          display_name: 'Gun Metal' },
  { id: 'm-matte-black',    code: 'metal_matte_black',        display_name: 'Matte Black Metal' },
  { id: 'm-matte-white',    code: 'metal_matte_white',        display_name: 'Matte White Metal' },
  { id: 'm-mini-steel',     code: 'metal_mini_steel',         display_name: 'Mini Stainless Steel' },
  { id: 'm-steel',          code: 'metal_steel',              display_name: 'Stainless Steel' },
  { id: 'm-letterpress',    code: 'paper_letterpress',        display_name: 'Letterpress' },
  { id: 'm-letterpress-g',  code: 'paper_letterpress_gilded', display_name: 'Letterpress with Gilding' },
  { id: 'm-standard',       code: 'paper_standard',           display_name: 'Standard Paper' },
  { id: 'm-full-colour',    code: 'plastic_full_colour',      display_name: 'Full Colour Plastic' },
  { id: 'm-satin',          code: 'plastic_satin',            display_name: 'Satin Plastic' },
  { id: 'm-tinted',         code: 'plastic_tinted',           display_name: 'Tinted Translucent Plastic' },
  { id: 'm-translucent',    code: 'plastic_translucent',      display_name: 'Translucent Plastic' },
  { id: 'm-wood',           code: 'wood',                     display_name: 'Wood' },
]

function matchCode(label: string): string | null {
  return matchMaterialByLabel(label, CATALOGUE)?.code ?? null
}

// ── Real live direction labels (code expected, or null when ambiguous) ────────

const REAL_LABELS: Array<[string, string | null]> = [
  ['900gsm Letterpress with a textured surface.', 'paper_letterpress'],
  ['Letterpress',                                 'paper_letterpress'],
  ['400gsm Matte Laminated Paper',                null],  // no distinctive paper word -> designer picks
  ['Carbon Fibre',                                'carbon_fibre'],
  ['Gun Metal',                                   'metal_gun_metal'],
  ['Matte Black Metal',                           'metal_matte_black'],
  ['Black Metal',                                 null],  // "black" without "matte" is ambiguous
  ['Black Steel',                                 'metal_steel'],
  ['Brushed Steel',                               'metal_steel'],
  ['Mirror Steel',                                'metal_steel'],
  ['Silver Steel',                                'metal_steel'],
  ['Natural (Matte) Steel',                       'metal_steel'],
  ['Stainless Steel',                             'metal_steel'],
  ['Stainless Steel with Infill',                 'metal_steel'],
  ['Copper Steel',                                'metal_steel'],  // "X Steel" = steel in a copper finish
  ['Gold Steel',                                  'metal_steel'],  // "X Steel" = steel in a gold finish
  ['Acid Green Plastic',                          null],  // no distinctive plastic word
  ['Satin White Plastic',                         'plastic_satin'],
  ['Translucent Plastic',                         'plastic_translucent'],
  ['Frosted Translucent Plastic',                 'plastic_translucent'],
  ['Wood',                                        'wood'],
  ['Wood (Bamboo)',                               'wood'],
]

test('real live direction labels resolve conservatively', () => {
  for (const [label, expected] of REAL_LABELS) {
    assertEqual(matchCode(label), expected, `"${label}" -> ${expected}`)
  }
})

// ── Constructed edge cases ────────────────────────────────────────────────────

test('base vs richer sibling are kept apart', () => {
  assertEqual(matchCode('Carbon Fibre with CNC'), 'carbon_fibre_cnc')
  assertEqual(matchCode('Letterpress with Gilding'), 'paper_letterpress_gilded')
  assertEqual(matchCode('Tinted Translucent Plastic'), 'plastic_tinted')
  assertEqual(matchCode('Mini Stainless Steel'), 'metal_mini_steel')
})

test('the matte colour metals need both words', () => {
  assertEqual(matchCode('Matte White Metal'), 'metal_matte_white')
  assertEqual(matchCode('Matte'), null)            // no colour -> ambiguous
  assertEqual(matchCode('White Metal'), null)      // no "matte" -> ambiguous
})

test('colour metals yield to steel, but cross-family clashes stay null', () => {
  // "X Steel" reads as steel in an X finish, so steel wins over a colour metal.
  assertEqual(matchCode('Copper Steel'), 'metal_steel')
  assertEqual(matchCode('Gold Steel'), 'metal_steel')
  // But the colour metals still match on their own (no "steel" in the label).
  assertEqual(matchCode('Copper Metal'), 'metal_copper')
  assertEqual(matchCode('Gold Metal'), 'metal_gold')
  // A genuine two-family clash has no head metal and stays ambiguous.
  assertEqual(matchCode('Wood Steel'), null)
})

test('full colour plastic, acrylic and standard paper', () => {
  assertEqual(matchCode('Full Colour Plastic'), 'plastic_full_colour')
  assertEqual(matchCode('Acrylic (Perspex)'), 'acrylic')
  assertEqual(matchCode('Standard Paper'), 'paper_standard')
})

test('unpublished / unknown materials and empty input return null', () => {
  assertEqual(matchCode('Titanium'), null)         // not in the picker catalogue
  assertEqual(matchCode('Brushed Aluminium'), null)
  assertEqual(matchCode(''), null)
  assertEqual(matchCode('   '), null)
})

test('tokeniser strips digits and punctuation', () => {
  assertEqual([...tokeniseLabel('900gsm Letterpress, textured.')].includes('letterpress'), true)
  assertEqual([...tokeniseLabel('Wood (Bamboo)')].sort().join(','), 'bamboo,wood')
})

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
