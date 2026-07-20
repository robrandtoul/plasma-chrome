import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { logAudit } from '../../lib/audit'

// Admin: map each proof-viewer material to its Stock Control counterpart.
//
// The order hand-off is moving from Help Scout text-parsing to a direct
// database write into Stock Control (docs/order-handoff-spec.md §3.3). The
// direct path resolves the Stock Control material SENDER-side, and for the
// 1:1 families that resolution is an explicit mapping: this grid sets
// materials.stock_material_id (a soft reference to public.materials.id —
// no cross-schema FK, per the house pattern).
//
// Only the explicit-mapping families need a value here. The option-driven
// materials resolve automatically at order time — letterpress via its
// front/core/back colour trio, wood via the species name, and
// satin/tinted/acrylic via the stock colour picked when the order is
// built — so those rows are shown greyed with a hint instead of a picker.
//
// Same grid conventions as Lead times / Xero item codes: one row per
// material, batch save via a single button, parallel UPDATEs with
// optimistic local state + rollback, one audit event per save batch.

interface MaterialRow {
  id: string
  code: string
  display_name: string
  category: string
  production_route: string | null
  stock_material_id: string | null
}

interface StockMaterial {
  id: string
  name: string
}

// How the direct hand-off resolves this material's Stock Control row.
// 'mapped' = explicit mapping set on this grid (the 1:1 families:
// metal_*, carbon fibre, carbon fibre CNC, standard paper, full colour
// plastic, translucent plastic — and any future material by default, so
// a new family is never silently unmappable). 'auto' = resolved at order
// time from data the order already carries; no mapping row needed.
type Resolution = { kind: 'mapped' } | { kind: 'auto'; via: string }

function resolutionFor(code: string): Resolution {
  if (code === 'paper_letterpress' || code === 'paper_letterpress_gilded') {
    return { kind: 'auto', via: 'the letterpress colour trio (front / core / back)' }
  }
  if (code === 'wood') {
    return { kind: 'auto', via: 'the wood species name' }
  }
  if (code === 'plastic_satin' || code === 'plastic_tinted' || code === 'acrylic') {
    return { kind: 'auto', via: 'the stock colour picked when the order is built' }
  }
  return { kind: 'mapped' }
}

interface RowDraft {
  // '' = not mapped; otherwise a public.materials.id.
  selectedId: string
  touched: boolean
}

function isDirty(row: MaterialRow, draft: RowDraft): boolean {
  return (draft.selectedId || null) !== (row.stock_material_id ?? null)
}

