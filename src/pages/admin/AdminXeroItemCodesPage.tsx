import { Fragment, useEffect, useMemo, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { logAudit } from '../../lib/audit'

// Admin: the Xero ItemCode each card variant invoices as.
//
// Migration 000232 adds material_variants.xero_item_code. When a paid
// order's invoice is written to Xero (stripe-webhook → createSalesInvoice),
// the product line carries this code so Xero books it to the right
// inventory item / sales account and per-product revenue reports work. An
// unmapped variant falls back to a single summary line, so blanks are safe.
//
// Unlike Card weights, this is a FLAT one-row-per-variant table with no
// collapsing: standard metals share a weight per thickness but have a
// DIFFERENT Xero item per finish (steel 300 = 013, gold 300 = 0146), and
// Standard Paper finishes share a weight but differ per item — so every
// variant gets its own editable cell.
//
// Save discipline mirrors Card weights: collect dirty rows, save in one
// click via parallel UPDATEs, emit one audit event per batch with
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
  xero_item_code: string
}

interface RawJoinedVariant {
  id: string
  code: string
  display_name: string
  variant_type: string
  sort_order: number
  xero_item_code: string | null
  materials: {
    id: string
    display_name: string
    category: string
    sort_order: number
  } | null
}

interface RowDraft {
  codeStr: string
  touched: boolean
}

// Normalise to the stored shape: trimmed, blank → null (unmapped).
function normalise(s: string): string | null {
  const t = s.trim()
  return t === '' ? null : t
}

function isDirty(row: Row, draft: RowDraft): boolean {
  return (normalise(draft.codeStr) ?? '') !== (row.xero_item_code ?? '')
}

