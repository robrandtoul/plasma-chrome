// Supplier proof holding pen — the fourth stage of an order's life.
//
// A supplier order does not end when we email it. QX (and Solopress, and Swype)
// reply with their own internal proof for us to approve, and only once we have
// approved it is the order genuinely away. Before this module that approval step
// lived in Help Scout and in somebody's head, which left a hole: if the supplier
// never received the order email, or simply forgot to reply, nothing told us —
// we found out a fortnight later when the cards didn't ship.
//
// The signal was always there. `place-order` opens a NEW Help Scout conversation
// per supplier order (supplier as the customer) and stores its id on
// orders.supplier_helpscout_conversation_id; the supplier's proof comes back as a
// reply on that thread, which fires convo.customer.reply.created at our webhook.
// We simply weren't listening — helpscout-webhook only matched conversations
// against proofs.helpscout_conversation_id, so 62 supplier replies arrived and
// were dropped. Migration 000409 adds the two stamps; this module turns them into
// the four things the Orders page needs to show.
//
// ── Why this lives in its own module ──────────────────────────────────────────
// Exactly the reasoning behind src/lib/ordersTriage.ts: this predicate decides
// whether a row is WORK at the top of the page or hides inside a collapsed block,
// and getting it wrong loses work silently — a supplier sits on an unapproved
// proof while the card reads "ordered". So the decision is one exported function
// with property tests proving the states are total and disjoint (see
// supplierProof.test.ts), rather than a handful of inline filters that can drift.

/** Where a placed supplier order has got to with its supplier's proof. */
export type SupplierProofState =
  /** Not in the pen: in-house, blanks-sourced, not placed, or no supplier thread. */
  | 'none'
  /** The supplier has replied since we last approved — a human must look. WORK. */
  | 'to_check'
  /** Emailed, nothing back yet, still inside the threshold. WAITING. */
  | 'awaiting'
  /** Emailed, nothing back, past the threshold — they may not have got it. FIX. */
  | 'overdue'
  /** Approved, and nothing newer has arrived since. Done — off to the log. */
  | 'approved'

/** The order fields the decision reads. Deliberately narrow so the predicate can
 *  be tested without constructing a whole OrderRow. */
export interface SupplierProofOrder {
  /** orders.status. Only a placed ('fulfilled') order can be in the pen. */
  status: string
  /** When the supplier order email went out. Null = no supplier email was sent. */
  supplierEmailSentAt: string | null
  /** The Help Scout conversation the supplier replies on. */
  supplierConversationId: string | null
  /** Newest supplier reply on that thread (stamped by helpscout-webhook). */
  supplierReplyAt: string | null
  /** When a human approved the supplier's proof. */
  approvedAt: string | null
}

export interface SupplierProofOptions {
  /** Working days of silence before an unanswered order reads as a problem. */
  overdueWorkingDays: number
  /** Injectable clock, so tests don't depend on today's date. */
  now?: Date
}

/**
 * Is this order in the holding pen at all?
 *
 * ⚠ Keyed off the supplier EMAIL, not the material's production_route. That is
 * not a shortcut — it is what makes the scope correct. A blanks-sourced order
 * (000382) has a supplier material but deliberately sends no supplier email: its
 * blanks ride a sibling order's batch and its message is the workshop note. Asked
 * "is this a supplier material?" it would sit in the pen forever waiting for a
 * proof from a supplier nobody emailed. Asked "did we email a supplier?" it is
 * correctly excluded, along with custom-quote orders whose route is unknown and
 * every in-house job — no email, no thread, no proof expected.
 *
 * `status === 'fulfilled'` gates the rest: an order cancelled or pulled back into
 * revision after placement drops out of the pen on its own.
 */
function inPen(o: SupplierProofOrder): boolean {
  return o.status === 'fulfilled' && !!o.supplierEmailSentAt && !!o.supplierConversationId
}

/** Mon–Fri, ignoring bank holidays — matching business_days_between's SQL
 *  semantics (000160): exclusive of the start day, INCLUSIVE of the end, so a
 *  threshold of 1 fires on the next working day rather than the one after. The
 *  sender's stricter bank-holiday-aware variant lives in
 *  supabase/functions/_shared/nudgeDecision.ts; a dashboard predicate matches the
 *  dashboard's helper, so the page and the database agree about "2 working days". */
