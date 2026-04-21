import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import PriceCell, { currencySymbol } from './PriceCell'
import { downloadPricingExport } from '../../lib/pricingIO'
import { logAudit } from '../../lib/audit'

// ── Types ────────────────────────────────────────────────────────────────────

type Currency = 'GBP' | 'EUR' | 'USD'
const CURRENCIES: Currency[] = ['GBP', 'EUR', 'USD']

interface Material {
  id: string
  code: string
  display_name: string
  category: string
  variant_type: 'thickness' | 'ink_count' | 'finish' | 'default'
  is_published: boolean
  split_name_surcharge_gbp: number | null
  split_name_surcharge_eur: number | null
  split_name_surcharge_usd: number | null
}

interface Variant {
  id: string
  code: string
  display_name: string
  variant_type: 'thickness' | 'ink_count' | 'finish' | 'default'
  sort_order: number
  is_active: boolean
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

  // Variant management state (Phase 3b.1). Kept local to this page.
  const [editingVariantId, setEditingVariantId] = useState<string | null>(null)
  const [editingNameDraft, setEditingNameDraft] = useState('')
  const [adding, setAdding] = useState(false)
  const [addNameDraft, setAddNameDraft] = useState('')
  const [variantInFlight, setVariantInFlight] = useState(false)
  const [variantError, setVariantError] = useState<string | null>(null)

  // Price tier add / remove state (Phase 3b.2). Scoped to the current
  // active variant — resets whenever the admin switches tabs.
  const [tierAddOpen, setTierAddOpen] = useState(false)
  const [tierQtyDraft, setTierQtyDraft] = useState('')
  const [tierGbpDraft, setTierGbpDraft] = useState('')
  const [tierEurDraft, setTierEurDraft] = useState('')
  const [tierUsdDraft, setTierUsdDraft] = useState('')
  const [tierInFlight, setTierInFlight] = useState(false)
  const [tierError, setTierError] = useState<string | null>(null)
  const [removeConfirmQty, setRemoveConfirmQty] = useState<number | null>(null)

  useEffect(() => { if (code) load(code) }, [code])

  // Reset the tier add form whenever the admin switches variant tabs,
  // so drafts from one variant don't leak into another.
  useEffect(() => {
    setTierAddOpen(false)
    setTierQtyDraft('')
    setTierGbpDraft('')
    setTierEurDraft('')
    setTierUsdDraft('')
    setTierError(null)
    setRemoveConfirmQty(null)
  }, [activeVariantId])

