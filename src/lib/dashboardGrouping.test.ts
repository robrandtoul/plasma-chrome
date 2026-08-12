// Unit tests for dashboardGrouping.ts
// Run with: npx tsx src/lib/dashboardGrouping.test.ts
//
// Tests focus on recentlyAwakened() and groupByTime() — the logic that
// determines where a proof appears in the time-bucketed list after a
// snooze expires.

import { recentlyAwakened, isCurrentlySnoozed, groupByTime, activityTimestamp, buildSnoozedSection, proofBucket, recentHelpscoutActivity, helpscoutReplyEvents, resolveCustomer, orderPaidEvents, groupPayLinkOpenEvents, checkoutHelpEvents, reorderRequestedEvents, bundleOpenedEvents, designerMessageEvents, followupReminderEvents, orderConfirmationEvents, orderGroupConfirmationEvents, bundleSentEvents, supersedeOutbound } from './dashboardGrouping'
import type { DashboardProject, OrderPaidRow, GroupPayLinkOpenRow, CheckoutHelpRow, BundleOpenRow, DesignerMessageRow, DashboardLatestEvent } from './dashboardGrouping'

// ── Helpers ───────────────────────────────────────────────────────────────────

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

/** Build a minimal DashboardProject with sensible defaults. */
function makeProject(overrides: Partial<DashboardProject> = {}): DashboardProject {
  return {
    proof_id:                   'test-id',
    created_at:                 new Date('2020-01-01').toISOString(),
    last_activity_at:           new Date('2020-01-01').toISOString(), // old — Older bucket by default
    status:                     'in_progress',
    approved_at:                null,
    abandoned_at:               null,
    disclaimer_acknowledged_at: null,
    helpscout_conversation_url: null,
    helpscout_conversation_id:  null,
    contact_id:                 null,
    contact_name:               null,
    contact_email:              null,
    company_id:                 null,
    company_name:               null,
    current_version_id:         null,
    current_version_number:     null,
    material_display:           null,
    version_created_at:         null,
    designer_user_id:           null,
    designer_name:              null,
    designer_initials:          null,
    designer_colour:            null,
    latest_event_at:            null,
    latest_event_type:          null,
    latest_event_actor:         null,
    latest_non_view_event_at:   null,
    latest_non_view_event_type: null,
    current_version_viewed_at:  null,
    rule_code:                  null,
    rule_meta:                  null,
    snooze_rule_code:           null,
    snoozed_until:              null,
    snooze_note:                null,
    snoozed_by_name:            null,
    snoozed_by_initials:        null,
    snoozed_by_colour:          null,
    designer_avatar_url:        null,
    helpscout_last_reply_at:          null,
    helpscout_last_customer_reply_at: null,
    follow_up_rule_code:        null,
    follow_up_sent_count:       null,
    follow_up_max_nudges:       null,
    follow_up_last_sent_at:     null,
    has_open_change_request:    false,
    order_status:               null,
    reorder_of_proof_id:        null,
    reorder_requested_at:       null,
    ...overrides,
  }
}

// ── The suite clock ───────────────────────────────────────────────────────────
//
// Every fixture below is built relative to NOW, and NOW is passed into every
// function under test that reads a clock. Nothing here consults the wall clock,
// so a run at 00:19 gives the same answers as a run at midday.
//
// That matters because Today / This week / Older are CALENDAR-day buckets. When
// these fixtures were built from the real Date.now(), `hoursAgo(1)` genuinely
// landed on *yesterday's* date for the first hour after local midnight, so two
// "lands in Today" assertions were simply wrong between 00:00 and 01:00 — the
// code was right. CI runs in UTC and usually dodged the window, which is how it
// survived; it was caught at 00:19 BST on 2026-08-10.
//
// ⚠ Local noon, deliberately, and built with the local-time Date constructor
// rather than an ISO string. The bucket helpers compare LOCAL calendar days, so
// a fixed UTC instant would still sit near midnight in far-offset zones (a
// UTC-noon pin is 01:00 local in UTC+13) and reintroduce the same boundary. Noon
// leaves ~12 hours of headroom either side in every timezone, and DST shifts of
// an hour or two can't push a fixture across a day boundary.
const NOW = new Date(2026, 7, 10, 12, 0, 0, 0).getTime() // 10 Aug 2026, 12:00 local

function hoursAgo(h: number): string {
  return new Date(NOW - h * 3_600_000).toISOString()
}

function hoursFromNow(h: number): string {
  return new Date(NOW + h * 3_600_000).toISOString()
}

function daysAgo(d: number): string {
  return hoursAgo(d * 24)
}

/** helpscoutReplyEvents pinned to the suite clock (its 30-day window reads it). */
function replyEvents(
  projects: DashboardProject[],
  bundles?: ReadonlyMap<string, { setId: string }>,
) {
  return helpscoutReplyEvents(projects, bundles, NOW)
}

// ── recentlyAwakened() ────────────────────────────────────────────────────────

console.log('\nrecentlyAwakened()')

test('returns false when snoozed_until is null', () => {
  const p = makeProject({ snoozed_until: null })
  assert(!recentlyAwakened(p, NOW), 'should be false')
})

test('returns false when snooze is still active (expires in the future)', () => {
  const p = makeProject({ snoozed_until: hoursFromNow(12) })
  assert(!recentlyAwakened(p, NOW), 'should be false — snooze not yet expired')
})

test('returns true when snooze expired 1 hour ago', () => {
  const p = makeProject({ snoozed_until: hoursAgo(1) })
  assert(recentlyAwakened(p, NOW), 'should be true — expired within 24 h window')
})

test('returns true when snooze expired 23 hours ago (boundary)', () => {
  const p = makeProject({ snoozed_until: hoursAgo(23) })
  assert(recentlyAwakened(p, NOW), 'should be true — still within 24 h window')
})

test('returns false when snooze expired 25 hours ago (outside window)', () => {
  const p = makeProject({ snoozed_until: hoursAgo(25) })
  assert(!recentlyAwakened(p, NOW), 'should be false — outside 24 h window')
})

test('returns false when snooze expired 1 week ago', () => {
  const p = makeProject({ snoozed_until: daysAgo(7) })
  assert(!recentlyAwakened(p, NOW), 'should be false — long expired')
})

// ── groupByTime() — normal bucketing (no snooze) ──────────────────────────────

console.log('\ngroupByTime() — standard bucketing')

test('proof with last_activity_at = today lands in Today', () => {
  // hoursAgo(0), not `new Date()` — with the clock pinned, a real-clock fixture
  // would drift onto a different calendar day from NOW and fail from 11 Aug on.
  const p = makeProject({ last_activity_at: hoursAgo(0) })
  const sections = groupByTime([p], NOW)
  assertEqual(sections.length, 1)
  assertEqual(sections[0].key, 'today')
})

test('proof with last_activity_at = 3 days ago lands in This week', () => {
  const p = makeProject({ last_activity_at: daysAgo(3) })
  const sections = groupByTime([p], NOW)
  assertEqual(sections.length, 1)
  assertEqual(sections[0].key, 'week')
})

test('proof with last_activity_at = 10 days ago lands in Older', () => {
  const p = makeProject({ last_activity_at: daysAgo(10) })
  const sections = groupByTime([p], NOW)
  assertEqual(sections.length, 1)
  assertEqual(sections[0].key, 'older')
})

test('empty list returns no sections', () => {
  assertEqual(groupByTime([], NOW).length, 0)
})

