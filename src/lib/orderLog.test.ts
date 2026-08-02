// Unit tests for orderLog.ts
// Run with: npx tsx src/lib/orderLog.test.ts
//
// What's worth pinning: multi-term search is AND-matched across fields, the
// status buckets treat expiry as presentation inside "awaiting" (never a
// bucket) and read a grouped member's expiry from the GROUP row, paid stats
// exclude cancelled (refunded) orders, count group-level shipping/tariff
// once, and offline orders never skew the median time-to-pay, and the weekly
// series emits zeros for quiet weeks instead of silently closing the gap
// (the 000363 axis lesson) — including across the UK spring clock change.

// Pin the DST-observing production timezone BEFORE any Date is constructed —
// the buildWeeklyPaid DST regression below only bites where clocks change
// (UTC, the usual CI default, would pass even with the bug present).
process.env.TZ = 'Europe/London'

import {
  buildWeeklyPaid,
  computeOrderLogStats,
  matchesOrderSearch,
  mondayOf,
  orderLogDisplayStatus,
  orderLogStatus,
  type OrderLogSearchable,
  type StatsOrder,
} from './orderLog.ts'
import type { ExchangeRates } from './exchangeRates.ts'

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

const NOW = new Date('2026-08-01T12:00:00Z')

// 1:1 rates keep the GBP figures readable in assertions.
const FLAT_RATES: ExchangeRates = { gbpToEur: 1, gbpToUsd: 1, rateDate: '2026-08-01' }

function searchable(partial: Partial<OrderLogSearchable>): OrderLogSearchable {
  return {
    id: 'o1',
    payment_reference: 'ORD-1A2B3C4D5E',
    stock_order_number: '403910',
    xero_invoice_id: null,
    project_name: 'Atari reorder',
    ship_to_name: 'Nolan Bushnell',
    companyName: 'Atari Corp',
    contactName: 'Nolan Bushnell',
    contactEmail: 'nolan@example.com',
    specText: 'Stainless Steel · 500 micron',
    ...partial,
  }
}

function statsOrder(partial: Partial<StatsOrder & { expires_at: string | null; fulfilled_at: string | null }>) {
  return {
    status: 'paid',
    payment_method: 'online',
    currency: 'GBP' as const,
    sent_at: '2026-07-20T10:00:00Z',
    paid_at: '2026-07-22T10:00:00Z',
    expires_at: null,
    fulfilled_at: null,
    order_group_id: null,
    custom_quote_total: null,
    amount_card_discount: null,
    amount_us_tariff: null,
    amount_cards: 100,
    amount_tooling: null,
    amount_personalisation: null,
    amount_shipping: null,
    ...partial,
  }
}

console.log('\nmatchesOrderSearch')

test('empty query matches everything', () => {
  assert(matchesOrderSearch(searchable({}), '  '), 'blank matches')
})

test('multi-term queries AND across different fields', () => {
  assert(matchesOrderSearch(searchable({}), 'atari steel'), 'company + material together')
  assert(!matchesOrderSearch(searchable({}), 'atari letterpress'), 'a term matching nothing fails the row')
})

test('references, stock numbers and emails all match case-insensitively', () => {
  assert(matchesOrderSearch(searchable({}), 'ord-1a2b'), 'payment reference prefix')
  assert(matchesOrderSearch(searchable({}), '403910'), 'stock order number')
  assert(matchesOrderSearch(searchable({}), 'NOLAN@EXAMPLE.COM'), 'email uppercased')
})

console.log('\norderLogStatus')

test('sent + future expiry is awaiting; past expiry is the expired presentation of awaiting', () => {
  const live = orderLogStatus({ status: 'sent', expires_at: '2026-09-01T00:00:00Z', payment_method: 'online' }, NOW)
  assertEquals([live.bucket, live.label, live.expired], ['awaiting', 'Awaiting payment', false], 'live link')
  const expired = orderLogStatus({ status: 'sent', expires_at: '2026-07-01T00:00:00Z', payment_method: 'online' }, NOW)
  assertEquals([expired.bucket, expired.label, expired.expired], ['awaiting', 'Link expired', true], 'expired link stays in the awaiting bucket')
})

test('fulfilled reads as Ordered (placed with production, not delivered)', () => {
  const s = orderLogStatus({ status: 'fulfilled', expires_at: null, payment_method: 'online' }, NOW)
  assertEquals([s.bucket, s.label], ['ordered', 'Ordered'], 'vocabulary matches the admin log')
})

