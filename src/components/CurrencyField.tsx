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
}) {
  return (
    <fieldset
      disabled={disabled}
      className={[
        'inline-flex rounded-xl border p-0.5',
        invalid ? 'border-rose-300 bg-rose-50' : 'border-gray-200 bg-white',
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
              'rounded-lg px-5 py-1.5 text-sm font-semibold transition-colors',
              'focus-within:ring-2 focus-within:ring-gray-400 focus-within:ring-offset-1',
              disabled ? 'cursor-not-allowed' : 'cursor-pointer',
              selected
                ? 'bg-gray-900 text-white'
                : disabled
                  ? 'text-gray-400'
                  : 'text-gray-500 hover:text-gray-900',
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
