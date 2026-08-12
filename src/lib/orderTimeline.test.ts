// Unit tests for orderTimeline.ts
// Run with: npx tsx src/lib/orderTimeline.test.ts
//
// The rules worth pinning are the suppressions and redirections, not the happy
// path: offline orders must not grow pay-link entries, grouped members must
// read opened/invoice/confirmation from the GROUP row, expiry must only appear
// on an unpaid order whose expires_at is actually in the past, and the
// place-order hand-off stamps must collapse into "Placed into production"
// unless they arrived late (a retried hand-off).

import {
  buildOrderTimeline,
  PLACED_CLUSTER_MS,
  type TimelineOrder,
} from './orderTimeline.ts'

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

function order(partial: Partial<TimelineOrder>): TimelineOrder {
  return {
    id: 'o1',
    status: 'sent',
    payment_method: 'online',
    order_kind: 'production',
    created_at: '2026-07-01T10:00:00Z',
    sent_at: '2026-07-01T10:00:00Z',
    expires_at: '2026-07-15T10:00:00Z',
    pay_link_opened_at: null,
    help_requested_at: null,
    pay_link_resend_requested_at: null,
    paid_at: null,
    invoice_emailed_at: null,
    confirmation_sent_at: null,
    revised_at: null,
    fulfilled_at: null,
    handoff_at: null,
    supplier_email_sent_at: null,
    production_note_posted_at: null,
    artwork_checked_at: null,
    artwork_check_verdict: null,
    supplier_name: null,
    order_group_id: null,
    ...partial,
  }
}

console.log('\nbuildOrderTimeline — creation & link lifecycle')

test('an online order starts with a single created entry (link sent in the same insert)', () => {
  const entries = buildOrderTimeline(order({}), null, [], null, NOW)
  assertEquals(entries.map((e) => e.type), ['created', 'link_expired'], 'created + derived expiry only')
  assert(entries[0].label === 'Order created', 'labelled Order created')
  assert(entries[0].detail === 'Pay link sent to the customer.', 'detail says the link went out')
})

test('an offline order suppresses every pay-link entry', () => {
  const at = '2026-07-01T10:00:00Z'
  const entries = buildOrderTimeline(
    order({
      status: 'paid',
      payment_method: 'offline',
      paid_at: at,
      // Belt-and-braces: even if these were somehow stamped, an offline order
      // must never read as having had a link opened or expired.
      pay_link_opened_at: at,
      expires_at: '2026-07-02T10:00:00Z',
    }),
    null, [], null, NOW,
  )
  assertEquals(entries.map((e) => e.type), ['created', 'paid'], 'no link_opened, no link_expired')
  assert(entries[0].label === 'Order recorded', 'offline creation is "recorded"')
  assert(entries[1].label === 'Payment recorded', 'offline payment is "recorded", not "received"')
})

test('created and paid at the same instant sort lifecycle-order (offline nowIso)', () => {
  const at = '2026-07-01T10:00:00Z'
  const entries = buildOrderTimeline(
    order({ status: 'paid', payment_method: 'offline', paid_at: at, created_at: at }),
    null, [], null, NOW,
  )
  assertEquals(entries.map((e) => e.type), ['created', 'paid'], 'created wins the tie')
})

test('expiry appears only while unpaid and past expires_at', () => {
  const expired = buildOrderTimeline(order({ expires_at: '2026-07-10T10:00:00Z' }), null, [], null, NOW)
  assert(expired.some((e) => e.type === 'link_expired'), 'past expiry on a sent order shows')

  const live = buildOrderTimeline(order({ expires_at: '2026-09-01T10:00:00Z' }), null, [], null, NOW)
  assert(!live.some((e) => e.type === 'link_expired'), 'future expiry shows nothing')

  const paid = buildOrderTimeline(
    order({ status: 'paid', paid_at: '2026-07-05T10:00:00Z', expires_at: '2026-07-10T10:00:00Z' }),
    null, [], null, NOW,
  )
  assert(!paid.some((e) => e.type === 'link_expired'), 'a paid order never reads as expired')
})

console.log('\nbuildOrderTimeline — combined payments read the group row')

test('a grouped member reads opened / invoice / confirmation from the group', () => {
  const entries = buildOrderTimeline(
    order({
      status: 'paid',
      order_group_id: 'g1',
      paid_at: '2026-07-05T10:00:00Z',
      // Member stamps frozen at null — the group carries the real ones.
      pay_link_opened_at: null,
      invoice_emailed_at: null,
      confirmation_sent_at: null,
    }),
    {
      status: 'paid',
      expires_at: null,
      payment_reference: 'GRP-ABC123',
      pay_link_opened_at: '2026-07-04T09:00:00Z',
      invoice_emailed_at: '2026-07-05T10:05:00Z',
      confirmation_sent_at: '2026-07-05T10:06:00Z',
    },
    [], null, NOW,
  )
  const types = entries.map((e) => e.type)
  assertEquals(
    types,
    ['created', 'link_opened', 'paid', 'invoice_emailed', 'confirmation_sent'],
    'group stamps present in order',
  )
  const opened = entries.find((e) => e.type === 'link_opened')!
  assert(opened.label === 'Combined pay link opened', 'opened entry names the combined link')
  const paid = entries.find((e) => e.type === 'paid')!
  assert((paid.detail ?? '').includes('GRP-ABC123'), 'paid entry names the combined payment reference')
})

