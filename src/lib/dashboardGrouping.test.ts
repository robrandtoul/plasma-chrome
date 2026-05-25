// Unit tests for dashboardGrouping.ts
// Run with: npx tsx src/lib/dashboardGrouping.test.ts
//
// Tests focus on recentlyAwakened() and groupByTime() — the logic that
// determines where a proof appears in the time-bucketed list after a
// snooze expires.

import { recentlyAwakened, isCurrentlySnoozed, groupByTime, buildSnoozedSection } from './dashboardGrouping'
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

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
