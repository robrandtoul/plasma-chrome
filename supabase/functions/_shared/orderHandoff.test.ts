// Contract test for the direct order hand-off payload
// (docs/order-handoff-spec.md §3.2, payload_version 1).
// Run with: npx tsx supabase/functions/_shared/orderHandoff.test.ts
//
// The payload IS the contract between proof-viewer and Stock Control's
// create_order_handoff importer (migration 000333), so the two golden
// fixtures at the bottom pin it BYTE-FOR-BYTE: any reshaping of the payload —
// renamed key, reordered nesting, changed null convention — fails here and
// forces a deliberate payload_version decision instead of silent drift.

import { buildHandoffPayload, type HandoffPayloadInput } from './orderHandoff.ts'

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

// A plain steel in-house order — the base every variation below tweaks.
function baseInput(): HandoffPayloadInput {
  return {
    pvOrderId: '11111111-1111-1111-1111-111111111111',
    placedBy: '22222222-2222-2222-2222-222222222222',
    stockOrderNumber: '403900',
    route: 'in_house',
    customerName: 'Glosfume',
    projectName: 'Glosfume',
    helpscoutConversationId: '3341888858',
    qty: 100,
    supplierQty: 100,
    supplierOvers: 0,
    isPrototype: false,
    material: {
      pvMaterialId: '33333333-3333-3333-3333-333333333333',
      code: 'metal_steel',
      display: 'Stainless Steel',
      cardLine: 'Stainless Steel',
      letterpress: null,
    },
    supplier: null,
    dateRequired: '2026-08-01',
    inks: { front: 'White', back: null },
    packaging: 'Domestic',
    split: [],
    dropboxFolderUrl: 'https://www.dropbox.com/scl/fo/abc/h?rlkey=x&dl=0',
    note: null,
  }
}

console.log('field rules')
test('in-house forces supplier_qty = qty and supplier_overs = 0 even if passed', () => {
  const p = buildHandoffPayload({ ...baseInput(), supplierQty: 150, supplierOvers: 50 })
  assertEqual(p.supplier_qty, 100)
  assertEqual(p.supplier_overs, 0)
})
test('in-house nulls the supplier block even if one is passed', () => {
  const p = buildHandoffPayload({
    ...baseInput(),
    supplier: { supplierId: 'x', supplierName: 'QX Metals', productTypeName: 'Metal', specificType: null, thickness: null, finish: null, mustShipBy: null },
  })
  assertEqual(p.supplier, null)
})
test('stock_order_number is trimmed', () => {
  const p = buildHandoffPayload({ ...baseInput(), stockOrderNumber: '  403900  ' })
  assertEqual(p.stock_order_number, '403900')
})
test('prototype carries max_copies = qty; non-prototype is null', () => {
  assertEqual(buildHandoffPayload({ ...baseInput(), isPrototype: true, qty: 2, supplierQty: 2 }).prototype, { is_prototype: true, max_copies: 2 })
  assertEqual(buildHandoffPayload(baseInput()).prototype, null)
})
test('letterpress trio passes colour names RAW (default-suffix stripping is the resolver’s job)', () => {
  const p = buildHandoffPayload({
    ...baseInput(),
    material: {
      pvMaterialId: null,
      code: 'paper_letterpress_gilded',
      display: 'Letterpress with gilding',
      cardLine: 'Letterpress (Snow, Ebony, Snow) + gilding',
      letterpress: { front: 'Snow (default white)', core: 'Ebony (default black)', back: 'Snow (default white)', gilding: true },
    },
  })
  assertEqual((p.material as { letterpress: unknown }).letterpress, {
    front: 'Snow (default white)',
    core: 'Ebony (default black)',
    back: 'Snow (default white)',
    gilding: true,
  })
})
test('split entries keep name + qty shape', () => {
  const p = buildHandoffPayload({ ...baseInput(), split: [{ name: 'Joe Bloggs', qty: 60 }, { name: 'Jane Doe', qty: 40 }] })
  assertEqual(p.split, [{ name: 'Joe Bloggs', qty: 60 }, { name: 'Jane Doe', qty: 40 }])
})
test('supplier route keeps overs and the padded supplier_qty distinct from qty', () => {
  const p = buildHandoffPayload({
    ...baseInput(),
    route: 'supplier',
    supplierQty: 110,
    supplierOvers: 10,
    material: { pvMaterialId: '33333333-3333-3333-3333-333333333333', code: 'metal_steel', display: 'Stainless Steel', cardLine: null, letterpress: null },
    supplier: { supplierId: '44444444-4444-4444-4444-444444444444', supplierName: 'QX Metals', productTypeName: 'Metal', specificType: 'Stainless Steel', thickness: '500um', finish: 'Brushed', mustShipBy: '2026-07-25' },
  })
  assertEqual(p.qty, 100)
  assertEqual(p.supplier_qty, 110)
  assertEqual(p.supplier_overs, 10)
})
test('supplier route before a pick carries a null supplier_id (validation names it)', () => {
  const p = buildHandoffPayload({
    ...baseInput(),
    route: 'supplier',
    supplier: { supplierId: null, supplierName: null, productTypeName: 'Metal', specificType: null, thickness: null, finish: null, mustShipBy: '2026-07-25' },
  })
  assertEqual((p.supplier as { supplier_id: unknown }).supplier_id, null)
})

