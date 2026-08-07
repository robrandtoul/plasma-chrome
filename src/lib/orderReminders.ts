// The unpaid-order chase (send-order-reminders, migration 000238; cadence made
// admin-editable in 000270), as a shared decision.
//
// Lifted out of OrdersPage when the dashboard's Awaiting-payment rail panel
// needed to answer the same question — when does the next reminder go? — about
// the same orders. Two surfaces computing "next due" from the same ledger by
// two separate readings of the same rules is the exact drift this codebase has
// been bitten by before (the dashboard tile counts, twice). So the DECISION
// lives here and is made once; the two surfaces keep their own copy, because a
// full card and a 400px rail row have different room. That split mirrors
// orderTracking.ts, where the stage logic is shared and stageLabel/stageLine
// differ per surface.
//
// Pure module: no supabase, no React. Callers fetch and render.

const DAY_MS = 86_400_000

/**
 * The latest ledger row's meaning, when it was a skip / fail: a deliberate
 * 'pause' (grace window, follow-up tag — the chase is holding, fine) vs a
 * 'problem' (something is stopping it that may need a human).
 */
export interface ReminderNote {
  kind: 'pause' | 'problem'
  text: string
}

/** Per-order roll-up of the reminder ledger (order_nudges). */
export interface ReminderSummary {
  sentCount: number
  lastSentAt: string | null
  /** Highest reminder stage actually sent (drives "next reminder is N+1"). */
  highestSentNo: number
  /** Raw outcome of the latest run when it wasn't a send (else null). Turned
   *  into a note at render time, since the friendly text for a grace pause needs
   *  the proof's reply stamps + grace-days. */
  latestOutcome: string | null
}

/**
 * Admin-set chase cadence (settings, 000270) + whether the auto-chase is on.
 * Defaults mirror the edge function's fallbacks. graceDays is the shared
 * comms-grace knob (site_settings.needs_attention_rules
 * .helpscout_reply_grace_days) the order sender re-uses to pause after a reply.
 */
export interface ReminderCadence {
  max: number
  intervalDays: number
  autoEnabled: boolean
  graceDays: number
}

/** The reply stamps + grace days needed to explain a grace pause in full. */
export interface GraceContext {
  lastReplyAt: string | null
  lastCustomerReplyAt: string | null
  graceDays: number
}

export const DEFAULT_CADENCE: ReminderCadence = {
  max: 3,
  intervalDays: 3,
  autoEnabled: false,
  graceDays: 3,
}

/**
 * Read the cadence off the two settings rows, clamped to the same bounds the
 * admin form enforces. Either row missing falls back to the shipped defaults —
 * `autoEnabled` deliberately defaults FALSE, so a failed read can never make a
 * surface promise a reminder that nothing is going to send.
 */
export function readCadence(
  settings: { order_reminders_max?: unknown; order_reminder_interval_days?: unknown; auto_order_reminders_enabled?: unknown } | null,
  site: { needs_attention_rules?: unknown } | null,
): ReminderCadence {
  if (!settings) return DEFAULT_CADENCE
  const rules = (site?.needs_attention_rules ?? {}) as Record<string, unknown>
  const graceDays = Math.max(0, Number(rules['helpscout_reply_grace_days'] ?? 3))
  return {
    max: Math.min(5, Math.max(1, Number(settings.order_reminders_max ?? 3))),
    intervalDays: Math.min(30, Math.max(1, Number(settings.order_reminder_interval_days ?? 3))),
    autoEnabled: settings.auto_order_reminders_enabled === true,
    graceDays: Number.isFinite(graceDays) ? graceDays : 3,
  }
}

/** One raw ledger row, as selected from order_nudges. */
export interface NudgeLedgerRow {
  order_id: string
  reminder_no: number
  state: string
  outcome: string | null
  created_at: string
}

/**
 * Roll the ledger up per order. Takes the FULL ledger (not just sends) so a
 * skip or failure can surface rather than the chase just going quiet.
 */
