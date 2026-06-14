import { useState, type ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'

// Shared shell for the dashboard sidebar cards (Latest activity, Automated
// reminders, Lead times). Renders the house card chrome — a 32px tinted icon
// square + eyebrow + display heading over a soft hairline — but turns the
// header into a disclosure toggle so a designer can collapse panels they
// don't want taking up sidebar height. The open/closed choice is remembered
// per panel in localStorage (keyed by `storageKey`), so it survives reloads.
//
// The header follows the ARIA accordion-header pattern: a <button> wrapped in
// the heading element, carrying aria-expanded + aria-controls. The chevron
// matches the in-panel <details> idiom used elsewhere (points right when
// closed, rotates down when open).

function readCollapsed(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    // Private mode / disabled storage — default to expanded.
    return false
  }
}

function writeCollapsed(key: string, collapsed: boolean) {
  try {
    localStorage.setItem(key, collapsed ? '1' : '0')
  } catch {
    // Best-effort; a failed write just means the choice isn't remembered.
  }
}

export default function CollapsibleSidebarPanel({
  icon: Icon,
  iconTint,
  eyebrow,
  title,
  storageKey,
  children,
}: {
  icon: LucideIcon
  /** A design-token CSS variable string, e.g. 'var(--c-brand)'. */
  iconTint: string
  eyebrow: string
  title: string
  /** localStorage key the collapsed state is persisted under. */
  storageKey: string
  children: ReactNode
}) {
  const [collapsed, setCollapsed] = useState(() => readCollapsed(storageKey))
  const regionId = `collapsible-${storageKey.replace(/[^a-z0-9]+/gi, '-')}`

  function toggle() {
    setCollapsed((c) => {
      const next = !c
      writeCollapsed(storageKey, next)
      return next
    })
  }

  return (
    <section className="rounded-[14px] bg-surface border border-line overflow-hidden">
      <h2 className="m-0">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={!collapsed}
          aria-controls={regionId}
          className={[
            'flex w-full items-center gap-3 px-5 pt-5 pb-4 text-left transition-colors hover:bg-canvas',
            'focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--c-brand)]',
            collapsed ? '' : 'border-b border-line-soft',
          ].join(' ')}
        >
          <span
            aria-hidden="true"
            className="inline-flex items-center justify-center w-8 h-8 rounded-md shrink-0"
            style={{
              backgroundColor: `color-mix(in srgb, ${iconTint} 14%, transparent)`,
              color: iconTint,
            }}
          >
            <Icon size={16} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="eyebrow text-ink-mute block">{eyebrow}</span>
            <span className="block font-display font-medium tracking-[-0.02em] text-ink leading-tight text-[20px]">
              {title}
            </span>
          </span>
          {/* Disclosure chevron — matches the in-panel <details> idiom:
              points right when closed, rotates to point down when open. */}
          <svg
            aria-hidden="true"
            viewBox="0 0 16 16"
            className={[
              'h-4 w-4 shrink-0 self-center text-ink-mute transition-transform',
              collapsed ? '' : 'rotate-90',
            ].join(' ')}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="6 4 10 8 6 12" />
          </svg>
        </button>
      </h2>
      <div id={regionId} hidden={collapsed}>
        {!collapsed && children}
      </div>
    </section>
  )
}
