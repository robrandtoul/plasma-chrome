// Unit tests for supplierProof.ts
// Run with: npx tsx src/lib/supplierProof.test.ts   (or pnpm test:supplier-proof)
//
// The Orders page puts two of these states at the top as work and hides the rest
// in a collapsed block or the archive. That is only safe if the states are TOTAL
// and DISJOINT — every order gets exactly one, never two, never none. A gap here
// means a supplier is sitting on an unapproved proof while the card reads
// "ordered", which is the exact failure this feature exists to prevent.
//
// The other load-bearing case is the re-proof: QX routinely sends an updated
// proof hours after the first, sometimes after we have already approved. If that
// doesn't re-flag the card, we ship the wrong artwork.

import {
  supplierProofState,
  isSupplierProofWork,
  workingDaysBetween,
  overdueReason,
  waitingFor,
  splitBySupplierProof,
  type SupplierProofOrder,
  type SupplierProofState,
} from './supplierProof'

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

// Wed 12 Aug 2026, midday. (Sat 8th / Sun 9th are the weekend used below.)
const NOW = new Date('2026-08-12T12:00:00Z')
const OPTS = { overdueWorkingDays: 1, now: NOW }

/** A placed supplier order, emailed this morning, nothing back yet. */
const order = (o: Partial<SupplierProofOrder> = {}): SupplierProofOrder => ({
  status: 'fulfilled',
  supplierEmailSentAt: '2026-08-12T08:00:00Z',
  supplierConversationId: 'conv-1',
  supplierReplyAt: null,
  approvedAt: null,
  ...o,
})

const state = (o: Partial<SupplierProofOrder> = {}, opts = OPTS) => supplierProofState(order(o), opts)

console.log('\nsupplierProof')

// ── Who is in the pen at all ────────────────────────────────────────────────
// Keyed off the supplier EMAIL, not the material route — see the comment on
// inPen(). These four are the exclusions that buys us for free.

test('an in-house order is not in the pen (no supplier email was ever sent)', () => {
  assertEqual(state({ supplierEmailSentAt: null }), 'none')
})

test('a blanks-sourced order is not in the pen — supplier material, no supplier email', () => {
  // 000382: its blanks ride a sibling order's batch and its message is the
  // workshop note. Judged by material alone it would wait forever for a proof
  // from a supplier nobody emailed.
  assertEqual(state({ supplierEmailSentAt: null, supplierConversationId: null }), 'none')
})

test('an order with no supplier thread is not in the pen — nothing can reply to us', () => {
  assertEqual(state({ supplierConversationId: null }), 'none')
})

test('only a PLACED order is in the pen', () => {
  for (const status of ['draft', 'sent', 'paid', 'expired', 'cancelled', 'revision']) {
    assertEqual(state({ status }), 'none', `status ${status} should not be in the pen`)
  }
  assertEqual(state({ status: 'fulfilled' }), 'awaiting')
})

test('an order cancelled after placement drops out of the pen', () => {
  // It was emailed and the supplier replied — but the job is off, so it must not
  // sit in CHECK asking someone to approve artwork for a dead order.
  assertEqual(state({ status: 'cancelled', supplierReplyAt: '2026-08-12T10:00:00Z' }), 'none')
})

// ── The happy path ──────────────────────────────────────────────────────────

test('emailed, nothing back yet, same day → awaiting (not work)', () => {
  assertEqual(state(), 'awaiting')
  assertEqual(isSupplierProofWork('awaiting'), false)
})

test('the first proof arriving → to_check (work)', () => {
  assertEqual(state({ supplierReplyAt: '2026-08-12T10:00:00Z' }), 'to_check')
  assertEqual(isSupplierProofWork('to_check'), true)
})

test('approved, nothing since → approved (off to the archive)', () => {
  assertEqual(
    state({ supplierReplyAt: '2026-08-12T10:00:00Z', approvedAt: '2026-08-12T11:00:00Z' }),
    'approved',
  )
  assertEqual(isSupplierProofWork('approved'), false)
})

// ── The re-proof — the case that makes this a comparison, not a flag ─────────

test('an UPDATED proof after approval re-flags the card', () => {
  // Live shape: ORD-9F10EAFD92 got a proof at +0.4h and an updated one at +22.3h.
  assertEqual(
    state({ supplierReplyAt: '2026-08-12T11:30:00Z', approvedAt: '2026-08-12T11:00:00Z' }),
    'to_check',
    'a proof newer than the approval must come back as work',
  )
})

