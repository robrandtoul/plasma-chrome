import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { logAudit } from '../../lib/audit'
import { relativeTime, formatAbsoluteDateTime } from '../../lib/relativeTime'

// Admin: production lead times per material.
//
// One row per material. Designer enters a min/max business-day pair
// per material (or clears both at once to remove the recorded lead
// time). Saved as a batch via a single "Save changes" button, with
// one audit event per save covering every dirty row.
//
// The database CHECK constraint (migration 000175) enforces that the
// pair is either both null or both populated with positive ints and
// max >= min. The form mirrors the same rules client-side so the
// designer gets inline feedback before save rather than a generic
// error toast.

interface MaterialRow {
  id: string
  display_name: string
  category: string
  lead_time_min_days: number | null
  lead_time_max_days: number | null
  lead_time_updated_at: string | null
}

interface RowDraft {
  minStr: string
  maxStr: string
  touched: boolean
}

interface ValidationResult {
  ok: boolean
  message: string | null
  // Parsed numeric pair when `ok` is true and both fields are
  // populated. `null` when both fields are empty (the "clear" case).
  parsed: { min: number; max: number } | null
}

function parseDraft(draft: RowDraft): ValidationResult {
  const minTrim = draft.minStr.trim()
  const maxTrim = draft.maxStr.trim()
  const minEmpty = minTrim === ''
  const maxEmpty = maxTrim === ''
  if (minEmpty && maxEmpty) return { ok: true, message: null, parsed: null }
  if (minEmpty || maxEmpty) {
    return { ok: false, message: 'Enter both days, or clear both.', parsed: null }
  }
  const min = Number(minTrim)
  const max = Number(maxTrim)
  if (!Number.isInteger(min) || !Number.isInteger(max)) {
    return { ok: false, message: 'Whole numbers only.', parsed: null }
  }
  if (min <= 0 || max <= 0) {
    return { ok: false, message: 'Must be greater than zero.', parsed: null }
  }
  if (max < min) {
    return { ok: false, message: 'Max must be the same as or greater than min.', parsed: null }
  }
  return { ok: true, message: null, parsed: { min, max } }
}

function isDirty(row: MaterialRow, validation: ValidationResult): boolean {
  if (!validation.ok) return false
  if (validation.parsed === null) {
    return row.lead_time_min_days !== null || row.lead_time_max_days !== null
  }
  return (
    validation.parsed.min !== row.lead_time_min_days ||
    validation.parsed.max !== row.lead_time_max_days
  )
}

