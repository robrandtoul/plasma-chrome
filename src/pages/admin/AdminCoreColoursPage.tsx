import { useEffect, useMemo, useState } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../../lib/supabase'
import { logAudit } from '../../lib/audit'
import { CoreColourSwatch } from '../../components/CoreColourSwatch'
import type { LetterpressCoreColour } from '../../lib/types'
import CoreColoursImport from './CoreColoursImport'

// Admin page for the letterpress core-colour palette
// (migration 000133). Pattern matches the existing admin pricing
// pages: direct supabase calls, fire-and-forget audit log per
// change, no RPC. Soft-delete on Remove (sets is_active=false) so
// the FK on delete restrict in proof_versions never blocks.
//
// Inactive colours stay visible here (greyed out) but are filtered
// out of the designer-facing picker by RLS at the DB.

const HEX_RE = /^#[0-9A-Fa-f]{6}$/
function normaliseHex(raw: string): string {
  return raw.trim().toLowerCase()
}
function isValidHex(raw: string): boolean {
  return HEX_RE.test(raw.trim())
}

interface RowState {
  draftName: string
  draftHex: string
  draftSortOrder: string
  saving: boolean
  rowError: string | null
}

const blankRowState = (): RowState => ({
  draftName: '',
  draftHex: '',
  draftSortOrder: '',
  saving: false,
  rowError: null,
})

