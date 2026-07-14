import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { MoreHorizontal } from 'lucide-react'

// Shared "⋯" overflow menu for list cards (Orders page etc.). Keeps rare or
// destructive per-card actions out of the always-visible action row, so a card
// shows one primary action and tucks the rest here. Same pattern as the
// proof-detail HeaderActionsMenu: the dropdown is portalled to document.body
// and positioned from the trigger's rect, because PanelShell cards use
// overflow-hidden (for their rounded corners) which would clip an in-card
// dropdown.

export interface CardMenuItem {
  label: string
  /** Plain action item. */
  onClick?: () => void
  /** Internal route — rendered as a router Link so middle-click etc. work. */
  to?: string
  /** External link — rendered as an <a target="_blank">. */
  href?: string
  tone?: 'default' | 'danger'
  disabled?: boolean
  title?: string
}

const ITEM_CLS = 'block w-full px-3 py-2 max-md:py-2.5 text-left text-sm transition-colors hover:bg-canvas disabled:opacity-50 disabled:cursor-not-allowed'

function toneCls(tone: CardMenuItem['tone']) {
  return tone === 'danger' ? 'text-out' : 'text-ink-soft'
}

export default function CardActionsMenu({
  items,
  label = 'More actions',
  triggerClassName = '',
}: {
  items: CardMenuItem[]
  label?: string
  triggerClassName?: string
}) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null)

  useEffect(() => {
    if (!open) return
    function place() {
      const r = btnRef.current?.getBoundingClientRect()
      if (r) setPos({ top: r.bottom + 6, right: window.innerWidth - r.right })
    }
    place()
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    document.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (items.length === 0) return null

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => setOpen((o) => !o)}
        className={[
          'inline-flex h-[30px] w-[30px] max-md:h-11 max-md:w-11 shrink-0 items-center justify-center rounded-[4px] border border-line bg-surface text-ink-soft transition-colors hover:bg-canvas focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--c-brand)]',
          triggerClassName,
        ].filter(Boolean).join(' ')}
      >
        <MoreHorizontal size={16} aria-hidden="true" />
      </button>
      {open && pos && createPortal(
        <>
          {/* Transparent click-catcher closes the menu on any outside click. */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            role="menu"
            className="fixed z-50 min-w-[210px] rounded-[8px] border border-line bg-surface py-1 shadow-md"
            style={{ top: pos.top, right: pos.right }}
          >
            {items.map((item) =>
              item.to ? (
                <Link
                  key={item.label}
                  to={item.to}
                  role="menuitem"
                  title={item.title}
                  onClick={() => setOpen(false)}
                  className={`${ITEM_CLS} ${toneCls(item.tone)}`}
                >
                  {item.label}
                </Link>
              ) : item.href ? (
                <a
                  key={item.label}
                  href={item.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  role="menuitem"
                  title={item.title}
                  onClick={() => setOpen(false)}
                  className={`${ITEM_CLS} ${toneCls(item.tone)}`}
                >
                  {item.label}
                </a>
              ) : (
                <button
                  key={item.label}
                  type="button"
                  role="menuitem"
                  title={item.title}
                  disabled={item.disabled}
                  onClick={() => { setOpen(false); item.onClick?.() }}
                  className={`${ITEM_CLS} ${toneCls(item.tone)}`}
                >
                  {item.label}
                </button>
              ),
            )}
          </div>
        </>,
        document.body,
      )}
    </>
  )
}
