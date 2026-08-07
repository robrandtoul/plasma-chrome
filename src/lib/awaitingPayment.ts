// The dashboard's "Awaiting payment" rail panel: turning the raw 'sent' orders
// into the short, scannable list a designer can read at a glance.
//
// Why this exists at all. Awaiting-payment orders live on the Orders page
// inside the collapsed "Waiting" section — collapsed because those rows are the
// ones the automatic chaser is already handling, and as full cards they were
// two thirds of the page while needing nothing from anyone. That trade lost
// something real: the one fact worth watching on an unpaid link is whether the
// customer has OPENED it, and that fact went behind a click. This panel puts it
// back, in a form that costs a rail column rather than a page.
//
// The panel reports; it does not triage. The Orders page's Fix section already
// decides what is going wrong and what to do about it, and a second ordering of
// the same rows competing with it is exactly how two lists drift apart. So the
// sort here is one rule about one fact (below), and the exceptions — expired,
// held, asked-for-help — are *labels* on a row rather than a reason to reorder
// it.
//
// Pure module: no supabase, no React. AwaitingPaymentPanel does the fetching.

import { customerLabel } from './orderDisplay'
import { relativeTime } from './relativeTime'

/** A 'sent' order, with its customer names already joined. */
export interface AwaitingOrderInput {
  id: string
  proof_id: string
  order_group_id: string | null
  sent_at: string | null
  /** Stamped on EVERY customer open (000262), and never for signed-in staff
   *  (000266) — so this is genuinely "last opened, by the customer". */
  pay_link_opened_at: string | null
  expires_at: string | null
  held_at: string | null
  help_requested_at: string | null
  /** Null is treated as 'online' — the column's own default meaning. */
  payment_method: string | null
  contact_name: string | null
  company_name: string | null
  /** Thread-wide reply stamps (000208). Carried through so the panel can word a
   *  grace pause on the automatic chase — see src/lib/orderReminders.ts. */
  helpscout_last_reply_at: string | null
  helpscout_last_customer_reply_at: string | null
}

/** A combined payment (proofs.order_groups, 000309) covering 2+ of the above. */
export interface AwaitingGroupInput {
  id: string
  status: string
  sent_at: string | null
  pay_link_opened_at: string | null
  expires_at: string | null
}

export interface AwaitingRow {
  /** React key. Distinct from orderId so a group can't collide with an order. */
  key: string
  /** The order the row opens on the Orders page. For a combined payment this is
   *  the earliest member — any member scrolls to the same group block. */
  orderId: string
  proofId: string
  label: string
  /** >1 when this row stands for a combined payment. */
  orderCount: number
  openedAt: string | null
  sentAt: string | null
  expiresAt: string | null
  expired: boolean
  held: boolean
  helpRequested: boolean
  /** Bank transfer etc. — there is no pay link, so no "opened" to report. */
  offline: boolean
  /**
   * Part of a live combined payment. Tracked as its own flag rather than read
   * off `orderCount > 1`, because Release can leave a group holding a single
   * member: still grouped, still skipped by the reminder sender, but no longer
   * plural. Inferring it from the count would quietly start promising that
   * order reminders nothing is going to send.
   */
  grouped: boolean
  /** Reply stamps for the grace-pause wording; null on a grouped row, which
   *  short-circuits before the note is ever needed. */
  lastReplyAt: string | null
  lastCustomerReplyAt: string | null
}

const DAY_MS = 86_400_000

/** Show an expiry countdown only inside this window — a fortnight of "expires
 *  in 13 days" on every row is noise, the last couple of days is a deadline. */
export const EXPIRING_SOON_DAYS = 3

function isOffline(o: AwaitingOrderInput): boolean {
  return (o.payment_method ?? 'online') !== 'online'
}

function expiredAt(expiresAt: string | null, now: number): boolean {
  if (!expiresAt) return false
  const ms = Date.parse(expiresAt)
  return Number.isFinite(ms) && ms < now
}

