// Popping the team chat out of the app and into a window of its own.
//
// There are two routes, because no single one works in every browser:
//
//  • Document Picture-in-Picture (Chrome / Edge) opens a small window that
//    floats ABOVE other applications — the one that actually earns the word
//    "floating". It MOVES the existing panel into that window rather than
//    starting a second copy of the app, so it stays one React tree on one
//    realtime connection: one unread count, one set of sounds, nothing to keep
//    in step.
//  • A plain second browser window (Safari, Firefox) loads /chat?popout=1.
//    That IS a second copy of the app with its own connection, so the two
//    windows have to agree about what has been read and which of them is
//    allowed to make a noise. The broadcast channel below is what settles it.
//
// This module is deliberately React-free so the rules can be tested directly.

export const POPOUT_PARAM = 'popout'

/**
 * The popout's URL, built from the host's own chat route.
 *
 * It is per-app rather than a constant because each app owns where its chat
 * page lives; opening `/chat` in an app that mounts it elsewhere would pop out
 * a 404.
 */
export function popoutPath(fullPagePath: string): string {
  const sep = fullPagePath.includes('?') ? '&' : '?'
  return `${fullPagePath}${sep}${POPOUT_PARAM}=1`
}

/**
 * A named window, so pressing "Pop out" twice focuses the one that exists
 * instead of opening a second.
 *
 * ⚠ Window names are keyed per BROWSER, not per origin, and the four staff
 * apps share one SSO session. A constant here would mean pressing "Pop out"
 * in Stock re-uses and navigates the window Proofs already had open, which is
 * why the name is derived from the app's own storage prefix.
 */
export function popoutWindowName(prefix: string): string {
  return `${prefix}-popout`
}

// Per-window, not per-browser: sessionStorage is scoped to the tab, which is
// exactly the question being asked — "am *I* the popped-out window?"
export function popoutSessionKey(prefix: string): string {
  return `${prefix}-is-popout`
}

export function popoutSizeKey(prefix: string): string {
  return `${prefix}-popout-size`
}

/**
 * The same-origin channel that keeps an app's OWN windows in step: a second
 * tab, and the popped-out window.
 *
 * ⚠ It is origin-scoped, so it stops at the app boundary and can never carry
 * anything to another of the four apps. Cross-app agreement rides the shared
 * Supabase realtime topic instead (see the 'seen' broadcast in store.tsx);
 * this one exists for the popout handshake and single-window sound
 * ownership, both of which are genuinely local questions.
 */
export function syncChannelName(prefix: string): string {
  return `${prefix}-sync`
}
// The popped-out window says "still here" on this beat; every other window
// treats a lapse longer than POPOUT_ALIVE_MS as "it has gone". A heartbeat
// rather than a farewell message because a force-quit sends no farewell.
export const POPOUT_HEARTBEAT_MS = 2000
export const POPOUT_ALIVE_MS = 6000

export type ChatSyncMessage =
  /** Someone read a thread in another window — clear it here too. */
  | { kind: 'seen'; thread: string; at: string }
  /** The popped-out window announcing itself (on open, then on every beat). */
  | { kind: 'popout-alive' }
  /** The popped-out window closing tidily. */
  | { kind: 'popout-closed' }
  /** "Bring chat back" pressed in the app — asks the popout to close itself.
   *  Needed because a reload of the main window loses its handle on the popout
   *  but not its ability to talk to it. */
  | { kind: 'popout-close-request' }

export const DEFAULT_POPOUT_SIZE = { w: 420, h: 620 }
export const MIN_POPOUT_W = 300
export const MIN_POPOUT_H = 320

export function clampPopoutSize(size: { w: number; h: number }): { w: number; h: number } {
  return {
    w: Math.max(MIN_POPOUT_W, Math.round(size.w)),
    h: Math.max(MIN_POPOUT_H, Math.round(size.h)),
  }
}

/** Whether a location's query string marks this window as the popout. */
export function isPopoutSearch(search: string): boolean {
  try {
    return new URLSearchParams(search).get(POPOUT_PARAM) === '1'
  } catch {
    return false
  }
}

/**
 * A popout stays a popout for the life of its window, even after it navigates
 * somewhere that drops the query string — so the answer is recorded once, in
 * tab-scoped storage, rather than re-read from the URL each time.
 */
