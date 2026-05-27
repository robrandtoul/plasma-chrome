import { formatPrice } from '../lib/currency'
import type { Currency } from '../lib/types'

export type MaterialOptionTab = {
  code: string
  displayName: string
  surchargeFromPrice: number | null
  isActive: boolean
}

type MaterialOptionTabsProps = {
  label: string
  tabs: MaterialOptionTab[]
  onSelect: (code: string) => void
  currency: Currency
  showSurcharges: boolean
}

// Material option / finish tab strip. Sits in the right slot of
// the Plates section header. Active tab carries a solid ink
// underline; idle tabs hover into a soft line-coloured underline.
// All copy is mono-uppercase via the .eyebrow class from the
// design tokens so the strip reads as a continuation of the
// page's eyebrow system rather than a bespoke component.
//
// Behaviour preserved verbatim from the Direction-B version —
// only the visual chrome changes in this reskin pass.
export function MaterialOptionTabs({
  label,
  tabs,
  onSelect,
  currency,
  showSurcharges,
}: MaterialOptionTabsProps) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-6 gap-y-3">
      <span className="eyebrow">{label}</span>
      {tabs.map((tab) => (
        <button
          key={tab.code}
          type="button"
          aria-pressed={tab.isActive}
          onClick={() => onSelect(tab.code)}
          className={[
            'flex items-baseline gap-2 pb-2 border-b-2 transition-colors',
            tab.isActive
              ? 'border-ink'
              : 'border-transparent hover:border-line',
            'focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--c-brand)]',
          ].join(' ')}
        >
          <span
            className={[
              'eyebrow',
              tab.isActive ? 'text-ink' : 'text-ink-mute',
            ].join(' ')}
            style={{ letterSpacing: '0.18em' }}
          >
            {tab.displayName}
          </span>
          {showSurcharges && tab.surchargeFromPrice != null && (
            <span
              className="eyebrow text-ink-dim whitespace-nowrap"
              style={{ letterSpacing: '0.05em' }}
            >
              From +{formatPrice(tab.surchargeFromPrice, currency, 0)}
            </span>
          )}
        </button>
      ))}
    </div>
  )
}
