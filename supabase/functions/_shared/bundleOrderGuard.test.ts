// Unit tests for the bundle order guard.
// Run with: npx tsx supabase/functions/_shared/bundleOrderGuard.test.ts
//
// Imports BOTH twins — this Deno copy (create-order re-checks with it at send
// time) and the src/ copy (the Orders page, the order builder and the proof
// page label with it) — and runs every case through each. The two disagreeing
// about what counts as a bundle sibling is the specific failure this guards:
// the page would warn where the server stayed quiet, or worse the reverse.
//
// The cases below are the real shapes on live, not invented ones: a set-aside
// card, an abandoned card, a set worn down to one live card, and the 12 August
// two-card bundle the whole thing exists for.

import * as deno from './bundleOrderGuard.ts'
import * as web from '../../../src/lib/bundleOrderGuard.ts'

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

function assertEqual(actual: unknown, expected: unknown, msg?: string) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(msg ? `${msg}: expected ${e}, got ${a}` : `expected ${e}, got ${a}`)
}

/** Run through both twins; drift fails here rather than in production. */
function assertBoth<T>(fn: (m: typeof deno) => T, expected: T, msg?: string) {
  assertEqual(fn(deno), expected, msg ? `${msg} (deno)` : undefined)
  assertEqual(fn(web as unknown as typeof deno), expected, msg ? `${msg} (web)` : undefined)
}

type Row = deno.BundleCardRow
const card = (id: string, status: string, over: Partial<Row> = {}): Row => ({
  id,
  proof_set_id: 'set-1',
  set_discarded_at: null,
  status,
  ...over,
})

console.log('\nbundleOrderGuard')

// ── The incident ────────────────────────────────────────────────────────────

test('the 12 Aug case: one card approved, its sibling still open', () => {
  const members = [card('metal', 'approved'), card('letterpress', 'in_progress')]
  assertBoth((m) => m.bundleOrderState('metal', members), {
    setId: 'set-1',
    size: 2,
    approvedCount: 1,
    outstanding: [{ id: 'letterpress' }],
  })
  assertBoth((m) => m.hasOutstandingSiblings(m.bundleOrderState('metal', members)), true)
  assertBoth((m) => m.bundleProgressLabel(m.bundleOrderState('metal', members)!), '1 of 2 approved')
})

// ── What counts as a live sibling ───────────────────────────────────────────

test('a set-aside sibling never holds an order back', () => {
  // The customer already decided against it. With only one live sibling left
  // and it set aside, this is not a bundle any more at all.
  const members = [
    card('metal', 'approved'),
    card('letterpress', 'in_progress', { set_discarded_at: '2026-08-12T10:00:00Z' }),
  ]
  assertBoth((m) => m.bundleOrderState('metal', members), null)
})

test('an abandoned sibling never holds an order back', () => {
  const members = [card('metal', 'approved'), card('letterpress', 'abandoned')]
  assertBoth((m) => m.bundleOrderState('metal', members), null)
})

test('with a third live card, a dropped sibling is simply not counted', () => {
  // The bundle survives (2 live cards), so the state is real — but the dropped
  // card is in neither the "of N" nor the outstanding list.
  const members = [
    card('metal', 'approved'),
    card('letterpress', 'in_progress'),
    card('wood', 'abandoned'),
  ]
  assertBoth((m) => m.bundleOrderState('metal', members), {
    setId: 'set-1',
    size: 2,
    approvedCount: 1,
    outstanding: [{ id: 'letterpress' }],
  })
})

test('a dormant sibling is outstanding — quiet is not approved', () => {
  const members = [card('metal', 'approved'), card('letterpress', 'dormant')]
  assertBoth((m) => m.bundleOrderState('metal', members)!.outstanding, [{ id: 'letterpress' }])
})

// ── When there is nothing to say ────────────────────────────────────────────

test('a standalone project has no bundle state', () => {
  const members = [card('solo', 'approved', { proof_set_id: null })]
  assertBoth((m) => m.bundleOrderState('solo', members), null)
})

test('a proof absent from the membership rows has no bundle state', () => {
  // The Orders page fetches membership for every set at once; a proof in no set
  // simply isn't in the result. That must read as "not a bundle", never throw.
  assertBoth((m) => m.bundleOrderState('unknown', [card('metal', 'approved')]), null)
})

test('a bundle down to one live card is not a bundle', () => {
  // 000317's rule, and dashboardBundles' floor: a last card standing chases and
  // sells on its own terms. A "bundle of 1" warning is noise.
  const members = [card('metal', 'approved'), card('letterpress', 'abandoned')]
  assertBoth((m) => m.bundleOrderState('metal', members), null)
})

test('the card being ordered is itself set aside or abandoned', () => {
  const members = [
    card('metal', 'approved', { set_discarded_at: '2026-08-12T10:00:00Z' }),
    card('letterpress', 'in_progress'),
    card('wood', 'in_progress'),
  ]
  assertBoth((m) => m.bundleOrderState('metal', members), null)
})

test('members of other bundles are ignored', () => {
  const members = [
    card('metal', 'approved'),
    card('letterpress', 'in_progress'),
    card('someone-else', 'in_progress', { proof_set_id: 'set-2' }),
    card('someone-else-2', 'in_progress', { proof_set_id: 'set-2' }),
  ]
  assertBoth((m) => m.bundleOrderState('metal', members)!.size, 2)
  assertBoth((m) => m.bundleOrderState('metal', members)!.outstanding, [{ id: 'letterpress' }])
})

// ── The all-clear ───────────────────────────────────────────────────────────

test('a fully approved bundle has state but nothing outstanding', () => {
  // Deliberately not null: this is the moment to combine the payments instead
  // of sending three separate links, and the page says so.
  const members = [card('a', 'approved'), card('b', 'approved'), card('c', 'approved')]
  assertBoth((m) => m.bundleOrderState('a', members), {
    setId: 'set-1',
    size: 3,
    approvedCount: 3,
    outstanding: [],
  })
  assertBoth((m) => m.hasOutstandingSiblings(m.bundleOrderState('a', members)), false)
  assertBoth((m) => m.bundleProgressLabel(m.bundleOrderState('a', members)!), '3 of 3 approved')
})

test('hasOutstandingSiblings is false for a card with no bundle', () => {
  assertBoth((m) => m.hasOutstandingSiblings(null), false)
})

// ── isLiveBundleCard on its own ─────────────────────────────────────────────

test('isLiveBundleCard: in a set, not dropped, not abandoned', () => {
  assertBoth((m) => m.isLiveBundleCard(card('x', 'in_progress')), true)
  assertBoth((m) => m.isLiveBundleCard(card('x', 'approved')), true)
  assertBoth((m) => m.isLiveBundleCard(card('x', 'dormant')), true)
  assertBoth((m) => m.isLiveBundleCard(card('x', 'abandoned')), false)
  assertBoth((m) => m.isLiveBundleCard(card('x', 'in_progress', { proof_set_id: null })), false)
  assertBoth(
    (m) => m.isLiveBundleCard(card('x', 'in_progress', { set_discarded_at: '2026-08-12T10:00:00Z' })),
    false,
  )
})

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
