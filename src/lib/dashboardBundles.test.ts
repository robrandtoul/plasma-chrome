// Unit tests for dashboardBundles.ts
// Run with: npx tsx src/lib/dashboardBundles.test.ts
//
// Covers the two decisions that matter: which sets count as a bundle at all
// (buildBundleIndex — the exclusions all come from shapes present in live
// data), and where a bundle block lands in a section without resequencing the
// rest of the list (buildRowItems).

import {
  buildBundleIndex,
  buildRowItems,
  bundleSentState,
  bundleShownHere,
  EMPTY_BUNDLE_INDEX,
  type BundleMemberRow,
  type BundleSetRow,
} from './dashboardBundles'
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

function member(
  id: string,
  setId: string | null,
  overrides: Partial<BundleMemberRow> = {},
): BundleMemberRow {
  return { id, proof_set_id: setId, set_discarded_at: null, status: 'in_progress', ...overrides }
}

function set(id: string, overrides: Partial<BundleSetRow> = {}): BundleSetRow {
  return { id, token: `tok-${id}`, sent_at: null, last_opened_at: null, ...overrides }
}

/** Only the fields buildRowItems reads; the rest of DashboardProject is inert here. */
function project(id: string): DashboardProject {
  return { proof_id: id } as DashboardProject
}

const keys = (items: ReturnType<typeof buildRowItems>) => items.map((i) => i.key).join(',')

// ── buildBundleIndex ──────────────────────────────────────────────────────────

console.log('\nbuildBundleIndex')

test('two live cards in one set become a bundle', () => {
  const index = buildBundleIndex([member('a', 's1'), member('b', 's1')], [set('s1')])
  assertEqual(index.byProof.size, 2)
  assertEqual(index.byProof.get('a')!.size, 2)
  assertEqual(index.byProof.get('a')!.token, 'tok-s1')
  assert(index.byProof.get('a') === index.byProof.get('b'), 'both cards share one BundleInfo')
})

test('a standalone proof is not in the index', () => {
  const index = buildBundleIndex([member('a', null), member('b', 's1'), member('c', 's1')], [set('s1')])
  assertEqual(index.byProof.has('a'), false)
})

test('one card is not a bundle', () => {
  const index = buildBundleIndex([member('a', 's1')], [set('s1')])
  assertEqual(index.byProof.size, 0)
})

test('set-aside cards do not count, and can drop a set below two', () => {
  const index = buildBundleIndex(
    [member('a', 's1'), member('b', 's1', { set_discarded_at: '2026-07-20T10:00:00Z' })],
    [set('s1')],
  )
  assertEqual(index.byProof.size, 0, 'one live card left — no bundle')
})

test('abandoned cards do not count', () => {
  // Live shape: 10 of 35 member proofs are abandoned, and three sets are
  // abandoned end to end.
  const index = buildBundleIndex(
    [
      member('a', 's1'),
      member('b', 's1'),
      member('c', 's1', { status: 'abandoned' }),
      member('d', 's2', { status: 'abandoned' }),
      member('e', 's2', { status: 'abandoned' }),
    ],
    [set('s1'), set('s2')],
  )
  assertEqual(index.byProof.get('a')!.size, 2, 's1 counts its two live cards')
  assertEqual(index.byProof.has('c'), false, 'the abandoned sibling gets no chip')
  assertEqual(index.byProof.has('d'), false, 'a fully abandoned set renders nothing')
})

test('approvedCount spans the whole bundle', () => {
  const index = buildBundleIndex(
    [
      member('a', 's1', { status: 'approved' }),
      member('b', 's1', { status: 'approved' }),
      member('c', 's1'),
    ],
    [set('s1')],
  )
  assertEqual(index.byProof.get('c')!.approvedCount, 2)
  assertEqual(index.byProof.get('c')!.size, 3)
})

test('a member whose set row is missing stays a plain row', () => {
  const index = buildBundleIndex([member('a', 's1'), member('b', 's1')], [])
  assertEqual(index.byProof.size, 0)
})

// ── bundleSentState ───────────────────────────────────────────────────────────

console.log('\nbundleSentState')

test('unsent / sent-unopened / opened', () => {
  assertEqual(bundleSentState({ sentAt: null, lastOpenedAt: null }), 'unsent')
  assertEqual(bundleSentState({ sentAt: '2026-07-27T10:00:00Z', lastOpenedAt: null }), 'sent_unopened')
  assertEqual(
    bundleSentState({ sentAt: '2026-07-27T10:00:00Z', lastOpenedAt: '2026-07-27T11:00:00Z' }),
    'opened',
  )
})

