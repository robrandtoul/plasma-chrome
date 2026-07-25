// Unit tests for ordersTriage.ts
// Run with: npx tsx src/lib/ordersTriage.test.ts
//
// The Orders page collapses everything the automatic chaser is handling into a
// closed WAITING block. That is only safe if the split is exhaustive: the point
// of these tests is the COMPLEMENT property — over every combination of inputs,
// a row lands in exactly one bucket, never both and never neither. A gap here
// means a job hides in a collapsed section and a customer waits on cards nobody
// is making.

import {
  needsHumanChase,
  chaseReason,
  splitByChaseNeed,
  groupNeedsAttention,
  type TriageOrder,
} from './ordersTriage'

let passed = 0
let failed = 0

function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (err) {
    console.log(`  ✗ ${name}`)
    console.log(`    ${(err as Error).message}`)
    failed++
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message)
}

function assertEqual<T>(actual: T, expected: T, message?: string) {
  if (actual !== expected) {
    throw new Error(message ?? `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

const order = (o: Partial<TriageOrder> = {}): TriageOrder => ({
  expired: false,
  remindersSent: 0,
  askedForHelp: false,
  ...o,
})

const MAX = 3

console.log('\nordersTriage')

// ── The core promise: a healthy link is not work ─────────────────────────────

test('a freshly sent link with no reminders yet is waiting, not work', () => {
  assertEqual(needsHumanChase(order(), MAX), false)
})

test('a link mid-cadence is still waiting — the robot has it', () => {
  assertEqual(needsHumanChase(order({ remindersSent: 1 }), MAX), false)
  assertEqual(needsHumanChase(order({ remindersSent: MAX - 1 }), MAX), false)
})

// ── The three escalations ───────────────────────────────────────────────────

test('an expired link needs a human', () => {
  assertEqual(needsHumanChase(order({ expired: true }), MAX), true)
})

test('a spent cadence needs a human, at the cap and beyond it', () => {
  assertEqual(needsHumanChase(order({ remindersSent: MAX }), MAX), true)
  assertEqual(needsHumanChase(order({ remindersSent: MAX + 5 }), MAX), true)
})

test('a customer question needs a human even on a perfectly healthy link', () => {
  assertEqual(needsHumanChase(order({ askedForHelp: true }), MAX), true)
})

// ── The complement property, exhaustively ────────────────────────────────────

test('every input combination lands in exactly one bucket', () => {
  const all: TriageOrder[] = []
  for (const expired of [false, true]) {
    for (const askedForHelp of [false, true]) {
      // 0 .. MAX+1 covers below, at, and past the cap.
      for (let remindersSent = 0; remindersSent <= MAX + 1; remindersSent++) {
        all.push({ expired, remindersSent, askedForHelp })
      }
    }
  }
  const { needsYou, waiting } = splitByChaseNeed(all, (o) => o, MAX)
  assertEqual(
    needsYou.length + waiting.length,
    all.length,
    'every row must appear in exactly one bucket — none dropped, none duplicated',
  )
  // And no row appears in both (object identity makes this exact).
  for (const o of needsYou) {
    assert(!waiting.includes(o), `row in both buckets: ${JSON.stringify(o)}`)
  }
  // The only rows in `waiting` are ones with no escalation at all.
  for (const o of waiting) {
    assert(
      !o.expired && !o.askedForHelp && o.remindersSent < MAX,
      `a row with an escalation was left in waiting: ${JSON.stringify(o)}`,
    )
  }
})

test('splitByChaseNeed preserves input order within each bucket', () => {
  const rows = [
    { id: 'a', t: order() },
    { id: 'b', t: order({ expired: true }) },
    { id: 'c', t: order() },
    { id: 'd', t: order({ askedForHelp: true }) },
  ]
  const { needsYou, waiting } = splitByChaseNeed(rows, (r) => r.t, MAX)
  assertEqual(needsYou.map((r) => r.id).join(''), 'bd')
  assertEqual(waiting.map((r) => r.id).join(''), 'ac')
})

test('an empty list splits into two empty buckets, not undefined', () => {
  const { needsYou, waiting } = splitByChaseNeed([], (o: TriageOrder) => o, MAX)
  assertEqual(needsYou.length, 0)
  assertEqual(waiting.length, 0)
})

// ── Reason wording ──────────────────────────────────────────────────────────

test('a customer question outranks our own chase mechanics in the reason', () => {
  // All three escalations at once: the customer is owed a reply, so that wins.
  assertEqual(
    chaseReason(order({ expired: true, remindersSent: MAX, askedForHelp: true }), MAX),
    'Asked us a question from the pay page',
  )
})

test('expiry outranks a spent cadence', () => {
  assertEqual(chaseReason(order({ expired: true, remindersSent: MAX }), MAX), 'Pay link expired')
})

test('the exhausted-cadence reason quotes the configured cap, not a hardcoded 3', () => {
  assertEqual(chaseReason(order({ remindersSent: 5 }), 5), 'All 5 reminders sent, still unpaid')
})

test('every escalated row gets a non-empty reason', () => {
  for (const o of [
    order({ expired: true }),
    order({ remindersSent: MAX }),
    order({ askedForHelp: true }),
  ]) {
    assert(chaseReason(o, MAX).length > 0, `no reason for ${JSON.stringify(o)}`)
  }
})

// ── Combined payments ───────────────────────────────────────────────────────

test('a group with no expiry never needs attention', () => {
  assertEqual(groupNeedsAttention(null), false)
})

test('a group past its expiry needs attention; one in date does not', () => {
  const now = Date.parse('2026-07-25T12:00:00Z')
  assertEqual(groupNeedsAttention('2026-07-24T12:00:00Z', now), true)
  assertEqual(groupNeedsAttention('2026-07-26T12:00:00Z', now), false)
})

test('expiry is exclusive at the boundary — the instant it lapses it is not yet late', () => {
  const now = Date.parse('2026-07-25T12:00:00Z')
  assertEqual(groupNeedsAttention('2026-07-25T12:00:00Z', now), false)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
