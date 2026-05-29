import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { formatPrice } from '../../lib/currency'
import type { Currency } from '../../lib/types'
import type { PriceTier } from '../../lib/quote/calculate'

// Chip-style multi-quantity input for the spread quote mode.
// Designer types digits, then commits each chip with Enter,
// comma, space, or Tab. Backspace on an empty input deletes
// the last chip.
//
// Validation runs per chip against the active variant's tier
// set. Chips that match a real tier render in violet; chips
// that don't render in amber and surface a "75 not listed"
// note plus two manual-swap buttons (lower / upper neighbour).
// Manual swap only — no auto-replace, per the brief.
//
// Soft cap at 15 quantities. Beyond that we surface a warning
// but accept the input — the upper bound is presentation
// friction, not a hard limit.
const SOFT_LIMIT = 15

export function SpreadQuantityInput({
  values,
  onChange,
  variantTiers,
  currency,
  disabled = false,
}: {
  values: number[]
  onChange: (next: number[]) => void
  variantTiers: readonly PriceTier[]
  currency: Currency | null
  disabled?: boolean
}) {
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Reset the draft when values clear externally — e.g. mode
  // toggle off+on. Avoids carrying a stale typed-but-uncommitted
  // value across mode switches.
  useEffect(() => {
    if (values.length === 0) setDraft('')
  }, [values])

  const tierQtySet = new Set(variantTiers.map((t) => t.quantity))
  const sortedTierQtys = [...tierQtySet].sort((a, b) => a - b)

  function commitDraft(raw: string): boolean {
    const cleaned = raw.replace(/[^0-9]/g, '')
    if (cleaned === '') return false
    const n = Number.parseInt(cleaned, 10)
    if (!Number.isFinite(n) || n <= 0) return false
    onChange([...values, n])
    return true
  }

  function handleKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',' || e.key === 'Tab') {
      // Tab without a draft falls through to the natural focus
      // shift; only intercept when the designer has typed
      // something so they can still tab out of an empty field.
      if (draft.trim() === '') {
        if (e.key !== 'Tab') e.preventDefault()
        return
      }
      e.preventDefault()
      if (commitDraft(draft)) setDraft('')
    } else if (e.key === ' ' && draft.trim() !== '') {
      e.preventDefault()
      if (commitDraft(draft)) setDraft('')
    } else if (e.key === 'Backspace' && draft === '' && values.length > 0) {
      e.preventDefault()
      onChange(values.slice(0, -1))
    }
  }

  function handleChange(next: string) {
    // Accept digits + comma + space; commit on punctuation so a
    // pasted "50, 100, 250, 500" resolves into four chips
    // without further keystrokes.
    if (/[,\s]/.test(next)) {
      const parts = next.split(/[,\s]+/).filter(Boolean)
      const nums: number[] = []
      let trailing = ''
      parts.forEach((p, i) => {
        const c = p.replace(/[^0-9]/g, '')
        if (c === '') return
        // If the original input ends with no separator, the last
        // part stays as the live draft.
        const endsWithSep = /[,\s]$/.test(next)
        const isLast = i === parts.length - 1
        if (!endsWithSep && isLast) {
          trailing = c
        } else {
          const n = Number.parseInt(c, 10)
          if (Number.isFinite(n) && n > 0) nums.push(n)
        }
      })
      if (nums.length > 0) onChange([...values, ...nums])
      setDraft(trailing)
    } else {
      setDraft(next.replace(/[^0-9]/g, ''))
    }
  }

  function removeAt(index: number) {
    onChange(values.filter((_, i) => i !== index))
  }

  function swapAt(index: number, replacement: number) {
    const next = [...values]
    next[index] = replacement
    onChange(next)
  }

  const overSoftLimit = values.length > SOFT_LIMIT
  const chrome = disabled || sortedTierQtys.length === 0
  const placeholder =
    values.length === 0
      ? sortedTierQtys[0]
        ? `e.g. ${sortedTierQtys[0]}, ${sortedTierQtys[1] ?? sortedTierQtys[0] * 2}, …`
        : 'Quantities'
      : ''

  return (
    <fieldset>
      <legend className="mb-2 block text-xs font-semibold uppercase tracking-widest text-ink-dim">
        Quantities
      </legend>
      <div
        className={[
          'flex flex-wrap items-center gap-1.5 rounded-md border px-2 py-2 text-sm transition-colors',
          'focus-within:ring-2 focus-within:ring-brand focus-within:ring-offset-1',
          chrome
            ? 'cursor-not-allowed border-line-soft bg-canvas'
            : 'border-line bg-surface',
        ].join(' ')}
        onClick={() => inputRef.current?.focus()}
      >
        {values.map((q, i) => {
          const valid = tierQtySet.has(q)
          return (
            <span
              key={`${q}-${i}`}
              className={[
                'inline-flex items-center gap-1 rounded px-2 py-1 text-sm font-medium tabular-nums',
                valid
                  ? 'bg-brand-50 text-brand ring-1 ring-brand-200'
                  : 'bg-low-soft text-low ring-1 ring-low',
              ].join(' ')}
            >
              {q.toLocaleString()}
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); removeAt(i) }}
                className={[
                  'rounded text-xs leading-none transition-colors',
                  valid ? 'text-brand hover:text-brand' : 'text-low hover:text-low',
                ].join(' ')}
                aria-label={`Remove ${q}`}
              >
                ×
              </button>
            </span>
          )
        })}
        <input
          ref={inputRef}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          value={draft}
          onChange={(e) => handleChange(e.target.value)}
          onKeyDown={handleKey}
          onBlur={() => { if (draft.trim()) { if (commitDraft(draft)) setDraft('') } }}
          disabled={chrome}
          placeholder={placeholder}
          aria-label="Add quantity"
          className={[
            'min-w-[6rem] flex-1 border-0 bg-transparent px-1 py-0.5 text-[17px] sm:text-[15px] outline-none',
            chrome ? 'text-ink-dim placeholder:text-ink-dim' : 'text-ink placeholder:text-ink-mute',
          ].join(' ')}
        />
      </div>
      {/* Captions: tier orientation when ready, gate hint when
          disabled, soft-limit warning when over 15. */}
      {chrome ? (
        <p className="mt-1.5 text-xs text-ink-dim">
          Pick a material and currency to enable.
        </p>
      ) : (
        <p className="mt-1.5 text-xs text-ink-dim">
          Press Enter, comma, or space to add. {sortedTierQtys.length} tiers available
          {currency
            ? ` (${formatPrice(variantTiers[0]?.totalPrice ?? 0, currency)} – ${formatPrice(variantTiers[variantTiers.length - 1]?.totalPrice ?? 0, currency)})`
            : null}.
        </p>
      )}
      {overSoftLimit && (
        <p className="mt-1.5 text-xs text-low">
          That's {values.length} quantities. Help Scout replies stay readable up to about {SOFT_LIMIT}.
        </p>
      )}

      {/* Inline manual-swap hints for not-listed quantities.
          One row per invalid chip, ordered as typed. Buttons
          replace that specific chip with a real tier — no
          auto-replace. */}
      {!chrome && currency && values.some((q) => !tierQtySet.has(q)) && (
        <ul className="mt-3 space-y-2">
          {values.map((q, i) => {
            if (tierQtySet.has(q)) return null
            let lower: number | null = null
            let upper: number | null = null
            for (const tq of sortedTierQtys) {
              if (tq < q) lower = tq
              else if (tq > q) { upper = tq; break }
            }
            const nearestText =
              lower != null && upper != null
                ? `nearest tiers are ${lower.toLocaleString()} and ${upper.toLocaleString()}`
                : lower != null
                  ? `nearest tier below is ${lower.toLocaleString()}`
                  : upper != null
                    ? `nearest tier above is ${upper.toLocaleString()}`
                    : 'no tiers in range'
            return (
              <li
                key={`warn-${q}-${i}`}
                className="rounded-lg border border-low bg-low-soft px-3 py-2 text-xs text-low"
              >
                <p>
                  <span className="font-semibold tabular-nums">{q.toLocaleString()}</span> not listed,{' '}
                  {nearestText}.
                </p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {lower != null && (
                    <button
                      type="button"
                      onClick={() => swapAt(i, lower!)}
                      className="rounded border border-low bg-surface px-2 py-1 text-xs font-medium text-low hover:bg-low-soft"
                    >
                      Swap to {lower.toLocaleString()}
                    </button>
                  )}
                  {upper != null && (
                    <button
                      type="button"
                      onClick={() => swapAt(i, upper!)}
                      className="rounded border border-low bg-surface px-2 py-1 text-xs font-medium text-low hover:bg-low-soft"
                    >
                      Swap to {upper.toLocaleString()}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => removeAt(i)}
                    className="rounded border border-low bg-surface px-2 py-1 text-xs font-medium text-low hover:bg-low-soft"
                  >
                    Remove
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </fieldset>
  )
}
