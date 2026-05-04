import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { logAudit } from '../../lib/audit'
import { invalidatePublicSettings } from '../../lib/publicSettings'
import { invalidateVatRateGbp } from '../../lib/vatRateGbp'
import { invalidateApprovalSettings } from '../../lib/approvalSettings'
import AdminMaterialContentModal, { type MaterialContent } from './AdminMaterialContentModal'
import AdminTemplatesSection from './AdminTemplatesSection'

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
  /** UK VAT rate used to derive the ex-VAT readout on the quote
   *  compiler's GBP headline. Stored as a fraction (0.20 = 20%);
   *  CHECK 0..1 enforced at the column. Migration 000115. */
  vat_rate_gbp: number
  /** Phase 2 customer approval flow (migration 000116). */
  approvals_enabled: boolean
  approve_confirmation_copy: string
  request_changes_confirmation_copy: string
}

// Help Scout test-connection result. Component-scoped only — no DB
// persistence. Resets to "not tested" on page revisit, accepted v1
// trade-off per the brief.
type HelpScoutTestState =
  | { kind: 'untested' }
  | { kind: 'connected'; verifiedAt: string; mailboxName?: string }
  | { kind: 'failed'; reason: HelpScoutFailReason; detail?: string }

type HelpScoutFailReason =
  | 'missing_env_vars'
  | 'auth_failed'
  | 'api_unreachable'
  | 'unexpected_error'