export function summariseNudgeLedger(rows: NudgeLedgerRow[]): Record<string, ReminderSummary> {
  const byOrder = new Map<string, NudgeLedgerRow[]>()
  for (const n of rows) {
    const arr = byOrder.get(n.order_id) ?? []
    arr.push(n)
    byOrder.set(n.order_id, arr)
  }
  const map: Record<string, ReminderSummary> = {}
  for (const [orderId, list] of byOrder) {
    list.sort((a, b) => (a.created_at < b.created_at ? 1 : -1)) // newest first
    const sentRows = list.filter((r) => r.state === 'sent')
    const latest = list[0]
    const latestOutcome =
      latest && (latest.state === 'failed' || latest.state === 'skipped') ? latest.outcome : null
    map[orderId] = {
      sentCount: sentRows.length,
      lastSentAt: sentRows.length > 0 ? sentRows[0].created_at : null,
      highestSentNo: sentRows.reduce((m, r) => Math.max(m, r.reminder_no), 0),
      latestOutcome,
    }
  }
  return map
}

/**
 * Turn an order_nudges skip / fail outcome into one plain line for staff,
 * tagged pause vs problem. A successful / would-send outcome isn't either, so
 * returns null. For a grace pause, `grace` (when supplied) lets us name the
 * reply and date instead of the vague generic line.
 */
export function classifyReminderOutcome(outcome: string | null, grace?: GraceContext): ReminderNote | null {
  if (!outcome) return null
  if (outcome.startsWith('would_send') || outcome === 'sent' || outcome === 'sending') return null
  // Deliberate pauses — the chase is holding on purpose, not broken.
  if (outcome.includes('grace_window') || outcome.includes('recent_reply'))
    return graceNote(grace)
  if (outcome.includes('followup_tag'))
    return { kind: 'pause', text: 'Paused — the “follow up” tag is set on the Help Scout thread.' }
  // Problems — something is stopping the chase that may need a look.
  if (outcome.includes('no_conversation')) return { kind: 'problem', text: 'No Help Scout conversation linked — the reminder can’t send.' }
  if (outcome.includes('recipient_mismatch')) return { kind: 'problem', text: 'Contact email doesn’t match the Help Scout thread — not sent.' }
  if (outcome.includes('closed') || outcome.includes('conversation_missing')) return { kind: 'problem', text: 'Help Scout conversation is closed or missing — not sent.' }
  if (outcome.includes('unconfigured') || outcome.includes('no_base_url')) return { kind: 'problem', text: 'Reminder system isn’t fully configured — not sent.' }
  if (outcome.startsWith('render_failed')) return { kind: 'problem', text: 'Reminder template problem — not sent.' }
  if (outcome.startsWith('failed')) return { kind: 'problem', text: 'Help Scout rejected the last reminder — not sent.' }
  return { kind: 'problem', text: 'The last reminder didn’t send.' }
}

/**
 * Build the friendly grace-pause line. The chase pauses whenever EITHER stamp
 * (staff OR customer reply) lands within the grace window — same `Math.max` the
 * sender uses — so name whichever is newest and show when the pause lifts.
 * Returns null when the window has already cleared (so the caller shows its
 * normal next-due line instead of a stale pause), falling back to the vague line
 * only when the stamps are missing.
 */
export function graceNote(grace?: GraceContext, now: number = Date.now()): ReminderNote | null {
  const FALLBACK: ReminderNote = { kind: 'pause', text: 'Paused — recent reply on the Help Scout thread.' }
  if (!grace) return FALLBACK
  const staffMs = grace.lastReplyAt ? Date.parse(grace.lastReplyAt) : -Infinity
  const customerMs = grace.lastCustomerReplyAt ? Date.parse(grace.lastCustomerReplyAt) : -Infinity
  const newest = Math.max(staffMs, customerMs)
  if (!Number.isFinite(newest)) return FALLBACK
  const clearsMs = newest + grace.graceDays * DAY_MS
  if (clearsMs <= now) return null // window cleared — no longer paused
  // customer wins ties: a customer reply is the more meaningful signal to show.
  const fromCustomer = customerMs >= staffMs
  const who = fromCustomer ? 'the customer replied' : 'a reply was sent'
  return {
    kind: 'pause',
    text: `Paused — ${who} on the thread on ${formatDay(newest)}. Resumes ${formatDay(clearsMs)}.`,
  }
}

