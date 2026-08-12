// The order-lifecycle timeline, assembled entirely from column stamps and the
// order_nudges ledger.
//
// There is no event table for orders: stripe-webhook writes no audit_log rows
// at all, and audit_log SELECT is admin-only by RLS anyway — so "paid",
// "invoice emailed", "confirmation posted" and friends exist ONLY as
// timestamps on proofs.orders / proofs.order_groups. This module turns those
// stamps into a readable story, the same bridge the dashboard's Latest
// activity feed does (src/lib/dashboardGrouping.ts), kept pure so the Order
// log page and its tests ask the same questions.
//
// Rules worth keeping straight (each is pinned by a test):
// - Offline orders are born status='paid' with sent_at AND paid_at stamped in
//   the same insert and never had a pay link — link sent/opened/expired
//   semantics are suppressed and the two same-instant stamps collapse into
//   "recorded" then "payment recorded".
// - Combined-payment members freeze their own pay_link_opened_at and carry the
//   invoice/confirmation stamps on the GROUP row — pass the group and those
//   moments read from it.
// - Cancellation deliberately has NO timeline entry: orders has no
//   cancelled_at column, and updated_at moves on every edit so it would date
//   the entry dishonestly. The status pill carries the state instead.
// - place-order's hand-off stamps (handoff_at, supplier_email_sent_at,
//   production_note_posted_at) land within moments of fulfilled_at on a normal
//   placement — those collapse into the "Placed into production" entry; only a
//   stamp arriving later (a retried hand-off) earns its own row.

export type OrderTimelineEntryType =
  | 'created'
  | 'link_opened'
  | 'reminder_sent'
  | 'help_requested'
  | 'resend_requested'
  | 'link_expired'
  | 'paid'
  | 'invoice_emailed'
  | 'confirmation_sent'
  | 'revision_started'
  | 'artwork_checked'
  | 'placed'
  | 'handoff'
  | 'supplier_emailed'
  | 'production_note'
  // The supplier proof holding pen (000409): they sent their internal proof
  // back, and we signed it off. Between "emailed to the supplier" and anything
  // being made.
  | 'supplier_proof_received'
  | 'supplier_proof_approved'
  | 'shipped'
  | 'delivered'

export interface OrderTimelineEntry {
  id: string
  type: OrderTimelineEntryType
  at: string
  label: string
  detail?: string
}

export interface TimelineOrder {
  id: string
  status: string
  payment_method: string
  order_kind: string
  created_at: string
  sent_at: string | null
  expires_at: string | null
  pay_link_opened_at: string | null
  help_requested_at: string | null
  pay_link_resend_requested_at: string | null
  paid_at: string | null
  invoice_emailed_at: string | null
  confirmation_sent_at: string | null
  revised_at: string | null
  fulfilled_at: string | null
  handoff_at: string | null
  supplier_email_sent_at: string | null
  production_note_posted_at: string | null
  // Supplier proof holding pen (000409). Optional so a caller that predates the
  // migration — or a select that doesn't ask for them — still type-checks and
  // simply contributes no entries.
  supplier_reply_at?: string | null
  supplier_proof_approved_at?: string | null
  artwork_checked_at: string | null
  artwork_check_verdict: string | null
  supplier_name?: string | null
  order_group_id: string | null
}

export interface TimelineGroup {
  status: string
  expires_at: string | null
  payment_reference: string | null
  pay_link_opened_at: string | null
  invoice_emailed_at: string | null
  confirmation_sent_at: string | null
}

export interface TimelineReminder {
  reminder_no: number | null
  source: string | null
  created_at: string
  /**
   * Set when this reminder was about a whole combined payment (000388). Such a
   * reminder is booked against its representative member's order_id as well as
   * the group's, so it lands in that ONE member's timeline — and without this
   * it would read there as a reminder about that card, which nothing ever
   * sends while the card is grouped.
   */
  order_group_id?: string | null
}

export interface TimelineShipping {
  shipped_at: string | null
  delivered_at: string | null
}

// A hand-off stamp within this window of fulfilled_at is part of the same
// placement, not a separate event. Mirrors the 2-minute reminder/reply dedup
// in proofTimeline.ts, wider because place-order's supplier email + note can
// trail the status flip by a couple of minutes on a slow run.
export const PLACED_CLUSTER_MS = 5 * 60 * 1000

// Same-instant ties (offline orders stamp created/sent/paid with one nowIso)
// sort in lifecycle order, not insertion order.
const TIE_RANK: Record<OrderTimelineEntryType, number> = {
  created: 0,
  link_opened: 1,
  reminder_sent: 2,
  help_requested: 3,
  resend_requested: 4,
  link_expired: 5,
  paid: 6,
  invoice_emailed: 7,
  confirmation_sent: 8,
  revision_started: 9,
  artwork_checked: 10,
  placed: 11,
  handoff: 12,
  supplier_emailed: 13,
  production_note: 14,
  supplier_proof_received: 15,
  supplier_proof_approved: 16,
  shipped: 17,
  delivered: 18,
}

const VERDICT_LABEL: Record<string, string> = {
  clear: 'all clear',
  flagged: 'flagged for review',
  defect: 'defect found',
  error: 'did not finish',
}

