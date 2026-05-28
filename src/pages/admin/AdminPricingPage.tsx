import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { downloadPricingExport } from '../../lib/pricingIO'
import { logAudit } from '../../lib/audit'
import { invalidatePublicSettings } from '../../lib/publicSettings'
import { invalidateVatRateGbp } from '../../lib/vatRateGbp'
import AdminPricingImport from './AdminPricingImport'
import PersonalisationPricingSection from './PersonalisationPricingSection'
import { MATERIAL_OPTION_BACKED_ADDONS, resolveBackingOptionIds } from './backedAddons'

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
  // VAT rate (settings.vat_rate_gbp, migration 000115). Lives here
  // now rather than on the Settings page — pricing-adjacent. Stored
  // as a fraction (0.20 = 20%); rendered as percent-like decimal.
  const [vatRate, setVatRate] = useState<number | null>(null)
  const [vatDraft, setVatDraft] = useState<string>('')
  const [vatSaving, setVatSaving] = useState(false)
  const [vatSavedAt, setVatSavedAt] = useState<number | null>(null)
  const [vatError, setVatError] = useState<string | null>(null)

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

  useEffect(() => { load(); void loadVatRate() }, [])

  async function loadVatRate() {
    const { data } = await supabase.from('settings').select('vat_rate_gbp').eq('id', 1).single()
    const rate = data?.vat_rate_gbp != null ? Number(data.vat_rate_gbp) : null
    setVatRate(rate)
    setVatDraft(rate == null ? '' : String(rate))
  }

  async function saveVatRate() {
    if (vatRate == null) return
    const draft = vatDraft.trim()
    if (draft === '') {
      // Snap back to the saved value rather than wiping it. VAT is
      // load-bearing for every GBP quote in the system; an accidental
      // empty save would be very wrong.
      setVatDraft(String(vatRate))
      setVatError(null)
      return
    }
    const n = Number(draft)
    if (!Number.isFinite(n) || n < 0 || n > 1) {
      setVatError('Must be between 0 and 1 (e.g. 0.20)')
      return
    }
    // Round to 4dp to match the column's numeric(5,4) precision.
    const next = Math.round(n * 10000) / 10000
    if (next === vatRate) {
      setVatError(null)
      return
    }
    setVatSaving(true)
    setVatError(null)
    const prev = vatRate
    const { error: err } = await supabase
      .from('settings')
      .update({ vat_rate_gbp: next, updated_at: new Date().toISOString() })
      .eq('id', 1)
    setVatSaving(false)
    if (err) {
      setVatError(err.message)
      return
    }
    setVatRate(next)
    setVatDraft(String(next))
    setVatSavedAt(Date.now())
    invalidatePublicSettings()
    invalidateVatRateGbp()
    void logAudit({
      action: 'setting.vat_rate_gbp_updated',
      targetType: 'setting',
      targetId: 'vat_rate_gbp',
      targetLabel: 'UK VAT rate (GBP)',
      beforeValue: { vat_rate_gbp: prev },
      afterValue: { vat_rate_gbp: next },
    })
  }

  const vatRecentlySaved = vatSavedAt != null && Date.now() - vatSavedAt < 2000

  async function load() {
    setLoading(true)
    setError(null)
    try {
      // Tier counts come from the database-side aggregate view
      // (migration 000148). Previously we fetched every row in
      // price_tiers and rolled up client-side, which silently
      // truncated to supabase-js's 1000-row default cap and made
      // every material past the first three look like it had zero
      // tiers. The view returns one row per material — cheap.
      const [matResult, varResult, tierCountResult, aoResult, apResult] = await Promise.all([
        supabase.from('materials')
          .select('id, code, display_name, category, sort_order')
          .eq('is_active', true)
          .order('sort_order'),
        supabase.from('material_variants')
          .select('id, material_id, variant_type')
          .eq('is_active', true),
        supabase.from('material_price_tier_counts').select('material_id, tier_count'),
        supabase.from('add_ons')
          .select('id, code, display_name, pricing_model')
          .eq('is_active', true)
          .order('display_name'),
        supabase.from('add_on_prices').select('add_on_id'),
      ])

      if (matResult.error) throw matResult.error
      if (varResult.error) throw varResult.error
      if (tierCountResult.error) throw tierCountResult.error
      if (aoResult.error) throw aoResult.error
      if (apResult.error) throw apResult.error

      // Roll up per-material variant counts (still client-side; the
      // material_variants table is small).
      const variantsByMaterial = new Map<string, { count: number; type: string }>()
      for (const v of (varResult.data ?? []) as any[]) {
        const existing = variantsByMaterial.get(v.material_id)
        if (existing) existing.count += 1
        else variantsByMaterial.set(v.material_id, { count: 1, type: v.variant_type })
      }

      const tiersByMaterial = new Map<string, number>()
      for (const r of (tierCountResult.data ?? []) as Array<{ material_id: string; tier_count: number }>) {
        tiersByMaterial.set(r.material_id, Number(r.tier_count))
      }

      const addOnsWithPrices = new Set<string>()
      for (const ap of (apResult.data ?? []) as any[]) addOnsWithPrices.add(ap.add_on_id)

      // Backed add-ons (e.g. metal_finish_upgrade) are priced in
      // material_option_surcharges, not add_on_prices, so the
      // `addOnsWithPrices` check above always fails for them and
      // would falsely fire the "Needs pricing" badge. Resolve each
      // backed add-on's option_ids and check whether ANY surcharge
      // row exists. We only need a "has rows" yes/no; the count
      // header keeps the query cheap.
      const backedHasPrices = new Set<string>()
      const backedAddOns = ((aoResult.data ?? []) as any[]).filter((a) => a.code in MATERIAL_OPTION_BACKED_ADDONS)
      await Promise.all(backedAddOns.map(async (a) => {
        const optIds = await resolveBackingOptionIds(a.code)
        if (optIds.length === 0) return
        const { count, error } = await supabase
          .from('material_option_surcharges')
          .select('*', { count: 'exact', head: true })
          .in('material_option_id', optIds)
        if (error) throw error
        if ((count ?? 0) > 0) backedHasPrices.add(a.id)
      }))

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
        // Backed add-ons read their "has prices" flag from
        // material_option_surcharges; everything else falls back to
        // the add_on_prices presence check.
        has_prices: a.code in MATERIAL_OPTION_BACKED_ADDONS
          ? backedHasPrices.has(a.id)
          : addOnsWithPrices.has(a.id),
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
          <h2 className="text-xl font-bold text-ink">Pricing</h2>
          <p className="mt-1 text-sm text-ink-mute">
            Edit materials, variants, price tiers and add-on surcharges. Changes save automatically and customer-facing prices update immediately.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={handleExportSurcharges}
            disabled={exporting}
            className="rounded-lg px-3 py-2 text-sm font-medium text-ink-soft border border-line hover:bg-canvas disabled:opacity-50"
          >
            Export surcharges
          </button>
          <button
            onClick={handleExportAll}
            disabled={exporting}
            className="rounded-lg px-3 py-2 text-sm font-medium text-ink-soft border border-line hover:bg-canvas disabled:opacity-50"
          >
            {exporting ? 'Bundling…' : 'Export everything (ZIP)'}
          </button>
          <button
            onClick={() => setShowImport(true)}
            className="rounded-lg bg-ink px-4 py-2 text-sm font-semibold text-on-ink hover:opacity-90"
          >
            Import
          </button>
        </div>
      </div>
      {exportError && (
        <p className="rounded-lg bg-out-soft px-3 py-2 text-xs text-out">{exportError}</p>
      )}
      {showImport && (
        <AdminPricingImport
          onClose={() => setShowImport(false)}
          onCommitted={() => load()}
        />
      )}

      {/* ── Pricing settings ──────────────────────────────────
          VAT rate and personalisation pricing — both global
          per-currency settings that affect every quote. Lifted
          here from the Settings page so pricing-affecting
          knobs live next to the pricing they affect. */}
      <section className="rounded-[14px] bg-surface p-6 border border-line">
        <h3 className="mb-1 text-sm font-semibold text-ink">VAT rate</h3>
        <p className="mb-4 text-xs text-ink-mute">
          UK VAT rate. Currently {vatRate != null ? `${Math.round(vatRate * 100 * 100) / 100}% (${vatRate})` : '—'}. Edit if HMRC changes it. EUR and USD prices are VAT-free and unaffected.
        </p>
        <div className="flex items-center gap-3">
          <input
            type="number"
            min={0}
            max={1}
            step={0.01}
            value={vatDraft}
            onChange={(e) => { setVatDraft(e.target.value); setVatError(null) }}
            onBlur={() => { void saveVatRate() }}
            className={`${pricingInputClass} max-w-[10rem]`}
          />
          {vatSaving && <span className="text-xs text-ink-mute">Saving…</span>}
          {vatRecentlySaved && !vatSaving && <span className="text-xs text-in-stock">Saved</span>}
          {vatError && <span className="text-xs text-out">{vatError}</span>}
        </div>
      </section>

      <PersonalisationPricingSection />

      {loading ? (
        <div className="flex justify-center py-20">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-line border-t-ink" />
        </div>
      ) : error ? (
        <div className="rounded-[14px] bg-out-soft p-6 text-sm text-out ring-1 border-out">
          Failed to load pricing catalogue: {error}
        </div>
      ) : (
        <>
          {/* Materials */}
          <section>
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-widest text-ink-mute">Materials</h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {materials.map((m) => (
                <Link
                  key={m.id}
                  to={`/admin/pricing/materials/${m.code}`}
                  className="block rounded-[14px] bg-surface p-5 border border-line transition-shadow hover:shadow-md"
                >
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-semibold text-ink">{m.display_name}</div>
                    <span className="text-xs uppercase tracking-wider text-ink-mute">{m.category}</span>
                  </div>
                  <div className="mt-2 text-xs text-ink-mute">{variantTypeLabel(m.variant_type, m.variant_count)}</div>
                  <div className="mt-0.5 text-xs text-ink-mute">{m.tier_count} price tier{m.tier_count === 1 ? '' : 's'}</div>
                </Link>
              ))}
            </div>
          </section>

          {/* Add-ons */}
          <section>
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-widest text-ink-mute">Add-ons</h3>
            <div className="overflow-hidden rounded-[14px] bg-surface border border-line">
              {addOns.map((a, i) => (
                <Link
                  key={a.id}
                  to={`/admin/pricing/add-ons/${a.code}`}
                  className={[
                    'flex items-center gap-4 px-5 py-3 hover:bg-canvas',
                    i > 0 ? 'border-t border-line-soft' : '',
                  ].join(' ')}
                >
                  <div className="flex-1">
                    <div className="text-sm font-medium text-ink">{a.display_name}</div>
                    <div className="text-xs text-ink-mute">{pricingModelLabel(a.pricing_model)}</div>
                  </div>
                  {!a.has_prices && a.pricing_model !== 'custom_quote' && (
                    <span className="shrink-0 rounded-full bg-low-soft px-2 py-0.5 text-xs font-semibold text-low">
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

const pricingInputClass = 'rounded-lg border border-line px-3 py-2 text-[17px] sm:text-sm focus:border-[var(--c-brand)] focus:outline focus:outline-2 focus:outline-offset-[-1px] focus:outline-[var(--c-brand)]'
