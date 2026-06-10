import { useEffect, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { logAudit } from '../../lib/audit'
import { invalidatePublicSettings } from '../../lib/publicSettings'
import LoginCopySection from './LoginCopySection'
import MetalThicknessNotesSection from './MetalThicknessNotesSection'
import { FieldRow, inputClass } from './settingsControls'

// /admin/site-copy — every piece of editable wording, in one place.
// The Customer-facing card moved here wholesale from AdminSettingsPage
// (same per-field blur-save + audit flow, loading only the columns this
// page owns); LoginCopySection and MetalThicknessNotesSection are
// self-contained and own their own load + save.

// ── Types ────────────────────────────────────────────────────────────────────

interface SiteCopySettings {
  disclaimer_text: string
  company_name: string
  reply_email: string
  /** "About this proof" footer note on the customer page (000199). */
  about_proof_copy: string
  /** "QR code contents" panel copy on the customer page (000200). */
  qr_panel_intro_copy: string
  qr_panel_vcard_copy: string
}

/** Stable audit action string per field. */
const AUDIT_ACTION: Record<keyof SiteCopySettings, string> = {
  disclaimer_text:     'setting.disclaimer_updated',
  company_name:        'setting.company_name_updated',
  reply_email:         'setting.reply_email_updated',
  about_proof_copy:    'setting.about_proof_copy_updated',
  qr_panel_intro_copy: 'setting.qr_panel_intro_copy_updated',
  qr_panel_vcard_copy: 'setting.qr_panel_vcard_copy_updated',
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function AdminSiteCopyPage() {
  const [settings, setSettings] = useState<SiteCopySettings | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Per-field UI state: last save timestamp, in-flight saves, errors.
  const [savedAt, setSavedAt] = useState<Partial<Record<keyof SiteCopySettings, number>>>({})
  const [errors, setErrors] = useState<Partial<Record<keyof SiteCopySettings, string>>>({})
  const [working, setWorking] = useState<Partial<Record<keyof SiteCopySettings, boolean>>>({})

  // Local drafts so text fields don't round-trip on every keystroke.
  const [drafts, setDrafts] = useState<Partial<SiteCopySettings>>({})

  useEffect(() => { load() }, [])

  async function load() {
    const { data, error } = await supabase
      .from('settings')
      .select('disclaimer_text, company_name, reply_email, about_proof_copy, qr_panel_intro_copy, qr_panel_vcard_copy')
      .eq('id', 1)
      .single()
    if (error || !data) { setLoadError(error?.message ?? 'Settings row missing'); return }
    setSettings(data as SiteCopySettings)
    setDrafts({})
  }

  /** Persist a single field, with optimistic state + audit log. */
  async function saveField<K extends keyof SiteCopySettings>(field: K, nextValue: SiteCopySettings[K]) {
    if (!settings) return
    const prevValue = settings[field]
    if (prevValue === nextValue) return // no-op

    setWorking((w) => ({ ...w, [field]: true }))
    setErrors((e) => ({ ...e, [field]: undefined }))
    // Optimistic state
    setSettings((s) => s ? { ...s, [field]: nextValue } : s)

    const patch: any = { [field]: nextValue, updated_at: new Date().toISOString() }
    const { error } = await supabase.from('settings').update(patch).eq('id', 1)
    setWorking((w) => ({ ...w, [field]: false }))

    if (error) {
      // Rollback
      setSettings((s) => s ? { ...s, [field]: prevValue } : s)
      setErrors((e) => ({ ...e, [field]: error.message }))
      return
    }

    setSavedAt((s) => ({ ...s, [field]: Date.now() }))
    invalidatePublicSettings()

    void logAudit({
      action: AUDIT_ACTION[field],
      targetType: 'setting',
      targetId: field,
      targetLabel: humanFieldLabel(field),
      beforeValue: { [field]: prevValue },
      afterValue: { [field]: nextValue },
    })
  }

  // Single-field blur handler for text inputs.
  function onTextBlur(field: keyof SiteCopySettings) {
    if (!settings) return
    const draft = drafts[field]
    if (draft === undefined) return
    void saveField(field, draft as any)
  }

  function recentlySaved(field: keyof SiteCopySettings): boolean {
    const t = savedAt[field]
    return !!t && Date.now() - t < 2000
  }

  // Force a re-render for the "Saved" indicator fade — no need to be clever.
  const tickRef = useRef(0)
  useEffect(() => {
    const interval = setInterval(() => { tickRef.current += 1 }, 500)
    return () => clearInterval(interval)
  }, [])

  if (loadError) {
    return (
      <div className="rounded-2xl bg-out-soft p-6 text-sm text-out ring-1 ring-out">
        Failed to load settings: {loadError}
      </div>
    )
  }
  if (!settings) {
    return (
      <div className="flex justify-center py-20">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-line border-t-gray-900" />
      </div>
    )
  }

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-xl font-bold text-ink">Site copy</h2>
        <p className="mt-1 text-sm text-ink-mute">
          The editable wording on the customer proof page and the designer sign-in page. Changes save automatically and customer-facing values update within a minute.
        </p>
      </div>

      {/* ── Customer-facing ─────────────────────────────────────────── */}
      <section className="rounded-2xl bg-surface p-6 shadow-sm ring-1 ring-line">
        <h3 className="mb-4 text-sm font-semibold text-ink">Customer-facing</h3>
        <div className="space-y-5">
          <FieldRow
            label="Disclaimer copy"
            help="Shown on every customer-facing proof page. Paragraph breaks in this field render as spacing on the page."
            saved={recentlySaved('disclaimer_text')}
            working={working.disclaimer_text}
            error={errors.disclaimer_text}
          >
            <textarea
              value={drafts.disclaimer_text ?? settings.disclaimer_text}
              onChange={(e) => setDrafts((d) => ({ ...d, disclaimer_text: e.target.value }))}
              onBlur={() => onTextBlur('disclaimer_text')}
              rows={6}
              className={inputClass}
              placeholder="Please check this proof carefully before approving…"
            />
          </FieldRow>

          <FieldRow
            label="Company name"
            help="Used in references on the customer page (e.g. 'not the responsibility of [company name]')."
            saved={recentlySaved('company_name')}
            working={working.company_name}
            error={errors.company_name}
          >
            <input
              type="text"
              value={drafts.company_name ?? settings.company_name}
              onChange={(e) => setDrafts((d) => ({ ...d, company_name: e.target.value }))}
              onBlur={() => onTextBlur('company_name')}
              className={inputClass}
            />
          </FieldRow>

          <FieldRow
            label="Reply email"
            help="The email address customers should reply to when requesting changes. Shown on the customer page."
            saved={recentlySaved('reply_email')}
            working={working.reply_email}
            error={errors.reply_email}
          >
            <input
              type="email"
              value={drafts.reply_email ?? settings.reply_email}
              onChange={(e) => {
                setDrafts((d) => ({ ...d, reply_email: e.target.value }))
                // Clear a stale "Invalid email" pill the moment the
                // user keeps typing — without this, the error stuck
                // around even after the value was reverted to the
                // saved one and stayed up against the next save.
                if (errors.reply_email) {
                  setErrors((er) => ({ ...er, reply_email: undefined }))
                }
              }}
              onBlur={() => {
                const draft = drafts.reply_email
                if (draft == null) return
                if (draft !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft)) {
                  setErrors((e) => ({ ...e, reply_email: 'Invalid email' }))
                  setDrafts((d) => ({ ...d, reply_email: settings.reply_email }))
                  return
                }
                // Successful path — clear any prior error pill so the
                // FieldRow doesn't display "Saved" and "Invalid"
                // simultaneously after a fix-up edit.
                if (errors.reply_email) {
                  setErrors((er) => ({ ...er, reply_email: undefined }))
                }
                onTextBlur('reply_email')
              }}
              className={inputClass}
              placeholder="hello@plasmadesign.co.uk"
            />
          </FieldRow>

          <FieldRow
            label="About this proof note"
            help="The quiet note at the bottom of every customer proof page, explaining that on-screen colours and finish are an approximation of the real card."
            saved={recentlySaved('about_proof_copy')}
            working={working.about_proof_copy}
            error={errors.about_proof_copy}
          >
            <textarea
              value={drafts.about_proof_copy ?? settings.about_proof_copy}
              onChange={(e) => setDrafts((d) => ({ ...d, about_proof_copy: e.target.value }))}
              onBlur={() => onTextBlur('about_proof_copy')}
              rows={5}
              className={inputClass}
            />
          </FieldRow>

          <FieldRow
            label="QR panel — review instructions"
            help="First paragraph of the 'QR code contents' panel, shown on proofs that include QR codes. The standing 'please double-check each QR code' instruction. Leave blank to use the built-in default."
            saved={recentlySaved('qr_panel_intro_copy')}
            working={working.qr_panel_intro_copy}
            error={errors.qr_panel_intro_copy}
          >
            <textarea
              value={drafts.qr_panel_intro_copy ?? settings.qr_panel_intro_copy ?? ''}
              onChange={(e) => setDrafts((d) => ({ ...d, qr_panel_intro_copy: e.target.value }))}
              onBlur={() => onTextBlur('qr_panel_intro_copy')}
              rows={4}
              className={inputClass}
            />
          </FieldRow>

          <FieldRow
            label="QR panel — Plasma vCard note"
            help="Second paragraph of the 'QR code contents' panel, explaining what scanning a Plasma vCard QR does. Leave blank to use the built-in default."
            saved={recentlySaved('qr_panel_vcard_copy')}
            working={working.qr_panel_vcard_copy}
            error={errors.qr_panel_vcard_copy}
          >
            <textarea
              value={drafts.qr_panel_vcard_copy ?? settings.qr_panel_vcard_copy ?? ''}
              onChange={(e) => setDrafts((d) => ({ ...d, qr_panel_vcard_copy: e.target.value }))}
              onBlur={() => onTextBlur('qr_panel_vcard_copy')}
              rows={4}
              className={inputClass}
            />
          </FieldRow>
        </div>
      </section>

      {/* ── Login page copy ──────────────────────────────────── */}
      <LoginCopySection />

      {/* ── Metal thickness notes ────────────────────────────── */}
      <MetalThicknessNotesSection />
    </div>
  )
}

// ── Shared bits ─────────────────────────────────────────────────────────────

function humanFieldLabel(field: keyof SiteCopySettings): string {
  return {
    disclaimer_text: 'Disclaimer copy',
    company_name: 'Company name',
    reply_email: 'Reply email',
    about_proof_copy: 'About this proof note',
    qr_panel_intro_copy: 'QR panel — review instructions',
    qr_panel_vcard_copy: 'QR panel — Plasma vCard note',
  }[field]
}