export function buildOrderTimeline(
  order: TimelineOrder,
  group: TimelineGroup | null,
  reminders: TimelineReminder[],
  shipping: TimelineShipping | null,
  now: Date = new Date(),
): OrderTimelineEntry[] {
  const entries: OrderTimelineEntry[] = []
  const offline = order.payment_method === 'offline'
  const grouped = order.order_group_id != null && group != null
  const add = (type: OrderTimelineEntryType, at: string | null | undefined, label: string, detail?: string) => {
    if (!at) return
    entries.push({ id: `${type}-${at}`, type, at, label, detail })
  }

  if (offline) {
    add('created', order.created_at, 'Order recorded', 'Paid outside the pay page — no pay link was sent.')
  } else {
    add(
      'created',
      order.created_at,
      'Order created',
      grouped ? 'Later combined into one payment with other orders.' : 'Pay link sent to the customer.',
    )
  }

  if (!offline) {
    // A grouped member's own stamp freezes when its link goes dormant — the
    // combined link's open is the one that means anything.
    const openedAt = grouped ? group.pay_link_opened_at : order.pay_link_opened_at
    add(
      'link_opened',
      openedAt,
      grouped ? 'Combined pay link opened' : 'Pay link opened',
    )
  }

  for (const r of reminders) {
    const what = r.order_group_id ? 'Combined payment reminder' : 'Payment reminder'
    const n = r.reminder_no != null ? `${what} ${r.reminder_no}` : what
    add('reminder_sent', r.created_at, `${n} sent`, r.source === 'auto' ? 'Automatic' : undefined)
  }

  add('help_requested', order.help_requested_at, 'Customer asked for help on the pay page')
  add('resend_requested', order.pay_link_resend_requested_at, 'Customer asked for a fresh pay link')

  // Expiry is derived, never stored — status stays 'sent' while expires_at
  // slips into the past. Only an unpaid order can be expired, and a grouped
  // member's own expires_at freezes when its link goes dormant: the GROUP's
  // expiry is the one that means anything for a combined payment.
  if (!offline && order.status === 'sent') {
    if (grouped) {
      if (group.status === 'sent' && group.expires_at && new Date(group.expires_at) < now) {
        add('link_expired', group.expires_at, 'Combined pay link expired')
      }
    } else if (order.expires_at && new Date(order.expires_at) < now) {
      add('link_expired', order.expires_at, 'Pay link expired')
    }
  }

  if (order.paid_at) {
    add(
      'paid',
      order.paid_at,
      offline ? 'Payment recorded' : 'Payment received',
      grouped
        ? `Paid together with the other orders in combined payment ${group.payment_reference ?? ''}`.trim()
        : undefined,
    )
  }

  // Invoice + confirmation stamps live on the GROUP row for combined payments
  // (one invoice, one confirmation for the whole payment).
  const invoiceEmailedAt = grouped ? group.invoice_emailed_at : order.invoice_emailed_at
  const confirmationAt = grouped ? group.confirmation_sent_at : order.confirmation_sent_at
  add('invoice_emailed', invoiceEmailedAt, 'VAT invoice emailed')
  add('confirmation_sent', confirmationAt, 'Order confirmation posted on Help Scout')

  add('revision_started', order.revised_at, 'Order reopened for revision')

  if (order.artwork_checked_at) {
    const verdict = order.artwork_check_verdict ? VERDICT_LABEL[order.artwork_check_verdict] : null
    add('artwork_checked', order.artwork_checked_at, 'Artwork check ran', verdict ? `Verdict: ${verdict}` : undefined)
  }

  if (order.fulfilled_at) {
    const fulfilledMs = new Date(order.fulfilled_at).getTime()
    const within = (iso: string | null) =>
      iso != null && Math.abs(new Date(iso).getTime() - fulfilledMs) <= PLACED_CLUSTER_MS
    const clustered: string[] = []
    if (within(order.handoff_at)) clustered.push('sent to Stock Control')
    if (within(order.supplier_email_sent_at)) {
      clustered.push(order.supplier_name ? `order emailed to ${order.supplier_name}` : 'order emailed to the supplier')
    }
    if (within(order.production_note_posted_at)) clustered.push('production note posted')
    add(
      'placed',
      order.fulfilled_at,
      'Placed into production',
      clustered.length > 0 ? `${clustered.join(' · ')}`.replace(/^./, (c) => c.toUpperCase()) : undefined,
    )
    // A stamp outside the cluster window is a retried hand-off — its own moment.
    if (order.handoff_at && !within(order.handoff_at)) {
      add('handoff', order.handoff_at, 'Sent to Stock Control')
    }
    if (order.supplier_email_sent_at && !within(order.supplier_email_sent_at)) {
      add(
        'supplier_emailed',
        order.supplier_email_sent_at,
        order.supplier_name ? `Order emailed to ${order.supplier_name}` : 'Order emailed to the supplier',
      )
    }
    if (order.production_note_posted_at && !within(order.production_note_posted_at)) {
      add('production_note', order.production_note_posted_at, 'Production note posted')
    }
    // The supplier's own proof coming back, and our sign-off (000409).
    // supplier_reply_at holds only the NEWEST reply — the column is overwritten
    // by each one — so a re-proofed order shows its latest round, not its
    // history. Honest about what we store rather than inventing rounds we never
    // recorded.
    if (order.supplier_reply_at) {
      add(
        'supplier_proof_received',
        order.supplier_reply_at,
        order.supplier_name ? `${order.supplier_name} replied` : 'The supplier replied',
      )
    }
    if (order.supplier_proof_approved_at) {
      add('supplier_proof_approved', order.supplier_proof_approved_at, 'Supplier reply cleared')
    }
  }

  if (shipping) {
    add('shipped', shipping.shipped_at, 'Shipped to the customer')
    add('delivered', shipping.delivered_at, 'Delivered')
  }

  entries.sort((a, b) => {
    const d = new Date(a.at).getTime() - new Date(b.at).getTime()
    if (d !== 0) return d
    return TIE_RANK[a.type] - TIE_RANK[b.type]
  })
  return entries
}
