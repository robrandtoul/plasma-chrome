import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { logAudit } from '../../lib/audit'

// Admin: the flat prototyping-service fee per material family + currency.
//
// Migration 000287 adds proofs.prototype_prices (keyed by family + currency).
// The prototyping service charges a flat fee for up to three exact copies of an
// approved design — NOT the per-quantity price grid. create-order resolves the
// fee from here at order time, so a change applies immediately with no redeploy.
//
// Eligibility is admin-controlled too: a family is orderable only when it's
// marked "Offered" AND has a price in each currency. Metal / carbon fibre /
// acrylic / wood ship offered; paper / plastic ship off, so they can be
// switched on here later without a code change.
//
// GBP figures are VAT-inclusive; EUR / USD are VAT-free (the convention used
// everywhere in this app — those currencies are only used outside the UK).

type Currency = 'GBP' | 'EUR' | 'USD'
const CURRENCIES: Currency[] = ['GBP', 'EUR', 'USD']

// Render order + human labels. The keys match materials.category exactly.
const FAMILY_LABELS: { family: string; label: string }[] = [
  { family: 'metal', label: 'Metal' },
  { family: 'carbon_fibre', label: 'Carbon fibre' },
  { family: 'acrylic', label: 'Acrylic' },
  { family: 'wood', label: 'Wood' },
  { family: 'paper', label: 'Paper' },
  { family: 'plastic', label: 'Plastic' },
]

interface PriceRow {
  family: string
  currency: string
  amount: number | null
  is_active: boolean
}

interface FamilyDraft {
  active: boolean
  amounts: Record<Currency, string>
}

function emptyDraft(): FamilyDraft {
  return { active: false, amounts: { GBP: '', EUR: '', USD: '' } }
}

