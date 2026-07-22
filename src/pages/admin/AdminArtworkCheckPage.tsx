import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { logAudit } from '../../lib/audit'
import { FieldRow, RadioGroup, Toggle, inputClass } from './settingsControls'

// /admin/artwork-check — the home for the pre-print artwork sanity check
// (migration 000336+). Moved out of Admin → Settings once the feature grew
// beyond a single toggle: mode, the mandatory-run gate, and the model picker.
// All three are columns on the singleton proofs.settings row, read/written
// directly here (audited), and take effect on the next check with no redeploy.

type Mode = 'off' | 'shadow' | 'live'

interface ArtworkSettings {
  artwork_check_mode: Mode
  artwork_check_required: boolean
  artwork_check_model: string | null
}

// The default the edge function falls back to when no model is set — and the
// model the check was tuned + validated on. Kept in lockstep with
// DEFAULT_MODEL in _shared/artworkCheck/anthropic.ts.
const DEFAULT_MODEL = 'claude-opus-4-8'

// Curated so a typo can't reach the function. A demanding multimodal
// reasoning task, so only the capable tiers are offered; Opus 4.8 is the
// validated recommendation, the others are available to trial.
const MODEL_OPTIONS: { value: string; label: string }[] = [
  { value: 'claude-opus-4-8', label: 'Opus 4.8 — most capable (recommended; the check was tuned on this)' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5 — faster and cheaper (re-check accuracy before relying on it)' },
  { value: 'claude-fable-5', label: 'Fable 5 — newest flagship (re-check accuracy before relying on it)' },
]

export default function AdminArtworkCheckPage() {
  const [settings, setSettings] = useState<ArtworkSettings | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<Partial<Record<keyof ArtworkSettings, number>>>({})
  const [working, setWorking] = useState<Partial<Record<keyof ArtworkSettings, boolean>>>({})
  const [errors, setErrors] = useState<Partial<Record<keyof ArtworkSettings, string>>>({})

  useEffect(() => {
    void supabase
      .from('settings')
      .select('artwork_check_mode, artwork_check_required, artwork_check_model')
      .eq('id', 1)
      .single()
      .then(({ data, error }) => {
        if (error || !data) { setLoadError(error?.message ?? 'Settings row missing'); return }
        setSettings(data as ArtworkSettings)
      })
  }, [])

  async function save<K extends keyof ArtworkSettings>(field: K, value: ArtworkSettings[K]) {
    if (!settings || settings[field] === value) return
    const prev = settings[field]
    setWorking((w) => ({ ...w, [field]: true }))
    setErrors((e) => ({ ...e, [field]: undefined }))
    setSettings((s) => (s ? { ...s, [field]: value } : s))
    const { error } = await supabase.from('settings').update({ [field]: value, updated_at: new Date().toISOString() }).eq('id', 1)
    setWorking((w) => ({ ...w, [field]: false }))
    if (error) {
      setSettings((s) => (s ? { ...s, [field]: prev } : s))
      setErrors((e) => ({ ...e, [field]: error.message }))
      return
    }
    setSavedAt((s) => ({ ...s, [field]: Date.now() }))
    void logAudit({
      action: `setting.${field}_updated`,
      targetType: 'setting',
      targetId: field,
      targetLabel: field,
      beforeValue: { [field]: prev },
      afterValue: { [field]: value },
    })
  }

  // Turning the mandatory-run gate on blocks placing orders until each order's
  // check has run — it auto-runs when the review page opens, so in practice it
  // adds no clicks, but blocking placement deserves a confirm.
  async function changeRequired(v: boolean) {
    if (v) {
      const ok = window.confirm(
        'Require the artwork check before placing orders?\n\nAn order can’t be sent to the workshop or a supplier until the check has run for it. The check runs automatically when the review page opens, so this normally adds no extra clicks — and a flagged result never blocks; only running the check is required.',
      )
      if (!ok) return
    }
    await save('artwork_check_required', v)
  }

  const recentlySaved = (f: keyof ArtworkSettings) => !!savedAt[f] && Date.now() - (savedAt[f] ?? 0) < 4000

  const CARD = 'rounded-2xl bg-surface p-6 shadow-sm ring-1 ring-line'

  if (loadError) return <p className="text-sm text-out">Couldn’t load settings: {loadError}</p>
  if (!settings) return <p className="text-sm text-ink-mute">Loading…</p>

  // The current model as a select value: null (unset) shows as the default;
  // a value set by SQL outside the curated list is preserved as an extra option.
  const currentModel = settings.artwork_check_model || DEFAULT_MODEL
  const modelOptions = MODEL_OPTIONS.some((o) => o.value === currentModel)
    ? MODEL_OPTIONS
    : [...MODEL_OPTIONS, { value: currentModel, label: `${currentModel} (set manually)` }]

  return (
    <div className="mx-auto max-w-[760px]">
      <h1 className="text-xl font-semibold text-ink">Artwork check</h1>
      <p className="mt-1 text-sm text-ink-soft">
        Before an order is placed, an AI check compares what the customer supplied (the Help Scout
        thread, any QR contents, and readable attachments) against the actual Dropbox print files
        and the approved proof, and shows a supplied-vs-printed report on the Place order screen.
        Advisory — a flagged result never blocks; a human always decides.
      </p>

      <section className={`${CARD} mt-6`}>
        <h2 className="mb-4 text-sm font-semibold text-ink">Rollout</h2>
        <div className="space-y-5">
          <FieldRow
            label="Mode"
            help="Off — nothing runs. Shadow — the check runs and stores its report when a review page is opened, but nobody sees anything (used while tuning). Live — the report card appears on the Place order screen."
            saved={recentlySaved('artwork_check_mode')}
            working={working.artwork_check_mode}
            error={errors.artwork_check_mode}
          >
            <RadioGroup<Mode>
              value={settings.artwork_check_mode}
              onChange={(v) => void save('artwork_check_mode', v)}
              options={[
                { value: 'off', label: 'Off' },
                { value: 'shadow', label: 'Shadow' },
                { value: 'live', label: 'Live' },
              ]}
            />
          </FieldRow>

          <FieldRow
            label="Require a check before placing"
            help="When on (and the mode is Live), an order can’t be sent to the workshop or a supplier until the check has run for it. Running is the only requirement — any result (clear, flagged, even a failed run) satisfies it, and the check runs automatically when the review page opens. Inert while the mode isn’t Live."
            saved={recentlySaved('artwork_check_required')}
            working={working.artwork_check_required}
            error={errors.artwork_check_required}
          >
            <Toggle
              value={settings.artwork_check_required}
              onChange={(v) => void changeRequired(v)}
              disabled={!!working.artwork_check_required}
              label="Require a check before placing"
            />
          </FieldRow>
        </div>
      </section>

      <section className={`${CARD} mt-5`}>
        <h2 className="mb-4 text-sm font-semibold text-ink">Model</h2>
        <div className="space-y-5">
          <FieldRow
            label="Claude model"
            help="Which Claude model the check runs on. Opus 4.8 is the validated recommendation. Changing this takes effect on the next check with no redeploy — but re-run a few known orders to sanity-check any other model before relying on it, since the rules were tuned on Opus 4.8."
            saved={recentlySaved('artwork_check_model')}
            working={working.artwork_check_model}
            error={errors.artwork_check_model}
          >
            <select
              value={currentModel}
              onChange={(e) => void save('artwork_check_model', e.target.value)}
              className={`${inputClass} max-w-full`}
            >
              {modelOptions.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </FieldRow>
        </div>
      </section>
    </div>
  )
}
