import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ChevronRight, Hash, Tag, Plus, X } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import PriceCell, { currencySymbol } from './PriceCell'
import AdminPricingImport from './AdminPricingImport'
import Modal from '../../components/Modal'
import { downloadPricingExport } from '../../lib/pricingIO'
import { logAudit } from '../../lib/audit'
import { PanelShell, ButtonGhost, ButtonInk, tokens } from '../../design'

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
  // Currency the tier matrix is showing (screen 06 currency strip).
  // The grid filters price_tiers to this currency; switching re-pivots
  // the matrix without a refetch (all currencies are already loaded).
  const [editCurrency, setEditCurrency] = useState<Currency>('GBP')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Variant management state (Phase 3b.1). Kept local to this page.
  const [editingVariantId, setEditingVariantId] = useState<string | null>(null)
  const [editingNameDraft, setEditingNameDraft] = useState('')
  const [adding, setAdding] = useState(false)
  const [addNameDraft, setAddNameDraft] = useState('')
  const [variantInFlight, setVariantInFlight] = useState(false)
  const [variantError, setVariantError] = useState<string | null>(null)

  // Import modal (Phase 3b.3). Lets the admin upload a material-scoped
  // CSV that can create new tiers as well as update existing ones.
  const [showImport, setShowImport] = useState(false)

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

  async function saveSurcharge(currency: Currency, nextValue: number | null) {
    if (!material) return
    const col = `split_name_surcharge_${currency.toLowerCase()}` as
      'split_name_surcharge_gbp' | 'split_name_surcharge_eur' | 'split_name_surcharge_usd'
    const prevValue = material[col]
    // The column is nullable; null = "this material no longer offers
    // split-name pricing in this currency". Cleared cells write null
    // rather than 0 so the customer-facing render path can still
    // distinguish "no surcharge applies" from "surcharge is £0".
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

  // Matrix-cell save: update the (variant, quantity, currency) tier if
  // it exists, otherwise insert one. Lets every cell in the tier matrix
  // be edited directly — including gaps where a variant is missing a
  // quantity in the selected currency. Inserts are single-currency
  // (the matrix is per-currency); the multi-currency batch insert still
  // lives in handleAddTier for adding a brand-new quantity column.
  async function saveTierCell(variantId: string, quantity: number, nextTotal: number) {
    const existing = tiers.find(
      (t) => t.material_variant_id === variantId && t.quantity === quantity && t.currency === editCurrency,
    )
    if (existing) {
      await saveTier(existing.id, quantity, nextTotal)
      return
    }
    const nextUnit = Number((nextTotal / quantity).toFixed(4))
    const { data: created, error } = await supabase
      .from('price_tiers')
      .insert({
        material_variant_id: variantId,
        currency: editCurrency,
        quantity,
        total_price: nextTotal,
        unit_price: nextUnit,
      })
      .select('id, material_variant_id, currency, quantity, total_price, unit_price')
      .single()
    if (error || !created) throw new Error(error?.message ?? 'Insert failed')
    setTiers((prev) => [...prev, created as Tier])
    const variant = variants.find((v) => v.id === variantId)
    void logAudit({
      action: 'price_tier.created',
      targetType: 'price_tier',
      targetId: (created as Tier).id,
      targetLabel: `${material?.display_name ?? ''} ${variant?.display_name ?? ''} @ qty ${quantity}`,
      beforeValue: { currency: editCurrency, total_price: null },
      afterValue: { currency: editCurrency, total_price: nextTotal },
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
      // Close the input on failure too — without this, the row
      // showed the rolled-back name in state but kept the open
      // input with the user's typed value, which read as "did
      // my edit save or not?" The error pill makes the failure
      // explicit; the input doesn't need to stay open.
      setEditingVariantId(null)
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
    // Strict-digits regex up-front so silent quirks of parseInt /
    // Number don't sneak through — e.g. "1e3" parses to 1 via
    // parseInt and to 1000 via Number, both pass the loose check
    // but neither is what the designer typed.
    const qtyDraft = tierQtyDraft.trim()
    if (!/^\d+$/.test(qtyDraft)) {
      setTierError('Quantity must be a positive whole number.')
      return
    }
    const qty = parseInt(qtyDraft, 10)
    if (qty <= 0) {
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
    // In the transposed matrix a quantity is a COLUMN spanning every
    // variant, so removing it clears that quantity for all of the
    // material's variants (every currency) — not just one variant.
    const variantIds = variants.map((v) => v.id)
    const doomed = tiers.filter(
      (t) => variantIds.includes(t.material_variant_id) && t.quantity === qty,
    )
    if (doomed.length === 0) return

    setTierInFlight(true)
    setTierError(null)
    try {
      const { error: err } = await supabase
        .from('price_tiers')
        .delete()
        .in('material_variant_id', variantIds)
        .eq('quantity', qty)
      if (err) throw new Error(err.message)

      setTiers((prev) => prev.filter((t) => t.quantity !== qty))

      for (const row of doomed) {
        const variant = variants.find((v) => v.id === row.material_variant_id)
        void logAudit({
          action: 'price_tier_deleted',
          targetType: 'price_tier',
          targetId: row.id,
          targetLabel: `${material.display_name} ${variant?.display_name ?? ''} @ qty ${qty}`,
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
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-line motion-reduce:animate-none" style={{ borderTopColor: 'var(--c-ink)' }} />
      </div>
    )
  }
  if (loadError || !material) {
    return (
      <div className="rounded-[14px] bg-out-soft p-6 text-sm text-out border border-out">
        Failed to load material: {loadError ?? 'not found'}
      </div>
    )
  }

  // Meta line summarising the editable surface, per screen 06.
  // Descriptor word follows the material's variant_type; no
  // materials.notes field exists today so the trailing descriptor
  // is derived from the variant type + published state rather than
  // free-text copy.
  const variantWord =
    material.variant_type === 'thickness' ? 'thickness variants' :
    material.variant_type === 'ink_count' ? 'ink-count variants' :
    material.variant_type === 'finish'    ? 'finish variants' :
                                            'variant'
  const metaLine = [
    `${variants.length} ${variantWord}`,
    'GBP, EUR, USD',
    `${tiers.length} tier prices`,
    material.is_published ? 'published' : 'unpublished',
  ].join(' · ')

  return (
    <div className="space-y-6">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-1.5 text-[13px]">
        <Link to="/admin/pricing" className="text-ink-mute hover:text-ink transition-colors">Pricing</Link>
        <ChevronRight size={14} className="text-ink-dim" aria-hidden="true" />
        <span className="text-ink-soft truncate">{material.display_name}</span>
      </nav>

      {/* Header card — swatch + title + meta line on the left, actions
          on the right. No material colour field exists today, so the
          swatch is a neutral placeholder. */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-4 min-w-0">
          <span
            aria-hidden="true"
            className="shrink-0 w-12 h-12 rounded-[8px] border border-line"
            style={{ backgroundColor: 'var(--c-ink-dim)' }}
          />
          <div className="min-w-0">
            <h1 className="font-display font-medium tracking-[-0.02em] text-ink leading-tight m-0" style={{ fontSize: 'clamp(24px, 4vw, 32px)' }}>
              {material.display_name}
            </h1>
            <p className="mt-1 text-[13px] text-ink-mute">{metaLine}</p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <ButtonGhost
            onClick={() => downloadPricingExport(`material:${material.code}`, `pricing_${material.code}.csv`).catch(() => {})}
          >
            Export
          </ButtonGhost>
          {material.variant_type !== 'default' && !adding && (
            <ButtonGhost
              icon={Plus}
              disabled={variantInFlight}
              onClick={() => { setVariantError(null); setAdding(true) }}
            >
              Add variant
            </ButtonGhost>
          )}
          <ButtonInk onClick={() => setShowImport(true)}>Import</ButtonInk>
        </div>
      </div>

      {/* Currency strip — segmented GBP/EUR/USD + VAT explainer. The
          tier matrix below filters to the selected currency. */}
      <div className="rounded-[14px] bg-surface border border-line px-5 py-3.5 flex flex-wrap items-center gap-x-5 gap-y-2">
        <span className="eyebrow text-ink-mute">Currency</span>
        <div className="inline-flex items-center rounded-[8px] border border-line overflow-hidden">
          {CURRENCIES.map((c) => {
            const active = editCurrency === c
            return (
              <button
                key={c}
                type="button"
                onClick={() => setEditCurrency(c)}
                aria-pressed={active}
                className={[
                  'px-3.5 py-1.5 text-[13px] font-medium transition-colors',
                  active ? 'bg-ink text-on-ink' : 'bg-surface text-ink-soft hover:bg-canvas',
                ].join(' ')}
              >
                {c}
              </button>
            )
          })}
        </div>
        <span className="text-[13px] text-ink-mute">
          {editCurrency === 'GBP'
            ? '£ figures include VAT at 20%'
            : `${editCurrency} figures are VAT-free`}
        </span>
      </div>

      {showImport && code && (
        <AdminPricingImport
          scope={material.code}
          scopeLabel={material.display_name}
          onClose={() => setShowImport(false)}
          onCommitted={() => {
            // Reload prices so any newly-imported tiers surface immediately.
            void load(code)
          }}
        />
      )}

      {/* Tier prices — quantity rows × variant columns for the
          currency selected in the strip above. Quantities run down
          the table (tall, vertical scroll) so materials with many
          tiers — the metal schedules have ~39 — never trigger
          horizontal scroll. Each cell is a click-to-edit PriceCell
          (its brand focus ring matches the mockup's highlighted cell)
          with the per-card unit price below. The per-row Actions cell
          removes that quantity tier across every variant. */}
      {(() => {
        const activeVariants = variants.filter((v) => v.is_active)
        const tiersForCurrency = tiers.filter((t) => t.currency === editCurrency)
        const qtyList = [...new Set(tiersForCurrency.map((t) => t.quantity))].sort((a, b) => a - b)
        const tierFor = (variantId: string, qty: number) =>
          tiersForCurrency.find((t) => t.material_variant_id === variantId && t.quantity === qty) ?? null
        const eyebrow = `${activeVariants.length} ${activeVariants.length === 1 ? 'variant' : 'variants'} · ${qtyList.length} ${qtyList.length === 1 ? 'tier' : 'tiers'}`
        return (
          <PanelShell title="Tier prices" eyebrow={eyebrow} icon={Hash} accent={tokens.ink} padded={false}>
            {activeVariants.length === 0 ? (
              <p className="px-5 py-8 text-sm text-ink-mute">No active variants yet. Add one above to start building the price list.</p>
            ) : qtyList.length === 0 ? (
              <div className="px-5 py-6 space-y-3">
                <p className="text-sm text-ink-mute">No prices yet for {editCurrency}. Add your first quantity tier.</p>
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
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-line-soft">
                        <th className="px-5 py-3 text-left eyebrow text-ink-mute">Quantity</th>
                        {activeVariants.map((v) => (
                          <th key={v.id} className="px-4 py-3 text-right eyebrow text-ink-mute whitespace-nowrap border-l border-line-soft">
                            {v.display_name}
                          </th>
                        ))}
                        <th className="px-4 py-3 text-center eyebrow text-ink-mute w-16 border-l border-line-soft">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {qtyList.map((qty, ri) => (
                        <tr key={qty} className={ri > 0 ? 'border-t border-line-soft' : ''}>
                          {/* Quantity + sequential tier letter (A = smallest). */}
                          <td className="px-5 py-3 whitespace-nowrap">
                            <div className="font-mono text-[14px] font-medium text-ink tabular-nums">
                              {qty.toLocaleString()}
                            </div>
                            <div className="eyebrow text-ink-dim">tier {String.fromCharCode(65 + ri)}</div>
                          </td>
                          {activeVariants.map((v) => {
                            const tier = tierFor(v.id, qty)
                            return (
                              <td key={v.id} className="px-4 py-3 text-right border-l border-line-soft">
                                <div className="flex flex-col items-end">
                                  <PriceCell
                                    value={tier ? tier.total_price : null}
                                    currency={editCurrency}
                                    placeholder="—"
                                    onSave={(next) => saveTierCell(v.id, qty, next)}
                                  />
                                  {tier && (
                                    <span className="mt-0.5 font-mono text-[10px] text-ink-dim tabular-nums">
                                      {currencySymbol(editCurrency)}{(tier.total_price / qty).toFixed(2)}
                                    </span>
                                  )}
                                </div>
                              </td>
                            )
                          })}
                          <td className="px-4 py-3 text-center border-l border-line-soft">
                            <button
                              type="button"
                              onClick={() => { setTierError(null); setRemoveConfirmQty(qty) }}
                              title={`Remove the ${qty.toLocaleString()} tier (all variants)`}
                              aria-label={`Remove ${qty} tier`}
                              className="inline-flex items-center justify-center w-7 h-7 rounded-md text-ink-mute hover:text-out hover:bg-out-soft transition-colors"
                            >
                              <X size={13} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="px-5 py-4 border-t border-line-soft">
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
                    <ButtonGhost icon={Plus} onClick={() => { setTierError(null); setTierAddOpen(true) }}>
                      Add quantity tier
                    </ButtonGhost>
                  )}
                </div>
              </>
            )}
            {tierError && (
              <p className="mx-5 mb-4 rounded-lg bg-out-soft px-3 py-2 text-sm text-out">{tierError}</p>
            )}
          </PanelShell>
        )
      })()}

      {/* Variants */}
      <section>
        <div className="mb-3 flex items-center justify-between gap-4">
          <h3 className="text-sm font-semibold text-ink">Variants</h3>
          {material.variant_type !== 'default' && !adding && (
            <button
              type="button"
              onClick={() => { setVariantError(null); setAdding(true) }}
              disabled={variantInFlight}
              className="rounded-lg bg-ink px-3 py-1.5 text-sm font-medium text-on-ink hover:opacity-90 disabled:opacity-50"
            >
              Add variant
            </button>
          )}
        </div>

        {material.variant_type === 'default' ? (
          // Default materials have a single implicit variant created by
          // the admin create-material flow. No rename, no toggle, no add
          // — variant management isn't meaningful here.
          <div className="rounded-[14px] bg-surface p-6 border border-line">
            {variants[0] ? (
              <div className="flex items-center gap-3">
                <span className="text-sm font-medium text-ink">{variants[0].display_name}</span>
                <span className="inline-block rounded-full bg-line-soft px-2 py-0.5 text-xs font-semibold text-ink-soft">
                  Single variant
                </span>
              </div>
            ) : (
              <p className="text-sm text-ink-mute">No variant.</p>
            )}
            <p className="mt-2 text-xs text-ink-mute">
              This material has a single implicit variant. Variant management is only meaningful for materials with multiple options.
            </p>
          </div>
        ) : (
          <>
            {/* Soft bootstrap copy shown until the admin has added
                at least one variant. Matches the tone of the empty
                price-tier state below. */}
            {variants.length === 0 && !adding && (
              <p className="mb-3 text-sm text-ink-mute">
                No variants yet. Add your first variant below to start building the price list. For materials with a single price list, name it "Default".
              </p>
            )}
            {(variants.length > 0 || adding) && (
              <div className="overflow-hidden rounded-[14px] bg-surface border border-line">
                {variants.map((v, i) => {
                const isEditing = editingVariantId === v.id
                return (
                  <div
                    key={v.id}
                    className={[
                      'flex items-center gap-3 px-4 py-3',
                      i > 0 ? 'border-t border-line-soft' : '',
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
                          className="w-full rounded border border-line px-2.5 py-1 text-[17px] sm:text-sm focus:border-[var(--c-brand)] focus:bg-[var(--c-brand-50)] focus:outline-none"
                        />
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            setVariantError(null)
                            setEditingVariantId(v.id)
                            setEditingNameDraft(v.display_name)
                          }}
                          className="block w-full truncate text-left text-sm font-medium text-ink hover:text-ink-soft"
                          title="Click to rename"
                        >
                          {v.display_name}
                        </button>
                      )}
                    </div>

                    {/* Variant-type pill (read-only sanity check) */}
                    <span className="inline-block shrink-0 rounded-full bg-line-soft px-2 py-0.5 text-xs font-semibold text-ink-soft">
                      {v.variant_type}
                    </span>

                    {/* Deactivated pill */}
                    {!v.is_active && (
                      <span className="inline-block shrink-0 rounded-full bg-low-soft px-2 py-0.5 text-xs font-semibold text-low">
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
                        v.is_active ? 'bg-ink' : 'bg-line',
                      ].join(' ')}
                    >
                      <span
                        className={[
                          'inline-block h-5 w-5 transform rounded-full bg-surface transition-transform',
                          v.is_active ? 'translate-x-[1.375rem] translate-y-0.5' : 'translate-x-0.5 translate-y-0.5',
                        ].join(' ')}
                      />
                    </button>
                  </div>
                )
              })}

            {/* Inline add row — stacks below sm so the Save/Cancel pair
                doesn't get clipped off the right on phone widths. */}
            {adding && (
              <div className={[
                'flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center',
                variants.length > 0 ? 'border-t border-line-soft bg-canvas' : 'bg-canvas',
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
                  className="min-w-0 flex-1 rounded border border-line px-2.5 py-1 text-[17px] sm:text-sm focus:border-[var(--c-brand)] focus:bg-[var(--c-brand-50)] focus:outline-none"
                />
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => void handleAddVariant()}
                    disabled={variantInFlight || !addNameDraft.trim()}
                    className="shrink-0 rounded-lg bg-ink px-3 py-1 text-sm font-medium text-on-ink hover:opacity-90 disabled:opacity-50"
                  >
                    {variantInFlight ? 'Saving…' : 'Save'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setAdding(false); setAddNameDraft(''); setVariantError(null)
                    }}
                    disabled={variantInFlight}
                    className="shrink-0 rounded-lg px-3 py-1 text-sm font-medium text-ink-mute hover:bg-surface disabled:opacity-50"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
              </div>
            )}
          </>
        )}

        {variantError && (
          <p className="mt-2 rounded-lg bg-out-soft px-3 py-2 text-sm text-out">{variantError}</p>
        )}
      </section>

      {/* Split-name tooling surcharge — per-currency inputs + an info
          strip. Per extra name beyond the first; lives on the material,
          not the variant. */}
      <PanelShell
        title="Split-name tooling surcharge"
        eyebrow="Per extra name beyond the first"
        icon={Tag}
        accent={tokens.low}
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {CURRENCIES.map((currency) => {
            const col = `split_name_surcharge_${currency.toLowerCase()}` as keyof Material
            const val = material[col] as number | null
            return (
              <div key={currency}>
                <label className="eyebrow text-ink-mute block mb-1.5">
                  {currency} per extra name
                </label>
                <PriceCell
                  value={val}
                  currency={currency}
                  allowClear
                  onSave={(next) => saveSurcharge(currency, next)}
                  placeholder="—"
                />
              </div>
            )
          })}
        </div>
        <div
          className="mt-4 rounded-lg px-3 py-2.5 text-[12px] leading-[1.5] text-ink-soft"
          style={{
            backgroundColor: 'var(--c-low-soft)',
            boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--c-low) 30%, transparent)',
          }}
        >
          Surcharge lives on the material, not the variant. The new-version
          form doesn't expose this — designers manually override the snapshot
          when more than one name is in play.
        </div>
      </PanelShell>

      {/* Soft-confirm for removing a tier. Destructive button is rose
          so the admin can't click through absent-mindedly. */}
      <Modal
        open={removeConfirmQty != null}
        onClose={() => setRemoveConfirmQty(null)}
        preventClose={tierInFlight}
        ariaLabel="Remove price tier confirmation"
        backdropClassName="bg-black/40"
        panelClassName="w-full max-w-md rounded-[14px] bg-surface p-6 shadow-xl border border-line"
      >
        <h4 className="text-base font-semibold text-ink">Remove this quantity tier?</h4>
        <p className="mt-2 text-sm text-ink-soft">
          Remove the {removeConfirmQty?.toLocaleString()}-unit tier? This removes that quantity's GBP, EUR and USD prices for <strong>every variant</strong> of this material and cannot be undone.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setRemoveConfirmQty(null)}
            disabled={tierInFlight}
            className="rounded-lg px-4 py-2 text-sm font-medium text-ink-mute hover:bg-canvas disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => { if (removeConfirmQty != null) void handleDeleteTier(removeConfirmQty) }}
            disabled={tierInFlight}
            className="rounded-lg bg-out px-4 py-2 text-sm font-semibold text-on-out hover:opacity-90 disabled:opacity-50"
          >
            {tierInFlight ? 'Removing…' : 'Remove tier'}
          </button>
        </div>
      </Modal>
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
    <div className="rounded-[14px] bg-canvas p-4 border border-line">
      {/* Fields row: wraps on narrow, stays one line on wide. */}
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-ink-mute">Quantity</label>
          <input
            type="number"
            min="1"
            step="1"
            value={qty}
            onChange={(e) => onQty(e.target.value)}
            disabled={inFlight}
            className="w-28 rounded border border-line px-2 py-1 text-[17px] sm:text-sm tabular-nums focus:border-[var(--c-brand)] focus:bg-[var(--c-brand-50)] focus:outline-none"
            placeholder="e.g. 500"
          />
        </div>
        <CurrencyTotalField label="GBP (inc VAT)" symbol="£" value={gbp} onChange={onGbp} disabled={inFlight} />
        <CurrencyTotalField label="EUR (ex VAT)"  symbol="€" value={eur} onChange={onEur} disabled={inFlight} />
        <CurrencyTotalField label="USD (ex VAT)"  symbol="$" value={usd} onChange={onUsd} disabled={inFlight} />
      </div>
      {/* Actions row: always on its own line, right-aligned, so the
          buttons never drift away from the fields on narrow widths. */}
      <div className="mt-3 flex justify-end gap-2">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            disabled={inFlight}
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-ink-mute hover:bg-surface disabled:opacity-50"
          >
            Cancel
          </button>
        )}
        <button
          type="button"
          onClick={onSave}
          disabled={inFlight || !canSave}
          className="rounded-lg bg-ink px-3 py-1.5 text-sm font-medium text-on-ink hover:opacity-90 disabled:opacity-50"
        >
          {inFlight ? 'Saving…' : 'Save tier'}
        </button>
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
      <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-ink-mute">{label}</label>
      <div className="relative">
        <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-ink-mute">{symbol}</span>
        <input
          type="number"
          step="0.01"
          min="0"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className="w-28 rounded border border-line px-2 py-1 pl-5 text-sm tabular-nums focus:border-[var(--c-brand)] focus:bg-[var(--c-brand-50)] focus:outline-none"
          placeholder="0.00"
        />
      </div>
    </div>
  )
}
