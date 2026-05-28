import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import PriceCell, { currencySymbol } from './PriceCell'
import Modal from '../../components/Modal'
import { downloadPricingExport } from '../../lib/pricingIO'
import { logAudit } from '../../lib/audit'
import { MATERIAL_OPTION_BACKED_ADDONS, resolveBackingOptionIds } from './backedAddons'

type Currency = 'GBP' | 'EUR' | 'USD'
const CURRENCIES: Currency[] = ['GBP', 'EUR', 'USD']

// Add-ons whose tiers must align with their parent materials' price-tier
// quantities. The "Add tier" inline form constrains its quantity picker to
// `union(parent qtys) - existing add-on qtys` so we can't write a
// surcharge row at a quantity nobody can order.
const PARENT_MATERIAL_CODES_BY_ADDON: Record<string, string[]> = {
  metal_finish_upgrade: ['metal_steel', 'metal_gold'],
}

// Note: MATERIAL_OPTION_BACKED_ADDONS and resolveBackingOptionIds
// live in ./backedAddons.ts so the admin pricing index can share
// the same source of truth when computing the "Needs pricing"
// badge.

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
  const [parentQuantities, setParentQuantities] = useState<number[]>([])
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

      // Branch the data layer for material-option-backed add-ons.
      // For those, we read material_option_surcharges and synthesize
      // a Price[] keyed by (currency, quantity) — one synthetic row
      // per cell rather than per underlying option_id. Caller edits
      // one cell; the save fans out to every backing option_id.
      let priceData: Price[] = []
      if (MATERIAL_OPTION_BACKED_ADDONS[aoData.code]) {
        const optIds = await resolveBackingOptionIds(aoData.code)
        if (optIds.length === 0) {
          throw new Error(`No material_option rows found for add-on ${aoData.code}`)
        }
        const { data: rows, error: rowErr } = await supabase
          .from('material_option_surcharges')
          .select('material_option_id, currency, quantity, surcharge')
          .in('material_option_id', optIds)
          .order('quantity')
        if (rowErr) throw rowErr
        // Group by (currency, quantity) and surface one synthetic
        // Price per group. The four backing rows are identically
        // priced (verified in the pre-implementation audit), so we
        // pick the first row's surcharge as canonical.
        const byKey = new Map<string, number>()
        for (const r of (rows ?? []) as Array<{ currency: string; quantity: number; surcharge: number }>) {
          const k = `${r.currency}|${r.quantity}`
          if (!byKey.has(k)) byKey.set(k, Number(r.surcharge))
        }
        priceData = [...byKey.entries()].map(([k, surcharge]) => {
          const [currency, qty] = k.split('|')
          return {
            id: `mos:${k}`,
            add_on_id: aoData.id,
            currency: currency as Currency,
            quantity: Number(qty),
            surcharge,
          }
        }).sort((a, b) => (a.quantity ?? 0) - (b.quantity ?? 0))
      } else {
        const { data, error } = await supabase
          .from('add_on_prices')
          .select('id, add_on_id, currency, quantity, surcharge')
          .eq('add_on_id', aoData.id)
          .order('quantity')
        if (error) throw error
        priceData = (data ?? []) as Price[]
      }

      const parentCodes = PARENT_MATERIAL_CODES_BY_ADDON[aoData.code] ?? []
      let parentQtys: number[] = []
      if (parentCodes.length > 0) {
        // Pull every distinct quantity present in price_tiers across all
        // variants of the parent materials. Steel and Gold ship with
        // identical 39-tier schedules today, but querying the union is
        // future-proof if they ever diverge.
        const { data: parentData, error: parentErr } = await supabase
          .from('materials')
          .select('material_variants(price_tiers(quantity))')
          .in('code', parentCodes)
        if (parentErr) throw parentErr
        const set = new Set<number>()
        for (const m of (parentData ?? []) as Array<{ material_variants: Array<{ price_tiers: Array<{ quantity: number }> }> }>) {
          for (const v of m.material_variants ?? []) {
            for (const t of v.price_tiers ?? []) set.add(t.quantity)
          }
        }
        parentQtys = [...set].sort((a, b) => a - b)
      }

      setAddOn(aoData as AddOn)
      setPrices(priceData)
      setParentQuantities(parentQtys)
    } catch (e) {
      setLoadError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  async function createTier(quantity: number, gbp: number, eur: number, usd: number) {
    if (!addOn) return
    if (MATERIAL_OPTION_BACKED_ADDONS[addOn.code]) {
      // Fan out to every backing option_id × 3 currencies — 12 rows
      // for Mirror/Brushed (Steel + Gold). Editing the synthesised
      // single cell keeps all four schedules in lockstep.
      const optIds = await resolveBackingOptionIds(addOn.code)
      const rows = optIds.flatMap((oid) => [
        { material_option_id: oid, currency: 'GBP' as const, quantity, surcharge: gbp },
        { material_option_id: oid, currency: 'EUR' as const, quantity, surcharge: eur },
        { material_option_id: oid, currency: 'USD' as const, quantity, surcharge: usd },
      ])
      const { error } = await supabase.from('material_option_surcharges').insert(rows)
      if (error) throw new Error(error.message)
      // Append synthetic UI rows — one per (currency, quantity).
      const synthetic: Price[] = (['GBP', 'EUR', 'USD'] as const).map((c, i) => ({
        id: `mos:${c}|${quantity}`,
        add_on_id: addOn.id,
        currency: c,
        quantity,
        surcharge: i === 0 ? gbp : i === 1 ? eur : usd,
      }))
      setPrices((prev) => [...prev, ...synthetic])
      void logAudit({
        action: 'option_surcharges.metal_finish.tier_created',
        targetType: 'add_on',
        targetId: addOn.id,
        targetLabel: `${addOn.display_name} qty ${quantity}`,
        metadata: { quantity, gbp, eur, usd, applies_to_options: optIds.length, rows_created: rows.length },
      })
      return
    }
    const rows = [
      { add_on_id: addOn.id, currency: 'GBP' as const, quantity, surcharge: gbp },
      { add_on_id: addOn.id, currency: 'EUR' as const, quantity, surcharge: eur },
      { add_on_id: addOn.id, currency: 'USD' as const, quantity, surcharge: usd },
    ]
    const { data, error } = await supabase
      .from('add_on_prices')
      .insert(rows)
      .select()
    if (error) throw new Error(error.message)
    setPrices((prev) => [...prev, ...((data ?? []) as Price[])])
    void logAudit({
      action: 'addon_prices.tier_created',
      targetType: 'add_on',
      targetId: addOn.id,
      targetLabel: `${addOn.display_name} qty ${quantity}`,
      metadata: { quantity, gbp, eur, usd },
    })
  }

  async function saveSurcharge(priceId: string, next: number | null) {
    const existing = prices.find((p) => p.id === priceId)
    // Synthetic row from the material-option-backed branch. Save
    // fans out to every backing option_id at the matching (currency,
    // quantity); delete fans out the same way.
    if (priceId.startsWith('mos:') && addOn) {
      const [, coord] = priceId.split(':')
      const [currency, qtyStr] = coord.split('|')
      const quantity = Number(qtyStr)
      const optIds = await resolveBackingOptionIds(addOn.code)
      if (next == null) {
        const { error } = await supabase
          .from('material_option_surcharges')
          .delete()
          .in('material_option_id', optIds)
          .eq('currency', currency)
          .eq('quantity', quantity)
        if (error) throw new Error(error.message)
        setPrices((prev) => prev.filter((p) => p.id !== priceId))
        void logAudit({
          action: 'option_surcharge.metal_finish.deleted',
          targetType: 'add_on_price',
          targetId: priceId,
          targetLabel: `${addOn.display_name} ${currency} qty ${quantity}`,
          beforeValue: { currency, quantity, surcharge: existing?.surcharge ?? null, applies_to_options: optIds.length },
          afterValue: null,
        })
        return
      }
      const { error } = await supabase
        .from('material_option_surcharges')
        .update({ surcharge: next })
        .in('material_option_id', optIds)
        .eq('currency', currency)
        .eq('quantity', quantity)
      if (error) throw new Error(error.message)
      setPrices((prev) => prev.map((p) => p.id === priceId ? { ...p, surcharge: next } : p))
      void logAudit({
        action: 'option_surcharge.metal_finish.updated',
        targetType: 'add_on_price',
        targetId: priceId,
        targetLabel: `${addOn.display_name} ${currency} qty ${quantity}`,
        beforeValue: { currency, quantity, surcharge: existing?.surcharge ?? null, applies_to_options: optIds.length },
        afterValue: { currency, quantity, surcharge: next, applies_to_options: optIds.length },
      })
      return
    }
    if (next == null) {
      // add_on_prices.surcharge is NOT NULL, so "clear" means
      // remove the row — the price grid then shows "—" for that
      // (qty, currency) combination, matching the natural "no
      // price configured here" affordance.
      const { error } = await supabase
        .from('add_on_prices')
        .delete()
        .eq('id', priceId)
      if (error) throw new Error(error.message)
      setPrices((prev) => prev.filter((p) => p.id !== priceId))
      void logAudit({
        action: 'addon_price.deleted',
        targetType: 'add_on_price',
        targetId: priceId,
        targetLabel: `${addOn?.display_name ?? ''} ${existing?.quantity == null ? 'flat' : `qty ${existing?.quantity}`} ${existing?.currency ?? ''}`,
        beforeValue: { currency: existing?.currency, quantity: existing?.quantity ?? null, surcharge: existing?.surcharge ?? null },
        afterValue: null,
      })
      return
    }
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
    if (MATERIAL_OPTION_BACKED_ADDONS[addOn.code]) {
      // Fan out: 12 rows per quantity (4 option_ids × 3 currencies),
      // all starting at zero. Mirrors the existing seed-then-edit
      // ergonomic for the add_on_prices path.
      const optIds = await resolveBackingOptionIds(addOn.code)
      const rows = quantities.flatMap((qty) =>
        optIds.flatMap((oid) => CURRENCIES.map((currency) => ({
          material_option_id: oid, currency, quantity: qty, surcharge: 0,
        }))),
      )
      const { error } = await supabase.from('material_option_surcharges').insert(rows)
      if (error) throw new Error(error.message)
      const synthetic: Price[] = quantities.flatMap((qty) =>
        CURRENCIES.map((c) => ({
          id: `mos:${c}|${qty}`,
          add_on_id: addOn.id,
          currency: c,
          quantity: qty,
          surcharge: 0,
        })),
      )
      setPrices((prev) => [...prev, ...synthetic])
      setSeedDialog(false)
      void logAudit({
        action: 'option_surcharges.metal_finish.seeded',
        targetType: 'add_on',
        targetId: addOn.id,
        targetLabel: addOn.display_name,
        metadata: { quantities, rows_created: rows.length, pricing_model: 'per_quantity_tier', applies_to_options: optIds.length },
      })
      return
    }
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
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-line border-t-gray-900" />
      </div>
    )
  }
  if (loadError || !addOn) {
    return (
      <div className="rounded-2xl bg-out-soft p-6 text-sm text-out ring-1 ring-out">
        Failed to load add-on: {loadError ?? 'not found'}
      </div>
    )
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link to="/admin/pricing" className="text-xs text-ink-dim hover:text-ink-soft">← Back to pricing</Link>
          <h2 className="mt-2 text-xl font-bold text-ink">{addOn.display_name}</h2>
          {addOn.notes && <p className="mt-1 max-w-xl text-xs text-ink-mute">{addOn.notes}</p>}
          {MATERIAL_OPTION_BACKED_ADDONS[addOn.code] && (
            <p className="mt-2 max-w-xl text-xs text-violet-700">
              Prices apply to Mirror and Brushed across Steel and Gold. Editing one tier updates all four schedules in lockstep.
            </p>
          )}
          <p className="mt-2 text-sm text-ink-mute">
            Changes save automatically. Customer-facing prices update immediately.
          </p>
        </div>
        {addOn.pricing_model !== 'custom_quote' && (
          <button
            onClick={() => downloadPricingExport(`addon:${addOn.code}`, `pricing_addon_${addOn.code}.csv`).catch(() => {})}
            className="shrink-0 rounded-lg px-3 py-2 text-sm font-medium text-ink-soft ring-1 ring-line hover:bg-canvas"
          >
            Export this add-on
          </button>
        )}
      </div>

      {/* Editor — branches by pricing_model */}
      {addOn.pricing_model === 'custom_quote' ? (
        <div className="rounded-2xl bg-surface p-6 text-sm text-ink-mute shadow-sm ring-1 ring-line">
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
          parentQuantities={parentQuantities}
          onSave={saveSurcharge}
          onCreate={createTier}
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
  onSave: (priceId: string, next: number | null) => Promise<void>
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
    <section className="rounded-2xl bg-surface p-6 shadow-sm ring-1 ring-line">
      <h3 className="text-sm font-semibold text-ink">Flat surcharge</h3>
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
        {CURRENCIES.map((c) => {
          const p = byCurrency.get(c)
          if (!p) return (
            <div key={c}>
              <label className="block text-xs font-medium uppercase tracking-wide text-ink-dim">
                {c} {c === 'GBP' ? '(inc VAT)' : '(ex VAT)'}
              </label>
              <p className="mt-1 text-sm text-ink-dim">—</p>
            </div>
          )
          return (
            <div key={c}>
              <label className="block text-xs font-medium uppercase tracking-wide text-ink-dim">
                {c} {c === 'GBP' ? '(inc VAT)' : '(ex VAT)'}
              </label>
              <div className="mt-1">
                <PriceCell
                  value={p.surcharge}
                  currency={c}
                  allowClear
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

function PerTierEditor({ prices, parentQuantities, onSave, onCreate, onOpenSeed }: {
  prices: Price[]
  parentQuantities: number[]
  onSave: (priceId: string, next: number | null) => Promise<void>
  onCreate: (quantity: number, gbp: number, eur: number, usd: number) => Promise<void>
  onOpenSeed: () => void
}) {
  const [adding, setAdding] = useState(false)

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

  const availableQuantities = useMemo(() => {
    const taken = new Set<number>()
    for (const p of prices) if (p.quantity != null) taken.add(p.quantity)
    return parentQuantities.filter((q) => !taken.has(q))
  }, [prices, parentQuantities])

  // The "Add tier" affordance is only meaningful when we know which
  // quantities the parent materials support. For other add-ons the
  // editor falls back to seed-then-edit (existing behaviour).
  const canAddTier = parentQuantities.length > 0

  if (byQty.length === 0) {
    return (
      <EmptyState label="No prices set yet for this add-on." actionLabel="Add prices" onClick={onOpenSeed} />
    )
  }

  return (
    <section className="overflow-hidden rounded-2xl bg-surface shadow-sm ring-1 ring-line">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line-soft">
            <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-ink-dim">Qty</th>
            {CURRENCIES.map((c) => (
              <th key={c} className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-ink-dim">
                {c} {c === 'GBP' ? '(inc VAT)' : '(ex VAT)'}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {byQty.map(([qty, row]) => (
            <tr key={qty} className="border-b border-line-soft last:border-0">
              <td className="px-4 py-2 font-medium text-ink tabular-nums">{qty.toLocaleString()}</td>
              {CURRENCIES.map((c) => {
                const p = row[c]
                return (
                  <td key={`${qty}-${c}`} className="px-4 py-2">
                    {p ? (
                      <PriceCell value={p.surcharge} currency={c} allowClear onSave={(next) => onSave(p.id, next)} />
                    ) : (
                      <span className="text-ink-dim">—</span>
                    )}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
        {canAddTier && (
          <tfoot>
            {adding ? (
              <AddTierRow
                availableQuantities={availableQuantities}
                onSave={async (q, g, e, u) => { await onCreate(q, g, e, u); setAdding(false) }}
                onCancel={() => setAdding(false)}
              />
            ) : (
              <tr className="border-t border-line-soft bg-canvas">
                <td colSpan={1 + CURRENCIES.length} className="px-4 py-3">
                  <button
                    type="button"
                    onClick={() => setAdding(true)}
                    disabled={availableQuantities.length === 0}
                    title={availableQuantities.length === 0 ? 'All parent material quantities already have a surcharge tier' : undefined}
                    className="text-sm font-medium text-ink-soft hover:text-ink disabled:cursor-not-allowed disabled:text-ink-dim"
                  >
                    + Add tier
                  </button>
                </td>
              </tr>
            )}
          </tfoot>
        )}
      </table>
    </section>
  )
}

// ── Inline "Add tier" row ────────────────────────────────────────────────────

function AddTierRow({ availableQuantities, onSave, onCancel }: {
  availableQuantities: number[]
  onSave: (quantity: number, gbp: number, eur: number, usd: number) => Promise<void>
  onCancel: () => void
}) {
  const [quantity, setQuantity] = useState<string>('')
  const [gbp, setGbp] = useState<string>('')
  const [eur, setEur] = useState<string>('')
  const [usd, setUsd] = useState<string>('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function parsePrice(raw: string): number | null {
    const t = raw.trim()
    if (t === '') return null
    const n = parseFloat(t)
    if (!isFinite(n) || n < 0) return null
    return n
  }

  async function handleSave() {
    setError(null)
    const q = quantity === '' ? NaN : parseInt(quantity, 10)
    if (!Number.isInteger(q) || q <= 0) { setError('Pick a quantity'); return }
    const g = parsePrice(gbp)
    const e = parsePrice(eur)
    const u = parsePrice(usd)
    if (g == null || e == null || u == null) {
      setError('Enter a non-negative number for every currency')
      return
    }
    setSaving(true)
    try {
      await onSave(q, g, e, u)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const priceState: Record<Currency, [string, (v: string) => void]> = {
    GBP: [gbp, setGbp],
    EUR: [eur, setEur],
    USD: [usd, setUsd],
  }

  return (
    <>
      <tr className="border-t border-line-soft bg-canvas">
        <td className="px-4 py-2">
          <select
            value={quantity}
            onChange={(ev) => setQuantity(ev.target.value)}
            disabled={saving}
            className="rounded border border-line px-2 py-1 text-[17px] sm:text-sm tabular-nums focus:border-[var(--c-brand)] focus:bg-[var(--c-brand-50)] focus:outline-none"
          >
            <option value="">Pick a qty</option>
            {availableQuantities.map((q) => (
              <option key={q} value={q}>{q.toLocaleString()}</option>
            ))}
          </select>
        </td>
        {CURRENCIES.map((c) => {
          const [value, setter] = priceState[c]
          return (
            <td key={c} className="px-4 py-2">
              <div className="relative inline-block">
                <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-ink-dim">
                  {currencySymbol(c)}
                </span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={value}
                  placeholder="0.00"
                  onChange={(ev) => setter(ev.target.value)}
                  disabled={saving}
                  className="w-24 rounded border border-line px-2 py-1 pl-5 text-[17px] sm:text-sm tabular-nums focus:border-[var(--c-brand)] focus:bg-[var(--c-brand-50)] focus:outline-none"
                />
              </div>
            </td>
          )
        })}
      </tr>
      <tr className="bg-canvas">
        <td colSpan={1 + CURRENCIES.length} className="px-4 pb-3">
          <div className="flex items-center justify-end gap-2">
            {error && <span className="mr-auto text-xs text-out">{error}</span>}
            <button
              type="button"
              onClick={onCancel}
              disabled={saving}
              className="rounded-lg px-3 py-1.5 text-sm font-medium text-ink-mute hover:bg-canvas disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="rounded-lg bg-ink px-3 py-1.5 text-sm font-semibold text-on-ink hover:opacity-90 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save tier'}
            </button>
          </div>
        </td>
      </tr>
    </>
  )
}

// ── Empty state & seed dialog ────────────────────────────────────────────────

function EmptyState({ label, actionLabel, onClick }: {
  label: string
  actionLabel: string
  onClick: () => void
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl bg-surface py-12 text-center shadow-sm ring-1 ring-line">
      <p className="text-sm text-ink-mute">{label}</p>
      <button
        onClick={onClick}
        className="rounded-lg bg-ink px-4 py-2 text-sm font-semibold text-on-ink hover:opacity-90"
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
    <Modal
      open
      onClose={onCancel}
      preventClose={working}
      ariaLabelledBy="addon-seed-title"
      panelClassName="w-full max-w-sm rounded-2xl bg-surface p-6 shadow-xl"
    >
      <form onSubmit={handleSubmit}>
        <h3 id="addon-seed-title" className="text-lg font-semibold text-ink">Add prices</h3>
        <p className="mt-1 text-xs text-ink-mute">
          Enter the quantity tiers to seed, comma-separated. All three currencies start at £0 / €0 / $0 — edit each cell afterwards.
        </p>
        <div className="mt-4">
          <label className="block text-xs font-medium uppercase tracking-wide text-ink-dim">Quantities</label>
          <input
            type="text"
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            className="mt-1 w-full rounded border border-line px-3 py-2 text-[17px] sm:text-sm focus:border-[var(--c-brand)] focus:bg-[var(--c-brand-50)] focus:outline-none"
            placeholder="100, 250, 500, 750, 1000"
          />
        </div>
        {error && <p className="mt-3 rounded-lg bg-out-soft px-3 py-2 text-xs text-out">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={working}
            className="rounded-lg px-4 py-2 text-sm font-medium text-ink-mute hover:bg-canvas disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={working}
            className="rounded-lg bg-ink px-4 py-2 text-sm font-semibold text-on-ink hover:opacity-90 disabled:opacity-50"
          >
            {working ? 'Seeding…' : 'Seed tiers'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
