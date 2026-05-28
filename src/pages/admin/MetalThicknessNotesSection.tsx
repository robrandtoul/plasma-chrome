import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { logAudit } from '../../lib/audit'
import { invalidatePublicSettings } from '../../lib/publicSettings'
import {
  DEFAULT_METAL_THICKNESS_NOTES,
  normaliseMetalThicknessNotes,
  type MetalThicknessNotes,
  type ThicknessOption,
} from '../../lib/metalThicknessNotes'

// Admin editor for the customer-facing metal "Thickness" card copy
// (migration 000199). Self-contained section — owns its own load + save
// against the singleton settings row, mirroring AdminTemplatesSection,
// because the value is one JSONB blob and doesn't fit AdminSettingsPage's
// per-scalar-field save flow.
//
// Two sets are edited: "Standard metals" (steel, gold, gun metal, copper,
// …, all at 300/500/800µm) and "Mini Steel" (200/300/500µm). The copy is
// shared across the metal family by design, so a single edit updates every
// metal proof of that family. Saved as a whole; the public_settings cache
// is invalidated so a customer preview picks the change up quickly.

const inputClass =
  'w-full rounded border border-line px-3 py-2 text-[17px] sm:text-sm focus:border-[var(--c-brand)] focus:bg-[var(--c-brand-50)] focus:outline-none'

export default function MetalThicknessNotesSection() {
  const [loaded, setLoaded] = useState<MetalThicknessNotes | null>(null)
  const [draft, setDraft] = useState<MetalThicknessNotes | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  useEffect(() => {
    void load()
  }, [])

  async function load() {
    const { data, error } = await supabase
      .from('settings')
      .select('metal_thickness_notes')
      .eq('id', 1)
      .single()
    if (error) {
      setLoadError(error.message)
      return
    }
    const notes = normaliseMetalThicknessNotes(data?.metal_thickness_notes)
    setLoaded(notes)
    setDraft(notes)
  }

  // Dirty when the draft diverges from what was loaded. Deep-equal via
  // JSON.stringify — the structure is tiny and only ever holds strings.
  const dirty = useMemo(
    () => draft != null && loaded != null && JSON.stringify(draft) !== JSON.stringify(loaded),
    [draft, loaded],
  )

  function patchIntro(intro: string) {
    setDraft((d) => (d ? { ...d, intro } : d))
    if (savedAt != null) setSavedAt(null)
  }

  function patchRow(
    setKey: 'standard' | 'mini_steel',
    index: number,
    field: keyof ThicknessOption,
    value: string,
  ) {
    setDraft((d) => {
      if (!d) return d
      const next = d[setKey].map((row, i) => (i === index ? { ...row, [field]: value } : row))
      return { ...d, [setKey]: next }
    })
    if (savedAt != null) setSavedAt(null)
  }

  function resetToDefaults() {
    setDraft(DEFAULT_METAL_THICKNESS_NOTES)
    if (savedAt != null) setSavedAt(null)
  }

  async function handleSave() {
    if (!draft || !dirty || saving) return
    setSaving(true)
    setSaveError(null)
    const { error } = await supabase
      .from('settings')
      .update({ metal_thickness_notes: draft, updated_at: new Date().toISOString() })
      .eq('id', 1)
    setSaving(false)
    if (error) {
      setSaveError(error.message)
      return
    }
    setLoaded(draft)
    setSavedAt(Date.now())
    invalidatePublicSettings()
    void logAudit({
      action: 'setting.metal_thickness_notes_updated',
      targetType: 'setting',
      targetLabel: 'Metal thickness notes',
    })
  }

  const recentlySaved = savedAt != null && Date.now() - savedAt < 2500

  return (
    <section className="rounded-2xl bg-surface p-6 shadow-sm ring-1 ring-line">
      <div className="mb-1 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-ink">Metal thickness notes</h3>
        <button
          type="button"
          onClick={resetToDefaults}
          className="text-xs font-medium text-ink-mute underline underline-offset-2 hover:text-ink"
        >
          Reset to defaults
        </button>
      </div>
      <p className="mb-5 text-sm text-ink-mute">
        The "Thickness" card shown on customer proof pages for metal cards. The copy is shared across all standard metals (steel, gold, gun metal, copper, etc.); Mini Steel has its own set. Changes apply to every metal proof.
      </p>

      {loadError && (
        <div className="mb-4 rounded-lg bg-out-soft px-3 py-2 text-sm text-out">
          Failed to load: {loadError}
        </div>
      )}

      {draft == null ? (
        !loadError && (
          <div className="flex justify-center py-10">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-line border-t-ink" />
          </div>
        )
      ) : (
        <div className="space-y-6">
          {/* Intro paragraph */}
          <div>
            <label className="mb-1.5 block text-sm font-medium text-ink">Intro line</label>
            <p className="mb-2 text-xs text-ink-mute">
              Sits above the thickness list, in the left column.
            </p>
            <textarea
              value={draft.intro}
              onChange={(e) => patchIntro(e.target.value)}
              rows={3}
              className={inputClass}
            />
          </div>

          <ThicknessSetEditor
            heading="Standard metals"
            subtitle="Steel, Gold, Gun Metal, Copper, Matte Black/White, Titanium — 300 / 500 / 800µm."
            rows={draft.standard}
            onChange={(i, field, value) => patchRow('standard', i, field, value)}
          />

          <ThicknessSetEditor
            heading="Mini Steel"
            subtitle="The smaller card — 200 / 300 / 500µm."
            rows={draft.mini_steel}
            onChange={(i, field, value) => patchRow('mini_steel', i, field, value)}
          />

          {saveError && (
            <div className="rounded-lg bg-out-soft px-3 py-2 text-sm text-out">
              Failed to save: {saveError}
            </div>
          )}

          <div className="flex items-center justify-end gap-3">
            {recentlySaved && !saving && <span className="text-xs text-in-stock">Saved</span>}
            {saving && <span className="text-xs text-ink-mute">Saving…</span>}
            <button
              type="button"
              onClick={handleSave}
              disabled={!dirty || saving}
              className="rounded bg-ink px-4 py-2 text-sm font-semibold text-on-ink hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Save thickness notes
            </button>
          </div>
        </div>
      )}
    </section>
  )
}

function ThicknessSetEditor({
  heading,
  subtitle,
  rows,
  onChange,
}: {
  heading: string
  subtitle: string
  rows: ThicknessOption[]
  onChange: (index: number, field: keyof ThicknessOption, value: string) => void
}) {
  return (
    <div className="rounded-xl border border-line-soft p-4">
      <div className="mb-3">
        <h4 className="text-sm font-semibold text-ink">{heading}</h4>
        <p className="text-xs text-ink-mute">{subtitle}</p>
      </div>
      <div className="space-y-4">
        {rows.map((row, i) => (
          <div key={i} className="grid gap-3 sm:grid-cols-[110px_1fr]">
            <div>
              <label className="mb-1 block text-xs font-medium text-ink-mute">Label</label>
              <input
                type="text"
                value={row.label}
                onChange={(e) => onChange(i, 'label', e.target.value)}
                className={inputClass}
              />
            </div>
            <div className="space-y-2">
              <div>
                <label className="mb-1 block text-xs font-medium text-ink-mute">Name</label>
                <input
                  type="text"
                  value={row.name}
                  onChange={(e) => onChange(i, 'name', e.target.value)}
                  className={inputClass}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-ink-mute">Description</label>
                <textarea
                  value={row.description}
                  onChange={(e) => onChange(i, 'description', e.target.value)}
                  rows={2}
                  className={inputClass}
                />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