test('an unsent bundle whose cards were sent standalone still reads unsent', () => {
  // The 000317 case — live has one sitting fully approved. The label says the
  // bundle LINK has not gone out, which is exactly what this state means.
  const index = buildBundleIndex(
    [member('a', 's1', { status: 'approved' }), member('b', 's1', { status: 'approved' })],
    [set('s1')],
  )
  assertEqual(bundleSentState(index.byProof.get('a')!), 'unsent')
})

// ── buildRowItems ─────────────────────────────────────────────────────────────

console.log('\nbuildRowItems')

test('siblings split by an unrelated row are pulled together at the first one', () => {
  // The reported case: two Atlus cards with a Leccy.Tech row between them.
  const index = buildBundleIndex([member('atlus1', 's1'), member('atlus2', 's1')], [set('s1')])
  const items = buildRowItems([project('atlus1'), project('leccy'), project('atlus2')], index)
  assertEqual(keys(items), 'bundle:s1,leccy')
  const block = items[0]
  assert(block.kind === 'bundle', 'first item is the bundle block')
  if (block.kind === 'bundle') {
    assertEqual(block.projects.map((p) => p.proof_id).join(','), 'atlus1,atlus2')
  }
})

test('rows outside the bundle keep their order', () => {
  const index = buildBundleIndex([member('b', 's1'), member('d', 's1')], [set('s1')])
  const items = buildRowItems(
    [project('a'), project('b'), project('c'), project('d'), project('e')],
    index,
  )
  assertEqual(keys(items), 'a,bundle:s1,c,e')
})

test('a lone member in this section gets no block', () => {
  // Its siblings are in another day bucket / filtered out — the row keeps its
  // place and the caller renders the chip instead.
  const index = buildBundleIndex([member('a', 's1'), member('z', 's1')], [set('s1')])
  const items = buildRowItems([project('a'), project('b')], index)
  assertEqual(keys(items), 'a,b')
  assertEqual(items[0].kind, 'project')
})

test('two bundles in one section each get their own block', () => {
  const index = buildBundleIndex(
    [member('a', 's1'), member('c', 's1'), member('b', 's2'), member('d', 's2')],
    [set('s1'), set('s2')],
  )
  const items = buildRowItems([project('a'), project('b'), project('c'), project('d')], index)
  assertEqual(keys(items), 'bundle:s1,bundle:s2')
})

test('a three-card bundle nests all three', () => {
  const index = buildBundleIndex(
    [member('a', 's1'), member('b', 's1'), member('c', 's1')],
    [set('s1')],
  )
  const items = buildRowItems([project('a'), project('b'), project('c')], index)
  assertEqual(items.length, 1)
  if (items[0].kind === 'bundle') assertEqual(items[0].projects.length, 3)
})

test('no bundles at all is a pass-through', () => {
  const items = buildRowItems([project('a'), project('b')], EMPTY_BUNDLE_INDEX)
  assertEqual(keys(items), 'a,b')
  assert(items.every((i) => i.kind === 'project'), 'every item is a plain project')
})

test('every project survives the transform', () => {
  const index = buildBundleIndex([member('b', 's1'), member('d', 's1')], [set('s1')])
  const input = [project('a'), project('b'), project('c'), project('d')]
  const items = buildRowItems(input, index)
  const rendered = items.flatMap((i) => (i.kind === 'bundle' ? i.projects : [i.project]))
  assertEqual(rendered.length, input.length, 'no row is dropped')
  assertEqual(new Set(rendered.map((p) => p.proof_id)).size, input.length, 'no row is duplicated')
})

// ── bundleShownHere ───────────────────────────────────────────────────────────

console.log('\nbundleShownHere')

test('counts only the cards present in this list', () => {
  const index = buildBundleIndex(
    [member('a', 's1'), member('b', 's1'), member('c', 's1')],
    [set('s1')],
  )
  const info = index.byProof.get('a')!
  assertEqual(bundleShownHere([project('a'), project('b')], info), 2)
  assertEqual(bundleShownHere([project('a'), project('b'), project('c')], info), 3)
  assertEqual(bundleShownHere([project('x')], info), 0)
})

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
