// Unit tests for dashboardGrouping.ts
// Run with: npx tsx src/lib/dashboardGrouping.test.ts
//
// Tests focus on recentlyAwakened() and groupByTime() — the logic that
// determines where a proof appears in the time-bucketed list after a
// snooze expires.

import { recentlyAwakened, isCurrentlySnoozed, groupByTime, activityTimestamp, buildSnoozedSection, proofBucket, recentHelpscoutActivity, helpscoutReplyEvents } from './dashboardGrouping'
import type { DashboardProject } from './dashboardGrouping'

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

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 3_600_000).toISOString()
}

function hoursFromNow(h: number): string {
  return new Date(Date.now() + h * 3_600_000).toISOString()
}

function daysAgo(d: number): string {
  return hoursAgo(d * 24)
}

// ── recentlyAwakened() ────────────────────────────────────────────────────────

console.log('\nrecentlyAwakened()')

test('returns false when snoozed_until is null', () => {
  const p = makeProject({ snoozed_until: null })
  assert(!recentlyAwakened(p), 'should be false')
})

test('returns false when snooze is still active (expires in the future)', () => {
  const p = makeProject({ snoozed_until: hoursFromNow(12) })
  assert(!recentlyAwakened(p), 'should be false — snooze not yet expired')
})

test('returns true when snooze expired 1 hour ago', () => {
  const p = makeProject({ snoozed_until: hoursAgo(1) })
  assert(recentlyAwakened(p), 'should be true — expired within 24 h window')
})

test('returns true when snooze expired 23 hours ago (boundary)', () => {
  const p = makeProject({ snoozed_until: hoursAgo(23) })
  assert(recentlyAwakened(p), 'should be true — still within 24 h window')
})

test('returns false when snooze expired 25 hours ago (outside window)', () => {
  const p = makeProject({ snoozed_until: hoursAgo(25) })
  assert(!recentlyAwakened(p), 'should be false — outside 24 h window')
})

test('returns false when snooze expired 1 week ago', () => {
  const p = makeProject({ snoozed_until: daysAgo(7) })
  assert(!recentlyAwakened(p), 'should be false — long expired')
})

// ── groupByTime() — normal bucketing (no snooze) ──────────────────────────────

console.log('\ngroupByTime() — standard bucketing')

test('proof with last_activity_at = today lands in Today', () => {
  const p = makeProject({ last_activity_at: new Date().toISOString() })
  const sections = groupByTime([p])
  assertEqual(sections.length, 1)
  assertEqual(sections[0].key, 'today')
})

test('proof with last_activity_at = 3 days ago lands in This week', () => {
  const p = makeProject({ last_activity_at: daysAgo(3) })
  const sections = groupByTime([p])
  assertEqual(sections.length, 1)
  assertEqual(sections[0].key, 'week')
})

test('proof with last_activity_at = 10 days ago lands in Older', () => {
  const p = makeProject({ last_activity_at: daysAgo(10) })
  const sections = groupByTime([p])
  assertEqual(sections.length, 1)
  assertEqual(sections[0].key, 'older')
})

test('empty list returns no sections', () => {
  assertEqual(groupByTime([]).length, 0)
})

test('proof with null last_activity_at lands in Older', () => {
  // Defensive against the rare case where a freshly-inserted proof
  // row has not yet been bump-triggered, or a row arrives from a
  // typed cast that allows null. Without the null-guard the proof
  // would slip past every bucket and disappear from the dashboard.
  const p = makeProject({ last_activity_at: null as unknown as string })
  const sections = groupByTime([p])
  assertEqual(sections.length, 1)
  assertEqual(sections[0].key, 'older')
  assertEqual(sections[0].projects.length, 1)
})

test('proof with missing last_activity_at lands in Older', () => {
  // Same guard, undefined branch.
  const p = makeProject({ last_activity_at: undefined as unknown as string })
  const sections = groupByTime([p])
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
  const sections = groupByTime([p])
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
  const sections = groupByTime([p])
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
  const sections = groupByTime([p])
  assertEqual(sections.length, 1, 'should have exactly one section')
  assertEqual(sections[0].key, 'today', 'should be Today despite old last_activity_at')
  assertEqual(sections[0].projects.length, 1)
})

