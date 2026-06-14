// Unit tests for proofSnapshot.ts
// Run with: npx tsx src/lib/proofSnapshot.test.ts

import {
  sentEvidenceAt,
  buildFunnel,
  ageDays,
  totalNonBotViews,
  quantityRangeLabel,
  summaryLine,
  roundOutcome,
} from './proofSnapshot'

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

function assertEqual(actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`expected ${e}, got ${a}`)
}

const V_CREATED = '2026-06-10T09:00:00Z'

// ── sentEvidenceAt ──────────────────────────────────────────────────────────────

test('sentEvidenceAt prefers the in-app reply stamp', () => {
  assertEqual(
    sentEvidenceAt({
      versionReplyAt: '2026-06-11T10:00:00Z',
      versionCreatedAt: V_CREATED,
      helpscoutLastReplyAt: '2026-06-12T10:00:00Z',
    }),
    '2026-06-11T10:00:00Z',
  )
})

test('sentEvidenceAt falls back to a HS reply that postdates the version', () => {
  assertEqual(
    sentEvidenceAt({
      versionReplyAt: null,
      versionCreatedAt: V_CREATED,
      helpscoutLastReplyAt: '2026-06-11T10:00:00Z',
    }),
    '2026-06-11T10:00:00Z',
  )
})

test('sentEvidenceAt ignores a HS reply older than the version (000224 rule)', () => {
  assertEqual(
    sentEvidenceAt({
      versionReplyAt: null,
      versionCreatedAt: V_CREATED,
      helpscoutLastReplyAt: '2026-06-09T10:00:00Z',
    }),
    null,
  )
})

// ── buildFunnel ──────────────────────────────────────────────────────────────────

test('funnel: not sent → everything pending', () => {
  const steps = buildFunnel({ sentAt: null, viewCount: 0, lastViewedAt: null, responded: null })
  assertEqual(steps.map((s) => s.state), ['pending', 'pending', 'pending'])
  assertEqual(steps[0].note, 'not sent yet')
})

test('funnel: sent, not viewed → viewed step is the active one', () => {
  const steps = buildFunnel({ sentAt: '2026-06-11T10:00:00Z', viewCount: 0, lastViewedAt: null, responded: null })
  assertEqual(steps.map((s) => s.state), ['done', 'active', 'pending'])
  assertEqual(steps[1].note, 'not viewed')
})

test('funnel: viewed, no response → responded step active + awaiting reply', () => {
  const steps = buildFunnel({
    sentAt: '2026-06-11T10:00:00Z',
    viewCount: 4,
    lastViewedAt: '2026-06-12T14:00:00Z',
    responded: null,
  })
  assertEqual(steps.map((s) => s.state), ['done', 'done', 'active'])
  assertEqual(steps[1].label, 'Viewed 4×')
  assertEqual(steps[2].note, 'awaiting reply')
})

test('funnel: changes requested → responded done with a label', () => {
  const steps = buildFunnel({
    sentAt: '2026-06-11T10:00:00Z',
    viewCount: 2,
    lastViewedAt: '2026-06-12T14:00:00Z',
    responded: { kind: 'changes', at: '2026-06-13T09:00:00Z' },
  })
  assertEqual(steps.map((s) => s.state), ['done', 'done', 'done'])
  assertEqual(steps[2].note, 'changes requested')
  assertEqual(steps[2].at, '2026-06-13T09:00:00Z')
})

// ── stat cards ──────────────────────────────────────────────────────────────────

test('ageDays floors to whole days and never goes negative', () => {
  const now = new Date('2026-06-15T00:00:00Z').getTime()
  assertEqual(ageDays('2026-06-10T00:00:00Z', now), 5)
  assertEqual(ageDays('2026-06-16T00:00:00Z', now), 0)
})

test('totalNonBotViews sums every version list', () => {
  const map = new Map<string, unknown[]>([
    ['a', [1, 2, 3]],
    ['b', [1]],
    ['c', []],
  ])
  assertEqual(totalNonBotViews(map), 4)
})

