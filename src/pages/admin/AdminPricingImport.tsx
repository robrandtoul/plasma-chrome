import { useRef, useState } from 'react'
import Modal from '../../components/Modal'
import { commitPricingImport, previewPricingImport, type ImportPreview } from '../../lib/pricingIO'

interface Props {
  onClose: () => void
  onCommitted: () => void
  /** When set, rows for other materials become errors in the preview
   *  and add-on CSVs are rejected. Populated by the per-material
   *  Import button on AdminMaterialEditor; left null by the global
   *  import at /admin/pricing. */
  scope?: string | null
  /** Human-readable version of scope for the modal subtitle. */
  scopeLabel?: string | null
}

export default function AdminPricingImport({ onClose, onCommitted, scope, scopeLabel }: Props) {
  const [file, setFile] = useState<File | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showCreates, setShowCreates] = useState(false)
  const [showChanges, setShowChanges] = useState(false)
  const [showUnchanged, setShowUnchanged] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // Esc handling owned by Modal; preventClose wired to `working`
  // blocks Esc / backdrop dismissal during preview parsing or apply.

  async function handleFile(f: File) {
    setFile(f)
    setError(null)
    setPreview(null)
    setWorking(true)
    try {
      const p = await previewPricingImport(f, scope ?? null)
      setPreview(p)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setWorking(false)
    }
  }

  async function handleCommit() {
    if (!file) return
    setWorking(true)
    setError(null)
    try {
      const result = await commitPricingImport(file, scope ?? null)
      if (result.committed) {
        onCommitted()
        onClose()
      } else {
        setError(result.errors?.[0]?.message ?? 'Commit failed')
        setPreview(result)
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setWorking(false)
    }
  }

  const totalApplicable = (preview?.creates.length ?? 0) + (preview?.changes.length ?? 0)

  return (
    <Modal
      open
      onClose={onClose}
      preventClose={working}
      ariaLabelledBy="pricing-import-title"
      panelClassName="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-surface shadow-xl"
    >
          <div className="flex items-start justify-between gap-4 border-b border-line-soft px-6 py-4">
            <div>
              <h3 id="pricing-import-title" className="text-lg font-semibold text-ink">Import pricing</h3>
              {scopeLabel && (
                <p className="mt-0.5 text-xs text-ink-mute">Scoped to {scopeLabel}. Rows for other materials will be flagged as errors.</p>
              )}
            </div>
            <button
              onClick={onClose}
              disabled={working}
              className="rounded p-1.5 text-ink-dim hover:bg-canvas hover:text-ink-soft disabled:opacity-50"
              aria-label="Close"
            >
              <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
              </svg>
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-6 py-5">
            {!preview ? (
              <div>
                <p className="text-sm text-ink-mute">
                  Drag a CSV or ZIP here, or click to pick one. Imports update existing prices and create new quantity tiers. They never delete tiers. To remove a tier, use the pricing editor.
                </p>
                <div
                  onDragOver={(e) => { if (working) return; e.preventDefault(); setDragOver(true) }}
                  onDragLeave={(e) => {
                    // dragleave fires every time the cursor crosses an
                    // inner-element boundary, so a flat setDragOver(false)
                    // would flicker the dropzone border on every internal
                    // move. Only reset when the cursor is actually leaving
                    // the dropzone — relatedTarget is the element the
                    // cursor moved onto; if that's still inside our
                    // currentTarget, ignore.
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
                    'mt-4 flex h-40 flex-col items-center justify-center rounded-2xl border-2 border-dashed text-sm text-ink-mute transition-colors',
                    working
                      ? 'cursor-not-allowed border-line bg-canvas opacity-70'
                      : 'cursor-pointer hover:bg-canvas',
                    !working && (dragOver ? 'border-ink bg-canvas' : 'border-line'),
                  ].filter(Boolean).join(' ')}
                >
                  {working ? 'Parsing…' : 'Drop a .csv or .zip here, or click to browse'}
                </div>
                <input
                  ref={inputRef}
                  type="file"
                  accept=".csv,.zip"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f) handleFile(f)
                  }}
                />
                {error && (
                  <p className="mt-3 rounded-lg bg-out-soft px-3 py-2 text-xs text-out">{error}</p>
                )}
              </div>
            ) : (
              <PreviewView
                preview={preview}
                fileName={file?.name ?? ''}
                showCreates={showCreates}
                setShowCreates={setShowCreates}
                showChanges={showChanges}
                setShowChanges={setShowChanges}
                showUnchanged={showUnchanged}
                setShowUnchanged={setShowUnchanged}
                error={error}
              />
            )}
          </div>

          {/* Footer actions */}
          {preview && (
            <div className="flex items-center justify-between gap-3 border-t border-line-soft px-6 py-4">
              <button
                onClick={() => {
                  setFile(null)
                  setPreview(null)
                  setError(null)
                  // Reset the underlying <input>'s value so picking
                  // the same filename a second time still fires
                  // onChange. Browsers skip onChange when the value
                  // is unchanged, which silently no-op'd this path.
                  if (inputRef.current) inputRef.current.value = ''
                }}
                disabled={working}
                className="text-xs text-ink-mute underline-offset-2 hover:text-ink hover:underline disabled:opacity-50"
              >
                Pick a different file
              </button>
              <div className="flex gap-2">
                <button
                  onClick={onClose}
                  disabled={working}
                  className="rounded px-4 py-2 text-sm font-medium text-ink-mute hover:bg-canvas disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleCommit}
                  disabled={working || preview.errors.length > 0 || totalApplicable === 0}
                  className="rounded bg-ink px-4 py-2 text-sm font-semibold text-on-ink hover:opacity-90 disabled:opacity-50"
                >
                  {working
                    ? 'Applying…'
                    : commitButtonLabel(preview.creates.length, preview.changes.length)}
                </button>
              </div>
            </div>
          )}
    </Modal>
  )
}