test('a grouped member derives expiry from the GROUP link, not its own frozen stamp', () => {
  const member = order({
    order_group_id: 'g1',
    // The member's own link went dormant when it joined the group — its
    // expires_at is frozen and meaningless.
    expires_at: '2026-07-10T10:00:00Z',
  })
  const groupBase = {
    payment_reference: 'GRP-ABC123',
    pay_link_opened_at: null,
    invoice_emailed_at: null,
    confirmation_sent_at: null,
  }
  const liveGroup = buildOrderTimeline(member, { ...groupBase, status: 'sent', expires_at: '2026-09-01T10:00:00Z' }, [], null, NOW)
  assert(!liveGroup.some((e) => e.type === 'link_expired'), 'live group link → no expiry entry despite the stale member stamp')

  const deadGroup = buildOrderTimeline(member, { ...groupBase, status: 'sent', expires_at: '2026-07-20T10:00:00Z' }, [], null, NOW)
  const expired = deadGroup.find((e) => e.type === 'link_expired')
  assert(expired != null, 'expired group link → expiry entry')
  assert(expired!.label === 'Combined pay link expired', 'labelled as the combined link')
  assert(expired!.at === '2026-07-20T10:00:00Z', 'dated off the GROUP expiry')
})

console.log('\nbuildOrderTimeline — reminders & customer signals')

test('sent reminders each get an entry with their stored ordinal', () => {
  const entries = buildOrderTimeline(
    order({}),
    null,
    [
      { reminder_no: 1, source: 'auto', created_at: '2026-07-04T09:30:00Z' },
      { reminder_no: 2, source: 'auto', created_at: '2026-07-08T09:30:00Z' },
    ],
    null, NOW,
  )
  const reminders = entries.filter((e) => e.type === 'reminder_sent')
  assertEquals(reminders.map((r) => r.label), ['Payment reminder 1 sent', 'Payment reminder 2 sent'], 'ordinals from the ledger')
  assert(reminders[0].detail === 'Automatic', 'auto source noted')
})

console.log('\nbuildOrderTimeline — placement cluster')

test('hand-off stamps within the cluster window fold into Placed into production', () => {
  const fulfilled = '2026-07-06T10:00:00Z'
  const entries = buildOrderTimeline(
    order({
      status: 'fulfilled',
      paid_at: '2026-07-05T10:00:00Z',
      fulfilled_at: fulfilled,
      handoff_at: '2026-07-06T10:00:30Z',
      supplier_email_sent_at: '2026-07-06T10:01:00Z',
      supplier_name: 'Prestige Print Co',
    }),
    null, [], null, NOW,
  )
  const placedEntries = entries.filter((e) =>
    ['placed', 'handoff', 'supplier_emailed', 'production_note'].includes(e.type))
  assertEquals(placedEntries.map((e) => e.type), ['placed'], 'one entry, not three')
  assert((placedEntries[0].detail ?? '').includes('Stock Control'), 'detail mentions the hand-off')
  assert((placedEntries[0].detail ?? '').includes('Prestige Print Co'), 'detail names the supplier')
})

test('a hand-off stamp outside the cluster window is its own entry (retried hand-off)', () => {
  const fulfilled = '2026-07-06T10:00:00Z'
  const lateHandoff = new Date(new Date(fulfilled).getTime() + PLACED_CLUSTER_MS + 60_000).toISOString()
  const entries = buildOrderTimeline(
    order({ status: 'fulfilled', paid_at: '2026-07-05T10:00:00Z', fulfilled_at: fulfilled, handoff_at: lateHandoff }),
    null, [], null, NOW,
  )
  const placed = entries.find((e) => e.type === 'placed')!
  assert(placed.detail == null, 'placed entry carries no cluster detail')
  assert(entries.some((e) => e.type === 'handoff'), 'the late hand-off is its own entry')
})

console.log('\nbuildOrderTimeline — the rest of the lifecycle')

test('artwork check entry carries the verdict, incl. the CHECK\'s 4th value "defect"', () => {
  const entries = buildOrderTimeline(
    order({ artwork_checked_at: '2026-07-05T11:00:00Z', artwork_check_verdict: 'defect' }),
    null, [], null, NOW,
  )
  const check = entries.find((e) => e.type === 'artwork_checked')!
  assert((check.detail ?? '').includes('defect found'), 'defect verdict labelled')
})

