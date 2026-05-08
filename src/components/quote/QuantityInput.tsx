import { useEffect, useState, type KeyboardEvent } from 'react'
import { formatPrice } from '../../lib/currency'
import type { Currency } from '../../lib/types'
import type { PriceTier } from '../../lib/quote/calculate'
import { stepTier } from '../../lib/quote/calculate'

// Hero quantity input — single-quantity mode's primary action on
// the compiler. Larger type, violet-tinted background, visible
// up/down stepper buttons, and a live "{qty} cards • {total}
// total ({unit} per card)" preview line. The hero treatment was
// driven by a real bug: the old quantity field looked identical
// to the unique-names field below it, and the designer kept
// typing quantities into Names. Bumping the visual weight of the
// quantity input fixes the contrast.
//
// Spread mode uses SpreadQuantityInput (chip-style) and is not
// affected by any of this.
//
// Total + unit-price preview values are passed in by the parent
// — they come from the same `calculate(...)` result the price
// column and CopyQuoteButton already use, so the preview can't
// drift from the headline.
//
// Quantity flow (unchanged):
// - Typing accepts digits, strips commas/spaces.
// - ArrowUp / ArrowDown step through valid tiers, same as
//   clicking the new chevron buttons.
// - Empty → null. Non-tier value → typed integer; the parent's
//   snap chips own the "you didn't pick a tier" nudge.
export function QuantityInput({
  value,
  onChange,
  variantTiers,
  currency,
  disabled = false,
  previewTotal,
  previewUnitPrice,
  previewValidTier,
}: {
  value: number | null
  onChange: (next: number | null) => void
  variantTiers: readonly PriceTier[]
  currency: Currency | null
  disabled?: boolean
  // Resolved total (base + finish + split-name) and per-card
  // unit price for the live preview line. Both null until the
  // parent's calculate() resolves a tier match. validTier is
  // the canonical "is this typed value an exact tier" gate so
  // the preview hides on free-typed non-tier numbers.
  previewTotal?: number | null
  previewUnitPrice?: number | null
  previewValidTier?: boolean
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

  function step(direction: 'up' | 'down') {
    const next = stepTier(variantTiers, value, direction)
    if (next != null) onChange(next)
  }

  function handleKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      step(e.key === 'ArrowUp' ? 'up' : 'down')
    }
    // Enter does nothing — there's nothing to submit.
    if (e.key === 'Enter') e.preventDefault()
  }

  // Smallest tier sample for the placeholder. Just orientation —
  // helps the designer guess a starting number when the customer
  // says "I dunno, what do most people order?"
  const smallest = variantTiers[0]?.quantity
  const placeholder = smallest ? `e.g. ${smallest.toLocaleString()}` : 'Quantity'

  // Stepper enable/disable: at the smallest tier, "down" is a
  // no-op (no smaller tier to land on); same for "up" at the
  // largest. With a null current value, both go somewhere
  // sensible (the smallest / largest).
  const sortedTiers = [...variantTiers].sort((a, b) => a.quantity - b.quantity)
  const minQty = sortedTiers[0]?.quantity ?? null
  const maxQty = sortedTiers[sortedTiers.length - 1]?.quantity ?? null
  const stepDownDisabled = disabled || variantTiers.length === 0 || (value != null && minQty != null && value <= minQty)
  const stepUpDisabled = disabled || variantTiers.length === 0 || (value != null && maxQty != null && value >= maxQty)

  // Live preview gating. Only render the preview line when:
  //   - quantity is non-null (otherwise: hide entirely)
  //   - parent's previewValidTier is true (otherwise: dim message)
  //   - currency + total + unit price all available
  // The existing helper line (range + ↑/↓ hint) renders below,
  // unaffected by the preview state.
  const showPreview =
    value != null &&
    !disabled &&
    currency != null &&
    previewValidTier &&
    previewTotal != null &&
    previewUnitPrice != null

  const showInvalidHint = value != null && !disabled && currency != null && previewValidTier === false

  return (
    <fieldset>
      <legend className="mb-2 block text-xs font-semibold uppercase tracking-widest text-gray-400">
        Quantity
      </legend>
      <div
        className={[
          // Hero shell: violet-tinted background, 2px violet border,
          // 10px radius. Width capped at 320px so it reads as the
          // primary action without dominating the column on wide
          // viewports. Slight box-shadow on focus-within so the
          // hero state is unmistakable.
          'relative flex max-w-[320px] items-stretch overflow-hidden rounded-[10px] border-2 transition-shadow',
          'focus-within:shadow-[0_0_0_3px_rgba(127,119,221,0.25)]',
          disabled || variantTiers.length === 0
            ? 'cursor-not-allowed border-gray-200 bg-gray-50'
            : 'border-[#7F77DD] bg-[#EEEDFE]',
        ].join(' ')}
      >
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
            // Hero-sized text. ~28px, weight 500, vertically centred.
            // Tabular nums so the cursor sits cleanly through digit
            // changes. Transparent background — colour comes from
            // the wrapper's tint.
            'min-w-0 flex-1 bg-transparent px-4 py-2.5 text-[28px] font-medium leading-tight tabular-nums',
            'focus:outline-none',
            disabled || variantTiers.length === 0
              ? 'cursor-not-allowed text-gray-400 placeholder:text-gray-300'
              : 'text-gray-900 placeholder:text-[#9994d6]',
          ].join(' ')}
        />
        {/* Stepper column on the right edge. Two stacked buttons,
            each ~24px tall, divided by a thin line. Same logic as
            keyboard ↑/↓ — single setQuantity entry point via
            step(). */}
        <div className="flex w-9 flex-col border-l border-[#7F77DD]/40">
          <button
            type="button"
            onClick={() => step('up')}
            disabled={stepUpDisabled}
            aria-label="Next quantity tier"
            className={[
              'flex h-1/2 items-center justify-center transition-colors',
              stepUpDisabled
                ? 'cursor-not-allowed text-gray-300'
                : 'text-[#5b2bba] hover:bg-[#dfdcfb]',
            ].join(' ')}
            tabIndex={-1}
          >
            <Chevron direction="up" />
          </button>
          <div className="h-px bg-[#7F77DD]/40" aria-hidden />
          <button
            type="button"
            onClick={() => step('down')}
            disabled={stepDownDisabled}
            aria-label="Previous quantity tier"
            className={[
              'flex h-1/2 items-center justify-center transition-colors',
              stepDownDisabled
                ? 'cursor-not-allowed text-gray-300'
                : 'text-[#5b2bba] hover:bg-[#dfdcfb]',
            ].join(' ')}
            tabIndex={-1}
          >
            <Chevron direction="down" />
          </button>
        </div>
      </div>

      {/* Live preview line. Shows only when the typed value is a
          valid tier and the parent has resolved total + unit. */}
      {showPreview && (
        <p className="mt-2 text-[15px] tabular-nums text-gray-700">
          <span className="font-medium">
            {value!.toLocaleString()} cards • {formatPrice(previewTotal!, currency!)} total
          </span>
          <span className="ml-2 text-gray-400">
            ({formatPrice(previewUnitPrice!, currency!, 2)} per card)
          </span>
        </p>
      )}

      {/* Invalid-tier dim line. The parent's snap chips still
          surface the nearest-tier suggestion below the price
          column; this line is just a quiet acknowledgement that
          the typed number doesn't resolve to a price. */}
      {showInvalidHint && (
        <p className="mt-2 text-[15px] text-gray-400">
          Not a valid tier
        </p>
      )}

      {/* Existing helper line — orientation, smaller and lower
          contrast than the preview above. Kept as-is so the
          designer can read off the available range at a glance. */}
      {disabled ? (
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

function Chevron({ direction }: { direction: 'up' | 'down' }) {
  return (
    <svg
      viewBox="0 0 12 12"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {direction === 'up' ? (
        <path d="M3 7.5l3-3 3 3" />
      ) : (
        <path d="M3 4.5l3 3 3-3" />
      )}
    </svg>
  )
}
