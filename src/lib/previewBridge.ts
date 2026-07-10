// Preview bridge — the window.postMessage protocol between the
// designer-side VersionPreviewGate (the "host") and the customer page
// it renders inside an iframe (/p/:id?preview=1&v=…, the "page").
//
// Why a bridge exists: the gate's job is to make the pre-send check
// real — its confirm button stays disabled until the designer has
// scrolled through the proof and looked at every material-option tab
// (finishes, species) the customer would be able to click. Scroll
// position is readable directly from the parent because the iframe is
// same-origin, but the active option tab is React state inside the
// customer page, so the page reports it up: one `context` message
// describing which tabs exist on the previewed version, then a
// `tab-viewed` ping each time a tab becomes active. In the other
// direction the host sends `show-tab` when the designer clicks a tab
// chip in the gate banner, so the chips double as navigation — the
// preview switches tab and scrolls to the plate grid. That keeps the
// coverage requirement helpful rather than punitive: the checklist is
// also the fastest way to flick through the options.
//
// Deploy-skew safety: the gate treats the bridge as advisory. If no
// `context` arrives (an older customer-page bundle still cached, or a
// future refactor drops the pings) the gate falls back to scroll-only
// after a timeout — a missing message must never lock a designer out.
// See VersionPreviewGate.tsx.
//
// Security posture: both listeners check `event.origin` against their
// own origin before parsing (gate and page are the same app), the page
// only participates when genuinely embedded in a same-app preview
// (isEmbeddedPreview), and every outbound post pins targetOrigin to
// window.location.origin so nothing is delivered to a foreign
// embedder. The shape validators are deliberately strict — unknown
// source tags, kinds, or field types return null and the message is
// dropped.

import type { PublicMaterialOption, PublicProofVersion } from './types'

// Source tags identify bridge traffic among other postMessage noise
// (browser extensions are the usual culprits).
export const PREVIEW_PAGE_SOURCE = 'plasma-preview-page'
export const PREVIEW_HOST_SOURCE = 'plasma-preview-host'

export interface PreviewTabInfo {
  code: string
  label: string
}

export type PreviewPageMessage =
  | {
      source: typeof PREVIEW_PAGE_SOURCE
      kind: 'context'
      versionId: string
      tabs: PreviewTabInfo[]
    }
  | {
      source: typeof PREVIEW_PAGE_SOURCE
      kind: 'tab-viewed'
      versionId: string
      code: string
    }

export interface PreviewHostMessage {
  source: typeof PREVIEW_HOST_SOURCE
  kind: 'show-tab'
  versionId: string
  code: string
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null
}

function isTabInfo(x: unknown): x is PreviewTabInfo {
  return isRecord(x) && typeof x.code === 'string' && typeof x.label === 'string'
}

// Shape validation for page→host traffic. Pure on the data payload —
// callers do the event.origin check themselves, which keeps these
// testable outside a browser.
export function asPreviewPageMessage(data: unknown): PreviewPageMessage | null {
  if (!isRecord(data) || data.source !== PREVIEW_PAGE_SOURCE) return null
  if (typeof data.versionId !== 'string') return null
  if (data.kind === 'context') {
    if (!Array.isArray(data.tabs) || !data.tabs.every(isTabInfo)) return null
    return {
      source: PREVIEW_PAGE_SOURCE,
      kind: 'context',
      versionId: data.versionId,
      tabs: data.tabs.map((t) => ({ code: t.code, label: t.label })),
    }
  }
  if (data.kind === 'tab-viewed') {
    if (typeof data.code !== 'string') return null
    return {
      source: PREVIEW_PAGE_SOURCE,
      kind: 'tab-viewed',
      versionId: data.versionId,
      code: data.code,
    }
  }
  return null
}

// Shape validation for host→page traffic.
export function asPreviewHostMessage(data: unknown): PreviewHostMessage | null {
  if (!isRecord(data) || data.source !== PREVIEW_HOST_SOURCE) return null
  if (data.kind !== 'show-tab') return null
  if (typeof data.versionId !== 'string' || typeof data.code !== 'string') return null
  return {
    source: PREVIEW_HOST_SOURCE,
    kind: 'show-tab',
    versionId: data.versionId,
    code: data.code,
  }
}

// Which option tabs does the customer page actually render for this
// version? Mirrors the render branching in CustomerProofPage exactly:
// variant rounds use the stacked comparison grid (no tabs — and
// material_options is empty on them by design), Set (collection)
// renders one stacked section per layout (no tabs), and the standard
// branch only shows the MaterialOptionTabs strip when the version has
// 2+ options. Everything on a tabless version is reachable by
// scrolling, so the gate's scroll requirement covers it and this
// returns []. Keeping the mirror exact matters: advertising a tab the
// page doesn't render would leave the gate waiting on a ping that can
// never arrive.
export function previewTabsForVersion(
  version: Pick<
    PublicProofVersion,
    'is_variant_round' | 'shape' | 'material_id' | 'material_options'
  >,
  options: ReadonlyArray<Pick<PublicMaterialOption, 'material_id' | 'code' | 'display_name'>>,
): PreviewTabInfo[] {
  if (version.is_variant_round) return []
  if (version.shape === 'set_collection') return []
  const codes = version.material_options ?? []
  if (codes.length < 2) return []
  return codes.map((code) => ({
    code,
    label:
      options.find((o) => o.material_id === version.material_id && o.code === code)
        ?.display_name ?? code,
  }))
}

// True only when this window is the customer page rendered inside the
// designer preview gate: the ?preview=1 flag is present AND we're in
// an iframe. The flag alone isn't enough — "Preview as customer"
// opens the same URL in a full tab, where there's no host to talk to.
export function isEmbeddedPreview(): boolean {
  try {
    return (
      window.parent !== window &&
      new URLSearchParams(window.location.search).get('preview') === '1'
    )
  } catch {
    return false
  }
}

function postToParent(payload: PreviewPageMessage): void {
  try {
    window.parent.postMessage(payload, window.location.origin)
  } catch {
    // Best-effort chrome — a hostile or odd embedder can make
    // postMessage throw, and the bridge is never worth breaking the
    // customer page over.
  }
}

export function postPreviewContext(versionId: string, tabs: PreviewTabInfo[]): void {
  postToParent({ source: PREVIEW_PAGE_SOURCE, kind: 'context', versionId, tabs })
}

export function postPreviewTabViewed(versionId: string, code: string): void {
  postToParent({ source: PREVIEW_PAGE_SOURCE, kind: 'tab-viewed', versionId, code })
}

export function postShowTab(
  target: Window | null | undefined,
  versionId: string,
  code: string,
): void {
  try {
    target?.postMessage(
      {
        source: PREVIEW_HOST_SOURCE,
        kind: 'show-tab',
        versionId,
        code,
      } satisfies PreviewHostMessage,
      window.location.origin,
    )
  } catch {
    // Same best-effort stance as postToParent.
  }
}