test('proof with null last_activity_at lands in Older', () => {
  // Defensive against the rare case where a freshly-inserted proof
  // row has not yet been bump-triggered, or a row arrives from a
  // typed cast that allows null. Without the null-guard the proof
  // would slip past every bucket and disappear from the dashboard.
  const p = makeProject({ last_activity_at: null as unknown as string })
  const sections = groupByTime([p], NOW)
  assertEqual(sections.length, 1)
  assertEqual(sections[0].key, 'older')
  assertEqual(sections[0].projects.length, 1)
})

test('proof with missing last_activity_at lands in Older', () => {
  // Same guard, undefined branch.
  const p = makeProject({ last_activity_at: undefined as unknown as string })
  const sections = groupByTime([p], NOW)
  assertEqual(sections.length, 1)
  assertEqual(sections[0].key, 'older')
})

// ── activityTimestamp() + groupByTime() keyed on the activity clock ───────────
//
// Regression guard for the "Willis" case: a proof whose last_activity_at is
// old but whose latest_event_at is recent (e.g. a customer view today) must
// bucket and sort by the recent event, not the stale last_activity_at.

console.log('\nactivityTimestamp() — sort/group clock')

test('activityTimestamp prefers latest_event_at over last_activity_at', () => {
  const recent = hoursAgo(1)
  const p = makeProject({ last_activity_at: daysAgo(10), latest_event_at: recent })
  assertEqual(activityTimestamp(p), recent)
})

test('activityTimestamp falls back to last_activity_at when no event', () => {
  const p = makeProject({ last_activity_at: daysAgo(3), latest_event_at: null })
  assertEqual(activityTimestamp(p), p.last_activity_at)
})

test('proof with recent latest_event_at but old last_activity_at lands in Today', () => {
  // The Willis case: viewed minutes ago (latest_event_at), but the row's
  // last_activity_at clock reads days back. Must group by the recent event.
  const p = makeProject({ last_activity_at: daysAgo(9), latest_event_at: hoursAgo(1) })
  const sections = groupByTime([p], NOW)
  assertEqual(sections.length, 1)
  assertEqual(sections[0].key, 'today', 'should be Today via latest_event_at')
})

test('activityTimestamp uses version_created_at when it postdates the last customer event', () => {
  // The Yanko case: a new version sent an hour ago, but the customer's last
  // event (a change request) was three days back. The send is the freshest
  // activity, so the clock must read the send — not the stale customer event.
  const sent = hoursAgo(1)
  const p = makeProject({ last_activity_at: hoursAgo(1), latest_event_at: daysAgo(3), version_created_at: sent })
  assertEqual(activityTimestamp(p), sent)
})

test('activityTimestamp keeps latest_event_at once the customer acts after the send', () => {
  // Once the customer views / responds to the new version, their event is newest
  // again and wins back the clock.
  const viewed = hoursAgo(1)
  const p = makeProject({ latest_event_at: viewed, version_created_at: daysAgo(1) })
  assertEqual(activityTimestamp(p), viewed)
})

test('activityTimestamp uses version_created_at when there is no customer event', () => {
  const sent = hoursAgo(2)
  const p = makeProject({ last_activity_at: daysAgo(5), latest_event_at: null, version_created_at: sent })
  assertEqual(activityTimestamp(p), sent)
})

test('just-sent proof with an old last customer event lands in Today', () => {
  // Regression guard for the freshly-sent-but-not-yet-viewed proof dropping out
  // of Today (Yanko v4): groupByTime keys on the send, not the stale event.
  const p = makeProject({ last_activity_at: hoursAgo(1), latest_event_at: daysAgo(3), version_created_at: hoursAgo(1) })
  const sections = groupByTime([p], NOW)
  assertEqual(sections.length, 1)
  assertEqual(sections[0].key, 'today', 'should be Today via version_created_at')
})

// ── groupByTime() — recently awakened snooze overrides bucket ─────────────────

console.log('\ngroupByTime() — snooze awakening')

test('proof snoozed until 1 h ago, last_activity 10 days ago → Today', () => {
  const p = makeProject({
    last_activity_at: daysAgo(10),
    snoozed_until:    hoursAgo(1),
  })
  const sections = groupByTime([p], NOW)
  assertEqual(sections.length, 1, 'should have exactly one section')
  assertEqual(sections[0].key, 'today', 'should be Today despite old last_activity_at')
  assertEqual(sections[0].projects.length, 1)
})

test('proof snoozed until 23 h ago, last_activity 2 weeks ago → Today', () => {
  const p = makeProject({
    last_activity_at: daysAgo(14),
    snoozed_until:    hoursAgo(23),
  })
  const sections = groupByTime([p], NOW)
  assertEqual(sections[0].key, 'today')
})

test('proof snoozed until 25 h ago falls through to last_activity bucket (Older)', () => {
  const p = makeProject({
    last_activity_at: daysAgo(14),
    snoozed_until:    hoursAgo(25),
  })
  const sections = groupByTime([p], NOW)
  assertEqual(sections[0].key, 'older', 'should fall back to last_activity_at bucketing')
})

test('proof with active (future) snooze and old last_activity → Older (not Today)', () => {
  // Active snoozes are filtered out before groupByTime is called in the
  // dashboard, but if one slips through it should NOT get the awakened boost.
  const p = makeProject({
    last_activity_at: daysAgo(14),
    snoozed_until:    hoursFromNow(24),
  })
  const sections = groupByTime([p], NOW)
  assertEqual(sections[0].key, 'older', 'active snooze should not trigger awakened boost')
})

test('mix of regular and recently-awakened proofs sorts correctly', () => {
  const oldProof    = makeProject({ proof_id: 'old',    last_activity_at: daysAgo(10), snoozed_until: null })
  const weekProof   = makeProject({ proof_id: 'week',   last_activity_at: daysAgo(3),  snoozed_until: null })
  const awakenedP   = makeProject({ proof_id: 'awoken', last_activity_at: daysAgo(10), snoozed_until: hoursAgo(2) })
  const sections    = groupByTime([oldProof, weekProof, awakenedP], NOW)
  const keys        = sections.map((s) => s.key)
  assert(keys.includes('today'), 'Today section should exist')
  assert(keys.includes('week'),  'This week section should exist')
  assert(keys.includes('older'), 'Older section should exist')
  const todaySection = sections.find((s) => s.key === 'today')!
  assertEqual(todaySection.projects[0].proof_id, 'awoken')
})

// ── isCurrentlySnoozed() ──────────────────────────────────────────────────────

console.log('\nisCurrentlySnoozed()')

test('returns false when snoozed_until is null', () => {
  const p = makeProject({ snoozed_until: null })
  assert(!isCurrentlySnoozed(p, NOW), 'should be false')
})

test('returns true when snooze expires in the future', () => {
  const p = makeProject({ snoozed_until: hoursFromNow(12) })
  assert(isCurrentlySnoozed(p, NOW), 'should be true')
})

test('returns false when snooze just expired (recently awakened grace window)', () => {
  // 000186 widens the dashboard view's lateral so snoozed_until carries
  // forward for 24 hours after expiry. isCurrentlySnoozed must NOT treat
  // those rows as still-snoozed — they belong in Today, not in the
  // Snoozed section.
  const p = makeProject({ snoozed_until: hoursAgo(1) })
  assert(!isCurrentlySnoozed(p, NOW), 'should be false — snooze expired')
})

// ── buildSnoozedSection() ─────────────────────────────────────────────────────

console.log('\nbuildSnoozedSection()')

test('returns empty array when no projects are snoozed', () => {
  const sections = buildSnoozedSection([makeProject({ snoozed_until: null })], NOW)
  assertEqual(sections.length, 0)
})

