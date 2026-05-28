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

// Material option / finish selector. Sits in the right slot of the
// Plates section header. Rendered as a segmented control (the same
// idiom as CurrencyField on the designer side) so it reads
// unmistakably as a "pick one" toggle rather than as quiet caption
// text — the whole strip is one bordered track on a surface fill,
// and the active segment lifts out with a soft-coral fill + inset
// coral ring. The "Finish" / "Species" label leads in as a mono
// eyebrow.
//
// Behaviour preserved verbatim from the Direction-B version — only
// the visual chrome changes.
export function MaterialOptionTabs({
  label,
  tabs,
  onSelect,
  currency,
  showSurcharges,
}: MaterialOptionTabsProps) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="eyebrow text-ink-mute">{label}</span>
      <div className="inline-flex flex-wrap rounded border border-line bg-surface p-0.5">
        {tabs.map((tab) => (
          <button
            key={tab.code}
            type="button"
            aria-pressed={tab.isActive}
            onClick={() => onSelect(tab.code)}
            className={[
              'inline-flex items-baseline gap-1.5 rounded px-3 py-1.5 transition-colors',
              tab.isActive
                ? 'bg-brand-50 text-brand ring-1 ring-inset ring-brand'
                : 'text-ink-mute hover:text-ink',
              'focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--c-brand)]',
            ].join(' ')}
          >
            <span className="text-[13px] font-medium leading-none">
              {tab.displayName}
            </span>
            {showSurcharges && tab.surchargeFromPrice != null && (
              <span
                className={[
                  'text-[11px] font-mono font-tnum leading-none whitespace-nowrap',
                  tab.isActive ? 'text-brand/70' : 'text-ink-dim',
                ].join(' ')}
              >
                +{formatPrice(tab.surchargeFromPrice, currency, 0)}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  )
}
