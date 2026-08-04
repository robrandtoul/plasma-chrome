// Reading the "Qty:" line back out of the editable hand-off message.
//
// Since Phase 3 the hand-off message is read by people, not machines, so the
// wording is deliberately free — but the Qty line still LOOKS authoritative,
// and on 2026-08-04 (Thornton, order 403957) it was edited from 1,000 to
// 2,200 in place of the Spoilage overs field: the supplier email said 2,200
// while the Stock Control job, handoff_payload and supplier_overs all
// recorded 1,000. This helper lets the review page notice that shape of edit
// and warn — never block — when the message's Qty disagrees with the real
// supplier quantity.
//
// Rules, all conservative, because a missed warning is just the old
// behaviour while a false alarm teaches people to ignore the notice:
// - Only a line STARTING "Qty:" counts (case-insensitive, optional space
//   before the colon) — never "Supplier Qty:" or a sentence mentioning qty.
// - The FIRST such line is the answer, mirroring the retired note parser's
//   first-wins rule; a later Qty line never overrides it.
// - The value must LEAD with a digit, with commas and spaces allowed as
//   thousands separators ("2,200", "2 200") and anything after the number
//   ignored ("1000." from the legacy note sanitiser, "500 plus spares").
//   "Qty: TBC" or "Qty: approx 500" return null — and null means "couldn't
//   read it", which the caller must treat as silence, never as a mismatch.
//
// Run the tests: pnpm test:handoff-qty (also swept up by pnpm test).

export function extractQtyLineValue(message: string): number | null {
  for (const line of message.split('\n')) {
    const m = /^\s*qty\s*:\s*(.*)$/i.exec(line)
    if (!m) continue
    const num = /^([0-9][0-9,\s]*)/.exec(m[1].trim())
    if (!num) return null
    const value = Number(num[1].replace(/[,\s]/g, ''))
    return Number.isFinite(value) ? value : null
  }
  return null
}