test('a reply at exactly the approval instant does NOT re-flag', () => {
  // Strictly-newer, so the approval reply landing on the same timestamp as the
  // stamp can never bounce the card straight back into CHECK.
  assertEqual(
    state({ supplierReplyAt: '2026-08-12T11:00:00Z', approvedAt: '2026-08-12T11:00:00Z' }),
    'approved',
  )
})

test('an older reply than the approval stays approved', () => {
  assertEqual(
    state({ supplierReplyAt: '2026-08-12T09:00:00Z', approvedAt: '2026-08-12T11:00:00Z' }),
    'approved',
  )
})

// ── Cleared without replying ────────────────────────────────────────────────

test('cleared without replying (approved, no reply ever) → approved, not overdue', () => {
  // The escape hatch for an approval already sent by hand in Help Scout, and for
  // suppliers who acknowledge rather than proof. It must NOT read as silence.
  assertEqual(
    state({ supplierReplyAt: null, approvedAt: '2026-08-12T11:00:00Z', supplierEmailSentAt: '2026-08-03T08:00:00Z' }),
    'approved',
  )
})

// ── The hole this feature exists to close ───────────────────────────────────

test('silence past the threshold → overdue (work)', () => {
  // Emailed Mon 10th, it is now Wed 12th: 2 working days of silence.
  assertEqual(state({ supplierEmailSentAt: '2026-08-10T08:00:00Z' }), 'overdue')
  assertEqual(isSupplierProofWork('overdue'), true)
})

test('the threshold is configurable and respected', () => {
  const sent = { supplierEmailSentAt: '2026-08-11T08:00:00Z' } // Tue → 1 working day
  assertEqual(state(sent, { overdueWorkingDays: 1, now: NOW }), 'overdue')
  assertEqual(state(sent, { overdueWorkingDays: 2, now: NOW }), 'awaiting')
  assertEqual(state(sent, { overdueWorkingDays: 5, now: NOW }), 'awaiting')
})

test('a weekend does not make an order overdue', () => {
  // Emailed Fri 7th; on Mon 10th that is ONE working day, not three. Without
  // weekend-skipping, every Friday order would be a Monday-morning false alarm.
  const monday = new Date('2026-08-10T09:00:00Z')
  assertEqual(
    supplierProofState(order({ supplierEmailSentAt: '2026-08-07T16:00:00Z' }), { overdueWorkingDays: 2, now: monday }),
    'awaiting',
  )
})

// ── workingDaysBetween, directly ────────────────────────────────────────────

test('workingDaysBetween is exclusive of start, inclusive of end (business_days_between semantics)', () => {
  const d = (s: string) => new Date(`${s}T00:00:00Z`)
  assertEqual(workingDaysBetween(d('2026-08-12'), d('2026-08-12')), 0, 'same day = 0')
  assertEqual(workingDaysBetween(d('2026-08-11'), d('2026-08-12')), 1, 'Tue→Wed = 1')
  assertEqual(workingDaysBetween(d('2026-08-10'), d('2026-08-12')), 2, 'Mon→Wed = 2')
})

test('workingDaysBetween skips the weekend', () => {
  const d = (s: string) => new Date(`${s}T00:00:00Z`)
  assertEqual(workingDaysBetween(d('2026-08-07'), d('2026-08-10')), 1, 'Fri→Mon = 1 working day')
  assertEqual(workingDaysBetween(d('2026-08-07'), d('2026-08-09')), 0, 'Fri→Sun = 0 working days')
  assertEqual(workingDaysBetween(d('2026-08-06'), d('2026-08-13')), 5, 'Thu→Thu across a weekend = 5')
})

test('workingDaysBetween never goes negative on a clock skew', () => {
  const d = (s: string) => new Date(`${s}T00:00:00Z`)
  assertEqual(workingDaysBetween(d('2026-08-12'), d('2026-08-10')), 0)
})

// ── The totality + disjointness property, exhaustively ──────────────────────

