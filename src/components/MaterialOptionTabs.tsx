import { formatPrice } from '../lib/currency'
import type { Currency } from '../lib/types'
import { PAPER_INK, PAPER_TERTIARY, PAPER_QUATERNARY } from '../lib/theme'

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

export function MaterialOptionTabs({
  label,
  tabs,
  onSelect,
  currency,
  showSurcharges,
}: MaterialOptionTabsProps) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-8 gap-y-3">
      <span
        className="font-paper-mono uppercase"
        style={{ fontSize: 12, fontWeight: 500, letterSpacing: '0.32em', color: PAPER_INK }}
      >
        {label}
      </span>
      {tabs.map((tab) => (
        <button
          key={tab.code}
          type="button"
          aria-pressed={tab.isActive}
          onClick={() => onSelect(tab.code)}
          className={[
            'flex items-baseline gap-2 pb-3',
            'border-b-2 transition-colors',
            tab.isActive
              ? 'border-[#1a1612]'
              : 'border-transparent hover:border-[rgba(26,22,18,0.25)]',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(123,63,242,0.5)]',
          ].join(' ')}
        >
          <span
            className="font-paper-mono uppercase"
            style={{
              fontSize: 11,
              fontWeight: 500,
              letterSpacing: '0.22em',
              color: tab.isActive ? PAPER_INK : PAPER_TERTIARY,
            }}
          >
            {tab.displayName}
          </span>
          {showSurcharges && tab.surchargeFromPrice != null && (
            <span
              className="font-paper-mono uppercase whitespace-nowrap"
              style={{
                fontSize: 11,
                fontWeight: 400,
                letterSpacing: '0.05em',
                color: PAPER_QUATERNARY,
              }}
            >
              From +{formatPrice(tab.surchargeFromPrice, currency, 0)}
            </span>
          )}
        </button>
      ))}
    </div>
  )
}
