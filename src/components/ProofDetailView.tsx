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
            src={current.signed_url}
            alt={altText}
            className="block max-h-full max-w-full rounded-[8px] object-contain bg-canvas"
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

      {/* "Both sides" — floats top-left over the proof. The semi-
          opaque surface pill keeps it legible whatever the proof
          looks like underneath. */}
      <button
        ref={closeButtonRef}
        type="button"
        onClick={close}
        className="absolute left-4 top-4 z-20 inline-flex min-h-[44px] items-center gap-2 rounded-full bg-surface/75 border border-line px-4 py-2 eyebrow text-ink transition-colors hover:bg-surface focus-visible:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--c-brand)] sm:left-6 sm:top-6"
        style={{ backdropFilter: 'blur(4px)', letterSpacing: '0.18em' }}
      >
        <ChevronLeft size={14} aria-hidden="true" />
        Both sides
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
