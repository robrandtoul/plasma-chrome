// Unit tests for bundleCheckpoint.ts
// Run with: npx tsx src/lib/bundleCheckpoint.test.ts  (or pnpm test:bundle-checkpoint)
//
// What matters here:
//
//   1. The recommendation must flip at exactly the right moment. Mid-round
//      (any sibling still holding only what the customer has seen, or an
//      unbuilt shell) the primary action is "Back to the bundle"; only when
//      EVERY active card carries unannounced changes does it become the
//      bundle send. Flipping early recreates the premature email this
//      feature exists to stop; flipping late strands the designer.
//
//   2. The null guards ARE the feature's scope. The checkpoint must stand
//      down (plain send panel) for: bundles of one, a saved card that's been
//      discarded, an edit of an already-announced version, and an edit of a
//      non-current version. Each of those showing a checkpoint would give
//      wrong advice.
//
//   3. The seeded migration body must be byte-identical to DEFAULT_BODIES —
//      the admin editor's Reset button writes DEFAULT_BODIES back, so drift
//      means Reset restores different copy than a fresh replay would seed,
//      silently. Same guard the abandon-notice test carries for 000366.

import { readFileSync } from 'node:fs'
import {
  buildBundleCheckpoint,
  checkpointGuidance,
  primaryActionLabel,
  sendJustThisCardCaution,
  type CheckpointMember,
  type CheckpointVersion,
} from './bundleCheckpoint.ts'
import { DEFAULT_BODIES, renderTemplate } from './replyTemplates.ts'

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

