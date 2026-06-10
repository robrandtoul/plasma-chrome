// Unit tests for proofTimeline.ts
// Run with: npx tsx src/lib/proofTimeline.test.ts
//
// Tests focus on buildTimelineEntries() — the merge of proof
// milestones, version rows, proof_events and view rows into one
// newest-first list, plus the per-day view dedupe and the
// same-instant tie-ordering.

import { buildTimelineEntries, type TimelineSources, type TimelineEventRow } from './proofTimeline'

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

function baseSources(overrides: Partial<TimelineSources> = {}): TimelineSources {
  return {
    proof: {
      created_at: '2026-05-01T09:00:00Z',
      approved_at: null,
      abandoned_at: null,
      disclaimer_acknowledged_at: null,
      contactName: 'Sarah Smith',
    },
    versions: [],
    events: [],
    viewsByVersion: new Map(),
    ...overrides,
  }
}

function event(overrides: Partial<TimelineEventRow> = {}): TimelineEventRow {
  return {
    id: 'e1',
    proof_version_id: 'v1',
    event_type: 'approve',
    actor_name: 'Sarah Smith',
    name: null,
    comment: null,
    helpscout_thread_id: 'hs-1',
    created_at: '2026-05-03T10:00:00Z',
    variant_display_name: null,
    ...overrides,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

console.log('buildTimelineEntries()')

test('always contains the project-created milestone', () => {
  const entries = buildTimelineEntries(baseSources())
  assert(entries.length === 1, `expected 1 entry, got ${entries.length}`)
  assert(entries[0].type === 'project_created', `expected project_created, got ${entries[0].type}`)
  assert(entries[0].actor === null, 'milestone entries carry no actor')
})

test('version rows produce a created milestone and a reply entry only when sent', () => {
  const entries = buildTimelineEntries(
    baseSources({
      versions: [
        { id: 'v1', version_number: 1, created_at: '2026-05-01T10:00:00Z', last_reply_sent_at: '2026-05-01T11:00:00Z' },
        { id: 'v2', version_number: 2, created_at: '2026-05-05T10:00:00Z', last_reply_sent_at: null },
      ],
    }),
  )
  const verbs = entries.map((e) => e.verb)
  assert(verbs.includes('v1 created'), 'missing v1 created')
  assert(verbs.includes('v2 created'), 'missing v2 created')
  assert(verbs.includes('Reply sent for v1'), 'missing reply entry for v1')
  assert(!verbs.includes('Reply sent for v2'), 'v2 has no reply sent — no entry expected')
})

test('views dedupe to the earliest view per version per day', () => {
  const entries = buildTimelineEntries(
    baseSources({
      versions: [{ id: 'v1', version_number: 1, created_at: '2026-05-01T10:00:00Z', last_reply_sent_at: null }],
      viewsByVersion: new Map([
        ['v1', [
          { viewed_at: '2026-05-02T09:30:00Z' },
          { viewed_at: '2026-05-02T09:05:00Z' },
          { viewed_at: '2026-05-02T17:00:00Z' },
          { viewed_at: '2026-05-03T08:00:00Z' },
        ]],
      ]),
    }),
  )
  const views = entries.filter((e) => e.type === 'view')
  assert(views.length === 2, `expected 2 deduped views, got ${views.length}`)
  assert(views.some((v) => v.at === '2026-05-02T09:05:00Z'), 'kept the wrong row for day 1 — want the earliest')
  assert(views.some((v) => v.at === '2026-05-03T08:00:00Z'), 'missing day-2 view')
  assert(views[0].actor === 'Sarah Smith', 'view actor should be the contact name')
  assert(views[0].verb === 'opened v1', `unexpected view verb: ${views[0].verb}`)
})

test('event verbs branch on type and variant selection', () => {
  const entries = buildTimelineEntries(
    baseSources({
      versions: [{ id: 'v1', version_number: 3, created_at: '2026-05-01T10:00:00Z', last_reply_sent_at: null }],
      events: [
        event({ id: 'e1', event_type: 'approve' }),
        event({ id: 'e2', event_type: 'approve', variant_display_name: 'North' }),
        event({ id: 'e3', event_type: 'request_changes', comment: 'Logo too small' }),
        event({ id: 'e4', event_type: 'designer_override_approve', actor_name: 'Rob' }),
      ],
    }),
  )
  const byId = new Map(entries.map((e) => [e.id, e]))
  assert(byId.get('event:e1')!.verb === 'signed off v3', `e1: ${byId.get('event:e1')!.verb}`)
  assert(byId.get('event:e2')!.verb === 'chose ‘North’ on v3', `e2: ${byId.get('event:e2')!.verb}`)
  assert(byId.get('event:e3')!.verb === 'requested changes on v3', `e3: ${byId.get('event:e3')!.verb}`)
  assert(byId.get('event:e3')!.comment === 'Logo too small', 'change-request comment should pass through')
  assert(byId.get('event:e4')!.verb === 'marked v3 approved', `e4: ${byId.get('event:e4')!.verb}`)
})

test('whitespace-only comments are dropped', () => {
  const entries = buildTimelineEntries(
    baseSources({
      versions: [{ id: 'v1', version_number: 1, created_at: '2026-05-01T10:00:00Z', last_reply_sent_at: null }],
      events: [event({ comment: '   ' })],
    }),
  )
  assert(entries.find((e) => e.id === 'event:e1')!.comment === null, 'blank comment should be null')
})

test('failed-notification flag set only for customer events missing an HS thread', () => {
  const entries = buildTimelineEntries(
    baseSources({
      versions: [{ id: 'v1', version_number: 1, created_at: '2026-05-01T10:00:00Z', last_reply_sent_at: null }],
      events: [
        event({ id: 'e1', event_type: 'approve', helpscout_thread_id: null }),
        event({ id: 'e2', event_type: 'designer_override_approve', helpscout_thread_id: null }),
        event({ id: 'e3', event_type: 'request_changes', helpscout_thread_id: 'hs-9' }),
      ],
    }),
  )
  const byId = new Map(entries.map((e) => [e.id, e]))
  assert(byId.get('event:e1')!.failedNotification, 'approve with null thread should flag')
  assert(!byId.get('event:e2')!.failedNotification, 'designer override never flags')
  assert(!byId.get('event:e3')!.failedNotification, 'request_changes with thread should not flag')
})

test('recipient name passes through on split-name events', () => {
  const entries = buildTimelineEntries(
    baseSources({
      versions: [{ id: 'v1', version_number: 1, created_at: '2026-05-01T10:00:00Z', last_reply_sent_at: null }],
      events: [event({ name: 'John Smith' })],
    }),
  )
  assert(entries.find((e) => e.id === 'event:e1')!.recipientName === 'John Smith', 'missing recipient name')
})

test('newest first; same-instant approval milestone sorts above its approve event', () => {
  const t = '2026-05-09T14:00:00Z'
  const entries = buildTimelineEntries(
    baseSources({
      proof: {
        created_at: '2026-05-01T09:00:00Z',
        approved_at: t,
        abandoned_at: null,
        disclaimer_acknowledged_at: null,
        contactName: 'Sarah Smith',
      },
      versions: [{ id: 'v1', version_number: 1, created_at: '2026-05-01T10:00:00Z', last_reply_sent_at: null }],
      events: [event({ created_at: t })],
    }),
  )
  assert(entries[0].type === 'proof_approved', `top entry should be the milestone, got ${entries[0].type}`)
  assert(entries[1].id === 'event:e1', `approve event should follow, got ${entries[1].id}`)
  assert(entries[entries.length - 1].type === 'project_created', 'oldest entry should be project created')
})

test('terms acknowledgement is attributed to the contact', () => {
  const entries = buildTimelineEntries(
    baseSources({
      proof: {
        created_at: '2026-05-01T09:00:00Z',
        approved_at: null,
        abandoned_at: null,
        disclaimer_acknowledged_at: '2026-05-02T12:00:00Z',
        contactName: 'Sarah Smith',
      },
    }),
  )
  const ack = entries.find((e) => e.type === 'terms_acknowledged')
  assert(!!ack, 'missing terms entry')
  assert(ack!.actor === 'Sarah Smith', 'terms entry should carry the contact as actor')
})

// ── Result ────────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
