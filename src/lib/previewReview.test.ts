// Unit tests for previewReview.ts and the pure parts of previewBridge.ts.
// Run with: npx tsx src/lib/previewReview.test.ts   (pnpm test:preview-review)
//
// The gate these back is behavioural, not cosmetic: the preview
// confirm button must stay locked until the designer has genuinely
// scrolled the proof and visited every option tab — but must NEVER
// stay locked because of a missing bridge message, a spinner-page
// scroll sample, or page-height churn. Each case below is one of
// those failure modes.

import {
  asPreviewHostMessage,
  asPreviewPageMessage,
  previewTabsForVersion,
  PREVIEW_HOST_SOURCE,
  PREVIEW_PAGE_SOURCE,
} from './previewBridge'
import {
  initialProgress,
  outstandingTabs,
  previewAuditMetadata,
  reviewComplete,
  scrollSatisfied,
  withBridgeTimeout,
  withContext,
  withScrollSample,
  withScrollTrackingFailed,
  withTabViewed,
} from './previewReview'

// ── Harness ─────────────────────────────────────────────────────────────────

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

function assertEqual<T>(actual: T, expected: T, message?: string) {
  if (actual !== expected) {
    throw new Error(message ?? `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

function assertDeepEqual(actual: unknown, expected: unknown, message?: string) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) {
    throw new Error(message ?? `Expected ${e}, got ${a}`)
  }
}

const TABS = [
  { code: 'brushed', label: 'Brushed' },
  { code: 'mirror', label: 'Mirror' },
]

// ── Message shape validation ────────────────────────────────────────────────

console.log('\nasPreviewPageMessage')

test('accepts a well-formed context message', () => {
  const msg = asPreviewPageMessage({
    source: PREVIEW_PAGE_SOURCE,
    kind: 'context',
    versionId: 'v-1',
    tabs: TABS,
  })
  assertEqual(msg?.kind, 'context')
  if (msg?.kind === 'context') assertDeepEqual(msg.tabs, TABS)
})

test('accepts a well-formed tab-viewed message', () => {
  const msg = asPreviewPageMessage({
    source: PREVIEW_PAGE_SOURCE,
    kind: 'tab-viewed',
    versionId: 'v-1',
    code: 'mirror',
  })
  assertEqual(msg?.kind, 'tab-viewed')
})

test('rejects a foreign source tag', () => {
  assertEqual(
    asPreviewPageMessage({ source: 'metamask', kind: 'context', versionId: 'v', tabs: [] }),
    null,
  )
})

test('rejects unknown kinds, missing fields, and non-object payloads', () => {
  assertEqual(asPreviewPageMessage({ source: PREVIEW_PAGE_SOURCE, kind: 'boom', versionId: 'v' }), null)
  assertEqual(asPreviewPageMessage({ source: PREVIEW_PAGE_SOURCE, kind: 'context', tabs: [] }), null)
  assertEqual(
    asPreviewPageMessage({ source: PREVIEW_PAGE_SOURCE, kind: 'tab-viewed', versionId: 'v', code: 7 }),
    null,
  )
  assertEqual(asPreviewPageMessage('context'), null)
  assertEqual(asPreviewPageMessage(null), null)
})

test('rejects a context message with malformed tab entries', () => {
  assertEqual(
    asPreviewPageMessage({
      source: PREVIEW_PAGE_SOURCE,
      kind: 'context',
      versionId: 'v',
      tabs: [{ code: 'ok', label: 'OK' }, { code: 42 }],
    }),
    null,
  )
})

console.log('\nasPreviewHostMessage')

test('accepts a well-formed show-tab message', () => {
  const msg = asPreviewHostMessage({
    source: PREVIEW_HOST_SOURCE,
    kind: 'show-tab',
    versionId: 'v-1',
    code: 'mirror',
  })
  assertEqual(msg?.code, 'mirror')
})

test('rejects wrong source, wrong kind, and missing fields', () => {
  assertEqual(
    asPreviewHostMessage({ source: PREVIEW_PAGE_SOURCE, kind: 'show-tab', versionId: 'v', code: 'c' }),
    null,
  )
  assertEqual(
    asPreviewHostMessage({ source: PREVIEW_HOST_SOURCE, kind: 'context', versionId: 'v', code: 'c' }),
    null,
  )
  assertEqual(asPreviewHostMessage({ source: PREVIEW_HOST_SOURCE, kind: 'show-tab', code: 'c' }), null)
})

// ── previewTabsForVersion (must mirror the customer-page render gate) ──────

console.log('\npreviewTabsForVersion')

const OPTIONS = [
  { material_id: 'm-steel', code: 'brushed', display_name: 'Brushed' },
  { material_id: 'm-steel', code: 'mirror', display_name: 'Mirror' },
  { material_id: 'm-wood', code: 'brushed', display_name: 'Wrong material Brushed' },
]

test('maps 2+ options to tabs with display names from the right material', () => {
  const tabs = previewTabsForVersion(
    { is_variant_round: false, shape: 'recipients', material_id: 'm-steel', material_options: ['brushed', 'mirror'] },
    OPTIONS,
  )
  assertDeepEqual(tabs, TABS)
})

test('falls back to the raw code when no catalogue row matches', () => {
  const tabs = previewTabsForVersion(
    { is_variant_round: false, shape: 'recipients', material_id: 'm-steel', material_options: ['brushed', 'satin'] },
    OPTIONS,
  )
  assertDeepEqual(tabs[1], { code: 'satin', label: 'satin' })
})

test('returns no tabs for a single-option version (no switcher renders)', () => {
  assertDeepEqual(
    previewTabsForVersion(
      { is_variant_round: false, shape: 'recipients', material_id: 'm-steel', material_options: ['brushed'] },
      OPTIONS,
    ),
    [],
  )
})

test('returns no tabs for variant rounds and Set (collection) versions', () => {
  assertDeepEqual(
    previewTabsForVersion(
      { is_variant_round: true, shape: 'selection', material_id: null, material_options: ['a', 'b'] },
      OPTIONS,
    ),
    [],
  )
  assertDeepEqual(
    previewTabsForVersion(
      { is_variant_round: false, shape: 'set_collection', material_id: 'm-steel', material_options: ['brushed', 'mirror'] },
      OPTIONS,
    ),
    [],
  )
})

// ── Review-progress state machine ───────────────────────────────────────────

console.log('\nreview progress: scroll')

test('scroll samples while the bridge is waiting are discarded', () => {
  // The pre-data customer page is a viewport-height spinner that
  // measures as "already at the end" — committing it would wave every
  // proof straight through.
  const p = withScrollSample(initialProgress(), 100, true)
  assertEqual(p.maxScrollPct, 0)
  assertEqual(p.scrolledToEnd, false)
})

test('scroll ratchets up and never back down', () => {
  let p = withContext(initialProgress(), [])
  p = withScrollSample(p, 40, false)
  p = withScrollSample(p, 25, false)
  assertEqual(p.maxScrollPct, 40)
  p = withScrollSample(p, 100, true)
  p = withScrollSample(p, 10, false)
  assertEqual(p.scrolledToEnd, true, 'once at the end, always at the end')
})

test('an unchanged sample returns the same object (no re-render churn)', () => {
  let p = withContext(initialProgress(), [])
  p = withScrollSample(p, 40, false)
  assertEqual(withScrollSample(p, 40, false), p)
  assertEqual(withScrollSample(p, 12, false), p)
})

test('pct is clamped to 0–100', () => {
  let p = withContext(initialProgress(), [])
  p = withScrollSample(p, 140, false)
  assertEqual(p.maxScrollPct, 100)
})

test('samples after the bridge timeout do count (scroll-only fallback)', () => {
  let p = withBridgeTimeout(initialProgress())
  p = withScrollSample(p, 100, true)
  assertEqual(p.scrolledToEnd, true)
})

console.log('\nreview progress: bridge and tabs')

test('timeout only bites while waiting', () => {
  const ready = withContext(initialProgress(), TABS)
  assertEqual(withBridgeTimeout(ready).bridge, 'ready')
})

test('late context upgrades a timed-out bridge and restores the tab checklist', () => {
  let p = withBridgeTimeout(initialProgress())
  p = withContext(p, TABS)
  assertEqual(p.bridge, 'ready')
  assertEqual(outstandingTabs(p).length, 2)
})

test('repeat context with the same tabs is a no-op object-wise', () => {
  const p = withContext(initialProgress(), TABS)
  assertEqual(withContext(p, [...TABS]), p)
})

test('tab views accumulate without duplicates, and pre-context pings still count', () => {
  let p = withTabViewed(initialProgress(), 'brushed')
  p = withTabViewed(p, 'brushed')
  assertDeepEqual(p.viewedTabCodes, ['brushed'])
  p = withContext(p, TABS)
  assertDeepEqual(outstandingTabs(p).map((t) => t.code), ['mirror'])
})

test('viewed codes no advertised tab uses never block completion', () => {
  let p = withContext(initialProgress(), [])
  p = withTabViewed(p, 'stray-code')
  p = withScrollSample(p, 100, true)
  assertEqual(reviewComplete(p), true)
})

console.log('\nreview progress: completion matrix')

test('never complete while the bridge is waiting', () => {
  assertEqual(reviewComplete(initialProgress()), false)
})

test('complete needs the end reached AND every tab viewed', () => {
  let p = withContext(initialProgress(), TABS)
  p = withScrollSample(p, 100, true)
  assertEqual(reviewComplete(p), false, 'tabs outstanding')
  p = withTabViewed(p, 'brushed')
  assertEqual(reviewComplete(p), false, 'one tab outstanding')
  p = withTabViewed(p, 'mirror')
  assertEqual(reviewComplete(p), true)
})

test('a tabless version completes on scroll alone', () => {
  let p = withContext(initialProgress(), [])
  assertEqual(reviewComplete(p), false)
  p = withScrollSample(p, 100, true)
  assertEqual(reviewComplete(p), true)
})

test('scroll-tracking failure waives the scroll requirement (fail open)', () => {
  let p = withContext(initialProgress(), TABS)
  p = withScrollTrackingFailed(p)
  assertEqual(scrollSatisfied(p), true)
  assertEqual(reviewComplete(p), false, 'tabs still required')
  p = withTabViewed(p, 'brushed')
  p = withTabViewed(p, 'mirror')
  assertEqual(reviewComplete(p), true)
})

test('failed tracking also stops later samples mutating state', () => {
  let p = withContext(initialProgress(), [])
  p = withScrollTrackingFailed(p)
  assertEqual(withScrollSample(p, 60, false), p)
})

test('bridge timeout with working scroll = scroll-only gate', () => {
  let p = withBridgeTimeout(initialProgress())
  assertEqual(reviewComplete(p), false)
  p = withScrollSample(p, 100, true)
  assertEqual(reviewComplete(p), true)
})

console.log('\npreviewAuditMetadata')

test('reports the shape the Activity ledger expects', () => {
  let p = withContext(initialProgress(), TABS)
  p = withTabViewed(p, 'brushed')
  p = withScrollSample(p, 72, false)
  const meta = previewAuditMetadata(p, 10_000, 22_400)
  assertDeepEqual(meta, {
    preview_seconds: 12,
    max_scroll_pct: 72,
    scrolled_to_end: false,
    tabs_total: 2,
    tabs_viewed: 1,
    bridge: 'ready',
    scroll_tracking: 'ok',
  })
})

test('viewed count ignores stray codes and seconds never go negative', () => {
  let p = withContext(initialProgress(), TABS)
  p = withTabViewed(p, 'stray')
  const meta = previewAuditMetadata(p, 5_000, 4_000)
  assertEqual(meta.tabs_viewed, 0)
  assertEqual(meta.preview_seconds, 0)
})

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
