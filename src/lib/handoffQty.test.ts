// Tests for handoffQty.ts — reading the "Qty:" line back out of the editable
// hand-off message (the Thornton 403957 guard-rail).
//
// The cases that matter are the conservative refusals: the warning this
// helper feeds must only ever fire on a number it actually read, because a
// false alarm on a free-worded message teaches reviewers to ignore it.
//
// Run: npx tsx src/lib/handoffQty.test.ts

import { extractQtyLineValue } from './handoffQty.ts'

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

// The generated shapes: plain digits, no separators.
eq('plain generated line', extractQtyLineValue('Qty: 2200'), 2200)
eq('inside a full supplier email', extractQtyLineValue(
  'Hi,\n\nPlease produce the following order:\n\nQty: 1000\nMaterial: Standard cards\nMust ship by: 05 Aug 2026\n\nMany thanks.',
), 1000)

// The incident edit: the designer typed the number with a thousands comma.
eq('comma separator (the 403957 edit)', extractQtyLineValue('Qty: 2,200'), 2200)
eq('space separator', extractQtyLineValue('Qty: 2 200'), 2200)

// Formatting freedom the wording rules allow.
eq('lowercase + space before colon', extractQtyLineValue('qty : 500'), 500)
eq('indented line', extractQtyLineValue('  Qty: 500'), 500)
eq('trailing period from the legacy note sanitiser', extractQtyLineValue('Qty: 1000.'), 1000)
eq('trailing words ignored', extractQtyLineValue('Qty: 500 plus spares'), 500)

// First-wins, mirroring the retired parser: a later Qty line never overrides.
eq('first of two Qty lines wins', extractQtyLineValue('Qty: 1000\nNotes:\nQty: 2200'), 1000)
eq('unreadable first line stays null even with a readable second', extractQtyLineValue('Qty: TBC\nQty: 2200'), null)

// Conservative refusals — null, never a guess.
eq('no Qty line', extractQtyLineValue('Please pack in white boxes.'), null)
eq('empty message', extractQtyLineValue(''), null)
eq('value does not lead with a digit', extractQtyLineValue('Qty: approx 500'), null)
eq('blank value', extractQtyLineValue('Qty:'), null)
eq('"Supplier Qty:" is not a Qty line', extractQtyLineValue('Supplier Qty: 2200'), null)
eq('qty mentioned mid-sentence is not a Qty line', extractQtyLineValue('note: match the qty: 50 sample'), null)
eq('absurd digit run overflows to null, not Infinity', extractQtyLineValue(`Qty: ${'9'.repeat(400)}`), null)

console.log(`\nhandoffQty: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
