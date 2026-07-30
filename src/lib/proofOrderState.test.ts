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
  RESEND_COOLDOWN_MINUTES,
  RESEND_COPY,
  canResendPayLink,
  orderStatusLine,
  parseProofOrderState,
  readyToOrderCopy,
  resendIsRecent,
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

const live: ProofOrderStatePayload = { state: 'awaiting_payment', expiresAt: '2026-08-13T12:44:59Z', resendRequestedAt: null, stage: null, deliveryTracked: null }

// Every state that can produce a panel — used by the copy-honesty sweeps so a
// new state can't quietly skip them.
const ALL_PANEL_STATES: ProofOrderStatePayload[] = [
  live,
  { state: 'link_expired', expiresAt: null, resendRequestedAt: null, stage: null, deliveryTracked: null },
  { state: 'none', expiresAt: null, resendRequestedAt: null, stage: null, deliveryTracked: null },
]

console.log('\nparseProofOrderState — defensive parsing')

test('reads the RPC shape, mapping expires_at to expiresAt', () => {
  assertEquals(
    parseProofOrderState({ state: 'awaiting_payment', expires_at: '2026-08-13T12:44:59Z' }),
    { state: 'awaiting_payment', expiresAt: '2026-08-13T12:44:59Z', resendRequestedAt: null, stage: null, deliveryTracked: null },
    'a live link should parse with its deadline',
  )
})