test('returns one Snoozed section when a project has an active snooze', () => {
  const p = makeProject({ snoozed_until: hoursFromNow(24) })
  const sections = buildSnoozedSection([p], NOW)
  assertEqual(sections.length, 1)
  assertEqual(sections[0].kind, 'snoozed')
  assertEqual(sections[0].projects.length, 1)
})

test('only currently-snoozed projects appear in the snoozed section', () => {
  const snoozed  = makeProject({ proof_id: 'snoozed', snoozed_until: hoursFromNow(24) })
  const normal   = makeProject({ proof_id: 'normal',  snoozed_until: null })
  const sections = buildSnoozedSection([snoozed, normal], NOW)
  assertEqual(sections[0].projects.length, 1)
  assertEqual(sections[0].projects[0].proof_id, 'snoozed')
})

test('recently-awakened proofs are excluded from the snoozed section', () => {
  // After 000186, snoozed_until persists for 24 h post-expiry to power
  // recentlyAwakened bucketing. The Snoozed section must still hide
  // those rows or the count would over-report the live snooze tally.
  const recentlyAwoken = makeProject({ proof_id: 'awoken',  snoozed_until: hoursAgo(2) })
  const stillSnoozed   = makeProject({ proof_id: 'snoozed', snoozed_until: hoursFromNow(2) })
  const sections = buildSnoozedSection([recentlyAwoken, stillSnoozed], NOW)
  assertEqual(sections[0].projects.length, 1)
  assertEqual(sections[0].projects[0].proof_id, 'snoozed')
})

// ── proofBucket() ─────────────────────────────────────────────────────────────
//
// One proof → one workflow bucket, shared by the status pill, the row's left
// cap, and the matching headline tile. These tests pin the precedence order.

console.log('\nproofBucket()')

test('in_progress with an unopened current version → not_viewed', () => {
  const p = makeProject({ status: 'in_progress', current_version_id: 'v1', current_version_viewed_at: null })
  assertEqual(proofBucket(p, NOW).bucket, 'not_viewed')
  assertEqual(proofBucket(p, NOW).label, 'Not viewed')
})

test('in_progress, current version viewed, nothing else → awaiting_customer', () => {
  const p = makeProject({ status: 'in_progress', current_version_id: 'v1', current_version_viewed_at: hoursAgo(2) })
  assertEqual(proofBucket(p, NOW).bucket, 'awaiting_customer')
})

test('change request raised after the current version → changes_requested', () => {
  const p = makeProject({
    status: 'in_progress',
    current_version_id: 'v1',
    current_version_viewed_at: hoursAgo(2),
    version_created_at: daysAgo(3),
    latest_non_view_event_type: 'request_changes',
    latest_non_view_event_at: daysAgo(1),
  })
  assertEqual(proofBucket(p, NOW).bucket, 'changes_requested')
})

test('change request older than the current version does not fire → awaiting_customer', () => {
  const p = makeProject({
    status: 'in_progress',
    current_version_id: 'v1',
    current_version_viewed_at: hoursAgo(2),
    version_created_at: daysAgo(1),
    latest_non_view_event_type: 'request_changes',
    latest_non_view_event_at: daysAgo(3), // answered by a newer version
  })
  assertEqual(proofBucket(p, NOW).bucket, 'awaiting_customer')
})

// 000279: multi-slot proof (Set collection / multi-recipient). The customer
// requested changes on one slot, then APPROVED a different slot afterwards — so
// the latest non-view event is an `approve` and the old latest-event signal
// would mask the open request as awaiting_customer. has_open_change_request
// carries the per-slot truth, so it still buckets as changes_requested.
test('open change request masked by a later approve on another slot → changes_requested', () => {
  const p = makeProject({
    status: 'in_progress',
    current_version_id: 'v1',
    current_version_viewed_at: hoursAgo(2),
    version_created_at: daysAgo(3),
    latest_non_view_event_type: 'approve', // last action was approving a different slot
    latest_non_view_event_at: hoursAgo(1),
    has_open_change_request: true,
  })
  assertEqual(proofBucket(p, NOW).bucket, 'changes_requested')
})

test('automation actively chasing a viewed proof → in_follow_up (not awaiting_customer)', () => {
  const p = makeProject({
    status: 'in_progress',
    current_version_id: 'v1',
    current_version_viewed_at: hoursAgo(2), // would otherwise be awaiting_customer
    follow_up_rule_code: 'viewed_not_actioned',
  })
  assertEqual(proofBucket(p, NOW).bucket, 'in_follow_up')
  assertEqual(proofBucket(p, NOW).label, 'In auto follow-up')
})

test('automation chasing an unopened proof → in_follow_up (not not_viewed)', () => {
  const p = makeProject({
    status: 'in_progress',
    current_version_id: 'v1',
    current_version_viewed_at: null, // would otherwise be not_viewed
    follow_up_rule_code: 'sent_never_viewed',
  })
  assertEqual(proofBucket(p, NOW).bucket, 'in_follow_up')
})

test('a customer reply beats an active chase → customer_replied wins over in_follow_up', () => {
  const p = makeProject({
    status: 'in_progress',
    current_version_id: 'v1',
    current_version_viewed_at: null,
    version_created_at: daysAgo(3),
    follow_up_rule_code: 'sent_never_viewed', // chase on the clock
    helpscout_last_reply_at: daysAgo(2),
    helpscout_last_customer_reply_at: hoursAgo(3), // but the customer wrote back
  })
  assertEqual(proofBucket(p, NOW).bucket, 'customer_replied')
})

test('customer replied by email after our last reply and the current version → customer_replied', () => {
  const p = makeProject({
    status: 'in_progress',
    current_version_id: 'v1',
    current_version_viewed_at: hoursAgo(2), // would otherwise be awaiting_customer
    version_created_at: daysAgo(3),
    helpscout_last_reply_at: daysAgo(2),    // our last reply
    helpscout_last_customer_reply_at: hoursAgo(3), // newer customer reply → our move
  })
  assertEqual(proofBucket(p, NOW).bucket, 'customer_replied')
  assertEqual(proofBucket(p, NOW).label, 'Replied by email')
})

test('customer reply we have already answered (staff reply newer) → not customer_replied', () => {
  const p = makeProject({
    status: 'in_progress',
    current_version_id: 'v1',
    current_version_viewed_at: hoursAgo(2),
    version_created_at: daysAgo(3),
    helpscout_last_customer_reply_at: daysAgo(2),
    helpscout_last_reply_at: hoursAgo(1), // we replied since → no longer our move
  })
  assertEqual(proofBucket(p, NOW).bucket, 'awaiting_customer')
})

test('customer reply older than the current version → not customer_replied', () => {
  const p = makeProject({
    status: 'in_progress',
    current_version_id: 'v1',
    current_version_viewed_at: hoursAgo(2),
    version_created_at: hoursAgo(1),          // we shipped a newer version since the reply
    helpscout_last_customer_reply_at: daysAgo(2),
  })
  assertEqual(proofBucket(p, NOW).bucket, 'awaiting_customer')
})

test('customer reply on a thread we never replied to → customer_replied', () => {
  const p = makeProject({
    status: 'in_progress',
    current_version_id: 'v1',
    current_version_viewed_at: hoursAgo(2),
    version_created_at: daysAgo(3),
    helpscout_last_reply_at: null,            // no staff timestamp to beat
    helpscout_last_customer_reply_at: hoursAgo(3),
  })
  assertEqual(proofBucket(p, NOW).bucket, 'customer_replied')
})

