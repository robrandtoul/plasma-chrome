// Pure helpers behind the Order log page (/orders/log): search matching,
// status bucketing, and the headline stats strip. Kept out of the page so the
// filter/stat behaviour is unit-testable (pnpm test:order-log) and so the
// figures can't drift from what the list actually shows — both read the same
// functions over the same rows.
//
// Money note: GBP amounts are VAT-inclusive while EUR/USD are VAT-free, so any
// GBP-converted roll-up here is a rough guide, same caveat the Orders work
// queue prints. Totals come from orderTotal() (src/lib/orderDisplay.ts) so the
// three order surfaces agree on every displayed figure.

import { orderTotal, type OrderAmounts } from './orderDisplay'
import { currencyToGbp, type ExchangeRates } from './exchangeRates'

// The minimal shape the helpers need — the page's list rows satisfy it.
export interface OrderLogSearchable {
  id: string
  payment_reference: string | null
  stock_order_number: string | null
  xero_invoice_id: string | null
  project_name: string | null
  ship_to_name: string | null
  companyName: string | null
  contactName: string | null
  contactEmail: string | null
  specText: string
}

// Every whitespace-separated term must match somewhere — "atari steel" finds
// Atari's steel order without demanding one field carry both words.
export function matchesOrderSearch(row: OrderLogSearchable, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const haystack = [
    row.payment_reference,
    row.stock_order_number,
    row.xero_invoice_id,
    row.project_name,
    row.ship_to_name,
    row.companyName,
    row.contactName,
    row.contactEmail,
    row.specText,
    row.id,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return q.split(/\s+/).every((term) => haystack.includes(term))
}

// ── Status buckets ───────────────────────────────────────────────────────────
// The log's vocabulary follows the admin Order log: sent = "Awaiting payment",
// fulfilled = "Ordered" (placed with production, not delivered). Expiry is
// DERIVED — status stays 'sent' in the DB while expires_at slips past — so
// "expired" is a presentation state inside the awaiting bucket, never a
// filter key of its own.

export type OrderLogBucket = 'awaiting' | 'paid' | 'ordered' | 'revision' | 'cancelled'

export interface OrderLogStatusInfo {
  bucket: OrderLogBucket
  label: string
  // Design-system Pill colour name.
  pill: 'brand' | 'in-stock' | 'low' | 'out' | 'critical' | 'allocated' | 'neutral' | 'mute'
  expired: boolean
}

// The group row a combined-payment member's expiry must be read from. A
// grouped member's own expires_at freezes when its link goes dormant — only
// the GROUP's link is payable, so only the group's expiry means anything.
export interface OrderLogGroupRef {
  status: string
  expires_at: string | null
}

export function orderLogStatus(
  o: {
    status: string
    expires_at: string | null
    payment_method: string
    order_group_id?: string | null
    // The owning proof's status, when the caller has it. Only consulted for
    // cancelled orders — see below.
    proof_status?: string | null
  },
  now: Date,
  group: OrderLogGroupRef | null = null,
): OrderLogStatusInfo {
  switch (o.status) {
    case 'paid':
      return { bucket: 'paid', label: 'Paid', pill: 'in-stock', expired: false }
    case 'fulfilled':
      return { bucket: 'ordered', label: 'Ordered', pill: 'allocated', expired: false }
    case 'revision':
      return { bucket: 'revision', label: 'Revision', pill: 'out', expired: false }
    case 'cancelled':
      // An order cancelled because the whole PROJECT was closed off reads
      // "Abandoned", matching the proof page — "Cancelled" would imply a
      // live project whose order was called off. A cancelled order on a
      // live project (a superseded pay link, a re-cut order) keeps
      // "Cancelled". Same bucket either way.
      return o.proof_status === 'abandoned'
        ? { bucket: 'cancelled', label: 'Abandoned', pill: 'mute', expired: false }
        : { bucket: 'cancelled', label: 'Cancelled', pill: 'mute', expired: false }
    default: {
      if (o.order_group_id != null) {
        // Group row not loaded (or group no longer 'sent') → a transient
        // "Awaiting payment" is safer than a false "Link expired".
        const expired =
          group != null && group.status === 'sent' && group.expires_at != null && new Date(group.expires_at) < now
        return expired
          ? { bucket: 'awaiting', label: 'Combined link expired', pill: 'out', expired: true }
          : { bucket: 'awaiting', label: 'Awaiting payment', pill: 'low', expired: false }
      }
      const expired = o.expires_at != null && new Date(o.expires_at) < now
      return expired
        ? { bucket: 'awaiting', label: 'Link expired', pill: 'out', expired: true }
        : { bucket: 'awaiting', label: 'Awaiting payment', pill: 'low', expired: false }
    }
  }
}

// The dispatch-derived pill (Shipped / Delivered, from the admin shipping
// enrichment) may only override statuses it is strictly downstream of — a
// revision or cancelled order must keep saying so even when the parcel
// already went out, or the pill hides exactly the state that needs eyes.
export function orderLogDisplayStatus(
  status: OrderLogStatusInfo,
  shipped: boolean,
  delivered: boolean,
): { label: string; pill: OrderLogStatusInfo['pill'] } {
  const dispatchApplies = status.bucket === 'paid' || status.bucket === 'ordered'
  if (dispatchApplies && delivered) return { label: 'Delivered', pill: 'in-stock' }
  if (dispatchApplies && shipped) return { label: 'Shipped', pill: 'in-stock' }
  return { label: status.label, pill: status.pill }
}

// ── Stats ────────────────────────────────────────────────────────────────────

export interface StatsOrder extends OrderAmounts {
  status: string
  payment_method: string
  currency: 'GBP' | 'EUR' | 'USD'
  sent_at: string | null
  paid_at: string | null
  order_group_id?: string | null
}

// Combined payments charge shipping + the US tariff ONCE at group level and
// zero them on every member row — so the group rows must be counted (once
// each) or the paid roll-ups under-report the money actually taken.
export interface StatsGroup {
  status: string
  paid_at: string | null
  expires_at: string | null
  currency: 'GBP' | 'EUR' | 'USD'
  amount_shipping: number | null
  amount_us_tariff: number | null
}

export interface WeeklyPaidPoint {
  // ISO date (yyyy-mm-dd) of the Monday the week starts on, local time.
  weekStart: string
  count: number
  gbp: number
}

export interface OrderLogStats {
  paid30Count: number
  paid30Gbp: number
  awaitingCount: number
  awaitingExpiredCount: number
  placed30Count: number
  // Median sent→paid gap for online orders, in days; null when no sample.
  medianDaysToPay: number | null
  weeklyPaid: WeeklyPaidPoint[]
}

const DAY_MS = 24 * 60 * 60 * 1000

function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

// Monday-start week, local time. A present-days-only group-by would silently
// close real quiet weeks (the 000363 lesson), so the page always renders every
// week in the window — buildWeeklyPaid emits zeros for empty ones.
export function mondayOf(d: Date): Date {
  const day = startOfLocalDay(d)
  const dow = (day.getDay() + 6) % 7 // Mon=0 … Sun=6
  return new Date(day.getTime() - dow * DAY_MS)
}

function localIsoDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// "Money in" for stats = a payment stamp on a not-cancelled order. A cancelled
// order that was once paid has been refunded (or is being unwound) — counting
// it would report revenue we handed back.
function countsAsPaid(o: { status: string; paid_at: string | null }): boolean {
  return o.paid_at != null && o.status !== 'cancelled'
}

export function buildWeeklyPaid(
  orders: StatsOrder[],
  rates: ExchangeRates | null,
  now: Date,
  weeks = 12,
  groups: StatsGroup[] = [],
): WeeklyPaidPoint[] {
  const thisMonday = mondayOf(now)
  const points: WeeklyPaidPoint[] = []
  const index = new Map<string, WeeklyPaidPoint>()
  for (let i = weeks - 1; i >= 0; i--) {
    // Calendar arithmetic, NOT millisecond subtraction: subtracting exact
    // 168-hour multiples crosses the UK spring clock change into a Sunday-
    // 23:00 instant, so every pre-transition week gets a Sunday-dated key
    // that no payment's mondayOf() key can match — the bars silently zero
    // for ~12 weeks after each spring change. The Date constructor
    // normalises the underflowed day-of-month in local time instead.
    const start = new Date(thisMonday.getFullYear(), thisMonday.getMonth(), thisMonday.getDate() - i * 7)
    const point = { weekStart: localIsoDate(start), count: 0, gbp: 0 }
    points.push(point)
    index.set(point.weekStart, point)
  }
  for (const o of orders) {
    if (!countsAsPaid(o)) continue
    const key = localIsoDate(mondayOf(new Date(o.paid_at!)))
    const point = index.get(key)
    if (!point) continue
    point.count += 1
    const total = orderTotal(o)
    if (total != null) point.gbp += currencyToGbp(total, o.currency, rates)
  }
  // Group-level shipping + tariff join the week's money (never its count —
  // a group is a payment wrapper, not an order).
  for (const g of groups) {
    if (g.paid_at == null || g.status === 'cancelled') continue
    const point = index.get(localIsoDate(mondayOf(new Date(g.paid_at))))
    if (!point) continue
    point.gbp += currencyToGbp(Number(g.amount_shipping ?? 0) + Number(g.amount_us_tariff ?? 0), g.currency, rates)
  }
  for (const p of points) p.gbp = Math.round(p.gbp)
  return points
}

export function computeOrderLogStats(
  orders: (StatsOrder & { expires_at: string | null; fulfilled_at: string | null })[],
  rates: ExchangeRates | null,
  now: Date,
  groupsById: Record<string, StatsGroup> = {},
): OrderLogStats {
  const cutoff30 = now.getTime() - 30 * DAY_MS
  let paid30Count = 0
  let paid30Gbp = 0
  let awaitingCount = 0
  let awaitingExpiredCount = 0
  let placed30Count = 0
  const payGaps: number[] = []

  for (const o of orders) {
    if (countsAsPaid(o) && new Date(o.paid_at!).getTime() >= cutoff30) {
      paid30Count += 1
      const total = orderTotal(o)
      if (total != null) paid30Gbp += currencyToGbp(total, o.currency, rates)
    }
    if (o.status === 'sent') {
      awaitingCount += 1
      // Same group-aware expiry rule the status pills use, so the tile and
      // the list can't disagree about what counts as expired.
      const group = o.order_group_id != null ? groupsById[o.order_group_id] ?? null : null
      if (orderLogStatus(o, now, group).expired) awaitingExpiredCount += 1
    }
    if (o.fulfilled_at != null && o.status === 'fulfilled' && new Date(o.fulfilled_at).getTime() >= cutoff30) {
      placed30Count += 1
    }
    // Offline orders stamp sent_at and paid_at in the same insert — a zero-day
    // "gap" that would drag the median into fiction.
    if (o.payment_method === 'online' && o.sent_at && countsAsPaid(o)) {
      const gap = new Date(o.paid_at!).getTime() - new Date(o.sent_at).getTime()
      if (gap >= 0) payGaps.push(gap / DAY_MS)
    }
  }

  // Each paid group's shipping + tariff counts once — the member rows carry
  // zeros for those lines by design (create-checkout-session group mode).
  const groups = Object.values(groupsById)
  for (const g of groups) {
    if (g.paid_at == null || g.status === 'cancelled') continue
    if (new Date(g.paid_at).getTime() < cutoff30) continue
    paid30Gbp += currencyToGbp(Number(g.amount_shipping ?? 0) + Number(g.amount_us_tariff ?? 0), g.currency, rates)
  }

  payGaps.sort((a, b) => a - b)
  const medianDaysToPay =
    payGaps.length === 0
      ? null
      : payGaps.length % 2 === 1
        ? payGaps[(payGaps.length - 1) / 2]
        : (payGaps[payGaps.length / 2 - 1] + payGaps[payGaps.length / 2]) / 2

  return {
    paid30Count,
    paid30Gbp: Math.round(paid30Gbp),
    awaitingCount,
    awaitingExpiredCount,
    placed30Count,
    medianDaysToPay,
    weeklyPaid: buildWeeklyPaid(orders, rates, now, 12, groups),
  }
}