export function isPopoutWindow(prefix: string): boolean {
  if (typeof window === 'undefined') return false
  try {
    if (isPopoutSearch(window.location.search)) {
      sessionStorage.setItem(popoutSessionKey(prefix), '1')
      return true
    }
    return sessionStorage.getItem(popoutSessionKey(prefix)) === '1'
  } catch {
    // sessionStorage unavailable (private mode, embedded contexts) — fall back
    // to the URL, which is right until this window navigates.
    return isPopoutSearch(window.location.search)
  }
}

/** Has the popped-out window been heard from recently enough to still count? */
export function popoutIsAlive(lastBeatAt: number, now: number): boolean {
  if (!lastBeatAt) return false
  return now - lastBeatAt < POPOUT_ALIVE_MS
}

/**
 * The stored popout size, or null when this browser has never saved one.
 * Distinguishing "never set" from "set to the default" is what lets the store
 * publish a pre-existing local size up to the profile without every app racing
 * to write the same default over each other.
 */
export function readStoredPopoutSize(prefix: string): { w: number; h: number } | null {
  try {
    const raw = localStorage.getItem(popoutSizeKey(prefix))
    if (!raw) return null
    const p = JSON.parse(raw) as { w?: unknown; h?: unknown }
    if (typeof p.w === 'number' && typeof p.h === 'number') return clampPopoutSize({ w: p.w, h: p.h })
  } catch {
    /* ignore */
  }
  return null
}

export function readPopoutSize(prefix: string): { w: number; h: number } {
  try {
    const raw = localStorage.getItem(popoutSizeKey(prefix))
    if (raw) {
      const p = JSON.parse(raw) as { w?: unknown; h?: unknown }
      if (typeof p.w === 'number' && typeof p.h === 'number') return clampPopoutSize({ w: p.w, h: p.h })
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_POPOUT_SIZE
}

export function writePopoutSize(prefix: string, size: { w: number; h: number }) {
  // A window reports 0×0 while it is closing in some browsers; saving that
  // would leave the next popout at the minimum size for no reason.
  if (!size.w || !size.h) return
  try {
    localStorage.setItem(popoutSizeKey(prefix), JSON.stringify(clampPopoutSize(size)))
  } catch {
    /* ignore */
  }
}

/**
 * window.open features for the fallback route: a chrome-light window parked
 * just inside the right-hand edge of `anchor` — the app window's own position
 * and width — so the popout lands beside the app, on whichever screen the app
 * happens to be on, rather than always on the primary monitor.
 */
export function windowFeatures(
  size: { w: number; h: number },
  anchor: { x: number; y: number; width: number } = { x: 0, y: 0, width: 0 },
): string {
  const { w, h } = clampPopoutSize(size)
  const left = Math.max(0, Math.round(anchor.x + anchor.width - w - 40))
  const top = Math.max(0, Math.round(anchor.y + 80))
  return `popup=yes,width=${w},height=${h},left=${left},top=${top}`
}

export function supportsDocumentPip(): boolean {
  return typeof window !== 'undefined' && !!window.documentPictureInPicture
}

/**
 * A picture-in-picture window starts as a blank document with none of the
 * app's styles, so copy them across. Links are re-linked by absolute URL
 * (their relative font/image URLs would otherwise resolve against the new
 * window's about:blank base); inline <style> blocks — which is how Vite serves
 * CSS in development — are copied verbatim.
 */
export function preparePopoutDocument(win: Window) {
  const doc = win.document
  doc.title = 'Team chat'
  for (const node of Array.from(document.querySelectorAll('style, link[rel="stylesheet"]'))) {
    if (node instanceof HTMLLinkElement) {
      const link = doc.createElement('link')
      link.rel = 'stylesheet'
      link.href = node.href
      if (node.media) link.media = node.media
      doc.head.appendChild(link)
    } else if (node instanceof HTMLStyleElement) {
      const style = doc.createElement('style')
      style.textContent = node.textContent
      doc.head.appendChild(style)
    }
  }
  // The panel fills the window and scrolls internally; the document itself
  // must not scroll or the composer drifts off the bottom edge.
  doc.documentElement.style.height = '100%'
  doc.body.style.margin = '0'
  doc.body.style.height = '100%'
  doc.body.style.overflow = 'hidden'
}

declare global {
  interface DocumentPictureInPictureOptions {
    width?: number
    height?: number
    disallowReturnToOpener?: boolean
    preferInitialWindowPlacement?: boolean
  }
  interface DocumentPictureInPicture extends EventTarget {
    requestWindow(options?: DocumentPictureInPictureOptions): Promise<Window>
    readonly window: Window | null
  }
  interface Window {
    documentPictureInPicture?: DocumentPictureInPicture
  }
}