test('proof snoozed until 23 h ago, last_activity 2 weeks ago → Today', () => {
  const p = makeProject({
    last_activity_at: daysAgo(14),
    snoozed_until:    hoursAgo(23),
  })
  const sections = groupByTime([p])
  assertEqual(sections[0].key, 'today')
})

test('proof snoozed until 25 h ago falls through to last_activity bucket (Older)', () => {
  const p = makeProject({
    last_activity_at: daysAgo(14),
    snoozed_until:    hoursAgo(25),
  })
  const sections = groupByTime([p])
  assertEqual(sections[0].key, 'older', 'should fall back to last_activity_at bucketing')
})

test('proof with active (future) snooze and old last_activity → Older (not Today)', () => {
  // Active snoozes are filtered out before groupByTime is called in the
  // dashboard, but if one slips through it should NOT get the awakened boost.
  const p = makeProject({
    last_activity_at: daysAgo(14),
    snoozed_until:    hoursFromNow(24),
  })
  const sections = groupByTime([p])
  assertEqual(sections[0].key, 'older', 'active snooze should not trigger awakened boost')
})

test('mix of regular and recently-awakened proofs sorts correctly', () => {
  const oldProof    = makeProject({ proof_id: 'old',    last_activity_at: daysAgo(10), snoozed_until: null })
  const weekProof   = makeProject({ proof_id: 'week',   last_activity_at: daysAgo(3),  snoozed_until: null })
  const awakenedP   = makeProject({ proof_id: 'awoken', last_activity_at: daysAgo(10), snoozed_until: hoursAgo(2) })
  const sections    = groupByTime([oldProof, weekProof, awakenedP])
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
  assert(!isCurrentlySnoozed(p), 'should be false')
})

test('returns true when snooze expires in the future', () => {
  const p = makeProject({ snoozed_until: hoursFromNow(12) })
  assert(isCurrentlySnoozed(p), 'should be true')
})

test('returns false when snooze just expired (recently awakened grace window)', () => {
  // 000186 widens the dashboard view's lateral so snoozed_until carries
  // forward for 24 hours after expiry. isCurrentlySnoozed must NOT treat
  // those rows as still-snoozed — they belong in Today, not in the
  // Snoozed section.
  const p = makeProject({ snoozed_until: hoursAgo(1) })
  assert(!isCurrentlySnoozed(p), 'should be false — snooze expired')
})

// ── buildSnoozedSection() ─────────────────────────────────────────────────────

console.log('\nbuildSnoozedSection()')

test('returns empty array when no projects are snoozed', () => {
  const sections = buildSnoozedSection([makeProject({ snoozed_until: null })])
  assertEqual(sections.length, 0)
})

test('returns one Snoozed section when a project has an active snooze', () => {
  const p = makeProject({ snoozed_until: hoursFromNow(24) })
  const sections = buildSnoozedSection([p])
  assertEqual(sections.length, 1)
  assertEqual(sections[0].kind, 'snoozed')
  assertEqual(sections[0].projects.length, 1)
})

test('only currently-snoozed projects appear in the snoozed section', () => {
  const snoozed  = makeProject({ proof_id: 'snoozed', snoozed_until: hoursFromNow(24) })
  const normal   = makeProject({ proof_id: 'normal',  snoozed_until: null })
  const sections = buildSnoozedSection([snoozed, normal])
  assertEqual(sections[0].projects.length, 1)
  assertEqual(sections[0].projects[0].proof_id, 'snoozed')
})

test('recently-awakened proofs are excluded from the snoozed section', () => {
  // After 000186, snoozed_until persists for 24 h post-expiry to power
  // recentlyAwakened bucketing. The Snoozed section must still hide
  // those rows or the count would over-report the live snooze tally.
  const recentlyAwoken = makeProject({ proof_id: 'awoken',  snoozed_until: hoursAgo(2) })
  const stillSnoozed   = makeProject({ proof_id: 'snoozed', snoozed_until: hoursFromNow(2) })
  const sections = buildSnoozedSection([recentlyAwoken, stillSnoozed])
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
  assertEqual(proofBucket(p).bucket, 'not_viewed')
  assertEqual(proofBucket(p).label, 'Not viewed')
})

