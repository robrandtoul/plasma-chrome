// blanksSource.ts — pure rules for "base cards supplied under another order's
// batch" (combined supplier batches, migrations 000382/000383).
//
// The situation: two paid orders for the same base card (e.g. two practices of
// one umbrella company, plain black paper blanks foiled in-house). One combined
// supplier batch is much cheaper than two, so ONE order carries the whole batch
// via its Spoilage overs, and the other points here — it is then handed off as
// an IN-HOUSE job (the foiling) with a provenance line, and no supplier email
// is sent for it.
//
// PURE module: no imports, no Deno APIs — imported by the place-order edge
// function and by the tsx test (./blanksSource.test.ts, `pnpm test:blanks`).

export interface BlanksSourceOrder {
  id: string
  payment_reference: string | null
  stock_order_number: string | null
  project_name: string | null
  supplier_name: string | null
  quantity: number | null
  supplier_overs: number | null
  status: string
  material_id: string | null
  order_kind: string | null
  blanks_source_order_id: string | null
}

// The number of blanks the source order asked its supplier to make:
// its own customer quantity plus its spoilage overs (the padding that is
// carrying this order's cards).
export function blanksBatchQuantity(src: Pick<BlanksSourceOrder, 'quantity' | 'supplier_overs'>): number {
  const qty = Math.max(0, Math.floor(Number(src.quantity) || 0))
  const overs = Math.max(0, Math.floor(Number(src.supplier_overs) || 0))
  return qty + overs
}

// Spare blanks once BOTH orders take their paid quantity out of the batch.
// Negative means the batch cannot even cover the two customers' quantities
// before any spoilage — surfaced as a strong warning, never a block (the
// designer may be planning a top-up).
export function blanksSpareAfterBoth(
  src: Pick<BlanksSourceOrder, 'quantity' | 'supplier_overs'>,
  thisQty: number,
): number {
  const srcQty = Math.max(0, Math.floor(Number(src.quantity) || 0))
  return blanksBatchQuantity(src) - srcQty - Math.max(0, Math.floor(Number(thisQty) || 0))
}

// The handle a human recognises the source order by: the Stock Control job
// number first (what the workshop sees on the inbound delivery), the payment
// reference as fallback.
export function blanksSourceRef(src: Pick<BlanksSourceOrder, 'stock_order_number' | 'payment_reference'>): string {
  const stock = (src.stock_order_number ?? '').trim()
  if (stock) return stock
  return (src.payment_reference ?? '').trim() || 'unknown'
}

// Why this order can't take its blanks from `src` — or null when it can.
// Written as the sentence the review page shows the designer.
export function blanksSourceProblem(
  src: BlanksSourceOrder | null,
  ctx: { orderId: string; materialId: string | null },
): string | null {
  if (!src) return 'The order picked as the blanks source no longer exists.'
  if (src.id === ctx.orderId) return 'An order can’t supply its own blanks.'
  if (src.status !== 'fulfilled') {
    return 'The blanks-source order hasn’t been placed yet — place it (with the combined batch in its Spoilage overs) first.'
  }
  if ((src.order_kind ?? 'production') === 'prototype') {
    return 'A prototype run can’t supply blanks for a production order.'
  }
  if (!ctx.materialId || !src.material_id || src.material_id !== ctx.materialId) {
    return 'The blanks-source order is a different material — its blanks wouldn’t match this order’s cards.'
  }
  if (src.blanks_source_order_id != null) {
    return 'That order takes its own blanks from another order — pick the order that actually carries the supplier batch.'
  }
  return null
}

const fmt = (n: number): string => n.toLocaleString('en-GB')

// The provenance line: the ONE sentence that must reach the workshop, on both
// the Help Scout production note and the Stock Control job card (the job-card
// notes fold newlines to " / ", so this stays a single line).
export function composeBlanksProvenance(
  src: Pick<BlanksSourceOrder, 'stock_order_number' | 'payment_reference' | 'project_name' | 'supplier_name' | 'quantity' | 'supplier_overs'>,
  thisQty: number,
): string {
  const ref = blanksSourceRef(src)
  const label = (src.project_name ?? '').trim()
  const supplier = (src.supplier_name ?? '').trim() || 'the supplier'
  const batch = blanksBatchQuantity(src)
  return (
    `Base cards: no separate supplier order — this job’s ${fmt(Math.max(0, Math.floor(Number(thisQty) || 0)))} blanks ` +
    `come from the ${fmt(batch)}-card batch ordered from ${supplier} under order ${ref}` +
    (label ? ` (${label})` : '') +
    `. Do not order more blanks.`
  )
}
