import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { logAudit } from '../../lib/audit'

// Per-currency personalisation pricing editor (migration 000172).
// Three rows, one per currency, with a per-card rate plus a minimum
// charge. Both fields > 0 (DB check). Edits propagate immediately to
// every personalised proof — no snapshot, no version bump.
//
// Currencies are fixed (GBP / USD / EUR). The seed migration installs
// all three rows; designers and admins can read, only admins write
// (RLS). The component assumes the rows exist and treats a missing
// row as an error rather than offering an insert path — admins do
// not create currencies from the UI.

type Currency = 'GBP' | 'USD' | 'EUR'

interface PersonalisationRow {
  currency: Currency
  per_card_rate: number
  min_charge: number
}

const SYMBOL: Record<Currency, string> = {
  GBP: '£',
  USD: '$',
  EUR: '€',
}

const CURRENCIES: Currency[] = ['GBP', 'USD', 'EUR']

export default function PersonalisationPricingSection() {
  const [rows, setRows] = useState<Record<Currency, PersonalisationRow> | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Partial<Record<Currency, { rate: string; min: string }>>>({})
  const [errors, setErrors] = useState<Partial<Record<Currency, { rate?: string; min?: string }>>>({})
  const [working, setWorking] = useState<Partial<Record<Currency, boolean>>>({})
  const [savedAt, setSavedAt] = useState<Partial<Record<Currency, number>>>({})

  useEffect(() => {
    void load()
  }, [])

  async function load() {
    const { data, error } = await supabase
      .from('personalisation_pricing')
      .select('currency, per_card_rate, min_charge')
    if (error) {
      setLoadError(error.message)
      return
    }
    const map: Partial<Record<Currency, PersonalisationRow>> = {}
    for (const r of (data ?? []) as PersonalisationRow[]) {
      map[r.currency] = {
        currency: r.currency,
        per_card_rate: Number(r.per_card_rate),
        min_charge: Number(r.min_charge),
      }
    }
    if (!map.GBP || !map.USD || !map.EUR) {
      setLoadError('Personalisation pricing rows are missing. Re-run migration 000172.')
      return
    }
    setRows(map as Record<Currency, PersonalisationRow>)
  }

  function setDraft(c: Currency, field: 'rate' | 'min', value: string) {
    setDrafts((d) => ({
      ...d,
      [c]: { ...(d[c] ?? { rate: '', min: '' }), [field]: value },
    }))
    setErrors((e) => ({ ...e, [c]: { ...(e[c] ?? {}), [field]: undefined } }))
  }

  function parseAmount(raw: string): number | null {
    const trimmed = raw.trim()
    if (trimmed === '') return null
    if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null
    const n = parseFloat(trimmed)
    if (!Number.isFinite(n) || n <= 0) return null
    return Math.round(n * 100) / 100
  }

  async function saveField(c: Currency, field: 'rate' | 'min') {
    if (!rows) return
    const draft = drafts[c]
    if (!draft) return
    const raw = field === 'rate' ? draft.rate : draft.min
    if (raw === undefined) return
    const parsed = parseAmount(raw)
    if (parsed == null) {
      setErrors((e) => ({
        ...e,
        [c]: { ...(e[c] ?? {}), [field]: 'Must be greater than zero.' },
      }))
      return
    }
    const current = rows[c]
    const prevValue = field === 'rate' ? current.per_card_rate : current.min_charge
    if (parsed === prevValue) {
      setDrafts((d) => {
        const next = { ...d }
        if (next[c]) {
          next[c] = { ...next[c]!, [field]: field === 'rate' ? String(current.per_card_rate) : String(current.min_charge) }
        }
        return next
      })
      return
    }
    setWorking((w) => ({ ...w, [c]: true }))
    setErrors((e) => ({ ...e, [c]: { ...(e[c] ?? {}), [field]: undefined } }))
    const patch =
      field === 'rate'
        ? { per_card_rate: parsed, updated_at: new Date().toISOString() }
        : { min_charge: parsed, updated_at: new Date().toISOString() }
    const { error } = await supabase
      .from('personalisation_pricing')
      .update(patch)
      .eq('currency', c)
    setWorking((w) => ({ ...w, [c]: false }))
    if (error) {
      setErrors((e) => ({
        ...e,
        [c]: { ...(e[c] ?? {}), [field]: error.message },
      }))
      return
    }
    setRows((r) =>
      r
        ? {
            ...r,
            [c]: {
              ...r[c],
              ...(field === 'rate'
                ? { per_card_rate: parsed }
                : { min_charge: parsed }),
            },
          }
        : r,
    )
    setSavedAt((s) => ({ ...s, [c]: Date.now() }))
    void logAudit({
      action:
        field === 'rate'
          ? 'setting.personalisation_per_card_rate_updated'
          : 'setting.personalisation_min_charge_updated',
      targetType: 'setting',
      targetId: `personalisation_pricing.${c}`,
      targetLabel: `Personalisation pricing (${c})`,
      beforeValue: { [field === 'rate' ? 'per_card_rate' : 'min_charge']: prevValue, currency: c },
      afterValue: { [field === 'rate' ? 'per_card_rate' : 'min_charge']: parsed, currency: c },
    })
  }

  function recentlySaved(c: Currency): boolean {
    const t = savedAt[c]
    return !!t && Date.now() - t < 2000
  }

  return (
    <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-gray-200">
      <h3 className="mb-1 text-sm font-semibold text-gray-900">Personalisation pricing</h3>
      <p className="mb-4 text-xs text-gray-500">
        Rate per card and minimum charge for the membership-card personalisation add-on, per currency. Changes apply immediately to every personalised proof, including ones already created. Customer pages render today's live numbers, not the rate at the time the proof was created.
      </p>
      {loadError ? (
        <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700 ring-1 ring-rose-200">
          {loadError}
        </p>
      ) : !rows ? (
        <p className="text-sm text-gray-400">Loading…</p>
      ) : (
        <div className="space-y-4">
          {CURRENCIES.map((c) => {
            const row = rows[c]
            const draft = drafts[c]
            const rateValue = draft?.rate ?? String(row.per_card_rate)
            const minValue = draft?.min ?? String(row.min_charge)
            const rateError = errors[c]?.rate
            const minError = errors[c]?.min
            return (
              <div
                key={c}
                className="rounded-lg border border-gray-200 p-4"
              >
                <div className="mb-2 flex items-center gap-3">
                  <span className="inline-flex items-center rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-semibold text-gray-700">
                    {c}
                  </span>
                  {working[c] && <span className="text-xs text-gray-400">Saving…</span>}
                  {recentlySaved(c) && !working[c] && (
                    <span className="text-xs text-emerald-600">Saved</span>
                  )}
                </div>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-600">
                      Per card
                    </label>
                    <div className="relative">
                      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">
                        {SYMBOL[c]}
                      </span>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={rateValue}
                        onChange={(e) => setDraft(c, 'rate', e.target.value)}
                        onBlur={() => void saveField(c, 'rate')}
                        className={[
                          'w-full rounded-lg border px-3 py-2 pl-7 text-[17px] sm:text-sm focus:outline-none focus:ring-1',
                          rateError
                            ? 'border-rose-300 focus:border-rose-500 focus:ring-rose-300'
                            : 'border-gray-300 focus:border-gray-900 focus:ring-gray-900',
                        ].join(' ')}
                      />
                    </div>
                    {rateError && (
                      <p className="mt-1 text-xs text-rose-600">{rateError}</p>
                    )}
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-600">
                      Minimum charge
                    </label>
                    <div className="relative">
                      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">
                        {SYMBOL[c]}
                      </span>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={minValue}
                        onChange={(e) => setDraft(c, 'min', e.target.value)}
                        onBlur={() => void saveField(c, 'min')}
                        className={[
                          'w-full rounded-lg border px-3 py-2 pl-7 text-[17px] sm:text-sm focus:outline-none focus:ring-1',
                          minError
                            ? 'border-rose-300 focus:border-rose-500 focus:ring-rose-300'
                            : 'border-gray-300 focus:border-gray-900 focus:ring-gray-900',
                        ].join(' ')}
                      />
                    </div>
                    {minError && (
                      <p className="mt-1 text-xs text-rose-600">{minError}</p>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