test('a grouped member reads expiry from the GROUP row, never its own frozen stamp', () => {
  const member = { status: 'sent', expires_at: '2026-07-01T00:00:00Z', payment_method: 'online', order_group_id: 'g1' }
  const liveGroup = orderLogStatus(member, NOW, { status: 'sent', expires_at: '2026-09-01T00:00:00Z' })
  assertEquals([liveGroup.label, liveGroup.expired], ['Awaiting payment', false], 'own expiry past + group live → awaiting')
  const deadGroup = orderLogStatus(
    { ...member, expires_at: '2026-09-01T00:00:00Z' },
    NOW,
    { status: 'sent', expires_at: '2026-07-01T00:00:00Z' },
  )
  assertEquals([deadGroup.label, deadGroup.expired], ['Combined link expired', true], 'group expiry past → expired even with own future stamp')
  const noGroup = orderLogStatus(member, NOW, null)
  assertEquals([noGroup.label, noGroup.expired], ['Awaiting payment', false], 'group row missing → safer transient awaiting, never a false expired')
})

test('a cancelled order on an abandoned project reads Abandoned, matching the proof page', () => {
  const abandoned = orderLogStatus(
    { status: 'cancelled', expires_at: null, payment_method: 'online', proof_status: 'abandoned' },
    NOW,
  )
  assertEquals([abandoned.bucket, abandoned.label], ['cancelled', 'Abandoned'], 'same bucket, honest label')
  const live = orderLogStatus(
    { status: 'cancelled', expires_at: null, payment_method: 'online', proof_status: 'in_progress' },
    NOW,
  )
  assertEquals(live.label, 'Cancelled', 'a cancelled order on a live project stays Cancelled')
  const unknown = orderLogStatus({ status: 'cancelled', expires_at: null, payment_method: 'online' }, NOW)
  assertEquals(unknown.label, 'Cancelled', 'no proof status → the order-level truth')
})

test('the dispatch pill only overrides paid/ordered — never revision or cancelled', () => {
  const paid = orderLogStatus({ status: 'paid', expires_at: null, payment_method: 'online' }, NOW)
  assertEquals(orderLogDisplayStatus(paid, true, false).label, 'Shipped', 'paid + shipped shows Shipped')
  assertEquals(orderLogDisplayStatus(paid, true, true).label, 'Delivered', 'delivered wins over shipped')
  const revision = orderLogStatus({ status: 'revision', expires_at: null, payment_method: 'online' }, NOW)
  assertEquals(orderLogDisplayStatus(revision, true, true).label, 'Revision', 'a shipped-then-revised order keeps saying Revision')
  const cancelled = orderLogStatus({ status: 'cancelled', expires_at: null, payment_method: 'online' }, NOW)
  assertEquals(orderLogDisplayStatus(cancelled, true, false).label, 'Cancelled', 'cancelled never reads as Shipped')
})

console.log('\ncomputeOrderLogStats')

test('paid-30-days counts payment stamps on not-cancelled orders only', () => {
  const stats = computeOrderLogStats(
    [
      statsOrder({}),                                    // paid inside window
      statsOrder({ status: 'fulfilled' }),               // paid then placed — still money in
      statsOrder({ status: 'cancelled' }),               // refunded — excluded
      statsOrder({ paid_at: '2026-06-01T10:00:00Z' }),   // outside window
      statsOrder({ status: 'sent', paid_at: null }),     // unpaid
    ],
    FLAT_RATES, NOW,
  )
  assertEquals(stats.paid30Count, 2, 'two qualifying payments')
  assertEquals(stats.paid30Gbp, 200, 'their totals summed')
  assertEquals(stats.awaitingCount, 1, 'the sent order awaits')
})

test('non-GBP totals convert through the live rate', () => {
  const stats = computeOrderLogStats(
    [statsOrder({ currency: 'USD', amount_cards: 254 })],
    { gbpToEur: 1.17, gbpToUsd: 1.27, rateDate: '2026-08-01' },
    NOW,
  )
  assertEquals(stats.paid30Gbp, 200, '$254 at 1.27 rounds to £200')
})

test('offline orders never enter the median time-to-pay sample', () => {
  const stats = computeOrderLogStats(
    [
      statsOrder({ sent_at: '2026-07-20T10:00:00Z', paid_at: '2026-07-24T10:00:00Z' }), // 4 days
      statsOrder({ payment_method: 'offline', sent_at: '2026-07-20T10:00:00Z', paid_at: '2026-07-20T10:00:00Z' }),
    ],
    FLAT_RATES, NOW,
  )
  assertEquals(stats.medianDaysToPay, 4, 'the zero-gap offline stamp is excluded')
})

