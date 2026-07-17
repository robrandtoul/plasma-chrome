// TEMPORARY on-device diagnostics for the iOS PWA keyboard/viewport saga
// (PRs #483–#489). Two jobs:
//
// 1. A tiny event log + live-value feed that ViewportDebugOverlay renders on
//    the phone, so we can SEE what window.innerHeight / visualViewport /
//    scroll positions / the app frame's inline styles actually do during the
//    tap → keyboard → dismiss cycle. Desktop browsers and Playwright cannot
//    reproduce any of this, so the overlay is the only instrument we have.
//
// 2. A "glue mode" switch so one Netlify preview can A/B the viewport-glue
//    behaviour without a rebuild:
//      main — exactly what main does today (the current, broken behaviour)
//      off  — no viewport JS at all: pure CSS h-dvh frame, no listeners
//      blur — hands-off while a field is focused; restore only on blur
//
// Enabling: on *.netlify.app hosts (deploy previews) the overlay is ON by
// default — the URL param can't survive Add-to-Home-Screen (manifest
// start_url is "/"), and the installed standalone app has no URL bar to type
// into. Anywhere else it's off unless ?debug=1 was visited once (persisted in
// localStorage; ?debug=0 turns it back off). Mode switching happens via the
// overlay's own buttons (persist + reload) or ?glue=main|off|blur.
//
// This whole module is throwaway: once the fix is confirmed on-device it gets
// removed or permanently gated.

export type GlueMode = 'main' | 'off' | 'blur'

const DEBUG_KEY = 'pv:vp-debug'
const MODE_KEY = 'pv:glue-mode'

export interface VpLogEntry {
  /** ms since page load (performance.now at record time) */
  t: number
  event: string
  detail: string
  /** how many consecutive occurrences this entry represents (coalesced) */
  n: number
}

const MAX_ENTRIES = 400

// High-frequency observation events (a pan drag fires vv-scroll ~60Hz) are
// coalesced into their predecessor when consecutive, so a scroll storm can't
// evict the causally interesting entries (focusin, height-write, …) out of
// the ring buffer before the tester taps "copy".
const COALESCE = new Set(['vv-scroll', 'vv-resize', 'win-resize'])

let initialised = false
let debugOn = false
let mode: GlueMode = 'main'
const entries: VpLogEntry[] = []
const listeners = new Set<() => void>()

function init() {
  if (initialised) return
  initialised = true
  try {
    const params = new URLSearchParams(window.location.search)
    const debugParam = params.get('debug')
    if (debugParam === '1') localStorage.setItem(DEBUG_KEY, '1')
    if (debugParam === '0') localStorage.setItem(DEBUG_KEY, '0')
    const glueParam = params.get('glue')
    if (glueParam === 'main' || glueParam === 'off' || glueParam === 'blur') {
      localStorage.setItem(MODE_KEY, glueParam)
    }

    const stored = localStorage.getItem(DEBUG_KEY)
    if (stored === '1') debugOn = true
    else if (stored === '0') debugOn = false
    else debugOn = window.location.hostname.endsWith('.netlify.app')

    const storedMode = localStorage.getItem(MODE_KEY)
    if (storedMode === 'main' || storedMode === 'off' || storedMode === 'blur') {
      mode = storedMode
    }
  } catch {
    // localStorage unavailable — leave defaults (debug off, mode main)
  }
}

export function viewportDebugEnabled(): boolean {
  init()
  return debugOn
}

/**
 * Read once per mount; switching modes goes through setGlueMode → reload.
 * The experimental modes are honoured ONLY while the debug overlay is
 * enabled — production (or anywhere debug is off) always runs 'main', so a
 * stray persisted ?glue=off can never silently disable the viewport glue
 * for a real user.
 */
export function glueMode(): GlueMode {
  init()
  return debugOn ? mode : 'main'
}

/**
 * Eager URL-param capture, called from main.tsx before the router mounts.
 * Without this, a signed-out visit to ?debug=1 loses the param to
 * RequireAuth's redirect before any consumer reads it.
 */
export function initViewportDebug() {
  init()
}

export function setGlueMode(next: GlueMode) {
  try {
    localStorage.setItem(MODE_KEY, next)
  } catch {
    /* nothing to do — the reload will just re-read the old mode */
  }
  window.location.reload()
}

export function setViewportDebug(on: boolean) {
  try {
    localStorage.setItem(DEBUG_KEY, on ? '1' : '0')
  } catch {
    /* ignore */
  }
  debugOn = on
  emit()
}

/** Record an event. Cheap (array push); safe to call from hot paths. */
export function vpLog(event: string, detail = '') {
  const last = entries[entries.length - 1]
  if (last && last.event === event && COALESCE.has(event)) {
    last.t = Math.round(performance.now())
    last.detail = detail
    last.n += 1
  } else {
    entries.push({ t: Math.round(performance.now()), event, detail, n: 1 })
    if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)
  }
  emit()
}

export function getVpLogEntries(): readonly VpLogEntry[] {
  return entries
}

