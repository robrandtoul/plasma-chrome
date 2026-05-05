import { useRef, useState } from 'react'
import * as XLSX from 'xlsx'
import Modal from '../../components/Modal'
import { CoreColourSwatch } from '../../components/CoreColourSwatch'
import { supabase } from '../../lib/supabase'
import type { LetterpressCoreColour } from '../../lib/types'

// XLSX import flow for /admin/core-colours.
//
// Three states: upload (file picker) → preview (validation + diff)
// → applying. Apply commits via the apply_core_colours_import RPC
// (migration 000137) which wraps validate + upsert + soft-deactivate
// + audit log in one transaction. Server-side validation is the
// authoritative gate; the client-side validation here is purely a
// UX affordance to show all errors at once before the round trip.

interface Props {
  /** Current DB state, used to compute the preview diff. */
  current: LetterpressCoreColour[]
  onClose: () => void
  /** Called after a successful apply so the parent can refresh. */
  onApplied: (summary: { inserted: number; updated: number; deactivated: number }) => void
}

interface ParsedRow {
  /** 1-indexed row number in the spreadsheet (header is row 1, first data row is 2). */
  rowNumber: number
  id: string | null
  name: string
  hex_value: string
  sort_order: number
  is_active: boolean
}

interface RowError {
  rowNumber: number
  message: string
}

interface DiffEntry {
  parsed: ParsedRow
  current: LetterpressCoreColour | null
  /** Per-field changes for updates; empty for inserts. */
  changes: Array<{ field: string; old: string; next: string }>
}

interface Preview {
  inserts: DiffEntry[]
  updates: DiffEntry[]
  deactivations: LetterpressCoreColour[]
  unchangedCount: number
}

const HEX_RE = /^#[0-9A-Fa-f]{6}$/
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Normalise a header cell to a known field key. Case-insensitive,
// trims whitespace. Returns null for unknown headers (caller skips
// the column).
function normaliseHeader(raw: unknown): keyof ParsedRow | 'unknown' | 'skip' {
  if (raw == null) return 'skip'
  const s = String(raw).trim().toLowerCase()
  if (s === '') return 'skip'
  if (s === 'id') return 'id'
  if (s === 'name') return 'name'
  if (s === 'hex' || s === 'hex_value' || s === 'hex value' || s === 'colour' || s === 'color') return 'hex_value'
  if (s === 'sort' || s === 'sort_order' || s === 'sort order' || s === 'order') return 'sort_order'
  if (s === 'active' || s === 'is_active' || s === 'is active' || s === 'status') return 'is_active'
  return 'unknown'
}

// Boolean coercion supporting common spreadsheet/text idioms.
// Returns null for unrecognised values so the caller can flag a
// validation error.
function parseBoolean(raw: unknown): boolean | null {
  if (typeof raw === 'boolean') return raw
  if (typeof raw === 'number') {
    if (raw === 1) return true
    if (raw === 0) return false
    return null
  }
  if (raw == null) return null
  const s = String(raw).trim().toLowerCase()
  if (['true', 't', 'yes', 'y', '1', 'active'].includes(s)) return true
  if (['false', 'f', 'no', 'n', '0', 'inactive'].includes(s)) return false
  return null
}

// Hex normalisation: trim, lowercase, ensure leading #. Doesn't
// validate; that's done separately so the validation error message
// can show what the user actually typed.
function normaliseHex(raw: unknown): string {
  if (raw == null) return ''
  let s = String(raw).trim().toLowerCase()
  if (s && !s.startsWith('#')) s = '#' + s
  return s
}

