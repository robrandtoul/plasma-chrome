import { type ReactNode } from 'react'
import { type LucideIcon } from 'lucide-react'

interface PanelShellProps {
  title?: string
  /** Optional small label above the title, or alone with no title. */
  eyebrow?: string
  /** Padded "(03)" affix next to the title. */
  count?: number
  /** Lucide icon component rendered inside a 28×28 tinted block. */
  icon?: LucideIcon
  /** CSS colour string for the icon block tint (e.g. tokens.brand). */
  accent?: string
  /** Pushed to the right of the header — buttons, toggles, links. */
  action?: ReactNode
  /** Default true. Pass false for grid panels that own their padding. */
  padded?: boolean
  className?: string
  children: ReactNode
}

// The signature container for every dashboard section, form section,
// and list panel in the reskin. Header row (icon + eyebrow + title +
// count + action) sits on a hairline divider; body padding is 14px
// when `padded` is true. Lift verbatim from prototypes/frames/shared.jsx
// PanelShell; only the colour layer comes from the new token bridge.
export function PanelShell({
  title,
  eyebrow,
  count,
  icon: Icon,
  accent,
  action,
  padded = true,
  className = '',
  children,
}: PanelShellProps) {
  const sectionCls = [
    'overflow-hidden bg-surface border border-line rounded-[14px]',
    className,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <section className={sectionCls}>
      {(title || eyebrow) && (
        <header className="flex flex-wrap items-center gap-[10px] px-[14px] pt-9 pb-3 bg-surface border-b border-line-soft">
          {Icon && (
            <span
              className="inline-flex items-center justify-center w-7 h-7 rounded-[6px] flex-shrink-0 border border-line-soft"
              style={{
                backgroundColor: accent
                  ? `color-mix(in srgb, ${accent} 14%, transparent)`
                  : 'var(--c-bg-panel)',
                color: accent ?? 'var(--c-ink-soft)',
              }}
            >
              <Icon size={14} />
            </span>
          )}
          <div className="flex flex-col gap-0.5">
            {eyebrow && <span className="eyebrow">{eyebrow}</span>}
            {title && (
              <h2 className="font-display text-[20px] font-medium tracking-[-0.02em] text-ink m-0 leading-tight">
                {title}
              </h2>
            )}
          </div>
          {typeof count === 'number' && (
            <span className="num num-sm text-ink-mute">
              ({String(count).padStart(2, '0')})
            </span>
          )}
          {/* ml-auto keeps the action right-aligned; when the header
              wraps on a narrow card the action drops to its own line
              (still right-aligned) rather than colliding with a long
              eyebrow. whitespace-nowrap keeps its text on one line. */}
          {action && <div className="ml-auto flex items-center gap-2 whitespace-nowrap">{action}</div>}
        </header>
      )}
      <div className={padded ? 'p-[14px]' : ''}>{children}</div>
    </section>
  )
}

export default PanelShell
