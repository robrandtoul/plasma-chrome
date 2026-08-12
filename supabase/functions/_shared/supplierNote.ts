// The two internal notes a supplier order files on the CUSTOMER's proof thread
// (000409), so whoever opens the project in Help Scout can see where the order
// has got to without going near the Orders page.
//
// They are a pair, written in two different functions at two different moments —
// `place-order` files the first when the order is emailed, `approve-supplier-proof`
// files the second when someone clears the reply. They live here together because
// a pair written apart drifts apart: the second note only makes sense as the
// answer to the first.
//
// ⚠ THE RULE, which has now caught us three times in one feature: name the
// supplier, and claim NOTHING about what they send. Only QX Metals return an
// artwork proof. Solopress send a booking confirmation and their own job number;
// Swype send a proforma invoice and don't start until it's paid. So "AWAITING
// SUPPLIER PROOF" / "SUPPLIER PROOF APPROVED" — the wording originally asked for
// — would be false on two suppliers out of the three, and false again on whoever
// is added next. supplierNote.test.ts pins it.
//
// Help Scout notes are staff-only: never emailed, never shown to the customer.

/** Uppercased supplier name for a note heading, with a safe fallback. */
function heading(supplierName: string | null | undefined): string {
  const name = (supplierName ?? '').trim()
  return name ? name.toUpperCase() : 'THE SUPPLIER'
}

/**
 * Filed when the order is emailed. Leads with the STATUS rather than the
 * contents: whoever opens this thread next wants to know where the order has got
 * to, and heading it "copy of order" buries that under a wall of spec.
 *
 * `orderCopyHtml` is the exact body emailed to the supplier, already HTML.
 */
export function awaitingSupplierNote(supplierName: string | null | undefined, orderCopyHtml: string): string {
  return (
    `<strong>AWAITING RESPONSE FROM ${heading(supplierName)}</strong>` +
    `<br>Copy of the order sent to them:<br><br>${orderCopyHtml}`
  )
}

/**
 * Filed when someone clears what the supplier sent back.
 *
 * `replied` is a real distinction for anyone reading the thread later, not a
 * cosmetic one: one of these means the supplier was told, the other means they
 * were not (the "just record it" path, used when the reply was already sent by
 * hand in Help Scout).
 */
export function supplierClearedNote(
  supplierName: string | null | undefined,
  clearedBy: string,
  replied: boolean,
): string {
  const by = clearedBy.trim() || 'a member of the team'
  const how = replied ? `Replied by ${by}.` : `Recorded by ${by} — no reply sent from here.`
  return `<strong>${heading(supplierName)} RESPONSE CLEARED</strong><br>${how}`
}
