import type { Currency } from '../lib/types'

const CURRENCIES: Currency[] = ['GBP', 'EUR', 'USD']

export function CurrencyField({
  value,
  onChange,
  disabled = false,
  invalid = false,
  edited = false,
}: {
  value: Currency | null
  onChange: (value: Currency) => void
  disabled?: boolean
  invalid?: boolean
  // True when the parent field is in the carried-but-edited state.
  // Drives the selected-button hue: brand on a clean carried field,
  // low (amber) once the designer has changed the currency away from
  // the value carried from the prior version. Defaults to false so v1
  // creation and any non-carried context just see brand.
  edited?: boolean
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
                ? edited
                  ? 'bg-low-soft text-low ring-1 ring-inset ring-low'
                  : 'bg-brand-50 text-brand ring-1 ring-inset ring-brand'
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