test('every input combination lands in exactly one state', () => {
  const all: SupplierProofOrder[] = []
  for (const status of ['fulfilled', 'paid', 'cancelled', 'revision']) {
    for (const supplierEmailSentAt of [null, '2026-08-12T08:00:00Z', '2026-08-03T08:00:00Z']) {
      for (const supplierConversationId of [null, 'conv-1']) {
        for (const supplierReplyAt of [null, '2026-08-12T09:00:00Z', '2026-08-12T11:30:00Z']) {
          for (const approvedAt of [null, '2026-08-12T11:00:00Z']) {
            all.push({ status, supplierEmailSentAt, supplierConversationId, supplierReplyAt, approvedAt })
          }
        }
      }
    }
  }

  const buckets = splitBySupplierProof(all, (o) => o, OPTS)
  const total =
    buckets.toCheck.length + buckets.awaiting.length + buckets.overdue.length +
    buckets.approved.length + buckets.none.length
  assertEqual(total, all.length, 'every row must appear in exactly one bucket — none dropped, none duplicated')

  // Object identity makes "in two buckets" exactly checkable.
  const lists = [buckets.toCheck, buckets.awaiting, buckets.overdue, buckets.approved, buckets.none]
  for (let i = 0; i < lists.length; i++) {
    for (let j = i + 1; j < lists.length; j++) {
      for (const o of lists[i]) {
        assert(!lists[j].includes(o), `row in two buckets: ${JSON.stringify(o)}`)
      }
    }
  }

  // And the state function itself always answers with a known state.
  const known: SupplierProofState[] = ['none', 'to_check', 'awaiting', 'overdue', 'approved']
  for (const o of all) {
    assert(known.includes(supplierProofState(o, OPTS)), `unknown state for ${JSON.stringify(o)}`)
  }
})

test('nothing outside the pen is ever work', () => {
  // The safety direction that matters: a row we decided not to show must be one
  // that genuinely needs nobody — never a supplier order quietly dropped.
  for (const status of ['draft', 'sent', 'paid', 'expired', 'cancelled', 'revision']) {
    assertEqual(isSupplierProofWork(state({ status, supplierReplyAt: '2026-08-12T11:00:00Z' })), false)
  }
})

test('a placed, emailed, unanswered order is ALWAYS visible somewhere', () => {
  // awaiting or overdue, never 'none' — the one thing that would recreate the
  // original hole is a placed supplier order that appears nowhere at all.
  for (const days of [0, 1, 3, 10, 40]) {
    const sent = new Date(NOW.getTime() - days * 86_400_000).toISOString()
    const s = state({ supplierEmailSentAt: sent })
    assert(s === 'awaiting' || s === 'overdue', `unanswered order after ${days}d resolved to ${s}`)
  }
})

test('splitBySupplierProof preserves input order within each bucket', () => {
  const rows = [
    { id: 'a', o: order() },
    { id: 'b', o: order({ supplierReplyAt: '2026-08-12T10:00:00Z' }) },
    { id: 'c', o: order() },
    { id: 'd', o: order({ supplierReplyAt: '2026-08-12T10:30:00Z' }) },
  ]
  const b = splitBySupplierProof(rows, (r) => r.o, OPTS)
  assertEqual(b.toCheck.map((r) => r.id).join(''), 'bd')
  assertEqual(b.awaiting.map((r) => r.id).join(''), 'ac')
})

// ── Copy helpers ────────────────────────────────────────────────────────────

test('overdueReason names the supplier and pluralises the days', () => {
  assertEqual(overdueReason('QX Metals', 1), 'QX Metals hasn’t replied in 1 working day — they may not have received the order.')
  assertEqual(overdueReason('QX Metals', 2), 'QX Metals hasn’t replied in 2 working days — they may not have received the order.')
})

test('overdueReason still reads properly with no supplier name', () => {
  assertEqual(overdueReason(null, 2), 'The supplier hasn’t replied in 2 working days — they may not have received the order.')
  assertEqual(overdueReason('   ', 2), 'The supplier hasn’t replied in 2 working days — they may not have received the order.')
})

test('waitingFor is coarse, and never says "in -1 minutes"', () => {
  const at = (mins: number) => waitingFor(new Date(NOW.getTime() - mins * 60_000).toISOString(), NOW)
  assertEqual(at(0), 'just now')
  assertEqual(at(25), '25 minutes ago')
  assertEqual(at(60), 'an hour ago')
  assertEqual(at(60 * 5), '5 hours ago')
  assertEqual(at(60 * 26), 'yesterday')
  assertEqual(at(60 * 24 * 3), '3 days ago')
  // A reply stamped a moment in the future (clock skew between HS and us).
  assertEqual(waitingFor(new Date(NOW.getTime() + 30_000).toISOString(), NOW), 'just now')
})

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
