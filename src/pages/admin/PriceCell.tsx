import { useEffect, useState } from 'react'

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

  // Reset draft if the underlying value changes from a parent refresh.
  useEffect(() => { setDraft(value == null ? '' : String(value)) }, [value])

  async function handleBlur() {
    if (readOnly) return
    const trimmed = draft.trim()
    // Allow clearing back to the previous value (no-op)
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

  return (
    <div className="inline-flex items-center gap-2">
      <div className="relative">
        {showSymbol && (
          <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-gray-400">
            {currencySymbol(currency)}
          </span>
        )}
        <input
          type="number"
          step="0.01"
          min="0"
          value={draft}
          readOnly={readOnly}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={handleBlur}
          onFocus={(e) => e.currentTarget.select()}
          className={[
            'w-24 rounded border px-2 py-1 text-sm tabular-nums',
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
