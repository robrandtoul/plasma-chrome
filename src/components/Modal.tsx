import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

// ── Body scroll lock counter ─────────────────────────────────────────────────
//
// Module-level counter so two stacked modals don't fight each other over
// `document.body.style.overflow`. The first opener captures the previous
// value; the last closer restores it. Without the counter, the inner modal
// would record `overflow: hidden` as the "previous" value and leave the
// body locked after both close. Same pattern Radix / react-aria use.
let scrollLockCount = 0
let scrollLockPrevious = ''
function lockBodyScroll() {
  if (scrollLockCount === 0) {
    scrollLockPrevious = document.body.style.overflow
    document.body.style.overflow = 'hidden'
  }
  scrollLockCount += 1
}
function unlockBodyScroll() {
  scrollLockCount = Math.max(0, scrollLockCount - 1)
  if (scrollLockCount === 0) {
    document.body.style.overflow = scrollLockPrevious
  }
}

// ── Focusable-element selector ───────────────────────────────────────────────

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

// ── Modal primitive ──────────────────────────────────────────────────────────
//
// Backdrop + panel + the four behaviours every dialog in the app should
// have but a half-dozen ad-hoc copies got wrong:
//
//   1. Esc closes (capture-phase, beats other handlers).
//   2. Tab cycles focus inside the panel; Shift-Tab goes the other way.
//   3. Body scroll is locked while open (counter-aware so stacked modals
//      don't double-restore).
//   4. Focus returns to whatever element was active before the modal
//      opened (typically the trigger button).
//
// Caller renders the panel content as `children`. Modal styles a default
// card (max-w-md, padding, rounded, shadow) but `panelClassName` overrides
// for variants — wider read-only viewers, full-screen forms, etc.
//
// `preventClose` blocks Esc + backdrop click but does NOT auto-disable any
// children. Caller is still responsible for marking buttons disabled while
// an in-flight operation is running.
//
// Accessibility:
//   * The panel has role="dialog" + aria-modal="true". Caller MUST supply
//     either `ariaLabelledBy` (id of a heading rendered inside children)
//     or `ariaLabel` (plain string) so screen readers have something to
//     announce.
//   * `ariaDescribedBy` is optional and points at a descriptive element
//     (e.g. the confirm message paragraph).

interface ModalProps {
  open: boolean
  onClose: () => void
  /**
   * When true, Esc and backdrop click are no-ops. Use during in-flight
   * operations to stop the user accidentally cancelling something they
   * already committed to.
   */
  preventClose?: boolean
  /** id of a heading rendered inside children. Required if ariaLabel is omitted. */
  ariaLabelledBy?: string
  /** Plain string label. Required if ariaLabelledBy is omitted. */
  ariaLabel?: string
  /** id of a descriptive element rendered inside children. Optional. */
  ariaDescribedBy?: string
  /**
   * Class names applied to the panel itself (the visible card). Overrides
   * the default chrome — pass the size + padding you want. The role and
   * ARIA attributes are always applied here.
   */
  panelClassName?: string
  children: ReactNode
}

const DEFAULT_PANEL_CLASS = 'w-full max-w-md rounded-2xl bg-white p-6 shadow-xl'

export default function Modal({
  open,
  onClose,
  preventClose = false,
  ariaLabelledBy,
  ariaLabel,
  ariaDescribedBy,
  panelClassName,
  children,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement | null>(null)
  // Element that had focus the moment the modal opened, so we can
  // return focus to it on close. Stored on first open; cleared on close.
  const previouslyFocusedRef = useRef<HTMLElement | null>(null)

  // Capture the focus origin + lock body scroll on open; restore both
  // on close. Stored as an effect so React's StrictMode double-mount
  // also exercises the symmetric lock/unlock pair without leaking.
  useEffect(() => {
    if (!open) return
    previouslyFocusedRef.current =
      typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null
    lockBodyScroll()
    return () => {
      unlockBodyScroll()
      // Restore focus to the trigger. Wrapped in a microtask so the
      // panel has fully unmounted first; otherwise focus() races
      // against React removing the element it was just on.
      const target = previouslyFocusedRef.current
      previouslyFocusedRef.current = null
      if (target && typeof target.focus === 'function') {
        // requestAnimationFrame to let React commit the unmount.
        requestAnimationFrame(() => target.focus())
      }
    }
  }, [open])

  // Auto-focus the first focusable element inside the panel on open.
  // Without this, focus stays on the trigger button, which is now
  // visually behind the modal — a screen reader user pressing Tab
  // would tab into the page underneath instead of into the panel.
  useEffect(() => {
    if (!open) return
    const el = panelRef.current
    if (!el) return
    const firstFocusable = el.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)
    if (firstFocusable) {
      firstFocusable.focus()
    } else {
      // No focusable children — focus the panel itself so subsequent
      // Tab events still hit the trap below. Requires tabindex="-1"
      // which we add unconditionally.
      el.focus()
    }
  }, [open])

  // Esc closes (capture-phase so it beats global Esc handlers higher
  // in the tree, e.g. a page-level "close lightbox on Esc"). Tab/
  // Shift-Tab cycle focus inside the panel.
  useEffect(() => {
    if (!open) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (preventClose) return
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key !== 'Tab' || !panelRef.current) return
      const focusables = panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement as HTMLElement | null
      if (e.shiftKey && active === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      } else if (active && !panelRef.current.contains(active)) {
        // Focus escaped (clicked something outside, then tabbed) —
        // pull it back in.
        e.preventDefault()
        first.focus()
      }
    }
    // Capture phase so we run before any descendant or page-level
    // Esc handler that might also be listening.
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [open, preventClose, onClose])

  if (!open) return null

  // mousedown-then-up split: only treat it as a backdrop click when
  // the press AND release both land on the centring container, not
  // on bubbled inner content. Avoids the "drag-to-select on a textarea,
  // release on the backdrop" foot-gun that would otherwise close the
  // modal while the user was just selecting text.
  function handleBackdropMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    if (preventClose) return
    if (e.target !== e.currentTarget) return
    onClose()
  }

  return createPortal(
    <>
      {/* Backdrop — its own element so the panel container's
          mousedown-then-release split cleanly differentiates a real
          backdrop click from a child release. */}
      <div
        className="fixed inset-0 z-40 bg-black/50"
        aria-hidden="true"
        onMouseDown={handleBackdropMouseDown}
      />
      <div
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
        onMouseDown={handleBackdropMouseDown}
      >
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={ariaLabelledBy}
          aria-label={ariaLabel}
          aria-describedby={ariaDescribedBy}
          tabIndex={-1}
          className={panelClassName ?? DEFAULT_PANEL_CLASS}
          // Stop mousedown from bubbling up to the centring container
          // so a press inside the panel (e.g. start of a textarea
          // drag-select) never registers as a backdrop click.
          onMouseDown={(e) => e.stopPropagation()}
        >
          {children}
        </div>
      </div>
    </>,
    document.body,
  )
}