test('median is null with no online payment sample', () => {
  const stats = computeOrderLogStats([statsOrder({ status: 'sent', paid_at: null })], FLAT_RATES, NOW)
  assertEquals(stats.medianDaysToPay, null, 'no sample, no figure')
})

console.log('\nbuildWeeklyPaid')

test('emits exactly N points with zeros for quiet weeks', () => {
  const weekly = buildWeeklyPaid(
    [statsOrder({ paid_at: '2026-07-22T10:00:00Z' })],
    FLAT_RATES, NOW, 12,
  )
  assertEquals(weekly.length, 12, 'every week in the window is present')
  const nonZero = weekly.filter((w) => w.count > 0)
  assertEquals(nonZero.length, 1, 'one busy week')
  assertEquals(nonZero[0].count, 1, 'with one payment')
  assert(weekly.some((w) => w.count === 0), 'quiet weeks are zeros, not gaps')
})

test('weeks start on Monday and the series ends with the current week', () => {
  const weekly = buildWeeklyPaid([], FLAT_RATES, NOW, 4)
  for (const w of weekly) {
    assertEquals(new Date(`${w.weekStart}T00:00:00`).getDay(), 1, `${w.weekStart} is a Monday`)
  }
  const lastStart = weekly[weekly.length - 1].weekStart
  const expected = mondayOf(NOW)
  const pad = (n: number) => String(n).padStart(2, '0')
  assertEquals(
    lastStart,
    `${expected.getFullYear()}-${pad(expected.getMonth() + 1)}-${pad(expected.getDate())}`,
    'final bucket is the week in progress',
  )
})

test('cancelled orders never count toward a week', () => {
  const weekly = buildWeeklyPaid(
    [statsOrder({ status: 'cancelled', paid_at: '2026-07-22T10:00:00Z' })],
    FLAT_RATES, NOW, 12,
  )
  assert(weekly.every((w) => w.count === 0), 'refunded money stays out of the chart')
})

test('weeks before the UK spring clock change still bucket correctly (DST regression)', () => {
  // 20 Apr 2026 is BST; 18 Mar 2026 is GMT, before the 29 Mar transition.
  // Millisecond-based week generation lands the pre-transition points on
  // Sunday 23:00 keys, silently dropping every payment before the change —
  // this pins the calendar-arithmetic fix. Only meaningful under a DST
  // timezone, hence the process.env.TZ pin at the top of this file.
  const dstNow = new Date(2026, 3, 20, 12)
  const weekly = buildWeeklyPaid(
    [statsOrder({ paid_at: new Date(2026, 2, 18, 12).toISOString() })],
    FLAT_RATES, dstNow, 12,
  )
  for (const w of weekly) {
    assertEquals(new Date(`${w.weekStart}T00:00:00`).getDay(), 1, `${w.weekStart} is a Monday`)
  }
  const target = weekly.find((w) => w.weekStart === '2026-03-16')
  assert(target != null, 'the week of 16 March exists in the window')
  assertEquals(target!.count, 1, 'the pre-transition payment lands in its bar')
})

console.log('\ncombined-payment group money')

test('a paid group’s shipping + tariff count once in the roll-ups, never in the counts', () => {
  const groups = {
    g1: {
      status: 'paid',
      paid_at: '2026-07-22T10:00:00Z',
      expires_at: null,
      currency: 'GBP' as const,
      amount_shipping: 24,
      amount_us_tariff: 39,
    },
  }
  const stats = computeOrderLogStats(
    [
      statsOrder({ order_group_id: 'g1' }),
      statsOrder({ order_group_id: 'g1' }),
    ],
    FLAT_RATES, NOW, groups,
  )
  assertEquals(stats.paid30Count, 2, 'a group is a payment wrapper, not an order')
  assertEquals(stats.paid30Gbp, 263, 'members’ £100 goods each + the group’s £63 shipping/tariff once')
  const week = stats.weeklyPaid.find((w) => w.weekStart === '2026-07-20')
  assertEquals([week?.count, week?.gbp], [2, 263], 'the weekly bar carries the same money')
})

test('a cancelled group’s charges stay out of the roll-ups', () => {
  const stats = computeOrderLogStats(
    [statsOrder({})],
    FLAT_RATES, NOW,
    { g1: { status: 'cancelled', paid_at: '2026-07-22T10:00:00Z', expires_at: null, currency: 'GBP' as const, amount_shipping: 24, amount_us_tariff: 39 } },
  )
  assertEquals(stats.paid30Gbp, 100, 'only the standalone order counts')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