test('a state with no expiry parses with expiresAt null', () => {
  assertEquals(parseProofOrderState({ state: 'none' }), { state: 'none', expiresAt: null, resendRequestedAt: null, stage: null, deliveryTracked: null },
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
  assert(copy!.body.includes('Can’t find yours?'),
    'the body must set up the resend button that follows it')
  assertEquals(copy!.expiresAt, '2026-08-13T12:44:59Z', 'the deadline rides through')
})

test('an expired link offers a fresh one instead of a dead end', () => {
  const copy = readyToOrderCopy({ state: 'link_expired', expiresAt: null, resendRequestedAt: null, stage: null, deliveryTracked: null }, 'approved')
  assertEquals(copy!.heading, 'Your payment link has expired', 'heading')
  assert(copy!.body.includes('reply to any message from us'),
    'the recovery route must be stated')
  assertEquals(copy!.expiresAt, null, 'a dead link must not advertise a deadline')
})

test('an already-paid order shows nothing — the proof page is not the order page', () => {
  assertEquals(readyToOrderCopy({ state: 'paid', expiresAt: null, resendRequestedAt: null, stage: null, deliveryTracked: null }, 'approved'), null,
    'a paying customer must never be shown "Ready to order?"')
})

test('an approved proof with no order yet still gets told how to buy', () => {
  const copy = readyToOrderCopy({ state: 'none', expiresAt: null, resendRequestedAt: null, stage: null, deliveryTracked: null }, 'approved')
  assert(copy != null, 'this is the approved_no_order customer — the one most likely to be stuck')
  assertEquals(copy!.heading, 'Ready to order?', 'heading')
  assert(copy!.body.includes('reply to any message from us'),
    'with no link in existence, replying is the only route — it must be stated plainly')
})

test('a proof still in progress is not nudged to order', () => {
  for (const status of ['in_progress', 'dormant', 'abandoned', null, undefined]) {
    assertEquals(readyToOrderCopy({ state: 'none', expiresAt: null, resendRequestedAt: null, stage: null, deliveryTracked: null }, status), null,
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

console.log('\nthe "send it again" action (000369)')

test('only a live link can be re-sent', () => {
  assert(canResendPayLink(live), 'awaiting_payment is the one state with something to send')
  for (const s of ['link_expired', 'paid', 'none'] as const) {
    assert(!canResendPayLink({ state: s, expiresAt: null, resendRequestedAt: null, stage: null, deliveryTracked: null }),
      `${s} must not offer a resend — an expired link needs a new one, which is a designer's job`)
  }
  assert(!canResendPayLink(null), 'an unread state offers nothing')
})

test('the resend stamp parses off the RPC', () => {
  assertEquals(
    parseProofOrderState({
      state: 'awaiting_payment',
      expires_at: '2026-08-13T12:44:59Z',
      resend_requested_at: '2026-07-30T16:00:00Z',
    }),
    { state: 'awaiting_payment', expiresAt: '2026-08-13T12:44:59Z', resendRequestedAt: '2026-07-30T16:00:00Z', stage: null, deliveryTracked: null },
    'both timestamps survive the allow-list',
  )
})

test('a recent resend keeps the acknowledgement across a reload', () => {
  const now = Date.parse('2026-07-30T16:05:00Z')
  assert(resendIsRecent('2026-07-30T16:00:00Z', now), '5 minutes ago is still within the window')
  assert(resendIsRecent('2026-07-30T16:04:59Z', now), 'a moment ago certainly is')
})

test('an old resend re-arms the button', () => {
  const now = Date.parse('2026-07-30T16:20:00Z')
  assert(!resendIsRecent('2026-07-30T16:00:00Z', now),
    `20 minutes is past the ${RESEND_COOLDOWN_MINUTES}-minute window, so they can ask again`)
  assert(!resendIsRecent(null, now), 'never sent → no acknowledgement')
})

test('a garbled or future stamp never strands the button', () => {
  const now = Date.parse('2026-07-30T16:00:00Z')
  assert(!resendIsRecent('not-a-date', now), 'unparseable must not read as recent')
  assert(!resendIsRecent('2026-07-30T18:00:00Z', now),
    'a future stamp (clock skew) must re-arm rather than lock the button forever')
})

test('the resend copy is the one place a send may be claimed, and only of the thread', () => {
  // The card body must never claim a send (see the sweep above) because
  // 'awaiting_payment' does not mean anything was delivered. This copy may,
  // because it describes an action we just performed — but it still promises
  // the email we hold, never their inbox.
  assert(RESEND_COPY.sent.toLowerCase().includes('on its way'),
    'the acknowledgement should describe the send it actually made')
  assert(RESEND_COPY.sent.toLowerCase().includes('spam'),
    'the commonest reason it "did not arrive" deserves naming')
  assert(RESEND_COPY.error.toLowerCase().includes('reply to any message from us'),
    'the fallback route must survive on the error path, since the body no longer carries it')
  for (const v of Object.values(RESEND_COPY)) {
    for (const forbidden of ['/order/', 'token', 'http://', 'https://']) {
      assert(!v.toLowerCase().includes(forbidden),
        `resend copy "${v.slice(0, 24)}…" must never contain ${forbidden}`)
    }
  }
})

test('the awaiting_payment body hands off to the button, not to a reply', () => {
  const copy = readyToOrderCopy(live, 'approved')!
  assert(copy.body.includes('Can’t find yours?'),
    'the body should set up the button that follows it')
  assert(!copy.body.includes('reply to any message'),
    'with a button present the reply route would be the weaker of two answers; it lives on the error path')
})

console.log('\nthe security invariant')

test('no copy ever contains a link, path or token', () => {
  const payloads: ProofOrderStatePayload[] = [
    live,
    { state: 'link_expired', expiresAt: null, resendRequestedAt: null, stage: null, deliveryTracked: null },
    { state: 'none', expiresAt: null, resendRequestedAt: null, stage: null, deliveryTracked: null },
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
  assertEquals(
    Object.keys(parsed!).sort(),
    ['deliveryTracked', 'expiresAt', 'resendRequestedAt', 'stage', 'state'],
    'the parser is an allow-list: only the display fields survive — never an id or token',
  )
})

// ── The order status on the approved card (000371) ──────────────────────────

console.log('\nthe order status shown on the approved card (000371)')

test('a paid order in production says where it is', () => {
  const s = orderStatusLine({
    state: 'paid', expiresAt: null, resendRequestedAt: null,
    stage: 'in_production', deliveryTracked: null,
  })
  assertEquals(s!.label, 'In production', 'label comes from the shared stage copy')
  assertEquals(s!.stage, 'in_production', 'the stage drives the progress strip')
  assert(s!.line.length > 0, 'a stage without a sentence is just jargon')
})

test('a delivered order is reported as delivered', () => {
  const s = orderStatusLine({
    state: 'paid', expiresAt: null, resendRequestedAt: null,
    stage: 'delivered', deliveryTracked: true,
  })
  assertEquals(s!.label, 'Delivered', 'the stage 000370 made reachable')
})

test('paid with tracking switched off still confirms the payment', () => {
  // The stage is null when an admin has customer tracking off, or the Stock
  // Control job was cancelled. Saying nothing at all would leave someone who
  // came back specifically to check their money with no answer.
  const s = orderStatusLine({
    state: 'paid', expiresAt: null, resendRequestedAt: null,
    stage: null, deliveryTracked: null,
  })
  assertEquals(s!.label, 'Paid', 'the payment is still a fact worth stating')
  assertEquals(s!.stage, null, 'but there is no journey to draw')
})

test('an outstanding payment is named, without repeating the deadline', () => {
  const s = orderStatusLine({
    state: 'awaiting_payment', expiresAt: '2026-08-13T12:44:59Z', resendRequestedAt: null,
    stage: null, deliveryTracked: null,
  })
  assertEquals(s!.label, 'Awaiting payment', 'label')
  assert(!('expiresAt' in s!), 'the deadline belongs to the Ready-to-order panel alone')
  assert(!/valid until/i.test(s!.line), 'and must not be restated here in prose either')
})

test('an expired link and a proof with no order say nothing on the card', () => {
  // Both are already handled by the Ready-to-order panel, which also carries
  // the way out. Two messages about one problem is worse than one.
  for (const state of ['link_expired', 'none'] as const) {
    assertEquals(
      orderStatusLine({ state, expiresAt: null, resendRequestedAt: null, stage: null, deliveryTracked: null }),
      null,
      `${state} must not add a second voice to the page`,
    )
  }
  assertEquals(orderStatusLine(null), null, 'an unread state shows nothing')
})

test('the card copy never leaks a link, a token or an amount', () => {
  const stages = [null, 'paid', 'in_production', 'on_its_way', 'delivered'] as const
  for (const stage of stages) {
    for (const state of ['awaiting_payment', 'paid'] as const) {
      const s = orderStatusLine({
        state, expiresAt: null, resendRequestedAt: null,
        stage: stage as never, deliveryTracked: null,
      })
      if (!s) continue
      const text = `${s.label} ${s.line}`
      assert(!/https?:\/\//i.test(text), `"${text}" must contain no URL`)
      assert(!/\/order|\/p\//i.test(text), `"${text}" must contain no path`)
      assert(!/[£$€]\s?\d/.test(text), `"${text}" must quote no amount`)
      assert(!/\btoken\b/i.test(text), `"${text}" must not mention a token`)
    }
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
