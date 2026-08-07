// Unit tests for orderReminders.ts
// Run with: npx tsx src/lib/orderReminders.test.ts
//
// This module exists because two surfaces now answer "when does the next
// reminder go?" about the same order — the Orders card and the dashboard's
// Awaiting-payment rail panel. What is worth pinning is therefore the DECISION,
// not either surface's wording:
//
//   1. the branch ORDER. A paused or broken chase must never be reported as
//      "due Tuesday", and a grouped member must never be reported as due at all
//      — the sender skips it, so no reminder is coming however healthy the
//      ledger looks.
//   2. the due arithmetic, which mirrors send-order-reminders: reminder
//      (highestSent + 1) is due once that many intervals have passed since the
//      link was SENT — not since the last reminder.
//   3. the two silences. A next reminder that would land after the link expires
//      is not promised, and neither is anything once the cap is spent.
//   4. readCadence defaulting autoEnabled to FALSE, so a failed settings read
//      can never make a surface promise a reminder nothing will send.

import {
  DEFAULT_CADENCE,
  classifyReminderOutcome,
  graceNote,
  readCadence,
  reminderShortLine,
  reminderState,
  summariseNudgeLedger,
  type ReminderCadence,
  type ReminderStateInput,
  type ReminderSummary,
} from './orderReminders.ts'

let passed = 0
let failed = 0

function test(name: string, fn: () => void) {
  try { fn(); console.log(`  ✓ ${name}`); passed++ }
  catch (err) { console.log(`  ✗ ${name}`); console.log(`    ${(err as Error).message}`); failed++ }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message)
}

function assertEquals(actual: unknown, expected: unknown, message: string) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`${message}\n      expected: ${e}\n      actual:   ${a}`)
}

const NOW = Date.now()
const DAY = 86_400_000
const daysAgo = (n: number) => new Date(NOW - n * DAY).toISOString()
const daysAhead = (n: number) => new Date(NOW + n * DAY).toISOString()

const CADENCE: ReminderCadence = { max: 3, intervalDays: 3, autoEnabled: true, graceDays: 3 }

function summary(over: Partial<ReminderSummary> = {}): ReminderSummary {
  return { sentCount: 0, lastSentAt: null, highestSentNo: 0, latestOutcome: null, ...over }
}

function input(over: Partial<ReminderStateInput> = {}): ReminderStateInput {
  return {
    sentAt: daysAgo(1),
    expiresAt: daysAhead(13),
    expired: false,
    inActiveGroup: false,
    summary: summary(),
    cadence: CADENCE,
    grace: { lastReplyAt: null, lastCustomerReplyAt: null, graceDays: 3 },
    ...over,
  }
}

console.log('\nreminderState — the due arithmetic')

test('reminder 1 is due one interval after the link was SENT', () => {
  // Sent 1 day ago on a 3-day interval → still 2 days out.
  const s = reminderState(input())
  assertEquals(s.next.kind, 'due-at', 'a real date')
  if (s.next.kind !== 'due-at') return
  assertEquals(s.next.no, 1, 'the first reminder')
  const days = Math.round((Date.parse(s.next.at) - NOW) / DAY)
  assertEquals(days, 2, 'three days after send, i.e. two from now')
})

test('the clock runs from the SEND, not from the last reminder', () => {
  // One reminder sent yesterday, link sent 5 days ago. Reminder 2 is due at
  // send + 6 days = 1 day away — NOT 3 days after yesterday's reminder.
  const s = reminderState(input({ sentAt: daysAgo(5), summary: summary({ sentCount: 1, highestSentNo: 1, lastSentAt: daysAgo(1) }) }))
  if (s.next.kind !== 'due-at') throw new Error(`expected due-at, got ${s.next.kind}`)
  assertEquals(s.next.no, 2, 'the second reminder')
  assertEquals(Math.round((Date.parse(s.next.at) - NOW) / DAY), 1, 'send + 2 intervals')
})

test('a due time already passed goes on the next working-day run', () => {
  const s = reminderState(input({ sentAt: daysAgo(9) }))
  assertEquals(s.next, { kind: 'due-now', no: 1 }, 'overdue reminders wait for the cron, not a date')
})

console.log('\nreminderState — the silences')

test('nothing is promised once the cap is spent', () => {
  const s = reminderState(input({ summary: summary({ sentCount: 3, highestSentNo: 3 }) }))
  assertEquals(s.next.kind, 'all-sent', 'the chase is over')
})

test('⚠ a reminder that would land after the link expires is not promised', () => {
  // Sent 1 day ago, expires tomorrow: reminder 1 would fall on day 3, past it.
  const s = reminderState(input({ sentAt: daysAgo(1), expiresAt: daysAhead(1) }))
  assertEquals(s.next.kind, 'none', 'the chase will not fire, so no date is offered')
})

