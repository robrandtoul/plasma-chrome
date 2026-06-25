import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useIsMobile } from './useIsMobile'

// Mobile bottom-sheet / full-screen sheet primitive. Rendered ONLY below
// md: — callers keep their existing desktop popover / centred dialog and
// branch on useIsMobile(). A single portal-rendered component reused by
// the dashboard action menu, the resolve popover, and the activity panel
// so they all get the same chrome, backdrop, scroll-lock and dismissal
// behaviour.
//
//   variant="sheet"       bottom-pinned card, rounded top, grab handle,
//                         grows to its content up to ~90dvh then scrolls.
//   variant="fullscreen"  inset:0, sticky header (X on the left) + scrolling
//                         body + optional sticky footer.
//
// Dismissal: backdrop tap + Escape (matches the popovers/Modal it
// replaces). Body scroll is locked while open. Safe-area insets are
// honoured (viewport-fit=cover is set in index.html) so the panel never
// slides under the home indicator / notch.

interface SheetProps {
  open: boolean
  onClose: () => void
  /** Centred header title (sheet) / leading header title (fullscreen). */
  title?: ReactNode
  /** Optional sub-line under the title. */
  subtitle?: ReactNode
  /** Optional element pinned to the top-right of the header. */
  headerRight?: ReactNode
  /** Sticky footer, fullscreen variant only. */
  footer?: ReactNode
  variant?: 'sheet' | 'fullscreen'
  /** Screen-reader label when no visible title is supplied. */
  ariaLabel?: string
  children: ReactNode
}

export function Sheet({
  open,
  onClose,
  title,
  subtitle,
  headerRight,
  footer,
  variant = 'sheet',
  ariaLabel,
  children,
}: SheetProps) {
  const isMobile = useIsMobile()
  const panelRef = useRef<HTMLDivElement | null>(null)
  const previouslyFocused = useRef<HTMLElement | null>(null)

  const active = open && isMobile

  // Lock body scroll + capture/restore focus while the sheet is open.
  useEffect(() => {
    if (!active) return
    previouslyFocused.current = document.activeElement as HTMLElement | null
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    // Focus the panel so Escape / Tab land inside it, not on the page
    // behind. rAF so the element is painted first.
    const raf = requestAnimationFrame(() => panelRef.current?.focus())
    return () => {
      cancelAnimationFrame(raf)
      document.body.style.overflow = prevOverflow
      const target = previouslyFocused.current
      previouslyFocused.current = null
      if (target && typeof target.focus === 'function') {
        requestAnimationFrame(() => target.focus())
      }
    }
  }, [active])

  // Escape closes (capture phase, mirrors Modal so it beats page-level
  // Escape handlers e.g. a lightbox).
  useEffect(() => {
    if (!active) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [active, onClose])

  if (!active) return null

  const isFullscreen = variant === 'fullscreen'

  // mousedown-then-up split so a drag that starts inside the panel (e.g.
  // selecting text) and releases on the backdrop doesn't close it.
  function handleBackdropMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target !== e.currentTarget) return
    onClose()
  }

  const panelClass = isFullscreen
    ? 'fixed inset-0 z-[80] flex flex-col bg-surface outline-none'
    : 'fixed inset-x-0 bottom-0 z-[80] flex max-h-[90dvh] flex-col rounded-t-[24px] bg-canvas outline-none animate-sheet-up'

  const panelStyle: React.CSSProperties = isFullscreen
    ? { paddingTop: 'env(safe-area-inset-top)' }
    : { boxShadow: '0 -10px 40px rgba(22,19,17,0.22)' }

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-[70] bg-[rgba(22,19,17,0.34)]"
        aria-hidden="true"
        onMouseDown={handleBackdropMouseDown}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : ariaLabel}
        tabIndex={-1}
        className={panelClass}
        style={panelStyle}
      >
        {isFullscreen ? (
          <header
            className="sticky top-0 z-10 flex items-center gap-3 border-b border-line bg-surface px-3 py-2"
          >
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-ink-soft hover:bg-canvas"
            >
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
            <div className="min-w-0 flex-1">
              {title && <div className="truncate text-[15px] font-semibold text-ink">{title}</div>}
              {subtitle && <div className="truncate text-[12px] text-ink-mute">{subtitle}</div>}
            </div>
            {headerRight && <div className="shrink-0">{headerRight}</div>}
          </header>
        ) : (
          <>
            <div className="flex justify-center pt-2.5 pb-1" aria-hidden="true">
              <span className="h-[5px] w-[38px] rounded-full bg-[#d8cfbf]" />
            </div>
            {(title || headerRight) && (
              <div className="flex items-center gap-2 px-5 pt-1 pb-3">
                <div className="min-w-0 flex-1 text-center">
                  {title && <div className="truncate text-[15px] font-semibold text-ink">{title}</div>}
                  {subtitle && <div className="truncate text-[12px] text-ink-mute">{subtitle}</div>}
                </div>
                {headerRight && <div className="absolute right-4 shrink-0">{headerRight}</div>}
              </div>
            )}
          </>
        )}

        <div
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
          style={
            isFullscreen
              ? undefined
              : { paddingBottom: 'calc(env(safe-area-inset-bottom) + 12px)' }
          }
        >
          {children}
        </div>

        {isFullscreen && footer && (
          <footer
            className="sticky bottom-0 border-t border-line bg-[rgba(255,255,255,0.96)] px-4 py-3 backdrop-blur"
            style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 12px)' }}
          >
            {footer}
          </footer>
        )}
      </div>
    </>,
    document.body,
  )
}

export default Sheet
