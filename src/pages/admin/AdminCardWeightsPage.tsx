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
    display_name: string
    category: string
    sort_order: number
  } | null
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
      .select('id, code, display_name, variant_type, sort_order, weight_grams, materials!inner(id, display_name, category, sort_order)')
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

  // Group rows by material id for the table render. Map keeps
  // insertion order, which is the sorted order from `flat` above.
  //
  // Each group also carries the material's variant_type so the
  // render below can decide whether to collapse the per-variant
  // inputs into one. Thickness materially affects card weight
  // (a 300μm steel card weighs less than an 800μm one) so those
  // groups stay expanded. Ink count and the Standard-Paper
  // finish dimension don't shift the underlying paper weight,
  // so those groups render a single input that controls every
  // variant in the material at once.
  const grouped = useMemo(() => {
    interface Group {
      materialId: string
      materialName: string
      category: string
      variantType: string
      rows: typeof rowState
    }
    const groups = new Map<string, Group>()
    for (const item of rowState) {
      const existing = groups.get(item.row.material_id)
      if (existing) {
        existing.rows.push(item)
      } else {
        groups.set(item.row.material_id, {
          materialId: item.row.material_id,
          materialName: item.row.material_display_name,
          category: item.row.material_category,
          variantType: item.row.variant_type,
          rows: [item],
        })
      }
    }
    return Array.from(groups.values())
  }, [rowState])

  // dirtyDisplayCount mirrors the visible UI rows: a collapsed
  // material counts as one regardless of how many underlying
  // variants the save will touch. Thickness materials still count
  // one per dirty variant since each is its own visible row.
  const dirtyDisplayCount = grouped.reduce((acc, g) => {
    const collapsed = shouldCollapseVariants(g.variantType)
    if (collapsed) {
      return acc + (g.rows[0]?.dirty ? 1 : 0)
    }
    return acc + g.rows.filter((r) => r.dirty).length
  }, 0)
  const hasInvalidTouched = rowState.some((s) => s.draft.touched && !s.validation.ok)
  const saveDisabled = saving || dirtyDisplayCount === 0 || hasInvalidTouched

  function updateDraft(id: string, patch: Partial<RowDraft>) {
    setDrafts((d) => ({ ...d, [id]: { ...d[id], ...patch, touched: true } }))
    if (savedAt != null) setSavedAt(null)
  }

  // Apply the same draft to every variant of a material. Used by
  // collapsed groups (ink count / finish) where the UI shows one
  // input that stands in for all variants. Every variant is marked
  // touched + dirty so the save path picks them all up.
  function updateGroupDraft(materialId: string, patch: Partial<RowDraft>) {
    setDrafts((d) => {
      const next = { ...d }
      for (const r of rows) {
        if (r.material_id !== materialId) continue
        next[r.variant_id] = { ...d[r.variant_id], ...patch, touched: true }
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
          Thickness variants (metal at 300μm, 500μm, 800μm, etc.) take their own weight. Ink count and finish variants share one weight per material — those dimensions don't shift the underlying card weight.
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
              {grouped.map((group) => {
                const collapsed = shouldCollapseVariants(group.variantType)
                // Collapsed groups render just the first variant's
                // row; the input handler propagates edits to every
                // variant in the group via updateGroupDraft.
                const renderedRows = collapsed ? group.rows.slice(0, 1) : group.rows
                return (
                  <Fragment key={group.materialId}>
                    <tr className="bg-gray-50/60">
                      <td colSpan={2} className="px-5 py-2">
                        <div className="font-medium text-gray-900">{group.materialName}</div>
                        <div className="text-xs uppercase tracking-wider text-gray-400">{group.category}</div>
                      </td>
                    </tr>
                    {renderedRows.map(({ row, draft, validation, dirty }) => {
                      const showError = draft.touched && !validation.ok
                      const errorId = showError ? `weight-error-${row.variant_id}` : undefined
                      // Default-variant materials show a single nameless
                      // row; surface the variant code so admin can still
                      // tell which line they're editing. Collapsed
                      // groups skip the variant sub-label entirely —
                      // the material header above already names the
                      // material, and there's only one input.
                      const variantLabel = collapsed
                        ? 'All variants'
                        : row.variant_type === 'default'
                          ? row.variant_code
                          : row.variant_display_name
                      return (
                        <tr key={row.variant_id} className={dirty ? 'bg-amber-50/40' : ''}>
                          <td className="px-5 py-3 align-top pl-10">
                            <div className={collapsed ? 'italic text-gray-400' : 'text-gray-700'}>
                              {variantLabel}
                            </div>
                          </td>
                          <td className="px-5 py-3 align-top">
                            <input
                              type="number"
                              min={1}
                              step={1}
                              inputMode="numeric"
                              value={draft.weightStr}
                              onChange={(e) => {
                                if (collapsed) {
                                  updateGroupDraft(group.materialId, { weightStr: e.target.value })
                                } else {
                                  updateDraft(row.variant_id, { weightStr: e.target.value })
                                }
                              }}
                              aria-invalid={showError || undefined}
                              aria-describedby={errorId}
                              className={weightInputClass(showError)}
                            />
                            {showError && (
                              <p id={errorId} className="mt-1 text-xs text-rose-700">
                                {validation.message}
                              </p>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </Fragment>
                )
              })}
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
  const base = 'w-24 rounded-lg border px-3 py-2 text-[17px] sm:text-sm focus:outline-none focus:ring-1'
  return showError
    ? `${base} border-rose-400 focus:border-rose-500 focus:ring-rose-400`
    : `${base} border-gray-300 focus:border-gray-900 focus:ring-gray-900`
}
