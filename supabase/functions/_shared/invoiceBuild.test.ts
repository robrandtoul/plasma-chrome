// Tests for invoiceBuild.ts — the custom-quote (agreed price) product line
// names the card count when the order carries a locked quantity
// ("Order ORD-XXXX — 250 cards"); older agreed-price orders with no quantity
// keep the bare "Order ORD-XXXX", prototypes keep their material label, and
// grid orders keep the count in the Qty column instead.
// Run with: npx tsx supabase/functions/_shared/invoiceBuild.test.ts
// (also swept up by `pnpm test`).

// invoiceBuild reads Deno.env inside its functions; under Node/tsx there is no
// Deno, so give it one that answers "unset" (the code's own fallbacks apply,
// e.g. tooling item '020'). Nothing in the module touches Deno at import time.
;(globalThis as { Deno?: unknown }).Deno ??= { env: { get: () => undefined } }

import {
  buildOrderGoodsLines,
  buildOrderInvoiceLines,
  type OrderForInvoice,
} from './invoiceBuild.ts'

let passed = 0
let failed = 0

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
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

// A variant-less agreed-price order resolves no item code and looks nothing
// up, so the client must never be touched — this proxy makes any access loud.
const noDb = new Proxy(
  {},
  {
    get(_target, prop) {
      throw new Error(`unexpected database access: ${String(prop)}`)
    },
  },
) as never

// Minimal chainable stand-in for the supabase-js client: every table resolves
// to one canned row (or null), whatever the select/eq chain.
function mockAdmin(rows: Record<string, Record<string, unknown> | null>) {
  const from = (table: string) => {
    const b = {
      select: () => b,
      eq: () => b,
      single: async () => ({ data: rows[table] ?? null }),
      maybeSingle: async () => ({ data: rows[table] ?? null }),
    }
    return b
  }
  return { from } as never
}

function agreedOrder(overrides: Partial<OrderForInvoice> = {}): OrderForInvoice {
  return {
    proof_id: null,
    material_variant_id: null,
    material_option_id: null,
    quantity: 250,
    names_count: 1,
    custom_quote_total: 480,
    amount_cards: null,
    amount_tooling: null,
    amount_personalisation: null,
    amount_shipping: null,
    amount_us_tariff: null,
    amount_card_discount: null,
    order_kind: 'production',
    ...overrides,
  }
}

console.log('agreed price (custom quote) product line')
await test('names the card count when the order has a locked quantity', async () => {
  const { lines } = await buildOrderGoodsLines(noDb, agreedOrder(), 'ORD-TEST1234')
  assertEqual(lines.length, 1)
  assertEqual(lines[0].description, 'Order ORD-TEST1234 — 250 cards')
  assertEqual(lines[0].amount, 480)
  // The count stays OUT of the Qty column — Xero would derive a per-unit
  // price from it, and an agreed lump sum has no honest per-unit figure.
  assertEqual(lines[0].quantity ?? null, null)
})
await test('thousands read with commas, en-GB style', async () => {
  const { lines } = await buildOrderGoodsLines(
    noDb,
    agreedOrder({ quantity: 1000, custom_quote_total: 1200 }),
    'ORD-TEST1234',
  )
  assertEqual(lines[0].description, 'Order ORD-TEST1234 — 1,000 cards')
})
await test('a single card reads "1 card"', async () => {
  const { lines } = await buildOrderGoodsLines(noDb, agreedOrder({ quantity: 1 }), 'ORD-TEST1234')
  assertEqual(lines[0].description, 'Order ORD-TEST1234 — 1 card')
})
await test('an older agreed-price order with no quantity keeps the bare label', async () => {
  const { lines } = await buildOrderGoodsLines(noDb, agreedOrder({ quantity: null }), 'ORD-TEST1234')
  assertEqual(lines[0].description, 'Order ORD-TEST1234')
})
await test('the designer discount line still follows the product line', async () => {
  const { lines } = await buildOrderGoodsLines(
    noDb,
    agreedOrder({ amount_card_discount: 50 }),
    'ORD-TEST1234',
  )
  assertEqual(
    lines.map((l) => l.description),
    ['Order ORD-TEST1234 — 250 cards', 'Discount'],
  )
  assertEqual(lines[1].amount, -50)
})

console.log('prototype branch untouched')
await test('a prototype still describes its material, never the card count', async () => {
  const admin = mockAdmin({
    material_variants: {
      xero_item_code: '0101',
      display_name: '500µm',
      material_id: 'mat-steel',
      materials: { display_name: 'Stainless Steel' },
    },
  })
  const { lines, productItemCode } = await buildOrderGoodsLines(
    admin,
    agreedOrder({ order_kind: 'prototype', material_variant_id: 'var-1', quantity: 25 }),
    'ORD-TEST1234',
  )
  assertEqual(lines[0].description, 'Stainless Steel 500µm — prototype sample')
  assertEqual(productItemCode, '0101')
})

console.log('grid orders unchanged')
await test('a grid order keeps the count in the Qty column, not the description', async () => {
  const { lines } = await buildOrderGoodsLines(
    noDb,
    agreedOrder({ custom_quote_total: null, amount_cards: 480 }),
    'ORD-TEST1234',
  )
  assertEqual(lines[0].description, 'Cards')
  assertEqual(lines[0].quantity, 250)
})

console.log('full invoice build (single order)')
await test('itemised lines survive the sum check with the new description', async () => {
  const { lines, domestic } = await buildOrderInvoiceLines(noDb, agreedOrder(), {
    reference: 'ORD-TEST1234',
    currency: 'GBP',
    expectedTotal: 480,
    country: 'GB',
  })
  assertEqual(domestic, true)
  assertEqual(lines.length, 1)
  assertEqual(lines[0].description, 'Order ORD-TEST1234 — 250 cards')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
