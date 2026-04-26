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

import type { CSSProperties } from 'react'

export type PricingDisplayValue = 'standard' | 'custom'

const SUBTITLE_FOR_VALUE: Record<PricingDisplayValue, string> = {
  standard: 'Customer sees a price grid based on material and quantity.',
  custom: "Pricing is hidden. Customer sees a note saying you'll quote separately.",
}
const SUBTITLE_UNSET = 'Choose how customers see pricing.'

// Inline selected-state style. Mirrors the violet hybrid used by
// the other segmented controls on the new-version form (variant
// chips, Card type, Sidedness, Currency). Kept inline here rather
// than reaching across to NewVersionPage so PricingDisplayField
// stays self-contained for EditVersionPage's usage too.
const SELECTED_STYLE: CSSProperties = {
  background: 'rgba(123,63,242,0.16)',
  color: '#5b2bba',
  boxShadow: 'inset 0 0 0 1.5px #7b3ff2',
}

export function PricingDisplayField({
  value,
  onChange,
  invalid = false,
  forwardRef,
  standardDisabled = false,
  disabledReason,
}: {
  value: PricingDisplayValue | null
  onChange: (value: PricingDisplayValue) => void
  invalid?: boolean
  forwardRef?: React.RefObject<HTMLElement | null>
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
    <section ref={forwardRef as React.RefObject<HTMLElement>}>
      <fieldset
        className={[
          'inline-flex rounded-xl border bg-white p-0.5',
          invalid ? 'border-rose-300' : 'border-gray-200',
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
                'rounded-lg px-5 py-2 text-sm font-semibold transition-colors',
                'focus-within:ring-2 focus-within:ring-gray-400 focus-within:ring-offset-1',
                disabled ? 'cursor-not-allowed text-gray-300' : 'cursor-pointer',
                !disabled && (selected ? '' : 'text-gray-500 hover:text-gray-900'),
              ].join(' ')}
              style={selected && !disabled ? SELECTED_STYLE : undefined}
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
      <p className="mt-1.5 text-xs text-gray-500">{subtitle}</p>
      {standardDisabled && disabledReason && (
        <p className="mt-1.5 text-xs text-gray-500">{disabledReason}</p>
      )}
      {invalid && <p className="mt-1.5 text-xs font-medium text-rose-500">Required</p>}
    </section>
  )
}
