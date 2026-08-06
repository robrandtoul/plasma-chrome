// Unit tests for awaitingPayment.ts
// Run with: npx tsx src/lib/awaitingPayment.test.ts
//
// Two things here are worth pinning against a future refactor, and neither is
// copy:
//
//   1. A combined payment reads its OPENED state from the group, never from a
//      member. The members keep the stamps from before they were grouped, so a
//      member-read reports an opened combined payment as untouched — and does it
//      once per member. This is the one bug the collapse exists to prevent.
//   2. The sort is opened-first-by-recency, then never-opened-by-longest-wait.
//      It is deliberately NOT a triage: nothing floats an expired or held row to
//      the top, because that would make this a second priority order competing
//      with the Orders page's Fix section.

import {
  awaitingChip,
  awaitingStatusLine,
  awaitingSummary,
  buildAwaitingRows,
  expiryNote,
  sortAwaitingRows,
  type AwaitingGroupInput,
  type AwaitingOrderInput,
  type AwaitingRow,
} from './awaitingPayment.ts'

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

// A fixed "now" so relative phrasing is deterministic.
const NOW = Date.parse('2026-08-06T12:00:00Z')
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString()
const daysAhead = (n: number) => new Date(NOW + n * 86_400_000).toISOString()

function order(over: Partial<AwaitingOrderInput> = {}): AwaitingOrderInput {
  return {
    id: 'o1',
    proof_id: 'p1',
    order_group_id: null,
    sent_at: daysAgo(2),
    pay_link_opened_at: null,
    expires_at: daysAhead(12),
    held_at: null,
    help_requested_at: null,
    payment_method: 'online',
    contact_name: 'Brad Talbot',
    company_name: 'MISFIT',
    ...over,
  }
}

function row(over: Partial<AwaitingRow> = {}): AwaitingRow {
  return {
    key: 'k', orderId: 'o1', proofId: 'p1', label: 'MISFIT', orderCount: 1,
    openedAt: null, sentAt: daysAgo(2), expiresAt: daysAhead(12),
    expired: false, held: false, helpRequested: false, offline: false,
    ...over,
  }
}

console.log('\nbuildAwaitingRows — shaping')

test('a standalone order becomes one row, labelled by company', () => {
  const [r] = buildAwaitingRows([order()], [], NOW)
  assertEquals(r.label, 'MISFIT', 'leads with the company')
  assertEquals(r.orderCount, 1, 'one order')
  assertEquals(r.orderId, 'o1', 'jumps to itself')
})

test('falls back to the contact when there is no company', () => {
  const [r] = buildAwaitingRows([order({ company_name: null })], [], NOW)
  assertEquals(r.label, 'Brad Talbot', 'falls back to the person')
})

console.log('\nbuildAwaitingRows — combined payments')

// The live shape as of 2026-08-06: two BlissFix orders sent individually, then
// grouped a minute later. Both members carry their own older sent_at and a null
// opened stamp; only the GROUP link has been sent to the customer.
const groupedOrders = [
  order({ id: 'm1', proof_id: 'pa', sent_at: daysAgo(5), company_name: 'BlissFix', order_group_id: 'g1' }),
  order({ id: 'm2', proof_id: 'pb', sent_at: daysAgo(4), company_name: 'BlissFix', order_group_id: 'g1' }),
]
const sentGroup: AwaitingGroupInput = {
  id: 'g1', status: 'sent', sent_at: daysAgo(4), pay_link_opened_at: null, expires_at: daysAhead(10),
}

test('members collapse into a single row carrying the order count', () => {
  const rows = buildAwaitingRows(groupedOrders, [sentGroup], NOW)
  assertEquals(rows.length, 1, 'two members, one row')
  assertEquals(rows[0].orderCount, 2, 'says how many orders it covers')
  assertEquals(rows[0].key, 'group:g1', 'keyed by group so it cannot collide with an order id')
})

