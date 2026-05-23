import { useEffect, useRef, useState } from 'react'
import type { GridImage } from './ImageGrid'
import {
  PAPER_CREAM,
  PAPER_INK,
  PAPER_SECONDARY,
  PAPER_TERTIARY,
  CTA_AMBER_BG,
  CTA_AMBER_HOVER_BG,
  CTA_AMBER_PRESSED_BG,
  CTA_AMBER_BORDER,
  CTA_AMBER_HOVER_BORDER,
  CTA_AMBER_TEXT,
  MONO,
  SANS,
} from '../lib/theme'

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
  // sheet on mobile (pb-[50vh]).
  panelOpen: boolean
  // Phase 3 — reports the side of the currently-visible image to
  // the parent so a subsequent change-request submit can record
  // which face the customer was looking at. Fires on mount and
  // whenever the index changes. Null when the current image has
  // no `side` value (legacy / shared / single-image groups).
  onCurrentSideChange?: (side: 'front' | 'back' | null) => void
}

// Non-modal, light-register replacement for the previous dark
// fullscreen lightbox (Phase 2 of the customer-page action rework).
//
// Coexists with the request-changes panel: when `panelOpen` is true
// the detail view insets so it doesn't cover the panel, letting the
// customer zoom in on the proof and describe a change at the same
// time. z-index sits below the panel (z-40) and the approve modal
// (z-50) so both win when stacked.
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
  const overlayRef = useRef<HTMLDivElement | null>(null)
  // PR #127 made the middle image region edge-to-edge so the proof
  // fills the viewport width in portrait. The caption + Request
  // changes row underneath used to carry the same horizontal padding
  // the image region had (px-4 sm:px-8) — once that padding came off
  // the image, the row's right edge no longer lined up with the
  // proof's right edge. We measure the rendered image and clamp the
  // caption + filename rows to the same width: in portrait the image
  // is viewport-wide so the row runs edge-to-edge; in landscape the
  // image is centred with side gaps and the row sits within the
  // image's bounds, with the chevron buttons (absolutely positioned
  // over the image region above) sitting beside the image in the
  // same way.
  const imageRef = useRef<HTMLElement | null>(null)
  const [imageWidth, setImageWidth] = useState<number | null>(null)

  const current = images[index]
  const total = images.length
  const canStep = total > 1

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

  // Observe the rendered image (or its fallback placeholder) and
  // track its width so the caption + filename rows below can match.
  // Re-runs when current.signed_url flips between img and fallback
  // — the DOM node imageRef points at changes, so we tear down the
  // previous observer and rebind. Reads the initial size synchronously
  // (ResizeObserver only fires on changes, not on first attach) so
  // there's no flash of unconstrained-width rows before the first
  // observer callback.
  useEffect(() => {
    const el = imageRef.current
    if (!el) {
      setImageWidth(null)
      return
    }
    const initial = el.getBoundingClientRect().width
    if (initial > 0) setImageWidth(initial)
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const w = e.contentRect.width
        if (w > 0) setImageWidth(w)
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [current?.signed_url, index])

  return (
    <div
      ref={overlayRef}
      role="dialog"
      aria-label={altText ? `Proof detail — ${altText}` : 'Proof detail'}
      className={[
        'fixed z-30 flex flex-col',
        // Default to the full viewport.
        'inset-0',
        // Panel-aware inset. Desktop: stop short of the docked
        // panel's left edge. Mobile: leave room above the bottom
        // sheet so the image centres in the visible region rather
        // than under the sheet.
        panelOpen ? 'pb-[50vh] sm:pb-0 sm:right-[400px]' : '',
        // Subtle fade in for the overlay itself; the image
        // settles in with the parent transition.
        'motion-safe:animate-[pdv-in_140ms_ease-out]',
      ].join(' ')}
      style={{
        // Near-opaque cream scrim — light, not dark. ~96% opacity
        // so a hint of the page below shows through and the
        // detail view reads as an overlay rather than as a
        // navigation. The customer page background is also
        // PAPER_CREAM, so the visible difference is mostly the
        // dimming of any non-cream sections that were on screen.
        background: 'rgba(254,253,250,0.96)',
        color: PAPER_INK,
      }}
      onClick={(e) => {
        // Backdrop click closes — but only on the backdrop itself,
        // not on bubbled clicks from the image or the controls.
        if (e.target === e.currentTarget) close()
      }}
    >
      <style>{`
        @keyframes pdv-in {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
      `}</style>

      {/* Top bar: "Both sides" close affordance (top-left). The
          spec names this control explicitly — it returns the
          customer to the overview where every plate of the proof
          is visible together. */}
      <div className="flex items-start justify-between px-4 pt-4 sm:px-8 sm:pt-6">
        <button
          ref={closeButtonRef}
          type="button"
          onClick={close}
          className="inline-flex min-h-[44px] items-center gap-2 rounded-[2px] px-4 py-2 transition-colors hover:bg-[rgba(26,22,18,0.06)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(58,44,145,0.45)]"
          style={{
            fontFamily: MONO,
            fontSize: 13,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            color: PAPER_INK,
          }}
        >
          <span aria-hidden="true">‹</span>
          Both sides
        </button>
      </div>

      {/* Middle: chevrons either side of the centred image. The
          image sits inside a flex-1 region that grows to fill
          available vertical space; max-h on the <img> caps it
          short of the visible region so the caption + Request
          changes row stay on-screen without scrolling.

          Self-click closes the detail view — the empty space
          around the image acts as the backdrop. The overlay's
          own onClick can't see these clicks (flex children
          fully cover it), so the close affordance lives here
          where the unoccupied padding sits. Clicks on the image
          and chevron buttons fail the target===currentTarget
          check and don't close. */}
      <div
        className="relative flex flex-1 min-h-0 items-center justify-center"
        onClick={(e) => { if (e.target === e.currentTarget) close() }}
      >
        {canStep && (
          <button
            type="button"
            aria-label="Previous side"
            onClick={() => step(-1)}
            className="absolute left-2 top-1/2 z-10 grid h-12 w-12 -translate-y-1/2 place-items-center rounded-full transition-colors hover:bg-[rgba(26,22,18,0.08)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(58,44,145,0.45)] sm:left-4 sm:h-14 sm:w-14"
            style={{ color: PAPER_INK, background: 'rgba(255,255,255,0.6)', border: '1px solid rgba(26,22,18,0.18)' }}
          >
            <span aria-hidden="true" className="text-2xl leading-none">‹</span>
          </button>
        )}
        {current?.signed_url ? (
          <img
            ref={(el) => { imageRef.current = el }}
            src={current.signed_url}
            alt={altText}
            className="block max-h-full max-w-full rounded-md object-contain"
            style={{ background: PAPER_CREAM }}
            onLoad={(e) => {
              // Pick up the post-load width — the ResizeObserver
              // also catches this via the natural-size-driven
              // layout change, but an explicit read here removes
              // any cross-browser race.
              const w = (e.currentTarget as HTMLImageElement).getBoundingClientRect().width
              if (w > 0) setImageWidth(w)
            }}
          />
        ) : (
          <div
            ref={(el) => { imageRef.current = el }}
            className="h-64 w-full max-w-md rounded-md"
            style={{ background: PAPER_CREAM, border: '1px solid rgba(26,22,18,0.12)' }}
          />
        )}
        {canStep && (
          <button
            type="button"
            aria-label="Next side"
            onClick={() => step(1)}
            className="absolute right-2 top-1/2 z-10 grid h-12 w-12 -translate-y-1/2 place-items-center rounded-full transition-colors hover:bg-[rgba(26,22,18,0.08)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(58,44,145,0.45)] sm:right-4 sm:h-14 sm:w-14"
            style={{ color: PAPER_INK, background: 'rgba(255,255,255,0.6)', border: '1px solid rgba(26,22,18,0.18)' }}
          >
            <span aria-hidden="true" className="text-2xl leading-none">›</span>
          </button>
        )}
      </div>

      {/* Bottom: caption row (recipient · side · n / m) + the
          amber "Request changes" CTA. The CTA is suppressed when
          a request-changes panel is already docked — the customer
          is already in the flow and a second entry point would
          read as redundant. */}
      <div
        className="mx-auto flex w-full flex-col items-center justify-between gap-3 pb-6 pt-4 sm:flex-row sm:pb-8"
        style={{ maxWidth: imageWidth ?? undefined }}
      >
        <p
          className="text-center font-paper-mono uppercase sm:text-left"
          style={{
            fontSize: 12,
            fontWeight: 500,
            letterSpacing: '0.22em',
            color: PAPER_SECONDARY,
          }}
        >
          {captionPieces.length > 0 ? captionPieces.join(' · ') : ' '}
        </p>
        {!hideRequestChanges && (
          <button
            type="button"
            onClick={onRequestChanges}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = CTA_AMBER_HOVER_BG
              e.currentTarget.style.borderColor = CTA_AMBER_HOVER_BORDER
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = CTA_AMBER_BG
              e.currentTarget.style.borderColor = CTA_AMBER_BORDER
            }}
            onMouseDown={(e) => {
              e.currentTarget.style.background = CTA_AMBER_PRESSED_BG
            }}
            onMouseUp={(e) => {
              e.currentTarget.style.background = CTA_AMBER_HOVER_BG
            }}
            className="inline-flex min-h-[44px] items-center justify-center rounded-[2px] px-6 py-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(58,44,145,0.45)]"
            style={{
              background: CTA_AMBER_BG,
              border: `1.5px solid ${CTA_AMBER_BORDER}`,
              color: CTA_AMBER_TEXT,
              fontFamily: MONO,
              fontSize: 13,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
            }}
          >
            Request changes
          </button>
        )}
      </div>

      {/* Filename + tertiary hint sits quietly below. Width-matched
          to the proof image above (same maxWidth treatment as the
          caption row) so it stays inside the proof's bounds rather
          than running edge-to-edge in landscape. */}
      {current?.original_filename && (
        <p
          className="pointer-events-none mx-auto w-full pb-3 text-center"
          style={{
            fontFamily: SANS,
            fontSize: 12,
            color: PAPER_TERTIARY,
            maxWidth: imageWidth ?? undefined,
          }}
        >
          {current.original_filename}
        </p>
      )}
    </div>
  )
}
