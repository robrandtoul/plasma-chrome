// Review-progress state for the designer preview gate.
//
// VersionPreviewGate keeps one ReviewProgress value and folds events
// into it through the functions below: scroll samples measured off the
// same-origin iframe, and bridge messages relayed from the customer
// page (see previewBridge.ts). The gate's confirm button enables only
// when reviewComplete() — the designer has scrolled to the end of the
// proof and looked at every option tab the customer would see.
//
// Design rules, all in service of "a check, not a punishment":
//
// - Requirements only ratchet. Once the end of the page has been
//   reached it stays reached, even though the page keeps growing as
//   images stream in and tab switches change its height. A button
//   that re-locks after being earned reads as broken and breeds
//   resentment (and workarounds).
// - Scroll samples taken while the bridge is still 'waiting' are
//   discarded. Before the proof data loads, the customer page is a
//   viewport-height spinner, which measures as "already at the end" —
//   committing that would wave every proof through. The customer page
//   posts its context message at the same moment real content mounts,
//   so 'ready' doubles as the content-is-measurable signal.
// - Fail open, never lock out. If the context message never arrives
//   (cached older customer-page bundle), the gate times the bridge out
//   and falls back to scroll-only; if scroll tracking itself throws,
//   the scroll requirement is waived too. A broken gate must never
//   stop proofs going out — the audit metadata records which mode the
//   confirmation happened in so a silent fallback is still visible.
// - Late context still counts. A slow connection can deliver the
//   context message after the timeout; upgrading 'timeout' → 'ready'
//   surfaces the real tab checklist rather than staying in the
//   degraded mode.
//
// Everything here is pure and browser-free so the whole matrix is unit
// tested: pnpm test:preview-review.

import type { PreviewTabInfo } from './previewBridge'

export type PreviewBridgeState = 'waiting' | 'ready' | 'timeout'

export interface ReviewProgress {
  bridge: PreviewBridgeState
  scrollTracking: 'ok' | 'failed'
  // Deepest point reached, as a percentage of the page height at the
  // time of the sample. Display + audit only — completion is the
  // boolean below.
  maxScrollPct: number
  scrolledToEnd: boolean
  // Tabs the previewed version renders (from the context message) and
  // which codes have been active so far. viewedTabCodes may contain
  // codes that arrive before context or that no advertised tab uses —
  // completion only ever counts the intersection.
  tabs: PreviewTabInfo[]
  viewedTabCodes: string[]
}

export function initialProgress(): ReviewProgress {
  return {
    bridge: 'waiting',
    scrollTracking: 'ok',
    maxScrollPct: 0,
    scrolledToEnd: false,
    tabs: [],
    viewedTabCodes: [],
  }
}

function sameTabs(a: PreviewTabInfo[], b: PreviewTabInfo[]): boolean {
  return a.length === b.length && a.every((t, i) => t.code === b[i].code && t.label === b[i].label)
}

// Context message arrived: the bridge is live and we know the real tab
// list. Idempotent for repeat sends (React strict mode double-effects,
// the designer flicking between versions and back) and accepted even
// after a timeout — see the header note on late context.
export function withContext(p: ReviewProgress, tabs: PreviewTabInfo[]): ReviewProgress {
  if (p.bridge === 'ready' && sameTabs(p.tabs, tabs)) return p
  return { ...p, bridge: 'ready', tabs }
}

// The context wait expired. Only meaningful from 'waiting' — a bridge
// that already went ready stays ready.
export function withBridgeTimeout(p: ReviewProgress): ReviewProgress {
  return p.bridge === 'waiting' ? { ...p, bridge: 'timeout' } : p
}

export function withTabViewed(p: ReviewProgress, code: string): ReviewProgress {
  if (p.viewedTabCodes.includes(code)) return p
  return { ...p, viewedTabCodes: [...p.viewedTabCodes, code] }
}

// Fold in one scroll measurement. pct is (scrollTop + viewport) over
// page height as a 0–100 number; atEnd is whether that sample sits
// within the bottom margin (a page shorter than the viewport counts as
// at the end — there is nothing to scroll). Returns the same object
// when nothing changed so scroll-event storms don't re-render the
// gate.
export function withScrollSample(p: ReviewProgress, pct: number, atEnd: boolean): ReviewProgress {
  if (p.bridge === 'waiting') return p
  if (p.scrollTracking === 'failed') return p
  const bounded = Math.max(0, Math.min(100, Math.round(pct)))
  const nextPct = Math.max(p.maxScrollPct, bounded)
  const nextEnd = p.scrolledToEnd || atEnd
  if (nextPct === p.maxScrollPct && nextEnd === p.scrolledToEnd) return p
  return { ...p, maxScrollPct: nextPct, scrolledToEnd: nextEnd }
}

export function withScrollTrackingFailed(p: ReviewProgress): ReviewProgress {
  return p.scrollTracking === 'failed' ? p : { ...p, scrollTracking: 'failed' }
}

export function outstandingTabs(p: ReviewProgress): PreviewTabInfo[] {
  return p.tabs.filter((t) => !p.viewedTabCodes.includes(t.code))
}

export function scrollSatisfied(p: ReviewProgress): boolean {
  return p.scrolledToEnd || p.scrollTracking === 'failed'
}

export function reviewComplete(p: ReviewProgress): boolean {
  return p.bridge !== 'waiting' && scrollSatisfied(p) && outstandingTabs(p).length === 0
}

// Structured snapshot for the audit ledger, written when the designer
// confirms (or bails back to the editor). This is the accountability
// half of the gate: the requirements make skimming harder, the audit
// trail makes it visible — a run of three-second, 30%-scrolled
// confirmations shows up on Admin → Activity long before a customer
// catches the next mistake.
export function previewAuditMetadata(
  p: ReviewProgress,
  openedAtMs: number,
  nowMs: number,
): Record<string, unknown> {
  return {
    preview_seconds: Math.max(0, Math.round((nowMs - openedAtMs) / 1000)),
    max_scroll_pct: p.maxScrollPct,
    scrolled_to_end: p.scrolledToEnd,
    tabs_total: p.tabs.length,
    tabs_viewed: p.tabs.filter((t) => p.viewedTabCodes.includes(t.code)).length,
    bridge: p.bridge,
    scroll_tracking: p.scrollTracking,
  }
}