  async function load(materialCode: string) {
    setLoading(true)
    setLoadError(null)
    try {
      const { data: matData, error: matErr } = await supabase
        .from('materials')
        .select('id, code, display_name, category, variant_type, is_published, split_name_surcharge_gbp, split_name_surcharge_eur, split_name_surcharge_usd')
        .eq('code', materialCode)
        .single()
      if (matErr || !matData) throw matErr ?? new Error('Material not found')

      // Pull active + inactive variants; the Variants section below the
      // surcharge block needs to show deactivated rows for recovery, and
      // the Price tiers tab strip filters active-only at render time.
      const [varResult, tierResult] = await Promise.all([
        supabase.from('material_variants')
          .select('id, code, display_name, variant_type, sort_order, is_active')
          .eq('material_id', matData.id)
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

      setMaterial(matData as Material)
      setVariants(variants)
      setTiers((tierResult.data ?? []) as Tier[])
      // Tab strip should default to the first ACTIVE variant so we don't
      // land the admin on a deactivated tab.
      setActiveVariantId(variants.find((v) => v.is_active)?.id ?? null)
    } catch (e) {
      setLoadError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  async function saveSurcharge(currency: Currency, nextValue: number) {
    if (!material) return
    const col = `split_name_surcharge_${currency.toLowerCase()}` as
      'split_name_surcharge_gbp' | 'split_name_surcharge_eur' | 'split_name_surcharge_usd'
    const prevValue = material[col]
    const { error } = await supabase
      .from('materials')
      .update({ [col]: nextValue })
      .eq('id', material.id)
    if (error) throw new Error(error.message)
    setMaterial((prev) => prev ? ({ ...prev, [col]: nextValue } as Material) : prev)
    void logAudit({
      action: 'material_surcharge.updated',
      targetType: 'material',
      targetId: material.id,
      targetLabel: `${material.display_name} (split-name ${currency})`,
      beforeValue: { currency, surcharge: prevValue },
      afterValue: { currency, surcharge: nextValue },
    })
  }

  async function saveTier(tierId: string, quantity: number, nextTotal: number) {
    const nextUnit = Number((nextTotal / quantity).toFixed(4))
    const existing = tiers.find((t) => t.id === tierId)
    const prevTotal = existing?.total_price ?? null
    const { error } = await supabase
      .from('price_tiers')
      .update({ total_price: nextTotal, unit_price: nextUnit })
      .eq('id', tierId)
    if (error) throw new Error(error.message)
    setTiers((prev) => prev.map((t) =>
      t.id === tierId ? { ...t, total_price: nextTotal, unit_price: nextUnit } : t,
    ))
    const variant = variants.find((v) => v.id === existing?.material_variant_id)
    void logAudit({
      action: 'price_tier.updated',
      targetType: 'price_tier',
      targetId: tierId,
      targetLabel: `${material?.display_name ?? ''} ${variant?.display_name ?? ''} @ qty ${quantity}`,
      beforeValue: { currency: existing?.currency, total_price: prevTotal },
      afterValue: { currency: existing?.currency, total_price: nextTotal },
    })
  }

  // ── Variant management helpers ────────────────────────────────────────

  // Check whether a candidate display name already exists among this
  // material's variants (case-insensitive). Excludes the variant being
  // renamed so it can keep its own name unchanged.
  function hasDuplicateDisplayName(candidate: string, excludeVariantId: string | null): boolean {
    const lc = candidate.trim().toLowerCase()
    return variants.some((v) =>
      v.id !== excludeVariantId && v.display_name.trim().toLowerCase() === lc,
    )
  }

  // Produce a unique (material_id, code) pair for the new variant.
  // Slugifies display_name; falls back to variant-<uuid8> when the
  // slug comes out empty (e.g. admin types "—" or "!!"). Suffixes
  // -2, -3… on collision with existing variant codes.
  function generateUniqueVariantCode(displayName: string, existing: string[]): string {
    let base = displayName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '')
    if (!base) base = `variant-${crypto.randomUUID().slice(0, 8)}`
    if (!existing.includes(base)) return base
    let n = 2
    while (existing.includes(`${base}-${n}`)) n++
    return `${base}-${n}`
  }

  async function handleAddVariant() {
    if (!material) return
    setVariantError(null)
    const trimmed = addNameDraft.trim()
    if (!trimmed) { setVariantError('Name is required.'); return }
    if (hasDuplicateDisplayName(trimmed, null)) {
      setVariantError('A variant with this name already exists.')
      return
    }
    setVariantInFlight(true)
    try {
      const code = generateUniqueVariantCode(trimmed, variants.map((v) => v.code))
      const nextSortOrder = variants.reduce((m, v) => Math.max(m, v.sort_order), 0) + 10
      const insertRow = {
        material_id: material.id,
        code,
        display_name: trimmed,
        variant_type: material.variant_type,
        sort_order: nextSortOrder,
        is_active: true,
      }
      const { data: created, error: err } = await supabase
        .from('material_variants')
        .insert(insertRow)
        .select('id, code, display_name, variant_type, sort_order, is_active')
        .single()
      if (err || !created) throw new Error(err?.message ?? 'Unknown error')

      const createdVariant = created as Variant
      setVariants((prev) => [...prev, createdVariant])
      // If this is the first active variant on the material, it also
      // becomes the tab strip's default selection.
      if (!activeVariantId) setActiveVariantId(createdVariant.id)
      setAdding(false)
      setAddNameDraft('')
      void logAudit({
        action: 'variant_created',
        targetType: 'material_variant',
        targetId: createdVariant.id,
        targetLabel: `${material.display_name} — ${createdVariant.display_name}`,
        metadata: insertRow,
      })
    } catch (e) {
      setVariantError(`Failed to create variant: ${(e as Error).message}`)
    } finally {
      setVariantInFlight(false)
    }
  }

  async function saveVariantName() {
    if (!editingVariantId || !material) return
    const current = variants.find((v) => v.id === editingVariantId)
    if (!current) return
    const trimmed = editingNameDraft.trim()
    if (trimmed === current.display_name) {
      setEditingVariantId(null)
      return
    }
    if (!trimmed) { setVariantError('Name is required.'); return }
    if (hasDuplicateDisplayName(trimmed, editingVariantId)) {
      setVariantError('A variant with this name already exists.')
      return
    }
    setVariantInFlight(true)
    setVariantError(null)
    const prev = current.display_name
    // Optimistic update
    setVariants((vs) => vs.map((v) =>
      v.id === editingVariantId ? { ...v, display_name: trimmed } : v,
    ))
    const { error: err } = await supabase
      .from('material_variants')
      .update({ display_name: trimmed })
      .eq('id', editingVariantId)
    setVariantInFlight(false)
    if (err) {
      // Rollback
      setVariants((vs) => vs.map((v) =>
        v.id === editingVariantId ? { ...v, display_name: prev } : v,
      ))
      setVariantError(`Failed to rename: ${err.message}`)
      return
    }
    setEditingVariantId(null)
    void logAudit({
      action: 'variant.display_name_updated',
      targetType: 'material_variant',
      targetId: editingVariantId,
      targetLabel: `${material.display_name} — ${trimmed}`,
      beforeValue: { display_name: prev },
      afterValue: { display_name: trimmed },
    })
  }

  async function toggleVariantActive(variantId: string) {
    if (!material) return
    const current = variants.find((v) => v.id === variantId)
    if (!current) return
    const next = !current.is_active
    setVariantInFlight(true)
    setVariantError(null)
    // Optimistic update
    setVariants((vs) => vs.map((v) =>
      v.id === variantId ? { ...v, is_active: next } : v,
    ))
    const { error: err } = await supabase
      .from('material_variants')
      .update({ is_active: next })
      .eq('id', variantId)
    setVariantInFlight(false)
    if (err) {
      // Rollback
      setVariants((vs) => vs.map((v) =>
        v.id === variantId ? { ...v, is_active: !next } : v,
      ))
      setVariantError(`Failed to update variant: ${err.message}`)
      return
    }
    // Keep the tab strip sensible: if the currently-selected tab was
    // just deactivated, jump to another active variant (or null).
    if (!next && activeVariantId === variantId) {
      const remaining = variants.filter((v) => v.id !== variantId && v.is_active)
      setActiveVariantId(remaining[0]?.id ?? null)
    }
    // If nothing was selected and we just reactivated, pick it up.
    if (next && !activeVariantId) setActiveVariantId(variantId)
    void logAudit({
      action: next ? 'variant_activated' : 'variant_deactivated',
      targetType: 'material_variant',
      targetId: variantId,
      targetLabel: `${material.display_name} — ${current.display_name}`,
      beforeValue: { is_active: !next },
      afterValue: { is_active: next },
    })
  }

  // ── Price tier add / remove (Phase 3b.2) ──────────────────────────────

  // Parse a decimal price string into a non-negative number, or return
  // null if it doesn't pass. Zero is allowed.
  function parseNonNegative(input: string): number | null {
    const trimmed = input.trim()
    if (trimmed === '') return null
    const n = Number(trimmed)
    if (!Number.isFinite(n) || n < 0) return null
    return Number(n.toFixed(2))
  }

  // Close the add form and wipe its drafts. Shared by Save/Cancel/tab
  // switch so callers never leave stale state.
  function resetTierAddForm() {
    setTierAddOpen(false)
    setTierQtyDraft('')
    setTierGbpDraft('')
    setTierEurDraft('')
    setTierUsdDraft('')
    setTierError(null)
  }

  async function handleAddTier() {
    if (!material) return
    const variantId = activeVariantId ?? variants.find((v) => v.is_active)?.id
    if (!variantId) { setTierError('No active variant selected.'); return }
    const variant = variants.find((v) => v.id === variantId)
    if (!variant) { setTierError('Variant not found.'); return }

    setTierError(null)

    // Quantity: required, positive integer, unique on this variant.
    const qty = parseInt(tierQtyDraft.trim(), 10)
    if (!Number.isFinite(qty) || qty <= 0 || !Number.isInteger(Number(tierQtyDraft.trim()))) {
      setTierError('Quantity must be a positive whole number.')
      return
    }
    const existingQtys = new Set(
      tiers
        .filter((t) => t.material_variant_id === variantId)
        .map((t) => t.quantity),
    )
    if (existingQtys.has(qty)) {
      setTierError(`A tier for ${qty.toLocaleString()} units already exists. Edit the existing row or remove it first.`)
      return
    }

    // All three prices required, zero allowed.
    const gbp = parseNonNegative(tierGbpDraft)
    const eur = parseNonNegative(tierEurDraft)
    const usd = parseNonNegative(tierUsdDraft)
    if (gbp === null || eur === null || usd === null) {
      setTierError('All three prices are required. Use 0 for "no charge" rather than leaving a field blank.')
      return
    }

    setTierInFlight(true)
    try {
      // Single batch INSERT → one SQL statement → atomic. Either all
      // three rows land or none do.
      const rows = (['GBP', 'EUR', 'USD'] as Currency[]).map((currency) => {
        const total = currency === 'GBP' ? gbp : currency === 'EUR' ? eur : usd
        const unit = Number((total / qty).toFixed(4))
        return {
          material_variant_id: variantId,
          currency,
          quantity: qty,
          total_price: total,
          unit_price: unit,
        }
      })
      const { data: created, error: err } = await supabase
        .from('price_tiers')
        .insert(rows)
        .select('id, material_variant_id, currency, quantity, total_price, unit_price')
      if (err || !created) throw new Error(err?.message ?? 'Unknown error')

      setTiers((prev) => [...prev, ...(created as Tier[])])

      // One audit event per DB row. Mirrors price_tier.updated granularity.
      for (const row of created as Tier[]) {
        void logAudit({
          action: 'price_tier_created',
          targetType: 'price_tier',
          targetId: row.id,
          targetLabel: `${material.display_name} ${variant.display_name} @ qty ${qty}`,
          afterValue: { currency: row.currency, total_price: row.total_price, quantity: qty },
        })
      }
      resetTierAddForm()
    } catch (e) {
      setTierError(`Failed to add tier: ${(e as Error).message}`)
    } finally {
      setTierInFlight(false)
    }
  }

  async function handleDeleteTier(qty: number) {
    if (!material) return
    const variantId = activeVariantId ?? variants.find((v) => v.is_active)?.id
    if (!variantId) return
    const variant = variants.find((v) => v.id === variantId)
    if (!variant) return
    const doomed = tiers.filter(
      (t) => t.material_variant_id === variantId && t.quantity === qty,
    )
    if (doomed.length === 0) return

    setTierInFlight(true)
    setTierError(null)
    try {
      // Single DELETE filtered by (variant, quantity) removes all three
      // currency rows atomically.
      const { error: err } = await supabase
        .from('price_tiers')
        .delete()
        .eq('material_variant_id', variantId)
        .eq('quantity', qty)
      if (err) throw new Error(err.message)

      setTiers((prev) => prev.filter(
        (t) => !(t.material_variant_id === variantId && t.quantity === qty),
      ))

      for (const row of doomed) {
        void logAudit({
          action: 'price_tier_deleted',
          targetType: 'price_tier',
          targetId: row.id,
          targetLabel: `${material.display_name} ${variant.display_name} @ qty ${qty}`,
          beforeValue: { currency: row.currency, total_price: row.total_price, quantity: qty },
        })
      }
      setRemoveConfirmQty(null)
    } catch (e) {
      setTierError(`Failed to remove tier: ${(e as Error).message}`)
    } finally {
      setTierInFlight(false)
    }
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
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link to="/admin/pricing" className="text-xs text-gray-400 hover:text-gray-700">← Back to pricing</Link>
          <div className="mt-2 flex items-center gap-3">
            <h2 className="text-xl font-bold text-gray-900">{material.display_name}</h2>
            {/* Read-only status pill. Publish toggle lives on the
                Settings-page material modal (single source of truth);
                this is just a glanceable indicator for price entry. */}
            {material.is_published ? (
              <span
                className="inline-block rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-semibold text-emerald-700"
                title="This material is visible to designers. Manage on the Settings page."
              >
                Published
              </span>
            ) : (
              <span
                className="inline-block rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-700"
                title="This material is hidden from designers. Publish from the Settings page."
              >
                Unpublished
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-gray-500">
            Changes save automatically. Customer-facing prices update immediately.
          </p>
        </div>
        <button
          onClick={() => downloadPricingExport(`material:${material.code}`, `pricing_${material.code}.csv`).catch(() => {})}
          className="shrink-0 rounded-lg px-3 py-2 text-sm font-medium text-gray-600 ring-1 ring-gray-200 hover:bg-gray-50"
        >
          Export this material
        </button>
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

      {/* Variants */}
      <section>
        <div className="mb-3 flex items-center justify-between gap-4">
          <h3 className="text-sm font-semibold text-gray-900">Variants</h3>
          {material.variant_type !== 'default' && !adding && (
            <button
              type="button"
              onClick={() => { setVariantError(null); setAdding(true) }}
              disabled={variantInFlight}
              className="rounded-lg bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
            >
              Add variant
            </button>
          )}
        </div>

        {material.variant_type === 'default' ? (
          // Default materials have a single implicit variant created by
          // the admin create-material flow. No rename, no toggle, no add
          // — variant management isn't meaningful here.
          <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-gray-200">
            {variants[0] ? (
              <div className="flex items-center gap-3">
                <span className="text-sm font-medium text-gray-900">{variants[0].display_name}</span>
                <span className="inline-block rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-600">
                  Single variant
                </span>
              </div>
            ) : (
              <p className="text-sm text-gray-400">No variant.</p>
            )}
            <p className="mt-2 text-xs text-gray-500">
              This material has a single implicit variant. Variant management is only meaningful for materials with multiple options.
            </p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-gray-200">
            {variants.length === 0 && !adding ? (
              <p className="px-4 py-6 text-sm text-gray-400">No variants yet. Click "Add variant" to create one.</p>
            ) : (
              variants.map((v, i) => {
                const isEditing = editingVariantId === v.id
                return (
                  <div
                    key={v.id}
                    className={[
                      'flex items-center gap-3 px-4 py-3',
                      i > 0 ? 'border-t border-gray-100' : '',
                      v.is_active ? '' : 'opacity-60',
                    ].join(' ')}
                  >
                    {/* Display name: inline-editable */}
                    <div className="min-w-0 flex-1">
                      {isEditing ? (
                        <input
                          autoFocus
                          type="text"
                          value={editingNameDraft}
                          onChange={(e) => setEditingNameDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') { e.preventDefault(); void saveVariantName() }
                            if (e.key === 'Escape') {
                              setEditingVariantId(null); setVariantError(null)
                            }
                          }}
                          onBlur={() => { void saveVariantName() }}
                          disabled={variantInFlight}
                          className="w-full rounded-lg border border-gray-300 px-2.5 py-1 text-sm focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900"
                        />
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            setVariantError(null)
                            setEditingVariantId(v.id)
                            setEditingNameDraft(v.display_name)
                          }}
                          className="block w-full truncate text-left text-sm font-medium text-gray-900 hover:text-gray-600"
                          title="Click to rename"
                        >
                          {v.display_name}
                        </button>
                      )}
                    </div>

                    {/* Variant-type pill (read-only sanity check) */}
                    <span className="inline-block shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-600">
                      {v.variant_type}
                    </span>

                    {/* Deactivated pill */}
                    {!v.is_active && (
                      <span className="inline-block shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">
                        Deactivated
                      </span>
                    )}

                    {/* Active toggle */}
                    <button
                      type="button"
                      onClick={() => void toggleVariantActive(v.id)}
                      disabled={variantInFlight}
                      role="switch"
                      aria-checked={v.is_active}
                      title={v.is_active ? 'Deactivate variant' : 'Activate variant'}
                      className={[
                        'relative inline-flex h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50',
                        v.is_active ? 'bg-gray-900' : 'bg-gray-200',
                      ].join(' ')}
                    >
                      <span
                        className={[
                          'inline-block h-5 w-5 transform rounded-full bg-white transition-transform',
                          v.is_active ? 'translate-x-[1.375rem] translate-y-0.5' : 'translate-x-0.5 translate-y-0.5',
                        ].join(' ')}
                      />
                    </button>
                  </div>
                )
              })
            )}

            {/* Inline add row */}
            {adding && (
              <div className={[
                'flex items-center gap-3 px-4 py-3',
                variants.length > 0 ? 'border-t border-gray-100 bg-gray-50' : 'bg-gray-50',
              ].join(' ')}>
                <input
                  autoFocus
                  type="text"
                  value={addNameDraft}
                  onChange={(e) => setAddNameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); void handleAddVariant() }
                    if (e.key === 'Escape') {
                      setAdding(false); setAddNameDraft(''); setVariantError(null)
                    }
                  }}
                  disabled={variantInFlight}
                  placeholder={
                    material.variant_type === 'thickness' ? 'e.g. 1mm' :
                    material.variant_type === 'ink_count' ? 'e.g. 2 inks' :
                    material.variant_type === 'finish' ? 'e.g. Brushed' :
                    'Variant name'
                  }
                  className="min-w-0 flex-1 rounded-lg border border-gray-300 px-2.5 py-1 text-sm focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900"
                />
                <button
                  type="button"
                  onClick={() => void handleAddVariant()}
                  disabled={variantInFlight || !addNameDraft.trim()}
                  className="shrink-0 rounded-lg bg-gray-900 px-3 py-1 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
                >
                  {variantInFlight ? 'Saving…' : 'Save'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAdding(false); setAddNameDraft(''); setVariantError(null)
                  }}
                  disabled={variantInFlight}
                  className="shrink-0 rounded-lg px-3 py-1 text-sm font-medium text-gray-500 hover:bg-white disabled:opacity-50"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        )}

        {variantError && (
          <p className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{variantError}</p>
        )}
      </section>

      {/* Price grid */}
      <section>
        <h3 className="mb-3 text-sm font-semibold text-gray-900">Price tiers</h3>
        {(() => {
          const activeVariants = variants.filter((v) => v.is_active)
          if (activeVariants.length === 0) {
            return <p className="text-sm text-gray-400">No active variants yet.</p>
          }
          // Default materials keep their single implicit variant as-is;
          // multi-variant materials render a tab strip above the grid.
          const renderedVariantId = material.variant_type === 'default'
            ? activeVariants[0].id
            : activeVariantId
          const tiersForVariant = tiers.filter((t) => t.material_variant_id === renderedVariantId)
          const isEmpty = tiersForVariant.length === 0

          return (
            <>
              {material.variant_type !== 'default' && (
                /* Variant tab strip — active variants only. Deactivated
                   variants never surface here, they're managed via the
                   Variants section above. */
                <div className="mb-4 flex flex-wrap gap-2">
                  {activeVariants.map((v) => {
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
              )}

              {isEmpty ? (
                /* Bootstrap state: no tiers yet, show the add form open
                   with a soft lead-in so the next step is obvious. */
                <div className="space-y-3">
                  <p className="text-sm text-gray-500">No price tiers yet. Add the first one below.</p>
                  <AddTierForm
                    qty={tierQtyDraft}
                    gbp={tierGbpDraft}
                    eur={tierEurDraft}
                    usd={tierUsdDraft}
                    onQty={setTierQtyDraft}
                    onGbp={setTierGbpDraft}
                    onEur={setTierEurDraft}
                    onUsd={setTierUsdDraft}
                    onSave={() => void handleAddTier()}
                    inFlight={tierInFlight}
                  />
                </div>
              ) : (
                <>
                  <PriceGrid
                    tiers={tiersForVariant}
                    onSave={saveTier}
                    onRemoveQty={(qty) => { setTierError(null); setRemoveConfirmQty(qty) }}
                  />
                  <div className="mt-4">
                    {tierAddOpen ? (
                      <AddTierForm
                        qty={tierQtyDraft}
                        gbp={tierGbpDraft}
                        eur={tierEurDraft}
                        usd={tierUsdDraft}
                        onQty={setTierQtyDraft}
                        onGbp={setTierGbpDraft}
                        onEur={setTierEurDraft}
                        onUsd={setTierUsdDraft}
                        onSave={() => void handleAddTier()}
                        onCancel={resetTierAddForm}
                        inFlight={tierInFlight}
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => { setTierError(null); setTierAddOpen(true) }}
                        className="rounded-lg px-3 py-2 text-sm font-medium text-gray-600 ring-1 ring-gray-200 hover:bg-gray-50"
                      >
                        Add tier
                      </button>
                    )}
                  </div>
                </>
              )}

              {tierError && (
                <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{tierError}</p>
              )}
            </>
          )
        })()}
      </section>

      {/* Soft-confirm for removing a tier. Destructive button is rose
          so the admin can't click through absent-mindedly. */}
      {removeConfirmQty != null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl ring-1 ring-gray-200">
            <h4 className="text-base font-semibold text-gray-900">Remove this tier?</h4>
            <p className="mt-2 text-sm text-gray-600">
              Remove the price tier for {removeConfirmQty.toLocaleString()} units? This removes the GBP, EUR and USD prices for this quantity and cannot be undone.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setRemoveConfirmQty(null)}
                disabled={tierInFlight}
                className="rounded-lg px-4 py-2 text-sm font-medium text-gray-500 hover:bg-gray-100 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => { if (removeConfirmQty != null) void handleDeleteTier(removeConfirmQty) }}
                disabled={tierInFlight}
                className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-500 disabled:opacity-50"
              >
                {tierInFlight ? 'Removing…' : 'Remove tier'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Add-tier form ────────────────────────────────────────────────────────────
//
// Inline row with four inputs (quantity + three currency totals) plus
// Save/Cancel. Extracted so the bootstrap and normal paths share markup.
// Parent owns validation and errors.

function AddTierForm({
  qty, gbp, eur, usd,
  onQty, onGbp, onEur, onUsd,
  onSave, onCancel, inFlight,
}: {
  qty: string
  gbp: string
  eur: string
  usd: string
  onQty: (v: string) => void
  onGbp: (v: string) => void
  onEur: (v: string) => void
  onUsd: (v: string) => void
  onSave: () => void
  /** Omit to hide Cancel (used in the bootstrap-empty path). */
  onCancel?: () => void
  inFlight: boolean
}) {
  const canSave = qty.trim() !== '' && gbp.trim() !== '' && eur.trim() !== '' && usd.trim() !== ''
  return (
    <div className="rounded-2xl bg-gray-50 p-4 ring-1 ring-gray-200">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-gray-400">Quantity</label>
          <input
            type="number"
            min="1"
            step="1"
            value={qty}
            onChange={(e) => onQty(e.target.value)}
            disabled={inFlight}
            className="w-28 rounded border border-gray-200 px-2 py-1 text-sm tabular-nums focus:border-gray-900 focus:outline-none"
            placeholder="e.g. 500"
          />
        </div>
        <CurrencyTotalField label="GBP (inc VAT)" symbol="£" value={gbp} onChange={onGbp} disabled={inFlight} />
        <CurrencyTotalField label="EUR (ex VAT)"  symbol="€" value={eur} onChange={onEur} disabled={inFlight} />
        <CurrencyTotalField label="USD (ex VAT)"  symbol="$" value={usd} onChange={onUsd} disabled={inFlight} />
        <div className="ml-auto flex items-center gap-2">
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              disabled={inFlight}
              className="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-500 hover:bg-white disabled:opacity-50"
            >
              Cancel
            </button>
          )}
          <button
            type="button"
            onClick={onSave}
            disabled={inFlight || !canSave}
            className="rounded-lg bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
          >
            {inFlight ? 'Saving…' : 'Save tier'}
          </button>
        </div>
      </div>
    </div>
  )
}

function CurrencyTotalField({ label, symbol, value, onChange, disabled }: {
  label: string
  symbol: string
  value: string
  onChange: (v: string) => void
  disabled: boolean
}) {
  return (
    <div>
      <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-gray-400">{label}</label>
      <div className="relative">
        <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-gray-400">{symbol}</span>
        <input
          type="number"
          step="0.01"
          min="0"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className="w-28 rounded border border-gray-200 px-2 py-1 pl-5 text-sm tabular-nums focus:border-gray-900 focus:outline-none"
          placeholder="0.00"
        />
      </div>
    </div>
  )
}

// ── Price grid ───────────────────────────────────────────────────────────────

function PriceGrid({ tiers, onSave, onRemoveQty }: {
  tiers: Tier[]
  onSave: (tierId: string, quantity: number, nextTotal: number) => Promise<void>
  /** Optional per-row remove handler. Omit to hide the Remove column. */
  onRemoveQty?: (quantity: number) => void
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

  // Empty state is handled by the parent so it can decide whether to
  // render bootstrap copy + an open add form instead of nothing.
  if (byQty.length === 0) return null

  return (
    <div className="overflow-x-auto rounded-2xl bg-white shadow-sm ring-1 ring-gray-200">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-100">
            <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Qty</th>
            {CURRENCIES.map((c) => (
              <th key={c} colSpan={2} className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">
                {c} {c === 'GBP' ? '(inc VAT)' : '(ex VAT)'}
              </th>
            ))}
            {onRemoveQty && (
              <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-gray-400"></th>
            )}
          </tr>
          <tr className="border-b border-gray-100">
            <th className="px-4 pb-2 text-left text-[11px] font-medium uppercase tracking-wider text-gray-300" />
            {CURRENCIES.flatMap((c) => ([
              <th key={`${c}-total`} className="px-4 pb-2 text-left text-[11px] font-medium uppercase tracking-wider text-gray-400">Total</th>,
              <th key={`${c}-unit`} className="px-4 pb-2 text-left text-[11px] font-medium uppercase tracking-wider text-gray-400">Unit</th>,
            ]))}
            {onRemoveQty && <th className="px-4 pb-2" />}
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
              {onRemoveQty && (
                <td className="px-4 py-2 text-right">
                  <button
                    type="button"
                    onClick={() => onRemoveQty(qty)}
                    title={`Remove tier for ${qty.toLocaleString()} units`}
                    className="rounded px-2 py-0.5 text-xs font-medium text-gray-400 hover:bg-rose-50 hover:text-rose-600"
                  >
                    Remove
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