test('quantityRangeLabel spans min–max with thousands separators', () => {
  assertEqual(
    quantityRangeLabel({ customQuote: false, perDirectionPricing: false, quantities: [25, 100, 1000] }),
    '25–1,000',
  )
})

test('quantityRangeLabel collapses a single tier', () => {
  assertEqual(
    quantityRangeLabel({ customQuote: false, perDirectionPricing: false, quantities: [500] }),
    '500',
  )
})

test('quantityRangeLabel returns Custom for custom quotes and null when unknown', () => {
  assertEqual(
    quantityRangeLabel({ customQuote: true, perDirectionPricing: false, quantities: [25, 100] }),
    'Custom',
  )
  assertEqual(
    quantityRangeLabel({ customQuote: false, perDirectionPricing: false, quantities: [] }),
    null,
  )
})

// ── summaryLine ──────────────────────────────────────────────────────────────────

test('summaryLine: awaiting customer after a view reads "Opened — awaiting reply"', () => {
  assertEqual(
    summaryLine({
      bucket: 'awaiting_customer',
      ruleCode: null,
      sentAt: '2026-06-11T10:00:00Z',
      lastViewedAt: '2026-06-12T14:00:00Z',
      respondedAt: null,
      customerRepliedAt: null,
      lastActivityAt: '2026-06-12T14:00:00Z',
    }),
    { lead: 'Opened — awaiting reply', at: '2026-06-12T14:00:00Z' },
  )
})

test('summaryLine: needs_attention maps the rule code to a sentence', () => {
  assertEqual(
    summaryLine({
      bucket: 'needs_attention',
      ruleCode: 'sent_never_viewed',
      sentAt: '2026-06-11T10:00:00Z',
      lastViewedAt: null,
      respondedAt: null,
      customerRepliedAt: null,
      lastActivityAt: '2026-06-11T10:00:00Z',
    }),
    { lead: 'Sent but not opened yet', at: '2026-06-11T10:00:00Z' },
  )
})

test('summaryLine: terminal states return null', () => {
  for (const bucket of ['approved', 'abandoned', 'dormant', 'snoozed'] as const) {
    assertEqual(
      summaryLine({
        bucket,
        ruleCode: null,
        sentAt: null,
        lastViewedAt: null,
        respondedAt: null,
        customerRepliedAt: null,
        lastActivityAt: null,
      }),
      null,
    )
  }
})

// ── roundOutcome ─────────────────────────────────────────────────────────────────

test('roundOutcome: superseded version with a change request reads changes', () => {
  assertEqual(
    roundOutcome({ isCurrent: false, proofApproved: false, hasChanges: true, hasApproved: false }),
    'changes',
  )
})

test('roundOutcome: change request wins over a stray approval on the same version', () => {
  assertEqual(
    roundOutcome({ isCurrent: false, proofApproved: false, hasChanges: true, hasApproved: true }),
    'changes',
  )
})

test('roundOutcome: superseded version with no response reads none', () => {
  assertEqual(
    roundOutcome({ isCurrent: false, proofApproved: false, hasChanges: false, hasApproved: false }),
    'none',
  )
})

test('roundOutcome: current version, sent, no response reads awaiting', () => {
  assertEqual(
    roundOutcome({ isCurrent: true, proofApproved: false, hasChanges: false, hasApproved: false }),
    'awaiting',
  )
})

test('roundOutcome: current version reads approved once the proof is approved', () => {
  assertEqual(
    roundOutcome({ isCurrent: true, proofApproved: true, hasChanges: false, hasApproved: false }),
    'approved',
  )
})

test('roundOutcome: current version with outstanding changes reads changes', () => {
  assertEqual(
    roundOutcome({ isCurrent: true, proofApproved: false, hasChanges: true, hasApproved: false }),
    'changes',
  )
})

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
