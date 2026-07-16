import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { logAudit } from '../../lib/audit'

// Admin: manage a material's OPTIONS — the second pricing/spec dimension
// beyond the variant (wood species, metal finishes). One row per option in
// the `material_options` table.
//
// Why this page exists: before it, options could only be added via a SQL
// migration, which is exactly how English Oak shipped with no Xero code and
// quietly invoiced under the generic Wood code (015). With this editor a new
// wood species — or a fix to an existing one's Xero code — is a pure admin
// task.
//
// Scope, kept deliberately tight and safe:
//   * EDIT existing options: display name, sort order, and Xero item code
//     (batch save, one click, mirrors the Xero item codes page).
//   * ADD a new option to a material that already uses options (code +
//     display name + Xero code). New options are never the base — the base
//     is set when the material is created — so we don't risk leaving a
//     material with two bases or none.
//   * REMOVE an option, FK-protected: the orders → material_option_id FK is
//     NO ACTION, so an option used by a real order can't be deleted and we
//     surface that as a friendly message rather than a raw error.
//
// `code` is the stable identifier referenced by proof_versions.material_options
// (a text[] of codes), so it's write-once: editable only when adding, shown
// read-only thereafter. Blank Xero code = the line inherits the variant's own
// code (intended for metal finishes; a gap for wood species, which each want
// their own).
//
// material_options is staff-writable under RLS (auth_role IS NOT NULL); this
// page is admin-gated at the route, same as the Xero item codes page.

interface OptionRow {
  id: string
  material_id: string
  code: string
  display_name: string
  is_base: boolean
  sort_order: number
  xero_item_code: string
  material_display_name: string
  material_category: string
  material_sort_order: number
  option_label: string | null
}

interface RawOption {
  id: string
  material_id: string
  code: string
  display_name: string
  is_base: boolean
  sort_order: number
  xero_item_code: string | null
  materials: {
    display_name: string
    category: string
    sort_order: number
    option_label: string | null
  } | null
}

interface Draft {
  display_name: string
  sort_order: string
  xero_item_code: string
}

interface NewOptionDraft {
  code: string
  display_name: string
  xero_item_code: string
  sort_order: string
}

const EMPTY_NEW: NewOptionDraft = { code: '', display_name: '', xero_item_code: '', sort_order: '' }

function normalise(s: string): string | null {
  const t = s.trim()
  return t === '' ? null : t
}

function draftFromRow(r: OptionRow): Draft {
  return {
    display_name: r.display_name,
    sort_order: String(r.sort_order),
    xero_item_code: r.xero_item_code,
  }
}

function isDirty(row: OptionRow, draft: Draft): boolean {
  return (
    draft.display_name.trim() !== row.display_name
    || (Number(draft.sort_order) || 0) !== row.sort_order
    || (normalise(draft.xero_item_code) ?? '') !== (row.xero_item_code ?? '')
  )
}

