import { useEffect, useState, type KeyboardEvent } from 'react'
import { formatPrice } from '../../lib/currency'
import type { Currency } from '../../lib/types'
import type { PriceTier } from '../../lib/quote/calculate'
import { stepTier } from '../../lib/quote/calculate'

// Free-typing quantity field with arrow-key tier stepping and
// snap-to-nearest hints when the typed value isn't a valid tier.
//
// Quantity flow:
// - Designer types digits. Each keystroke updates the value as a
//   plain integer (or null when blank). Backspace + retype always
//   works.
// - Up/Down arrow keys step through valid tiers for the current
//   variant + currency. Up from blank lands on the smallest tier;
//   up at the top of the range is a no-op.
// - When the typed value isn't a tier, the parent renders
//   "Snap to N (£X) · Snap to M (£Y)" chips below using the
//   QuoteResult.snap data. This component just owns the input;
//   the snap chips live on QuotePage so they can update the
//   shared selection state directly.
export function QuantityInput({
  value,
  onChange,
  variantTiers,
  currency,
  disabled = false,
}: {
  value: number | null
  onChange: (next: number | null) => void
  variantTiers: readonly PriceTier[]
  currency: Currency | null
  disabled?: boolean
}) {
  // Mirror state for the text representation. Lets the designer
  // clear the field without the parent's typed-integer state
  // collapsing the empty string back to "0". Synced one-way from
  // the parent value so external snaps (chip clicks, arrow keys
  // resolved by the parent) flow through.
  const [text, setText] = useState<string>(value == null ? '' : String(value))
  useEffect(() => {
    setText(value == null ? '' : String(value))
  }, [value])

  function handleChange(next: string) {
    // Strip everything except digits — paste of "1,500" or "1500 "
    // becomes "1500" without surprising the designer.
    const cleaned = next.replace(/[^0-9]/g, '')
    setText(cleaned)
    if (cleaned === '') {
      onChange(null)
    } else {
      const n = Number.parseInt(cleaned, 10)
      onChange(Number.isFinite(n) ? n : null)
    }
  }

  function handleKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      const stepped = stepTier(variantTiers, value, e.key === 'ArrowUp' ? 'up' : 'down')
      if (stepped != null) onChange(stepped)
    }
    // Enter does nothing — there's nothing to submit.
    if (e.key === 'Enter') e.preventDefault()
  }

  // Smallest tier sample for the placeholder. Just orientation —
  // helps the designer guess a starting number when the customer
  // says "I dunno, what do most people order?"
  const smallest = variantTiers[0]?.quantity
  const placeholder = smallest ? `e.g. ${smallest.toLocaleString()}` : 'Quantity'

  return (
    <fieldset>
      <legend className="mb-2 block text-xs font-semibold uppercase tracking-widest text-gray-400">
        Quantity
      </legend>
      <input
        type="text"
        inputMode="numeric"
        autoComplete="off"
        value={text}
        onChange={(e) => handleChange(e.target.value)}
        onKeyDown={handleKey}
        disabled={disabled || variantTiers.length === 0}
        placeholder={placeholder}
        aria-label="Quantity"
        className={[
          'w-40 rounded-lg border px-3 py-2 text-base font-medium tabular-nums',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:ring-offset-1',
          disabled || variantTiers.length === 0
            ? 'cursor-not-allowed border-gray-100 bg-gray-50 text-gray-400'
            : 'border-gray-200 bg-white text-gray-900 placeholder:text-gray-300',
        ].join(' ')}
      />
      {disabled ? (
        // External gate (no material or no currency). Replaces the
        // range caption since the latter can't be computed without
        // a currency anyway. Mirrors the price column's "Pick a
        // material, variant, currency and quantity..." prompt.
        <p className="mt-1.5 text-xs text-gray-400">
          Pick a material and currency to enable.
        </p>
      ) : currency && variantTiers.length > 0 ? (
        <p className="mt-1.5 text-xs text-gray-400">
          ↑/↓ to step through valid tiers ({variantTiers.length} available, {formatPrice(variantTiers[0].totalPrice, currency)} – {formatPrice(variantTiers[variantTiers.length - 1].totalPrice, currency)})
        </p>
      ) : null}
    </fieldset>
  )
}