test('in_progress, current version viewed, nothing else → awaiting_customer', () => {
  const p = makeProject({ status: 'in_progress', current_version_id: 'v1', current_version_viewed_at: hoursAgo(2) })
  assertEqual(proofBucket(p).bucket, 'awaiting_customer')
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
  assertEqual(proofBucket(p).bucket, 'changes_requested')
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
  assertEqual(proofBucket(p).bucket, 'awaiting_customer')
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
  assertEqual(proofBucket(p).bucket, 'changes_requested')
})

test('automation actively chasing a viewed proof → in_follow_up (not awaiting_customer)', () => {
  const p = makeProject({
    status: 'in_progress',
    current_version_id: 'v1',
    current_version_viewed_at: hoursAgo(2), // would otherwise be awaiting_customer
    follow_up_rule_code: 'viewed_not_actioned',
  })
  assertEqual(proofBucket(p).bucket, 'in_follow_up')
  assertEqual(proofBucket(p).label, 'In auto follow-up')
})

test('automation chasing an unopened proof → in_follow_up (not not_viewed)', () => {
  const p = makeProject({
    status: 'in_progress',
    current_version_id: 'v1',
    current_version_viewed_at: null, // would otherwise be not_viewed
    follow_up_rule_code: 'sent_never_viewed',
  })
  assertEqual(proofBucket(p).bucket, 'in_follow_up')
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
  assertEqual(proofBucket(p).bucket, 'customer_replied')
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
  assertEqual(proofBucket(p).bucket, 'customer_replied')
  assertEqual(proofBucket(p).label, 'Replied by email')
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
  assertEqual(proofBucket(p).bucket, 'awaiting_customer')
})

test('customer reply older than the current version → not customer_replied', () => {
  const p = makeProject({
    status: 'in_progress',
    current_version_id: 'v1',
    current_version_viewed_at: hoursAgo(2),
    version_created_at: hoursAgo(1),          // we shipped a newer version since the reply
    helpscout_last_customer_reply_at: daysAgo(2),
  })
  assertEqual(proofBucket(p).bucket, 'awaiting_customer')
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
  assertEqual(proofBucket(p).bucket, 'customer_replied')
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
  assertEqual(proofBucket(p).bucket, 'changes_requested')
})

test('terminal statuses map straight through', () => {
  assertEqual(proofBucket(makeProject({ status: 'approved'  })).bucket, 'approved')
  assertEqual(proofBucket(makeProject({ status: 'dormant'   })).bucket, 'dormant')
  assertEqual(proofBucket(makeProject({ status: 'abandoned' })).bucket, 'abandoned')
})

// ── order_status extends the approved slot (000307) ─────────────────────────
test('approved proof with a paid/fulfilled order reads Ordered', () => {
  const p = makeProject({ status: 'approved', order_status: 'ordered' })
  assertEqual(proofBucket(p).bucket, 'ordered')
  assertEqual(proofBucket(p).label, 'Ordered')
})

test('approved proof with an unpaid pay link reads Awaiting payment', () => {
  const p = makeProject({ status: 'approved', order_status: 'awaiting_payment' })
  assertEqual(proofBucket(p).bucket, 'awaiting_payment')
  assertEqual(proofBucket(p).label, 'Awaiting payment')
})

test('approved proof with no live payable order still reads Approved', () => {
  // A cancelled/expired-only proof surfaces order_status null and stays Approved.
  assertEqual(proofBucket(makeProject({ status: 'approved', order_status: null })).bucket, 'approved')
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
  assertEqual(proofBucket(p).bucket, 'awaiting_customer')
})

test('needs attention still wins over an ordered proof', () => {
  const p = makeProject({ status: 'approved', order_status: 'ordered', rule_code: 'approved_no_order' })
  assertEqual(proofBucket(p).bucket, 'needs_attention')
})

test('rule_code (needs attention) wins over the in_progress workflow state', () => {
  const p = makeProject({
    status: 'in_progress',
    current_version_id: 'v1',
    current_version_viewed_at: hoursAgo(2), // would otherwise be awaiting_customer
    rule_code: 'sent_never_viewed',
  })
  assertEqual(proofBucket(p).bucket, 'needs_attention')
})

test('rule_code wins even on a dormant proof', () => {
  const p = makeProject({ status: 'dormant', rule_code: 'approaching_dormant' })
  assertEqual(proofBucket(p).bucket, 'needs_attention')
})

test('an active snooze wins over everything, including a rule_code', () => {
  const p = makeProject({
    status: 'in_progress',
    rule_code: 'stuck_in_progress',
    snoozed_until: hoursFromNow(12),
  })
  assertEqual(proofBucket(p).bucket, 'snoozed')
})

