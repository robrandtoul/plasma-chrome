// Tests for the order-hold rules (src/lib/orderHolds.ts).
//
// The interesting cases are all about the "customer replied" prompt, because
// helpscout_last_customer_reply_at is thread-wide: it is stamped by ANY reply
// on the conversation, not by an answer to our question. Getting that wrong in
// the permissive direction produces a card that says the customer has come back
// when they have not — on a queue where the next action is irreversible.
//
// Run: npx tsx src/lib/orderHolds.test.ts

import {
  HOLD_COPY,
  HOLD_REASON_MAX,
  customerRepliedSince,
  holdBlockReason,
  holdReasonError,
  holdState,
  isHeld,
  repliedLine,
} from './orderHolds.ts'

let passed = 0
let failed = 0

function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++
  } else {
    failed++
    console.error(`  FAIL: ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function eq<T>(name: string, actual: T, expected: T) {
  check(name, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`)
}

const HELD = '2026-08-02T10:00:00.000Z'
const BEFORE = '2026-08-01T10:00:00.000Z'
const AFTER = '2026-08-03T10:00:00.000Z'
const LATER = '2026-08-04T10:00:00.000Z'

// ── holdState ──────────────────────────────────────────────────────────────

{
  eq('no row is not held', holdState(null).held, false)
  eq('a null held_at is not held', holdState({ held_at: null }).held, false)
  eq('isHeld agrees', isHeld({ held_at: null }), false)
  eq('isHeld agrees when held', isHeld({ held_at: HELD }), true)
}

{
  const s = holdState({ held_at: HELD, hold_reason: '  asked about the mobile  ', held_by_name: ' Rob Randtoul ' })
  check('a held row reports held', s.held)
  if (s.held) {
    eq('reason is trimmed', s.reason, 'asked about the mobile')
    eq('name is trimmed', s.byName, 'Rob Randtoul')
    eq('no reply context means no reply', s.repliedAt, null)
  }
}

{
  // The DB CHECK forbids this, but a stale cache or a mid-migration read could
  // produce it — an empty band explains nothing, which is worse than a hedge.
  const blank = holdState({ held_at: HELD, hold_reason: '   ' })
  check('a blank reason degrades rather than rendering empty', blank.held && blank.reason.length > 0)

  const unnamed = holdState({ held_at: HELD, hold_reason: 'x', held_by_name: '  ' })
  check('a whitespace-only name is held', unnamed.held)
  if (unnamed.held) eq('and reads as null, not blank', unnamed.byName, null)
}

// ── customerRepliedSince: the load-bearing predicate ───────────────────────

{
  eq('a reply after the hold counts',
    customerRepliedSince(HELD, { lastCustomerReplyAt: AFTER }), AFTER)
}

{
  // The whole reason the hold timestamp is the anchor: the thread is full of
  // pre-approval back-and-forth we have already dealt with.
  eq('a reply from BEFORE the hold does not count',
    customerRepliedSince(HELD, { lastCustomerReplyAt: BEFORE }), null)
  eq('a reply exactly at the hold does not count',
    customerRepliedSince(HELD, { lastCustomerReplyAt: HELD }), null)
}

{
  // We have already answered them, so the prompt would be stale.
  eq('a reply we have since answered does not count',
    customerRepliedSince(HELD, { lastCustomerReplyAt: AFTER, lastStaffReplyAt: LATER }), null)
  eq('a staff reply at the same moment counts as answered',
    customerRepliedSince(HELD, { lastCustomerReplyAt: AFTER, lastStaffReplyAt: AFTER }), null)
  eq('but a staff reply BEFORE theirs leaves it outstanding',
    customerRepliedSince(HELD, { lastCustomerReplyAt: LATER, lastStaffReplyAt: AFTER }), LATER)
}