test('an expired link promises nothing', () => {
  const s = reminderState(input({ expired: true, expiresAt: daysAgo(1) }))
  assertEquals(s.next.kind, 'none', 'a dead link is not chased')
})

test('auto-chase off with nothing sent says so; off after manual sends stays quiet', () => {
  const off = { ...CADENCE, autoEnabled: false }
  assertEquals(reminderState(input({ cadence: off })).next.kind, 'off', 'nothing sent — say it is off')
  assertEquals(
    reminderState(input({ cadence: off, summary: summary({ sentCount: 1, highestSentNo: 1 }) })).next.kind,
    'none',
    'reminders were sent by hand — "off" would misdescribe the history',
  )
})

console.log('\nreminderState — branch order is the contract')

test('⚠ a grouped member is never reported as due, however healthy the ledger', () => {
  const s = reminderState(input({ inActiveGroup: true, sentAt: daysAgo(9) }))
  assertEquals(s.next.kind, 'grouped', 'the sender skips grouped members entirely')
})

test('⚠ a live pause outranks the schedule', () => {
  // Overdue by the clock, but the customer replied yesterday.
  const s = reminderState(input({
    sentAt: daysAgo(9),
    summary: summary({ latestOutcome: 'skipped_grace_window' }),
    grace: { lastReplyAt: null, lastCustomerReplyAt: daysAgo(1), graceDays: 3 },
  }))
  assertEquals(s.next.kind, 'note', 'a held chase must not read as "due now"')
  if (s.next.kind === 'note') assertEquals(s.next.note.kind, 'pause', 'and it is a pause, not a fault')
})

test('a problem outranks the schedule too, and is tagged as a fault', () => {
  const s = reminderState(input({ sentAt: daysAgo(9), summary: summary({ latestOutcome: 'skipped_no_conversation' }) }))
  if (s.next.kind !== 'note') throw new Error(`expected note, got ${s.next.kind}`)
  assertEquals(s.next.note.kind, 'problem', 'someone has to fix this one')
})

test('⚠ a CLEARED grace pause falls through to the schedule', () => {
  // The stale outcome is still the newest ledger row, but the window has
  // lapsed — reporting "paused" forever would be a lie.
  const s = reminderState(input({
    sentAt: daysAgo(9),
    summary: summary({ latestOutcome: 'skipped_grace_window' }),
    grace: { lastReplyAt: null, lastCustomerReplyAt: daysAgo(30), graceDays: 3 },
  }))
  assertEquals(s.next.kind, 'due-now', 'the pause expired, so the schedule resumes')
})

test('the cap outranks the schedule', () => {
  const s = reminderState(input({ sentAt: daysAgo(30), summary: summary({ sentCount: 3, highestSentNo: 3 }) }))
  assertEquals(s.next.kind, 'all-sent', 'never offer a fourth of three')
})

console.log('\nsummariseNudgeLedger')

test('counts only real sends, and reads the cap off the highest stage', () => {
  const s = summariseNudgeLedger([
    { order_id: 'o1', reminder_no: 1, state: 'sent', outcome: 'sent', created_at: daysAgo(6) },
    { order_id: 'o1', reminder_no: 2, state: 'skipped', outcome: 'skipped_grace_window', created_at: daysAgo(1) },
    { order_id: 'o1', reminder_no: 1, state: 'dry_run', outcome: 'would_send', created_at: daysAgo(8) },
  ])
  assertEquals(s.o1.sentCount, 1, 'dry runs and skips are not sends')
  assertEquals(s.o1.highestSentNo, 1, 'a skipped stage 2 has not been sent')
  assertEquals(s.o1.lastSentAt, daysAgo(6), 'the newest real send')
  assertEquals(s.o1.latestOutcome, 'skipped_grace_window', 'the newest row explains the current state')
})

test('a latest row that succeeded reports no outcome to explain', () => {
  const s = summariseNudgeLedger([
    { order_id: 'o1', reminder_no: 1, state: 'skipped', outcome: 'skipped_capped', created_at: daysAgo(9) },
    { order_id: 'o1', reminder_no: 2, state: 'sent', outcome: 'sent', created_at: daysAgo(1) },
  ])
  assertEquals(s.o1.latestOutcome, null, 'a send is not a problem needing a line')
})

test('orders are kept apart', () => {
  const s = summariseNudgeLedger([
    { order_id: 'a', reminder_no: 1, state: 'sent', outcome: 'sent', created_at: daysAgo(2) },
    { order_id: 'b', reminder_no: 2, state: 'sent', outcome: 'sent', created_at: daysAgo(1) },
  ])
  assertEquals([s.a.highestSentNo, s.b.highestSentNo], [1, 2], 'no cross-contamination')
})

