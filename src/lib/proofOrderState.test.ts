// Run with: npx tsx src/lib/proofOrderState.test.ts
//
// Covers the "Ready to order?" panel's state → copy mapping.
//
// The case that created this feature: a customer approved three cards on
// 2026-07-30, was sent a combined pay link, then went back to /p/:id and
// tried to buy from the pricing table — "nowhere to select add to order or
// add to cart". The panel exists to answer that in place, so the two things
// worth pinning are (a) the panel appears for someone with a live link
// waiting, and (b) it NEVER carries the pay link itself, whatever the RPC
// sends. See migration 000367 and src/lib/customerProofUrl.ts:26-34.

import {
  parseProofOrderState,
  readyToOrderCopy,
  type ProofOrderStatePayload,
} from './proofOrderState.ts'

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

const live: ProofOrderStatePayload = { state: 'awaiting_payment', expiresAt: '2026-08-13T12:44:59Z' }

// Every state that can produce a panel — used by the copy-honesty sweeps so a
// new state can't quietly skip them.
const ALL_PANEL_STATES: ProofOrderStatePayload[] = [
  live,
  { state: 'link_expired', expiresAt: null },
  { state: 'none', expiresAt: null },
]

console.log('\nparseProofOrderState — defensive parsing')

test('reads the RPC shape, mapping expires_at to expiresAt', () => {
  assertEquals(
    parseProofOrderState({ state: 'awaiting_payment', expires_at: '2026-08-13T12:44:59Z' }),
    { state: 'awaiting_payment', expiresAt: '2026-08-13T12:44:59Z' },
    'a live link should parse with its deadline',
  )
})

test('a state with no expiry parses with expiresAt null', () => {
  assertEquals(parseProofOrderState({ state: 'none' }), { state: 'none', expiresAt: null },
    'jsonb_strip_nulls omits expires_at entirely for non-live states')
})

test('null, non-objects and arrays return null rather than throwing', () => {
  for (const raw of [null, undefined, 'awaiting_payment', 42, [], [{ state: 'paid' }]]) {
    assertEquals(parseProofOrderState(raw), null, `${JSON.stringify(raw)} should parse to null`)
  }
})

test('an unrecognised state returns null, so a future RPC value shows no panel', () => {
  assertEquals(parseProofOrderState({ state: 'part_refunded' }), null,
    'an unknown state must not fall through to a panel')
  assertEquals(parseProofOrderState({ expires_at: '2026-08-13T12:44:59Z' }), null,
    'a payload with no state at all must not render')
})

console.log('\nreadyToOrderCopy — which panel, if any')

test('a live pay link tells them where ordering happens', () => {
  const copy = readyToOrderCopy(live, 'approved')
  assert(copy != null, 'a live link should produce a panel')
  assertEquals(copy!.heading, 'Ready to order?', 'heading')
  assert(copy!.body.includes('nothing to add to a basket here'),
    'the body must name the exact thing the customer tried to do')
  assert(copy!.body.includes('payment link we send you by email'),
    'the body must point at the channel ordering actually happens on')
  assert(copy!.body.includes('reply to any message from us'),
    'the recovery route must be stated')
  assertEquals(copy!.expiresAt, '2026-08-13T12:44:59Z', 'the deadline rides through')
})

test('an expired link offers a fresh one instead of a dead end', () => {
  const copy = readyToOrderCopy({ state: 'link_expired', expiresAt: null }, 'approved')
  assertEquals(copy!.heading, 'Your payment link has expired', 'heading')
  assert(copy!.body.includes('reply to any message from us'),
    'the recovery route must be stated')
  assertEquals(copy!.expiresAt, null, 'a dead link must not advertise a deadline')
})

test('an already-paid order shows nothing — the proof page is not the order page', () => {
  assertEquals(readyToOrderCopy({ state: 'paid', expiresAt: null }, 'approved'), null,
    'a paying customer must never be shown "Ready to order?"')
})