export default function AdminLeadTimesPage() {
  const [rows, setRows] = useState<MaterialRow[]>([])
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
      .from('materials')
      .select('id, display_name, category, lead_time_min_days, lead_time_max_days, lead_time_updated_at')
      .eq('is_active', true)
      .order('category')
      .order('display_name')
    setLoading(false)
    if (err) {
      setError(err.message)
      return
    }
    const list = (data ?? []) as MaterialRow[]
    setRows(list)
    setDrafts(
      Object.fromEntries(
        list.map((r) => [
          r.id,
          {
            minStr: r.lead_time_min_days == null ? '' : String(r.lead_time_min_days),
            maxStr: r.lead_time_max_days == null ? '' : String(r.lead_time_max_days),
            touched: false,
          },
        ]),
      ),
    )
  }

  // Per-row validation + dirty state, computed once per render so
  // both the input handlers and the Save button consult the same
  // source of truth.
  const rowState = useMemo(() => {
    return rows.map((r) => {
      const draft = drafts[r.id] ?? { minStr: '', maxStr: '', touched: false }
      const validation = parseDraft(draft)
      return { row: r, draft, validation, dirty: isDirty(r, validation) }
    })
  }, [rows, drafts])

  const dirtyCount = rowState.filter((s) => s.dirty).length
  const hasInvalidDirty = rowState.some((s) => s.dirty && !s.validation.ok)
  // A row that has been touched but is invalid is also a blocker —
  // an intentional in-progress edit shouldn't let a save slip past
  // with the half-typed value reverted.
  const hasInvalidTouched = rowState.some((s) => s.draft.touched && !s.validation.ok)
  const saveDisabled = saving || dirtyCount === 0 || hasInvalidDirty || hasInvalidTouched

  function updateDraft(id: string, patch: Partial<RowDraft>) {
    setDrafts((d) => ({ ...d, [id]: { ...d[id], ...patch, touched: true } }))
    // Clear any prior "Saved" indicator the moment the designer
    // starts editing again — keeps the status truthful.
    if (savedAt != null) setSavedAt(null)
  }

  async function handleSave() {
    if (saveDisabled) return
    setSaving(true)
    setError(null)
    const updates = rowState.filter((s) => s.dirty)
    const nowIso = new Date().toISOString()
    // Optimistic local update so the inputs and "Last updated"
    // column settle immediately. Snapshot the previous rows so we
    // can roll back if Supabase returns an error.
    const previousRows = rows
    const nextRows: MaterialRow[] = rows.map((r) => {
      const u = updates.find((s) => s.row.id === r.id)
      if (!u) return r
      const parsed = u.validation.parsed
      return {
        ...r,
        lead_time_min_days: parsed?.min ?? null,
        lead_time_max_days: parsed?.max ?? null,
        lead_time_updated_at: nowIso,
      }
    })
    setRows(nextRows)

    // One UPDATE per dirty row. The catalogue is small (sub-30
    // materials) and admin saves are infrequent, so the round-trip
    // cost is not worth a batched RPC. Run in parallel so a five-
    // row batch still feels instant.
    const results = await Promise.all(
      updates.map((u) =>
        supabase
          .from('materials')
          .update({
            lead_time_min_days: u.validation.parsed?.min ?? null,
            lead_time_max_days: u.validation.parsed?.max ?? null,
            lead_time_updated_at: nowIso,
          })
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
    // Reset the touched flag on saved rows so per-row error text
    // disappears immediately after a successful save.
    setDrafts((d) => {
      const next = { ...d }
      for (const u of updates) {
        const parsed = u.validation.parsed
        next[u.row.id] = {
          minStr: parsed == null ? '' : String(parsed.min),
          maxStr: parsed == null ? '' : String(parsed.max),
          touched: false,
        }
      }
      return next
    })

    // Single audit event per save batch. Payload carries the
    // before/after pair per material so the activity log can show
    // exactly what changed in one row.
    void logAudit({
      action: 'material.lead_times_updated',
      targetType: 'material',
      targetLabel: updates.length === 1
        ? updates[0].row.display_name
        : `${updates.length} materials`,
      metadata: {
        changes: updates.map((u) => ({
          material_id: u.row.id,
          material_display_name: u.row.display_name,
          before: {
            lead_time_min_days: u.row.lead_time_min_days,
            lead_time_max_days: u.row.lead_time_max_days,
          },
          after: {
            lead_time_min_days: u.validation.parsed?.min ?? null,
            lead_time_max_days: u.validation.parsed?.max ?? null,
          },
        })),
      },
    })
  }

  const recentlySaved = savedAt != null && Date.now() - savedAt < 2000

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-ink">Lead times</h2>
        <p className="mt-1 text-sm text-ink-mute">
          Set the current production lead time per material, in business days. Surfaces on the Quote compiler so the designer sees a live figure beside the material and quantity inputs. Customer-facing pages are unaffected. Clear both fields on a row to remove the recorded lead time for that material.
        </p>
      </div>

      {error && (
        <div className="rounded-lg bg-out-soft px-3 py-2 text-sm text-out ring-1 border-out">
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
                <th className="px-5 py-3">Min days</th>
                <th className="px-5 py-3">Max days</th>
                <th className="px-5 py-3">Last updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-soft text-sm">
              {rowState.map(({ row, draft, validation, dirty }) => {
                const showError = draft.touched && !validation.ok
                const errorId = showError ? `lead-time-error-${row.id}` : undefined
                return (
                  <tr key={row.id} className={dirty ? 'bg-low-soft/40' : ''}>
                    <td className="px-5 py-3 align-top">
                      <div className="font-medium text-ink">{row.display_name}</div>
                      <div className="text-xs uppercase tracking-wider text-ink-mute">{row.category}</div>
                    </td>
                    <td className="px-5 py-3 align-top">
                      <input
                        type="number"
                        min={1}
                        step={1}
                        inputMode="numeric"
                        value={draft.minStr}
                        onChange={(e) => updateDraft(row.id, { minStr: e.target.value })}
                        aria-invalid={showError || undefined}
                        aria-describedby={errorId}
                        className={leadTimeInputClass(showError)}
                      />
                    </td>
                    <td className="px-5 py-3 align-top">
                      <input
                        type="number"
                        min={1}
                        step={1}
                        inputMode="numeric"
                        value={draft.maxStr}
                        onChange={(e) => updateDraft(row.id, { maxStr: e.target.value })}
                        aria-invalid={showError || undefined}
                        aria-describedby={errorId}
                        className={leadTimeInputClass(showError)}
                      />
                      {showError && (
                        <p id={errorId} className="mt-1 text-xs text-out">
                          {validation.message}
                        </p>
                      )}
                    </td>
                    <td
                      className="px-5 py-3 align-top text-xs text-ink-mute"
                      title={formatAbsoluteDateTime(row.lead_time_updated_at) || undefined}
                    >
                      {row.lead_time_updated_at == null
                        ? 'Never'
                        : relativeTime(row.lead_time_updated_at)}
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
          className="rounded-lg bg-ink px-4 py-2 text-sm font-semibold text-on-ink hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {dirtyCount === 0
            ? 'Save changes'
            : `Save changes (${dirtyCount} ${dirtyCount === 1 ? 'row' : 'rows'})`}
        </button>
      </div>
    </div>
  )
}

function leadTimeInputClass(showError: boolean): string {
  const base = 'w-24 rounded-lg border px-3 py-2 text-[17px] sm:text-sm focus:outline-none focus:ring-1'
  return showError
    ? `${base} border-out focus:outline focus:outline-2 focus:outline-offset-[-1px] focus:outline-[var(--c-out)]`
    : `${base} border-line focus:border-[var(--c-brand)] focus:outline focus:outline-2 focus:outline-offset-[-1px] focus:outline-[var(--c-brand)]`
}