/** Stable audit action string per field. */
const AUDIT_ACTION: Record<keyof Settings, string> = {
  disclaimer_text:                   'setting.disclaimer_updated',
  company_name:                      'setting.company_name_updated',
  reply_email:                       'setting.reply_email_updated',
  default_pricing_display:           'setting.default_pricing_display_updated',
  default_currency:                  'setting.default_currency_updated',
  vat_rate_gbp:                      'setting.vat_rate_gbp_updated',
  approvals_enabled:                 'setting.approvals_enabled_updated',
  approve_confirmation_copy:         'setting.approve_confirmation_copy_updated',
  request_changes_confirmation_copy: 'setting.request_changes_confirmation_copy_updated',
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

  // Help Scout connection state. No mount-time check — test only
  // fires when the admin clicks the Test connection button.
  const [hsTestState, setHsTestState] = useState<HelpScoutTestState>({ kind: 'untested' })
  const [hsTesting, setHsTesting] = useState(false)

  // Materials + selected material for the editor modal. Archived
  // rows are hidden from the main list unless the admin flips the
  // "Show archived" toggle.
  const [materials, setMaterials] = useState<MaterialContent[]>([])
  const [editingMaterial, setEditingMaterial] = useState<MaterialContent | null>(null)
  const [showArchived, setShowArchived] = useState(false)

  useEffect(() => { load(); void loadMaterials() }, [])

  async function load() {
    const { data, error } = await supabase.from('settings').select('*').eq('id', 1).single()
    if (error || !data) { setLoadError(error?.message ?? 'Settings row missing'); return }
    setSettings(data as Settings)
    setDrafts({})
  }

  async function loadMaterials() {
    // Admin list — loads all active materials including archived ones
    // so the "Show archived" toggle can reveal them without a second
    // round-trip. RLS lets admins see archived rows; designers
    // wouldn't.
    const { data } = await supabase
      .from('materials')
      .select('id, code, display_name, category, description, icon_url, is_published, archived_at, display_quantities, quote_min_quantity, quote_max_quantity, key_features')
      .eq('is_active', true)
      .order('sort_order')
    setMaterials((data ?? []) as MaterialContent[])
  }

  // Run the end-to-end Help Scout test (OAuth → /v2/mailboxes).
  // The structured response from admin-test-helpscout maps directly
  // into HelpScoutTestState, with a defensive 'unexpected_error'
  // bucket for transport / network failures the function couldn't
  // catch itself.
  async function testHelpScout() {
    if (hsTesting) return
    setHsTesting(true)
    const { data, error } = await supabase.functions.invoke<
      | { status: 'connected'; verifiedAt: string; mailboxName?: string }
      | { status: 'failed'; reason: HelpScoutFailReason; detail?: string }
    >('admin-test-helpscout')
    setHsTesting(false)
    if (error) {
      setHsTestState({ kind: 'failed', reason: 'unexpected_error', detail: error.message })
      return
    }
    if (!data) {
      setHsTestState({ kind: 'failed', reason: 'unexpected_error', detail: 'No response from edge function' })
      return
    }
    if (data.status === 'connected') {
      setHsTestState({ kind: 'connected', verifiedAt: data.verifiedAt, mailboxName: data.mailboxName })
      return
    }
    setHsTestState({ kind: 'failed', reason: data.reason, detail: data.detail })
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
    if (field === 'vat_rate_gbp') invalidateVatRateGbp()
    if (
      field === 'approvals_enabled' ||
      field === 'approve_confirmation_copy' ||
      field === 'request_changes_confirmation_copy'
    ) {
      invalidateApprovalSettings()
    }

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

  // Blur handler for the two customer-approval confirmation copy
  // textareas. Trims, rejects empty (so the spec defaults stay
  // populated — admin can't accidentally wipe the modal body),
  // otherwise saves the trimmed value.
  //
  // On empty input we keep the draft as-is rather than snapping it
  // back to the saved value. The user typed (and then deleted) the
  // text on purpose; reverting silently would lose any partial
  // wording they were re-working from. The error pill stays up
  // until they put a non-empty value back, which the next render
  // will save.
  function onConfirmationCopyBlur(
    field: 'approve_confirmation_copy' | 'request_changes_confirmation_copy',
  ) {
    if (!settings) return
    const draft = drafts[field]
    if (draft === undefined) return
    const trimmed = (draft as string).trim()
    if (trimmed === '') {
      setErrors((e) => ({ ...e, [field]: 'Confirmation copy cannot be empty.' }))
      return
    }
    void saveField(field, trimmed)
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
        </div>
      </section>

      {/* ── Customer approvals (Phase 2) ──────────────────────────── */}
      <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-gray-200">
        <h3 className="mb-4 text-sm font-semibold text-gray-900">Customer approvals</h3>
        <div className="space-y-5">
          <FieldRow
            label="Customer-facing approval flow enabled"
            help="When off, customers see the read-only proof page and reply via email. Toggle on to enable the Approve and Request changes buttons on the customer page."
            saved={recentlySaved('approvals_enabled')}
            working={working.approvals_enabled}
            error={errors.approvals_enabled}
          >
            <Toggle
              value={settings.approvals_enabled}
              onChange={(v) => void saveField('approvals_enabled', v)}
              disabled={!!working.approvals_enabled}
              label="Customer-facing approval flow enabled"
            />
          </FieldRow>

          <FieldRow
            label="Approve confirmation copy"
            help="Shown to customers after they click Approve, before they confirm. Plain text, no markdown."
            saved={recentlySaved('approve_confirmation_copy')}
            working={working.approve_confirmation_copy}
            error={errors.approve_confirmation_copy}
          >
            <textarea
              value={drafts.approve_confirmation_copy ?? settings.approve_confirmation_copy}
              onChange={(e) => setDrafts((d) => ({ ...d, approve_confirmation_copy: e.target.value }))}
              onBlur={() => onConfirmationCopyBlur('approve_confirmation_copy')}
              rows={3}
              className={inputClass}
            />
          </FieldRow>

          <FieldRow
            label="Request changes confirmation copy"
            help="Shown to customers after they click Request changes, before they confirm. Plain text, no markdown."
            saved={recentlySaved('request_changes_confirmation_copy')}
            working={working.request_changes_confirmation_copy}
            error={errors.request_changes_confirmation_copy}
          >
            <textarea
              value={drafts.request_changes_confirmation_copy ?? settings.request_changes_confirmation_copy}
              onChange={(e) => setDrafts((d) => ({ ...d, request_changes_confirmation_copy: e.target.value }))}
              onBlur={() => onConfirmationCopyBlur('request_changes_confirmation_copy')}
              rows={3}
              className={inputClass}
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

      {/* ── Pricing settings ─────────────────────────────────────── */}
      <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-gray-200">
        <h3 className="mb-4 text-sm font-semibold text-gray-900">Pricing settings</h3>
        <div className="space-y-5">
          <FieldRow
            label="UK VAT rate (GBP)"
            help="UK VAT rate. Currently 20% (0.20). Edit if HMRC changes it. EUR and USD prices are VAT-free and unaffected."
            saved={recentlySaved('vat_rate_gbp')}
            working={working.vat_rate_gbp}
            error={errors.vat_rate_gbp}
          >
            <input
              type="number"
              min={0}
              max={1}
              step={0.01}
              value={drafts.vat_rate_gbp ?? settings.vat_rate_gbp}
              onChange={(e) => {
                const raw = e.target.value
                // Allow empty string while editing — onBlur snaps
                // back to the saved value if the user leaves it
                // empty.
                if (raw === '') {
                  setDrafts((d) => ({ ...d, vat_rate_gbp: undefined }))
                  return
                }
                const n = Number(raw)
                setDrafts((d) => ({ ...d, vat_rate_gbp: Number.isFinite(n) ? n : d.vat_rate_gbp }))
              }}
              onBlur={() => {
                const draft = drafts.vat_rate_gbp
                if (draft == null) {
                  // Empty / nonsense — discard the draft, leave saved value as-is.
                  setDrafts((d) => ({ ...d, vat_rate_gbp: undefined }))
                  return
                }
                if (!Number.isFinite(draft) || draft < 0 || draft > 1) {
                  setErrors((e) => ({ ...e, vat_rate_gbp: 'Must be between 0 and 1 (e.g. 0.20)' }))
                  setDrafts((d) => ({ ...d, vat_rate_gbp: undefined }))
                  return
                }
                // Round to 4dp to match the column's numeric(5,4)
                // precision; avoids saving e.g. 0.20000000003 from
                // a copy-paste.
                const rounded = Math.round(draft * 10000) / 10000
                void saveField('vat_rate_gbp', rounded)
              }}
              className={`${inputClass} max-w-[10rem]`}
            />
          </FieldRow>
        </div>
      </section>

      {/* ── Integrations ─────────────────────────────────────────
          Help Scout panel — admin clicks Test connection to run the
          full OAuth + /v2/mailboxes round trip. Three indicator
          states (untested amber / connected green / failed red),
          mailbox name surfaced when available, distinct failure
          messages keyed off the structured `reason` returned by
          admin-test-helpscout. State is component-scoped — leaving
          and returning resets to "Not tested this session". */}
      <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-gray-200">
        <h3 className="mb-4 text-sm font-semibold text-gray-900">Help Scout</h3>

        <div className="flex flex-wrap items-start gap-4">
          <div className="flex-1 min-w-[15rem]">
            <HelpScoutStatusRow state={hsTestState} />
            <p className="mt-3 text-xs text-gray-500">
              To update Help Scout credentials, open the Supabase dashboard → Project Settings → Edge Functions → Secrets and update <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[11px]">HELPSCOUT_APP_ID</code> and <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[11px]">HELPSCOUT_APP_SECRET</code>. After updating, click Test connection to verify.
            </p>
          </div>
          <button
            onClick={testHelpScout}
            disabled={hsTesting}
            className="shrink-0 rounded-lg px-3 py-2 text-sm font-medium text-gray-600 ring-1 ring-gray-200 hover:bg-gray-50 disabled:opacity-50"
          >
            {hsTesting ? 'Testing…' : 'Test connection'}
          </button>
        </div>
      </section>

      {/* ── Reply templates ──────────────────────────────────── */}
      <AdminTemplatesSection />

      {/* ── Materials ──────────────────────────────────────────── */}
      <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-gray-200">
        <div className="mb-1 flex items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-semibold text-gray-900">Materials</h3>
            <p className="mt-1 text-xs text-gray-500">
              Per-material description and icon for the customer-facing "About [Material]" block. Unpublished materials stay hidden from designers until an admin publishes them. Archived materials are hidden entirely.
            </p>
          </div>
          <Link
            to="/admin/materials/new"
            className="shrink-0 rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-700"
          >
            Add material
          </Link>
        </div>

        {(() => {
          const active = materials.filter((m) => m.archived_at == null)
          const archived = materials.filter((m) => m.archived_at != null)
          return (
            <>
              {archived.length > 0 && (
                <div className="mt-3 flex items-center gap-2 text-xs">
                  <button
                    type="button"
                    onClick={() => setShowArchived(!showArchived)}
                    role="switch"
                    aria-checked={showArchived}
                    className={[
                      'relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors',
                      showArchived ? 'bg-gray-900' : 'bg-gray-200',
                    ].join(' ')}
                  >
                    <span
                      className={[
                        'inline-block h-4 w-4 transform rounded-full bg-white transition-transform',
                        showArchived ? 'translate-x-[1.125rem] translate-y-0.5' : 'translate-x-0.5 translate-y-0.5',
                      ].join(' ')}
                    />
                  </button>
                  <label className="text-gray-500">
                    Show archived ({archived.length})
                  </label>
                </div>
              )}

              <div className="mt-4 overflow-hidden rounded-lg ring-1 ring-gray-200">
                {active.length === 0 ? (
                  <p className="px-4 py-6 text-sm text-gray-400">No active materials.</p>
                ) : (
                  active.map((m, i) => renderMaterialRow(
                    m, i, setEditingMaterial, /* muted */ false,
                  ))
                )}
              </div>

              {showArchived && archived.length > 0 && (
                <div className="mt-6">
                  <div className="mb-2 flex items-center gap-2">
                    <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-400">
                      Archived
                    </h4>
                    <span className="text-xs text-gray-400">
                      ({archived.length})
                    </span>
                  </div>
                  <div className="overflow-hidden rounded-lg ring-1 ring-gray-200">
                    {archived.map((m, i) => renderMaterialRow(
                      m, i, setEditingMaterial, /* muted */ true,
                    ))}
                  </div>
                </div>
              )}
            </>
          )
        })()}
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

// Help Scout indicator row — three states with distinct colour tokens:
//   untested   → amber dot, "Not tested this session"
//   connected  → green dot, "Connected" + optional "Mailbox: {name}"
//                + "Last verified at HH:MM" footnote
//   failed     → red dot + a human-readable message keyed off
//                `reason`, with the optional `detail` rendered as
//                a muted second line for diagnostic depth.
function HelpScoutStatusRow({ state }: { state: HelpScoutTestState }) {
  if (state.kind === 'untested') {
    return (
      <div className="flex items-center gap-2">
        <Dot color="amber" />
        <span className="text-sm font-medium text-gray-900">Not tested this session</span>
      </div>
    )
  }
  if (state.kind === 'connected') {
    const verifiedAt = (() => {
      try {
        return new Date(state.verifiedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
      } catch {
        return null
      }
    })()
    return (
      <div>
        <div className="flex items-center gap-2">
          <Dot color="green" />
          <span className="text-sm font-medium text-emerald-700">Connected</span>
        </div>
        {state.mailboxName && (
          <p className="mt-1 text-xs text-gray-600">
            Mailbox: <span className="font-medium text-gray-900">{state.mailboxName}</span>
          </p>
        )}
        {verifiedAt && (
          <p className="mt-0.5 text-xs text-gray-400">Last verified at {verifiedAt}</p>
        )}
      </div>
    )
  }
  // failed
  const message = helpScoutFailMessage(state.reason)
  return (
    <div>
      <div className="flex items-center gap-2">
        <Dot color="red" />
        <span className="text-sm font-medium text-rose-700">Not connected — {message}</span>
      </div>
      {state.detail && (
        <p className="mt-1 break-all text-xs text-gray-500" title={state.detail}>{state.detail}</p>
      )}
    </div>
  )
}

function helpScoutFailMessage(reason: HelpScoutFailReason): string {
  switch (reason) {
    case 'missing_env_vars':
      return 'Credentials not set — see Supabase dashboard'
    case 'auth_failed':
      return 'Authentication failed — check HELPSCOUT_APP_SECRET'
    case 'api_unreachable':
      return 'Help Scout unreachable, try again'
    case 'unexpected_error':
      return 'Test failed'
  }
}

function Dot({ color }: { color: 'amber' | 'green' | 'red' }) {
  const cls = color === 'green'
    ? 'bg-emerald-500'
    : color === 'red'
      ? 'bg-rose-500'
      : 'bg-amber-400'
  return <span aria-hidden className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${cls}`} />
}

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

// Local copy of the app-wide toggle (gray-900 / gray-200, h-6 w-11,
// role="switch") matching the AdminTemplatesSection toggle so the
// Customer-approvals flow gate visually echoes the Send-replies gate.
function Toggle({
  value, onChange, disabled = false, label,
}: {
  value: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!value)}
      className={[
        'relative inline-flex h-6 w-11 shrink-0 rounded-full transition-colors',
        value ? 'bg-gray-900' : 'bg-gray-200',
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
      ].join(' ')}
    >
      <span
        className={[
          'inline-block h-5 w-5 translate-y-0.5 transform rounded-full bg-white transition-transform',
          value ? 'translate-x-[1.375rem]' : 'translate-x-0.5',
        ].join(' ')}
      />
    </button>
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
    vat_rate_gbp: 'UK VAT rate (GBP)',
    approvals_enabled: 'Customer-facing approval flow enabled',
    approve_confirmation_copy: 'Approve confirmation copy',
    request_changes_confirmation_copy: 'Request changes confirmation copy',
  }[field]
}

// One row in the materials list. Pulled out so the active and
// archived sections can share layout; `muted` greys the whole row +
// replaces the Published/Unpublished pill with an Archived badge.
function renderMaterialRow(
  m: MaterialContent,
  i: number,
  openEditor: (m: MaterialContent) => void,
  muted: boolean,
): React.ReactNode {
  return (
    <div
      key={m.id}
      className={[
        'flex items-center gap-4 px-4 py-3',
        i > 0 ? 'border-t border-gray-100' : '',
        muted ? 'opacity-70' : '',
      ].join(' ')}
    >
      <div className={[
        'flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded bg-gray-50 ring-1 ring-gray-200',
        muted ? 'grayscale' : '',
      ].join(' ')}>
        {m.icon_url
          ? <img src={m.icon_url} alt="" className="max-h-full max-w-full object-contain" />
          : <svg viewBox="0 0 16 16" className="h-4 w-4 text-gray-300" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 12l3-4 3 3 3-5 3 4" strokeLinecap="round" strokeLinejoin="round" /></svg>}
      </div>
      <div className="min-w-0 flex-1">
        <div className={[
          'truncate text-sm font-semibold',
          muted ? 'italic text-gray-500' : 'text-gray-900',
        ].join(' ')}>
          {m.display_name}
        </div>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {muted ? (
            <span className="inline-block rounded-full bg-gray-200 px-2 py-0.5 text-xs font-semibold text-gray-700">
              Archived
            </span>
          ) : m.is_published ? (
            <span className="inline-block rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700">Published</span>
          ) : (
            <span className="inline-block rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">Unpublished</span>
          )}
          {!m.description && !muted && (
            <span className="inline-block rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-500">
              Needs content
            </span>
          )}
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap justify-end gap-2">
        <button
          onClick={() => openEditor(m)}
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
  )
}

const inputClass = 'w-full rounded-lg border border-gray-300 px-3 py-2 text-[17px] sm:text-sm focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900'