// Parse the workbook into typed rows + collect validation errors.
// Returns both — the caller decides whether to render preview or
// just errors.
function parseWorkbook(buffer: ArrayBuffer): { rows: ParsedRow[]; errors: RowError[] } {
  const wb = XLSX.read(buffer, { type: 'array' })
  const sheetName = wb.SheetNames[0]
  if (!sheetName) {
    return { rows: [], errors: [{ rowNumber: 0, message: 'Workbook has no sheets.' }] }
  }
  const sheet = wb.Sheets[sheetName]
  const aoa: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null })
  if (aoa.length === 0) {
    return { rows: [], errors: [{ rowNumber: 0, message: 'Sheet is empty.' }] }
  }

  // Header row → column-index → field-key map.
  const header = aoa[0] ?? []
  const colMap: Partial<Record<keyof ParsedRow, number>> = {}
  for (let i = 0; i < header.length; i++) {
    const key = normaliseHeader(header[i])
    if (key === 'skip' || key === 'unknown') continue
    colMap[key] = i
  }

  // Required columns (id is optional)
  const missing: string[] = []
  if (colMap.name == null) missing.push('Name')
  if (colMap.hex_value == null) missing.push('Hex')
  if (colMap.sort_order == null) missing.push('Sort')
  if (colMap.is_active == null) missing.push('Active')
  if (missing.length > 0) {
    return {
      rows: [],
      errors: [{ rowNumber: 1, message: `Missing required column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.` }],
    }
  }

  const rows: ParsedRow[] = []
  const errors: RowError[] = []
  const seenNames = new Map<string, number>() // lower-cased name → first row number

  for (let r = 1; r < aoa.length; r++) {
    const row = aoa[r] ?? []
    // Treat fully-blank rows as the end of data (don't error on
    // trailing empties).
    if (row.every((c) => c == null || String(c).trim() === '')) continue

    const rowNumber = r + 1 // 1-indexed for users (header at row 1)

    const rawId = colMap.id != null ? row[colMap.id] : null
    const rawName = row[colMap.name!]
    const rawHex = row[colMap.hex_value!]
    const rawSort = row[colMap.sort_order!]
    const rawActive = row[colMap.is_active!]

    // id (optional). Empty string → null; otherwise must be valid uuid.
    let id: string | null = null
    if (rawId != null && String(rawId).trim() !== '') {
      const candidate = String(rawId).trim()
      if (!UUID_RE.test(candidate)) {
        errors.push({ rowNumber, message: `ID "${candidate}" is not a valid UUID.` })
      } else {
        id = candidate
      }
    }

    // name
    const name = rawName == null ? '' : String(rawName).trim()
    if (name === '') {
      errors.push({ rowNumber, message: 'Name is empty.' })
    } else {
      const key = name.toLowerCase()
      const prior = seenNames.get(key)
      if (prior != null) {
        errors.push({ rowNumber, message: `Name "${name}" duplicates row ${prior}.` })
      } else {
        seenNames.set(key, rowNumber)
      }
    }

    // hex
    const hex = normaliseHex(rawHex)
    if (!HEX_RE.test(hex)) {
      errors.push({ rowNumber, message: `Hex "${rawHex ?? ''}" is not a valid 6-digit hex value (expected like #1B3A6B).` })
    }

    // sort
    let sort = NaN
    if (rawSort != null && String(rawSort).trim() !== '') {
      const n = Number(rawSort)
      if (Number.isInteger(n)) sort = n
    }
    if (!Number.isInteger(sort)) {
      errors.push({ rowNumber, message: `Sort "${rawSort ?? ''}" is not a whole number.` })
    }

    // active
    const active = parseBoolean(rawActive)
    if (active == null) {
      errors.push({ rowNumber, message: `Active "${rawActive ?? ''}" is not a recognised boolean (expected TRUE / FALSE / 1 / 0 / yes / no).` })
    }

    // Even if some fields failed, build the row so we can reflect
    // it in the preview when validation is clean enough — but if
    // any field is invalid, we'll skip preview generation entirely.
    rows.push({
      rowNumber,
      id,
      name,
      hex_value: hex,
      sort_order: Number.isInteger(sort) ? sort : 0,
      is_active: active ?? false,
    })
  }

  if (rows.length === 0 && errors.length === 0) {
    errors.push({ rowNumber: 0, message: 'No data rows in spreadsheet (only the header row was found).' })
  }

  return { rows, errors }
}

// Compute insert / update / deactivate buckets for the preview UI.
// Updates carry per-field diffs; rows whose every field equals the
// current row are folded into unchangedCount.
function computeDiff(parsed: ParsedRow[], current: LetterpressCoreColour[]): Preview {
  const byId = new Map(current.map((c) => [c.id, c]))
  const byName = new Map(current.map((c) => [c.name.toLowerCase(), c]))

  const inserts: DiffEntry[] = []
  const updates: DiffEntry[] = []
  const keptIds = new Set<string>()
  let unchangedCount = 0

  for (const p of parsed) {
    // Resolve the existing row: prefer id, fall back to name lookup.
    let existing: LetterpressCoreColour | null = null
    if (p.id) existing = byId.get(p.id) ?? null
    if (!existing) existing = byName.get(p.name.toLowerCase()) ?? null

    if (!existing) {
      inserts.push({ parsed: p, current: null, changes: [] })
      continue
    }

    keptIds.add(existing.id)
    const changes: Array<{ field: string; old: string; next: string }> = []
    if (existing.name !== p.name) {
      changes.push({ field: 'Name', old: existing.name, next: p.name })
    }
    if (existing.hex_value.toLowerCase() !== p.hex_value.toLowerCase()) {
      changes.push({ field: 'Hex', old: existing.hex_value, next: p.hex_value })
    }
    if (existing.sort_order !== p.sort_order) {
      changes.push({ field: 'Sort', old: String(existing.sort_order), next: String(p.sort_order) })
    }
    if (existing.is_active !== p.is_active) {
      changes.push({
        field: 'Active',
        old: existing.is_active ? 'TRUE' : 'FALSE',
        next: p.is_active ? 'TRUE' : 'FALSE',
      })
    }
    if (changes.length === 0) {
      unchangedCount += 1
    } else {
      updates.push({ parsed: p, current: existing, changes })
    }
  }

  // Deactivations: any currently-active row whose id wasn't kept
  // by the import. (Inactive rows absent from the import stay
  // inactive without being counted, matching the server-side rule.)
  const deactivations = current.filter((c) => c.is_active && !keptIds.has(c.id))

  return { inserts, updates, deactivations, unchangedCount }
}

