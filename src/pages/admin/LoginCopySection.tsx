import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { logAudit } from '../../lib/audit'
import { invalidatePublicSettings } from '../../lib/publicSettings'
import {
  LOGIN_HEADLINE_DEFAULT,
  LOGIN_DESCRIPTION_DEFAULT,
  LOGIN_STATS_DEFAULT,
  LOGIN_FORM_HEADING_DEFAULT,
  LOGIN_FORM_SUBCOPY_DEFAULT,
  normaliseLoginStats,
  type LoginStat,
} from '../../lib/loginCopy'

// Admin editor for the login page's copy (migration 000206). Self-
// contained — owns its own load + save against the singleton settings
// row, mirroring MetalThicknessNotesSection, because it edits a mix of
// prose fields plus the three stat blocks and saves them as one unit.
// The login page reads the same values via the public_settings() RPC.

interface LoginCopy {
  headline: string
  description: string
  stats: LoginStat[]
  formHeading: string
  formSubcopy: string
}

const DEFAULTS: LoginCopy = {
  headline: LOGIN_HEADLINE_DEFAULT,
  description: LOGIN_DESCRIPTION_DEFAULT,
  stats: LOGIN_STATS_DEFAULT,
  formHeading: LOGIN_FORM_HEADING_DEFAULT,
  formSubcopy: LOGIN_FORM_SUBCOPY_DEFAULT,
}

const inputClass =
  'w-full rounded border border-line px-3 py-2 text-[17px] sm:text-sm focus:border-[var(--c-brand)] focus:bg-[var(--c-brand-50)] focus:outline-none'

export default function LoginCopySection() {
  const [loaded, setLoaded] = useState<LoginCopy | null>(null)
  const [draft, setDraft] = useState<LoginCopy | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  useEffect(() => { void load() }, [])

  async function load() {
    const { data, error } = await supabase
      .from('settings')
      .select('login_headline, login_description, login_stats, login_form_heading, login_form_subcopy')
      .eq('id', 1)
      .single()
    if (error) { setLoadError(error.message); return }
    const value: LoginCopy = {
      headline: (data?.login_headline as string) || DEFAULTS.headline,
      description: (data?.login_description as string) || DEFAULTS.description,
      stats: normaliseLoginStats(data?.login_stats),
      formHeading: (data?.login_form_heading as string) || DEFAULTS.formHeading,
      formSubcopy: (data?.login_form_subcopy as string) || DEFAULTS.formSubcopy,
    }
    setLoaded(value)
    setDraft(value)
  }

  const dirty = useMemo(
    () => draft != null && loaded != null && JSON.stringify(draft) !== JSON.stringify(loaded),
    [draft, loaded],
  )

  function patch(p: Partial<LoginCopy>) {
    setDraft((d) => (d ? { ...d, ...p } : d))
    if (savedAt != null) setSavedAt(null)
  }
  function patchStat(index: number, field: keyof LoginStat, value: string) {
    setDraft((d) => {
      if (!d) return d
      const stats = d.stats.map((s, i) => (i === index ? { ...s, [field]: value } : s))
      return { ...d, stats }
    })
    if (savedAt != null) setSavedAt(null)
  }
  function resetToDefaults() {
    setDraft(DEFAULTS)
    if (savedAt != null) setSavedAt(null)
  }

  async function handleSave() {
    if (!draft || !dirty || saving) return
    setSaving(true)
    setSaveError(null)
    const { error } = await supabase
      .from('settings')
      .update({
        login_headline: draft.headline,
        login_description: draft.description,
        login_stats: draft.stats,
        login_form_heading: draft.formHeading,
        login_form_subcopy: draft.formSubcopy,
        updated_at: new Date().toISOString(),
      })
      .eq('id', 1)
    setSaving(false)
    if (error) { setSaveError(error.message); return }
    setLoaded(draft)
    setSavedAt(Date.now())
    invalidatePublicSettings()
    void logAudit({
      action: 'setting.login_copy_updated',
      targetType: 'setting',
      targetLabel: 'Login page copy',
    })
  }

  const recentlySaved = savedAt != null && Date.now() - savedAt < 2500

  return (
    <section className="rounded-2xl bg-surface p-6 shadow-sm ring-1 ring-line">
      <div className="mb-1 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-ink">Login page</h3>
        <button
          type="button"
          onClick={resetToDefaults}
          className="text-xs font-medium text-ink-mute underline underline-offset-2 hover:text-ink"
        >
          Reset to defaults
        </button>
      </div>
      <p className="mb-5 text-sm text-ink-mute">
        The copy on the designer sign-in page. The headline keeps line breaks. The three stats are decorative figures shown on the brand panel.
      </p>

      {loadError && (
        <div className="mb-4 rounded-lg bg-out-soft px-3 py-2 text-sm text-out">Failed to load: {loadError}</div>
      )}

      {draft == null ? (
        !loadError && (
          <div className="flex justify-center py-10">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-line border-t-ink" />
          </div>
        )
      ) : (
        <div className="space-y-6">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-ink">Headline</label>
            <p className="mb-2 text-xs text-ink-mute">Big marketing headline on the brand panel. Line breaks are kept.</p>
            <textarea value={draft.headline} onChange={(e) => patch({ headline: e.target.value })} rows={3} className={inputClass} />
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-ink">Description</label>
            <textarea value={draft.description} onChange={(e) => patch({ description: e.target.value })} rows={3} className={inputClass} />
          </div>

          <div className="rounded-xl border border-line-soft p-4">
            <div className="mb-3">
              <h4 className="text-sm font-semibold text-ink">Stats</h4>
              <p className="text-xs text-ink-mute">Three figures shown on the brand panel (e.g. "142" / "proofs sent this year").</p>
            </div>
            <div className="space-y-3">
              {draft.stats.map((s, i) => (
                <div key={i} className="grid gap-3 sm:grid-cols-[120px_1fr]">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-ink-mute">Value</label>
                    <input type="text" value={s.value} onChange={(e) => patchStat(i, 'value', e.target.value)} className={inputClass} />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-ink-mute">Label</label>
                    <input type="text" value={s.label} onChange={(e) => patchStat(i, 'label', e.target.value)} className={inputClass} />
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-ink">Sign-in heading</label>
            <input type="text" value={draft.formHeading} onChange={(e) => patch({ formHeading: e.target.value })} className={inputClass} />
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-ink">Sign-in note</label>
            <p className="mb-2 text-xs text-ink-mute">Small paragraph under the sign-in heading.</p>
            <textarea value={draft.formSubcopy} onChange={(e) => patch({ formSubcopy: e.target.value })} rows={3} className={inputClass} />
          </div>

          {saveError && (
            <div className="rounded-lg bg-out-soft px-3 py-2 text-sm text-out">Failed to save: {saveError}</div>
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
              Save login copy
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