test('a recently-expired snooze (grace window) does not count as snoozed', () => {
  const p = makeProject({ status: 'in_progress', current_version_id: 'v1', snoozed_until: hoursAgo(2) })
  assertEqual(proofBucket(p).bucket, 'not_viewed')
})

test('terminal status wins over the in_progress workflow sub-states (dormant, unviewed)', () => {
  // A dormant proof whose current version was never viewed: the Dormant
  // status takes precedence over not_viewed, matching the left-cap order.
  const p = makeProject({ status: 'dormant', current_version_id: 'v1', current_version_viewed_at: null })
  assertEqual(proofBucket(p).bucket, 'dormant')
})

// ── recentHelpscoutActivity() ─────────────────────────────────────────────────

console.log('\nrecentHelpscoutActivity()')

test('null when there is no Help Scout reply activity', () => {
  assertEqual(recentHelpscoutActivity(makeProject()), null)
})

test('returns the staff reply when it is recent', () => {
  const p = makeProject({ helpscout_last_reply_at: hoursAgo(2) })
  assertEqual(recentHelpscoutActivity(p)?.kind, 'staff')
})

test('returns the most recent of staff vs customer', () => {
  const p = makeProject({
    helpscout_last_reply_at: daysAgo(2),
    helpscout_last_customer_reply_at: hoursAgo(3),
  })
  assertEqual(recentHelpscoutActivity(p)?.kind, 'customer')
})

test('null when the most recent reply is older than the window', () => {
  const p = makeProject({ helpscout_last_reply_at: daysAgo(5) })
  assertEqual(recentHelpscoutActivity(p, 3), null)
})

// ── helpscoutReplyEvents() ────────────────────────────────────────────────────
//
// Synthesises Latest-activity feed rows from each proof's Help Scout reply
// timestamps so an email reply (a timestamp, not a stored event) surfaces.

console.log('\nhelpscoutReplyEvents()')

test('no reply timestamps → no events', () => {
  assertEqual(helpscoutReplyEvents([makeProject()]).length, 0)
})

