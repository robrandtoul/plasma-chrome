// Tests for blanksSource.ts — the "base cards supplied under another order's
// batch" rules (combined supplier batches).
// Run with: npx tsx supabase/functions/_shared/blanksSource.test.ts
// (also swept up by `pnpm test`).

import {
  blanksBatchQuantity,
  blanksSourceProblem,
  blanksSourceRef,
  blanksSpareAfterBoth,
  composeBlanksProvenance,
  type BlanksSourceOrder,
} from './blanksSource.ts'

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

// The real case this feature was built for: Thornton carries the combined
// batch (1,000 own + 1,200 overs = 2,200 from Solopress); Apex points at it.
function thornton(): BlanksSourceOrder {
  return {
    id: 'src-1',
    payment_reference: 'ORD-ACFEE77DD5',
    stock_order_number: '403957',
    project_name: 'Thornton Dental & Implant Centre',
    supplier_name: 'Solopress',
    quantity: 1000,
    supplier_overs: 1200,
    status: 'fulfilled',
    material_id: 'mat-paper',
    order_kind: 'production',
    blanks_source_order_id: null,
  }
}
const APEX_CTX = { orderId: 'this-1', materialId: 'mat-paper' }

console.log('batch + spare maths')
test('batch = source quantity + overs', () => {
  assertEqual(blanksBatchQuantity(thornton()), 2200)
})
test('null/negative overs read as zero', () => {
  assertEqual(blanksBatchQuantity({ quantity: 1000, supplier_overs: null }), 1000)
  assertEqual(blanksBatchQuantity({ quantity: 1000, supplier_overs: -50 }), 1000)
})
test('spare after both = batch − both paid quantities', () => {
  assertEqual(blanksSpareAfterBoth(thornton(), 1000), 200)
})
test('a short batch goes negative (warning territory)', () => {
  assertEqual(blanksSpareAfterBoth({ quantity: 1000, supplier_overs: 500 }, 1000), -500)
})

console.log('source reference')
test('stock order number wins; payment reference is the fallback', () => {
  assertEqual(blanksSourceRef(thornton()), '403957')
  assertEqual(blanksSourceRef({ stock_order_number: null, payment_reference: 'ORD-XYZ' }), 'ORD-XYZ')
  assertEqual(blanksSourceRef({ stock_order_number: '  ', payment_reference: null }), 'unknown')
})

console.log('validation')
test('the Thornton→Apex shape is valid', () => {
  assertEqual(blanksSourceProblem(thornton(), APEX_CTX), null)
})
test('missing source is named', () => {
  assertEqual(blanksSourceProblem(null, APEX_CTX), 'The order picked as the blanks source no longer exists.')
})
test('an order cannot supply its own blanks', () => {
  const src = { ...thornton(), id: 'this-1' }
  assertEqual(blanksSourceProblem(src, APEX_CTX)?.includes('own blanks'), true)
})
test('an unplaced source is refused (the batch must exist first)', () => {
  const src = { ...thornton(), status: 'paid' }
  assertEqual(blanksSourceProblem(src, APEX_CTX)?.includes('hasn’t been placed yet'), true)
})
test('a prototype cannot supply a production order', () => {
  const src = { ...thornton(), order_kind: 'prototype' }
  assertEqual(blanksSourceProblem(src, APEX_CTX)?.includes('prototype'), true)
})
test('material mismatch is refused (blanks must match)', () => {
  const src = { ...thornton(), material_id: 'mat-metal' }
  assertEqual(blanksSourceProblem(src, APEX_CTX)?.includes('different material'), true)
})
test('an order with no recorded material cannot anchor the match', () => {
  assertEqual(blanksSourceProblem(thornton(), { orderId: 'this-1', materialId: null })?.includes('different material'), true)
})
test('chaining is refused — point at the batch carrier', () => {
  const src = { ...thornton(), blanks_source_order_id: 'other' }
  assertEqual(blanksSourceProblem(src, APEX_CTX)?.includes('actually carries'), true)
})
test('a legacy order_kind of null counts as production', () => {
  const src = { ...thornton(), order_kind: null }
  assertEqual(blanksSourceProblem(src, APEX_CTX), null)
})

console.log('provenance line')
test('golden provenance line (single line, both numbers, supplier + label)', () => {
  assertEqual(
    composeBlanksProvenance(thornton(), 1000),
    'Base cards: no separate supplier order — this job’s 1,000 blanks come from the 2,200-card batch ordered from Solopress under order 403957 (Thornton Dental & Implant Centre). Do not order more blanks.',
  )
})
test('no project name → no bracket; no supplier name → "the supplier"', () => {
  const line = composeBlanksProvenance({ ...thornton(), project_name: null, supplier_name: null }, 1000)
  assertEqual(line.includes('('), false)
  assertEqual(line.includes('from the supplier under order 403957'), true)
})
test('provenance stays one line (job-card notes fold newlines)', () => {
  assertEqual(composeBlanksProvenance(thornton(), 1000).includes('\n'), false)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