export function workingDaysBetween(start: Date, end: Date): number {
  const DAY = 86_400_000
  const from = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate())
  const to = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate())
  if (to <= from) return 0
  let days = 0
  for (let t = from + DAY; t <= to; t += DAY) {
    const dow = new Date(t).getUTCDay() // 0=Sun … 6=Sat
    if (dow !== 0 && dow !== 6) days++
  }
  return days
}

/**
 * The one decision. Total (every order gets exactly one state) and disjoint —
 * proved over every input combination in supplierProof.test.ts.
 *
 * The re-proof case is why this is a comparison rather than a flag. QX routinely
 * sends a second proof hours after the first ("Sorry, please find the updated
 * proof attached"), sometimes after we have already approved. Because the rule is
 * "has anything arrived SINCE we approved?", an updated proof simply re-flags the
 * card. No extra state, no way for a late correction to be silently swallowed.
 */
export function supplierProofState(
  o: SupplierProofOrder,
  opts: SupplierProofOptions,
): SupplierProofState {
  if (!inPen(o)) return 'none'

  const reply = o.supplierReplyAt ? new Date(o.supplierReplyAt).getTime() : null
  const approved = o.approvedAt ? new Date(o.approvedAt).getTime() : null

  // Something arrived since we last signed off — including the very first proof,
  // where there is no approval to be newer than.
  if (reply != null && (approved == null || reply > approved)) return 'to_check'

  // Signed off, nothing newer since. Covers "cleared without replying" too, where
  // there is an approval but never was a reply.
  if (approved != null) return 'approved'

  // Emailed, genuinely nothing back. How long has it been?
  const sentAt = new Date(o.supplierEmailSentAt as string)
  const silentFor = workingDaysBetween(sentAt, opts.now ?? new Date())
  return silentFor >= opts.overdueWorkingDays ? 'overdue' : 'awaiting'
}

/** States that belong at the top of the Orders page — a person is needed today.
 *  Its complement (awaiting / approved / none) is everything that is either
 *  progressing on its own or finished. */
export function isSupplierProofWork(state: SupplierProofState): boolean {
  return state === 'to_check' || state === 'overdue'
}

/** Why an unanswered order is in FIX, in the terms the desk thinks in. Names the
 *  supplier because "they may not have received it" is only actionable if you
 *  know who to ring. */
export function overdueReason(supplierName: string | null, workingDays: number): string {
  const who = supplierName?.trim() || 'The supplier'
  const days = workingDays === 1 ? '1 working day' : `${workingDays} working days`
  return `${who} hasn’t replied in ${days} — they may not have received the order.`
}

/** How long a proof has been sitting unchecked, for the CHECK card. Deliberately
 *  coarse: the desk needs "this morning" vs "yesterday", not a stopwatch. */
export function waitingFor(since: string, now: Date = new Date()): string {
  const mins = Math.max(0, Math.round((now.getTime() - new Date(since).getTime()) / 60_000))
  if (mins < 60) return mins <= 1 ? 'just now' : `${mins} minutes ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return hours === 1 ? 'an hour ago' : `${hours} hours ago`
  const days = Math.round(hours / 24)
  return days === 1 ? 'yesterday' : `${days} days ago`
}

/**
 * Bucket a list in ONE pass, so the page's sections cannot drift apart. The
 * caller never gets the chance to filter twice with mismatched predicates — the
 * mistake that has repeatedly put a count and its own click-through out of step
 * on the dashboard (000245 / 000246).
 */
export function splitBySupplierProof<T>(
  orders: T[],
  toProof: (o: T) => SupplierProofOrder,
  opts: SupplierProofOptions,
): { toCheck: T[]; awaiting: T[]; overdue: T[]; approved: T[]; none: T[] } {
  const out = { toCheck: [] as T[], awaiting: [] as T[], overdue: [] as T[], approved: [] as T[], none: [] as T[] }
  for (const o of orders) {
    switch (supplierProofState(toProof(o), opts)) {
      case 'to_check': out.toCheck.push(o); break
      case 'awaiting': out.awaiting.push(o); break
      case 'overdue': out.overdue.push(o); break
      case 'approved': out.approved.push(o); break
      default: out.none.push(o)
    }
  }
  return out
}
