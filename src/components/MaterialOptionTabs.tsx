import { SwatchBook } from 'lucide-react'
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

// Material option / finish chooser. Previously this lived as a quiet
// strip in the right slot of the Plates section header, where the tiny
// mono "FINISH" eyebrow made it easy to miss. It's now a self-contained
// bordered bar that sits full-width directly above the plate grid:
//
//   • a swatch icon + a plain-English call to action ("Choose your
//     finish") so it reads unmistakably as a thing to act on;
//   • a one-line hint that switching previews the result;
//   • a segmented control of larger, higher-contrast pills — the active
//     segment lifts out with a soft-coral fill + inset coral ring.
//
// The label ("Finish" / "Species") drives both the heading and the
// segment text. Selection behaviour is unchanged — only the chrome and
// placement.
export function MaterialOptionTabs({
  label,
  tabs,
  onSelect,
  currency,
  showSurcharges,
}: MaterialOptionTabsProps) {
  return (
    <div className="flex flex-col gap-4 rounded-[14px] border border-line bg-surface px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
      {/* Call to action — icon cue + prompt + preview hint */}
      <div className="flex items-center gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-50 text-brand">
          <SwatchBook size={17} aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <div className="font-display font-medium leading-tight text-ink text-[15px]">
            Choose your {label.toLowerCase()}
          </div>
          <div className="mt-0.5 text-[12px] leading-tight text-ink-mute">
            Switch to preview each option
          </div>
        </div>
      </div>

      {/* Segmented control. On mobile it's a full-width single row that
          must not wrap (the wrap looked broken on an iPhone); if the
          options ever exceed the width it scrolls horizontally rather
          than stacking. On sm+ it shrinks back to a content-width strip
          beside the prompt. */}
      <div className="flex w-full flex-nowrap gap-1 rounded-full border border-line bg-canvas p-1 sm:inline-flex sm:w-auto sm:shrink-0">
        {tabs.map((tab) => (
          <button
            key={tab.code}
            type="button"
            aria-pressed={tab.isActive}
            onClick={() => onSelect(tab.code)}
            className={[
              // Mobile: equal-width thirds, surcharge stacked under the
              // name so three options never wrap or clip on an iPhone.
              // sm+: natural-width inline pills with the surcharge beside
              // the name (the original treatment).
              'flex flex-1 flex-col items-center justify-center gap-0.5 rounded-full px-3 py-1.5 text-center transition-colors',
              'sm:flex-none sm:flex-row sm:items-baseline sm:gap-1.5 sm:px-4 sm:py-2',
              tab.isActive
                ? 'bg-brand-50 text-brand outline outline-1 -outline-offset-1 outline-brand'
                : 'text-ink-soft hover:bg-surface hover:text-ink',
              'focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--c-brand)]',
            ].join(' ')}
          >
            <span className="text-[14px] font-medium leading-none">
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