test('a sidebar change request outranks an email reply (both present) → changes_requested', () => {
  const p = makeProject({
    status: 'in_progress',
    current_version_id: 'v1',
    current_version_viewed_at: hoursAgo(2),
    version_created_at: daysAgo(3),
    latest_non_view_event_type: 'request_changes',
    latest_non_view_event_at: daysAgo(1),
    helpscout_last_customer_reply_at: hoursAgo(3), // also replied by email
  })
  assertEqual(proofBucket(p, NOW).bucket, 'changes_requested')
})

test('terminal statuses map straight through', () => {
  assertEqual(proofBucket(makeProject({ status: 'approved'  }), NOW).bucket, 'approved')
  assertEqual(proofBucket(makeProject({ status: 'dormant'   }), NOW).bucket, 'dormant')
  assertEqual(proofBucket(makeProject({ status: 'abandoned' }), NOW).bucket, 'abandoned')
})

// ── order_status extends the approved slot (000307) ─────────────────────────
test('approved proof with a paid/fulfilled order reads Ordered', () => {
  const p = makeProject({ status: 'approved', order_status: 'ordered' })
  assertEqual(proofBucket(p, NOW).bucket, 'ordered')
  assertEqual(proofBucket(p, NOW).label, 'Ordered')
})

test('approved proof with an unpaid pay link reads Awaiting payment', () => {
  const p = makeProject({ status: 'approved', order_status: 'awaiting_payment' })
  assertEqual(proofBucket(p, NOW).bucket, 'awaiting_payment')
  assertEqual(proofBucket(p, NOW).label, 'Awaiting payment')
})

test('approved proof with no live payable order still reads Approved', () => {
  // A cancelled/expired-only proof surfaces order_status null and stays Approved.
  assertEqual(proofBucket(makeProject({ status: 'approved', order_status: null }), NOW).bucket, 'approved')
})

test('order_status only affects approved proofs, never in_progress', () => {
  // Defensive: order_status is only ever non-null on approved proofs in the
  // data, but even if it leaked onto an in_progress row the workflow buckets win.
  const p = makeProject({
    status: 'in_progress',
    current_version_id: 'v1',
    current_version_viewed_at: hoursAgo(2),
    order_status: 'ordered',
  })
  assertEqual(proofBucket(p, NOW).bucket, 'awaiting_customer')
})

test('needs attention still wins over an ordered proof', () => {
  const p = makeProject({ status: 'approved', order_status: 'ordered', rule_code: 'approved_no_order' })
  assertEqual(proofBucket(p, NOW).bucket, 'needs_attention')
})

test('rule_code (needs attention) wins over the in_progress workflow state', () => {
  const p = makeProject({
    status: 'in_progress',
    current_version_id: 'v1',
    current_version_viewed_at: hoursAgo(2), // would otherwise be awaiting_customer
    rule_code: 'sent_never_viewed',
  })
  assertEqual(proofBucket(p, NOW).bucket, 'needs_attention')
})

test('rule_code wins even on a dormant proof', () => {
  const p = makeProject({ status: 'dormant', rule_code: 'approaching_dormant' })
  assertEqual(proofBucket(p, NOW).bucket, 'needs_attention')
})

test('an active snooze wins over everything, including a rule_code', () => {
  const p = makeProject({
    status: 'in_progress',
    rule_code: 'stuck_in_progress',
    snoozed_until: hoursFromNow(12),
  })
  assertEqual(proofBucket(p, NOW).bucket, 'snoozed')
})

test('a recently-expired snooze (grace window) does not count as snoozed', () => {
  const p = makeProject({ status: 'in_progress', current_version_id: 'v1', snoozed_until: hoursAgo(2) })
  assertEqual(proofBucket(p, NOW).bucket, 'not_viewed')
})

test('terminal status wins over the in_progress workflow sub-states (dormant, unviewed)', () => {
  // A dormant proof whose current version was never viewed: the Dormant
  // status takes precedence over not_viewed, matching the left-cap order.
  const p = makeProject({ status: 'dormant', current_version_id: 'v1', current_version_viewed_at: null })
  assertEqual(proofBucket(p, NOW).bucket, 'dormant')
})

// ── recentHelpscoutActivity() ─────────────────────────────────────────────────

console.log('\nrecentHelpscoutActivity()')

test('null when there is no Help Scout reply activity', () => {
  assertEqual(recentHelpscoutActivity(makeProject(), 3, NOW), null)
})

test('returns the staff reply when it is recent', () => {
  const p = makeProject({ helpscout_last_reply_at: hoursAgo(2) })
  assertEqual(recentHelpscoutActivity(p, 3, NOW)?.kind, 'staff')
})

test('returns the most recent of staff vs customer', () => {
  const p = makeProject({
    helpscout_last_reply_at: daysAgo(2),
    helpscout_last_customer_reply_at: hoursAgo(3),
  })
  assertEqual(recentHelpscoutActivity(p, 3, NOW)?.kind, 'customer')
})

test('null when the most recent reply is older than the window', () => {
  const p = makeProject({ helpscout_last_reply_at: daysAgo(5) })
  assertEqual(recentHelpscoutActivity(p, 3, NOW), null)
})

// ── helpscoutReplyEvents() ────────────────────────────────────────────────────
//
// Synthesises Latest-activity feed rows from each proof's Help Scout reply
// timestamps so an email reply (a timestamp, not a stored event) surfaces.

console.log('\nhelpscoutReplyEvents()')

test('no reply timestamps → no events', () => {
  assertEqual(replyEvents([makeProject()]).length, 0)
})

test('customer reply → one customer_reply row attributed to the contact', () => {
  const at = hoursAgo(1)
  const events = replyEvents([
    makeProject({ proof_id: 'p1', contact_name: 'Dalton Rawson', helpscout_last_customer_reply_at: at }),
  ])
  assertEqual(events.length, 1)
  assertEqual(events[0].event_type, 'customer_reply')
  assertEqual(events[0].actor_name, 'Dalton Rawson')
  assertEqual(events[0].created_at, at)
  assertEqual(events[0].id, 'hs-customer-p1')
  assertEqual(events[0].proof_id, 'p1')
})

test('customer reply falls back to company, then to "Customer"', () => {
  const co = replyEvents([
    makeProject({ contact_name: null, company_name: 'Brookland Watch Co', helpscout_last_customer_reply_at: hoursAgo(1) }),
  ])
  assertEqual(co[0].actor_name, 'Brookland Watch Co')
  const none = replyEvents([
    makeProject({ contact_name: null, company_name: null, helpscout_last_customer_reply_at: hoursAgo(1) }),
  ])
  assertEqual(none[0].actor_name, 'Customer')
})

test('staff reply → one staff_reply row attributed to "You"', () => {
  const events = replyEvents([
    makeProject({ proof_id: 'p2', helpscout_last_reply_at: hoursAgo(3) }),
  ])
  assertEqual(events.length, 1)
  assertEqual(events[0].event_type, 'staff_reply')
  assertEqual(events[0].actor_name, 'You')
  assertEqual(events[0].id, 'hs-staff-p2')
})

test('both directions → two rows for the same proof', () => {
  const events = replyEvents([
    makeProject({
      proof_id: 'p3',
      contact_name: 'Sam Shutlar',
      helpscout_last_customer_reply_at: hoursAgo(1),
      helpscout_last_reply_at: hoursAgo(2),
    }),
  ])
  assertEqual(events.length, 2)
  assert(events.some((e) => e.event_type === 'customer_reply'), 'has customer row')
  assert(events.some((e) => e.event_type === 'staff_reply'), 'has staff row')
})

test('replies older than the 30-day window are excluded', () => {
  const events = replyEvents([
    makeProject({
      helpscout_last_customer_reply_at: daysAgo(40),
      helpscout_last_reply_at: daysAgo(31),
    }),
  ])
  assertEqual(events.length, 0)
})