test('customer reply → one customer_reply row attributed to the contact', () => {
  const at = hoursAgo(1)
  const events = helpscoutReplyEvents([
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
  const co = helpscoutReplyEvents([
    makeProject({ contact_name: null, company_name: 'Brookland Watch Co', helpscout_last_customer_reply_at: hoursAgo(1) }),
  ])
  assertEqual(co[0].actor_name, 'Brookland Watch Co')
  const none = helpscoutReplyEvents([
    makeProject({ contact_name: null, company_name: null, helpscout_last_customer_reply_at: hoursAgo(1) }),
  ])
  assertEqual(none[0].actor_name, 'Customer')
})

test('staff reply → one staff_reply row attributed to "You"', () => {
  const events = helpscoutReplyEvents([
    makeProject({ proof_id: 'p2', helpscout_last_reply_at: hoursAgo(3) }),
  ])
  assertEqual(events.length, 1)
  assertEqual(events[0].event_type, 'staff_reply')
  assertEqual(events[0].actor_name, 'You')
  assertEqual(events[0].id, 'hs-staff-p2')
})

test('both directions → two rows for the same proof', () => {
  const events = helpscoutReplyEvents([
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
  const events = helpscoutReplyEvents([
    makeProject({
      helpscout_last_customer_reply_at: daysAgo(40),
      helpscout_last_reply_at: daysAgo(31),
    }),
  ])
  assertEqual(events.length, 0)
})

test('version_number carries the current version (0 when none)', () => {
  const withVer = helpscoutReplyEvents([
    makeProject({ current_version_number: 2, helpscout_last_customer_reply_at: hoursAgo(1) }),
  ])
  assertEqual(withVer[0].version_number, 2)
  const noVer = helpscoutReplyEvents([
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
  const events = helpscoutReplyEvents(sharedThread(hoursAgo(1)))
  assertEqual(events.length, 1)
  assertEqual(events[0].event_type, 'customer_reply')
  assertEqual(events[0].collapsed?.count, 3)
})

test('collapsing is per direction — a customer and a staff reply stay separate', () => {
  const at = hoursAgo(1)
  const events = helpscoutReplyEvents([
    makeProject({ proof_id: 'p1', helpscout_conversation_id: 'c', helpscout_last_customer_reply_at: at, helpscout_last_reply_at: at }),
    makeProject({ proof_id: 'p2', helpscout_conversation_id: 'c', helpscout_last_customer_reply_at: at, helpscout_last_reply_at: at }),
  ])
  assertEqual(events.length, 2)
  assert(events.some((e) => e.event_type === 'customer_reply'), 'kept the customer row')
  assert(events.some((e) => e.event_type === 'staff_reply'), 'kept the staff row')
  assert(events.every((e) => e.collapsed?.count === 2), 'both collapsed a pair')
})

test('two replies at different times on one conversation stay two rows', () => {
  const events = helpscoutReplyEvents([
    makeProject({ proof_id: 'p1', helpscout_conversation_id: 'c', helpscout_last_customer_reply_at: hoursAgo(1) }),
    makeProject({ proof_id: 'p2', helpscout_conversation_id: 'c', helpscout_last_customer_reply_at: hoursAgo(5) }),
  ])
  assertEqual(events.length, 2)
  assert(events.every((e) => e.collapsed === undefined), 'neither row claims to cover others')
})

test('different conversations are never collapsed, even at the same instant', () => {
  const at = hoursAgo(1)
  const events = helpscoutReplyEvents([
    makeProject({ proof_id: 'p1', helpscout_conversation_id: 'c1', helpscout_last_customer_reply_at: at }),
    makeProject({ proof_id: 'p2', helpscout_conversation_id: 'c2', helpscout_last_customer_reply_at: at }),
  ])
  assertEqual(events.length, 2)
})

// The regression this guards: keying on a null conversation id would fold every
// unlinked proof that happened to share a timestamp into a single row.
test('proofs with no conversation id are never collapsed together', () => {
  const at = hoursAgo(1)
  const events = helpscoutReplyEvents([
    makeProject({ proof_id: 'p1', helpscout_conversation_id: null, helpscout_last_customer_reply_at: at }),
    makeProject({ proof_id: 'p2', helpscout_conversation_id: null, helpscout_last_customer_reply_at: at }),
  ])
  assertEqual(events.length, 2)
  assert(events.every((e) => e.collapsed === undefined), 'no collapse marker')
})

test('a lone row on a conversation carries no collapsed marker', () => {
  const events = helpscoutReplyEvents([
    makeProject({ proof_id: 'p1', helpscout_conversation_id: 'c', helpscout_last_customer_reply_at: hoursAgo(1) }),
  ])
  assertEqual(events.length, 1)
  assertEqual(events[0].collapsed, undefined)
})

test('the surviving row is the same one regardless of input order', () => {
  const at = hoursAgo(1)
  const forward = helpscoutReplyEvents(sharedThread(at, ['p1', 'p2', 'p3']))
  const reversed = helpscoutReplyEvents(sharedThread(at, ['p3', 'p2', 'p1']))
  assertEqual(forward[0].proof_id, reversed[0].proof_id)
  assertEqual(forward[0].id, reversed[0].id)
})

// Sharing a thread is the trigger, but only a real bundle may be CALLED one —
// two unrelated projects raised off one email thread collapse identically.
test('collapsed rows are only marked as a bundle when every proof is in one', () => {
  const at = hoursAgo(1)
  const projects = sharedThread(at, ['p1', 'p2'])

  const allInOneBundle = helpscoutReplyEvents(projects, new Map([
    ['p1', { setId: 'set-a' }],
    ['p2', { setId: 'set-a' }],
  ]))
  assertEqual(allInOneBundle[0].collapsed?.bundle, true)

  const differentBundles = helpscoutReplyEvents(projects, new Map([
    ['p1', { setId: 'set-a' }],
    ['p2', { setId: 'set-b' }],
  ]))
  assertEqual(differentBundles[0].collapsed?.bundle, false)

  const oneLooseProof = helpscoutReplyEvents(projects, new Map([
    ['p1', { setId: 'set-a' }],
  ]))
  assertEqual(oneLooseProof[0].collapsed?.bundle, false)

  const noBundleInfoAtAll = helpscoutReplyEvents(projects)
  assertEqual(noBundleInfoAtAll[0].collapsed?.count, 2)
  assertEqual(noBundleInfoAtAll[0].collapsed?.bundle, false)
})

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