{
  eq('no stamps at all', customerRepliedSince(HELD, {}), null)
  eq('null context', customerRepliedSince(HELD, null), null)
  eq('unparseable customer stamp is ignored, not thrown',
    customerRepliedSince(HELD, { lastCustomerReplyAt: 'not a date' }), null)
  eq('unparseable hold stamp is ignored',
    customerRepliedSince('nonsense', { lastCustomerReplyAt: AFTER }), null)
  // An unparseable STAFF stamp must not silently suppress a real reply.
  eq('unparseable staff stamp does not swallow the reply',
    customerRepliedSince(HELD, { lastCustomerReplyAt: AFTER, lastStaffReplyAt: 'nonsense' }), AFTER)
}

{
  const s = holdState(
    { held_at: HELD, hold_reason: 'asked about the number' },
    { lastCustomerReplyAt: AFTER },
  )
  eq('holdState threads the reply through', s.held && s.repliedAt, AFTER)
  const line = repliedLine(s)
  check('and offers a line to show', !!line)
  // It must read as an errand, never as "answered" — the stamp cannot know
  // what they actually said.
  check('worded as go and read it, not as answered', !/answered|resolved|cleared/i.test(line ?? ''), line ?? '')
}

{
  eq('an unheld order has no replied line', repliedLine({ held: false }), null)
  eq('a held order with no reply has no line',
    repliedLine(holdState({ held_at: HELD, hold_reason: 'x' })), null)
}

// ── Copy ───────────────────────────────────────────────────────────────────

{
  const r = holdBlockReason(holdState({ held_at: HELD, hold_reason: 'x', held_by_name: 'Chris Jackson' }))
  check('the block reason names who held it', /Chris Jackson/.test(r ?? ''), r ?? '')
  check('and says how to proceed', /take it off hold/i.test(r ?? ''), r ?? '')
  // Never promise more than the software delivers: the Help Scout note parser
  // creates Stock Control jobs without an order row at all.
  check('but never claims nobody can place it', !/nobody|no one|cannot be placed/i.test(r ?? ''), r ?? '')
  eq('and an unheld order has no block reason', holdBlockReason({ held: false }), null)
}

{
  const r = holdBlockReason(holdState({ held_at: HELD, hold_reason: 'x' }))
  check('an unattributed hold still reads as a sentence', /^This is on hold/.test(r ?? ''), r ?? '')
}

{
  // The dialog is shown for BOTH a paid order (Place) and a revision order
  // (Waiting → Being revised), so its body must not name a section. It said
  // "stays in your Place list" until holds opened up to revision orders.
  check('the dialog body names no section', !/Place list|Place section/i.test(HOLD_COPY.dialog_body), HOLD_COPY.dialog_body)
  check('and still scopes the promise to "from here"', /from here/.test(HOLD_COPY.dialog_body), HOLD_COPY.dialog_body)
  check('never promising nobody can place it', !/nobody|no one/i.test(HOLD_COPY.dialog_body), HOLD_COPY.dialog_body)
  // "Release" already means "Release from combined payment" on this page.
  check('no label says Release', ![HOLD_COPY.put, HOLD_COPY.take_off, HOLD_COPY.confirm, HOLD_COPY.take_off_confirm].some((s) => /release/i.test(s)))
}

// ── Reason validation ──────────────────────────────────────────────────────

{
  check('an empty reason is refused', !!holdReasonError(''))
  check('whitespace only is refused', !!holdReasonError('   '))
  eq('a real reason passes', holdReasonError('waiting on the phone number'), null)
  eq('exactly at the cap passes', holdReasonError('x'.repeat(HOLD_REASON_MAX)), null)
  check('over the cap is refused', !!holdReasonError('x'.repeat(HOLD_REASON_MAX + 1)))
  // The DB CHECK measures the TRIMMED length, so the client must agree or the
  // write bounces with a raw constraint violation.
  eq('padding does not push a valid reason over', holdReasonError('  ' + 'x'.repeat(HOLD_REASON_MAX) + '  '), null)
}

console.log(`\norderHolds: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