test('version_number carries the current version (0 when none)', () => {
  const withVer = replyEvents([
    makeProject({ current_version_number: 2, helpscout_last_customer_reply_at: hoursAgo(1) }),
  ])
  assertEqual(withVer[0].version_number, 2)
  const noVer = replyEvents([
    makeProject({ current_version_number: null, helpscout_last_customer_reply_at: hoursAgo(1) }),
  ])
  assertEqual(noVer[0].version_number, 0)
})

// ── helpscoutReplyEvents() — one reply, one row ───────────────────────────────
//
// The reply stamps are per proof but a Help Scout conversation is per customer,
// so N proofs on one thread used to print N identical rows for a single reply.

console.log('\nhelpscoutReplyEvents() — conversation de-duplication')

// Three proofs on one conversation, all carrying the same reply stamp — the
// shape a bundle has by design (000317).
function sharedThread(at: string, ids = ['p1', 'p2', 'p3']) {
  return ids.map((id) =>
    makeProject({
      proof_id: id,
      contact_name: 'Trevor Lee',
      helpscout_conversation_id: 'convo-1',
      helpscout_last_customer_reply_at: at,
    }),
  )
}

test('three proofs sharing a conversation and a reply → exactly one row', () => {
  const events = replyEvents(sharedThread(hoursAgo(1)))
  assertEqual(events.length, 1)
  assertEqual(events[0].event_type, 'customer_reply')
  assertEqual(events[0].collapsed?.count, 3)
})

test('collapsing is per direction — a customer and a staff reply stay separate', () => {
  const at = hoursAgo(1)
  const events = replyEvents([
    makeProject({ proof_id: 'p1', helpscout_conversation_id: 'c', helpscout_last_customer_reply_at: at, helpscout_last_reply_at: at }),
    makeProject({ proof_id: 'p2', helpscout_conversation_id: 'c', helpscout_last_customer_reply_at: at, helpscout_last_reply_at: at }),
  ])
  assertEqual(events.length, 2)
  assert(events.some((e) => e.event_type === 'customer_reply'), 'kept the customer row')
  assert(events.some((e) => e.event_type === 'staff_reply'), 'kept the staff row')
  assert(events.every((e) => e.collapsed?.count === 2), 'both collapsed a pair')
})

test('two replies at different times on one conversation stay two rows', () => {
  const events = replyEvents([
    makeProject({ proof_id: 'p1', helpscout_conversation_id: 'c', helpscout_last_customer_reply_at: hoursAgo(1) }),
    makeProject({ proof_id: 'p2', helpscout_conversation_id: 'c', helpscout_last_customer_reply_at: hoursAgo(5) }),
  ])
  assertEqual(events.length, 2)
  assert(events.every((e) => e.collapsed === undefined), 'neither row claims to cover others')
})

test('different conversations are never collapsed, even at the same instant', () => {
  const at = hoursAgo(1)
  const events = replyEvents([
    makeProject({ proof_id: 'p1', helpscout_conversation_id: 'c1', helpscout_last_customer_reply_at: at }),
    makeProject({ proof_id: 'p2', helpscout_conversation_id: 'c2', helpscout_last_customer_reply_at: at }),
  ])
  assertEqual(events.length, 2)
})

// The regression this guards: keying on a null conversation id would fold every
// unlinked proof that happened to share a timestamp into a single row.
test('proofs with no conversation id are never collapsed together', () => {
  const at = hoursAgo(1)
  const events = replyEvents([
    makeProject({ proof_id: 'p1', helpscout_conversation_id: null, helpscout_last_customer_reply_at: at }),
    makeProject({ proof_id: 'p2', helpscout_conversation_id: null, helpscout_last_customer_reply_at: at }),
  ])
  assertEqual(events.length, 2)
  assert(events.every((e) => e.collapsed === undefined), 'no collapse marker')
})

test('a lone row on a conversation carries no collapsed marker', () => {
  const events = replyEvents([
    makeProject({ proof_id: 'p1', helpscout_conversation_id: 'c', helpscout_last_customer_reply_at: hoursAgo(1) }),
  ])
  assertEqual(events.length, 1)
  assertEqual(events[0].collapsed, undefined)
})

test('the surviving row is the same one regardless of input order', () => {
  const at = hoursAgo(1)
  const forward = replyEvents(sharedThread(at, ['p1', 'p2', 'p3']))
  const reversed = replyEvents(sharedThread(at, ['p3', 'p2', 'p1']))
  assertEqual(forward[0].proof_id, reversed[0].proof_id)
  assertEqual(forward[0].id, reversed[0].id)
})

// Sharing a thread is the trigger, but only a real bundle may be CALLED one —
// two unrelated projects raised off one email thread collapse identically.
test('collapsed rows are only marked as a bundle when every proof is in one', () => {
  const at = hoursAgo(1)
  const projects = sharedThread(at, ['p1', 'p2'])

  const allInOneBundle = replyEvents(projects, new Map([
    ['p1', { setId: 'set-a' }],
    ['p2', { setId: 'set-a' }],
  ]))
  assertEqual(allInOneBundle[0].collapsed?.bundle, true)

  const differentBundles = replyEvents(projects, new Map([
    ['p1', { setId: 'set-a' }],
    ['p2', { setId: 'set-b' }],
  ]))
  assertEqual(differentBundles[0].collapsed?.bundle, false)

  const oneLooseProof = replyEvents(projects, new Map([
    ['p1', { setId: 'set-a' }],
  ]))
  assertEqual(oneLooseProof[0].collapsed?.bundle, false)

  const noBundleInfoAtAll = replyEvents(projects)
  assertEqual(noBundleInfoAtAll[0].collapsed?.count, 2)
  assertEqual(noBundleInfoAtAll[0].collapsed?.bundle, false)
})

// ── Order & checkout activity rows ────────────────────────────────────────────
//
// Each builder below bridges a TIMESTAMP into the feed — a payment, a question
// asked at the checkout, a bundle being opened. None is a stored event, which is
// why none of them was on the dashboard at all until now, and the mistakes they
// can make are the quiet kind: a row announcing money that never arrived, or one
// customer's single payment printed three times over.

console.log('\nresolveCustomer()')

test('the loaded project names the row when it has one', () => {
  const who = resolveCustomer(
    makeProject({ contact_name: 'Ada Lovelace', company_name: 'Analytical Engines', current_version_number: 3 }),
    { contacts: { full_name: 'Stale Name', companies: { name: 'Stale Co' } } },
  )
  assertEqual(who.companyName, 'Analytical Engines')
  assertEqual(who.versionNumber, 3)
})

// The measured case: 69 of 123 payments in the 30 days to 11 Aug 2026 sat on
// proofs outside the dashboard's working set, because a project is approved and
// closed long before the money arrives.
test('a proof outside the working set is still named, from the embed', () => {
  const who = resolveCustomer(undefined, { contacts: { full_name: 'Ada Lovelace', companies: { name: 'Analytical Engines' } } })
  assertEqual(who.contactName, 'Ada Lovelace')
  assertEqual(who.companyName, 'Analytical Engines')
  assertEqual(who.actorName, 'Ada Lovelace')
  assertEqual(who.versionNumber, 0, 'the embed carries no version, and no row in this family prints one')
})

// PostgREST returns a to-one embed as an object or a single-element array
// depending on how the types infer — the order_nudges fetch has always had to
// normalise both.
test('the array form of a to-one embed is read the same as the object form', () => {
  const who = resolveCustomer(undefined, [{ contacts: [{ full_name: 'Ada Lovelace', companies: [{ name: 'Analytical Engines' }] }] }])
  assertEqual(who.contactName, 'Ada Lovelace')
  assertEqual(who.companyName, 'Analytical Engines')
})