export function subscribeVpLog(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

function emit() {
  listeners.forEach((fn) => fn())
}

/** Short human label for a focus target, e.g. "TEXTAREA[Message the team…]". */
export function describeTarget(target: EventTarget | null): string {
  if (!(target instanceof HTMLElement)) return String(target)
  const tag = target.tagName
  const id = target.id ? `#${target.id}` : ''
  const hint =
    target.getAttribute('placeholder') ??
    target.getAttribute('aria-label') ??
    target.getAttribute('name') ??
    ''
  return `${tag}${id}${hint ? `[${hint.slice(0, 24)}]` : ''}`
}

function isEditable(el: EventTarget | null): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

// Passive observation probes, installed only while the overlay is enabled.
// These answer the questions on-device screenshots alone can't:
//
// - touchstart:            did the tap land on the element we think it did, and
//                          was the frame counter-shifted at that instant? (a
//                          shifted frame at tap time = tap lands on the wrong
//                          element / a node that's about to move)
// - kb-open / kb-never-presented: the objective "did the keyboard actually
//                          present" signal — the first visualViewport resize
//                          with a >60px height drop within 1s of focusing an
//                          editable element; its ABSENCE is the smoking gun for
//                          the no-keyboard regression.
// - focus-probe +100/+500: is the focused element STILL the active element and
//                          still attached to the DOM shortly after focus? A
//                          "no" means React remounted it — the documented
//                          implicit-blur keyboard killer.
// - js-focus()/js-blur():  tripwire on programmatic focus/blur calls — one
//                          stray .blur() mid-presentation kills the keyboard
//                          and leaves an element that LOOKS focused.
//
// Returns a cleanup that removes everything and restores the prototypes.
export function installDebugProbes(): () => void {
  if (!viewportDebugEnabled()) return () => {}
  const vv = window.visualViewport
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as { standalone?: boolean }).standalone === true
  vpLog(
    'env',
    `${standalone ? 'standalone' : 'browser-tab'} ih=${window.innerHeight} vv.h=${vv ? Math.round(vv.height) : '–'} mode=${glueMode()}`,
  )

  const frameShifted = () => {
    const frame = document.querySelector<HTMLElement>('[data-app-frame]')
    return frame?.style.transform ? ' FRAME-SHIFTED' : ''
  }
  const onTouchStart = (e: TouchEvent) => {
    vpLog('touchstart', `${describeTarget(e.target)}${frameShifted()}`)
  }

  // Keyboard-presented detector. Armed on focusin of an editable element;
  // disarmed by the first big vv height drop (kb-open) or after 1s without
  // one (kb-never-presented). The 60px threshold filters ordinary resize
  // noise from a real keyboard transition.
  let armed = false
  let baseH = 0
  let kbTimer = 0
  const onVvResizeProbe = () => {
    if (!armed || !vv) return
    const dh = baseH - vv.height
    if (dh > 60) {
      vpLog('kb-open', `Δh=${Math.round(dh)}`)
      armed = false
      window.clearTimeout(kbTimer)
    }
  }
  const focusProbeAt = (target: HTMLElement, ms: number) => {
    window.setTimeout(() => {
      const same = document.activeElement === target
      vpLog(
        `focus-probe+${ms}`,
        `active=${same ? 'same' : describeTarget(document.activeElement)} connected=${target.isConnected}`,
      )
    }, ms)
  }
  const onFocusInProbe = (e: FocusEvent) => {
    if (!isEditable(e.target)) return
    const target = e.target
    baseH = vv?.height ?? window.innerHeight
    armed = true
    window.clearTimeout(kbTimer)
    kbTimer = window.setTimeout(() => {
      if (armed) {
        vpLog('kb-never-presented', `1s after focusin, vv.h=${vv ? Math.round(vv.height) : '–'}`)
      }
      armed = false
    }, 1000)
    focusProbeAt(target, 100)
    focusProbeAt(target, 500)
  }

  // Programmatic focus()/blur() tripwire. Only patched while debugging.
  const origFocus = HTMLElement.prototype.focus
  const origBlur = HTMLElement.prototype.blur
  HTMLElement.prototype.focus = function (this: HTMLElement, ...args: [(FocusOptions | undefined)?]) {
    if (isEditable(this)) vpLog('js-focus()', describeTarget(this))
    return origFocus.apply(this, args)
  }
  HTMLElement.prototype.blur = function (this: HTMLElement) {
    if (isEditable(this)) vpLog('js-blur()', describeTarget(this))
    return origBlur.call(this)
  }

  document.addEventListener('touchstart', onTouchStart, { passive: true, capture: true })
  document.addEventListener('focusin', onFocusInProbe, true)
  vv?.addEventListener('resize', onVvResizeProbe)
  return () => {
    document.removeEventListener('touchstart', onTouchStart, true)
    document.removeEventListener('focusin', onFocusInProbe, true)
    vv?.removeEventListener('resize', onVvResizeProbe)
    window.clearTimeout(kbTimer)
    HTMLElement.prototype.focus = origFocus
    HTMLElement.prototype.blur = origBlur
  }
}