console.log('golden fixtures (byte-pin the contract)')
test('in-house golden payload (satin stock colour, split, note)', () => {
  const p = buildHandoffPayload({
    pvOrderId: '11111111-1111-1111-1111-111111111111',
    placedBy: '22222222-2222-2222-2222-222222222222',
    stockOrderNumber: '403901',
    route: 'in_house',
    customerName: 'Bloom Law',
    projectName: 'Bloom Law',
    helpscoutConversationId: '3348322774',
    qty: 100,
    supplierQty: 100,
    supplierOvers: 0,
    isPrototype: false,
    material: {
      pvMaterialId: '55555555-5555-5555-5555-555555555555',
      code: 'plastic_satin',
      display: 'Satin Plastic',
      cardLine: 'Satin Black Plastic',
      letterpress: null,
    },
    supplier: null,
    dateRequired: '2026-08-10',
    inks: { front: 'White', back: 'Silver' },
    packaging: 'International',
    split: [{ name: 'Ada', qty: 50 }, { name: 'Grace', qty: 50 }],
    dropboxFolderUrl: 'https://www.dropbox.com/scl/fo/xyz/h?rlkey=y&dl=0',
    note: 'Rounded corners please',
  })
  assertEqual(p, {
    payload_version: 1,
    pv_order_id: '11111111-1111-1111-1111-111111111111',
    placed_by: '22222222-2222-2222-2222-222222222222',
    stock_order_number: '403901',
    route: 'in_house',
    customer_name: 'Bloom Law',
    project_name: 'Bloom Law',
    helpscout_conversation_id: '3348322774',
    qty: 100,
    supplier_qty: 100,
    supplier_overs: 0,
    prototype: null,
    material: {
      pv_material_id: '55555555-5555-5555-5555-555555555555',
      code: 'plastic_satin',
      display: 'Satin Plastic',
      card_line: 'Satin Black Plastic',
      letterpress: null,
    },
    supplier: null,
    date_required: '2026-08-10',
    inks: { front: 'White', back: 'Silver' },
    packaging: 'International',
    split: [{ name: 'Ada', qty: 50 }, { name: 'Grace', qty: 50 }],
    artwork: { dropbox_url: 'https://www.dropbox.com/scl/fo/xyz/h?rlkey=y&dl=0' },
    note: 'Rounded corners please',
  })
})
test('supplier golden payload (prototype carbon fibre with overs)', () => {
  const p = buildHandoffPayload({
    pvOrderId: '11111111-1111-1111-1111-111111111111',
    placedBy: '22222222-2222-2222-2222-222222222222',
    stockOrderNumber: '403902',
    route: 'supplier',
    customerName: 'Copper-Bottomed Renovations LLC',
    projectName: null,
    helpscoutConversationId: null,
    qty: 2,
    supplierQty: 4,
    supplierOvers: 2,
    isPrototype: true,
    material: {
      pvMaterialId: '66666666-6666-6666-6666-666666666666',
      code: 'carbon_fibre',
      display: 'Carbon Fibre',
      cardLine: null,
      letterpress: null,
    },
    supplier: {
      supplierId: '44444444-4444-4444-4444-444444444444',
      supplierName: 'QX Metals',
      productTypeName: 'Carbon fibre',
      specificType: 'Carbon Fibre',
      thickness: '800um',
      finish: null,
      mustShipBy: '2026-07-28',
    },
    dateRequired: '2026-08-05',
    inks: { front: null, back: null },
    packaging: 'Domestic',
    split: [],
    dropboxFolderUrl: null,
    note: null,
  })
  assertEqual(p, {
    payload_version: 1,
    pv_order_id: '11111111-1111-1111-1111-111111111111',
    placed_by: '22222222-2222-2222-2222-222222222222',
    stock_order_number: '403902',
    route: 'supplier',
    customer_name: 'Copper-Bottomed Renovations LLC',
    project_name: null,
    helpscout_conversation_id: null,
    qty: 2,
    supplier_qty: 4,
    supplier_overs: 2,
    prototype: { is_prototype: true, max_copies: 2 },
    material: {
      pv_material_id: '66666666-6666-6666-6666-666666666666',
      code: 'carbon_fibre',
      display: 'Carbon Fibre',
      card_line: null,
      letterpress: null,
    },
    supplier: {
      supplier_id: '44444444-4444-4444-4444-444444444444',
      supplier_name: 'QX Metals',
      product_type_name: 'Carbon fibre',
      specific_type: 'Carbon Fibre',
      thickness: '800um',
      finish: null,
      must_ship_by: '2026-07-28',
    },
    date_required: '2026-08-05',
    inks: { front: null, back: null },
    packaging: 'Domestic',
    split: [],
    artwork: { dropbox_url: null },
    note: null,
  })
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
