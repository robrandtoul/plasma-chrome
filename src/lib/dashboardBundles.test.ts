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
  hoistBundleSections,
  type BundleMemberRow,
  type BundleSetRow,
} from './dashboardBundles'
import type { DashboardProject, ProjectSection } from './dashboardGrouping'

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

// ── hoistBundleSections ───────────────────────────────────────────────────────

console.log('\nhoistBundleSections')

function timeSection(key: string, ids: string[]): ProjectSection {
  return { key, title: key, kind: 'time', projects: ids.map(project) }
}

const sectionIds = (s: ProjectSection) => s.projects.map((p) => p.proof_id).join(',')

test('a card racing ahead pulls the whole bundle into its section', () => {
  // The Experience Auto Group case (2026-07-28): v8 freshly sent lands in
  // Today while its two siblings sit in Older — the bundle rides up together.
  const index = buildBundleIndex(
    [member('v8', 's1'), member('v7', 's1'), member('mb', 's1')],
    [set('s1')],
  )
  const out = hoistBundleSections(
    [timeSection('today', ['v8', 'other']), timeSection('older', ['x', 'v7', 'mb', 'y'])],
    index,
  )
  assertEqual(out.length, 2)
  assertEqual(sectionIds(out[0]), 'v8,other,v7,mb', 'siblings appended after Today rows')
  assertEqual(sectionIds(out[1]), 'x,y', 'Older keeps its unrelated rows in order')
  // And the merged section renders as one block anchored at the fresh card.
  const items = buildRowItems(out[0].projects, index)
  assertEqual(keys(items), 'bundle:s1,other')
  if (items[0].kind === 'bundle') {
    assertEqual(items[0].projects.map((p) => p.proof_id).join(','), 'v8,v7,mb')
  }
})

test('a section emptied by hoisting is dropped', () => {
  const index = buildBundleIndex([member('a', 's1'), member('b', 's1')], [set('s1')])
  const out = hoistBundleSections(
    [timeSection('today', ['a']), timeSection('older', ['b'])],
    index,
  )
  assertEqual(out.length, 1)
  assertEqual(sectionIds(out[0]), 'a,b')
})

test('a bundle already in one section leaves every section untouched', () => {
  const index = buildBundleIndex([member('a', 's1'), member('b', 's1')], [set('s1')])
  const input = [timeSection('today', ['a', 'b']), timeSection('older', ['x'])]
  const out = hoistBundleSections(input, index)
  assertEqual(sectionIds(out[0]), 'a,b')
  assertEqual(sectionIds(out[1]), 'x')
  assert(out[0] === input[0] && out[1] === input[1], 'untouched sections keep their identity')
})

test('a lone member whose siblings are filtered out of the list stays put', () => {
  // The chip case: sibling z is not in any section (tile filter / search /
  // outside the working set), so there is nothing to gather.
  const index = buildBundleIndex([member('a', 's1'), member('z', 's1')], [set('s1')])
  const out = hoistBundleSections(
    [timeSection('today', ['a']), timeSection('older', ['x'])],
    index,
  )
  assertEqual(sectionIds(out[0]), 'a')
  assertEqual(sectionIds(out[1]), 'x')
})

test('two bundles anchor independently in their own freshest sections', () => {
  const index = buildBundleIndex(
    [member('a1', 's1'), member('a2', 's1'), member('b1', 's2'), member('b2', 's2')],
    [set('s1'), set('s2')],
  )
  const out = hoistBundleSections(
    [
      timeSection('today', ['a1']),
      timeSection('week', ['b1', 'a2']),
      timeSection('older', ['b2']),
    ],
    index,
  )
  assertEqual(out.length, 2, 'older emptied and dropped')
  assertEqual(sectionIds(out[0]), 'a1,a2')
  assertEqual(sectionIds(out[1]), 'b1,b2')
})

test('no bundles at all is a pass-through', () => {
  const input = [timeSection('today', ['a']), timeSection('older', ['b'])]
  assert(hoistBundleSections(input, EMPTY_BUNDLE_INDEX) === input, 'same array back')
})

test('every project survives the hoist', () => {
  const index = buildBundleIndex(
    [member('a', 's1'), member('b', 's1'), member('c', 's1')],
    [set('s1')],
  )
  const input = [
    timeSection('today', ['a', 'x']),
    timeSection('week', ['b', 'y']),
    timeSection('older', ['z', 'c']),
  ]
  const out = hoistBundleSections(input, index)
  const rendered = out.flatMap((s) => s.projects.map((p) => p.proof_id))
  assertEqual(rendered.length, 6, 'no row is dropped')
  assertEqual(new Set(rendered).size, 6, 'no row is duplicated')
})

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
