import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import PriceCell, { currencySymbol } from './PriceCell'

// ── Types ────────────────────────────────────────────────────────────────────

type Currency = 'GBP' | 'EUR' | 'USD'
const CURRENCIES: Currency[] = ['GBP', 'EUR', 'USD']

interface Material {
  id: string
  code: string
  display_name: string
  category: string
  variant_type: 'thickness' | 'ink_count' | 'finish' | 'default'
  split_name_surcharge_gbp: number | null
  split_name_surcharge_eur: number | null
  split_name_surcharge_usd: number | null
}

interface Variant {
  id: string
  code: string
  display_name: string
  sort_order: number
}

interface Tier {
  id: string
  material_variant_id: string
  currency: Currency
  quantity: number
  total_price: number
  unit_price: number
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function AdminMaterialEditor() {
  const { code } = useParams<{ code: string }>()
  const [material, setMaterial] = useState<Material | null>(null)
  const [variants, setVariants] = useState<Variant[]>([])
  const [tiers, setTiers] = useState<Tier[]>([])
  const [activeVariantId, setActiveVariantId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => { if (code) load(code) }, [code])

  async function load(materialCode: string) {
    setLoading(true)
    setLoadError(null)
    try {
      const { data: matData, error: matErr } = await supabase
        .from('materials')
        .select('id, code, display_name, category, split_name_surcharge_gbp, split_name_surcharge_eur, split_name_surcharge_usd')
        .eq('code', materialCode)
        .single()
      if (matErr || !matData) throw matErr ?? new Error('Material not found')

      const [varResult, tierResult] = await Promise.all([
        supabase.from('material_variants')
          .select('id, code, display_name, variant_type, sort_order')
          .eq('material_id', matData.id)
          .eq('is_active', true)
          .order('sort_order'),
        supabase.from('price_tiers')
          .select('id, material_variant_id, currency, quantity, total_price, unit_price')
          .in('material_variant_id',
            (await supabase.from('material_variants').select('id').eq('material_id', matData.id)).data?.map((x: any) => x.id) ?? [])
          .order('quantity'),
      ])
      if (varResult.error) throw varResult.error
      if (tierResult.error) throw tierResult.error

      const variants = (varResult.data ?? []) as Variant[]
      // Filter to the material's single axis — protects against stale rows
      // with an unexpected variant_type.
      const variantType = ((varResult.data?.[0] as any)?.variant_type ?? 'default') as Material['variant_type']

      setMaterial({ ...matData, variant_type: variantType } as any)
      setVariants(variants)
      setTiers((tierResult.data ?? []) as Tier[])
      setActiveVariantId(variants[0]?.id ?? null)
    } catch (e) {
      setLoadError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  async function saveSurcharge(currency: Currency, nextValue: number) {
    if (!material) return
    const col = `split_name_surcharge_${currency.toLowerCase()}` as const
    const { error } = await supabase
      .from('materials')
      .update({ [col]: nextValue })
      .eq('id', material.id)
    if (error) throw new Error(error.message)
    setMaterial((prev) => prev ? ({ ...prev, [col]: nextValue } as Material) : prev)
  }

  async function saveTier(tierId: string, quantity: number, nextTotal: number) {
    const nextUnit = Number((nextTotal / quantity).toFixed(4))
    const { error } = await supabase
      .from('price_tiers')
      .update({ total_price: nextTotal, unit_price: nextUnit })
      .eq('id', tierId)
    if (error) throw new Error(error.message)
    setTiers((prev) => prev.map((t) =>
      t.id === tierId ? { ...t, total_price: nextTotal, unit_price: nextUnit } : t,
    ))
  }

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-200 border-t-gray-900" />
      </div>
    )
  }
  if (loadError || !material) {
    return (
      <div className="rounded-2xl bg-rose-50 p-6 text-sm text-rose-700 ring-1 ring-rose-200">
        Failed to load material: {loadError ?? 'not found'}
      </div>
    )
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <Link to="/admin/pricing" className="text-xs text-gray-400 hover:text-gray-700">← Back to pricing</Link>
        <h2 className="mt-2 text-xl font-bold text-gray-900">{material.display_name}</h2>
        <p className="mt-1 text-sm text-gray-500">
          Changes save automatically. Customer-facing prices update immediately.
        </p>
      </div>

      {/* Surcharges */}
      <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-gray-200">
        <h3 className="text-sm font-semibold text-gray-900">Split-name surcharge</h3>
        <p className="mt-1 text-xs text-gray-500">
          Charged per extra name beyond the first. Leave blank if this material doesn't offer split names.
        </p>
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
          {CURRENCIES.map((currency) => {
            const col = `split_name_surcharge_${currency.toLowerCase()}` as keyof Material
            const val = material[col] as number | null
            return (
              <div key={currency}>
                <label className="block text-xs font-medium uppercase tracking-wide text-gray-400">
                  {currency} {currency === 'GBP' ? '(inc VAT)' : '(ex VAT)'}
                </label>
                <div className="mt-1">
                  <PriceCell
                    value={val}
                    currency={currency}
                    onSave={(next) => saveSurcharge(currency, next)}
                    placeholder="—"
                  />
                </div>
              </div>
            )
          })}
        </div>
      </section>

      {/* Variants / price grid */}
      <section>
        <h3 className="mb-3 text-sm font-semibold text-gray-900">Price tiers</h3>
        {variants.length === 0 ? (
          <p className="text-sm text-gray-400">No variants yet.</p>
        ) : material.variant_type === 'default' ? (
          <PriceGrid tiers={tiers.filter((t) => t.material_variant_id === variants[0].id)} onSave={saveTier} />
        ) : (
          <>
            {/* Variant tab strip */}
            <div className="mb-4 flex flex-wrap gap-2">
              {variants.map((v) => {
                const isActive = activeVariantId === v.id
                return (
                  <button
                    key={v.id}
                    onClick={() => setActiveVariantId(v.id)}
                    className={[
                      'rounded-full px-4 py-1.5 text-sm font-medium transition-colors',
                      isActive
                        ? 'bg-gray-900 text-white'
                        : 'bg-white text-gray-600 ring-1 ring-gray-200 hover:bg-gray-50',
                    ].join(' ')}
                  >
                    {v.display_name}
                  </button>
                )
              })}
            </div>
            <PriceGrid
              tiers={tiers.filter((t) => t.material_variant_id === activeVariantId)}
              onSave={saveTier}
            />
          </>
        )}
      </section>
    </div>
  )
}

// ── Price grid ───────────────────────────────────────────────────────────────

function PriceGrid({ tiers, onSave }: {
  tiers: Tier[]
  onSave: (tierId: string, quantity: number, nextTotal: number) => Promise<void>
}) {
  // Group by quantity so every row has all three currencies side-by-side.
  const byQty = useMemo(() => {
    const map = new Map<number, Partial<Record<Currency, Tier>>>()
    for (const t of tiers) {
      const row = map.get(t.quantity) ?? {}
      row[t.currency as Currency] = t
      map.set(t.quantity, row)
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0])
  }, [tiers])