/**
 * Collapse the 'sent' orders into one row each, EXCEPT that the members of a
 * combined payment collapse into a single row.
 *
 * ⚠ The group's own timestamps win for a grouped row, and this is the whole
 * point of the collapse rather than a detail of it. A combined payment
 * supersedes its members' individual links: the customer is sent ONE link, and
 * only `order_groups.pay_link_opened_at` records their opening it. The member
 * rows keep the stamps from before they were grouped — on live today both
 * BlissFix members read "never opened" while carrying their own older sent_at —
 * so a panel that read the member would report an opened combined payment as
 * untouched, twice over.
 *
 * A group row that is missing, or no longer 'sent' (cancelled, or paid while
 * this page was open), leaves its members to render standalone. That is the
 * safe direction: showing two rows that should be one is a cosmetic oddity,
 * whereas dropping them would hide money owed.
 */
export function buildAwaitingRows(
  orders: AwaitingOrderInput[],
  groups: AwaitingGroupInput[],
  now: number = Date.now(),
): AwaitingRow[] {
  const groupById = new Map(groups.filter((g) => g.status === 'sent').map((g) => [g.id, g]))
  const rows: AwaitingRow[] = []
  const members = new Map<string, AwaitingOrderInput[]>()

  for (const o of orders) {
    const g = o.order_group_id ? groupById.get(o.order_group_id) : undefined
    if (g) {
      const list = members.get(g.id)
      if (list) list.push(o)
      else members.set(g.id, [o])
      continue
    }
    rows.push({
      key: o.id,
      orderId: o.id,
      proofId: o.proof_id,
      label: customerLabel(o.company_name, o.contact_name),
      orderCount: 1,
      openedAt: o.pay_link_opened_at,
      sentAt: o.sent_at,
      expiresAt: o.expires_at,
      expired: expiredAt(o.expires_at, now),
      held: o.held_at != null,
      helpRequested: o.help_requested_at != null,
      offline: isOffline(o),
      grouped: false,
      lastReplyAt: o.helpscout_last_reply_at,
      lastCustomerReplyAt: o.helpscout_last_customer_reply_at,
    })
  }

  for (const [groupId, list] of members) {
    const g = groupById.get(groupId)!
    // Earliest member first, id as the tiebreak, so the row's identity (and
    // therefore its jump target) is stable across refetches.
    const sorted = [...list].sort(
      (a, b) => (Date.parse(a.sent_at ?? '') || 0) - (Date.parse(b.sent_at ?? '') || 0) || a.id.localeCompare(b.id),
    )
    const first = sorted[0]
    rows.push({
      key: `group:${groupId}`,
      orderId: first.id,
      proofId: first.proof_id,
      label: customerLabel(first.company_name, first.contact_name),
      orderCount: sorted.length,
      openedAt: g.pay_link_opened_at,
      sentAt: g.sent_at,
      expiresAt: g.expires_at,
      expired: expiredAt(g.expires_at, now),
      // Hold + help are per-order concepts; a group is flagged when ANY member
      // carries one, since the row now stands for all of them.
      held: sorted.some((o) => o.held_at != null),
      helpRequested: sorted.some((o) => o.help_requested_at != null),
      offline: sorted.every(isOffline),
      grouped: true,
      // Unused on a grouped row (the reminder decision short-circuits), and
      // deliberately not guessed from an arbitrary member.
      lastReplyAt: null,
      lastCustomerReplyAt: null,
    })
  }

  return sortAwaitingRows(rows)
}

/**
 * One rule, about the one fact the panel is for: has the customer opened it?
 *
 *   1. Opened, most recently opened first. A link opened an hour ago is someone
 *      standing at the checkout right now — the most actionable thing here.
 *   2. Then never opened, longest-waiting first, so the ones going cold sit at
 *      the bottom of the top group rather than lost at the end of the list.
 *
 * Expired rows are deliberately NOT floated to the top. They surface anyway
 * (an expired link is either old-and-unopened, so already near the head of
 * group 2, or opened, so in group 1) and they carry a plain "Expired" label.
 * Reordering for them would make this a second triage competing with the Orders
 * page's Fix section, which is the one job this panel doesn't have.
 */