function assertEquals<T>(actual: T, expected: T, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`)
  }
}

// ── Fixture builders ─────────────────────────────────────────────────────────

const SENT = '2026-07-01T09:00:00Z'

function version(
  id: string,
  n: number,
  lastReplySentAt: string | null,
  over: Partial<CheckpointVersion> = {},
): CheckpointVersion {
  return {
    id,
    version_number: n,
    material_display: 'Stainless Steel',
    names: [],
    last_reply_sent_at: lastReplySentAt,
    ...over,
  }
}

function member(
  proofId: string,
  cv: CheckpointVersion | null,
  over: Partial<CheckpointMember> = {},
): CheckpointMember {
  return { proof_id: proofId, status: 'in_progress', set_discarded_at: null, current_version: cv, ...over }
}

// ── The Experience Auto Group shape: a revision round on a sent bundle ───────

console.log('\nbuildBundleCheckpoint — sent bundle, mid-revision-round')

test('first card revised, siblings still announced → back to the bundle', () => {
  const model = buildBundleCheckpoint({
    members: [
      member('p1', version('v1b', 2, null)),          // just revised
      member('p2', version('v2a', 1, SENT)),          // customer has latest
      member('p3', version('v3a', 1, SENT)),          // customer has latest
    ],
    savedProofId: 'p1',
    savedVersionId: 'v1b',
    setSentAt: SENT,
  })
  assert(model != null, 'the checkpoint should show')
  assertEquals(model!.rows.map((r) => r.state), ['saved_now', 'with_customer', 'with_customer'], 'states')
  assertEquals(model!.outstandingCount, 2, 'both un-revised siblings are outstanding')
  assertEquals(model!.readyForOneSend, false, 'the round is not done')
  assertEquals(primaryActionLabel(model!), 'Back to the bundle', 'primary steers back mid-round')
})

test('every card revised → the single bundle send becomes the primary action', () => {
  const model = buildBundleCheckpoint({
    members: [
      member('p1', version('v1b', 2, null)),
      member('p2', version('v2b', 2, null)),
      member('p3', version('v3b', 3, null)),
    ],
    savedProofId: 'p3',
    savedVersionId: 'v3b',
    setSentAt: SENT,
  })
  assert(model != null, 'the checkpoint should show')
  assertEquals(model!.outstandingCount, 0, 'nothing outstanding')
  assertEquals(model!.readyForOneSend, true, 'the round is complete')
  assert(primaryActionLabel(model!) !== 'Back to the bundle', 'primary is now the send itself')
  assert(/bundle/i.test(primaryActionLabel(model!)), 'the send action names the bundle')
})

test('an unbuilt shell keeps the round open', () => {
  const model = buildBundleCheckpoint({
    members: [
      member('p1', version('v1b', 2, null)),
      member('p2', version('v2b', 2, null)),
      member('p3', null),                              // card added, never built
    ],
    savedProofId: 'p1',
    savedVersionId: 'v1b',
    setSentAt: SENT,
  })
  assert(model != null, 'the checkpoint should show')
  assertEquals(model!.rows[2].state, 'no_artwork', 'the shell is called out')
  assertEquals(model!.readyForOneSend, false, 'a shell blocks the one-send recommendation')
})

test('discarded and abandoned members are invisible to the round', () => {
  const model = buildBundleCheckpoint({
    members: [
      member('p1', version('v1b', 2, null)),
      member('p2', version('v2b', 2, null)),
      member('p3', version('v3a', 1, SENT), { set_discarded_at: '2026-07-10T00:00:00Z' }),
      member('p4', version('v4a', 1, SENT), { status: 'abandoned' }),
    ],
    savedProofId: 'p1',
    savedVersionId: 'v1b',
    setSentAt: SENT,
  })
  assert(model != null, 'two active members remain, so the checkpoint shows')
  assertEquals(model!.activeCount, 2, 'only active members count')
  assertEquals(model!.rows.length, 2, 'set-aside cards do not clutter the checklist')
  assertEquals(model!.readyForOneSend, true, 'their announce state cannot hold the round open')
})

// ── Null guards: when the plain panel is the right flow ──────────────────────

console.log('\nbuildBundleCheckpoint — stands down for')

test('a bundle with a single active card', () => {
  const model = buildBundleCheckpoint({
    members: [
      member('p1', version('v1b', 2, null)),
      member('p2', version('v2a', 1, SENT), { set_discarded_at: '2026-07-10T00:00:00Z' }),
    ],
    savedProofId: 'p1',
    savedVersionId: 'v1b',
    setSentAt: SENT,
  })
  assertEquals(model, null, 'nothing to coordinate — per-card flow is correct')
})

test('an edit of an already-announced version', () => {
  const model = buildBundleCheckpoint({
    members: [
      member('p1', version('v1a', 2, SENT)),          // announced; designer edited it
      member('p2', version('v2a', 1, SENT)),
    ],
    savedProofId: 'p1',
    savedVersionId: 'v1a',
    setSentAt: SENT,
  })
  assertEquals(model, null, 'the bundle update send would skip this card, so the panel is honest')
})

test('an edit of a version that is no longer current', () => {
  const model = buildBundleCheckpoint({
    members: [
      member('p1', version('v1c', 3, null)),          // current is v1c…
      member('p2', version('v2a', 1, SENT)),
    ],
    savedProofId: 'p1',
    savedVersionId: 'v1b',                             // …but v1b was edited
    setSentAt: SENT,
  })
  assertEquals(model, null, 'the bundle page shows the current version, not the edited one')
})

test('a saved card that is itself discarded or missing', () => {
  const discarded = buildBundleCheckpoint({
    members: [
      member('p1', version('v1b', 2, null), { set_discarded_at: '2026-07-10T00:00:00Z' }),
      member('p2', version('v2a', 1, SENT)),
      member('p3', version('v3a', 1, SENT)),
    ],
    savedProofId: 'p1',
    savedVersionId: 'v1b',
    setSentAt: SENT,
  })
  assertEquals(discarded, null, 'a set-aside card is not part of the round')
  const missing = buildBundleCheckpoint({
    members: [member('p2', version('v2a', 1, SENT)), member('p3', version('v3a', 1, SENT))],
    savedProofId: 'p1',
    savedVersionId: 'v1b',
    setSentAt: SENT,
  })
  assertEquals(missing, null, 'a card the fetch cannot see gets the plain panel')
})

// ── Unsent bundles: the build-out flow ───────────────────────────────────────

console.log('\nbuildBundleCheckpoint — unsent bundle')

test('cards still unbuilt → back to the bundle', () => {
  const model = buildBundleCheckpoint({
    members: [member('p1', version('v1a', 1, null)), member('p2', null), member('p3', null)],
    savedProofId: 'p1',
    savedVersionId: 'v1a',
    setSentAt: null,
  })
  assert(model != null, 'the checkpoint should show')
  assertEquals(model!.readyForOneSend, false, 'two shells remain')
  assertEquals(primaryActionLabel(model!), 'Back to the bundle', 'keep building')
})

test('every card built → send the bundle, even with an individually-sent sibling', () => {
  // The Shard Global shape: a card announced standalone before the set went
  // out. The INITIAL bundle send stamps every active card, so an announced
  // sibling doesn't hold the send back on an unsent set.
  const model = buildBundleCheckpoint({
    members: [
      member('p1', version('v1a', 1, null)),
      member('p2', version('v2a', 2, SENT)),
    ],
    savedProofId: 'p1',
    savedVersionId: 'v1a',
    setSentAt: null,
  })
  assert(model != null, 'the checkpoint should show')
  assertEquals(model!.readyForOneSend, true, 'the initial send covers every active card')
  assert(/bundle/i.test(primaryActionLabel(model!)), 'primary is the bundle send')
})

// ── Copy rules ───────────────────────────────────────────────────────────────

console.log('\ncopy rules')

test('guidance changes with the state, and the per-card caution is never empty', () => {
  const mk = (setSentAt: string | null, siblingSent: string | null) =>
    buildBundleCheckpoint({
      members: [member('p1', version('v1b', 2, null)), member('p2', version('v2a', 1, siblingSent))],
      savedProofId: 'p1',
      savedVersionId: 'v1b',
      setSentAt,
    })!
  const midRound = mk(SENT, SENT)
  const ready = mk(SENT, null)
  const unsent = mk(null, null)
  assert(checkpointGuidance(midRound) !== checkpointGuidance(ready), 'mid-round and ready read differently')
  assert(checkpointGuidance(unsent) !== checkpointGuidance(ready), 'unsent and sent read differently')
  for (const m of [midRound, ready, unsent]) {
    assert(sendJustThisCardCaution(m).trim().length > 0, 'the demoted send always says what it costs')
  }
})

test('rows are labelled from names first, material second — the workspace rule', () => {
  const model = buildBundleCheckpoint({
    members: [
      member('p1', version('v1b', 2, null, { names: ['James Milner', 'Sadio Mané'] })),
      member('p2', version('v2a', 1, SENT, { material_display: 'Carbon Fibre' })),
    ],
    savedProofId: 'p1',
    savedVersionId: 'v1b',
    setSentAt: SENT,
  })!
  assertEquals(model.rows[0].label, 'James Milner & Sadio Mané', 'recipient names win')
  assertEquals(model.rows[1].label, 'Carbon Fibre', 'material stands in when there are no names')
})

// ── The revision template ────────────────────────────────────────────────────

console.log('\nbundle_revision_link template')

test('renders with and without a company, and always carries the link', () => {
  const withCompany = renderTemplate(DEFAULT_BODIES.bundle_revision_link, {
    first_name: 'Alex',
    company: 'Experience Auto Group',
    url: 'https://example.test/bundle/abc?token=t',
  })
  assert(withCompany.includes('for Experience Auto Group'), 'company renders inside the conditional')
  assert(withCompany.includes('https://example.test/bundle/abc?token=t'), 'the bundle link is present')
  const noCompany = renderTemplate(DEFAULT_BODIES.bundle_revision_link, {
    first_name: 'Alex',
    company: '   ',
    url: 'https://example.test/bundle/abc?token=t',
  })
  assert(!noCompany.includes(' for '), 'a blank company collapses the whole clause')
})

test('migration 000386 seeds the code default byte-for-byte', () => {
  // The admin editor's Reset button writes DEFAULT_BODIES back; a fresh
  // replay seeds the migration literal. If the two drift, Reset silently
  // restores different copy than a fresh install ships with. Extract the
  // seeded body (4th value) and unescape Postgres '' quoting, same walk the
  // abandon-notice test uses for 000366.
  const sql = readFileSync(
    new URL('../../supabase/migrations/000386_bundle_revision_template.sql', import.meta.url),
    'utf8',
  )
  const values = sql.slice(sql.indexOf('values'))
  const bodyStart = values.indexOf("'Hi {first_name}")
  assert(bodyStart !== -1, 'could not find the seeded body literal in 000386')
  let i = bodyStart + 1
  let seeded = ''
  while (i < values.length) {
    if (values[i] === "'") {
      if (values[i + 1] === "'") { seeded += "'"; i += 2; continue }
      break
    }
    seeded += values[i]
    i += 1
  }
  assertEquals(seeded, DEFAULT_BODIES.bundle_revision_link, 'seed and code default must match')
})

// ── Result ───────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