test('⚠ the OPENED state comes from the group, not from a member', () => {
  // The customer opened the combined link; neither member row knows that.
  const opened = { ...sentGroup, pay_link_opened_at: daysAgo(1) }
  const rows = buildAwaitingRows(groupedOrders, [opened], NOW)
  assertEquals(rows[0].openedAt, daysAgo(1), 'reads the group stamp')
  assert(awaitingStatusLine(rows[0], NOW).startsWith('Opened'), 'reports it as opened')
})

test('⚠ a member stamp never masquerades as the group being opened', () => {
  // The reverse trap: a member was opened before it was grouped. That link is
  // superseded and tells us nothing about the combined one.
  const stale = [{ ...groupedOrders[0], pay_link_opened_at: daysAgo(6) }, groupedOrders[1]]
  const rows = buildAwaitingRows(stale, [sentGroup], NOW)
  assertEquals(rows[0].openedAt, null, 'the superseded member open is ignored')
})

test('the jump target is the earliest member, stably across input order', () => {
  const a = buildAwaitingRows(groupedOrders, [sentGroup], NOW)[0]
  const b = buildAwaitingRows([...groupedOrders].reverse(), [sentGroup], NOW)[0]
  assertEquals(a.orderId, 'm1', 'earliest member')
  assertEquals(a.orderId, b.orderId, 'same target whichever order the rows arrive in')
})

test('a cancelled or missing group leaves its members standalone', () => {
  // Safe direction: two rows where there should be one is cosmetic; dropping
  // them would hide money owed.
  const cancelled = buildAwaitingRows(groupedOrders, [{ ...sentGroup, status: 'cancelled' }], NOW)
  assertEquals(cancelled.length, 2, 'cancelled group — members render individually')
  assertEquals(buildAwaitingRows(groupedOrders, [], NOW).length, 2, 'missing group — same')
})

test('hold and help flags on a group are true when ANY member carries one', () => {
  const held = [groupedOrders[0], { ...groupedOrders[1], held_at: daysAgo(1) }]
  const [r] = buildAwaitingRows(held, [sentGroup], NOW)
  assert(r.held, 'the row now stands for all its members')
  assertEquals(awaitingChip(r), 'On hold', 'and says so')
})

console.log('\nsortAwaitingRows')

test('opened rows lead, most recently opened first', () => {
  const rows = sortAwaitingRows([
    row({ key: 'cold', openedAt: null, sentAt: daysAgo(1) }),
    row({ key: 'older-open', openedAt: daysAgo(5) }),
    row({ key: 'hot', openedAt: daysAgo(0.1) }),
  ])
  assertEquals(rows.map((r) => r.key), ['hot', 'older-open', 'cold'], 'someone at the checkout comes first')
})

test('never-opened rows follow, longest wait first', () => {
  const rows = sortAwaitingRows([
    row({ key: 'recent', sentAt: daysAgo(1) }),
    row({ key: 'stale', sentAt: daysAgo(20) }),
    row({ key: 'mid', sentAt: daysAgo(6) }),
  ])
  assertEquals(rows.map((r) => r.key), ['stale', 'mid', 'recent'], 'going coldest first')
})

test('a missing sent_at sorts last rather than scrambling the comparator', () => {
  const rows = sortAwaitingRows([
    row({ key: 'none', sentAt: null }),
    row({ key: 'has', sentAt: daysAgo(3) }),
  ])
  assertEquals(rows.map((r) => r.key), ['has', 'none'], 'NaN never reaches the comparison')
})

test('⚠ expired and held rows are NOT floated — the sort is not a triage', () => {
  const rows = sortAwaitingRows([
    row({ key: 'opened-today', openedAt: daysAgo(0.2) }),
    row({ key: 'expired', expired: true, sentAt: daysAgo(1) }),
    row({ key: 'held', held: true, sentAt: daysAgo(1) }),
  ])
  assertEquals(rows[0].key, 'opened-today', 'the opened row still leads')
})

console.log('\nawaitingStatusLine')

test('opened leads the line', () => {
  assertEquals(awaitingStatusLine(row({ openedAt: daysAgo(3) }), NOW), 'Opened 3d ago', 'the fact the panel is for')
})