test('an approved proof with no order yet still gets told how to buy', () => {
  const copy = readyToOrderCopy({ state: 'none', expiresAt: null }, 'approved')
  assert(copy != null, 'this is the approved_no_order customer — the one most likely to be stuck')
  assertEquals(copy!.heading, 'Ready to order?', 'heading')
  assert(copy!.body.includes('reply to any message from us'),
    'with no link in existence, replying is the only route — it must be stated plainly')
})

test('a proof still in progress is not nudged to order', () => {
  for (const status of ['in_progress', 'dormant', 'abandoned', null, undefined]) {
    assertEquals(readyToOrderCopy({ state: 'none', expiresAt: null }, status), null,
      `status ${String(status)} should show no ordering panel`)
  }
})

test('a live link shows even mid-revision — the link is real whatever the proof status', () => {
  for (const status of ['in_progress', 'dormant', null]) {
    assert(readyToOrderCopy(live, status) != null,
      `status ${String(status)} must still surface a genuinely live pay link`)
  }
})

test('a failed or unparsed RPC shows nothing', () => {
  assertEquals(readyToOrderCopy(null, 'approved'), null,
    'the page must be unchanged when the state could not be read')
})

console.log('\ncopy honesty — two claims we cannot back up')

// Both regressions below were caught in adversarial review before shipping.
test('no copy ever claims an email has already been sent', () => {
  // `awaiting_payment` means an order row is live and unexpired — NOT that
  // anything reached the customer. create-order stamps status 'sent' at
  // row-creation and never touches Help Scout; the send is a separate manual
  // step, and a combined-payment group has no send step at all. Claiming a
  // send would send someone hunting for an email that may never have left —
  // exactly the dead end this card exists to end.
  for (const p of ALL_PANEL_STATES) {
    const copy = readyToOrderCopy(p, 'approved')
    if (!copy) continue
    for (const claim of ['we’ve emailed', 'we have emailed', 'we’ve sent you', 'the link we sent', 'we’ll email you']) {
      assert(!copy.body.toLowerCase().includes(claim),
        `copy for ${p.state} claims "${claim}", which we cannot verify happened`)
    }
  }
})

test('no copy promises a quantity choice the pay page may not offer', () => {
  // The pay page only renders a quantity chooser when the designer left
  // quantity open; a locked-quantity or custom-quote order shows a settled
  // line instead. "That's where you choose your quantity" would be wrong for
  // those customers, and the RPC deliberately carries no order shape to
  // branch on.
  for (const p of ALL_PANEL_STATES) {
    const copy = readyToOrderCopy(p, 'approved')
    if (!copy) continue
    assert(!copy.body.toLowerCase().includes('choose your quantity'),
      `copy for ${p.state} promises a quantity chooser that may not exist`)
  }
})

console.log('\nthe security invariant')

test('no copy ever contains a link, path or token', () => {
  const payloads: ProofOrderStatePayload[] = [
    live,
    { state: 'link_expired', expiresAt: null },
    { state: 'none', expiresAt: null },
  ]
  for (const p of payloads) {
    for (const status of ['approved', 'in_progress']) {
      const copy = readyToOrderCopy(p, status)
      if (!copy) continue
      const text = `${copy.eyebrow} ${copy.heading} ${copy.body}`
      for (const forbidden of ['/order/', 'token', 'http://', 'https://']) {
        assert(!text.toLowerCase().includes(forbidden),
          `copy for ${p.state} must never contain ${forbidden} — /p/ links are shared broadly (000367)`)
      }
    }
  }
})

test('the parsed payload carries no identifiers even if the RPC sends some', () => {
  // Belt and braces: if a future migration were to add an order id or token
  // to the payload, the parser must drop it rather than pass it to the UI.
  const parsed = parseProofOrderState({
    state: 'awaiting_payment',
    expires_at: '2026-08-13T12:44:59Z',
    order_id: '12b18b85-f345-4d1d-a659-2e243ee0d67b',
    token: '3266c7ef802261358ad77816f5c93ffb',
  })
  assertEquals(Object.keys(parsed!).sort(), ['expiresAt', 'state'],
    'the parser is an allow-list: only state and expiresAt survive')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