test('with neither source the row falls back to a generic customer', () => {
  const who = resolveCustomer(undefined, null)
  assertEqual(who.actorName, 'Customer')
  assertEqual(who.contactName, null)
  assertEqual(who.companyName, null)
})

console.log('\norderPaidEvents()')

function paidRow(overrides: Partial<OrderPaidRow> = {}): OrderPaidRow {
  return {
    id: 'o1',
    proof_id: 'p1',
    paid_at: hoursAgo(2),
    order_group_id: null,
    status: 'paid',
    order_kind: 'production',
    ...overrides,
  }
}

const paidProjects = [
  makeProject({ proof_id: 'p1', contact_name: 'Ada Lovelace', company_name: 'Analytical Engines' }),
  makeProject({ proof_id: 'p2', contact_name: 'Ada Lovelace', company_name: 'Analytical Engines' }),
  makeProject({ proof_id: 'p3', contact_name: 'Ada Lovelace', company_name: 'Analytical Engines' }),
]

test('a payment becomes one row naming the customer', () => {
  const events = orderPaidEvents([paidRow()], paidProjects, undefined, NOW)
  assertEqual(events.length, 1)
  assertEqual(events[0].event_type, 'order_paid')
  assertEqual(events[0].company_name, 'Analytical Engines')
  assertEqual(events[0].proof_id, 'p1')
  assertEqual(events[0].collapsed, undefined, 'a lone payment carries no collapsed marker')
})

// Six cancelled orders on live still carry a paid_at. Reading the stamp alone
// would announce a payment for money that has since been given back.
test('a cancelled order keeps its paid_at and must not read as a payment', () => {
  const events = orderPaidEvents([paidRow({ status: 'cancelled' })], paidProjects, undefined, NOW)
  assertEqual(events.length, 0)
})

// A free reprint off the Flagged board is BORN paid — nobody paid anything.
test('a free reprint is born paid and must not read as a payment', () => {
  const events = orderPaidEvents([paidRow({ order_kind: 'reprint' })], paidProjects, undefined, NOW)
  assertEqual(events.length, 0)
})

// The Stripe webhook flips the group and every member together, so the naive
// row-per-order reading prints one payment as three.
test('a combined payment is one row covering its member orders', () => {
  const events = orderPaidEvents(
    [
      paidRow({ id: 'o1', proof_id: 'p1', order_group_id: 'g1' }),
      paidRow({ id: 'o2', proof_id: 'p2', order_group_id: 'g1' }),
      paidRow({ id: 'o3', proof_id: 'p3', order_group_id: 'g1' }),
    ],
    paidProjects, undefined, NOW,
  )
  assertEqual(events.length, 1)
  assertEqual(events[0].collapsed?.count, 3)
  assertEqual(events[0].id, 'order-paid-group-g1')
})

test('the collapsed row carries the newest member stamp', () => {
  const events = orderPaidEvents(
    [
      paidRow({ id: 'o1', proof_id: 'p1', order_group_id: 'g1', paid_at: hoursAgo(5) }),
      paidRow({ id: 'o2', proof_id: 'p2', order_group_id: 'g1', paid_at: hoursAgo(2) }),
    ],
    paidProjects, undefined, NOW,
  )
  assertEqual(events[0].created_at, hoursAgo(2))
})

test('the surviving member is the same one regardless of input order', () => {
  const rows = [
    paidRow({ id: 'o1', proof_id: 'p1', order_group_id: 'g1' }),
    paidRow({ id: 'o2', proof_id: 'p2', order_group_id: 'g1' }),
  ]
  const forward = orderPaidEvents(rows, paidProjects, undefined, NOW)
  const reversed = orderPaidEvents([...rows].reverse(), paidProjects, undefined, NOW)
  assertEqual(forward[0].proof_id, reversed[0].proof_id)
  assertEqual(forward[0].id, reversed[0].id)
})

// Same rule as the reply rows: sharing a payment is the trigger, but only
// proofs genuinely in one bundle may be described as one.
test('a combined payment is only called a bundle when its cards are one', () => {
  const rows = [
    paidRow({ id: 'o1', proof_id: 'p1', order_group_id: 'g1' }),
    paidRow({ id: 'o2', proof_id: 'p2', order_group_id: 'g1' }),
  ]
  const oneBundle = orderPaidEvents(rows, paidProjects, new Map([
    ['p1', { setId: 'set-a' }],
    ['p2', { setId: 'set-a' }],
  ]), NOW)
  assertEqual(oneBundle[0].collapsed?.bundle, true)

  const unrelated = orderPaidEvents(rows, paidProjects, new Map([
    ['p1', { setId: 'set-a' }],
  ]), NOW)
  assertEqual(unrelated[0].collapsed?.bundle, false)
})

test('payments older than the window are dropped', () => {
  const events = orderPaidEvents([paidRow({ paid_at: daysAgo(45) })], paidProjects, undefined, NOW)
  assertEqual(events.length, 0)
})

console.log('\ngroupPayLinkOpenEvents()')

// The group link is the one the customer is sent, and opening it stamps the
// GROUP row — 21 of the 22 paid member orders on live carry no open of their
// own, so reading the orders table alone shows a combined payment as nothing.
test('a combined pay-link open becomes one row keyed to the group', () => {
  const events = groupPayLinkOpenEvents(
    [{ id: 'g1', pay_link_opened_at: hoursAgo(1), orders: [{ proof_id: 'p2' }, { proof_id: 'p1' }] }],
    paidProjects, undefined, NOW,
  )
  assertEqual(events.length, 1)
  assertEqual(events[0].event_type, 'pay_link_opened')
  assertEqual(events[0].id, 'paylink-group-g1')
  assertEqual(events[0].proof_id, 'p1', 'names and links to the same member every load')
  assertEqual(events[0].collapsed?.count, 2)
})

test('a group with no readable members is skipped rather than rendered nameless', () => {
  const rows: GroupPayLinkOpenRow[] = [{ id: 'g1', pay_link_opened_at: hoursAgo(1), orders: [] }]
  assertEqual(groupPayLinkOpenEvents(rows, paidProjects, undefined, NOW).length, 0)
  assertEqual(
    groupPayLinkOpenEvents([{ id: 'g1', pay_link_opened_at: hoursAgo(1), orders: null }], paidProjects, undefined, NOW).length,
    0,
  )
})

console.log('\ncheckoutHelpEvents()')

test('both checkout stamps produce their own row, with distinct verbs', () => {
  const rows: CheckoutHelpRow[] = [
    { id: 'o1', proof_id: 'p1', help_requested_at: hoursAgo(3), pay_link_resend_requested_at: hoursAgo(1) },
  ]
  const events = checkoutHelpEvents(rows, paidProjects, NOW)
  assertEqual(events.length, 2)
  assert(events.some((e) => e.event_type === 'checkout_help'), 'has the question row')
  assert(events.some((e) => e.event_type === 'pay_link_resend_requested'), 'has the resend row')
})

// The two stamps are fetched separately so neither truncates the other, which
// means an order carrying both is handed to the builder twice.
test('an order arriving in both fetches is not printed twice', () => {
  const row: CheckoutHelpRow = {
    id: 'o1', proof_id: 'p1', help_requested_at: hoursAgo(3), pay_link_resend_requested_at: null,
  }
  const events = checkoutHelpEvents([row, { ...row }], paidProjects, NOW)
  assertEqual(events.length, 1)
})

