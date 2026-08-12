// How long a row has been waiting, and whether that is starting to matter.
//
// Every section of the Orders page already has a clock running — it just isn't
// shown, or is buried in prose on some cards and absent on others ("paid 2 days
// ago" appears on a To-order card; nothing on a Send row says how long a proof
// has sat approved). Priority on this page is decided almost entirely by how
// long something has waited, so the number that decides the order of work was
// the one thing you couldn't sort by.
//
// ⚠ Each section measures from a DIFFERENT event, and getting that wrong would
// be worse than showing nothing — a Place row aged from its approval date would
// read as weeks old the moment a customer took their time paying, and the
// oldest-first sort would put the wrong job at the top every time.
//
//   Send     approved_at            how long we have sat on a proof they signed off
//   Place    paid_at                how long we have held their money without ordering
//   Check    supplier_reply_at      how long a supplier's reply has gone unread
//   Waiting  sent_at                how long the pay link has been out
//
// The thresholds are deliberately NOT the same either. A day of not sending a
// link is careless; a day of a customer not paying is normal.

export type OrderStage = 'send' | 'place' | 'check' | 'waiting'

/** Amber at `warn` days, red at `urgent`. Chosen per stage from what the page
 *  already treats as late elsewhere: the supplier threshold matches
 *  settings.supplier_proof_overdue_days (1 working day, 000409), and the
 *  awaiting-payment one sits just past the 3-day reminder interval so a row only
 *  colours once the automatic chaser has actually had a go. */
const THRESHOLDS: Record<OrderStage, { warn: number; urgent: number }> = {
  // We are the blocker: a proof approved days ago with no link sent is money
  // sitting still for no reason.
  send:    { warn: 2, urgent: 5 },
  // They have paid. Anything beyond a couple of days is us holding the job up.
  place:   { warn: 2, urgent: 4 },
  // A supplier reply is same-day work — QX's median is two hours.
  check:   { warn: 1, urgent: 2 },
  // The customer's own pace. Reminders go at 3-day intervals, so nothing is
  // "late" until the chaser has had at least one turn.
  waiting: { warn: 5, urgent: 10 },
}

export type AgeTone = 'calm' | 'warn' | 'urgent'

export interface OrderAge {
  /** Whole days since the stage's own clock started. 0 = today. */
  days: number
  /** Short label for a dense column: "4h", "2d", "3w". */
  label: string
  tone: AgeTone
  /** Spoken form for screen readers and tooltips — "waiting 2 days". */
  title: string
}

/** The timestamp each stage measures from. Returns null when the row has no
 *  clock yet, which is a real state (a Place row whose payment webhook hasn't
 *  landed), not an error. */
export function ageAnchor(
  stage: OrderStage,
  o: { approved_at?: string | null; paid_at?: string | null; supplier_reply_at?: string | null; sent_at?: string | null },
): string | null {
  switch (stage) {
    case 'send': return o.approved_at ?? null
    case 'place': return o.paid_at ?? null
    case 'check': return o.supplier_reply_at ?? null
    case 'waiting': return o.sent_at ?? null
  }
}

/**
 * Coarse on purpose. The desk needs "this morning" vs "last week", not a
 * stopwatch, and a column of `2d` / `11h` scans in a way that "2 days ago"
 * never will at this density.
 */
export function formatAge(fromIso: string, now: Date = new Date()): { days: number; label: string; spoken: string } {
  const ms = Math.max(0, now.getTime() - new Date(fromIso).getTime())
  const hours = Math.floor(ms / 3_600_000)
  const days = Math.floor(hours / 24)
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`
  if (hours < 1) return { days: 0, label: 'now', spoken: 'less than an hour' }
  if (hours < 24) return { days: 0, label: `${hours}h`, spoken: plural(hours, 'hour') }
  if (days < 14) return { days, label: `${days}d`, spoken: plural(days, 'day') }
  const weeks = Math.floor(days / 7)
  return { days, label: `${weeks}w`, spoken: plural(weeks, 'week') }
}

export function ageTone(stage: OrderStage, days: number): AgeTone {
  const t = THRESHOLDS[stage]
  if (days >= t.urgent) return 'urgent'
  if (days >= t.warn) return 'warn'
  return 'calm'
}

/** Everything a row needs to render its age cell, or null when there is no
 *  clock to read — callers render a dash rather than inventing a zero. */
export function orderAge(
  stage: OrderStage,
  o: { approved_at?: string | null; paid_at?: string | null; supplier_reply_at?: string | null; sent_at?: string | null },
  now: Date = new Date(),
): OrderAge | null {
  const from = ageAnchor(stage, o)
  if (!from) return null
  const { days, label, spoken } = formatAge(from, now)
  // ⚠ The title is SPOKEN, not the abbreviation. A screen reader saying
  // "waiting 5 d" is noise; the column's whole job is the compact label, so the
  // accessible name has to carry the meaning the abbreviation drops.
  return { days, label, tone: ageTone(stage, days), title: `waiting ${spoken}` }
}

/** Milliseconds waited, for sorting. Rows with no clock sort LAST on an
 *  oldest-first list rather than leading it: an unknown age is not evidence of
 *  urgency, and putting it top would be the one way this column could actively
 *  mislead. */
export function ageMs(
  stage: OrderStage,
  o: { approved_at?: string | null; paid_at?: string | null; supplier_reply_at?: string | null; sent_at?: string | null },
  now: Date = new Date(),
): number {
  const from = ageAnchor(stage, o)
  if (!from) return -1
  return Math.max(0, now.getTime() - new Date(from).getTime())
}

export type AgeSort = 'oldest' | 'newest'

/** Sort a list by age without mutating it. `-1` (no clock) always sinks. */
export function sortByAge<T>(
  rows: T[],
  stage: OrderStage,
  toOrder: (r: T) => Parameters<typeof ageMs>[1],
  dir: AgeSort,
  now: Date = new Date(),
): T[] {
  return [...rows].sort((a, b) => {
    const am = ageMs(stage, toOrder(a), now)
    const bm = ageMs(stage, toOrder(b), now)
    if (am < 0 && bm < 0) return 0
    if (am < 0) return 1
    if (bm < 0) return -1
    return dir === 'oldest' ? bm - am : am - bm
  })
}