function PreviewView({
  preview,
  fileName,
  showCreates,
  setShowCreates,
  showChanges,
  setShowChanges,
  showUnchanged,
  setShowUnchanged,
  error,
}: {
  preview: ImportPreview
  fileName: string
  showCreates: boolean
  setShowCreates: (v: boolean) => void
  showChanges: boolean
  setShowChanges: (v: boolean) => void
  showUnchanged: boolean
  setShowUnchanged: (v: boolean) => void
  error: string | null
}) {
  return (
    <div className="space-y-4">
      <div>
        <p className="text-xs uppercase tracking-wider text-ink-dim">{fileName}</p>
        <p className="mt-1 text-sm text-ink-soft">
          <strong>{preview.creates.length}</strong> new tier{preview.creates.length === 1 ? '' : 's'},
          {' '}<strong>{preview.changes.length}</strong> price{preview.changes.length === 1 ? '' : 's'} will change,
          {' '}<strong>{preview.unchanged.length}</strong> unchanged,
          {' '}<strong className={preview.errors.length > 0 ? 'text-out' : ''}>{preview.errors.length}</strong> error{preview.errors.length === 1 ? '' : 's'}.
        </p>
      </div>

      {error && <p className="rounded-lg bg-out-soft px-3 py-2 text-xs text-out">{error}</p>}

      {preview.errors.length > 0 && (
        <section>
          <h4 className="mb-2 text-sm font-semibold text-out">Errors</h4>
          <ul className="space-y-1 rounded-lg bg-out-soft px-4 py-3 text-xs text-out">
            {preview.errors.map((e, i) => (
              <li key={i}>
                <span className="font-medium">{e.file || fileName || 'CSV'}{e.row != null ? ` · Row ${e.row}` : ''}:</span> {e.message}
              </li>
            ))}
          </ul>
        </section>
      )}

      {preview.creates.length > 0 && (
        <section>
          <button
            onClick={() => setShowCreates(!showCreates)}
            className="flex items-center gap-2 text-sm font-semibold text-ink hover:text-ink-soft"
          >
            <span>{showCreates ? '▾' : '▸'}</span>
            New tiers ({preview.creates.length})
          </button>
          {showCreates && (
            <div className="mt-2 table-scroll rounded-lg ring-1 ring-line">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-line-soft bg-canvas text-left">
                    <th className="px-3 py-2 font-semibold text-ink-mute">Material</th>
                    <th className="px-3 py-2 font-semibold text-ink-mute">Variant</th>
                    <th className="px-3 py-2 font-semibold text-ink-mute">Qty</th>
                    <th className="px-3 py-2 font-semibold text-ink-mute">GBP</th>
                    <th className="px-3 py-2 font-semibold text-ink-mute">EUR</th>
                    <th className="px-3 py-2 font-semibold text-ink-mute">USD</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.creates.map((c, i) => (
                    <tr key={i} className="border-b border-line-soft last:border-0">
                      <td className="px-3 py-1.5 text-ink-soft">{c.material_slug}</td>
                      <td className="px-3 py-1.5 text-ink-soft">{c.variant_label}</td>
                      <td className="px-3 py-1.5 tabular-nums text-ink-soft">{c.quantity.toLocaleString()}</td>
                      <td className="px-3 py-1.5 tabular-nums font-medium text-ink">£{c.gbp}</td>
                      <td className="px-3 py-1.5 tabular-nums font-medium text-ink">€{c.eur}</td>
                      <td className="px-3 py-1.5 tabular-nums font-medium text-ink">${c.usd}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {preview.changes.length > 0 && (
        <section>
          <button
            onClick={() => setShowChanges(!showChanges)}
            className="flex items-center gap-2 text-sm font-semibold text-ink hover:text-ink-soft"
          >
            <span>{showChanges ? '▾' : '▸'}</span>
            Changes ({preview.changes.length})
          </button>
          {showChanges && (
            <div className="mt-2 table-scroll rounded-lg ring-1 ring-line">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-line-soft bg-canvas text-left">
                    <th className="px-3 py-2 font-semibold text-ink-mute">What</th>
                    <th className="px-3 py-2 font-semibold text-ink-mute">Old</th>
                    <th className="px-3 py-2 font-semibold text-ink-mute">New</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.changes.map((c, i) => (
                    <tr key={i} className="border-b border-line-soft last:border-0">
                      <td className="px-3 py-1.5 text-ink-soft">{c.description}</td>
                      <td className="px-3 py-1.5 tabular-nums text-ink-mute">{c.oldValue}</td>
                      <td className="px-3 py-1.5 tabular-nums font-medium text-ink">{c.newValue}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {preview.unchanged.length > 0 && (
        <section>
          <button
            onClick={() => setShowUnchanged(!showUnchanged)}
            className="flex items-center gap-2 text-sm font-medium text-ink-mute hover:text-ink-soft"
          >
            <span>{showUnchanged ? '▾' : '▸'}</span>
            Unchanged ({preview.unchanged.length})
          </button>
          {showUnchanged && (
            <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto rounded-lg bg-canvas px-3 py-2 text-xs text-ink-mute">
              {preview.unchanged.map((u, i) => <li key={i}>{u.description}</li>)}
            </ul>
          )}
        </section>
      )}
    </div>
  )
}

// Apply-button label. One of three shapes based on which buckets have
// entries — keeps the button compact when only one bucket is populated.
function commitButtonLabel(creates: number, changes: number): string {
  if (creates > 0 && changes > 0) {
    return `Apply ${creates} new, ${changes} change${changes === 1 ? '' : 's'}`
  }
  if (creates > 0) {
    return `Apply ${creates} new tier${creates === 1 ? '' : 's'}`
  }
  return `Apply ${changes} change${changes === 1 ? '' : 's'}`
}