  if (byQty.length === 0) {
    return <p className="text-sm text-gray-400">No price tiers set for this variant yet.</p>
  }

  return (
    <div className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-gray-200">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-100">
            <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Qty</th>
            {CURRENCIES.map((c) => (
              <th key={c} colSpan={2} className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">
                {c} {c === 'GBP' ? '(inc VAT)' : '(ex VAT)'}
              </th>
            ))}
          </tr>
          <tr className="border-b border-gray-100">
            <th className="px-4 pb-2 text-left text-[11px] font-medium uppercase tracking-wider text-gray-300" />
            {CURRENCIES.flatMap((c) => ([
              <th key={`${c}-total`} className="px-4 pb-2 text-left text-[11px] font-medium uppercase tracking-wider text-gray-400">Total</th>,
              <th key={`${c}-unit`} className="px-4 pb-2 text-left text-[11px] font-medium uppercase tracking-wider text-gray-400">Unit</th>,
            ]))}
          </tr>
        </thead>
        <tbody>
          {byQty.map(([qty, row]) => (
            <tr key={qty} className="border-b border-gray-50 last:border-0">
              <td className="px-4 py-2 font-medium text-gray-900 tabular-nums">{qty.toLocaleString()}</td>
              {CURRENCIES.flatMap((c) => {
                const tier = row[c]
                return [
                  <td key={`${qty}-${c}-total`} className="px-4 py-2">
                    {tier ? (
                      <PriceCell
                        value={tier.total_price}
                        currency={c}
                        onSave={(next) => onSave(tier.id, qty, next)}
                      />
                    ) : (
                      <span className="text-gray-300">—</span>
                    )}
                  </td>,
                  <td key={`${qty}-${c}-unit`} className="px-4 py-2 text-xs text-gray-500 tabular-nums">
                    {tier
                      ? `${currencySymbol(c)}${(tier.total_price / qty).toFixed(4)}`
                      : '—'}
                  </td>,
                ]
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