test('never opened says how long it has been sitting', () => {
  assertEquals(awaitingStatusLine(row({ sentAt: daysAgo(5) }), NOW), 'Not opened · sent 5d ago', 'the wait is the signal')
  // relativeTime rolls over to weeks at exactly 7 days, so a fortnight-old link
  // reads "2w ago" rather than "14d ago". Pinned because the panel's whole
  // second group is old links, and this is the phrasing most of them get.
  assertEquals(awaitingStatusLine(row({ sentAt: daysAgo(14) }), NOW), 'Not opened · sent 2w ago', 'weeks past the 7-day rollover')
})

test('an offline order reports no opened state, because it has no link', () => {
  const line = awaitingStatusLine(row({ offline: true, sentAt: daysAgo(2) }), NOW)
  assert(!line.includes('opened'), `bank transfer has no link to open — got "${line}"`)
  assertEquals(line, 'Awaiting payment · raised 2d ago', 'says what it is instead')
})

test('⚠ an exception never displaces the opened state', () => {
  // The chip carries "Expired"; the line still answers "did they look at it?".
  const r = row({ expired: true, openedAt: daysAgo(2) })
  assert(awaitingStatusLine(r, NOW).startsWith('Opened 2d ago'), 'opened state holds the lead')
  assertEquals(awaitingChip(r), 'Expired', 'the exception rides on the chip')
})

test('a combined payment says how many orders it covers', () => {
  const line = awaitingStatusLine(row({ orderCount: 3, sentAt: daysAgo(2) }), NOW)
  assertEquals(line, 'Not opened · sent 2d ago · 3 orders', 'the count explains the single row')
})

console.log('\nexpiryNote')

test('silent outside the window', () => {
  assertEquals(expiryNote(row({ expiresAt: daysAhead(9) }), NOW), null, 'a fortnight of countdown is noise')
})

test('speaks inside it', () => {
  assertEquals(expiryNote(row({ expiresAt: daysAhead(2) }), NOW), 'expires in 2 days', 'a deadline is signal')
  assertEquals(expiryNote(row({ expiresAt: daysAhead(0.5) }), NOW), 'expires today', 'last day')
})

test('silent once expired — the chip already says so', () => {
  assertEquals(expiryNote(row({ expired: true, expiresAt: daysAgo(1) }), NOW), null, 'never say it twice in two registers')
})

test('silent for an offline order, which has no link to expire', () => {
  assertEquals(expiryNote(row({ offline: true, expiresAt: daysAhead(1) }), NOW), null, 'no link, no expiry')
})

console.log('\nawaitingChip — one slot, highest concern first')

test('expired outranks hold outranks help', () => {
  assertEquals(awaitingChip(row({ expired: true, held: true, helpRequested: true })), 'Expired', 'expired wins')
  assertEquals(awaitingChip(row({ held: true, helpRequested: true })), 'On hold', 'then hold')
  assertEquals(awaitingChip(row({ helpRequested: true })), 'Asked for help', 'then help')
  assertEquals(awaitingChip(row()), null, 'and nothing on an ordinary row')
})

console.log('\nawaitingSummary')

test('counts the rows and how many are opened', () => {
  assertEquals(awaitingSummary([row({ openedAt: daysAgo(1) }), row(), row()]), '3 payments · 1 opened', 'the headline')
  assertEquals(awaitingSummary([]), '0 payments', 'no dangling "· 0 opened" on an empty list')
  assertEquals(awaitingSummary([row()]), '1 payment · 0 opened', 'singular')
})

test('⚠ counts PAYMENTS, so it can legitimately differ from the orders tile', () => {
  // Five orders, one of which is a combined payment over two of them, is four
  // payments. The tile beside this panel counts orders and will read 5. The
  // unit is named precisely so that difference reads as a fact rather than as
  // rows going missing.
  const rows = buildAwaitingRows(
    [...groupedOrders, order({ id: 'x1' }), order({ id: 'x2' }), order({ id: 'x3' })],
    [sentGroup],
    NOW,
  )
  assertEquals(rows.length, 4, 'five orders, four payments')
  assert(awaitingSummary(rows).startsWith('4 payments'), 'and it says "payments", not a bare count')
})

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
