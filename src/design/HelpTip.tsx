import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'

// In-context help tooltip for the cryptic status tags around the staff app.
// Wrap a tag (a Pill, a chip, a short text label) and pass the plain-English
// explanation as `body` — usually straight from tagHelp(family, code). The tip
// shows on hover and on keyboard focus.
//
// Rendered via createPortal to document.body, mirroring the dashboard's
// ThumbnailPopover: a position:fixed surface placed from the trigger's
// bounding box escapes the overflow clipping of scrolling panels (the Outbox
// list scrolls) and any parent stacking context. Any scroll or resize closes
// it rather than chasing a now-stale position.

type Affordance = 'underline' | 'ring' | 'none'

interface HelpTipProps {
  // The explanation to show. When empty/undefined the children render exactly
  // as-is with no tooltip behaviour, so a call site can wrap a tag whose code
  // may or may not have help text without branching.
  body: string | null | undefined
  children: ReactNode
  // How the trigger hints it's hoverable. Plain text labels read well with a
  // dotted underline; filled chips/pills look cleaner with a faint hover ring
  // (or nothing at all). Default 'underline'.
  affordance?: Affordance
  // Whether the trigger is itself keyboard-focusable. Default true (so the tip
  // is reachable by tab). Pass false when the trigger sits inside an
  // already-focusable control (e.g. a button) to avoid a nested tab stop —
  // the tip is then hover-only.
  focusable?: boolean
  className?: string
}

// underline uses border-bottom (works on the inline trigger); ring/none keep
// the trigger inline-flex so chips stay vertically centred.
const AFFORDANCE_CLASS: Record<Affordance, string> = {
  underline: 'inline border-b border-dotted border-ink-dim',
  ring: 'inline-flex items-center rounded-[7px] transition-shadow hover:shadow-[0_0_0_2px_var(--c-allocated-soft)] focus-visible:shadow-[0_0_0_2px_var(--c-allocated-soft)]',
  none: 'inline-flex items-center',
}

const TIP_W = 240
const GAP = 8
const MARGIN = 12

export function HelpTip({
  body,
  children,
  affordance = 'underline',
  focusable = true,
  className = '',
}: HelpTipProps) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const triggerRef = useRef<HTMLSpanElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const tipId = useId()

  // Place the tip from the trigger box once open. A layout effect so the
  // measured placement lands before paint (no flash). The tip is measured for
  // its real height so the flip-above case (no room below) lands exactly.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return
    const t = triggerRef.current.getBoundingClientRect()
    const h = tipRef.current?.offsetHeight ?? 80
    let top = t.bottom + GAP
    if (top + h > window.innerHeight - MARGIN) {
      const above = t.top - GAP - h
      if (above >= MARGIN) top = above
    }
    let left = t.left + t.width / 2 - TIP_W / 2
    left = Math.max(MARGIN, Math.min(left, window.innerWidth - TIP_W - MARGIN))
    setPos({ top, left })
  }, [open])

  // A fixed tip can't follow its trigger, so any scroll (capture catches inner
  // scrollers too) or resize closes it. Escape closes for keyboard users.
  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('resize', close)
    document.addEventListener('scroll', close, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('resize', close)
      document.removeEventListener('scroll', close, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!body) return <>{children}</>

  return (
    <span
      ref={triggerRef}
      tabIndex={focusable ? 0 : undefined}
      aria-describedby={open ? tipId : undefined}
      className={`cursor-help ${AFFORDANCE_CLASS[affordance]} ${className}`.trim()}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {children}
      {open &&
        createPortal(
          <div
            ref={tipRef}
            id={tipId}
            role="tooltip"
            className="fixed z-[80] rounded-[10px] bg-surface border border-line shadow-md px-3 py-2 text-[12px] leading-relaxed text-ink-soft pointer-events-none"
            style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, width: TIP_W }}
          >
            {body}
          </div>,
          document.body,
        )}
    </span>
  )
}

export default HelpTip
