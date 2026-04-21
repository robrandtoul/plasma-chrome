import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { logAudit } from '../../lib/audit'

// ── Types ────────────────────────────────────────────────────────────────────

export interface MaterialContent {
  id: string
  code: string
  display_name: string
  description: string | null
  icon_url: string | null
  is_published: boolean
}

const ACCEPTED = ['image/png', 'image/jpeg', 'image/svg+xml']
const MAX_SIZE = 2 * 1024 * 1024

// Pull the "foo.png" tail out of a Supabase public URL so we can delete
// the file when the icon is replaced or removed.
function pathFromPublicUrl(url: string | null): string | null {
  if (!url) return null
  const match = url.match(/\/storage\/v1\/object\/public\/material-icons\/(.+)$/)
  return match?.[1] ?? null
}

function extFromFile(file: File): string {
  if (file.type === 'image/svg+xml') return 'svg'
  if (file.type === 'image/jpeg') return 'jpg'
  return 'png'
}

// ── Component ────────────────────────────────────────────────────────────────

export default function AdminMaterialContentModal({ material, onClose, onSaved }: {
  material: MaterialContent
  onClose: () => void
  onSaved: (updated: MaterialContent) => void
}) {
  const [draftName, setDraftName] = useState(material.display_name)
  const [draftDesc, setDraftDesc] = useState(material.description ?? '')
  const [currentIconUrl, setCurrentIconUrl] = useState(material.icon_url)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [nameError, setNameError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape' && !saving) onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, saving])

  async function saveName() {
    const trimmed = draftName.trim()
    if (trimmed === material.display_name) { setNameError(null); return }
    if (trimmed === '') {
      setNameError('Name is required.')
      setDraftName(material.display_name)
      return
    }

    // Client-side duplicate check (case-insensitive). The DB unique
    // index is the source of truth; this just gives a friendlier error
    // before we issue the UPDATE.
    const { data: dupes } = await supabase
      .from('materials')
      .select('id')
      .ilike('display_name', trimmed)
      .neq('id', material.id)
      .limit(1)
    if (dupes && dupes.length > 0) {
      setNameError('A material with this name already exists.')
      setDraftName(material.display_name)
      return
    }

    setSaving(true)
    setNameError(null)
    const prev = material.display_name
    const { error: err } = await supabase
      .from('materials')
      .update({ display_name: trimmed })
      .eq('id', material.id)
    setSaving(false)
    if (err) {
      // Unique-index violation from the DB (race condition).
      if (err.code === '23505') {
        setNameError('A material with this name already exists.')
      } else {
        setNameError(`Failed to rename: ${err.message}`)
      }
      setDraftName(prev)
      return
    }
    setSavedAt(Date.now())
    material.display_name = trimmed
    onSaved({ ...material })
    void logAudit({
      action: 'material.name_updated',
      targetType: 'material',
      targetId: material.id,
      targetLabel: trimmed,
      beforeValue: { display_name: prev },
      afterValue: { display_name: trimmed },
    })
  }

  async function saveDescription() {
    const trimmed = draftDesc.trim() === '' ? null : draftDesc
    if (trimmed === material.description) return
    setSaving(true)
    setError(null)
    const prev = material.description
    const { error: err } = await supabase
      .from('materials')
      .update({ description: trimmed })
      .eq('id', material.id)
    setSaving(false)
    if (err) {
      setError(`Failed to save description: ${err.message}`)
      setDraftDesc(prev ?? '')
      return
    }
    setSavedAt(Date.now())
    material.description = trimmed
    onSaved({ ...material })
    void logAudit({
      action: 'material.description_updated',
      targetType: 'material',
      targetId: material.id,
      targetLabel: material.display_name,
      beforeValue: { description: prev },
      afterValue: { description: trimmed },
    })
  }

  async function handleFile(file: File) {
    if (!ACCEPTED.includes(file.type)) { setError('Use PNG, JPG, or SVG.'); return }
    if (file.size > MAX_SIZE) { setError('Icon must be 2 MB or less.'); return }
    setError(null)
    setSaving(true)

    const ext = extFromFile(file)
    const path = `${material.code}.${ext}`

    // Upload (upsert so the same slug always overwrites).
    const { error: upErr } = await supabase.storage
      .from('material-icons')
      .upload(path, file, { upsert: true, contentType: file.type })
    if (upErr) {
      setSaving(false)
      setError(`Upload failed: ${upErr.message}`)
      return
    }

    // Clean up any stale icon at a different extension (e.g. old PNG
    // when we just uploaded a JPG). Cheap and only the extension pool
    // to scan.
    const priorPath = pathFromPublicUrl(currentIconUrl)
    if (priorPath && priorPath !== path) {
      await supabase.storage.from('material-icons').remove([priorPath])
    }

    const { data: pub } = supabase.storage.from('material-icons').getPublicUrl(path)
    // Cache-bust so the browser picks up the new file straight away.
    const url = `${pub.publicUrl}?v=${Date.now()}`

    const { error: updErr } = await supabase
      .from('materials')
      .update({ icon_url: url })
      .eq('id', material.id)
    setSaving(false)
    if (updErr) {
      setError(`Failed to save icon URL: ${updErr.message}`)
      return
    }
    setCurrentIconUrl(url)
    material.icon_url = url
    onSaved({ ...material })
    setSavedAt(Date.now())
    void logAudit({
      action: 'material.icon_uploaded',
      targetType: 'material',
      targetId: material.id,
      targetLabel: material.display_name,
      metadata: { filename: file.name, size_kb: Math.round(file.size / 1024), path },
    })
  }

  async function handleRemoveIcon() {
    if (!currentIconUrl) return
    setSaving(true)
    setError(null)
    const priorPath = pathFromPublicUrl(currentIconUrl)
    const prevUrl = currentIconUrl
    if (priorPath) {
      await supabase.storage.from('material-icons').remove([priorPath])
    }
    const { error: err } = await supabase
      .from('materials')
      .update({ icon_url: null })
      .eq('id', material.id)
    setSaving(false)
    if (err) { setError(`Failed to clear icon: ${err.message}`); return }
    setCurrentIconUrl(null)
    material.icon_url = null
    onSaved({ ...material })
    setSavedAt(Date.now())
    void logAudit({
      action: 'material.icon_removed',
      targetType: 'material',
      targetId: material.id,
      targetLabel: material.display_name,
      metadata: { previous_url: prevUrl },
    })
  }

  const recentlySaved = savedAt != null && Date.now() - savedAt < 2000

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/50" onClick={() => !saving && onClose()} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl">
          {/* Header */}
          <div className="flex items-start justify-between border-b border-gray-100 px-6 py-4">
            <div>
              <h3 className="text-lg font-semibold text-gray-900">{draftName.trim() || material.display_name}</h3>
              <Link
                to={`/admin/pricing/materials/${material.code}`}
                className="text-xs text-gray-500 hover:text-gray-900 hover:underline"
              >
                Open pricing editor →
              </Link>
            </div>
            <div className="flex items-center gap-3">
              {saving && <span className="text-xs text-gray-400">Saving…</span>}
              {recentlySaved && !saving && <span className="text-xs text-emerald-600">Saved</span>}
              <button
                onClick={onClose}
                className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                aria-label="Close"
              >
                <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                  <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
                </svg>
              </button>
            </div>
          </div>

          {/* Body */}
          <div className="space-y-6 overflow-y-auto px-6 py-5">
            {/* Name */}
            <section>
              <label className="mb-1.5 block text-sm font-medium text-gray-700">
                Material name <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                value={draftName}
                onChange={(e) => { setDraftName(e.target.value); if (nameError) setNameError(null) }}
                onBlur={saveName}
                className={[
                  'w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-1',
                  nameError
                    ? 'border-rose-300 focus:border-rose-500 focus:ring-rose-300'
                    : 'border-gray-300 focus:border-gray-900 focus:ring-gray-900',
                ].join(' ')}
              />
              <p className="mt-1.5 text-xs text-gray-500">
                This is what customers and designers see. The internal identifier (slug) won't change.
              </p>
              {nameError && (
                <p className="mt-1.5 text-xs font-medium text-rose-500">{nameError}</p>
              )}
            </section>

            {/* Description */}
            <section>
              <label className="mb-1.5 block text-sm font-medium text-gray-700">Description</label>
              <textarea
                value={draftDesc}
                onChange={(e) => setDraftDesc(e.target.value)}
                onBlur={saveDescription}
                rows={6}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900"
                placeholder="e.g. Steel cards are 0.5mm thick and laser-cut to…"
              />
              <p className="mt-1.5 text-xs text-gray-500">
                Displayed on the customer-facing proof page for any proof using this material. Paragraph breaks render as spacing.
              </p>
            </section>

            {/* Icon */}
            <section>
              <label className="mb-1.5 block text-sm font-medium text-gray-700">Icon</label>
              <div
                onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault()
                  setDragOver(false)
                  const f = e.dataTransfer.files?.[0]
                  if (f) void handleFile(f)
                }}
                className={[
                  'flex min-h-[10rem] items-center justify-center gap-6 rounded-2xl border-2 border-dashed p-4 transition-colors',
                  dragOver ? 'border-gray-900 bg-gray-50' : 'border-gray-300',
                ].join(' ')}
              >
                {currentIconUrl ? (
                  <img src={currentIconUrl} alt="Icon preview" className="max-h-32 max-w-[12rem] object-contain" />
                ) : (
                  <p className="text-sm text-gray-400">No icon set</p>
                )}
                <div className="flex flex-col gap-2">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/svg+xml"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0]
                      if (f) void handleFile(f)
                    }}
                  />
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={saving}
                    className="rounded-lg bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
                  >
                    {currentIconUrl ? 'Replace icon' : 'Upload icon'}
                  </button>
                  {currentIconUrl && (
                    <button
                      onClick={handleRemoveIcon}
                      disabled={saving}
                      className="rounded-lg px-3 py-1.5 text-sm font-medium text-rose-600 ring-1 ring-rose-200 hover:bg-rose-50 disabled:opacity-50"
                    >
                      Remove icon
                    </button>
                  )}
                </div>
              </div>
              <p className="mt-1.5 text-xs text-gray-500">
                PNG, JPG or SVG, up to 2 MB. Square or roughly square, at least 480px wide works best. Transparent backgrounds render cleanly.
              </p>
            </section>

            {error && (
              <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>
            )}
          </div>

          {/* Footer */}
          <div className="flex justify-end border-t border-gray-100 px-6 py-4">
            <button
              onClick={onClose}
              className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-700"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