export function sortAwaitingRows(rows: AwaitingRow[]): AwaitingRow[] {
  return [...rows].sort((a, b) => {
    const aOpen = a.openedAt ? Date.parse(a.openedAt) : null
    const bOpen = b.openedAt ? Date.parse(b.openedAt) : null
    if (aOpen != null && bOpen != null) return bOpen - aOpen
    if (aOpen != null) return -1
    if (bOpen != null) return 1
    // Neither opened — longest wait first. A missing sent_at sorts last rather
    // than parsing to NaN and scrambling the comparator.
    const aSent = a.sentAt ? Date.parse(a.sentAt) : Infinity
    const bSent = b.sentAt ? Date.parse(b.sentAt) : Infinity
    return aSent - bSent
  })
}

/**
 * The row's second line. Always leads with the opened state, because that is
 * what the panel is for and an exception must not displace it — the exception
 * gets its own chip on the line above.
 */
export function awaitingStatusLine(row: AwaitingRow, now: number = Date.now()): string {
  const parts: string[] = []

  if (row.offline) {
    // No link exists, so "not opened" would be a fact about nothing.
    parts.push(row.sentAt ? `Awaiting payment · raised ${relativeTime(row.sentAt)}` : 'Awaiting payment')
  } else if (row.openedAt) {
    parts.push(`Opened ${relativeTime(row.openedAt)}`)
  } else if (row.sentAt) {
    parts.push(`Not opened · sent ${relativeTime(row.sentAt)}`)
  } else {
    parts.push('Not opened')
  }

  const expiry = expiryNote(row, now)
  if (expiry) parts.push(expiry)
  if (row.orderCount > 1) parts.push(`${row.orderCount} orders`)

  return parts.join(' · ')
}

/**
 * "expires in 2 days" — only inside EXPIRING_SOON_DAYS, and never once it has
 * expired (the chip says that, and saying it twice in two registers reads as
 * two different facts).
 */
export function expiryNote(row: AwaitingRow, now: number = Date.now()): string | null {
  if (row.expired || row.offline || !row.expiresAt) return null
  const ms = Date.parse(row.expiresAt)
  if (!Number.isFinite(ms)) return null
  const days = Math.ceil((ms - now) / DAY_MS)
  if (days > EXPIRING_SOON_DAYS) return null
  if (days <= 1) return 'expires today'
  return `expires in ${days} days`
}

/** The single exception chip, if any. One slot, highest concern first. */
export function awaitingChip(row: AwaitingRow): string | null {
  if (row.expired) return 'Expired'
  if (row.held) return 'On hold'
  if (row.helpRequested) return 'Asked for help'
  return null
}

/**
 * "4 payments · 1 opened" — the panel's one-line summary.
 *
 * ⚠ Counts PAYMENTS, not orders, and says so — because it will not match the
 * dashboard's "Awaiting payment" tile a few inches away, which counts orders.
 * A combined payment is one payment covering several orders, so five orders can
 * be four payments, and a bare "4 waiting" under a tile reading 5 invites the
 * one question this panel must never raise: what is it not showing me? Naming
 * the unit makes the difference self-explanatory, and the row's own "· 2 orders"
 * reconciles it on screen. Counts drifting apart is a documented bug class on
 * this dashboard (PV-2026W19-015); this one is honest by construction rather
 * than by keeping two predicates in step.
 */
export function awaitingSummary(rows: AwaitingRow[]): string {
  if (rows.length === 0) return '0 payments'
  const opened = rows.filter((r) => r.openedAt != null).length
  return `${rows.length} payment${rows.length === 1 ? '' : 's'} · ${opened} opened`
}
