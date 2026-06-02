import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, Send } from 'lucide-react'
import type { GridImage } from './ImageGrid'
import { ButtonCoral } from '../design'

export type ProofDetailViewProps = {
  // Navigable set — typically the clicked image's group (front +
  // back of one recipient's card, or both directions of one variant
  // round card). Chevron navigation is scoped to this set only.
  images: GridImage[]
  // Index inside `images` of the image the customer clicked.
  initialIndex: number
  // What to print above the side / n-of-m caption. Examples:
  // "Alec", "Shared", "Direction A — Bold". Null when no recipient /
  // variant context applies (rare; rendered as side-only).
  displayLabel: string | null
  // Closes the detail view and returns to the overview. Also bound
  // to the "Both sides" top-left close affordance, Escape, and a
  // backdrop click.
  close: () => void
  // Opens the request-changes panel for the current image's
  // recipient (parent picks openActionPanel vs openVariantActionPanel
  // depending on the call site).
  onRequestChanges: () => void
  // Hide the in-view "Request changes" CTA when a panel is already
  // docked — the customer is already in the flow and doesn't need a
  // second entry point inside the detail view.
  hideRequestChanges: boolean
  // When the request-changes panel is open, inset the detail view so
  // it doesn't cover the panel: stops short of the docked panel on
  // desktop (sm:right-[400px]) and leaves room above the bottom
  // sheet on mobile (bottom-[50vh]).
  panelOpen: boolean
  // Phase 3 — reports the side of the currently-visible image to
  // the parent so a subsequent change-request submit can record
  // which face the customer was looking at. Fires on mount and
  // whenever the index changes. Null when the current image has
  // no `side` value (legacy / shared / single-image groups).
  onCurrentSideChange?: (side: 'front' | 'back' | null) => void
}