test('checkout stamps older than the window are dropped', () => {
  const events = checkoutHelpEvents(
    [{ id: 'o1', proof_id: 'p1', help_requested_at: daysAgo(45), pay_link_resend_requested_at: null }],
    paidProjects, NOW,
  )
  assertEqual(events.length, 0)
})

console.log('\nreorderRequestedEvents()')

test('a reorder request becomes a row on the project that was asked about', () => {
  const events = reorderRequestedEvents(
    [makeProject({ proof_id: 'p9', contact_name: 'Ada Lovelace', reorder_requested_at: hoursAgo(4) })],
    NOW,
  )
  assertEqual(events.length, 1)
  assertEqual(events[0].event_type, 'reorder_requested')
  assertEqual(events[0].proof_id, 'p9')
})

// Nothing ever clears the stamp — it survives the designer raising the reorder,
// so only the window retires the row.
test('a reorder request older than the window is dropped', () => {
  const events = reorderRequestedEvents(
    [makeProject({ proof_id: 'p9', reorder_requested_at: daysAgo(45) })],
    NOW,
  )
  assertEqual(events.length, 0)
})

console.log('\nbundleOpenedEvents()')

const bundleRow: BundleOpenRow = {
  id: 'set-a', last_opened_at: hoursAgo(1), proofs: [{ id: 'p2' }, { id: 'p1' }],
}

test('a bundle open links to the bundle, not to one of its cards', () => {
  const events = bundleOpenedEvents([bundleRow], paidProjects, NOW)
  assertEqual(events.length, 1)
  assertEqual(events[0].event_type, 'bundle_opened')
  assertEqual(events[0].link, '/bundles/set-a')
  assertEqual(events[0].company_name, 'Analytical Engines', 'named from a member project')
})

// last_opened_at is one value that moves, not a log. A bundle-keyed id is what
// turns a second open into the same row with a newer clock.
test('a second open moves the same row rather than adding one', () => {
  const first = bundleOpenedEvents([bundleRow], paidProjects, NOW)
  const second = bundleOpenedEvents([{ ...bundleRow, last_opened_at: hoursAgo(0.5) }], paidProjects, NOW)
  assertEqual(first[0].id, second[0].id)
  assert(second[0].created_at > first[0].created_at, 'the clock moved')
})

// ── The outbound family ───────────────────────────────────────────────────────
//
// Every message we send stamps the same Help Scout column, so the feed used to
// call all of them "was sent a reply". These builders read the record each kind
// of message leaves behind instead; supersedeOutbound keeps one row per message
// when several of them describe the same send.

console.log('\ndesignerMessageEvents()')

const ROSTER = new Map([['u-donna', 'Donna Lambe'], ['u-chris', 'Chris Jackson']])

function versionRow(overrides: Partial<DesignerMessageRow> = {}): DesignerMessageRow {
  return {
    id: 'v-1',
    proof_id: 'p1',
    version_number: 3,
    last_reply_sent_at: hoursAgo(2),
    last_reply_sent_by: 'u-donna',
    proofs: { helpscout_conversation_id: 'convo-1', contacts: null },
    ...overrides,
  }
}

test('a designer message names the sender and the version', () => {
  const events = designerMessageEvents([versionRow()], paidProjects, ROSTER, undefined, NOW)
  assertEqual(events.length, 1)
  assertEqual(events[0].event_type, 'designer_message')
  assertEqual(events[0].actor_name, 'Donna Lambe')
  assertEqual(events[0].version_number, 3)
  assertEqual(events[0].company_name, 'Analytical Engines')
})

// The load-bearing rule. send-nudges stamps last_reply_sent_at exactly like a
// human sender but leaves last_reply_sent_by NULL on purpose (000215), so the
// NULL is the automation's own marker — 31 of these landed in 30 days on live.
// Treating one as a designer message would credit a person for a robot's chase.
test('a NULL sender is the automation, not a designer — no row', () => {
  const events = designerMessageEvents(
    [versionRow({ last_reply_sent_by: null })], paidProjects, ROSTER, undefined, NOW)
  assertEqual(events.length, 0)
})

// A bundle send posts ONE message and stamps every card it announces
// (SetWorkspacePage), the anchor by the edge function and the rest by the
// browser a moment later. Row-per-stamp would print the same email three times.
test('one bundle send stamping three cards becomes one row', () => {
  const at = hoursAgo(2)
  const bundles = new Map([['p1', { setId: 's1' }], ['p2', { setId: 's1' }], ['p3', { setId: 's1' }]])
  const events = designerMessageEvents([
    versionRow({ id: 'v-1', proof_id: 'p1', last_reply_sent_at: at, proofs: null }),
    versionRow({ id: 'v-2', proof_id: 'p2', last_reply_sent_at: new Date(Date.parse(at) + 1200).toISOString(), proofs: null }),
    versionRow({ id: 'v-3', proof_id: 'p3', last_reply_sent_at: new Date(Date.parse(at) + 1500).toISOString(), proofs: null }),
  ], paidProjects, ROSTER, bundles, NOW)
  assertEqual(events.length, 1)
  assertEqual(events[0].collapsed?.count, 3)
  assertEqual(events[0].collapsed?.bundle, true)
})

// The clustering must not swallow genuinely separate sends. Two versions of one
// project, a week apart, are two things that happened.
test('two sends a week apart on one conversation stay two rows', () => {
  const events = designerMessageEvents([
    versionRow({ id: 'v-1', version_number: 2, last_reply_sent_at: daysAgo(8) }),
    versionRow({ id: 'v-2', version_number: 3, last_reply_sent_at: daysAgo(1) }),
  ], paidProjects, ROSTER, undefined, NOW)
  assertEqual(events.length, 2)
  assert(events.every((e) => e.collapsed === undefined), 'neither claims to cover the other')
})

// team_roster() lists only active profiles, so a message from someone who has
// since left resolves to no name. The row still says what went out — it just
// doesn't invent who by, and matching the customer label suppresses the subline.
test('an unknown sender keeps the row and claims nobody', () => {
  const events = designerMessageEvents(
    [versionRow({ last_reply_sent_by: 'u-departed' })], paidProjects, ROSTER, undefined, NOW)
  assertEqual(events.length, 1)
  assertEqual(events[0].actor_name, 'Analytical Engines', 'falls back to the customer label')
})

// A bundle send can cover cards sitting on different versions. "was sent v2" is
// then false for two thirds of them, so the copy has to drop the number.
test('a cluster spanning versions names no version', () => {
  const at = hoursAgo(2)
  const bundles = new Map([['p1', { setId: 's1' }], ['p2', { setId: 's1' }]])
  const events = designerMessageEvents([
    versionRow({ id: 'v-1', proof_id: 'p1', version_number: 2, last_reply_sent_at: at, proofs: null }),
    versionRow({ id: 'v-2', proof_id: 'p2', version_number: 4, last_reply_sent_at: at, proofs: null }),
  ], paidProjects, ROSTER, bundles, NOW)
  assertEqual(events.length, 1)
  assertEqual(events[0].version_number, 0, 'no single version to claim')
})

test('a message older than the 30-day window is excluded', () => {
  const events = designerMessageEvents(
    [versionRow({ last_reply_sent_at: daysAgo(31) })], paidProjects, ROSTER, undefined, NOW)
  assertEqual(events.length, 0)
})

console.log('\nfollowupReminderEvents()')

