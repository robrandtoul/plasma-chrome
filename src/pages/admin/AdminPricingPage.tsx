import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { downloadPricingExport } from '../../lib/pricingIO'
import AdminPricingImport from './AdminPricingImport'

// ── Types ────────────────────────────────────────────────────────────────────

interface MaterialRow {
  id: string
  code: string
  display_name: string
  category: string
  sort_order: number
  variant_count: number
  variant_type: string
  tier_count: number
}

interface AddOnRow {
  id: string
  code: string
  display_name: string
  pricing_model: 'per_quantity_tier' | 'flat' | 'custom_quote'
  has_prices: boolean
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function variantTypeLabel(type: string, count: number): string {
  if (type === 'default') return 'Single variant'
  if (type === 'thickness') return count === 1 ? '1 thickness' : `${count} thicknesses`
  if (type === 'ink_count') return count === 1 ? '1 ink count' : `${count} ink counts`
  if (type === 'finish') return count === 1 ? '1 finish' : `${count} finishes`
  return `${count} variants`
}

function pricingModelLabel(model: string): string {
  if (model === 'per_quantity_tier') return 'Per quantity tier'
  if (model === 'flat') return 'Flat surcharge'
  if (model === 'custom_quote') return 'Custom quote'
  return model
}

// ── Component ────────────────────────────────────────────────────────────────

export default function AdminPricingPage() {
  const [materials, setMaterials] = useState<MaterialRow[]>([])
  const [addOns, setAddOns] = useState<AddOnRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showImport, setShowImport] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)

  async function handleExportAll() {
    setExportError(null)
    setExporting(true)
    try {
      await downloadPricingExport('all', 'pricing_export.zip')
    } catch (e) {
      setExportError((e as Error).message)
    } finally {
      setExporting(false)
    }
  }

  async function handleExportSurcharges() {
    setExportError(null)
    setExporting(true)
    try {
      await downloadPricingExport('surcharges', 'pricing_surcharges.csv')
    } catch (e) {
      setExportError((e as Error).message)
    } finally {
      setExporting(false)
    }
  }

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const [matResult, varResult, tierResult, aoResult, apResult] = await Promise.all([
        supabase.from('materials')
          .select('id, code, display_name, category, sort_order')
          .eq('is_active', true)
          .order('sort_order'),
        supabase.from('material_variants')
          .select('id, material_id, variant_type')
          .eq('is_active', true),
        supabase.from('price_tiers').select('id, material_variant_id'),
        supabase.from('add_ons')
          .select('id, code, display_name, pricing_model')
          .eq('is_active', true)
          .order('display_name'),
        supabase.from('add_on_prices').select('add_on_id'),
      ])

      if (matResult.error) throw matResult.error
      if (varResult.error) throw varResult.error
      if (tierResult.error) throw tierResult.error
      if (aoResult.error) throw aoResult.error
      if (apResult.error) throw apResult.error

      // Roll up per-material variant + tier counts.
      const variantsByMaterial = new Map<string, { count: number; type: string }>()
      for (const v of (varResult.data ?? []) as any[]) {
        const existing = variantsByMaterial.get(v.material_id)
        if (existing) existing.count += 1
        else variantsByMaterial.set(v.material_id, { count: 1, type: v.variant_type })
      }

      const variantIdToMaterial = new Map<string, string>()
      for (const v of (varResult.data ?? []) as any[]) variantIdToMaterial.set(v.id, v.material_id)

      const tiersByMaterial = new Map<string, number>()
      for (const t of (tierResult.data ?? []) as any[]) {
        const matId = variantIdToMaterial.get(t.material_variant_id)
        if (matId) tiersByMaterial.set(matId, (tiersByMaterial.get(matId) ?? 0) + 1)
      }

      const addOnsWithPrices = new Set<string>()
      for (const ap of (apResult.data ?? []) as any[]) addOnsWithPrices.add(ap.add_on_id)

      const matRows: MaterialRow[] = ((matResult.data ?? []) as any[]).map((m) => {
        const info = variantsByMaterial.get(m.id) ?? { count: 0, type: 'default' }
        return {
          id: m.id,
          code: m.code,
          display_name: m.display_name,
          category: m.category,
          sort_order: m.sort_order,
          variant_count: info.count,
          variant_type: info.type,
          tier_count: tiersByMaterial.get(m.id) ?? 0,
        }
      })

      const aoRows: AddOnRow[] = ((aoResult.data ?? []) as any[]).map((a) => ({
        id: a.id,
        code: a.code,
        display_name: a.display_name,
        pricing_model: a.pricing_model,
        has_prices: addOnsWithPrices.has(a.id),
      }))

      setMaterials(matRows)
      setAddOns(aoRows)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-10">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Pricing</h2>
          <p className="mt-1 text-sm text-gray-500">
            Edit materials, variants, price tiers and add-on surcharges. Changes save automatically and customer-facing prices update immediately.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={handleExportSurcharges}
            disabled={exporting}
            className="rounded-lg px-3 py-2 text-sm font-medium text-gray-600 ring-1 ring-gray-200 hover:bg-gray-50 disabled:opacity-50"
          >
            Export surcharges
          </button>
          <button
            onClick={handleExportAll}
            disabled={exporting}
            className="rounded-lg px-3 py-2 text-sm font-medium text-gray-600 ring-1 ring-gray-200 hover:bg-gray-50 disabled:opacity-50"
          >
            {exporting ? 'Bundling…' : 'Export everything (ZIP)'}
          </button>
          <button
            onClick={() => setShowImport(true)}
            className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-700"
          >
            Import
          </button>
        </div>
      </div>
      {exportError && (
        <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{exportError}</p>
      )}
      {showImport && (
        <AdminPricingImport
          onClose={() => setShowImport(false)}
          onCommitted={() => load()}
        />
      )}

      {loading ? (
        <div className="flex justify-center py-20">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-200 border-t-gray-900" />
        </div>
      ) : error ? (
        <div className="rounded-2xl bg-rose-50 p-6 text-sm text-rose-700 ring-1 ring-rose-200">
          Failed to load pricing catalogue: {error}
        </div>
      ) : (
        <>
          {/* Materials */}
          <section>
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-widest text-gray-500">Materials</h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {materials.map((m) => (
                <Link
                  key={m.id}
                  to={`/admin/pricing/materials/${m.code}`}
                  className="block rounded-2xl bg-white p-5 shadow-sm ring-1 ring-gray-200 transition-shadow hover:shadow-md"
                >
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-semibold text-gray-900">{m.display_name}</div>
                    <span className="text-xs uppercase tracking-wider text-gray-400">{m.category}</span>
                  </div>
                  <div className="mt-2 text-xs text-gray-500">{variantTypeLabel(m.variant_type, m.variant_count)}</div>
                  <div className="mt-0.5 text-xs text-gray-400">{m.tier_count} price tier{m.tier_count === 1 ? '' : 's'}</div>
                </Link>
              ))}
            </div>
          </section>

          {/* Add-ons */}
          <section>
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-widest text-gray-500">Add-ons</h3>
            <div className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-gray-200">
              {addOns.map((a, i) => (
                <Link
                  key={a.id}
                  to={`/admin/pricing/add-ons/${a.code}`}
                  className={[
                    'flex items-center gap-4 px-5 py-3 hover:bg-gray-50',
                    i > 0 ? 'border-t border-gray-100' : '',
                  ].join(' ')}
                >
                  <div className="flex-1">
                    <div className="text-sm font-medium text-gray-900">{a.display_name}</div>
                    <div className="text-xs text-gray-500">{pricingModelLabel(a.pricing_model)}</div>
                  </div>
                  {!a.has_prices && a.pricing_model !== 'custom_quote' && (
                    <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">
                      Needs pricing
                    </span>
                  )}
                </Link>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  )
}