// Non-modal, light-register replacement for the previous dark
// fullscreen lightbox. Coexists with the request-changes panel:
// when `panelOpen` is true the detail view insets so it doesn't
// cover the panel, letting the customer zoom in on the proof and
// describe a change at the same time. z-index sits below the panel
// (z-40) and the approve modal (z-50) so both win when stacked.
//
// The chrome (Both sides, caption, Request changes) floats
// absolutely over the proof so the image region claims every
// available pixel of the detail-view area.
export function ProofDetailView({
  images,
  initialIndex,
  displayLabel,
  close,
  onRequestChanges,
  hideRequestChanges,
  panelOpen,
  onCurrentSideChange,
}: ProofDetailViewProps) {
  // Index is local — opening a new detail view re-mounts the
  // component (different key in the parent), so the seed always wins.
  const [index, setIndex] = useState(() =>
    Math.min(Math.max(initialIndex, 0), Math.max(images.length - 1, 0)),
  )
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)

  // ── Pinch / double-tap zoom + pan ────────────────────────────────
  // The proof image is the whole point of this view, so the customer
  // needs to inspect it closely (kerning, registration, edge gilding).
  // We can't lean on the browser's native pinch-zoom because the
  // app-wide viewport meta pins `maximum-scale=1` (added to stop iOS
  // Safari auto-zooming form fields on the quote compiler), which iOS
  // honours and so disables page pinch everywhere. So we implement
  // zoom locally on the image via Pointer Events: two-finger pinch,
  // double-tap to toggle, and one-finger pan once zoomed in. `scale`
  // drives a CSS transform; translate (tx/ty) keeps the focal point
  // under the fingers and is clamped so the image can't be dragged
  // entirely out of view.
  const MIN_SCALE = 1
  const MAX_SCALE = 4
  const [scale, setScale] = useState(1)
  const [tx, setTx] = useState(0)
  const [ty, setTy] = useState(0)
  // Live mirrors so the pointer handlers always read the latest
  // transform without re-subscribing on every render.
  const scaleRef = useRef(1)
  scaleRef.current = scale
  const txRef = useRef(0)
  txRef.current = tx
  const tyRef = useRef(0)
  tyRef.current = ty
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  // Active pointers (one entry per finger / the mouse), the in-flight
  // pinch + pan baselines, a per-gesture "did it move / pinch" flag
  // (so a clean tap can be distinguished for double-tap), and the
  // last clean tap for double-tap detection.
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map())
  const pinchRef = useRef<{ startDist: number; startScale: number } | null>(null)
  const panRef = useRef<{ x: number; y: number } | null>(null)
  const gestureRef = useRef<{ moved: boolean; pinched: boolean }>({
    moved: false,
    pinched: false,
  })
  const lastTapRef = useRef<{ t: number; x: number; y: number } | null>(null)
  // True whenever there's no finger down — used to enable a short
  // transition (so double-tap zoom eases) while keeping live gestures
  // snappy with no transition lag.
  const [idle, setIdle] = useState(true)

  const current = images[index]
  const total = images.length
  const canStep = total > 1
  const isZoomed = scale > MIN_SCALE

  const sideLabel = (current?.label ?? '').trim()
  const captionPieces = [
    displayLabel?.toUpperCase() ?? null,
    sideLabel ? sideLabel.toUpperCase() : null,
    canStep ? `${index + 1} / ${total}` : null,
  ].filter(Boolean) as string[]
  const altText =
    [displayLabel, sideLabel].filter(Boolean).join(' · ') || 'Proof image'

  // Move focus into the dialog on mount so a Tab on the keyboard
  // user's first keystroke lands inside the detail view rather than
  // somewhere on the page behind it. requestAnimationFrame defers
  // until the dialog DOM has actually mounted. No focus trap: the
  // detail view is deliberately non-modal so the page behind stays
  // tab-reachable (and so does the request-changes panel when both
  // are open).
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      closeButtonRef.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [])

  // Phase 3 — report the visible side to the parent so a subsequent
  // change-request submit can stamp proof_events.side. Fires on
  // mount with the initial side and again every time the customer
  // steps via chevron / arrow key. images is stable per mount
  // (parent re-keys on group change), so depending on `index` alone
  // is correct.
  useEffect(() => {
    onCurrentSideChange?.(images[index]?.side ?? null)
  }, [index, images, onCurrentSideChange])

  // Escape + arrow-key navigation. Bound on document so we hear
  // keys regardless of where focus currently sits (e.g. on the
  // image, on a chevron). Capture phase + stopImmediatePropagation
  // on Escape so that when the request-changes panel is also open
  // (which has its own Escape→close handler), Escape closes only
  // the detail view in front and leaves the customer's in-progress
  // comment intact in the panel behind.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation()
        close()
        return
      }
      // Don't hijack arrow keys when the customer is typing in the
      // request-changes panel's name or comment field — moving the
      // text cursor must keep working. Escape is handled above so
      // the close affordance still fires from anywhere.
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if (!canStep) return
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault()
        setIndex((i) => (i - 1 + total) % total)
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault()
        setIndex((i) => (i + 1) % total)
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [canStep, total, close])

  function step(direction: 1 | -1) {
    setIndex((i) => (i + direction + total) % total)
  }

  // Reset the zoom whenever the visible image changes (chevron / arrow
  // / swipe handled by the parent re-key never applies here, but the
  // local index does). Starting each image at 1:1 matches the
  // overview the customer just came from.
  useEffect(() => {
    setScale(1)
    setTx(0)
    setTy(0)
  }, [index])

  function distance(
    a: { x: number; y: number },
    b: { x: number; y: number },
  ): number {
    return Math.hypot(a.x - b.x, a.y - b.y)
  }

  // Clamp a proposed translation so the (scaled) image can't be panned
  // past the point where its edge crosses the viewport centre — i.e.
  // it can move only as far as there's overflow to reveal. baseW/baseH
  // are the image's rendered size at scale 1, recovered from the live
  // (currently-transformed) rect by dividing out the committed scale.
  function clampTranslate(
    nx: number,
    ny: number,
    s: number,
  ): { x: number; y: number } {
    const img = imgRef.current
    const vp = viewportRef.current
    if (!img || !vp) return { x: nx, y: ny }
    const vr = vp.getBoundingClientRect()
    const ir = img.getBoundingClientRect()
    const baseW = ir.width / scaleRef.current
    const baseH = ir.height / scaleRef.current
    const maxX = Math.max(0, (baseW * s - vr.width) / 2)
    const maxY = Math.max(0, (baseH * s - vr.height) / 2)
    return {
      x: Math.min(maxX, Math.max(-maxX, nx)),
      y: Math.min(maxY, Math.max(-maxY, ny)),
    }
  }

  // Apply a new scale while keeping the screen point (fx, fy) pinned
  // under the fingers / tap. With transform-origin at the image
  // centre, the on-screen position of a local point d (offset from
  // centre) is centre + translate + scale·d, so holding (fx,fy) fixed
  // across s0→s1 gives t1 = t0 − (s1−s0)·d, where d = (focal −
  // currentCentre) / s0. Dropping back to 1:1 recentres to (0,0).
  function applyScaleAround(rawScale: number, fx: number, fy: number) {
    const img = imgRef.current
    if (!img) return
    const s0 = scaleRef.current
    const s1 = Math.min(MAX_SCALE, Math.max(MIN_SCALE, rawScale))
    if (s1 === s0) return
    const ir = img.getBoundingClientRect()
    const cx = ir.left + ir.width / 2
    const cy = ir.top + ir.height / 2
    const dx = (fx - cx) / s0
    const dy = (fy - cy) / s0
    let nt = { x: txRef.current - (s1 - s0) * dx, y: tyRef.current - (s1 - s0) * dy }
    if (s1 === MIN_SCALE) nt = { x: 0, y: 0 }
    const clamped = clampTranslate(nt.x, nt.y, s1)
    setScale(s1)
    setTx(clamped.x)
    setTy(clamped.y)
  }

  function onPointerDown(e: React.PointerEvent<HTMLImageElement>) {
    e.currentTarget.setPointerCapture?.(e.pointerId)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    gestureRef.current.moved = false
    setIdle(false)
    if (pointers.current.size === 2) {
      const pts = [...pointers.current.values()]
      pinchRef.current = {
        startDist: distance(pts[0], pts[1]) || 1,
        startScale: scaleRef.current,
      }
      gestureRef.current.pinched = true
      panRef.current = null
    } else if (pointers.current.size === 1) {
      panRef.current = { x: e.clientX, y: e.clientY }
    }
  }

  function onPointerMove(e: React.PointerEvent<HTMLImageElement>) {
    if (!pointers.current.has(e.pointerId)) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size >= 2 && pinchRef.current) {
      const pts = [...pointers.current.values()]
      const d = distance(pts[0], pts[1])
      const mid = {
        x: (pts[0].x + pts[1].x) / 2,
        y: (pts[0].y + pts[1].y) / 2,
      }
      gestureRef.current.moved = true
      applyScaleAround(
        pinchRef.current.startScale * (d / pinchRef.current.startDist),
        mid.x,
        mid.y,
      )
    } else if (pointers.current.size === 1 && panRef.current) {
      const dx = e.clientX - panRef.current.x
      const dy = e.clientY - panRef.current.y
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) gestureRef.current.moved = true
      // Pan only matters once zoomed in; at 1:1 a one-finger drag is a
      // no-op (we don't repurpose it for swipe-to-navigate here).
      if (scaleRef.current > MIN_SCALE) {
        panRef.current = { x: e.clientX, y: e.clientY }
        const clamped = clampTranslate(txRef.current + dx, tyRef.current + dy, scaleRef.current)
        setTx(clamped.x)
        setTy(clamped.y)
      }
    }
  }

  function releasePointer(e: React.PointerEvent<HTMLImageElement>, tappable: boolean) {
    const had = pointers.current.has(e.pointerId)
    pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) pinchRef.current = null
    if (pointers.current.size === 1) {
      // A finger lifted out of a pinch — hand panning to the survivor
      // so the image doesn't jump on the next move.
      const survivor = [...pointers.current.values()][0]
      panRef.current = { x: survivor.x, y: survivor.y }
    }
    if (pointers.current.size === 0) {
      panRef.current = null
      setIdle(true)
      // Double-tap toggles between fit and 2.5× around the tap point.
      // Only a clean single-pointer tap (no drag, no pinch) qualifies.
      if (tappable && had && !gestureRef.current.moved && !gestureRef.current.pinched) {
        const now = Date.now()
        const lt = lastTapRef.current
        if (lt && now - lt.t < 300 && Math.hypot(e.clientX - lt.x, e.clientY - lt.y) < 30) {
          applyScaleAround(scaleRef.current > MIN_SCALE ? MIN_SCALE : 2.5, e.clientX, e.clientY)
          lastTapRef.current = null
        } else {
          lastTapRef.current = { t: now, x: e.clientX, y: e.clientY }
        }
      }
      gestureRef.current.pinched = false
    }
  }

  return (
    <div
      role="dialog"
      aria-label={altText ? `Proof detail — ${altText}` : 'Proof detail'}
      className={[
        'fixed z-30 text-ink',
        // Panel-aware inset via positional constraints rather than
        // padding. Padding would shrink the *content* area, but
        // absolutely-positioned chrome (the Both sides, caption,
        // and CTA below) would still anchor to the screen edges —
        // a caption at bottom-4 would sit behind the docked panel.
        // Positional inset shrinks the whole box, so absolute
        // children land relative to the visible detail-view area.
        panelOpen
          ? 'inset-x-0 top-0 bottom-[50vh] sm:bottom-0 sm:right-[400px]'
          : 'inset-0',
        // Subtle fade in for the overlay itself; the image
        // settles in with the parent transition.
        'motion-safe:animate-[pdv-in_140ms_ease-out]',
      ].join(' ')}
      // Near-opaque cream scrim — light, not dark. ~96% opacity so
      // a hint of the page below shows through and the detail view
      // reads as an overlay rather than as navigation. The customer
      // page background is also canvas-cream, so the visible
      // difference is mostly the dimming of any non-cream sections
      // that were on screen.
      style={{ background: 'color-mix(in srgb, var(--c-bg) 96%, transparent)' }}
    >
      <style>{`
        @keyframes pdv-in {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
      `}</style>

      {/* Image region: fills the full detail-view area. Self-click
          closes the detail view — the empty letterbox space around
          the object-contain image acts as the backdrop. Clicks on
          the image or chevrons fail the target===currentTarget
          check and don't close. */}
      <div
        ref={viewportRef}
        className="absolute inset-0 flex items-center justify-center"
        onClick={(e) => { if (e.target === e.currentTarget) close() }}
      >
        {canStep && (
          <button
            type="button"
            aria-label="Previous side"
            onClick={() => step(-1)}
            className="absolute left-2 top-1/2 z-10 grid h-12 w-12 -translate-y-1/2 place-items-center rounded-full bg-surface/70 border border-line text-ink transition-colors hover:bg-surface focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--c-brand)] sm:left-4 sm:h-14 sm:w-14"
            style={{ backdropFilter: 'blur(4px)' }}
          >
            <span aria-hidden="true" className="text-2xl leading-none">‹</span>
          </button>
        )}
        {current?.signed_url ? (
          <img
            ref={imgRef}
            src={current.signed_url}
            alt={altText}
            draggable={false}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={(e) => releasePointer(e, true)}
            onPointerCancel={(e) => releasePointer(e, false)}
            className="block max-h-full max-w-full rounded-[8px] object-contain bg-canvas select-none"
            style={{
              transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
              transformOrigin: 'center center',
              // We own the gestures, so stop the browser from also
              // scrolling / page-zooming when fingers land on the image.
              touchAction: 'none',
              cursor: isZoomed ? 'grab' : 'zoom-in',
              transition: idle ? 'transform 140ms ease-out' : 'none',
              willChange: 'transform',
            }}
          />
        ) : (
          <div className="h-64 w-full max-w-md rounded-[8px] bg-canvas border border-line" />
        )}
        {canStep && (
          <button
            type="button"
            aria-label="Next side"
            onClick={() => step(1)}
            className="absolute right-2 top-1/2 z-10 grid h-12 w-12 -translate-y-1/2 place-items-center rounded-full bg-surface/70 border border-line text-ink transition-colors hover:bg-surface focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--c-brand)] sm:right-4 sm:h-14 sm:w-14"
            style={{ backdropFilter: 'blur(4px)' }}
          >
            <span aria-hidden="true" className="text-2xl leading-none">›</span>
          </button>
        )}
      </div>

      {/* Close affordance — floats top-left over the proof. The semi-
          opaque surface pill keeps it legible whatever the proof
          looks like underneath. Labelled "Both sides" only when the
          group actually has more than one side to step through;
          single-side cards get a plain "Back" so the label doesn't
          promise a second side that isn't there. */}
      <button
        ref={closeButtonRef}
        type="button"
        onClick={close}
        className="absolute left-4 top-4 z-20 inline-flex min-h-[44px] items-center gap-2 rounded-full bg-surface/75 border border-line px-4 py-2 eyebrow text-ink transition-colors hover:bg-surface focus-visible:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--c-brand)] sm:left-6 sm:top-6"
        style={{ backdropFilter: 'blur(4px)', letterSpacing: '0.18em' }}
      >
        <ChevronLeft size={14} aria-hidden="true" />
        {canStep ? 'Both sides' : 'Back'}
      </button>

      {/* Bottom-centred stack: caption on top, Request changes CTA
          below it with a small gap. pointer-events-none on the
          container + caption so taps in the bottom letterbox space
          pass through to the image-region backdrop (which closes).
          The CTA opts back into pointer-events because it's
          interactive. */}
      {(captionPieces.length > 0 || !hideRequestChanges) && (
        <div
          className="pointer-events-none absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 flex-col items-center gap-3 sm:bottom-6"
          style={{ maxWidth: 'calc(100% - 32px)' }}
        >
          {captionPieces.length > 0 && (
            <p
              className="pointer-events-none rounded-full bg-surface/75 border border-line px-4 py-1.5 text-center eyebrow text-ink-soft m-0 whitespace-nowrap overflow-hidden text-ellipsis max-w-full"
              style={{ backdropFilter: 'blur(4px)' }}
            >
              {captionPieces.join(' · ')}
            </p>
          )}
          {!hideRequestChanges && (
            <div className="pointer-events-auto">
              <ButtonCoral icon={Send} onClick={onRequestChanges}>
                Request changes
              </ButtonCoral>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
