import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { logAudit } from '../../lib/audit'
import { invalidatePublicSettings } from '../../lib/publicSettings'
import AdminMaterialContentModal, { type MaterialContent } from './AdminMaterialContentModal'

// ── Types ────────────────────────────────────────────────────────────────────

type PricingDisplayValue = 'standard' | 'custom_quote'
type CurrencyValue = 'GBP' | 'EUR' | 'USD'

interface Settings {
  disclaimer_text: string
  company_name: string
  reply_email: string
  /** null means "no default — force the designer to choose". */
  default_pricing_display: PricingDisplayValue | null
  default_currency: CurrencyValue | null
}

interface HelpScoutStatus {
  connected: boolean
  app_id_set: boolean
  app_secret_set: boolean
}

/** Stable audit action string per field. */
const AUDIT_ACTION: Record<keyof Settings, string> = {
  disclaimer_text:         'setting.disclaimer_updated',
  company_name:            'setting.company_name_updated',
  reply_email:             'setting.reply_email_updated',
  default_pricing_display: 'setting.default_pricing_display_updated',
  default_currency:        'setting.default_currency_updated',
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function AdminSettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Per-field UI state: last save timestamp, in-flight saves, errors.
  const [savedAt, setSavedAt] = useState<Partial<Record<keyof Settings, number>>>({})
  const [errors, setErrors] = useState<Partial<Record<keyof Settings, string>>>({})
  const [working, setWorking] = useState<Partial<Record<keyof Settings, boolean>>>({})

  // Local drafts so text fields don't round-trip on every keystroke.
  const [drafts, setDrafts] = useState<Partial<Settings>>({})

  // Help Scout connection state.
  const [hsStatus, setHsStatus] = useState<HelpScoutStatus | null>(null)
  const [hsTesting, setHsTesting] = useState(false)
  const [hsTestResult, setHsTestResult] = useState<{ ok: boolean; message: string } | null>(null)

  // Materials + selected material for the editor modal.
  const [materials, setMaterials] = useState<MaterialContent[]>([])
  const [editingMaterial, setEditingMaterial] = useState<MaterialContent | null>(null)

  useEffect(() => { load(); void loadMaterials() }, [])

  async function load() {
    const { data, error } = await supabase.from('settings').select('*').eq('id', 1).single()
    if (error || !data) { setLoadError(error?.message ?? 'Settings row missing'); return }
    setSettings(data as Settings)
    setDrafts({})
    // Status check in the background
    void checkHelpScout()
  }

  async function loadMaterials() {
    // Admin list — show every active material, published or not.
    const { data } = await supabase
      .from('materials')
      .select('id, code, display_name, category, description, icon_url, is_published')
      .eq('is_active', true)
      .order('sort_order')
    setMaterials((data ?? []) as MaterialContent[])
  }

  async function checkHelpScout() {
    const { data, error } = await supabase.functions.invoke('helpscout-status')
    if (error) { setHsStatus({ connected: false, app_id_set: false, app_secret_set: false }); return }
    setHsStatus(data as HelpScoutStatus)
  }

  async function testHelpScout() {
    setHsTesting(true)
    setHsTestResult(null)
    const { data, error } = await supabase.functions.invoke('match-helpscout-conversation', {
      body: { email: 'test-connection@example.invalid' },
    })
    setHsTesting(false)
    if (error) {
      setHsTestResult({ ok: false, message: error.message })
    } else if ((data as any)?.error) {
      setHsTestResult({ ok: false, message: (data as any).error })
    } else {
      setHsTestResult({ ok: true, message: 'Help Scout responded successfully.' })
    }
  }

  /** Persist a single field, with optimistic state + audit log. */
  async function saveField<K extends keyof Settings>(field: K, nextValue: Settings[K]) {
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
  function onTextBlur(field: keyof Settings) {
    if (!settings) return
    const draft = drafts[field]
    if (draft === undefined) return
    void saveField(field, draft as any)
  }

  function recentlySaved(field: keyof Settings): boolean {
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
      <div className="rounded-2xl bg-rose-50 p-6 text-sm text-rose-700 ring-1 ring-rose-200">
        Failed to load settings: {loadError}
      </div>
    )
  }
  if (!settings) {
    return (
      <div className="flex justify-center py-20">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-200 border-t-gray-900" />
      </div>
    )
  }

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-xl font-bold text-gray-900">Settings</h2>
        <p className="mt-1 text-sm text-gray-500">
          Changes save automatically. Customer-facing values update within a minute.
        </p>
      </div>

      {/* ── Customer-facing ─────────────────────────────────────────── */}
      <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-gray-200">
        <h3 className="mb-4 text-sm font-semibold text-gray-900">Customer-facing</h3>
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
              onChange={(e) => setDrafts((d) => ({ ...d, reply_email: e.target.value }))}
              onBlur={() => {
                const draft = drafts.reply_email
                if (draft == null) return
                if (draft !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft)) {
                  setErrors((e) => ({ ...e, reply_email: 'Invalid email' }))
                  setDrafts((d) => ({ ...d, reply_email: settings.reply_email }))
                  return
                }
                onTextBlur('reply_email')
              }}
              className={inputClass}
              placeholder="hello@plasmadesign.co.uk"
            />
          </FieldRow>
        </div>
      </section>

      {/* ── Designer defaults ─────────────────────────────────────── */}
      <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-gray-200">
        <h3 className="mb-4 text-sm font-semibold text-gray-900">Designer defaults</h3>
        <div className="space-y-5">
          <FieldRow
            label="Default pricing display"
            help={`What's pre-selected when a designer creates a new version. Choosing "No default" means designers have to pick a value every time, which prevents mistakes from accepting the pre-filled choice.`}
            saved={recentlySaved('default_pricing_display')}
            working={working.default_pricing_display}
            error={errors.default_pricing_display}
          >
            <RadioGroup<PricingDisplayValue | null>
              value={settings.default_pricing_display}
              onChange={(v) => saveField('default_pricing_display', v)}
              options={[
                { value: 'standard', label: 'Standard pricing' },
                { value: 'custom_quote', label: 'Custom quote' },
                { value: null, label: 'No default' },
              ]}
            />
          </FieldRow>

          <FieldRow
            label="Default currency"
            help={`What's pre-selected when a designer creates a new version. Choosing "No default" means designers have to pick a value every time, which prevents mistakes from accepting the pre-filled choice.`}
            saved={recentlySaved('default_currency')}
            working={working.default_currency}
            error={errors.default_currency}
          >
            <RadioGroup<CurrencyValue | null>
              value={settings.default_currency}
              onChange={(v) => saveField('default_currency', v)}
              options={[
                { value: 'GBP', label: 'GBP' },
                { value: 'EUR', label: 'EUR' },
                { value: 'USD', label: 'USD' },
                { value: null, label: 'No default' },
              ]}
            />
          </FieldRow>
        </div>
      </section>

      {/* ── Integrations ───────────────────────────────────────── */}
      <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-gray-200">
        <h3 className="mb-4 text-sm font-semibold text-gray-900">Integrations</h3>

        <div className="flex flex-wrap items-center gap-4">
          <div className="flex-1 min-w-[15rem]">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-gray-900">Help Scout</span>
              {hsStatus == null ? (
                <span className="text-xs text-gray-400">Checking…</span>
              ) : hsStatus.connected ? (
                <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700">Connected</span>
              ) : (
                <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-500">Not connected</span>
              )}
            </div>
            <p className="mt-1 text-xs text-gray-500">
              Configured via the HELPSCOUT_APP_ID and HELPSCOUT_APP_SECRET Supabase secrets.
            </p>
            {hsTestResult && (
              <p className={['mt-2 rounded-lg px-3 py-2 text-xs', hsTestResult.ok ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'].join(' ')}>
                {hsTestResult.message}
              </p>
            )}
          </div>
          <button
            onClick={testHelpScout}
            disabled={hsTesting || !hsStatus?.connected}
            className="shrink-0 rounded-lg px-3 py-2 text-sm font-medium text-gray-600 ring-1 ring-gray-200 hover:bg-gray-50 disabled:opacity-50"
          >
            {hsTesting ? 'Testing…' : 'Test connection'}
          </button>
        </div>
      </section>

      {/* ── Materials ──────────────────────────────────────────── */}
      <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-gray-200">
        <div className="mb-1 flex items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-semibold text-gray-900">Materials</h3>
            <p className="mt-1 text-xs text-gray-500">
              Per-material description and icon for the customer-facing "About [Material]" block. Unpublished materials stay hidden from designers until an admin publishes them.
            </p>
          </div>
          <Link
            to="/admin/materials/new"
            className="shrink-0 rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-700"
          >
            Add material
          </Link>
        </div>
        <div className="mt-4 overflow-hidden rounded-lg ring-1 ring-gray-200">
          {materials.length === 0 ? (
            <p className="px-4 py-6 text-sm text-gray-400">No materials.</p>
          ) : (
            materials.map((m, i) => (
              <div
                key={m.id}
                className={['flex items-center gap-4 px-4 py-3', i > 0 ? 'border-t border-gray-100' : ''].join(' ')}
              >
                <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded bg-gray-50 ring-1 ring-gray-200">
                  {m.icon_url
                    ? <img src={m.icon_url} alt="" className="max-h-full max-w-full object-contain" />
                    : <svg viewBox="0 0 16 16" className="h-4 w-4 text-gray-300" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 12l3-4 3 3 3-5 3 4" strokeLinecap="round" strokeLinejoin="round" /></svg>}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-gray-900">{m.display_name}</div>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {m.is_published
                      ? <span className="inline-block rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700">Published</span>
                      : <span className="inline-block rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">Unpublished</span>}
                    {!m.description && (
                      <span className="inline-block rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-500">
                        Needs content
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap justify-end gap-2">
                  <button
                    onClick={() => setEditingMaterial(m)}
                    className="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-600 ring-1 ring-gray-200 hover:bg-gray-50"
                  >
                    Edit
                  </button>
                  <Link
                    to={`/admin/pricing/materials/${m.code}`}
                    className="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-500 hover:bg-gray-50"
                  >
                    Pricing &amp; variants
                  </Link>
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      {editingMaterial && (
        <AdminMaterialContentModal
          material={editingMaterial}
          onClose={() => { setEditingMaterial(null); void loadMaterials() }}
          onSaved={(updated) => {
            setMaterials((prev) => prev.map((m) => m.id === updated.id ? updated : m))
          }}
        />
      )}
    </div>
  )
}

// ── Shared bits ─────────────────────────────────────────────────────────────

function FieldRow({ label, help, saved, working, error, children }: {
  label: string
  help: string
  saved?: boolean
  working?: boolean
  error?: string
  children: React.ReactNode
}) {
  return (
    <div>
      <div className="mb-1 flex items-center gap-3">
        <label className="text-sm font-medium text-gray-700">{label}</label>
        {working && <span className="text-xs text-gray-400">Saving…</span>}
        {saved && !working && <span className="text-xs text-emerald-600">Saved</span>}
        {error && <span className="text-xs text-rose-600">{error}</span>}
      </div>
      {children}
      <p className="mt-1.5 text-xs text-gray-500">{help}</p>
    </div>
  )
}

function RadioGroup<T extends string | null>({ value, onChange, options }: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: string }[]
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={o.value ?? '__none__'}
            type="button"
            onClick={() => onChange(o.value)}
            className={[
              'rounded-full px-4 py-1.5 text-sm font-medium transition-colors',
              active
                ? 'bg-gray-900 text-white'
                : 'bg-white text-gray-600 ring-1 ring-gray-200 hover:bg-gray-50',
            ].join(' ')}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

function humanFieldLabel(field: keyof Settings): string {
  return {
    disclaimer_text: 'Disclaimer copy',
    company_name: 'Company name',
    reply_email: 'Reply email',
    default_pricing_display: 'Default pricing display',
    default_currency: 'Default currency',
  }[field]
}

const inputClass = 'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900'
