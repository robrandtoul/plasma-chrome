// Finish photos (migration 000299) — a studio photo per finish per material,
// shown on the pay page's open-spec finish chooser so the customer sees the
// real surface (brushed vs mirror) rather than a flat artwork render.
//
// Self-contained section for AdminMaterialContentModal: loads the material's
// material_options rows and renders one photo control per finish; renders
// nothing at all for materials with no option dimension. Storage reuses the
// public `material-icons` bucket (admin-gated write policies already exist)
// under a `finish-photos/` prefix, following the icon-upload pattern exactly:
// upsert by stable path → clean stale extension → getPublicUrl + cache-bust →
// write material_options.photo_url (staff-write RLS) → audit.

import { useEffect, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { logAudit } from '../../lib/audit'

interface OptionRow {
  id: string
  code: string
  display_name: string
  is_base: boolean
  photo_url: string | null
  // Customer-facing education line on the pay-page finish card (000303).
  description: string | null
}

const ACCEPTED = ['image/png', 'image/jpeg']
const MAX_SIZE = 5 * 1024 * 1024

function pathFromPublicUrl(url: string | null): string | null {
  if (!url) return null
  const match = url.match(/\/storage\/v1\/object\/public\/material-icons\/(.+?)(\?.*)?$/)
  return match?.[1] ?? null
}

export default function AdminFinishPhotosSection({ materialId, materialLabel }: {
  materialId: string
  materialLabel: string
}) {
  const [options, setOptions] = useState<OptionRow[]>([])
  // Singular dimension noun from materials.option_label ("Finish", "Species").
  const [optionLabel, setOptionLabel] = useState('Finish')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // Which option the hidden file input is currently picking for.
  const pickingForRef = useRef<OptionRow | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [optsRes, matRes] = await Promise.all([
        supabase
          .from('material_options')
          .select('id, code, display_name, is_base, photo_url, description')
          .eq('material_id', materialId)
          .order('sort_order'),
        supabase.from('materials').select('option_label').eq('id', materialId).maybeSingle(),
      ])
      if (cancelled) return
      setOptions(
        (optsRes.data ?? []).map((o) => ({
          id: o.id as string,
          code: o.code as string,
          display_name: (o.display_name as string) ?? 'Option',
          is_base: !!o.is_base,
          photo_url: (o.photo_url as string | null) ?? null,
          description: (o.description as string | null) ?? null,
        })),
      )
      if (matRes.data?.option_label) setOptionLabel(matRes.data.option_label as string)
    })()
    return () => { cancelled = true }
  }, [materialId])

  async function handleFile(option: OptionRow, file: File) {
    if (!ACCEPTED.includes(file.type)) { setError('Use a PNG or JPG photo.'); return }
    if (file.size > MAX_SIZE) { setError('Photos must be 5 MB or less.'); return }
    setError(null)
    setBusyId(option.id)

    const ext = file.type === 'image/jpeg' ? 'jpg' : 'png'
    // Keyed on the option id: stable per finish-per-material, survives renames.
    const path = `finish-photos/${option.id}.${ext}`
    const { error: upErr } = await supabase.storage
      .from('material-icons')
      .upload(path, file, { upsert: true, contentType: file.type })
    if (upErr) {
      setBusyId(null)
      setError(`Upload failed: ${upErr.message}`)
      return
    }
    // Clean a stale file at the other extension (old PNG when a JPG lands).
    const priorPath = pathFromPublicUrl(option.photo_url)
    if (priorPath && priorPath !== path) {
      await supabase.storage.from('material-icons').remove([priorPath])
    }
    const { data: pub } = supabase.storage.from('material-icons').getPublicUrl(path)
    const url = `${pub.publicUrl}?v=${Date.now()}`

    const { error: updErr } = await supabase
      .from('material_options')
      .update({ photo_url: url })
      .eq('id', option.id)
    setBusyId(null)
    if (updErr) {
      setError(`Failed to save the photo: ${updErr.message}`)
      return
    }
    setOptions((prev) => prev.map((o) => (o.id === option.id ? { ...o, photo_url: url } : o)))
    void logAudit({
      action: 'material.finish_photo_uploaded',
      targetType: 'material_option',
      targetId: option.id,
      targetLabel: `${materialLabel} — ${option.display_name}`,
      metadata: { filename: file.name, size_kb: Math.round(file.size / 1024), path },
    })
  }

  // Saved on blur: a description edit is one field, not a form — the same
  // quiet-save shape the photo actions use. Empty string clears to null so
  // cards without copy simply omit the line.
  async function handleDescriptionBlur(option: OptionRow, raw: string) {
    const next = raw.trim() === '' ? null : raw.trim()
    if (next === option.description) return
    setError(null)
    const { error: err } = await supabase
      .from('material_options')
      .update({ description: next })
      .eq('id', option.id)
    if (err) { setError(`Failed to save the description: ${err.message}`); return }
    setOptions((prev) => prev.map((o) => (o.id === option.id ? { ...o, description: next } : o)))
    void logAudit({
      action: 'material.finish_description_updated',
      targetType: 'material_option',
      targetId: option.id,
      targetLabel: `${materialLabel} — ${option.display_name}`,
      metadata: { description: next },
    })
  }

  async function handleRemove(option: OptionRow) {
    if (!option.photo_url) return
    setBusyId(option.id)
    setError(null)
    const priorPath = pathFromPublicUrl(option.photo_url)
    if (priorPath) {
      await supabase.storage.from('material-icons').remove([priorPath])
    }
    const { error: err } = await supabase
      .from('material_options')
      .update({ photo_url: null })
      .eq('id', option.id)
    setBusyId(null)
    if (err) { setError(`Failed to remove the photo: ${err.message}`); return }
    setOptions((prev) => prev.map((o) => (o.id === option.id ? { ...o, photo_url: null } : o)))
    void logAudit({
      action: 'material.finish_photo_removed',
      targetType: 'material_option',
      targetId: option.id,
      targetLabel: `${materialLabel} — ${option.display_name}`,
      metadata: { previous_url: option.photo_url },
    })
  }

  // Materials without an option dimension get no section at all.
  if (options.length === 0) return null

  const noun = optionLabel.toLowerCase()

  return (
    <section>
      <label className="mb-1.5 block text-sm font-medium text-ink-soft">{optionLabel} photos</label>
      <div className="space-y-2">
        {options.map((o) => (
          <div key={o.id} className="rounded-lg bg-canvas px-4 py-3 ring-1 ring-line">
            <div className="flex items-center gap-4">
              {o.photo_url ? (
                <img
                  src={o.photo_url}
                  alt={`${o.display_name} ${noun} photo`}
                  className="h-14 w-20 shrink-0 rounded-md object-cover ring-1 ring-line"
                />
              ) : (
                <div className="flex h-14 w-20 shrink-0 items-center justify-center rounded-md bg-surface text-[11px] text-ink-dim ring-1 ring-line">
                  No photo
                </div>
              )}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-ink">{o.display_name}</p>
                <p className="text-[12px] text-ink-mute">{o.is_base ? `Base ${noun}` : `Surcharged ${noun}`}</p>
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  type="button"
                  disabled={busyId === o.id}
                  onClick={() => { pickingForRef.current = o; fileInputRef.current?.click() }}
                  className="rounded px-3 py-1.5 text-sm font-medium text-ink-soft ring-1 ring-line hover:bg-surface disabled:opacity-50"
                >
                  {busyId === o.id ? 'Saving…' : o.photo_url ? 'Replace' : 'Upload'}
                </button>
                {o.photo_url && (
                  <button
                    type="button"
                    disabled={busyId === o.id}
                    onClick={() => void handleRemove(o)}
                    className="rounded px-3 py-1.5 text-sm font-medium text-out ring-1 ring-out hover:bg-out-soft disabled:opacity-50"
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>
            {/* Customer-facing description (000303) — shown under the name on
                the pay-page finish card. Saves quietly on blur. */}
            <textarea
              aria-label={`${o.display_name} customer description`}
              defaultValue={o.description ?? ''}
              onBlur={(e) => void handleDescriptionBlur(o, e.target.value)}
              rows={2}
              placeholder={`Customer-facing line about the ${o.display_name.toLowerCase()} ${noun} (optional)`}
              className="mt-2 w-full rounded border border-line bg-surface px-3 py-2 text-[17px] sm:text-sm focus:border-[var(--c-brand)] focus:bg-[var(--c-brand-50)] focus:outline-none"
            />
          </div>
        ))}
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          const target = pickingForRef.current
          e.target.value = ''
          if (f && target) void handleFile(target, f)
        }}
      />
      {error && <p className="mt-1.5 text-sm text-out">{error}</p>}
      <p className="mt-1.5 text-xs text-ink-mute">
        Shown on the order page when the customer picks their {noun} at checkout. PNG or JPG, up to 5 MB — landscape photos of the actual surface work best. Without a photo, the customer sees their own artwork from that {noun}&rsquo;s proof tab instead. The description appears under the {noun}&rsquo;s name on its card — useful where a photo can&rsquo;t tell the story (e.g. gloss vs matte).
      </p>
    </section>
  )
}
