import type { Currency } from '../lib/types'

const CURRENCIES: Currency[] = ['GBP', 'EUR', 'USD']

export function CurrencyField({
  value,
  onChange,
  disabled = false,
  invalid = false,
}: {
  value: Currency | null
  onChange: (value: Currency) => void
  disabled?: boolean
  invalid?: boolean
  // Accepted for call-site compatibility. The carried / edited state is
  // now conveyed by the field wrapper + "from vN" / "edited" badge, not
  // by the selected pill — coral always means "selected".
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
                ? 'bg-brand-50 text-brand ring-1 ring-inset ring-brand'
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
