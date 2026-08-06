// Unit tests for letterpress.ts
// Run with: npx tsx src/lib/letterpress.test.ts
//
// One job: keep the two letterpress-layer gates apart.
//
// They were a single set until 2026-08-06, and a single value could only
// ever be right for one of the two questions it was being asked:
//
//   "capture the colours?"  — both codes. The trio IS the paper stock the
//                             Stock Control job allocates against.
//   "show the customer the
//    layered cross-section?" — un-gilded only. Gilding covers the edge.
//
// It was set to un-gilded, so gilded versions stored null colours, and a
// gilded in-house order failed Confirm on `letterpress_colours_missing`
// with no way to fix it from the app (an approved proof locks version
// editing). Order 403976 needed a direct database update.
//
// The tests below are deliberately written as "these two must DISAGREE
// about gilded", because the failure mode isn't a wrong value — it's
// someone tidying two similar-looking sets back into one.

import { LAYER_COLOUR_MATERIAL_CODES, showsLayeredConstruction } from './letterpress.ts'

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

const PLAIN = 'paper_letterpress'
const GILDED = 'paper_letterpress_gilded'

// ── The capture gate: both letterpress codes ──────────────────────────

test('plain letterpress captures the layer colours', () => {
  assert(LAYER_COLOUR_MATERIAL_CODES.has(PLAIN), 'plain letterpress must show the pickers')
})

test('THE FIX: gilded letterpress captures the layer colours too', () => {
  // Removing this is what stranded order 403976 at Confirm. The hand-off
  // RPC requires the trio for BOTH codes (it builds the job's material
  // line from it), so a gilded version without colours is unplaceable.
  assert(LAYER_COLOUR_MATERIAL_CODES.has(GILDED), 'gilded letterpress must show the pickers')
})

test('no other material captures layer colours', () => {
  for (const code of ['metal_steel', 'paper_standard', 'wood', 'plastic_satin', 'acrylic']) {
    assert(!LAYER_COLOUR_MATERIAL_CODES.has(code), `${code} must not show the pickers`)
  }
})

// ── The customer-page gate: un-gilded only ────────────────────────────

test('plain letterpress shows the customer the cross-section', () => {
  assert(showsLayeredConstruction(PLAIN), 'plain letterpress must render the construction panel')
})

test('gilded letterpress does NOT show the customer the cross-section', () => {
  // The gilding covers the layered edge, so the panel would describe a
  // detail the customer's card doesn't have. This is the half that must
  // survive the capture gate widening.
  assert(!showsLayeredConstruction(GILDED), 'gilded letterpress must not render the construction panel')
})

test('non-letterpress materials show no cross-section', () => {
  for (const code of ['metal_steel', 'paper_standard', 'wood']) {
    assert(!showsLayeredConstruction(code), `${code} must not render the construction panel`)
  }
})

test('a version with no material at all is handled', () => {
  // Per-direction-pricing Selection rounds store no material_id
  // (000142 / 000144), so material_code is legitimately null.
  assert(!showsLayeredConstruction(null), 'null must not render the construction panel')
  assert(!showsLayeredConstruction(undefined), 'undefined must not render the construction panel')
  assert(!showsLayeredConstruction(''), 'empty string must not render the construction panel')
})

// ── The relationship between them ─────────────────────────────────────

test('THE INVARIANT: the two gates disagree about gilded letterpress', () => {
  // If this ever passes trivially because both sides say the same thing,
  // the split has been collapsed and one of the two jobs is now wrong.
  assert(
    LAYER_COLOUR_MATERIAL_CODES.has(GILDED) && !showsLayeredConstruction(GILDED),
    'gilded must be captured for production but hidden from the customer',
  )
})

test('showing construction implies capturing it', () => {
  // The panel can only render colours the form stored, so the display set
  // must stay a subset of the capture set — never the other way round.
  for (const code of [PLAIN, GILDED, 'metal_steel', 'wood', 'paper_standard']) {
    if (showsLayeredConstruction(code)) {
      assert(
        LAYER_COLOUR_MATERIAL_CODES.has(code),
        `${code} renders construction it never captures — it would always be blank`,
      )
    }
  }
})

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