// ONE ROW PER PROJECT, not per ledger row. send-nudges sent 93 reminders in 7
// days on live; at a row each they would take the top of a 20-row feed every
// morning and push out the views, approvals and payments it exists to show.
test('several reminders to one project collapse to its most recent', () => {
  const events = followupReminderEvents([
    { id: 'n1', proof_id: 'p1', created_at: daysAgo(6) },
    { id: 'n2', proof_id: 'p1', created_at: daysAgo(3) },
    { id: 'n3', proof_id: 'p1', created_at: hoursAgo(2) },
  ], paidProjects, NOW)
  assertEqual(events.length, 1)
  assertEqual(events[0].id, 'followup-n3', 'kept the newest')
  assertEqual(events[0].event_type, 'followup_reminder')
})

// The row that most needed this: nobody sent it, so its actor must be the
// CUSTOMER — the same convention pay_link_sent and order_reminder_sent follow,
// which is what leaves the panel with no sender to put on the subline. (The
// actor is the contact, per resolveCustomer; the panel leads with the company.)
test('a reminder names the customer as its actor, never a sender', () => {
  const events = followupReminderEvents(
    [{ id: 'n1', proof_id: 'p1', created_at: hoursAgo(1) }], paidProjects, NOW)
  assertEqual(events[0].actor_name, 'Ada Lovelace')
  assertEqual(events[0].company_name, 'Analytical Engines')
})

test('reminders to different projects stay separate rows', () => {
  const events = followupReminderEvents([
    { id: 'n1', proof_id: 'p1', created_at: hoursAgo(1) },
    { id: 'n2', proof_id: 'p2', created_at: hoursAgo(1) },
  ], paidProjects, NOW)
  assertEqual(events.length, 2)
})

console.log('\norderConfirmationEvents()')

test('an order confirmation names itself', () => {
  const events = orderConfirmationEvents([{
    id: 'o1', proof_id: 'p1', confirmation_sent_at: hoursAgo(1), order_group_id: null,
  }], paidProjects, NOW)
  assertEqual(events.length, 1)
  assertEqual(events[0].event_type, 'order_confirmation_sent')
  assertEqual(events[0].company_name, 'Analytical Engines')
})

// One payment, one confirmation, stamped on the group row (000309) — a member
// row would double-count the same email.
test('a member of a combined payment is left to the group row', () => {
  const events = orderConfirmationEvents([{
    id: 'o1', proof_id: 'p1', confirmation_sent_at: hoursAgo(1), order_group_id: 'g1',
  }], paidProjects, NOW)
  assertEqual(events.length, 0)
})

test('a combined payment confirmation collapses its members', () => {
  const events = orderGroupConfirmationEvents([{
    id: 'g1',
    confirmation_sent_at: hoursAgo(1),
    orders: [{ proof_id: 'p1' }, { proof_id: 'p2' }],
  }], paidProjects, undefined, NOW)
  assertEqual(events.length, 1)
  assertEqual(events[0].collapsed?.count, 2)
})

console.log('\nbundleSentEvents()')

test('a bundle send links to the bundle and carries its set id', () => {
  const events = bundleSentEvents([{
    id: 'set-a', sent_at: hoursAgo(1), proofs: [{ id: 'p2' }, { id: 'p1' }],
  }], paidProjects, NOW)
  assertEqual(events.length, 1)
  assertEqual(events[0].event_type, 'bundle_sent')
  assertEqual(events[0].link, '/bundles/set-a')
  // Load-bearing: the per-card rows underneath share no proof_id with this row,
  // so the set id is the only thing that can tell supersedeOutbound they are
  // one message.
  assertEqual(events[0].set_id, 'set-a')
})

console.log('\nsupersedeOutbound() — one message, one row')

function outboundRow(
  type: DashboardLatestEvent['event_type'],
  overrides: Partial<DashboardLatestEvent> = {},
): DashboardLatestEvent {
  return {
    id: `${type}-1`,
    created_at: hoursAgo(1),
    event_type: type,
    actor_name: 'Analytical Engines',
    recipient_name: null,
    helpscout_thread_id: null,
    proof_id: 'p1',
    version_number: 1,
    contact_name: 'Ada Lovelace',
    company_name: 'Analytical Engines',
    ...overrides,
  }
}

test('a named row supersedes the generic reply describing the same message', () => {
  const at = hoursAgo(1)
  const kept = supersedeOutbound([
    outboundRow('staff_reply', { created_at: at }),
    outboundRow('order_confirmation_sent', { created_at: new Date(Date.parse(at) + 2000).toISOString() }),
  ])
  assertEqual(kept.length, 1)
  assertEqual(kept[0].event_type, 'order_confirmation_sent')
})

// This one has double-printed since the pay-link row shipped: sending a pay link
// goes through send-helpscout-reply, so it stamps the Help Scout column too.
test('a pay-link send supersedes its own "was sent a reply"', () => {
  const kept = supersedeOutbound([
    outboundRow('staff_reply'),
    outboundRow('pay_link_sent'),
  ])
  assertEqual(kept.length, 1)
  assertEqual(kept[0].event_type, 'pay_link_sent')
})

// Same project, but hours apart: two messages, and the feed should say so.
test('rows outside the window are two messages, not one', () => {
  const kept = supersedeOutbound([
    outboundRow('staff_reply', { created_at: hoursAgo(1) }),
    outboundRow('order_confirmation_sent', { created_at: hoursAgo(6) }),
  ])
  assertEqual(kept.length, 2)
})

test('rows on different projects never supersede each other', () => {
  const kept = supersedeOutbound([
    outboundRow('staff_reply', { proof_id: 'p1' }),
    outboundRow('order_confirmation_sent', { proof_id: 'p2' }),
  ])
  assertEqual(kept.length, 2)
})

// The bundle case: the announcement is keyed to the SET and the per-card rows to
// their own projects, so they share no proof_id and only the bundle index can
// tell they are one send.
test('a bundle announcement supersedes the per-card rows beneath it', () => {
  const bundles = new Map([['p1', { setId: 's1' }], ['p2', { setId: 's1' }]])
  const kept = supersedeOutbound([
    outboundRow('designer_message', { id: 'dm-1', proof_id: 'p1' }),
    outboundRow('designer_message', { id: 'dm-2', proof_id: 'p2' }),
    outboundRow('bundle_sent', { id: 'bs-1', proof_id: 'p1', set_id: 's1' }),
  ], bundles)
  assertEqual(kept.length, 1)
  assertEqual(kept[0].event_type, 'bundle_sent')
})

// Rank is specificity, not importance — two sends of the same kind are two
// separate things and must both survive, however close together they land.
test('equal ranks never displace each other', () => {
  const kept = supersedeOutbound([
    outboundRow('designer_message', { id: 'dm-1' }),
    outboundRow('designer_message', { id: 'dm-2' }),
  ])
  assertEqual(kept.length, 2)
})

// Only the outbound family takes part. A customer opening the proof a second
// after we emailed them is the most interesting coincidence on the card.
test('inbound and customer rows are never touched', () => {
  const kept = supersedeOutbound([
    outboundRow('view'),
    outboundRow('approve'),
    outboundRow('customer_reply'),
    outboundRow('staff_reply'),
    outboundRow('order_confirmation_sent'),
  ])
  assertEqual(kept.length, 4, 'only the staff_reply went')
  assert(!kept.some((e) => e.event_type === 'staff_reply'), 'and it was the staff_reply')
})

// A three-deep pile from one payment on a bundled project: the reply stamp, the
// version stamp its sender wrote, and the confirmation itself.
test('a pile of records for one message reduces to the most specific', () => {
  const kept = supersedeOutbound([
    outboundRow('staff_reply', { id: 'sr-1' }),
    outboundRow('designer_message', { id: 'dm-1' }),
    outboundRow('order_confirmation_sent', { id: 'oc-1' }),
  ])
  assertEqual(kept.length, 1)
  assertEqual(kept[0].id, 'oc-1')
})

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
