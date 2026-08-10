// Tests for the finish parser.
//
// Run: node scripts/reorder-register/finishParse.test.mjs
//
// The parser's whole job is to REFUSE more often than it answers, because its
// output lands on a customer's own proof page badging a price column as "your
// last order". So most of what follows asserts a null, and each one names the
// real invoice or real material that would otherwise have produced a wrong
// answer. A test that only proved the happy path would be worse than none.

import { parseFinish, parseWoodSpecies, isProductLine } from './finishParse.mjs'

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (err) {
    console.log(`  ✗ ${name}`)
    console.log(`    ${err.message}`)
    failed++
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

// Real catalogue shapes (ids abbreviated).
const STEEL = [
  { id: 'st-nat', code: 'natural', display_name: 'Natural' },
  { id: 'st-bru', code: 'brushed', display_name: 'Brushed' },
  { id: 'st-mir', code: 'mirror', display_name: 'Mirror' },
]
const FCP = [
  { id: 'fcp-gloss', code: 'gloss', display_name: 'Gloss' },
  { id: 'fcp-matte', code: 'matte', display_name: 'Matte' },
]
const WOOD = [
  { id: 'w-bw', code: 'black_walnut', display_name: 'Black Walnut' },
  { id: 'w-ac', code: 'american_cherry', display_name: 'American Cherry' },
  { id: 'w-fb', code: 'finnish_birch', display_name: 'Finnish Birch' },
  { id: 'w-cm', code: 'canadian_maple', display_name: 'Canadian Maple' },
  { id: 'w-bam', code: 'bamboo', display_name: 'Bamboo' },
  { id: 'w-eo', code: 'english_oak', display_name: 'English Oak' },
]

const steel = (description, extra = {}) =>
  parseFinish({ description, materialCode: 'metal_steel', options: STEEL, ...extra })

console.log('\nwhat it accepts')

test('the hand-keyed "<option> finish" forms all observed on real invoices', () => {
  for (const [desc, want] of [
    ['Stainless steel business cards (500 micron with brushed finish)', 'st-bru'],
    ['Steel cards - Natural finish', 'st-nat'],
    ['Stainless steel cards\nMirror Finish', 'st-mir'],
    ['Stainless steel cards (800 micron - natural finish)', 'st-nat'],
  ]) {
    const r = steel(desc)
    assert(r.option?.id === want, `"${desc}" → ${r.option?.id ?? r.reason}, wanted ${want}`)
  }
})

test('the app-era "— <display name>" suffix', () => {
  const r = steel('Stainless Steel 800 micron — Natural')
  assert(r.option?.id === 'st-nat', `got ${r.option?.id ?? r.reason}`)
})

test('the two permitted synonyms, and only those', () => {
  const fcp = (d) => parseFinish({ description: d, materialCode: 'plastic_full_colour', options: FCP })
  assert(fcp('Full colour plastic (760 micron with glossy finish)').option?.id === 'fcp-gloss', 'glossy')
  assert(fcp('Full colour plastic (760 micron - matt finish)').option?.id === 'fcp-matte', 'matt')
  // "shiny" is not a synonym we accept, and inventing more is how a parser
  // starts reading words that meant something else.
  assert(fcp('Full colour plastic with shiny finish').option === null, 'shiny must not match')
})

console.log('\nwhat it refuses — each of these would otherwise be a wrong answer')

test('⚠ silence is never the base option, however common that finish is', () => {
  // Natural is the commonest steel finish by far, which is exactly why
  // defaulting to it is wrong: the unnamed lines are the ones it gets wrong.
  const r = steel('Stainless steel business cards (500 micron)')
  assert(r.option === null, `got ${r.option?.display_name}`)
  assert(r.reason === 'not_named', r.reason)
})

test('⚠ a material with no choice yields nothing, even when the text says "matte"', () => {
  // Matte Black Metal is a MATERIAL. An unscoped search for /matt/ reads the
  // material's own name as a finish; the structural guard is that we only ever
  // match a material's own options, and this one has none.
  const r = parseFinish({
    description: 'Matte black metal business cards (500 micron)',
    materialCode: 'metal_matte_black',
    options: [],
  })
  assert(r.option === null && r.reason === 'material_has_no_options', r.reason)
})

test('⚠ the prototype marker is not a finish', () => {
  // invoiceBuild.ts uses the same em-dash separator for prototypes as for the
  // finish, and such an invoice already exists on live.
  const r = steel('Stainless Steel 300 micron — prototype sample')
  assert(r.option === null && r.reason === 'prototype_sample', r.reason)
})

test('⚠ a thickness contradiction voids the line (INV-23471)', () => {
  const r = steel('Stainless steel cards (1500 micron with mirror finish)', { itemMicrons: 800 })
  assert(r.option === null && r.reason === 'thickness_contradiction', r.reason)
})

test('⚠ a material contradiction voids the line (INV-25013: copper on a gun-metal item)', () => {
  const r = parseFinish({
    description: 'Copper cards (500 micron with brushed finish)',
    itemName: 'Gun metal cards (500 micron)',
    materialCode: 'metal_gun_metal',
    options: STEEL, // pretend it had options; the contradiction must win anyway
  })
  assert(r.option === null && r.reason.startsWith('material_contradiction'), r.reason)
})

test('⚠ two materials in one line voids it (INV-23456)', () => {
  const r = parseFinish({
    description: 'Gold metal cards (800 micron with mirror finish) / 50 in traditional gold / 50 in rose gold',
    itemName: 'Gold metal cards (800 micron)',
    materialCode: 'metal_gold',
    options: STEEL,
  })
  // Refusal is the property that matters; WHICH guard catches it is not. Since
  // the contradiction list was narrowed against real data, "rose gold" on a
  // "Gold metal cards" item now trips the stray-material check first, and the
  // dedicated two-materials rule became belt-and-braces. Both are refusals.
  assert(r.option === null, `expected a refusal, got ${r.option?.display_name}`)
  assert(
    r.reason === 'two_materials_in_one_line' || r.reason.startsWith('material_contradiction'),
    r.reason,
  )
})

test('⚠ two options named — never rank, never take the first', () => {
  const r = steel('Stainless steel cards, 50 with mirror finish and 50 with brushed finish')
  assert(r.option === null && r.reason === 'two_options_named', r.reason)
})

test('a matching thickness is not a contradiction', () => {
  const r = steel('Stainless steel cards (800 micron with mirror finish)', { itemMicrons: 800 })
  assert(r.option?.id === 'st-mir', `got ${r.option?.id ?? r.reason}`)
})

test('"rose gold" on a rose gold item is not a stray material', () => {
  const r = parseFinish({
    description: 'Rose gold metal cards (500 micron with brushed finish)',
    itemName: 'Rose gold metal cards (500 micron)',
    materialCode: 'metal_rose_gold',
    options: STEEL,
  })
  assert(r.option?.id === 'st-bru', `got ${r.option?.id ?? r.reason}`)
})

console.log('\ntuning — the false refusals found in the 637-row shadow run')

test('⚠ an infill or plating colour is not a material (13 real rows)', () => {
  // These all name their finish explicitly and were being thrown away because
  // "matt black" was read as Matte Black Metal.
  for (const [desc, want] of [
    ['Gold metal business cards (500 micron) with matt black polymer infill (NATURAL FINISH)', 'Natural'],
    ['Gold metal business cards (500 micron) with matt black polymer infill (BRUSHED FINISH)', 'Brushed'],
    ['Gold metal cards with matte black plating (800 micron) - Natural finish', 'Natural'],
    ['Gold metal cards (800 micron with natural finish and matte black polymer)', 'Natural'],
  ]) {
    const r = parseFinish({
      description: desc,
      itemName: 'Gold metal cards (500 micron)',
      materialCode: 'metal_gold',
      options: STEEL, // same three names as gold's own options
    })
    assert(r.option?.display_name === want, `"${desc.slice(0, 50)}…" → ${r.option?.display_name ?? r.reason}`)
  }
})

test('⚠ foiling is not a material (real full-colour-plastic rows)', () => {
  const r = parseFinish({
    description: 'Full colour plastic cards (760 micron) - GLOSS - metallic gold foiling',
    itemName: 'Full colour plastic cards (760 micron)',
    itemMicrons: 760,
    materialCode: 'plastic_full_colour',
    options: FCP,
  })
  // "GLOSS" here is a bare word, not "gloss finish" — so it is correctly NOT
  // matched. What matters is that the gold foiling no longer voids the line.
  assert(r.reason !== 'material_contradiction:gold', r.reason)
})

test('a genuine material contradiction still refuses', () => {
  // "Gold metal business cards" on a STAINLESS STEEL item — the item and the
  // description disagree about what was sold, and we do not get to pick.
  const r = parseFinish({
    description: 'Gold metal business cards (800 micron with mirror finish and printed numbering)',
    itemName: 'Stainless steel cards (800 micron)',
    materialCode: 'metal_steel',
    options: STEEL,
  })
  assert(r.option === null && r.reason.startsWith('material_contradiction'), r.reason)
})

test('a gun-metal description on a gold item still refuses', () => {
  const r = parseFinish({
    description: 'Gun metal business cards (500 micron) - brushed finish - 25 per person',
    itemName: 'Gold metal cards (500 micron)',
    materialCode: 'metal_gold',
    options: STEEL,
  })
  assert(r.option === null && r.reason.startsWith('material_contradiction'), r.reason)
})

test('a copper description on a rose gold item still refuses', () => {
  // Either the item code or the description is wrong. Copper has no finish
  // options at all, so guessing here would invent a dimension.
  const r = parseFinish({
    description: 'Copper metal business cards (500 micron - brushed) with black polymer infill',
    itemName: 'Rose gold metal cards (500 micron)',
    materialCode: 'metal_rose_gold',
    options: STEEL,
  })
  assert(r.option === null && r.reason.startsWith('material_contradiction'), r.reason)
})

test('⚠ "Mini" on a full-size item refuses — Mini Steel has no finishes at all', () => {
  // Found by the 20-row hand check, not by reasoning about the data. Real
  // strings, real invoices.
  for (const desc of [
    'Mini Stainless steel business cards (500 micron)\n\nBrushed Finish/ Black Polymer',
    'Mini Stainless steel business cards (500 micron - 65mm x 35mm) - MIRROR FINISH',
    'Mini Stainless steel business cards (300 micron) - Natural finish',
  ]) {
    const r = parseFinish({
      description: desc,
      itemName: 'Stainless steel cards (500 micron)',
      materialCode: 'metal_steel',
      options: STEEL,
    })
    assert(r.option === null && r.reason === 'mini_variant_contradiction', `${desc.slice(0, 40)} → ${r.reason}`)
  }
  // …but a genuinely mini item is not contradicted by its own description.
  const ok = parseFinish({
    description: 'Mini steel cards (300 micron with brushed finish)',
    itemName: 'Mini steel cards (300 micron)',
    materialCode: 'metal_mini_steel',
    options: STEEL,
  })
  assert(ok.option?.display_name === 'Brushed', ok.reason)
})

console.log('\nwood — the species is in the item name, so no description is needed')

test('the six species, including the ones the invoice abbreviates', () => {
  for (const [spec, want] of [
    ['100 wood cards (3mm thick) - Bamboo', 'w-bam'],
    ['50 wood cards (3mm thick) - Black walnut', 'w-bw'],
    ['50 wood cards (3mm thick) - American cherry', 'w-ac'],
    ['100 wood cards (3mm thick) - Maple', 'w-cm'],
    ['50 wood cards (3mm thick) - Finnish birch', 'w-fb'],
  ]) {
    const r = parseWoodSpecies(spec, WOOD)
    assert(r.option?.id === want, `"${spec}" → ${r.option?.id ?? r.reason}, wanted ${want}`)
  }
})

test('⚠ "Mixed" is an order of several species, not a species', () => {
  const r = parseWoodSpecies('50 wood cards (3mm thick) - Mixed', WOOD)
  assert(r.option === null && r.reason === 'mixed_species', r.reason)
})

test('a spec with no species suffix yields nothing', () => {
  const r = parseWoodSpecies('50 wood cards (3mm thick)', WOOD)
  assert(r.option === null, `got ${r.option?.display_name}`)
})

console.log('\nthe product-line filter — it decides who is eligible at all')

test('services and the summary-line fallback are not products', () => {
  assert(isProductLine({ item_code: '0144' }), 'a card is')
  for (const code of ['020', '050', '052', '910']) {
    assert(!isProductLine({ item_code: code }), `${code} is not`)
  }
  // "Order ORD-…" — what Xero gets when it rejects the itemised codes.
  assert(!isProductLine({ item_code: null }), 'a line with no item is not')
  assert(!isProductLine({ item_code: '' }), 'an empty code is not')
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