// Byte-for-byte the `formatDate` OrdersPage renders dates with ("04 Aug 2026").
// This text goes into a sentence the Orders card already shows, so it must not
// drift into a different date register just because the function moved.
function formatDay(ms: number): string {
  return new Date(ms).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

export interface ReminderStateInput {
  sentAt: string | null
  expiresAt: string | null
  /** The link's window has passed — the chase stops regardless of cadence. */
  expired: boolean
  /** A member of a live combined payment: the sender skips it (its own link
   *  isn't payable), so no reminder is coming for this order at all. */
  inActiveGroup: boolean
  summary: ReminderSummary | null
  cadence: ReminderCadence
  grace: GraceContext
}

/**
 * What is happening with this order's automatic chase, as one decision.
 *
 * `next` is a discriminated union rather than a string so each surface can word
 * it for its own space. The order of the branches IS the contract — it mirrors
 * what the Orders card has always rendered:
 *
 *   grouped  → nothing is chasing a grouped member, whatever the ledger says
 *   note     → a live pause or a problem outranks the schedule; a chase that is
 *              being held must never be reported as "due Tuesday"
 *   all-sent → the cap is spent
 *   due-now  → the clock has passed; it goes on the next working-day run
 *   due-at   → a real date
 *   off      → auto-chase disabled and nothing ever sent
 *   none     → nothing honest to say (e.g. auto off but reminders were sent by
 *              hand, or the next one would land after the link expires)
 */
export function reminderState(input: ReminderStateInput): {
  sentCount: number
  max: number
  lastSentAt: string | null
  next:
    | { kind: 'grouped' }
    | { kind: 'note'; note: ReminderNote }
    | { kind: 'all-sent' }
    | { kind: 'due-now'; no: number }
    | { kind: 'due-at'; no: number; at: string }
    | { kind: 'off' }
    | { kind: 'none' }
} {
  const { summary, cadence, grace, expired, expiresAt, sentAt, inActiveGroup } = input
  const sentCount = summary?.sentCount ?? 0
  const highestNo = summary?.highestSentNo ?? 0
  const base = { sentCount, max: cadence.max, lastSentAt: summary?.lastSentAt ?? null }

  if (inActiveGroup) return { ...base, next: { kind: 'grouped' } }

  const note = classifyReminderOutcome(summary?.latestOutcome ?? null, grace)
  if (note) return { ...base, next: { kind: 'note', note } }

  if (highestNo >= cadence.max) return { ...base, next: { kind: 'all-sent' } }

  // Same arithmetic the edge function decides by: reminder (highestSent + 1) is
  // due once that many intervals have passed since the link was sent, while the
  // link is still live.
  if (!expired && cadence.autoEnabled && sentAt) {
    const no = highestNo + 1
    const dueAtMs = new Date(sentAt).getTime() + no * cadence.intervalDays * DAY_MS
    const expMs = expiresAt ? new Date(expiresAt).getTime() : null
    if (expMs != null && dueAtMs >= expMs) {
      // Would fall after the link expires — the chase won't fire, so promising
      // a date would be a lie.
      return { ...base, next: { kind: 'none' } }
    }
    if (dueAtMs <= Date.now()) return { ...base, next: { kind: 'due-now', no } }
    return { ...base, next: { kind: 'due-at', no, at: new Date(dueAtMs).toISOString() } }
  }

  if (!cadence.autoEnabled && sentCount === 0) return { ...base, next: { kind: 'off' } }
  return { ...base, next: { kind: 'none' } }
}

/**
 * The compact one-liner for the dashboard rail, where there is room for a
 * single short clause under the row's opened-state line. The Orders card words
 * the same state at greater length; keep them consistent in MEANING, not text.
 *
 * Returns null when there is nothing worth a line, so a row stays two lines
 * rather than growing an empty third.
 */
export function reminderShortLine(state: ReturnType<typeof reminderState>): string | null {
  const { next, max } = state
  switch (next.kind) {
    case 'grouped':
      return 'Combined — no reminders'
    case 'note':
      // The full sentence goes in a title attribute; a rail row has no space
      // for "Paused — the customer replied on the thread on 4 August."
      return next.note.kind === 'problem' ? 'Chase stopped' : 'Chase paused'
    case 'all-sent':
      return `All ${max} reminder${max === 1 ? '' : 's'} sent`
    case 'due-now':
      return `Reminder ${next.no} of ${max} · next run`
    case 'due-at':
      return `Reminder ${next.no} of ${max} · ${formatShortDay(next.at)}`
    case 'off':
      return 'Reminders off'
    case 'none':
      return null
  }
}

// "9 Aug" — short enough to sit beside the reminder number in a rail row.
function formatShortDay(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}
