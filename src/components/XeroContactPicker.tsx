import { useEffect, useState } from 'react'
import { Input } from '../design'
import { supabase } from '../lib/supabase'

// Xero customer picker for the Create order modal. Lets the designer search the
// org's Xero contacts (via the xero-search-contacts edge function) and choose
// which existing contact the paid invoice should file under, so invoices
// consolidate under the customer's Xero record instead of spawning a fresh
// contact from the payer. Leaving it blank = a new customer; Xero creates the
// contact and the webhook remembers it for next time (000275).
//
// Controlled: the parent owns the chosen {id,name} and pre-fills it from the
// customer's last order. Selecting still always goes through a live search, so
// the designer can override the pre-fill at any time.

export interface XeroContact {
  id: string
  name: string
}

interface SearchResult {
  id: string
  name: string
  email: string | null
}

interface Props {
  value: XeroContact | null
  onChange: (v: XeroContact | null) => void
  disabled?: boolean
  // Whether to show the "Leave blank — new customer" shortcut. Off when the
  // parent owns the new-vs-existing decision via its own toggle, so this picker
  // is purely "find the existing customer".
  allowNew?: boolean
}

export default function XeroContactPicker({ value, onChange, disabled, allowNew = true }: Props) {
  // Editing = showing the search box. Off by default when a value is set (we
  // show the chosen contact), on when there's nothing chosen yet.
  const [editing, setEditing] = useState(false)
  const [q, setQ] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [searched, setSearched] = useState(false)

  // Debounced Xero search. Two-character floor mirrors the edge function.
  useEffect(() => {
    const term = q.trim()
    if (term.length < 2) {
      setResults([])
      setSearched(false)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    const handle = window.setTimeout(() => {
      void supabase.functions
        .invoke<{ contacts?: SearchResult[]; error?: string }>('xero-search-contacts', { body: { q: term } })
        .then(({ data, error: fnErr }) => {
          if (cancelled) return
          if (fnErr || !data || data.error) {
            setError(data?.error ?? 'Couldn’t search Xero just now — you can still leave this blank.')
            setResults([])
          } else {
            setResults(data.contacts ?? [])
          }
          setSearched(true)
          setLoading(false)
        })
    }, 300)
    return () => {
      cancelled = true
      window.clearTimeout(handle)
    }
  }, [q])

  function pick(c: SearchResult) {
    onChange({ id: c.id, name: c.name })
    setEditing(false)
    setQ('')
    setResults([])
    setSearched(false)
    setError(null)
  }

  // ── Chosen state ──────────────────────────────────────────────────
  if (value && !editing) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-canvas px-3 py-2">
        <span className="min-w-0 truncate text-sm text-ink">
          <span className="text-ink-mute">Files under </span>
          <span className="font-medium">{value.name}</span>
        </span>
        <button
          type="button"
          onClick={() => {
            setEditing(true)
            setQ('')
          }}
          disabled={disabled}
          className="shrink-0 text-[13px] font-medium text-[var(--c-brand)] hover:underline disabled:opacity-50"
        >
          Change
        </button>
      </div>
    )
  }

  // ── Search state ──────────────────────────────────────────────────
  const showDropdown = q.trim().length >= 2 && (loading || searched || !!error)
  return (
    <div className="relative">
      <Input
        type="text"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search Xero customers by name or email…"
        disabled={disabled}
        autoComplete="off"
      />
      {showDropdown && (
        <div className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-line bg-white shadow-lg">
          {loading && <p className="px-3 py-2 text-[13px] text-ink-mute">Searching…</p>}
          {!loading && error && <p className="px-3 py-2 text-[13px] text-out">{error}</p>}
          {!loading && !error && results.length === 0 && (
            <p className="px-3 py-2 text-[13px] text-ink-mute">No matching Xero customers.</p>
          )}
          {!loading &&
            !error &&
            results.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => pick(c)}
                aria-label={`File this invoice under ${c.name}`}
                className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left hover:bg-canvas"
              >
                <span className="text-sm text-ink">{c.name}</span>
                {c.email && <span className="text-[12px] text-ink-mute">{c.email}</span>}
              </button>
            ))}
        </div>
      )}
      {(value || allowNew) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1">
          {value && (
            <button
              type="button"
              onClick={() => {
                setEditing(false)
                setQ('')
              }}
              className="text-[12px] text-ink-mute hover:underline"
            >
              Keep {value.name}
            </button>
          )}
          {allowNew && (
            <button
              type="button"
              onClick={() => {
                onChange(null)
                setEditing(false)
                setQ('')
              }}
              className="text-[12px] text-ink-mute hover:underline"
            >
              Leave blank — new customer (Xero creates it)
            </button>
          )}
        </div>
      )}
    </div>
  )
}
