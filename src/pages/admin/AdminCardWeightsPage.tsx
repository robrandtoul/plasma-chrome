import { Fragment, useEffect, useMemo, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { logAudit } from '../../lib/audit'

// Admin: single-card weights per variant, in grams.
//
// Migration 000178 adds material_variants.weight_grams (default 10,
// CHECK > 0). The Quote compiler's FedEx shipping calculation reads
// this column to derive parcel weight (per-card × quantity + box
// tare). This page lets admin set the real figure per variant.
//
// Layout: variants grouped by material — lead times are per-material
// so a one-row-per-material table works; weights are per-variant
// because thickness changes weight, so the same shape would force a
// nested editor. We use a flat list with material headers instead:
// scans visually as "materials, with their variants nested under",
// edits as a single batched save.
//
// Save discipline: collect dirty rows, save them all in one click via
// parallel UPDATEs, emit one audit event per save batch carrying
// before/after per variant.

interface Row {
  variant_id: string
  variant_code: string
  variant_display_name: string
  variant_type: string
  variant_sort_order: number
  material_id: string
  material_code: string
  material_display_name: string
  material_category: string
  material_sort_order: number
  weight_grams: number
}

interface RawJoinedVariant {
  id: string
  code: string
  display_name: string
  variant_type: string
  sort_order: number
  weight_grams: number
  materials: {
    id: string
    code: string
    display_name: string
    category: string
    sort_order: number
  } | null
}

// Standard metal materials share their card size, thickness
// schedule (300 / 500 / 800 micron) AND base metal — they're all
// stainless steel under different surface finishes (steel / gold /
// copper / gun metal / matte black / matte white). Card weight
// depends on thickness, not on finish family, so the Card weights
// tab merges them into one "Metal" mega-group with one input per
// thickness.
//
// Explicit exclusions:
//   * metal_mini_steel — different card size, different thickness
//     set (200 / 300 / 500), so it has its own section.
//   * metal_titanium   — genuine titanium, not stainless steel
//     with a finish, so it has a unique weight profile even at
//     the same thicknesses (and a 1000μm tier the others don't
//     have). It stays in its own section.
const STANDARD_METAL_EXCLUDED_CODES = new Set(['metal_mini_steel', 'metal_titanium'])
function isStandardMetal(materialCode: string): boolean {
  return materialCode.startsWith('metal_') && !STANDARD_METAL_EXCLUDED_CODES.has(materialCode)
}

interface RowDraft {
  weightStr: string
  touched: boolean
}

interface Validation {
  ok: boolean
  message: string | null
  parsed: number | null
}

function parseDraft(draft: RowDraft): Validation {
  const trimmed = draft.weightStr.trim()
  if (trimmed === '') {
    return { ok: false, message: 'Weight required.', parsed: null }
  }
  const n = Number(trimmed)
  if (!Number.isInteger(n)) {
    return { ok: false, message: 'Whole grams only.', parsed: null }
  }
  if (n <= 0) {
    return { ok: false, message: 'Must be greater than zero.', parsed: null }
  }
  return { ok: true, message: null, parsed: n }
}

function isDirty(row: Row, validation: Validation): boolean {
  if (!validation.ok || validation.parsed === null) return false
  return validation.parsed !== row.weight_grams
}

export default function AdminCardWeightsPage() {
  const [rows, setRows] = useState<Row[]>([])
  const [drafts, setDrafts] = useState<Record<string, RowDraft>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  useEffect(() => { void load() }, [])

  async function load() {
    setLoading(true)
    setError(null)
    // Join through materials so the page can group by material and
    // sort the materials by sort_order rather than alphabetically —
    // matches the order the same materials render in elsewhere.
    const { data, error: err } = await supabase
      .from('material_variants')
      .select('id, code, display_name, variant_type, sort_order, weight_grams, materials!inner(id, code, display_name, category, sort_order)')
      .eq('is_active', true)
      .order('sort_order')
    setLoading(false)
    if (err) {
      setError(err.message)
      return
    }

    const joined = (data ?? []) as unknown as RawJoinedVariant[]
    // PostgREST inner-join returns the parent as an object when the
    // relationship is to-one. Flatten to a single row-per-variant
    // shape and drop any record whose join unexpectedly missed
    // (defensive — `materials!inner` guarantees the join, so this is
    // belt-and-braces against API shape drift).
    const flat: Row[] = joined
      .filter((v) => v.materials != null)
      .map((v) => ({
        variant_id: v.id,
        variant_code: v.code,
        variant_display_name: v.display_name,
        variant_type: v.variant_type,
        variant_sort_order: v.sort_order,
        material_id: v.materials!.id,
        material_code: v.materials!.code,
        material_display_name: v.materials!.display_name,
        material_category: v.materials!.category,
        material_sort_order: v.materials!.sort_order,
        weight_grams: v.weight_grams,
      }))
    // Sort: material sort_order first, then variant sort_order within
    // each material.
    flat.sort((a, b) =>
      a.material_sort_order - b.material_sort_order
      || a.variant_sort_order - b.variant_sort_order
    )
    setRows(flat)
    setDrafts(
      Object.fromEntries(
        flat.map((r) => [r.variant_id, { weightStr: String(r.weight_grams), touched: false }]),
      ),
    )
  }

  const rowState = useMemo(() => {
    return rows.map((r) => {
      const draft = drafts[r.variant_id] ?? { weightStr: '', touched: false }
      const validation = parseDraft(draft)
      return { row: r, draft, validation, dirty: isDirty(r, validation) }
    })
  }, [rows, drafts])

  // Build the display tree the table actually renders.
  //
  // Three rendering modes feed into a uniform DisplayRow shape:
  //   * Expanded — thickness materials (Full Colour Plastic 420/680/
  //     760μm, Mini Steel 200/300/500μm). One DisplayRow per
  //     variant; allVariantIds is just that single id.
  //   * Collapsed — non-thickness materials (ink-count and the
  //     Standard-Paper finish dimension). One DisplayRow per
  //     material; allVariantIds covers every variant of the
  //     material so saving propagates the same weight to all.
  //   * Mega-metal — the six standard metal materials share card
  //     size and thickness schedule (300/500/800μm). The display
  //     merges them into a single "Metal" group with one
  //     DisplayRow per thickness; allVariantIds covers the variant
  //     at that thickness across every standard metal.
  //
  // The `dirty` flag on a DisplayRow is true iff ANY of the
  // controlled variants is dirty. `draft` and `validation` come
  // from the primary variant (the first one in allVariantIds);
  // the others are kept in lockstep by the change handler.
  interface DisplayRow {
    variantId: string         // primary variant id, used as React key
    label: string             // first-column label
    draft: RowDraft
    validation: Validation
    dirty: boolean
    allVariantIds: string[]
    primaryRow: Row
  }
  interface DisplayGroup {
    key: string
    name: string
    category: string
    rows: DisplayRow[]
  }
  const displayGroups = useMemo<DisplayGroup[]>(() => {
    // ── Step 1: bucket rowState by material id (as before). ──
    interface RawGroup {
      materialId: string
      materialCode: string
      materialName: string
      category: string
      variantType: string
      rows: typeof rowState
    }
    const groupsByMaterial = new Map<string, RawGroup>()
    for (const item of rowState) {
      const existing = groupsByMaterial.get(item.row.material_id)
      if (existing) {
        existing.rows.push(item)
      } else {
        groupsByMaterial.set(item.row.material_id, {
          materialId: item.row.material_id,
          materialCode: item.row.material_code,
          materialName: item.row.material_display_name,
          category: item.row.material_category,
          variantType: item.row.variant_type,
          rows: [item],
        })
      }
    }
    // ── Step 2: split out standard metals for the mega-group. ──
    const standardMetals: RawGroup[] = []
    const others: RawGroup[] = []
    for (const g of groupsByMaterial.values()) {
      if (isStandardMetal(g.materialCode)) standardMetals.push(g)
      else others.push(g)
    }

    const out: DisplayGroup[] = []

    // ── Step 3: synthesize the "Metal" mega-group if needed. ──
    if (standardMetals.length > 0) {
      // Bucket variants across the standard metals by thickness
      // display_name (e.g. "300 micron"). Each bucket becomes one
      // DisplayRow controlling the corresponding variants on every
      // standard metal.
      interface ThicknessBucket {
        sortOrder: number
        label: string
        items: typeof rowState
      }
      const byThickness = new Map<string, ThicknessBucket>()
      for (const g of standardMetals) {
        for (const item of g.rows) {
          const tname = item.row.variant_display_name
          const existing = byThickness.get(tname)
          if (existing) {
            existing.items.push(item)
          } else {
            byThickness.set(tname, {
              sortOrder: item.row.variant_sort_order,
              label: tname,
              items: [item],
            })
          }
        }
      }
      // Sort by the numeric μm value pulled from the label so the
      // thicknesses render in real ascending order. Falling back to
      // the per-material sort_order produced inconsistent ordering
      // when different metals seed the same display_name with
      // different sort_orders (and put outliers like a one-off
      // "1000 micron" between 300 and 500).
      const buckets = Array.from(byThickness.values())
        .sort((a, b) => micronFromLabel(a.label) - micronFromLabel(b.label))
      const rows: DisplayRow[] = buckets.map((b) => {
        const primary = b.items[0]
        const allVariantIds = b.items.map((it) => it.row.variant_id)
        return {
          variantId: primary.row.variant_id,
          label: b.label,
          draft: primary.draft,
          validation: primary.validation,
          // Any dirty member marks the display row dirty so the
          // amber background fires even if the primary happens
          // to match the stored value (shouldn't in practice
          // since the change handler keeps them in lockstep, but
          // belt-and-braces).
          dirty: b.items.some((it) => it.dirty),
          allVariantIds,
          primaryRow: primary.row,
        }
      })
      out.push({ key: 'mega_metal', name: 'Metal', category: 'metal', rows })
    }

    // ── Step 4: emit the remaining material groups. ──
    // Sorted by material sort_order, which `flat` already imposed
    // — Map preserves insertion order. We just need to make sure
    // the mega-group sits where the first standard metal would
    // have. Simplest: append `others` after the mega-group if the
    // mega-group exists; this means Metal renders at the top of
    // the table (standard metals already have the lowest sort_orders
    // in the existing seed, so visually nothing changes).
    for (const g of others) {
      const collapsed = shouldCollapseVariants(g.variantType)
      if (collapsed) {
        // Single DisplayRow controlling every variant in the material.
        const primary = g.rows[0]
        out.push({
          key: g.materialId,
          name: g.materialName,
          category: g.category,
          rows: [{
            variantId: primary.row.variant_id,
            label: 'All variants',
            draft: primary.draft,
            validation: primary.validation,
            dirty: g.rows.some((it) => it.dirty),
            allVariantIds: g.rows.map((it) => it.row.variant_id),
            primaryRow: primary.row,
          }],
        })
      } else {
        // One DisplayRow per variant (thickness materials).
        out.push({
          key: g.materialId,
          name: g.materialName,
          category: g.category,
          rows: g.rows.map((it) => ({
            variantId: it.row.variant_id,
            label: it.row.variant_type === 'default'
              ? it.row.variant_code
              : it.row.variant_display_name,
            draft: it.draft,
            validation: it.validation,
            dirty: it.dirty,
            allVariantIds: [it.row.variant_id],
            primaryRow: it.row,
          })),
        })
      }
    }

    return out
  }, [rowState])

  // dirtyDisplayCount mirrors the visible UI rows — collapsed and
  // mega-metal display rows still count as one each regardless of
  // how many underlying variants the save will touch.
  const dirtyDisplayCount = displayGroups.reduce(
    (acc, g) => acc + g.rows.filter((r) => r.dirty).length,
    0,
  )
  const hasInvalidTouched = rowState.some((s) => s.draft.touched && !s.validation.ok)
  const saveDisabled = saving || dirtyDisplayCount === 0 || hasInvalidTouched

  // Apply the same draft to one or more variant ids. A regular
  // expanded row passes a single-element array; collapsed and
  // mega-metal rows pass every variant they control so the save
  // path picks them all up in lockstep.
  function updateMultiDraft(variantIds: string[], patch: Partial<RowDraft>) {
    setDrafts((d) => {
      const next = { ...d }
      for (const id of variantIds) {
        next[id] = { ...d[id], ...patch, touched: true }
      }
      return next
    })
    if (savedAt != null) setSavedAt(null)
  }

  // Variants of type 'ink_count' don't affect card weight (colour
  // count drives setup, not material density); 'finish' variants on
  // Standard Paper are surface treatments (UV spot, foiling) that
  // don't change the underlying paper weight either. Only 'thickness'
  // genuinely shifts the per-card figure. A new variant type with a
  // weight delta would need to be excluded from this check.
  function shouldCollapseVariants(variantType: string): boolean {
    return variantType !== 'thickness'
  }

  async function handleSave() {
    if (saveDisabled) return
    setSaving(true)
    setError(null)
    const updates = rowState.filter((s) => s.dirty)
    const previousRows = rows
    const nextRows: Row[] = rows.map((r) => {
      const u = updates.find((s) => s.row.variant_id === r.variant_id)
      if (!u || u.validation.parsed === null) return r
      return { ...r, weight_grams: u.validation.parsed }
    })
    setRows(nextRows)

    const results = await Promise.all(
      updates.map((u) =>
        supabase
          .from('material_variants')
          .update({ weight_grams: u.validation.parsed })
          .eq('id', u.row.variant_id),
      ),
    )
    const firstError = results.find((r) => r.error)?.error ?? null
    if (firstError) {
      setRows(previousRows)
      setError(`Failed to save: ${firstError.message}`)
      setSaving(false)
      return
    }

    setSaving(false)
    setSavedAt(Date.now())
    setDrafts((d) => {
      const next = { ...d }
      for (const u of updates) {
        if (u.validation.parsed === null) continue
        next[u.row.variant_id] = { weightStr: String(u.validation.parsed), touched: false }
      }
      return next
    })

    void logAudit({
      action: 'material_variant.weights_updated',
      targetType: 'material_variant',
      targetLabel: updates.length === 1
        ? `${updates[0].row.material_display_name} — ${updates[0].row.variant_display_name}`
        : `${updates.length} variants`,
      metadata: {
        changes: updates.map((u) => ({
          variant_id: u.row.variant_id,
          material_display_name: u.row.material_display_name,
          variant_display_name: u.row.variant_display_name,
          before: { weight_grams: u.row.weight_grams },
          after: { weight_grams: u.validation.parsed },
        })),
      },
    })
  }

  const recentlySaved = savedAt != null && Date.now() - savedAt < 2000

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-gray-900">Card weights</h2>
        <p className="mt-1 text-sm text-gray-500">
          Single-card weight in grams. The Quote compiler multiplies this by quantity and adds the FedEx box tare weight to derive the parcel weight for shipping rates. Customer-facing pages are unaffected — weights only surface internally on the Quote compiler.
        </p>
        <p className="mt-2 text-xs text-gray-400">
          Thickness variants take their own weight. Ink count and finish variants share one weight per material — those dimensions don't shift the underlying card weight. Standard metals (steel, gold, copper, etc.) share their weights too: one row per thickness covers all six finishes. Mini Steel and Full Colour Plastic keep their own per-thickness rows.
        </p>
      </div>

      {error && (
        <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-rose-200">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-20">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-200 border-t-gray-900" />
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-gray-200">
          <table className="min-w-full divide-y divide-gray-100">
            <thead>
              <tr className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-widest text-gray-500">
                <th className="px-5 py-3">Material / Variant</th>
                <th className="px-5 py-3">Weight (g)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 text-sm">
              {displayGroups.map((group) => (
                <Fragment key={group.key}>
                  <tr className="bg-gray-50/60">
                    <td colSpan={2} className="px-5 py-2">
                      <div className="font-medium text-gray-900">{group.name}</div>
                      <div className="text-xs uppercase tracking-wider text-gray-400">{group.category}</div>
                    </td>
                  </tr>
                  {group.rows.map((dr) => {
                    const showError = dr.draft.touched && !dr.validation.ok
                    const errorId = showError ? `weight-error-${dr.variantId}` : undefined
                    const isAllVariants = dr.label === 'All variants'
                    return (
                      <tr key={dr.variantId} className={dr.dirty ? 'bg-amber-50/40' : ''}>
                        <td className="px-5 py-3 align-top pl-10">
                          <div className={isAllVariants ? 'italic text-gray-400' : 'text-gray-700'}>
                            {dr.label}
                          </div>
                        </td>
                        <td className="px-5 py-3 align-top">
                          <input
                            type="number"
                            min={1}
                            step={1}
                            inputMode="numeric"
                            value={dr.draft.weightStr}
                            onChange={(e) => updateMultiDraft(dr.allVariantIds, { weightStr: e.target.value })}
                            aria-invalid={showError || undefined}
                            aria-describedby={errorId}
                            className={weightInputClass(showError)}
                          />
                          {showError && (
                            <p id={errorId} className="mt-1 text-xs text-rose-700">
                              {dr.validation.message}
                            </p>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center justify-end gap-3">
        {recentlySaved && !saving && (
          <span className="text-xs text-emerald-600">Saved</span>
        )}
        {saving && <span className="text-xs text-gray-400">Saving…</span>}
        <button
          type="button"
          onClick={handleSave}
          disabled={saveDisabled}
          className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-gray-900"
        >
          {dirtyDisplayCount === 0
            ? 'Save changes'
            : `Save changes (${dirtyDisplayCount} ${dirtyDisplayCount === 1 ? 'row' : 'rows'})`}
        </button>
      </div>
    </div>
  )
}

function weightInputClass(showError: boolean): string {
  const base = 'w-24 rounded border px-3 py-2 text-[17px] sm:text-sm focus:outline-none'
  return showError
    ? `${base} border-out focus:border-[var(--c-out)] focus:bg-[var(--c-out-soft)]`
    : `${base} border-line focus:border-[var(--c-brand)] focus:bg-[var(--c-brand-50)]`
}

// Extract the leading integer from a thickness label like "300 micron".
// Used to sort the merged "Metal" mega-group's rows in ascending
// thickness order regardless of how the per-material sort_order was
// originally seeded. Falls back to MAX_SAFE_INTEGER for labels with
// no digit so they sink to the end rather than crashing the sort.
function micronFromLabel(label: string): number {
  const match = label.match(/\d+/)
  return match ? parseInt(match[0], 10) : Number.MAX_SAFE_INTEGER
}