export default function CoreColoursImport({ current, onClose, onApplied }: Props) {
  const [file, setFile] = useState<File | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [parsed, setParsed] = useState<ParsedRow[] | null>(null)
  const [parseErrors, setParseErrors] = useState<RowError[]>([])
  const [preview, setPreview] = useState<Preview | null>(null)
  const [working, setWorking] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const [showInserts, setShowInserts] = useState(true)
  const [showUpdates, setShowUpdates] = useState(true)
  const [showDeactivations, setShowDeactivations] = useState(true)
  const inputRef = useRef<HTMLInputElement>(null)

  async function handleFile(f: File) {
    setFile(f)
    setParsed(null)
    setParseErrors([])
    setPreview(null)
    setServerError(null)
    setWorking(true)
    try {
      const buffer = await f.arrayBuffer()
      const { rows, errors } = parseWorkbook(buffer)
      setParsed(rows)
      setParseErrors(errors)
      if (errors.length === 0) {
        setPreview(computeDiff(rows, current))
      }
    } catch (e) {
      setParseErrors([{ rowNumber: 0, message: `Could not read file: ${(e as Error).message}` }])
    } finally {
      setWorking(false)
    }
  }

  async function handleApply() {
    if (!parsed || parseErrors.length > 0 || !preview) return
    setWorking(true)
    setServerError(null)
    try {
      const payload = parsed.map((p) => ({
        id: p.id,
        name: p.name,
        hex_value: p.hex_value.toLowerCase(),
        sort_order: p.sort_order,
        is_active: p.is_active,
      }))
      const { data, error } = await supabase.rpc('apply_core_colours_import', {
        rows: payload,
        source_filename: file?.name ?? null,
      })
      if (error) throw new Error(error.message)
      const summary = (data ?? { inserted: 0, updated: 0, deactivated: 0 }) as {
        inserted: number
        updated: number
        deactivated: number
      }
      onApplied(summary)
      onClose()
    } catch (e) {
      setServerError((e as Error).message)
    } finally {
      setWorking(false)
    }
  }

  const totalChanges =
    (preview?.inserts.length ?? 0) +
    (preview?.updates.length ?? 0) +
    (preview?.deactivations.length ?? 0)

  function resetPick() {
    setFile(null)
    setParsed(null)
    setParseErrors([])
    setPreview(null)
    setServerError(null)
    if (inputRef.current) inputRef.current.value = ''
  }

  return (
    <Modal
      open
      onClose={onClose}
      preventClose={working}
      ariaLabelledBy="core-colours-import-title"
      panelClassName="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl"
    >
      <div className="flex items-start justify-between gap-4 border-b border-gray-100 px-6 py-4">
        <div>
          <h3 id="core-colours-import-title" className="text-lg font-semibold text-gray-900">
            Import paper colours
          </h3>
          <p className="mt-0.5 text-xs text-gray-500">
            Upload an XLSX with the same columns as Export. Changes are previewed before any write.
          </p>
        </div>
        <button
          onClick={onClose}
          disabled={working}
          className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 disabled:opacity-50"
          aria-label="Close"
        >
          <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
            <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
          </svg>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {!file ? (
          <div
            onDragOver={(e) => { if (working) return; e.preventDefault(); setDragOver(true) }}
            onDragLeave={(e) => {
              const next = e.relatedTarget as Node | null
              if (next && e.currentTarget.contains(next)) return
              setDragOver(false)
            }}
            onDrop={(e) => {
              e.preventDefault()
              setDragOver(false)
              if (working) return
              const f = e.dataTransfer.files?.[0]
              if (f) handleFile(f)
            }}
            onClick={() => { if (working) return; inputRef.current?.click() }}
            aria-disabled={working || undefined}
            className={[
              'flex h-40 flex-col items-center justify-center rounded-2xl border-2 border-dashed text-sm text-gray-500 transition-colors',
              working ? 'cursor-not-allowed border-gray-200 bg-gray-50 opacity-70' : 'cursor-pointer hover:bg-gray-50',
              !working && (dragOver ? 'border-gray-900 bg-gray-50' : 'border-gray-300'),
            ].join(' ')}
          >
            {working ? 'Parsing…' : 'Drop a .xlsx here, or click to browse'}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-xs uppercase tracking-wider text-gray-400">{file.name}</p>
              <button
                onClick={resetPick}
                disabled={working}
                className="text-xs text-gray-500 underline-offset-2 hover:text-gray-900 hover:underline disabled:opacity-50"
              >
                Pick a different file
              </button>
            </div>

            {parseErrors.length > 0 && (
              <section>
                <h4 className="mb-2 text-sm font-semibold text-rose-700">
                  {parseErrors.length} validation error{parseErrors.length === 1 ? '' : 's'}
                </h4>
                <ul className="space-y-1 rounded-lg bg-rose-50 px-4 py-3 text-xs text-rose-700">
                  {parseErrors.map((e, i) => (
                    <li key={i}>
                      <span className="font-medium">
                        {e.rowNumber === 0 ? 'File' : `Row ${e.rowNumber}`}:
                      </span>{' '}
                      {e.message}
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-xs text-gray-500">
                  Fix the spreadsheet and re-upload. The preview is blocked until every row validates.
                </p>
              </section>
            )}

            {preview && parseErrors.length === 0 && (
              <PreviewView
                preview={preview}
                showInserts={showInserts}
                setShowInserts={setShowInserts}
                showUpdates={showUpdates}
                setShowUpdates={setShowUpdates}
                showDeactivations={showDeactivations}
                setShowDeactivations={setShowDeactivations}
              />
            )}

            {serverError && (
              <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">
                Apply failed: {serverError}
              </p>
            )}
          </div>
        )}
      </div>

      {file && (
        <div className="flex items-center justify-end gap-2 border-t border-gray-100 px-6 py-4">
          <button
            onClick={onClose}
            disabled={working}
            className="rounded-lg px-4 py-2 text-sm font-medium text-gray-500 hover:bg-gray-100 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleApply}
            disabled={working || parseErrors.length > 0 || !preview || totalChanges === 0}
            title={
              parseErrors.length > 0
                ? 'Fix validation errors before applying'
                : totalChanges === 0
                ? 'No changes detected — nothing to apply'
                : undefined
            }
            className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-700 disabled:opacity-50"
          >
            {working ? 'Applying…' : applyLabel(preview)}
          </button>
        </div>
      )}
    </Modal>
  )
}

function applyLabel(preview: Preview | null): string {
  if (!preview) return 'Apply'
  const total = preview.inserts.length + preview.updates.length + preview.deactivations.length
  if (total === 0) return 'No changes'
  const parts: string[] = []
  if (preview.inserts.length) parts.push(`${preview.inserts.length} new`)
  if (preview.updates.length) parts.push(`${preview.updates.length} update${preview.updates.length === 1 ? '' : 's'}`)
  if (preview.deactivations.length) parts.push(`${preview.deactivations.length} deactivation${preview.deactivations.length === 1 ? '' : 's'}`)
  return `Apply ${parts.join(', ')}`
}

function PreviewView({
  preview,
  showInserts,
  setShowInserts,
  showUpdates,
  setShowUpdates,
  showDeactivations,
  setShowDeactivations,
}: {
  preview: Preview
  showInserts: boolean
  setShowInserts: (v: boolean) => void
  showUpdates: boolean
  setShowUpdates: (v: boolean) => void
  showDeactivations: boolean
  setShowDeactivations: (v: boolean) => void
}) {
  const total = preview.inserts.length + preview.updates.length + preview.deactivations.length
  return (
    <div className="space-y-4">
      <div className="rounded-xl bg-gray-50 p-4 text-sm text-gray-700 ring-1 ring-gray-100">
        <p>
          <strong>{preview.inserts.length}</strong> new,{' '}
          <strong>{preview.updates.length}</strong> updated,{' '}
          <strong>{preview.deactivations.length}</strong> deactivated
          {preview.unchangedCount > 0 && (
            <>
              {' '}<span className="text-gray-500">({preview.unchangedCount} unchanged)</span>
            </>
          )}
          .
        </p>
        {total === 0 && (
          <p className="mt-1 text-xs text-gray-500">
            No changes detected. The spreadsheet matches the live catalogue.
          </p>
        )}
      </div>

      {preview.inserts.length > 0 && (
        <Section
          label={`New colours (${preview.inserts.length})`}
          open={showInserts}
          onToggle={() => setShowInserts(!showInserts)}
        >
          <div className="overflow-hidden rounded-lg ring-1 ring-gray-200">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50 text-left">
                  <th className="px-3 py-2 font-semibold text-gray-500">Swatch</th>
                  <th className="px-3 py-2 font-semibold text-gray-500">Name</th>
                  <th className="px-3 py-2 font-semibold text-gray-500">Hex</th>
                  <th className="px-3 py-2 font-semibold text-gray-500">Sort</th>
                  <th className="px-3 py-2 font-semibold text-gray-500">Active</th>
                </tr>
              </thead>
              <tbody>
                {preview.inserts.map((d) => (
                  <tr key={`${d.parsed.rowNumber}-${d.parsed.name}`} className="border-b border-gray-50 last:border-0">
                    <td className="px-3 py-2"><CoreColourSwatch hex={d.parsed.hex_value} size={20} ariaLabel={`${d.parsed.name} swatch`} /></td>
                    <td className="px-3 py-2 font-medium text-gray-900">{d.parsed.name}</td>
                    <td className="px-3 py-2 font-mono text-gray-700">{d.parsed.hex_value}</td>
                    <td className="px-3 py-2 tabular-nums text-gray-700">{d.parsed.sort_order}</td>
                    <td className="px-3 py-2 text-gray-700">{d.parsed.is_active ? 'TRUE' : 'FALSE'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {preview.updates.length > 0 && (
        <Section
          label={`Updates (${preview.updates.length})`}
          open={showUpdates}
          onToggle={() => setShowUpdates(!showUpdates)}
        >
          <div className="space-y-2">
            {preview.updates.map((d) => (
              <div
                key={d.current!.id}
                className="rounded-lg ring-1 ring-gray-200"
              >
                <div className="flex items-center gap-3 border-b border-gray-100 px-3 py-2">
                  <CoreColourSwatch hex={d.current!.hex_value} size={20} ariaLabel={`${d.current!.name} current swatch`} />
                  <span className="text-sm font-medium text-gray-900">{d.current!.name}</span>
                </div>
                <table className="w-full text-xs">
                  <thead className="sr-only">
                    <tr><th>Field</th><th>Old</th><th>New</th></tr>
                  </thead>
                  <tbody>
                    {d.changes.map((c, i) => (
                      <tr key={i} className="border-b border-gray-50 last:border-0">
                        <td className="px-3 py-1.5 text-gray-500">{c.field}</td>
                        <td className="px-3 py-1.5 font-mono text-gray-500 line-through">{c.old}</td>
                        <td className="px-3 py-1.5 font-mono font-medium text-gray-900">{c.next}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        </Section>
      )}

      {preview.deactivations.length > 0 && (
        <Section
          label={`Deactivations (${preview.deactivations.length})`}
          open={showDeactivations}
          onToggle={() => setShowDeactivations(!showDeactivations)}
        >
          <div className="overflow-hidden rounded-lg ring-1 ring-gray-200">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50 text-left">
                  <th className="px-3 py-2 font-semibold text-gray-500">Swatch</th>
                  <th className="px-3 py-2 font-semibold text-gray-500">Name</th>
                  <th className="px-3 py-2 font-semibold text-gray-500">Hex</th>
                </tr>
              </thead>
              <tbody>
                {preview.deactivations.map((c) => (
                  <tr key={c.id} className="border-b border-gray-50 last:border-0">
                    <td className="px-3 py-2"><CoreColourSwatch hex={c.hex_value} size={20} ariaLabel={`${c.name} swatch`} /></td>
                    <td className="px-3 py-2 text-gray-700">{c.name}</td>
                    <td className="px-3 py-2 font-mono text-gray-500">{c.hex_value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="px-3 py-2 text-xs text-gray-500">
              Deactivation is a soft-delete. Existing letterpress proofs that reference these colours keep rendering, and the rows can be restored from the table above.
            </p>
          </div>
        </Section>
      )}
    </div>
  )
}

function Section({
  label,
  open,
  onToggle,
  children,
}: {
  label: string
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <section>
      <button
        onClick={onToggle}
        className="flex items-center gap-2 text-sm font-semibold text-gray-900 hover:text-gray-700"
      >
        <span aria-hidden>{open ? '▾' : '▸'}</span>
        {label}
      </button>
      {open && <div className="mt-2">{children}</div>}
    </section>
  )
}
