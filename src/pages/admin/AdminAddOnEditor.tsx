import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import PriceCell from './PriceCell'
import { downloadPricingExport } from '../../lib/pricingIO'
import { logAudit } from '../../lib/audit'

type Currency = 'GBP' | 'EUR' | 'USD'
const CURRENCIES: Currency[] = ['GBP', 'EUR', 'USD']

interface AddOn {
  id: string
  code: string
  display_name: string
  pricing_model: 'per_quantity_tier' | 'flat' | 'custom_quote'
  notes: string | null
}

interface Price {
  id: string
  add_on_id: string
  currency: Currency
  /** null for flat add-ons */
  quantity: number | null
  surcharge: number
}

export default function AdminAddOnEditor() {
  const { code } = useParams<{ code: string }>()
  const [addOn, setAddOn] = useState<AddOn | null>(null)
  const [prices, setPrices] = useState<Price[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [seedDialog, setSeedDialog] = useState(false)

  useEffect(() => { if (code) load(code) }, [code])

  async function load(addOnCode: string) {
    setLoading(true)
    setLoadError(null)
    try {
      const { data: aoData, error: aoErr } = await supabase
        .from('add_ons')
        .select('id, code, display_name, pricing_model, notes')
        .eq('code', addOnCode)
        .single()
      if (aoErr || !aoData) throw aoErr ?? new Error('Add-on not found')

      const { data: priceData, error: priceErr } = await supabase
        .from('add_on_prices')
        .select('id, add_on_id, currency, quantity, surcharge')
        .eq('add_on_id', aoData.id)
        .order('quantity')
      if (priceErr) throw priceErr

      setAddOn(aoData as AddOn)
      setPrices((priceData ?? []) as Price[])
    } catch (e) {
      setLoadError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  async function saveSurcharge(priceId: string, next: number) {
    const existing = prices.find((p) => p.id === priceId)
    const { error } = await supabase
      .from('add_on_prices')
      .update({ surcharge: next })
      .eq('id', priceId)
    if (error) throw new Error(error.message)
    setPrices((prev) => prev.map((p) => p.id === priceId ? { ...p, surcharge: next } : p))
    void logAudit({
      action: 'addon_price.updated',
      targetType: 'add_on_price',
      targetId: priceId,
      targetLabel: `${addOn?.display_name ?? ''} ${existing?.quantity == null ? 'flat' : `qty ${existing?.quantity}`} ${existing?.currency ?? ''}`,
      beforeValue: { currency: existing?.currency, quantity: existing?.quantity ?? null, surcharge: existing?.surcharge ?? null },
      afterValue: { currency: existing?.currency, quantity: existing?.quantity ?? null, surcharge: next },
    })
  }

  async function seedQuantities(quantities: number[]) {
    if (!addOn) return
    const rows = quantities.flatMap((qty) => CURRENCIES.map((currency) => ({
      add_on_id: addOn.id,
      currency,
      quantity: qty,
      surcharge: 0,
    })))
    const { data, error } = await supabase
      .from('add_on_prices')
      .insert(rows)
      .select()
    if (error) throw new Error(error.message)
    setPrices((prev) => [...prev, ...((data ?? []) as Price[])])
    setSeedDialog(false)
    void logAudit({
      action: 'addon_prices.seeded',
      targetType: 'add_on',
      targetId: addOn.id,
      targetLabel: addOn.display_name,
      metadata: { quantities, rows_created: rows.length, pricing_model: 'per_quantity_tier' },
    })
  }

  async function seedFlat() {
    if (!addOn) return
    const rows = CURRENCIES.map((currency) => ({
      add_on_id: addOn.id,
      currency,
      quantity: null,
      surcharge: 0,
    }))
    const { data, error } = await supabase
      .from('add_on_prices')
      .insert(rows)
      .select()
    if (error) throw new Error(error.message)
    setPrices((prev) => [...prev, ...((data ?? []) as Price[])])
    void logAudit({
      action: 'addon_prices.seeded',
      targetType: 'add_on',
      targetId: addOn.id,
      targetLabel: addOn.display_name,
      metadata: { rows_created: rows.length, pricing_model: 'flat' },
    })
  }

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-200 border-t-gray-900" />
      </div>
    )
  }
  if (loadError || !addOn) {
    return (
      <div className="rounded-2xl bg-rose-50 p-6 text-sm text-rose-700 ring-1 ring-rose-200">
        Failed to load add-on: {loadError ?? 'not found'}
      </div>
    )
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link to="/admin/pricing" className="text-xs text-gray-400 hover:text-gray-700">← Back to pricing</Link>
          <h2 className="mt-2 text-xl font-bold text-gray-900">{addOn.display_name}</h2>
          {addOn.notes && <p className="mt-1 max-w-xl text-xs text-gray-500">{addOn.notes}</p>}
          <p className="mt-2 text-sm text-gray-500">
            Changes save automatically. Customer-facing prices update immediately.
          </p>
        </div>
        {addOn.pricing_model !== 'custom_quote' && (
          <button
            onClick={() => downloadPricingExport(`addon:${addOn.code}`, `pricing_addon_${addOn.code}.csv`).catch(() => {})}
            className="shrink-0 rounded-lg px-3 py-2 text-sm font-medium text-gray-600 ring-1 ring-gray-200 hover:bg-gray-50"
          >
            Export this add-on
          </button>
        )}
      </div>

      {/* Editor — branches by pricing_model */}
      {addOn.pricing_model === 'custom_quote' ? (
        <div className="rounded-2xl bg-white p-6 text-sm text-gray-500 shadow-sm ring-1 ring-gray-200">
          Pricing for this add-on is custom. No editor available.
        </div>
      ) : addOn.pricing_model === 'flat' ? (
        <FlatEditor
          prices={prices}
          onSave={saveSurcharge}
          onSeed={seedFlat}
        />
      ) : (
        <PerTierEditor
          prices={prices}
          onSave={saveSurcharge}
          onOpenSeed={() => setSeedDialog(true)}
        />
      )}

      {seedDialog && (
        <SeedQuantitiesDialog
          onSeed={seedQuantities}
          onCancel={() => setSeedDialog(false)}
        />
      )}
    </div>
  )
}

// ── Flat surcharge editor ────────────────────────────────────────────────────

function FlatEditor({ prices, onSave, onSeed }: {
  prices: Price[]
  onSave: (priceId: string, next: number) => Promise<void>
  onSeed: () => Promise<void>
}) {
  const byCurrency = new Map<Currency, Price>()
  for (const p of prices) if (p.quantity == null) byCurrency.set(p.currency as Currency, p)

  const anyPresent = byCurrency.size > 0

  if (!anyPresent) {
    return (
      <EmptyState label="No flat surcharges set yet." actionLabel="Add prices" onClick={onSeed} />
    )
  }

  return (
    <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-gray-200">
      <h3 className="text-sm font-semibold text-gray-900">Flat surcharge</h3>
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
        {CURRENCIES.map((c) => {
          const p = byCurrency.get(c)
          if (!p) return (
            <div key={c}>
              <label className="block text-xs font-medium uppercase tracking-wide text-gray-400">
                {c} {c === 'GBP' ? '(inc VAT)' : '(ex VAT)'}
              </label>
              <p className="mt-1 text-sm text-gray-300">—</p>
            </div>
          )
          return (
            <div key={c}>
              <label className="block text-xs font-medium uppercase tracking-wide text-gray-400">
                {c} {c === 'GBP' ? '(inc VAT)' : '(ex VAT)'}
              </label>
              <div className="mt-1">
                <PriceCell
                  value={p.surcharge}
                  currency={c}
                  onSave={(next) => onSave(p.id, next)}
                />
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

// ── Per-quantity-tier editor ────────────────────────────────────────────────

function PerTierEditor({ prices, onSave, onOpenSeed }: {
  prices: Price[]
  onSave: (priceId: string, next: number) => Promise<void>
  onOpenSeed: () => void
}) {
  const byQty = useMemo(() => {
    const map = new Map<number, Partial<Record<Currency, Price>>>()
    for (const p of prices) {
      if (p.quantity == null) continue
      const row = map.get(p.quantity) ?? {}
      row[p.currency as Currency] = p
      map.set(p.quantity, row)
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0])
  }, [prices])

  if (byQty.length === 0) {
    return (
      <EmptyState label="No prices set yet for this add-on." actionLabel="Add prices" onClick={onOpenSeed} />
    )
  }

  return (
    <section className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-gray-200">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-100">
            <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Qty</th>
            {CURRENCIES.map((c) => (
              <th key={c} className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">
                {c} {c === 'GBP' ? '(inc VAT)' : '(ex VAT)'}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {byQty.map(([qty, row]) => (
            <tr key={qty} className="border-b border-gray-50 last:border-0">
              <td className="px-4 py-2 font-medium text-gray-900 tabular-nums">{qty.toLocaleString()}</td>
              {CURRENCIES.map((c) => {
                const p = row[c]
                return (
                  <td key={`${qty}-${c}`} className="px-4 py-2">
                    {p ? (
                      <PriceCell value={p.surcharge} currency={c} onSave={(next) => onSave(p.id, next)} />
                    ) : (
                      <span className="text-gray-300">—</span>
                    )}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

// ── Empty state & seed dialog ────────────────────────────────────────────────

function EmptyState({ label, actionLabel, onClick }: {
  label: string
  actionLabel: string
  onClick: () => void
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl bg-white py-12 text-center shadow-sm ring-1 ring-gray-200">
      <p className="text-sm text-gray-500">{label}</p>
      <button
        onClick={onClick}
        className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-700"
      >
        {actionLabel}
      </button>
    </div>
  )
}

function SeedQuantitiesDialog({ onSeed, onCancel }: {
  onSeed: (quantities: number[]) => Promise<void>
  onCancel: () => void
}) {
  const [raw, setRaw] = useState('100, 250, 500, 750, 1000')
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const parts = raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)
    const nums: number[] = []
    for (const p of parts) {
      const n = parseInt(p, 10)
      if (isNaN(n) || n <= 0) { setError(`Invalid quantity: "${p}"`); return }
      if (!nums.includes(n)) nums.push(n)
    }
    if (nums.length === 0) { setError('Enter at least one quantity'); return }
    nums.sort((a, b) => a - b)

    setError(null)
    setWorking(true)
    try {
      await onSeed(nums)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setWorking(false)
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/50" onClick={() => !working && onCancel()} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <form onSubmit={handleSubmit} className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
          <h3 className="text-lg font-semibold text-gray-900">Add prices</h3>
          <p className="mt-1 text-xs text-gray-500">
            Enter the quantity tiers to seed, comma-separated. All three currencies start at £0 / €0 / $0 — edit each cell afterwards.
          </p>
          <div className="mt-4">
            <label className="block text-xs font-medium uppercase tracking-wide text-gray-400">Quantities</label>
            <input
              autoFocus
              type="text"
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900"
              placeholder="100, 250, 500, 750, 1000"
            />
          </div>
          {error && <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>}
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              disabled={working}
              className="rounded-lg px-4 py-2 text-sm font-medium text-gray-500 hover:bg-gray-100 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={working}
              className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-700 disabled:opacity-50"
            >
              {working ? 'Seeding…' : 'Seed tiers'}
            </button>
          </div>
        </form>
      </div>
    </>
  )
}
