import type { CSSProperties } from 'react'
import type { Currency } from '../lib/types'

const CURRENCIES: Currency[] = ['GBP', 'EUR', 'USD']

// Hybrid selected-state. Soft violet tint with a 1.5px violet ring
// via inset box-shadow. Mirrors the chip and segmented-control
// styling used elsewhere on the new-version form (variant chips,
// material-options chips, card-type / sidedness segmented).
const hybridChipSelectedStyle: CSSProperties = {
  background: 'rgba(123,63,242,0.16)',
  color: '#5b2bba',
  boxShadow: 'inset 0 0 0 1.5px #7b3ff2',
}

// Same shape as the violet style above, retinted amber. Used when
// the parent field has been edited away from the value carried
// from the prior version, so the selected button matches the
// field's amber border, tint and pill instead of leaving a violet
// active selection inside an amber wrapper.
const hybridChipEditedSelectedStyle: CSSProperties = {
  background: 'rgba(245,158,11,0.16)',
  color: '#92400e',
  boxShadow: 'inset 0 0 0 1.5px #f59e0b',
}

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
  // True when the parent field is in the carried-but-edited
  // state. Drives the selected-button hue: violet on a clean
  // carried field, amber once the designer has changed the
  // currency. Defaults to false so v1 creation and any
  // non-carried context just see violet.
  edited?: boolean
}) {
  const selectedStyle = edited ? hybridChipEditedSelectedStyle : hybridChipSelectedStyle
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
              'rounded-lg px-5 py-2 text-sm font-semibold transition-colors',
              'focus-within:ring-2 focus-within:ring-gray-400 focus-within:ring-offset-1',
              disabled ? 'cursor-not-allowed' : 'cursor-pointer',
              selected
                ? ''
                : disabled
                  ? 'text-gray-400'
                  : 'text-gray-500 hover:text-gray-900',
            ].join(' ')}
            style={selected && !disabled ? selectedStyle : undefined}
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