export default function AdminCoreColoursPage() {
  const [colours, setColours] = useState<LetterpressCoreColour[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Per-row inline-edit state. Keyed by colour id; absent = read-only.
  const [editing, setEditing] = useState<Record<string, RowState>>({})

  // Add-row state. Null = closed; non-null = expanded form below the
  // table. Mirrors the per-row shape so save logic can reuse the
  // hex / name validation helpers.
  const [adding, setAdding] = useState<RowState | null>(null)

  // Import modal visibility (migration 000137). Mounts the
  // CoreColoursImport component which owns its own file pick →
  // preview → apply flow and calls onApplied with the server-
  // returned summary so we can refresh the table + show a toast.
  const [showImport, setShowImport] = useState(false)
  // Lightweight summary toast after a successful Apply. 5s
  // auto-dismiss matches the existing Undo toast cadence elsewhere.
  const [importToast, setImportToast] = useState<string | null>(null)

  useEffect(() => {
    void load()
  }, [])

  async function load() {
    setLoading(true)
    setLoadError(null)
    const { data, error } = await supabase
      .from('letterpress_core_colours')
      .select('id, name, hex_value, is_active, sort_order')
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true })
    if (error) {
      setLoadError(error.message)
      setLoading(false)
      return
    }
    setColours((data ?? []) as LetterpressCoreColour[])
    setLoading(false)
  }

  // Set membership on names, normalised to lower-case so
  // "Burgundy" and "burgundy" can't both be added. The DB has a
  // unique constraint as the ultimate guard, but client-side
  // pre-check gives a friendlier error.
  const nameLowercase = useMemo(
    () => new Set(colours.map((c) => c.name.toLowerCase())),
    [colours],
  )

  function startEdit(c: LetterpressCoreColour) {
    setEditing((prev) => ({
      ...prev,
      [c.id]: {
        draftName: c.name,
        draftHex: c.hex_value,
        draftSortOrder: String(c.sort_order),
        saving: false,
        rowError: null,
      },
    }))
  }

  function cancelEdit(id: string) {
    setEditing((prev) => {
      const { [id]: _, ...rest } = prev
      return rest
    })
  }

  function setEditField(id: string, field: keyof RowState, value: string) {
    setEditing((prev) => ({
      ...prev,
      [id]: { ...prev[id], [field]: value, rowError: null },
    }))
  }

  async function saveEdit(c: LetterpressCoreColour) {
    const draft = editing[c.id]
    if (!draft) return

    const trimmedName = draft.draftName.trim()
    const normalisedHex = normaliseHex(draft.draftHex)
    const sortOrderNum = parseInt(draft.draftSortOrder, 10)

    if (!trimmedName) {
      setEditing((prev) => ({ ...prev, [c.id]: { ...draft, rowError: 'Name is required.' } }))
      return
    }
    if (!isValidHex(normalisedHex)) {
      setEditing((prev) => ({ ...prev, [c.id]: { ...draft, rowError: 'Hex must be a 6-digit value like #1a2b3c.' } }))
      return
    }
    if (!Number.isInteger(sortOrderNum)) {
      setEditing((prev) => ({ ...prev, [c.id]: { ...draft, rowError: 'Sort order must be a whole number.' } }))
      return
    }

    // Name uniqueness — case-insensitive client-side pre-check that
    // skips the row's own current name. DB unique constraint is the
    // belt-and-braces.
    const conflict = colours.find(
      (other) =>
        other.id !== c.id &&
        other.name.toLowerCase() === trimmedName.toLowerCase(),
    )
    if (conflict) {
      setEditing((prev) => ({ ...prev, [c.id]: { ...draft, rowError: `Name already used by "${conflict.name}".` } }))
      return
    }

    setEditing((prev) => ({ ...prev, [c.id]: { ...draft, saving: true, rowError: null } }))

    const before = {
      name: c.name,
      hex_value: c.hex_value,
      sort_order: c.sort_order,
    }
    const after = {
      name: trimmedName,
      hex_value: normalisedHex,
      sort_order: sortOrderNum,
    }

    const { data, error } = await supabase
      .from('letterpress_core_colours')
      .update(after)
      .eq('id', c.id)
      .select('id, name, hex_value, is_active, sort_order')
      .single()

    if (error || !data) {
      setEditing((prev) => ({
        ...prev,
        [c.id]: { ...draft, saving: false, rowError: error?.message ?? 'Save failed.' },
      }))
      return
    }

    setColours((prev) => sortColours(prev.map((row) => (row.id === c.id ? (data as LetterpressCoreColour) : row))))
    cancelEdit(c.id)
    void logAudit({
      action: 'core_colour_updated',
      targetType: 'letterpress_core_colour',
      targetId: c.id,
      targetLabel: trimmedName,
      beforeValue: before,
      afterValue: after,
    })
  }

  async function deactivate(c: LetterpressCoreColour) {
    const { data, error } = await supabase
      .from('letterpress_core_colours')
      .update({ is_active: false })
      .eq('id', c.id)
      .select('id, name, hex_value, is_active, sort_order')
      .single()
    if (error || !data) return
    setColours((prev) => sortColours(prev.map((row) => (row.id === c.id ? (data as LetterpressCoreColour) : row))))
    void logAudit({
      action: 'core_colour_deactivated',
      targetType: 'letterpress_core_colour',
      targetId: c.id,
      targetLabel: c.name,
      beforeValue: { is_active: true },
      afterValue: { is_active: false },
    })
  }

  async function reactivate(c: LetterpressCoreColour) {
    const { data, error } = await supabase
      .from('letterpress_core_colours')
      .update({ is_active: true })
      .eq('id', c.id)
      .select('id, name, hex_value, is_active, sort_order')
      .single()
    if (error || !data) return
    setColours((prev) => sortColours(prev.map((row) => (row.id === c.id ? (data as LetterpressCoreColour) : row))))
    void logAudit({
      action: 'core_colour_reactivated',
      targetType: 'letterpress_core_colour',
      targetId: c.id,
      targetLabel: c.name,
      beforeValue: { is_active: false },
      afterValue: { is_active: true },
    })
  }

  async function createColour() {
    if (!adding) return
    const trimmedName = adding.draftName.trim()
    const normalisedHex = normaliseHex(adding.draftHex)
    const sortOrderNum = parseInt(adding.draftSortOrder, 10)

    if (!trimmedName) {
      setAdding({ ...adding, rowError: 'Name is required.' })
      return
    }
    if (!isValidHex(normalisedHex)) {
      setAdding({ ...adding, rowError: 'Hex must be a 6-digit value like #1a2b3c.' })
      return
    }
    if (!Number.isInteger(sortOrderNum)) {
      setAdding({ ...adding, rowError: 'Sort order must be a whole number.' })
      return
    }
    if (nameLowercase.has(trimmedName.toLowerCase())) {
      setAdding({ ...adding, rowError: `"${trimmedName}" is already in the palette.` })
      return
    }

    setAdding({ ...adding, saving: true, rowError: null })

    const { data, error } = await supabase
      .from('letterpress_core_colours')
      .insert({
        name: trimmedName,
        hex_value: normalisedHex,
        sort_order: sortOrderNum,
        is_active: true,
      })
      .select('id, name, hex_value, is_active, sort_order')
      .single()

    if (error || !data) {
      setAdding({ ...adding, saving: false, rowError: error?.message ?? 'Save failed.' })
      return
    }

    setColours((prev) => sortColours([...prev, data as LetterpressCoreColour]))
    setAdding(null)
    void logAudit({
      action: 'core_colour_created',
      targetType: 'letterpress_core_colour',
      targetId: (data as LetterpressCoreColour).id,
      targetLabel: trimmedName,
      afterValue: {
        name: trimmedName,
        hex_value: normalisedHex,
        sort_order: sortOrderNum,
        is_active: true,
      },
    })
  }

  function openAdd() {
    // Suggest the next sort_order step after the highest existing
    // value, or 10 when the palette is empty. Keeps new entries
    // sorted to the bottom by default.
    const maxSort = colours.reduce((m, c) => Math.max(m, c.sort_order), 0)
    setAdding({
      ...blankRowState(),
      draftHex: '#000000',
      draftSortOrder: String(maxSort + 10),
    })
  }

  // Export the full catalogue (active + inactive) to an XLSX,
  // ordered by sort_order then name. Columns: ID, Name, Hex, Sort,
  // Active. Active rendered as TRUE / FALSE so the round-trip
  // import path (which accepts those literals) works without
  // post-processing. Filename includes today's date so successive
  // exports don't overwrite each other in the downloads folder.
  function handleExport() {
    if (colours.length === 0) return
    const sorted = [...colours].sort((a, b) => {
      if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order
      return a.name.localeCompare(b.name)
    })
    const aoa: (string | number | boolean)[][] = [
      ['ID', 'Name', 'Hex', 'Sort', 'Active'],
      ...sorted.map((c) => [
        c.id,
        c.name,
        c.hex_value,
        c.sort_order,
        c.is_active ? 'TRUE' : 'FALSE',
      ]),
    ]
    const ws = XLSX.utils.aoa_to_sheet(aoa)
    // Reasonable default column widths so the file is readable
    // when opened. UUID column is wide; Name moderate; the rest
    // narrow.
    ws['!cols'] = [
      { wch: 38 }, // ID (UUID)
      { wch: 22 }, // Name
      { wch: 10 }, // Hex
      { wch: 8 },  // Sort
      { wch: 10 }, // Active
    ]
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Core colours')
    const today = new Date().toISOString().slice(0, 10)
    XLSX.writeFile(wb, `letterpress-core-colours-${today}.xlsx`)
  }

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-line border-t-gray-900" />
      </div>
    )
  }

  if (loadError) {
    return (
      <div className="rounded-2xl bg-out-soft p-6 text-sm text-out ring-1 ring-out">
        Failed to load paper colours: {loadError}
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-ink">Letterpress paper colours</h2>
          <p className="mt-1 max-w-xl text-sm text-ink-mute">
            The Colorplan paper palette used for the front, core, and back layers of un-gilded
            letterpress cards. Designers pick from active colours when creating a letterpress proof.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={handleExport}
            disabled={colours.length === 0}
            className="rounded-lg px-4 py-2 text-sm font-medium text-ink-soft ring-1 ring-line hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-50"
            title={colours.length === 0 ? 'Catalogue is empty — nothing to export' : 'Download the full palette as XLSX'}
          >
            Export
          </button>
          <button
            type="button"
            onClick={() => setShowImport(true)}
            className="rounded-lg px-4 py-2 text-sm font-medium text-ink-soft ring-1 ring-line hover:bg-canvas"
            title="Upload an XLSX to bulk-update the palette"
          >
            Import
          </button>
          <button
            type="button"
            onClick={openAdd}
            disabled={!!adding}
            className="rounded-lg bg-ink px-4 py-2 text-sm font-semibold text-on-ink hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            + Add colour
          </button>
        </div>
      </div>

      {/* Toast: post-apply summary, auto-dismiss after 5s. */}
      {importToast && (
        <div
          role="status"
          className="rounded-lg bg-in-stock-soft px-4 py-3 text-sm text-in-stock ring-1 ring-in-stock"
        >
          {importToast}
        </div>
      )}

      <section className="overflow-hidden rounded-2xl bg-surface shadow-sm ring-1 ring-line">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line-soft">
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-ink-dim">Colour</th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-ink-dim">Name</th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-ink-dim">Hex</th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-ink-dim">Sort</th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-ink-dim">Status</th>
              <th className="px-4 py-3" aria-label="Actions"></th>
            </tr>
          </thead>
          <tbody>
            {colours.length === 0 && !adding && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sm text-ink-mute">
                  No paper colours yet. Add the first one above.
                </td>
              </tr>
            )}
            {colours.map((c) => {
              const draft = editing[c.id]
              const isEditing = !!draft
              return (
                <tr
                  key={c.id}
                  className={[
                    'border-b border-line-soft last:border-0',
                    !c.is_active ? 'bg-canvas' : '',
                  ].join(' ')}
                >
                  <td className="px-4 py-3">
                    <CoreColourSwatch
                      hex={isEditing && isValidHex(draft.draftHex) ? normaliseHex(draft.draftHex) : c.hex_value}
                      size={28}
                      ariaLabel={`${c.name} swatch`}
                    />
                  </td>
                  <td className="px-4 py-3">
                    {isEditing ? (
                      <input
                        type="text"
                        value={draft.draftName}
                        onChange={(e) => setEditField(c.id, 'draftName', e.target.value)}
                        disabled={draft.saving}
                        className="w-40 rounded border border-line px-2 py-1 text-[17px] sm:text-sm focus:border-[var(--c-brand)] focus:bg-[var(--c-brand-50)] focus:outline-none"
                      />
                    ) : (
                      <span className={c.is_active ? 'font-medium text-ink' : 'text-ink-mute'}>
                        {c.name}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">
                    {isEditing ? (
                      <div className="flex items-center gap-2">
                        <input
                          type="color"
                          value={isValidHex(draft.draftHex) ? normaliseHex(draft.draftHex) : '#000000'}
                          onChange={(e) => setEditField(c.id, 'draftHex', e.target.value)}
                          disabled={draft.saving}
                          aria-label="Pick colour"
                          className="h-8 w-8 cursor-pointer rounded border border-line"
                        />
                        <input
                          type="text"
                          value={draft.draftHex}
                          onChange={(e) => setEditField(c.id, 'draftHex', e.target.value)}
                          disabled={draft.saving}
                          placeholder="#1a2b3c"
                          className="w-24 rounded border border-line px-2 py-1 font-mono text-xs focus:border-[var(--c-brand)] focus:bg-[var(--c-brand-50)] focus:outline-none"
                        />
                      </div>
                    ) : (
                      <span className={c.is_active ? 'text-ink-soft' : 'text-ink-dim'}>{c.hex_value}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 tabular-nums">
                    {isEditing ? (
                      <input
                        type="number"
                        value={draft.draftSortOrder}
                        onChange={(e) => setEditField(c.id, 'draftSortOrder', e.target.value)}
                        disabled={draft.saving}
                        className="w-20 rounded border border-line px-2 py-1 text-[17px] sm:text-sm tabular-nums focus:border-[var(--c-brand)] focus:bg-[var(--c-brand-50)] focus:outline-none"
                      />
                    ) : (
                      <span className={c.is_active ? 'text-ink-soft' : 'text-ink-dim'}>{c.sort_order}</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {c.is_active ? (
                      <span className="inline-flex items-center rounded-full bg-in-stock-soft px-2.5 py-0.5 text-xs font-medium text-in-stock ring-1 ring-in-stock">
                        Active
                      </span>
                    ) : (
                      <span className="inline-flex items-center rounded-full bg-canvas px-2.5 py-0.5 text-xs font-medium text-ink-mute ring-1 ring-line">
                        Inactive
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {isEditing ? (
                      <div className="flex flex-col items-end gap-1">
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => cancelEdit(c.id)}
                            disabled={draft.saving}
                            className="rounded-lg px-3 py-1.5 text-sm font-medium text-ink-mute hover:bg-canvas disabled:opacity-50"
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            onClick={() => void saveEdit(c)}
                            disabled={draft.saving}
                            className="rounded-lg bg-ink px-3 py-1.5 text-sm font-semibold text-on-ink hover:opacity-90 disabled:opacity-50"
                          >
                            {draft.saving ? 'Saving…' : 'Save'}
                          </button>
                        </div>
                        {draft.rowError && (
                          <span className="text-xs text-out">{draft.rowError}</span>
                        )}
                      </div>
                    ) : (
                      <div className="flex items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => startEdit(c)}
                          className="rounded-lg px-3 py-1.5 text-sm font-medium text-ink-soft hover:bg-canvas"
                        >
                          Edit
                        </button>
                        {c.is_active ? (
                          <button
                            type="button"
                            onClick={() => void deactivate(c)}
                            className="rounded-lg px-3 py-1.5 text-sm font-medium text-out hover:bg-out-soft"
                          >
                            Remove
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => void reactivate(c)}
                            className="rounded-lg px-3 py-1.5 text-sm font-medium text-in-stock hover:bg-in-stock-soft"
                          >
                            Restore
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
          {adding && (
            <tfoot>
              <tr className="border-t border-line bg-canvas">
                <td className="px-4 py-3">
                  <CoreColourSwatch
                    hex={isValidHex(adding.draftHex) ? normaliseHex(adding.draftHex) : '#000000'}
                    size={28}
                    ariaLabel="New colour swatch"
                  />
                </td>
                <td className="px-4 py-3">
                  <input
                    type="text"
                    value={adding.draftName}
                    onChange={(e) => setAdding({ ...adding, draftName: e.target.value, rowError: null })}
                    disabled={adding.saving}
                    placeholder="e.g. Sage"
                    className="w-40 rounded border border-line px-2 py-1 text-[17px] sm:text-sm focus:border-[var(--c-brand)] focus:bg-[var(--c-brand-50)] focus:outline-none"
                  />
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={isValidHex(adding.draftHex) ? normaliseHex(adding.draftHex) : '#000000'}
                      onChange={(e) => setAdding({ ...adding, draftHex: e.target.value, rowError: null })}
                      disabled={adding.saving}
                      aria-label="Pick colour"
                      className="h-8 w-8 cursor-pointer rounded border border-line"
                    />
                    <input
                      type="text"
                      value={adding.draftHex}
                      onChange={(e) => setAdding({ ...adding, draftHex: e.target.value, rowError: null })}
                      disabled={adding.saving}
                      placeholder="#1a2b3c"
                      className="w-24 rounded border border-line px-2 py-1 font-mono text-xs focus:border-[var(--c-brand)] focus:bg-[var(--c-brand-50)] focus:outline-none"
                    />
                  </div>
                </td>
                <td className="px-4 py-3">
                  <input
                    type="number"
                    value={adding.draftSortOrder}
                    onChange={(e) => setAdding({ ...adding, draftSortOrder: e.target.value, rowError: null })}
                    disabled={adding.saving}
                    className="w-20 rounded border border-line px-2 py-1 text-[17px] sm:text-sm tabular-nums focus:border-[var(--c-brand)] focus:bg-[var(--c-brand-50)] focus:outline-none"
                  />
                </td>
                <td className="px-4 py-3 text-xs text-ink-mute">New</td>
                <td className="px-4 py-3 text-right">
                  <div className="flex flex-col items-end gap-1">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setAdding(null)}
                        disabled={adding.saving}
                        className="rounded-lg px-3 py-1.5 text-sm font-medium text-ink-mute hover:bg-canvas disabled:opacity-50"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => void createColour()}
                        disabled={adding.saving}
                        className="rounded-lg bg-ink px-3 py-1.5 text-sm font-semibold text-on-ink hover:opacity-90 disabled:opacity-50"
                      >
                        {adding.saving ? 'Saving…' : 'Save colour'}
                      </button>
                    </div>
                    {adding.rowError && (
                      <span className="text-xs text-out">{adding.rowError}</span>
                    )}
                  </div>
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </section>

      <p className="text-xs text-ink-mute">
        Removing a colour deactivates it but keeps the row, so any existing proofs that use the colour
        keep working. Inactive colours stay listed here. Restore reactivates the colour for designers.
      </p>

      {showImport && (
        <CoreColoursImport
          current={colours}
          onClose={() => setShowImport(false)}
          onApplied={(summary) => {
            // Reload from the DB so the table shows the new state
            // (server may have applied additional rules beyond the
            // preview's expectations, e.g. RLS-based filters).
            void load()
            const parts: string[] = []
            if (summary.inserted) parts.push(`${summary.inserted} added`)
            if (summary.updated) parts.push(`${summary.updated} updated`)
            if (summary.deactivated) parts.push(`${summary.deactivated} deactivated`)
            setImportToast(
              parts.length > 0
                ? `Import applied: ${parts.join(', ')}.`
                : 'Import applied: no changes.',
            )
            setTimeout(() => setImportToast(null), 5000)
          }}
        />
      )}
    </div>
  )
}

function sortColours(rows: LetterpressCoreColour[]): LetterpressCoreColour[] {
  return [...rows].sort((a, b) => {
    if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order
    return a.name.localeCompare(b.name)
  })
}
