// Tests for handoffChecks.ts — the problem/warning split on the place-order
// review page, now that a hand-off problem really does fail the placement.
//
// The cases that matter are the two that cost a designer a confused afternoon
// on order 403976: a problem must produce a block reason that quotes itself,
// and `supplier_missing` must NOT — it's the page's own unanswered question,
// not a Stock Control defect.
//
// Run: npx tsx src/lib/handoffChecks.test.ts

import {
  handoffBlockReason,
  handoffProblemHint,
  visibleHandoffProblems,
  type HandoffFinding,
} from './handoffChecks.ts'

let passed = 0
let failed = 0

function eq(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    console.log(`  ✓ ${name}`)
    passed++
  } else {
    console.log(`  ✗ ${name}`)
    console.log(`    expected ${e}, got ${a}`)
    failed++
  }
}

function ok(name: string, cond: boolean) {
  eq(name, cond, true)
}

const letterpress: HandoffFinding = {
  code: 'letterpress_colours_missing',
  message: 'A letterpress order needs its Front, Core and Back colours.',
}
const unmapped: HandoffFinding = {
  code: 'material_unmapped',
  message: '"Brushed Steel" doesn’t match any Stock Control material — set the mapping in Admin → Catalogue data → Stock materials.',
}
const supplierMissing: HandoffFinding = {
  code: 'supplier_missing',
  message: 'Choose a supplier to order from.',
}

// --- visibleHandoffProblems -------------------------------------------------

eq('a real problem is shown', visibleHandoffProblems([letterpress]), [letterpress])
eq('supplier_missing is hidden — the page owns that question', visibleHandoffProblems([supplierMissing]), [])
eq(
  'a real problem still shows alongside a hidden one',
  visibleHandoffProblems([supplierMissing, unmapped]),
  [unmapped],
)
eq('empty stays empty', visibleHandoffProblems([]), [])

// --- handoffBlockReason -----------------------------------------------------

// The tooltip must be self-contained: it's read with the pointer on the
// button, where "see the box above" is no help at all.
ok(
  'the block reason quotes the problem',
  (handoffBlockReason([letterpress]) ?? '').includes('Front, Core and Back colours'),
)
ok(
  'the block reason says who is refusing',
  (handoffBlockReason([letterpress]) ?? '').startsWith('Stock Control can’t accept this order yet'),
)
ok(
  'several problems name the first and count the rest',
  (handoffBlockReason([letterpress, unmapped]) ?? '').includes('(+1 more)'),
)
ok(
  'a single problem carries no count',
  !(handoffBlockReason([letterpress]) ?? '').includes('more)'),
)

// No visible problem → no block. This is what keeps a supplier-route preview
// from disabling Confirm for a reason the picker beside it already covers.
eq('no problems → no block reason', handoffBlockReason([]), null)
eq('only supplier_missing → no block reason', handoffBlockReason([supplierMissing]), null)

// --- handoffProblemHint -----------------------------------------------------

const hint = handoffProblemHint('letterpress_colours_missing') ?? ''
ok('letterpress points at the version form', hint.includes('Edit version'))
// The gilded caveat is the whole reason this hint is worth shipping: the
// pickers don't render for paper_letterpress_gilded, which is the material
// that triggered the incident.
ok('letterpress warns that gilded orders have no pickers', /gilded/i.test(hint))

eq('a problem whose message already names its fix gets no hint', handoffProblemHint('material_unmapped'), null)
eq('an unknown code gets no hint', handoffProblemHint('some_future_code'), null)

console.log(`\nhandoffChecks: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
