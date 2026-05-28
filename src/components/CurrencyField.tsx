import type { Currency } from '../lib/types'

const CURRENCIES: Currency[] = ['GBP', 'EUR', 'USD']

// Selected-pill hue. Carried fields pass a tone so the pill reads as
// coral (fresh), neutral ("as before") or amber (changed).
const SELECTED_TONE: Record<'brand' | 'neutral' | 'low', string> = {
  brand: 'bg-brand-50 text-brand ring-1 ring-inset ring-brand',
  neutral: 'bg-canvas text-ink ring-1 ring-inset ring-ink',
  low: 'bg-low-soft text-low ring-1 ring-inset ring-low',
}

export function CurrencyField({
  value,
  onChange,
  disabled = false,
  invalid = false,
  tone = 'brand',
}: {
  value: Currency | null
  onChange: (value: Currency) => void
  disabled?: boolean
  invalid?: boolean
  // Selected-pill tone for carried fields: brand (fresh), neutral
  // (carried & unchanged), low (changed). Defaults to brand.
  tone?: 'brand' | 'neutral' | 'low'
}) {
  return (
    <fieldset
      disabled={disabled}
      className={[
        'inline-flex rounded-md border p-0.5',
        invalid ? 'border-out bg-out-soft' : 'border-line bg-surface',
        disabled ? 'opacity-70' : '',
      ].join(' ')}
    >
      <legend className="sr-only">Currency</legend>
      {CURRENCIES.map((c) => {
        const selected = value === c
        return (
          <label
            key={c}
            className={[
              'rounded px-5 py-2 text-sm font-semibold transition-colors',
              'focus-within:ring-2 focus-within:ring-brand focus-within:ring-offset-1',
              disabled ? 'cursor-not-allowed' : 'cursor-pointer',
              selected
                ? SELECTED_TONE[tone]
                : disabled
                  ? 'text-ink-dim'
                  : 'text-ink-mute hover:text-ink',
            ].join(' ')}
          >
            <input
              type="radio"
              name="currency"
              value={c}
              checked={selected}
              onChange={() => onChange(c)}
              className="sr-only"
            />
            {c}
          </label>
        )
      })}
    </fieldset>
  )
}
