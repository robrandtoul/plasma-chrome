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

test('version and reply entries attribute the designer when a name resolves', () => {
  const entries = buildTimelineEntries(
    baseSources({
      versions: [
        {
          id: 'v1', version_number: 1, created_at: '2026-05-01T10:00:00Z',
          last_reply_sent_at: '2026-05-01T11:00:00Z',
          created_by: 'designer-1', last_reply_sent_by: 'designer-2',
        },
      ],
      designerNamesById: new Map([
        ['designer-1', 'Donna Lambe'],
        ['designer-2', 'Jack Johnson'],
      ]),
    }),
  )
  const created = entries.find((e) => e.type === 'version_created')!
  const reply = entries.find((e) => e.type === 'reply_sent')!
  assert(created.actor === 'Donna Lambe', `creator actor: ${created.actor}`)
  assert(created.verb === 'created v1', `creator verb: ${created.verb}`)
  assert(reply.actor === 'Jack Johnson', `reply actor: ${reply.actor}`)
  assert(reply.verb === 'sent a reply for v1', `reply verb: ${reply.verb}`)
})

test('attribution falls back to milestone copy when ids are null or unresolvable', () => {
  const entries = buildTimelineEntries(
    baseSources({
      versions: [
        {
          id: 'v1', version_number: 1, created_at: '2026-05-01T10:00:00Z',
          last_reply_sent_at: '2026-05-01T11:00:00Z',
          // created_by resolves to nothing (deleted profile); reply
          // sender null (automated nudge / pre-000215 row).
          created_by: 'gone-user', last_reply_sent_by: null,
        },
      ],
      designerNamesById: new Map(),
    }),
  )
  const created = entries.find((e) => e.type === 'version_created')!
  const reply = entries.find((e) => e.type === 'reply_sent')!
  assert(created.actor === null && created.verb === 'v1 created', `creator fallback: ${created.actor} / ${created.verb}`)
  assert(reply.actor === null && reply.verb === 'Reply sent for v1', `reply fallback: ${reply.actor} / ${reply.verb}`)
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

test('no customer_email_reply entry when the timestamp is absent', () => {
  const entries = buildTimelineEntries(baseSources())
  assert(!entries.some((e) => e.type === 'customer_email_reply'), 'unexpected email-reply entry')
})

test('a customer email reply produces one entry attributed to the contact', () => {
  const entries = buildTimelineEntries(
    baseSources({
      proof: {
        created_at: '2026-05-01T09:00:00Z',
        approved_at: null,
        abandoned_at: null,
        disclaimer_acknowledged_at: null,
        contactName: 'Sarah Smith',
        customerEmailReplyAt: '2026-05-04T12:00:00Z',
      },
    }),
  )
  const reply = entries.find((e) => e.type === 'customer_email_reply')
  assert(!!reply, 'missing customer_email_reply entry')
  assert(reply!.actor === 'Sarah Smith', 'email reply should carry the contact as actor')
  assert(reply!.verb === 'replied by email', `unexpected verb: ${reply!.verb}`)
  assert(reply!.at === '2026-05-04T12:00:00Z', 'entry sorts on the reply timestamp')
})

test('email reply falls back to "Customer" when no contact name', () => {
  const entries = buildTimelineEntries(
    baseSources({
      proof: {
        created_at: '2026-05-01T09:00:00Z',
        approved_at: null,
        abandoned_at: null,
        disclaimer_acknowledged_at: null,
        contactName: null,
        customerEmailReplyAt: '2026-05-04T12:00:00Z',
      },
    }),
  )
  const reply = entries.find((e) => e.type === 'customer_email_reply')
  assert(!!reply && reply.actor === 'Customer', 'should fall back to "Customer"')
})

// ── Result ────────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