test('shipping entries appear only with real timestamps (shipped_at can be null on live rows)', () => {
  const entries = buildOrderTimeline(
    order({ status: 'fulfilled', paid_at: '2026-07-05T10:00:00Z', fulfilled_at: '2026-07-06T10:00:00Z' }),
    null, [],
    { shipped_at: null, delivered_at: null },
    NOW,
  )
  assert(!entries.some((e) => e.type === 'shipped' || e.type === 'delivered'), 'no dateless shipped/delivered rows')

  const withDates = buildOrderTimeline(
    order({ status: 'fulfilled', paid_at: '2026-07-05T10:00:00Z', fulfilled_at: '2026-07-06T10:00:00Z' }),
    null, [],
    { shipped_at: '2026-07-10T10:00:00Z', delivered_at: '2026-07-12T10:00:00Z' },
    NOW,
  )
  assertEquals(
    withDates.filter((e) => ['shipped', 'delivered'].includes(e.type)).map((e) => e.type),
    ['shipped', 'delivered'],
    'dated stamps render',
  )
})

test('cancellation deliberately has no entry — there is no honest timestamp for it', () => {
  const entries = buildOrderTimeline(
    order({ status: 'cancelled' }),
    null, [], null, NOW,
  )
  // The status pill carries "Cancelled"; the timeline stays silent rather than
  // dating the moment off updated_at (which moves on every edit).
  assertEquals(entries.map((e) => e.type), ['created'], 'no synthetic cancelled entry, and no expiry on a cancelled order')
})

test('entries come back oldest-first', () => {
  const entries = buildOrderTimeline(
    order({
      status: 'fulfilled',
      pay_link_opened_at: '2026-07-02T10:00:00Z',
      paid_at: '2026-07-05T10:00:00Z',
      invoice_emailed_at: '2026-07-05T10:05:00Z',
      fulfilled_at: '2026-07-06T10:00:00Z',
    }),
    null, [], null, NOW,
  )
  const times = entries.map((e) => new Date(e.at).getTime())
  const sorted = [...times].sort((a, b) => a - b)
  assertEquals(times, sorted, 'ascending by time')
})

console.log('\nbuildOrderTimeline — supplier proof holding pen (000409)')

test('a supplier proof coming back and being approved are two entries, in order', () => {
  const entries = buildOrderTimeline(
    order({
      status: 'fulfilled',
      paid_at: '2026-07-05T10:00:00Z',
      fulfilled_at: '2026-07-06T10:00:00Z',
      supplier_email_sent_at: '2026-07-06T10:01:00Z',
      supplier_name: 'QX Metals',
      supplier_reply_at: '2026-07-06T12:00:00Z',
      supplier_proof_approved_at: '2026-07-06T15:30:00Z',
    }),
    null, [], null, NOW,
  )
  const types = entries.map((e) => e.type)
  const received = types.indexOf('supplier_proof_received')
  const approved = types.indexOf('supplier_proof_approved')
  assert(received !== -1, 'the proof coming back is on the timeline')
  assert(approved !== -1, 'the approval is on the timeline')
  assert(received < approved, 'the proof arrives before it is approved')
  const receivedEntry = entries[received]
  assert(
    (receivedEntry.label ?? '').includes('QX Metals'),
    'the supplier is named — "the supplier replied" is useless with three of them',
  )
  // Never claims a proof: we detect the reply, not its contents, and only one of
  // the three live suppliers actually sends a proof.
  assert(
    !(receivedEntry.label ?? '').toLowerCase().includes('proof'),
    'the timeline should not claim a proof arrived — we only know they replied',
  )
})

test('an order with no supplier proof activity gains no pen entries', () => {
  // The in-house path, and every order placed before 000409 shipped.
  const entries = buildOrderTimeline(
    order({ status: 'fulfilled', paid_at: '2026-07-05T10:00:00Z', fulfilled_at: '2026-07-06T10:00:00Z' }),
    null, [], null, NOW,
  )
  const types = entries.map((e) => e.type)
  assert(!types.includes('supplier_proof_received'), 'no phantom proof entry')
  assert(!types.includes('supplier_proof_approved'), 'no phantom approval entry')
})

test('an approval recorded without a reply still shows (the "just record it" path)', () => {
  // Approved by hand in Help Scout, or a supplier who acknowledged rather than
  // proofed. There is no reply stamp, but the sign-off is real and must appear.
  const entries = buildOrderTimeline(
    order({
      status: 'fulfilled',
      paid_at: '2026-07-05T10:00:00Z',
      fulfilled_at: '2026-07-06T10:00:00Z',
      supplier_email_sent_at: '2026-07-06T10:01:00Z',
      supplier_proof_approved_at: '2026-07-07T09:00:00Z',
    }),
    null, [], null, NOW,
  )
  const types = entries.map((e) => e.type)
  assert(types.includes('supplier_proof_approved'), 'the approval is recorded')
  assert(!types.includes('supplier_proof_received'), 'but no proof is claimed to have arrived')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
