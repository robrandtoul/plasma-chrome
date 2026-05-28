import type { Currency } from '../../lib/types'

const CURRENCIES: Currency[] = ['GBP', 'EUR', 'USD']

// Compiler-side currency picker. Same visual shape as
// src/components/CurrencyField but lighter — no carry-forward
// edited state, no fieldset disable, no radio plumbing. We wire
// plain buttons because the page owns sessionStorage stickiness
// directly and doesn't need radio semantics for form submission.
export function CurrencyToggle({
  value,
  onChange,
}: {
  value: Currency | null
  onChange: (next: Currency) => void
}) {
  return (
    <fieldset>
      <legend className="mb-2 block text-xs font-semibold uppercase tracking-widest text-ink-dim">
        Currency
      </legend>
      <div className="inline-flex rounded-md border border-line bg-surface p-0.5">
        {CURRENCIES.map((c) => {
          const selected = value === c
          return (
            <button
              key={c}
              type="button"
              onClick={() => onChange(c)}
              className={[
                'rounded px-5 py-2 text-sm font-semibold transition-colors',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1',
                selected
                  ? 'bg-brand-50 text-brand ring-1 ring-inset ring-brand'
                  : 'text-ink-mute hover:text-ink',
              ].join(' ')}
            >
              {c}
            </button>
          )
        })}
      </div>
    </fieldset>
  )
}
