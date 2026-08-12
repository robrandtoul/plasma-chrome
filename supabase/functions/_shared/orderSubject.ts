// The Help Scout subject a placed order's customer thread is renamed to, so the
// conversation, the Dropbox order folder and the Stock Control job number all
// read the same: "Order 402910 - Capital Piling".
//
// ⚠ WHY THIS IS SHARED. place-order computed this twice, differently, and only
// one of them was right:
//
//   in-house  `Order <no> - <project_name ?? customer>`   ← matches the folder
//   supplier  `Order <no> - <customer>`                   ← does NOT
//
// The folder is where `project_name` COMES FROM — the dropbox-folder function
// parses the linked folder's name into order number + project name — so a
// subject built from the customer name only matches the folder by luck. On live
// (2026-08-12) the two names differ on 23 of 46 supplier orders, i.e. half.
//
// One formula, one place, used by both routes.

/**
 * `Order <stock number> - <project or customer name>`.
 *
 * Falls back to the customer name when the order has no project name (no Dropbox
 * folder linked yet), and drops the separator entirely when neither is known —
 * "Order 402910" is a fine subject; "Order 402910 - " is not.
 *
 * A blank-but-present project name counts as absent. Nothing on live has one
 * today, but `?? ` alone would let `''` through and produce a subject naming
 * nobody, which is worse than the fallback it skipped.
 */
export function orderFolderSubject(
  stockOrderNumber: string | number | null | undefined,
  projectName: string | null | undefined,
  customerName: string | null | undefined,
): string {
  const number = String(stockOrderNumber ?? '').trim()
  const name = (projectName ?? '').trim() || (customerName ?? '').trim()
  const head = number ? `Order ${number}` : 'Order'
  return name ? `${head} - ${name}` : head
}
