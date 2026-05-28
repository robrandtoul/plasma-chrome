// Compact pricing-display picker. Designer chooses whether the
// customer sees a standard price grid or a custom-quote note.
//
// Segmented toggle (matches the form's other segmented controls:
// Currency, Card type, Sidedness) plus a contextual one-line subtitle
// that switches with selection so the customer-visible outcome stays
// explained inline. Replaces the previous two-card radio layout
// which cost ~120px of vertical space for the same choice.
//
// Used by NewVersionPage's Commercial section and EditVersionPage's
// pricing block. Both surfaces benefit consistently from the rewrite;
// EditVersionPage's standardDisabled / disabledReason pair keeps
// working (the Standard button greys out and the reason renders as
// an additional subtitle when set).

import type { RefObject } from 'react'

export type PricingDisplayValue = 'standard' | 'custom'

const SUBTITLE_FOR_VALUE: Record<PricingDisplayValue, string> = {
  standard: 'Customer sees a price grid based on material and quantity.',
  custom: "Pricing is hidden. Customer sees a note saying you'll quote separately.",
}
const SUBTITLE_UNSET = 'Choose how customers see pricing.'

// Selected-pill hue. On carried fields the host passes a tone so the
// pill reads as coral (fresh), neutral ("as before") or amber (changed).
const SELECTED_TONE: Record<'brand' | 'neutral' | 'low', string> = {
  brand: 'bg-brand-50 text-brand ring-1 ring-inset ring-brand',
  neutral: 'bg-canvas text-ink ring-1 ring-inset ring-ink',
  low: 'bg-low-soft text-low ring-1 ring-inset ring-low',
}

export function PricingDisplayField({
  value,
  onChange,
  invalid = false,
  forwardRef,
  standardDisabled = false,
  disabledReason,
  tone = 'brand',
}: {
  value: PricingDisplayValue | null
  onChange: (value: PricingDisplayValue) => void
  invalid?: boolean
  forwardRef?: RefObject<HTMLElement | null>
  // Selected-pill tone for carried fields: brand (fresh), neutral
  // (carried & unchanged), low (changed). Defaults to brand.
  tone?: 'brand' | 'neutral' | 'low'
  // Disable the "Standard pricing" option. Used on EditVersionPage
  // when the loaded version's pricing_snapshot carries no per-tier
  // prices — selecting Standard would produce a version marked as
  // standard-priced but with an empty grid on the customer page,
  // which is broken output. Disabling the option at the source
  // removes the footgun without needing a save-time guard.
  standardDisabled?: boolean
  // Explanatory helper rendered below the toggle when the Standard
  // option is disabled, so the designer understands why.
  disabledReason?: string
}) {
  const subtitle = value == null ? SUBTITLE_UNSET : SUBTITLE_FOR_VALUE[value]

  return (
    <section ref={forwardRef as RefObject<HTMLElement>}>
      <fieldset
        className={[
          'inline-flex rounded border bg-surface p-0.5',
          invalid ? 'border-out' : 'border-line',
        ].join(' ')}
      >
        <legend className="sr-only">Pricing display</legend>
        {(['standard', 'custom'] as const).map((opt) => {
          const selected = value === opt
          const disabled = opt === 'standard' && standardDisabled
          return (
            <label
              key={opt}
              className={[
                'rounded px-5 py-2 text-sm font-semibold transition-colors',
                'focus-within:ring-2 focus-within:ring-brand focus-within:ring-offset-1',
                disabled ? 'cursor-not-allowed text-ink-dim' : 'cursor-pointer',
                !disabled &&
                  (selected
                    ? SELECTED_TONE[tone]
                    : 'text-ink-mute hover:text-ink'),
              ].join(' ')}
            >
              <input
                type="radio"
                name="pricing-display"
                value={opt}
                checked={selected}
                disabled={disabled}
                onChange={() => !disabled && onChange(opt)}
                className="sr-only"
              />
              {opt === 'standard' ? 'Standard pricing' : 'Custom quote'}
            </label>
          )
        })}
      </fieldset>
      <p className="mt-1.5 text-xs text-ink-mute">{subtitle}</p>
      {standardDisabled && disabledReason && (
        <p className="mt-1.5 text-xs text-ink-mute">{disabledReason}</p>
      )}
      {invalid && <p className="mt-1.5 text-xs font-medium text-out">Required</p>}
    </section>
  )
}
