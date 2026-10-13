// Send later: the pure rules behind a message written now and sent at a
// chosen time. No React, no data access, so a host can unit-test them (the
// package has no test runner of its own).
//
// What is decided here, and why each rule is the way it is:
//
//   * The earliest a message may be scheduled for is the next whole minute
//     at least a minute away. Delivery is an every-minute cron, so a time
//     inside the current minute could land before the row is even written,
//     and a time with seconds on it would promise a precision nobody gets.
//
//   * The presets are the three or four moments people actually mean by
//     "later": in an hour, this afternoon, tomorrow morning, Monday morning.
//     They are computed from the clock, not stored, and a preset that would
//     name a moment already passed, or one another preset already names,
//     is left out rather than shown greyed.
//
//   * A scheduled row is always the author's own, so its thread is simply
//     its recipient (or the room). `threadOf` in the store answers the
//     harder question for messages that may have come FROM someone.

import type { ChatThread, ScheduledMessage } from './types'

/** How far ahead the earliest schedule may be. */
export const MIN_LEAD_MS = 60_000
/** How far ahead the latest may be. A year is arbitrary and generous; its job
 *  is to catch a year typed into the wrong box. */
export const MAX_LEAD_MS = 366 * 24 * 60 * 60_000

const MINUTE_MS = 60_000

/** The next whole minute at least `MIN_LEAD_MS` away. Whole UTC minutes are
 *  whole local minutes too, since every time zone's offset is whole minutes. */
export function earliestSendAt(now: Date = new Date()): Date {
  return new Date(Math.ceil((now.getTime() + MIN_LEAD_MS) / MINUTE_MS) * MINUTE_MS)
}

/** Why a time cannot be scheduled, or null when it can. */
export function scheduleProblem(at: Date | null, now: Date = new Date()): string | null {
  if (!at || !Number.isFinite(at.getTime())) return 'Pick a time to send it.'
  if (at.getTime() < earliestSendAt(now).getTime()) return 'Pick a time at least a minute from now.'
  if (at.getTime() > now.getTime() + MAX_LEAD_MS) return 'That is more than a year away.'
  return null
}

export interface SchedulePreset {
  key: 'hour' | 'afternoon' | 'tomorrow' | 'monday'
  label: string
  at: Date
}

function atLocal(base: Date, daysAhead: number, hour: number): Date {
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + daysAhead, hour, 0, 0, 0)
  return d
}

/** The quick choices, soonest first. See the header for the rules. */
export function schedulePresets(now: Date = new Date()): SchedulePreset[] {
  const out: SchedulePreset[] = []
  const inHour = new Date(now.getTime() + 60 * MINUTE_MS)
  inHour.setSeconds(0, 0)
  out.push({ key: 'hour', label: 'In an hour', at: inHour })

  // This afternoon at two, offered while it is still at least an hour away:
  // closer than that and "in an hour" already says it.
  const afternoon = atLocal(now, 0, 14)
  if (afternoon.getTime() - now.getTime() >= 60 * MINUTE_MS) {
    out.push({ key: 'afternoon', label: 'This afternoon', at: afternoon })
  }

  const tomorrow = atLocal(now, 1, 9)
  out.push({ key: 'tomorrow', label: 'Tomorrow morning', at: tomorrow })

  // Monday morning, when it is not simply tomorrow and not a week away.
  const daysUntilMonday = (8 - now.getDay()) % 7 || 7
  if (daysUntilMonday >= 2 && daysUntilMonday <= 6) {
    out.push({ key: 'monday', label: 'Monday morning', at: atLocal(now, daysUntilMonday, 9) })
  }
  return out
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

function timeOf(d: Date): string {
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })
}

/** "Today at 14:00" / "Tomorrow at 09:00" / "Mon at 09:00" / "Tue 21 Oct at
 *  09:00", or "Sending now" once the time has come and the cron has not yet
 *  run (it runs within the minute). */
export function sendAtLabel(at: Date | string, now: Date = new Date()): string {
  const d = at instanceof Date ? at : new Date(at)
  if (!Number.isFinite(d.getTime())) return ''
  if (d.getTime() <= now.getTime()) return 'Sending now'
  const days = Math.round((startOfDay(d) - startOfDay(now)) / 86_400_000)
  const time = timeOf(d)
  if (days === 0) return `Today at ${time}`
  if (days === 1) return `Tomorrow at ${time}`
  if (days > 1 && days < 7) return `${d.toLocaleDateString('en-GB', { weekday: 'short' })} at ${time}`
  const includeYear = d.getFullYear() !== now.getFullYear()
  const day = d.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(includeYear ? { year: 'numeric' } : {}),
  })
  return `${day} at ${time}`
}

/** Which conversation a waiting message belongs to. Always the author's own
 *  row, so the room or its recipient. */
export function scheduledThread(row: Pick<ScheduledMessage, 'recipient_id'>): ChatThread {
  return row.recipient_id ?? 'team'
}

/** The waiting messages for one conversation, soonest first. */
export function scheduledForThread(rows: ScheduledMessage[], thread: ChatThread): ScheduledMessage[] {
  return rows.filter((r) => scheduledThread(r) === thread).slice().sort(bySendAt)
}

export function bySendAt(a: ScheduledMessage, b: ScheduledMessage): number {
  if (a.send_at !== b.send_at) return a.send_at < b.send_at ? -1 : 1
  return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0
}

/** The soonest send time among the rows, or null with none. */
export function earliestDue(rows: ScheduledMessage[]): string | null {
  let best: string | null = null
  for (const r of rows) if (best === null || r.send_at < best) best = r.send_at
  return best
}

/** `YYYY-MM-DDTHH:MM` in local time, the value a `datetime-local` input
 *  takes. */
export function toLocalInputValue(d: Date): string {
  const pad = (n: number) => `${n}`.padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** The reverse: a `datetime-local` value as a Date, or null when it is not
 *  one. The browser hands the value back in local time with no zone, which
 *  is exactly what `new Date(y, m, d, h, mi)` takes. */
export function fromLocalInputValue(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value)
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0, 0)
  return Number.isFinite(d.getTime()) ? d : null
}
