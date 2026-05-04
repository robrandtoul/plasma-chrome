import { useEffect, useRef, useState, type KeyboardEvent } from 'react'

// ── Currency symbol helper ───────────────────────────────────────────────────

export function currencySymbol(currency: 'GBP' | 'EUR' | 'USD'): string {
  if (currency === 'GBP') return '£'
  if (currency === 'EUR') return '€'
  return '$'
}

// ── PriceCell ────────────────────────────────────────────────────────────────
//
// Inline-editable price input with optimistic saves: the DOM reflects the
// change immediately, we persist on blur, show a transient "Saved" pill on
// success, and revert the draft + surface a short error if the server
// rejects the update.

interface Props {
  value: number | null
  currency: 'GBP' | 'EUR' | 'USD'
  onSave: (next: number) => Promise<void>
  placeholder?: string
  readOnly?: boolean
  /** Always show the currency symbol prefix, even in a read-only cell. */
  showSymbol?: boolean
}

export default function PriceCell({ value, currency, onSave, placeholder, readOnly, showSymbol = true }: Props) {
  const [draft, setDraft] = useState<string>(value == null ? '' : String(value))
  const [saving, setSaving] = useState(false)
  const [justSaved, setJustSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Tracks whether the most recent focus came from a mouse press
  // (in which case we leave the click-to-position alone) vs Tab
  // keyboard focus (in which case selecting all matches the
  // existing convenient overwrite behaviour).
  const focusFromMouseRef = useRef(false)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Reset draft if the underlying value changes from a parent refresh.
  useEffect(() => { setDraft(value == null ? '' : String(value)) }, [value])

  async function commit() {
    if (readOnly) return
    const trimmed = draft.trim()
    // Empty input on a previously-empty cell is a no-op.
    if (trimmed === '' && value == null) return
    const parsed = parseFloat(trimmed)
    if (isNaN(parsed) || parsed < 0) {
      setError('Invalid')
      setDraft(value == null ? '' : String(value))
      setTimeout(() => setError(null), 2000)
      return
    }
    if (value != null && parsed === value) return
    setSaving(true)
    setError(null)
    try {
      await onSave(parsed)
      setSaving(false)
      setJustSaved(true)
      setTimeout(() => setJustSaved(false), 1200)
    } catch (e) {
      setSaving(false)
      setError((e as Error).message || 'Save failed')
      setDraft(value == null ? '' : String(value))
      setTimeout(() => setError(null), 3000)
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      // Blur to commit so the focus ring drops; commit() runs via
      // onBlur. Using blur (not direct commit) keeps the existing
      // "saved/error pill" timing consistent across both paths.
      inputRef.current?.blur()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      // Revert the draft to the saved value and bail out without
      // calling commit on the way out.
      setDraft(value == null ? '' : String(value))
      inputRef.current?.blur()
    }
  }

  return (
    <div className="inline-flex items-center gap-2">
      <div className="relative">
        {showSymbol && (
          <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-gray-400">
            {currencySymbol(currency)}
          </span>
        )}
        <input
          ref={inputRef}
          type="number"
          step="0.01"
          min="0"
          value={draft}
          readOnly={readOnly}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => { focusFromMouseRef.current = false; void commit() }}
          onMouseDown={() => { focusFromMouseRef.current = true }}
          onFocus={(e) => {
            // Only auto-select when the user tabbed in. Mouse focus
            // should leave the cursor where they clicked so cents
            // can be edited without a select-all-on-focus reset.
            if (!focusFromMouseRef.current) e.currentTarget.select()
          }}
          onKeyDown={handleKeyDown}
          className={[
            'w-24 rounded border px-2 py-1 text-[17px] sm:text-sm tabular-nums',
            showSymbol ? 'pl-5' : '',
            error
              ? 'border-rose-300 focus:border-rose-500 focus:outline-none'
              : 'border-gray-200 focus:border-gray-900 focus:outline-none',
            readOnly ? 'cursor-default bg-gray-50 text-gray-500' : '',
          ].join(' ')}
        />
      </div>
      {saving && <span className="text-xs text-gray-400">Saving…</span>}
      {justSaved && <span className="text-xs text-emerald-600">Saved</span>}
      {error && <span className="text-xs text-rose-600">{error}</span>}
    </div>
  )
}