export default function AdminStockMaterialsPage() {
  const [rows, setRows] = useState<MaterialRow[]>([])
  const [stockMaterials, setStockMaterials] = useState<StockMaterial[]>([])
  const [drafts, setDrafts] = useState<Record<string, RowDraft>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  useEffect(() => { void load() }, [])

  async function load() {
    setLoading(true)
    setError(null)
    // Proof-viewer materials + Stock Control's live catalogue, in parallel.
    // The cross-schema read is the sanctioned pattern from stockColours.ts:
    // public.materials already grants authenticated SELECT.
    const [matRes, stockRes] = await Promise.all([
      supabase
        .from('materials')
        .select('id, code, display_name, category, production_route, stock_material_id')
        .eq('is_active', true)
        .is('archived_at', null)
        .order('category')
        .order('display_name'),
      supabase
        .schema('public')
        .from('materials')
        .select('id, name')
        .eq('archived', false)
        .eq('is_custom', false)
        .order('name'),
    ])
    setLoading(false)
    if (matRes.error) {
      setError(matRes.error.message)
      return
    }
    if (stockRes.error) {
      setError(`Could not load Stock Control materials: ${stockRes.error.message}`)
      return
    }
    const list = (matRes.data ?? []) as MaterialRow[]
    setRows(list)
    setStockMaterials((stockRes.data ?? []) as StockMaterial[])
    setDrafts(
      Object.fromEntries(
        list.map((r) => [r.id, { selectedId: r.stock_material_id ?? '', touched: false }]),
      ),
    )
  }

  const rowState = useMemo(() => {
    return rows.map((r) => {
      const draft = drafts[r.id] ?? { selectedId: '', touched: false }
      return { row: r, draft, resolution: resolutionFor(r.code), dirty: isDirty(r, draft) }
    })
  }, [rows, drafts])

  const stockNameById = useMemo(
    () => new Map(stockMaterials.map((m) => [m.id, m.name])),
    [stockMaterials],
  )

  const dirtyCount = rowState.filter((s) => s.dirty).length
  const saveDisabled = saving || dirtyCount === 0

  function updateDraft(id: string, selectedId: string) {
    setDrafts((d) => ({ ...d, [id]: { selectedId, touched: true } }))
    if (savedAt != null) setSavedAt(null)
  }

  async function handleSave() {
    if (saveDisabled) return
    setSaving(true)
    setError(null)
    const updates = rowState.filter((s) => s.dirty)
    // Optimistic local update with a snapshot to roll back to on error.
    const previousRows = rows
    const nextRows: MaterialRow[] = rows.map((r) => {
      const u = updates.find((s) => s.row.id === r.id)
      if (!u) return r
      return { ...r, stock_material_id: u.draft.selectedId || null }
    })
    setRows(nextRows)

    // One UPDATE per dirty row, in parallel — same trade-off as Lead
    // times: a sub-30-row catalogue doesn't warrant a batched RPC.
    const results = await Promise.all(
      updates.map((u) =>
        supabase
          .from('materials')
          .update({ stock_material_id: u.draft.selectedId || null })
          .eq('id', u.row.id),
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
        next[u.row.id] = { selectedId: u.draft.selectedId, touched: false }
      }
      return next
    })

    // Single audit event per save batch, with before/after ids AND the
    // human-readable Stock Control names so the activity log reads clean.
    void logAudit({
      action: 'material.stock_material_mapping_updated',
      targetType: 'material',
      targetLabel: updates.length === 1
        ? updates[0].row.display_name
        : `${updates.length} materials`,
      metadata: {
        changes: updates.map((u) => ({
          material_id: u.row.id,
          material_display_name: u.row.display_name,
          before: {
            stock_material_id: u.row.stock_material_id,
            stock_material_name: u.row.stock_material_id
              ? stockNameById.get(u.row.stock_material_id) ?? null
              : null,
          },
          after: {
            stock_material_id: u.draft.selectedId || null,
            stock_material_name: u.draft.selectedId
              ? stockNameById.get(u.draft.selectedId) ?? null
              : null,
          },
        })),
      },
    })
  }

  const recentlySaved = savedAt != null && Date.now() - savedAt < 2000

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-ink-mute">
          Which Stock Control material each proof-viewer material becomes when an order is handed to the workshop system. Only the one-to-one families need a mapping here — metals, carbon fibre, standard paper, full colour plastic, and translucent plastic. The rest resolve automatically at order time: letterpress from its colour trio, wood from the species, and satin / tinted / acrylic from the order&rsquo;s stock colour.
        </p>
        <p className="mt-2 text-xs text-ink-dim">
          An unmapped one-to-one material blocks the direct hand-off with a named error at the order review step, so nothing malformed can reach production — but map everything here so orders flow without that stop.
        </p>
      </div>

      {error && (
        <div className="rounded-lg bg-out-soft px-3 py-2 text-sm text-out ring-1 ring-out">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-20">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-line border-t-ink" />
        </div>
      ) : (
        <div className="overflow-hidden rounded-[14px] bg-surface border border-line">
          <table className="min-w-full divide-y divide-line-soft">
            <thead>
              <tr className="bg-canvas text-left text-xs font-semibold uppercase tracking-widest text-ink-mute">
                <th className="px-5 py-3">Material</th>
                <th className="px-5 py-3">Stock Control material</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-soft text-sm">
              {rowState.map(({ row, draft, resolution, dirty }) => {
                // A saved id whose Stock Control row has since been archived
                // (or is custom) isn't in the fetched list — keep it visible
                // as a labelled option rather than silently showing unmapped.
                const savedUnknown =
                  draft.selectedId !== '' && !stockNameById.has(draft.selectedId)
                return (
                  <tr key={row.id} className={dirty ? 'bg-low-soft/40' : ''}>
                    <td className="px-5 py-3 align-top">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-ink">{row.display_name}</span>
                        {row.production_route && (
                          <span className="rounded-full border border-line px-2 py-0.5 text-[11px] text-ink-soft">
                            {row.production_route === 'supplier' ? 'Supplier' : 'In-house'}
                          </span>
                        )}
                      </div>
                      <div className="text-xs uppercase tracking-wider text-ink-mute">{row.category}</div>
                    </td>
                    <td className="px-5 py-3 align-top">
                      {resolution.kind === 'auto' ? (
                        <p className="max-w-[360px] text-xs text-ink-dim">
                          No mapping needed — resolved automatically via {resolution.via}.
                        </p>
                      ) : (
                        <>
                          <select
                            value={draft.selectedId}
                            onChange={(e) => updateDraft(row.id, e.target.value)}
                            className="h-[38px] w-full max-w-[360px] rounded-lg border border-line bg-surface px-3 text-sm text-ink focus:border-[var(--c-brand)] focus:bg-[var(--c-brand-50)] focus:outline-none"
                          >
                            <option value="">— not mapped —</option>
                            {savedUnknown && (
                              <option value={draft.selectedId}>Unknown material (archived in Stock Control?)</option>
                            )}
                            {stockMaterials.map((m) => (
                              <option key={m.id} value={m.id}>{m.name}</option>
                            ))}
                          </select>
                          <p className="mt-1 max-w-[360px] text-[11px] text-ink-dim">
                            One-to-one family — the hand-off needs this set explicitly.
                          </p>
                        </>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center justify-end gap-3">
        {recentlySaved && !saving && (
          <span className="text-xs text-in-stock">Saved</span>
        )}
        {saving && <span className="text-xs text-ink-mute">Saving…</span>}
        <button
          type="button"
          onClick={handleSave}
          disabled={saveDisabled}
          className="rounded bg-ink px-4 py-2 text-sm font-semibold text-on-ink hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {dirtyCount === 0
            ? 'Save changes'
            : `Save changes (${dirtyCount} ${dirtyCount === 1 ? 'row' : 'rows'})`}
        </button>
      </div>
    </div>
  )
}