export default function AdminMaterialOptionsPage() {
  const [rows, setRows] = useState<OptionRow[]>([])
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  // Per-material "add option" drafts, keyed by material_id. A material gets a
  // row here only once the user opens its add form.
  const [adding, setAdding] = useState<Record<string, NewOptionDraft>>({})
  const [busyMaterial, setBusyMaterial] = useState<string | null>(null)

  useEffect(() => { void load() }, [])

  async function load() {
    setLoading(true)
    setError(null)
    const { data, error: err } = await supabase
      .from('material_options')
      .select('id, material_id, code, display_name, is_base, sort_order, xero_item_code, materials!inner(display_name, category, sort_order, option_label)')
      .order('sort_order')
    setLoading(false)
    if (err) {
      setError(err.message)
      return
    }
    const joined = (data ?? []) as unknown as RawOption[]
    const flat: OptionRow[] = joined
      .filter((o) => o.materials != null)
      .map((o) => ({
        id: o.id,
        material_id: o.material_id,
        code: o.code,
        display_name: o.display_name,
        is_base: o.is_base,
        sort_order: o.sort_order,
        xero_item_code: o.xero_item_code ?? '',
        material_display_name: o.materials!.display_name,
        material_category: o.materials!.category,
        material_sort_order: o.materials!.sort_order,
        option_label: o.materials!.option_label,
      }))
    flat.sort((a, b) =>
      a.material_sort_order - b.material_sort_order
      || a.sort_order - b.sort_order,
    )
    setRows(flat)
    setDrafts(Object.fromEntries(flat.map((r) => [r.id, draftFromRow(r)])))
  }

  const rowState = useMemo(() => rows.map((r) => {
    const draft = drafts[r.id] ?? draftFromRow(r)
    return { row: r, draft, dirty: isDirty(r, draft) }
  }), [rows, drafts])

  const groups = useMemo(() => {
    const byMaterial = new Map<string, {
      name: string; category: string; optionLabel: string | null; rows: typeof rowState
    }>()
    for (const item of rowState) {
      const existing = byMaterial.get(item.row.material_id)
      if (existing) existing.rows.push(item)
      else byMaterial.set(item.row.material_id, {
        name: item.row.material_display_name,
        category: item.row.material_category,
        optionLabel: item.row.option_label,
        rows: [item],
      })
    }
    return Array.from(byMaterial.entries()).map(([id, g]) => ({ id, ...g }))
  }, [rowState])

  const dirtyCount = rowState.filter((s) => s.dirty).length
  const saveDisabled = saving || dirtyCount === 0

  function updateDraft(id: string, patch: Partial<Draft>) {
    setDrafts((d) => ({ ...d, [id]: { ...(d[id] ?? { display_name: '', sort_order: '0', xero_item_code: '' }), ...patch } }))
    if (savedAt != null) setSavedAt(null)
  }

  async function handleSave() {
    if (saveDisabled) return
    setSaving(true)
    setError(null)
    const updates = rowState.filter((s) => s.dirty)
    const previousRows = rows
    const nextRows = rows.map((r) => {
      const u = updates.find((s) => s.row.id === r.id)
      if (!u) return r
      return {
        ...r,
        display_name: u.draft.display_name.trim(),
        sort_order: Number(u.draft.sort_order) || 0,
        xero_item_code: normalise(u.draft.xero_item_code) ?? '',
      }
    })
    setRows(nextRows)

    const results = await Promise.all(updates.map((u) =>
      supabase
        .from('material_options')
        .update({
          display_name: u.draft.display_name.trim(),
          sort_order: Number(u.draft.sort_order) || 0,
          xero_item_code: normalise(u.draft.xero_item_code),
        })
        .eq('id', u.row.id),
    ))
    const firstError = results.find((r) => r.error)?.error ?? null
    if (firstError) {
      setRows(previousRows)
      setError(`Failed to save: ${firstError.message}`)
      setSaving(false)
      return
    }

    setSaving(false)
    setSavedAt(Date.now())
    void logAudit({
      action: 'material_option.updated',
      targetType: 'material_option',
      targetLabel: updates.length === 1
        ? `${updates[0].row.material_display_name} — ${updates[0].row.display_name}`
        : `${updates.length} options`,
      metadata: {
        changes: updates.map((u) => ({
          option_id: u.row.id,
          material_display_name: u.row.material_display_name,
          code: u.row.code,
          before: { display_name: u.row.display_name, sort_order: u.row.sort_order, xero_item_code: u.row.xero_item_code || null },
          after: { display_name: u.draft.display_name.trim(), sort_order: Number(u.draft.sort_order) || 0, xero_item_code: normalise(u.draft.xero_item_code) },
        })),
      },
    })
  }

  async function handleAdd(materialId: string, materialName: string) {
    const draft = adding[materialId]
    if (!draft) return
    const code = draft.code.trim()
    const displayName = draft.display_name.trim()
    if (!code || !displayName) {
      setError('A new option needs both a code and a display name.')
      return
    }
    setBusyMaterial(materialId)
    setError(null)
    // Default the sort order to one past the current max in the group.
    const groupRows = rows.filter((r) => r.material_id === materialId)
    const defaultSort = groupRows.reduce((max, r) => Math.max(max, r.sort_order), 0) + 1
    const sortOrder = draft.sort_order.trim() === '' ? defaultSort : (Number(draft.sort_order) || defaultSort)

    const { error: err } = await supabase
      .from('material_options')
      .insert({
        material_id: materialId,
        code,
        display_name: displayName,
        is_base: false,
        sort_order: sortOrder,
        xero_item_code: normalise(draft.xero_item_code),
      })
    setBusyMaterial(null)
    if (err) {
      // 23505 = duplicate code within the material (unique on material_id, code).
      setError(
        err.code === '23505'
          ? `An option with code "${code}" already exists for ${materialName}.`
          : `Failed to add option: ${err.message}`,
      )
      return
    }
    void logAudit({
      action: 'material_option.created',
      targetType: 'material_option',
      targetLabel: `${materialName} — ${displayName}`,
      metadata: { material_id: materialId, code, display_name: displayName, sort_order: sortOrder, xero_item_code: normalise(draft.xero_item_code) },
    })
    setAdding((a) => { const next = { ...a }; delete next[materialId]; return next })
    await load()
  }

  async function handleRemove(row: OptionRow) {
    if (!window.confirm(`Remove "${row.display_name}" from ${row.material_display_name}? This can't be undone.`)) return
    setBusyMaterial(row.material_id)
    setError(null)
    const { error: err } = await supabase.from('material_options').delete().eq('id', row.id)
    setBusyMaterial(null)
    if (err) {
      // 23503 = FK violation: the option is referenced by an existing order.
      setError(
        err.code === '23503'
          ? `Can't remove "${row.display_name}" — it's used by at least one order. Options on placed orders are kept for the record.`
          : `Failed to remove option: ${err.message}`,
      )
      return
    }
    void logAudit({
      action: 'material_option.deleted',
      targetType: 'material_option',
      targetLabel: `${row.material_display_name} — ${row.display_name}`,
      metadata: { material_id: row.material_id, code: row.code, xero_item_code: row.xero_item_code || null },
    })
    await load()
  }

  const recentlySaved = savedAt != null && Date.now() - savedAt < 2000

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-ink-mute">
          The choices offered within a material — wood species, metal finishes. Add a new option (e.g. a new wood species), rename one, set its sort order, or set the Xero item code it invoices as. The customer page picks up new options automatically.
        </p>
        <p className="mt-2 text-xs text-ink-dim">
          A blank Xero code makes the option invoice under its variant's own code. Wood species each want their own code; metal finishes are intended to inherit the base metal's. A code can't be changed once set (orders reference it) — remove and re-add if you really need to.
        </p>
      </div>

      {error && (
        <div className="rounded-lg bg-out-soft px-3 py-2 text-sm text-out ring-1 ring-out">{error}</div>
      )}

      {loading ? (
        <div className="flex justify-center py-20">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-line border-t-gray-900" />
        </div>
      ) : (
        <div className="space-y-5">
          {groups.map((group) => {
            const newDraft = adding[group.id]
            const busy = busyMaterial === group.id
            return (
              <div key={group.id} className="overflow-hidden rounded-2xl bg-surface shadow-sm ring-1 ring-line">
                <div className="bg-canvas px-5 py-3">
                  <div className="font-medium text-ink">{group.name}</div>
                  <div className="text-xs uppercase tracking-wider text-ink-dim">
                    {group.category}{group.optionLabel ? ` · ${group.optionLabel}` : ''}
                  </div>
                </div>
                <table className="min-w-full divide-y divide-line-soft">
                  <thead>
                    <tr className="text-left text-xs font-semibold uppercase tracking-widest text-ink-mute">
                      <th className="px-5 py-2">Option</th>
                      <th className="px-5 py-2 w-24">Order</th>
                      <th className="px-5 py-2 w-40">Xero code</th>
                      <th className="px-5 py-2 w-20" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line-soft text-sm">
                    {group.rows.map(({ row, draft, dirty }) => (
                      <tr key={row.id} className={dirty ? 'bg-low-soft' : ''}>
                        <td className="px-5 py-3 align-top">
                          <input
                            type="text"
                            value={draft.display_name}
                            onChange={(e) => updateDraft(row.id, { display_name: e.target.value })}
                            className="w-48 rounded border border-line px-3 py-2 text-[17px] sm:text-sm focus:border-[var(--c-brand)] focus:bg-[var(--c-brand-50)] focus:outline-none"
                          />
                          <div className="mt-1 flex items-center gap-2 text-xs text-ink-dim">
                            <code className="rounded bg-canvas px-1.5 py-0.5">{row.code}</code>
                            {row.is_base && <span className="rounded-full bg-low-soft px-2 py-0.5 font-medium text-ink-soft">Base</span>}
                          </div>
                        </td>
                        <td className="px-5 py-3 align-top">
                          <input
                            type="number"
                            value={draft.sort_order}
                            onChange={(e) => updateDraft(row.id, { sort_order: e.target.value })}
                            className="w-20 rounded border border-line px-3 py-2 text-[17px] sm:text-sm focus:border-[var(--c-brand)] focus:bg-[var(--c-brand-50)] focus:outline-none"
                          />
                        </td>
                        <td className="px-5 py-3 align-top">
                          <input
                            type="text"
                            value={draft.xero_item_code}
                            onChange={(e) => updateDraft(row.id, { xero_item_code: e.target.value })}
                            placeholder="—"
                            className="w-32 rounded border border-line px-3 py-2 text-[17px] sm:text-sm focus:border-[var(--c-brand)] focus:bg-[var(--c-brand-50)] focus:outline-none"
                          />
                        </td>
                        <td className="px-5 py-3 align-top text-right">
                          <button
                            type="button"
                            onClick={() => void handleRemove(row)}
                            disabled={busy || row.is_base}
                            title={row.is_base ? 'The base option can’t be removed here' : 'Remove this option'}
                            className="text-xs font-medium text-out hover:underline disabled:cursor-not-allowed disabled:text-ink-dim disabled:no-underline"
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <div className="border-t border-line-soft bg-canvas px-5 py-3">
                  {newDraft ? (
                    <div className="flex flex-wrap items-end gap-3">
                      <label className="text-xs text-ink-mute">
                        <span className="mb-1 block">Code</span>
                        <input
                          type="text"
                          value={newDraft.code}
                          onChange={(e) => setAdding((a) => ({ ...a, [group.id]: { ...newDraft, code: e.target.value } }))}
                          placeholder="english_oak"
                          className="w-40 rounded border border-line px-3 py-2 text-sm focus:border-[var(--c-brand)] focus:outline-none"
                        />
                      </label>
                      <label className="text-xs text-ink-mute">
                        <span className="mb-1 block">Display name</span>
                        <input
                          type="text"
                          value={newDraft.display_name}
                          onChange={(e) => setAdding((a) => ({ ...a, [group.id]: { ...newDraft, display_name: e.target.value } }))}
                          placeholder="English Oak"
                          className="w-44 rounded border border-line px-3 py-2 text-sm focus:border-[var(--c-brand)] focus:outline-none"
                        />
                      </label>
                      <label className="text-xs text-ink-mute">
                        <span className="mb-1 block">Xero code</span>
                        <input
                          type="text"
                          value={newDraft.xero_item_code}
                          onChange={(e) => setAdding((a) => ({ ...a, [group.id]: { ...newDraft, xero_item_code: e.target.value } }))}
                          placeholder="0156"
                          className="w-28 rounded border border-line px-3 py-2 text-sm focus:border-[var(--c-brand)] focus:outline-none"
                        />
                      </label>
                      <button
                        type="button"
                        onClick={() => void handleAdd(group.id, group.name)}
                        disabled={busy}
                        className="rounded bg-ink px-3 py-2 text-sm font-semibold text-on-ink hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {busy ? 'Adding…' : 'Add option'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setAdding((a) => { const next = { ...a }; delete next[group.id]; return next })}
                        className="text-xs text-ink-mute hover:text-ink"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setAdding((a) => ({ ...a, [group.id]: { ...EMPTY_NEW } }))}
                      className="text-sm font-medium text-brand hover:underline"
                    >
                      + Add {group.optionLabel ? group.optionLabel.toLowerCase() : 'option'}
                    </button>
                  )}
                </div>
              </div>
            )
          })}
          {groups.length === 0 && (
            <p className="text-sm text-ink-mute">No materials use options yet.</p>
          )}
        </div>
      )}

      <div className="flex items-center justify-end gap-3">
        {recentlySaved && !saving && <span className="text-xs text-in-stock">Saved</span>}
        {saving && <span className="text-xs text-ink-dim">Saving…</span>}
        <button
          type="button"
          onClick={handleSave}
          disabled={saveDisabled}
          className="rounded bg-ink px-4 py-2 text-sm font-semibold text-on-ink hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:opacity-40"
        >
          {dirtyCount === 0 ? 'Save changes' : `Save changes (${dirtyCount} ${dirtyCount === 1 ? 'row' : 'rows'})`}
        </button>
      </div>
    </div>
  )
}