export default function AdminXeroItemCodesPage() {
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
    const { data, error: err } = await supabase
      .from('material_variants')
      .select('id, code, display_name, variant_type, sort_order, xero_item_code, materials!inner(id, display_name, category, sort_order)')
      .eq('is_active', true)
      .order('sort_order')
    setLoading(false)
    if (err) {
      setError(err.message)
      return
    }

    const joined = (data ?? []) as unknown as RawJoinedVariant[]
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
        xero_item_code: v.xero_item_code ?? '',
      }))
    flat.sort((a, b) =>
      a.material_sort_order - b.material_sort_order
      || a.variant_sort_order - b.variant_sort_order
    )
    setRows(flat)
    setDrafts(
      Object.fromEntries(
        flat.map((r) => [r.variant_id, { codeStr: r.xero_item_code, touched: false }]),
      ),
    )
  }

  const rowState = useMemo(() => {
    return rows.map((r) => {
      const draft = drafts[r.variant_id] ?? { codeStr: '', touched: false }
      return { row: r, draft, dirty: isDirty(r, draft) }
    })
  }, [rows, drafts])

  // Group by material, preserving the sort order `flat` imposed.
  const groups = useMemo(() => {
    const byMaterial = new Map<string, { name: string; category: string; rows: typeof rowState }>()
    for (const item of rowState) {
      const existing = byMaterial.get(item.row.material_id)
      if (existing) existing.rows.push(item)
      else byMaterial.set(item.row.material_id, {
        name: item.row.material_display_name,
        category: item.row.material_category,
        rows: [item],
      })
    }
    return Array.from(byMaterial.entries()).map(([id, g]) => ({ id, ...g }))
  }, [rowState])

  const dirtyCount = rowState.filter((s) => s.dirty).length
  const saveDisabled = saving || dirtyCount === 0

  function updateDraft(variantId: string, codeStr: string) {
    setDrafts((d) => ({ ...d, [variantId]: { codeStr, touched: true } }))
    if (savedAt != null) setSavedAt(null)
  }

  async function handleSave() {
    if (saveDisabled) return
    setSaving(true)
    setError(null)
    const updates = rowState.filter((s) => s.dirty)
    const previousRows = rows
    const nextRows: Row[] = rows.map((r) => {
      const u = updates.find((s) => s.row.variant_id === r.variant_id)
      if (!u) return r
      return { ...r, xero_item_code: normalise(u.draft.codeStr) ?? '' }
    })
    setRows(nextRows)

    const results = await Promise.all(
      updates.map((u) =>
        supabase
          .from('material_variants')
          .update({ xero_item_code: normalise(u.draft.codeStr) })
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
        next[u.row.variant_id] = { codeStr: normalise(u.draft.codeStr) ?? '', touched: false }
      }
      return next
    })

    void logAudit({
      action: 'material_variant.xero_item_codes_updated',
      targetType: 'material_variant',
      targetLabel: updates.length === 1
        ? `${updates[0].row.material_display_name} — ${updates[0].row.variant_display_name}`
        : `${updates.length} variants`,
      metadata: {
        changes: updates.map((u) => ({
          variant_id: u.row.variant_id,
          material_display_name: u.row.material_display_name,
          variant_display_name: u.row.variant_display_name,
          before: { xero_item_code: u.row.xero_item_code || null },
          after: { xero_item_code: normalise(u.draft.codeStr) },
        })),
      },
    })
  }

  const recentlySaved = savedAt != null && Date.now() - savedAt < 2000

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-ink">Xero item codes</h2>
        <p className="mt-1 text-sm text-ink-mute">
          The Xero ItemCode each card variant invoices as. When a customer pays, the invoice's product line uses this code so Xero books it to the right inventory item and per-product revenue reports work. Split-name tooling and shipping use their own fixed codes (020, and 050 / 052) — set those nowhere here.
        </p>
        <p className="mt-2 text-xs text-ink-dim">
          Leave a cell blank to invoice that variant on a single summary line instead. Customer-facing pages are unaffected — codes only surface on the accounting side.
        </p>
      </div>

      {error && (
        <div className="rounded-lg bg-out-soft px-3 py-2 text-sm text-out ring-1 ring-out">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-20">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-line border-t-gray-900" />
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl bg-surface shadow-sm ring-1 ring-line">
          <table className="min-w-full divide-y divide-line-soft">
            <thead>
              <tr className="bg-canvas text-left text-xs font-semibold uppercase tracking-widest text-ink-mute">
                <th className="px-5 py-3">Material / Variant</th>
                <th className="px-5 py-3">Xero item code</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-soft text-sm">
              {groups.map((group) => (
                <Fragment key={group.id}>
                  <tr className="bg-canvas">
                    <td colSpan={2} className="px-5 py-2">
                      <div className="font-medium text-ink">{group.name}</div>
                      <div className="text-xs uppercase tracking-wider text-ink-dim">{group.category}</div>
                    </td>
                  </tr>
                  {group.rows.map(({ row, draft, dirty }) => {
                    const label = row.variant_type === 'default'
                      ? row.variant_code
                      : row.variant_display_name
                    return (
                      <tr key={row.variant_id} className={dirty ? 'bg-low-soft' : ''}>
                        <td className="px-5 py-3 align-top pl-10">
                          <div className="text-ink-soft">{label}</div>
                        </td>
                        <td className="px-5 py-3 align-top">
                          <input
                            type="text"
                            value={draft.codeStr}
                            onChange={(e) => updateDraft(row.variant_id, e.target.value)}
                            placeholder="—"
                            className="w-32 rounded border border-line px-3 py-2 text-[17px] sm:text-sm focus:border-[var(--c-brand)] focus:bg-[var(--c-brand-50)] focus:outline-none"
                          />
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
          <span className="text-xs text-in-stock">Saved</span>
        )}
        {saving && <span className="text-xs text-ink-dim">Saving…</span>}
        <button
          type="button"
          onClick={handleSave}
          disabled={saveDisabled}
          className="rounded bg-ink px-4 py-2 text-sm font-semibold text-on-ink hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:opacity-40"
        >
          {dirtyCount === 0
            ? 'Save changes'
            : `Save changes (${dirtyCount} ${dirtyCount === 1 ? 'row' : 'rows'})`}
        </button>
      </div>
    </div>
  )
}