export default function AdminPrototypePricesPage() {
  const [rows, setRows] = useState<PriceRow[]>([])
  const [drafts, setDrafts] = useState<Record<string, FamilyDraft>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  useEffect(() => { void load() }, [])

  async function load() {
    setLoading(true)
    setError(null)
    const { data, error: err } = await supabase
      .from('prototype_prices')
      .select('family, currency, amount, is_active')
    setLoading(false)
    if (err) {
      setError(err.message)
      return
    }
    const list = (data ?? []) as PriceRow[]
    setRows(list)
    const byFamily: Record<string, FamilyDraft> = {}
    for (const { family } of FAMILY_LABELS) byFamily[family] = emptyDraft()
    for (const r of list) {
      const d = byFamily[r.family] ?? emptyDraft()
      d.active = r.is_active
      if (CURRENCIES.includes(r.currency as Currency)) {
        d.amounts[r.currency as Currency] = r.amount != null ? String(r.amount) : ''
      }
      byFamily[r.family] = d
    }
    setDrafts(byFamily)
  }

  // Original (stored) view, for dirty-checking + the audit before/after.
  const stored = useMemo(() => {
    const byFamily: Record<string, FamilyDraft> = {}
    for (const { family } of FAMILY_LABELS) byFamily[family] = emptyDraft()
    for (const r of rows) {
      const d = byFamily[r.family] ?? emptyDraft()
      d.active = r.is_active
      if (CURRENCIES.includes(r.currency as Currency)) {
        d.amounts[r.currency as Currency] = r.amount != null ? String(r.amount) : ''
      }
      byFamily[r.family] = d
    }
    return byFamily
  }, [rows])

  function familyDirty(family: string): boolean {
    const d = drafts[family]
    const s = stored[family]
    if (!d || !s) return false
    if (d.active !== s.active) return true
    return CURRENCIES.some((c) => d.amounts[c].trim() !== s.amounts[c].trim())
  }

  const dirtyFamilies = FAMILY_LABELS.filter((f) => familyDirty(f.family)).map((f) => f.family)

  // Validation: an offered family must have a positive price in every currency.
  function familyError(family: string): string | null {
    const d = drafts[family]
    if (!d) return null
    if (!d.active) return null
    for (const c of CURRENCIES) {
      const v = d.amounts[c].trim()
      if (v === '') return `Enter a ${c} price (offered families need a price in every currency).`
      const n = Number(v)
      if (!Number.isFinite(n) || n <= 0) return `${c} price must be greater than zero.`
    }
    return null
  }

  const firstError = dirtyFamilies.map(familyError).find((e) => e != null) ?? null
  const saveDisabled = saving || dirtyFamilies.length === 0 || firstError != null

  function setActive(family: string, active: boolean) {
    setDrafts((d) => ({ ...d, [family]: { ...(d[family] ?? emptyDraft()), active } }))
    if (savedAt != null) setSavedAt(null)
  }
  function setAmount(family: string, currency: Currency, value: string) {
    setDrafts((d) => {
      const cur = d[family] ?? emptyDraft()
      return { ...d, [family]: { ...cur, amounts: { ...cur.amounts, [currency]: value } } }
    })
    if (savedAt != null) setSavedAt(null)
  }

  async function handleSave() {
    if (saveDisabled) return
    setSaving(true)
    setError(null)

    // One UPDATE per (family, currency) for each dirty family. The 18 rows are
    // seeded in 000287 and the table grants UPDATE only (no insert), so we only
    // ever update existing rows.
    const updates: { family: string; currency: Currency; amount: number | null; is_active: boolean }[] = []
    for (const family of dirtyFamilies) {
      const d = drafts[family]
      for (const c of CURRENCIES) {
        const raw = d.amounts[c].trim()
        const amount = raw === '' ? null : Math.round(Number(raw) * 100) / 100
        updates.push({ family, currency: c, amount, is_active: d.active })
      }
    }

    const results = await Promise.all(
      updates.map((u) =>
        supabase
          .from('prototype_prices')
          .update({ amount: u.amount, is_active: u.is_active, updated_at: new Date().toISOString() })
          .eq('family', u.family)
          .eq('currency', u.currency),
      ),
    )
    const failed = results.find((r) => r.error)?.error ?? null
    if (failed) {
      setError(`Failed to save: ${failed.message}`)
      setSaving(false)
      return
    }

    void logAudit({
      action: 'prototype_prices.updated',
      targetType: 'prototype_prices',
      targetLabel: dirtyFamilies.length === 1
        ? FAMILY_LABELS.find((f) => f.family === dirtyFamilies[0])?.label ?? dirtyFamilies[0]
        : `${dirtyFamilies.length} families`,
      metadata: {
        changes: dirtyFamilies.map((family) => ({
          family,
          before: stored[family],
          after: drafts[family],
        })),
      },
    })

    setSaving(false)
    setSavedAt(Date.now())
    await load()
  }

  const recentlySaved = savedAt != null && Date.now() - savedAt < 2000

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-ink">Prototype prices</h2>
        <p className="mt-1 text-sm text-ink-mute">
          The flat prototyping-service fee — up to three exact copies of an approved design — per material family. Charged instead of the per-quantity price grid; shipping is added on top. Changes apply immediately to new prototype orders, with no redeploy.
        </p>
        <p className="mt-2 text-xs text-ink-dim">
          GBP is VAT-inclusive; EUR and USD are VAT-free. A family is only orderable as a prototype when it's marked “Offered” and has a price in every currency. Paper and plastic ship off — switch them on here once you've set a price. The service is internal-only and never shown on customer-facing pages.
        </p>
      </div>

      {error && (
        <div className="rounded-lg bg-out-soft px-3 py-2 text-sm text-out ring-1 ring-out">{error}</div>
      )}

      {loading ? (
        <div className="flex justify-center py-20">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-line border-t-gray-900" />
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl bg-surface shadow-sm ring-1 ring-line">
          <table className="min-w-full divide-y divide-line-soft">
            <thead>
              <tr className="bg-canvas text-left text-xs font-semibold uppercase tracking-widest text-ink-mute">
                <th className="px-5 py-3">Material family</th>
                <th className="px-5 py-3">Offered</th>
                <th className="px-5 py-3">GBP (inc VAT)</th>
                <th className="px-5 py-3">EUR</th>
                <th className="px-5 py-3">USD</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-soft text-sm">
              {FAMILY_LABELS.map(({ family, label }) => {
                const d = drafts[family] ?? emptyDraft()
                const dirty = familyDirty(family)
                const fErr = familyError(family)
                return (
                  <tr key={family} className={dirty ? 'bg-low-soft' : ''}>
                    <td className="px-5 py-3 align-top font-medium text-ink">{label}</td>
                    <td className="px-5 py-3 align-top">
                      <label className="inline-flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={d.active}
                          onChange={(e) => setActive(family, e.target.checked)}
                          className="h-4 w-4 rounded border-line"
                        />
                        <span className="text-ink-soft">{d.active ? 'Offered' : 'Off'}</span>
                      </label>
                    </td>
                    {CURRENCIES.map((c) => (
                      <td key={c} className="px-5 py-3 align-top">
                        <input
                          type="number"
                          min={0}
                          step={0.01}
                          inputMode="decimal"
                          value={d.amounts[c]}
                          onChange={(e) => setAmount(family, c, e.target.value)}
                          placeholder="—"
                          aria-label={`${label} ${c} prototype price`}
                          className="w-28 rounded border border-line px-3 py-2 text-[17px] sm:text-sm focus:border-[var(--c-brand)] focus:bg-[var(--c-brand-50)] focus:outline-none"
                        />
                      </td>
                    ))}
                    {fErr && dirty && (
                      <td className="px-5 py-1 text-xs text-out" colSpan={5}>{fErr}</td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center justify-end gap-3">
        {firstError && <span className="text-xs text-out">{firstError}</span>}
        {recentlySaved && !saving && !firstError && <span className="text-xs text-in-stock">Saved</span>}
        {saving && <span className="text-xs text-ink-dim">Saving…</span>}
        <button
          type="button"
          onClick={handleSave}
          disabled={saveDisabled}
          className="rounded bg-ink px-4 py-2 text-sm font-semibold text-on-ink hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:opacity-40"
        >
          {dirtyFamilies.length === 0
            ? 'Save changes'
            : `Save changes (${dirtyFamilies.length} ${dirtyFamilies.length === 1 ? 'family' : 'families'})`}
        </button>
      </div>
    </div>
  )
}