console.log('\nreadCadence')

test('clamps to the bounds the admin form enforces', () => {
  const c = readCadence({ order_reminders_max: 99, order_reminder_interval_days: 0, auto_order_reminders_enabled: true }, null)
  assertEquals([c.max, c.intervalDays], [5, 1], 'max 5, interval at least 1')
})

test('⚠ a missing settings row defaults auto-chase to OFF', () => {
  // The dangerous default is the other way: a failed read must not make a
  // surface promise a reminder that nothing is going to send.
  assertEquals(readCadence(null, null), DEFAULT_CADENCE, 'shipped defaults')
  assertEquals(DEFAULT_CADENCE.autoEnabled, false, 'and those default to off')
})

test('the grace window comes off the shared needs-attention rules', () => {
  const c = readCadence({ order_reminders_max: 3, order_reminder_interval_days: 3, auto_order_reminders_enabled: true },
    { needs_attention_rules: { helpscout_reply_grace_days: 7 } })
  assertEquals(c.graceDays, 7, 'the proof chase and the order chase share one knob')
  assertEquals(readCadence({ auto_order_reminders_enabled: true }, { needs_attention_rules: {} }).graceDays, 3, 'default 3')
})

console.log('\ngraceNote')

test('names whichever reply is newest, customer winning ties', () => {
  const n = graceNote({ lastReplyAt: daysAgo(2), lastCustomerReplyAt: daysAgo(1), graceDays: 3 }, NOW)
  assert(n != null && n.text.includes('the customer replied'), 'the customer reply is the meaningful signal')
  const staff = graceNote({ lastReplyAt: daysAgo(1), lastCustomerReplyAt: daysAgo(2), graceDays: 3 }, NOW)
  assert(staff != null && staff.text.includes('a reply was sent'), 'ours when ours is newer')
})

test('returns null once the window has cleared', () => {
  assertEquals(graceNote({ lastReplyAt: daysAgo(30), lastCustomerReplyAt: null, graceDays: 3 }, NOW), null, 'not paused any more')
})

test('falls back to the vague line when the stamps are missing', () => {
  const n = graceNote({ lastReplyAt: null, lastCustomerReplyAt: null, graceDays: 3 }, NOW)
  assert(n != null && n.kind === 'pause', 'still a pause, just unnameable')
})

console.log('\nclassifyReminderOutcome')

test('a send or a dry run is neither pause nor problem', () => {
  assertEquals(classifyReminderOutcome('sent'), null, 'nothing to report')
  assertEquals(classifyReminderOutcome('would_send_reminder_1'), null, 'a dry run is not a fault')
  assertEquals(classifyReminderOutcome(null), null, 'no outcome, no line')
})

test('a follow-up tag is a deliberate pause, not a fault', () => {
  const n = classifyReminderOutcome('skipped_followup_tag')
  assertEquals(n?.kind, 'pause', 'a human flagged the thread on purpose')
})

test('an unrecognised skip is treated as a problem rather than ignored', () => {
  const n = classifyReminderOutcome('skipped_something_new')
  assertEquals(n?.kind, 'problem', 'silence about an unknown stall is the worse failure')
})

console.log('\nreminderShortLine — the rail wording')

test('answers the question in one clause', () => {
  const due = reminderState(input({ sentAt: daysAgo(1) }))
  const line = reminderShortLine(due)
  assert(line != null && line.startsWith('Reminder 1 of 3 · '), `got "${line}"`)
  assertEquals(reminderShortLine(reminderState(input({ sentAt: daysAgo(9) }))), 'Reminder 1 of 3 · next run', 'overdue')
})

test('says nothing when there is nothing honest to say', () => {
  // A third line that reads "—" is worse than a two-line row.
  assertEquals(reminderShortLine(reminderState(input({ expired: true }))), null, 'no empty filler')
})

test('covers every state the decision can return', () => {
  const cases: Array<[Partial<ReminderStateInput>, string]> = [
    [{ inActiveGroup: true }, 'Combined — no reminders'],
    [{ summary: summary({ sentCount: 3, highestSentNo: 3 }) }, 'All 3 reminders sent'],
    [{ cadence: { ...CADENCE, autoEnabled: false } }, 'Reminders off'],
    [{ summary: summary({ latestOutcome: 'skipped_no_conversation' }) }, 'Chase stopped'],
  ]
  for (const [over, expected] of cases) {
    assertEquals(reminderShortLine(reminderState(input(over))), expected, `state → "${expected}"`)
  }
})

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
