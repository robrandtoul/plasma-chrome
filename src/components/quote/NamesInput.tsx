import { useEffect, useState, type KeyboardEvent } from 'react'
import { formatPrice } from '../../lib/currency'
import type { Currency } from '../../lib/types'

// Split-name tooling input. Number of unique recipient names on
// the order. Default 1 ("everyone gets the same details") — at
// that value there's no surcharge and no breakdown line.
//
// Hidden by the parent entirely when the active material has no
// per-extra-name surcharge configured for the active currency.
// At commit 5 this covers wood, acrylic, paper standard, carbon
// fibre and CNC carbon.
//
// Same ergonomics as QuantityInput: free typing, ArrowUp/Down
// step by 1, Enter does nothing. Min 1, max capped at 50 to
// prevent absurd values from typos.
const MIN_NAMES = 1
const MAX_NAMES = 50

export function NamesInput({
  value,
  onChange,
  perExtraNameSurcharge,
  currency,
}: {
  value: number
  onChange: (next: number) => void
  perExtraNameSurcharge: number
  currency: Currency
}) {
  const [text, setText] = useState<string>(String(value))
  useEffect(() => { setText(String(value)) }, [value])

  function clamp(n: number): number {
    if (!Number.isFinite(n)) return MIN_NAMES
    return Math.max(MIN_NAMES, Math.min(MAX_NAMES, Math.floor(n)))
  }

  function handleChange(next: string) {
    const cleaned = next.replace(/[^0-9]/g, '')
    setText(cleaned)
    if (cleaned === '') {
      onChange(MIN_NAMES)
      return
    }
    const n = Number.parseInt(cleaned, 10)
    onChange(clamp(n))
  }

  function handleKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      onChange(clamp(value + 1))
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      onChange(clamp(value - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
    }
  }

  return (
    <fieldset>
      <legend className="mb-2 block text-xs font-semibold uppercase tracking-widest text-gray-400">
        Unique names
      </legend>
      <input
        type="text"
        inputMode="numeric"
        autoComplete="off"
        value={text}
        onChange={(e) => handleChange(e.target.value)}
        onKeyDown={handleKey}
        aria-label="Number of unique names"
        className={[
          'w-24 rounded-lg border px-3 py-2 text-[17px] sm:text-base font-medium tabular-nums',
          'border-gray-200 bg-white text-gray-900',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:ring-offset-1',
        ].join(' ')}
      />
      <p className="mt-1.5 text-xs text-gray-400">
        Each name beyond the first adds {formatPrice(perExtraNameSurcharge, currency)} for split-name tooling.
      </p>
    </fieldset>
  )
}
