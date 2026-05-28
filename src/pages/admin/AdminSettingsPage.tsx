import { useEffect, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { logAudit } from '../../lib/audit'
import { invalidatePublicSettings } from '../../lib/publicSettings'
import { invalidateApprovalSettings } from '../../lib/approvalSettings'
import { invalidateShippingSettings } from '../../lib/shippingSettings'
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
  /** Phase 2 customer approval flow (migration 000116). */
  approvals_enabled: boolean
  approve_confirmation_copy: string
  request_changes_confirmation_copy: string
  /** Shipping (migration 000178). */
  fedex_box_weight_grams: number
  fedex_intl_adjust_percent: number
  /** Domestic UK flat rates (migration 000179), GBP VAT-inclusive. */
  domestic_uk_mainland_rate_gbp: number
  domestic_uk_ni_rate_gbp: number
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
  approvals_enabled:                 'setting.approvals_enabled_updated',
  approve_confirmation_copy:         'setting.approve_confirmation_copy_updated',
  request_changes_confirmation_copy: 'setting.request_changes_confirmation_copy_updated',
  fedex_box_weight_grams:            'setting.fedex_box_weight_grams_updated',
  fedex_intl_adjust_percent:         'setting.fedex_intl_adjust_percent_updated',
  domestic_uk_mainland_rate_gbp:     'setting.domestic_uk_mainland_rate_gbp_updated',
  domestic_uk_ni_rate_gbp:           'setting.domestic_uk_ni_rate_gbp_updated',
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

  useEffect(() => { load() }, [])

  async function load() {
    const { data, error } = await supabase.from('settings').select('*').eq('id', 1).single()
    if (error || !data) { setLoadError(error?.message ?? 'Settings row missing'); return }
    setSettings(data as Settings)
    setDrafts({})
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
    if (
      field === 'approvals_enabled' ||
      field === 'approve_confirmation_copy' ||
      field === 'request_changes_confirmation_copy'
    ) {
      invalidateApprovalSettings()
    }
    if (
      field === 'fedex_box_weight_grams'
      || field === 'fedex_intl_adjust_percent'
      || field === 'domestic_uk_mainland_rate_gbp'
      || field === 'domestic_uk_ni_rate_gbp'
    ) {
      invalidateShippingSettings()
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

  // Blur handler for the Shipping number inputs. Validates the
  // draft is a finite number within the column's CHECK range, then
  // saves the rounded value (whole grams for the box; 2dp percent
  // for the adjustment so 7.5% works but stray decimals don't).
  // On invalid input we surface a pill rather than silently snapping
  // back — same philosophy as onConfirmationCopyBlur above.
  function onShippingNumberBlur(
    field:
      | 'fedex_box_weight_grams'
      | 'fedex_intl_adjust_percent'
      | 'domestic_uk_mainland_rate_gbp'
      | 'domestic_uk_ni_rate_gbp',
  ) {
    if (!settings) return
    const draft = drafts[field]
    if (draft === undefined) return
    const value = Number(draft)
    if (!Number.isFinite(value)) {
      setErrors((e) => ({ ...e, [field]: 'Must be a number.' }))
      return
    }
    if (field === 'fedex_box_weight_grams') {
      if (!Number.isInteger(value) || value < 0) {
        setErrors((e) => ({ ...e, [field]: 'Whole grams, zero or greater.' }))
        return
      }
    } else if (field === 'fedex_intl_adjust_percent') {
      if (value < -100 || value > 100) {
        setErrors((e) => ({ ...e, [field]: 'Between -100 and 100.' }))
        return
      }
    } else {
      // domestic UK rates — non-negative GBP amounts
      if (value < 0) {
        setErrors((e) => ({ ...e, [field]: 'Must be zero or greater.' }))
        return
      }
    }
    if (errors[field]) setErrors((e) => ({ ...e, [field]: undefined }))
    void saveField(field, value)
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
        <h2 className="text-xl font-bold text-ink">Settings</h2>
        <p className="mt-1 text-sm text-ink-mute">
          Changes save automatically. Customer-facing values update within a minute.
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
        </div>
      </section>

      {/* ── Customer approvals (Phase 2) ──────────────────────────── */}
      <section className="rounded-2xl bg-surface p-6 shadow-sm ring-1 ring-line">
        <h3 className="mb-4 text-sm font-semibold text-ink">Customer approvals</h3>
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
      <section className="rounded-2xl bg-surface p-6 shadow-sm ring-1 ring-line">
        <h3 className="mb-4 text-sm font-semibold text-ink">Designer defaults</h3>
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

      {/* ── Integrations ─────────────────────────────────────────
          Help Scout panel — admin clicks Test connection to run the
          full OAuth + /v2/mailboxes round trip. Three indicator
          states (untested amber / connected green / failed red),
          mailbox name surfaced when available, distinct failure
          messages keyed off the structured `reason` returned by
          admin-test-helpscout. State is component-scoped — leaving
          and returning resets to "Not tested this session". */}
      <section className="rounded-2xl bg-surface p-6 shadow-sm ring-1 ring-line">
        <h3 className="mb-4 text-sm font-semibold text-ink">Help Scout</h3>

        <div className="flex flex-wrap items-start gap-4">
          <div className="flex-1 min-w-[15rem]">
            <HelpScoutStatusRow state={hsTestState} />
            <p className="mt-3 text-xs text-ink-mute">
              To update Help Scout credentials, open the Supabase dashboard → Project Settings → Edge Functions → Secrets and update <code className="rounded bg-canvas px-1 py-0.5 font-mono text-[11px]">HELPSCOUT_APP_ID</code> and <code className="rounded bg-canvas px-1 py-0.5 font-mono text-[11px]">HELPSCOUT_APP_SECRET</code>. After updating, click Test connection to verify.
            </p>
          </div>
          <button
            onClick={testHelpScout}
            disabled={hsTesting}
            className="shrink-0 rounded-lg px-3 py-2 text-sm font-medium text-ink-soft ring-1 ring-line hover:bg-canvas disabled:opacity-50"
          >
            {hsTesting ? 'Testing…' : 'Test connection'}
          </button>
        </div>
      </section>

      {/* ── Shipping (migration 000178) ──────────────────────────
          FedEx box tare weight and the international % adjustment
          applied on top of FedEx-quoted shipping totals in the Quote
          compiler. Both round-trip through the same saveField path
          as the other settings; on success the shippingSettings
          cache is invalidated so other open tabs pick the change up
          faster than the 60s TTL. Customer-facing pages are
          unaffected. */}
      <section className="rounded-2xl bg-surface p-6 shadow-sm ring-1 ring-line">
        <h3 className="mb-4 text-sm font-semibold text-ink">Shipping</h3>
        <div className="space-y-5">
          <FieldRow
            label="FedEx box weight (grams)"
            help="Weight of an empty FedEx box in grams. Added to the per-card weight × quantity figure to produce the parcel weight sent to FedEx for a rate request. Only used by the Quote compiler; customer-facing pages don't see this."
            saved={recentlySaved('fedex_box_weight_grams')}
            working={working.fedex_box_weight_grams}
            error={errors.fedex_box_weight_grams}
          >
            <input
              type="number"
              min={0}
              step={1}
              inputMode="numeric"
              value={drafts.fedex_box_weight_grams ?? settings.fedex_box_weight_grams}
              onChange={(e) => setDrafts((d) => ({ ...d, fedex_box_weight_grams: e.target.value === '' ? 0 : Number(e.target.value) }))}
              onBlur={() => onShippingNumberBlur('fedex_box_weight_grams')}
              className={`w-32 ${inputClass}`}
            />
          </FieldRow>

          <FieldRow
            label="International shipping adjustment (%)"
            help="Percentage applied to FedEx-quoted shipping totals in the Quote compiler. Positive marks shipping up, negative marks down, 0 leaves the FedEx figure untouched. Applied at render time, so changes here take effect immediately."
            saved={recentlySaved('fedex_intl_adjust_percent')}
            working={working.fedex_intl_adjust_percent}
            error={errors.fedex_intl_adjust_percent}
          >
            <input
              type="number"
              min={-100}
              max={100}
              step={0.5}
              inputMode="decimal"
              value={drafts.fedex_intl_adjust_percent ?? settings.fedex_intl_adjust_percent}
              onChange={(e) => setDrafts((d) => ({ ...d, fedex_intl_adjust_percent: e.target.value === '' ? 0 : Number(e.target.value) }))}
              onBlur={() => onShippingNumberBlur('fedex_intl_adjust_percent')}
              className={`w-32 ${inputClass}`}
            />
          </FieldRow>

          <FieldRow
            label="UK mainland shipping rate (£, inc VAT)"
            help="Flat DPD rate for UK mainland deliveries, GBP VAT-inclusive. Triggered when the Quote compiler destination is United Kingdom and the postcode is anything other than a BT-prefix Northern Ireland code."
            saved={recentlySaved('domestic_uk_mainland_rate_gbp')}
            working={working.domestic_uk_mainland_rate_gbp}
            error={errors.domestic_uk_mainland_rate_gbp}
          >
            <input
              type="number"
              min={0}
              step={0.01}
              inputMode="decimal"
              value={drafts.domestic_uk_mainland_rate_gbp ?? settings.domestic_uk_mainland_rate_gbp}
              onChange={(e) => setDrafts((d) => ({ ...d, domestic_uk_mainland_rate_gbp: e.target.value === '' ? 0 : Number(e.target.value) }))}
              onBlur={() => onShippingNumberBlur('domestic_uk_mainland_rate_gbp')}
              className={`w-32 ${inputClass}`}
            />
          </FieldRow>

          <FieldRow
            label="Northern Ireland shipping rate (£, inc VAT)"
            help="Flat DPD rate for Northern Ireland deliveries, GBP VAT-inclusive. Triggered when the Quote compiler destination is United Kingdom and the postcode starts with BT."
            saved={recentlySaved('domestic_uk_ni_rate_gbp')}
            working={working.domestic_uk_ni_rate_gbp}
            error={errors.domestic_uk_ni_rate_gbp}
          >
            <input
              type="number"
              min={0}
              step={0.01}
              inputMode="decimal"
              value={drafts.domestic_uk_ni_rate_gbp ?? settings.domestic_uk_ni_rate_gbp}
              onChange={(e) => setDrafts((d) => ({ ...d, domestic_uk_ni_rate_gbp: e.target.value === '' ? 0 : Number(e.target.value) }))}
              onBlur={() => onShippingNumberBlur('domestic_uk_ni_rate_gbp')}
              className={`w-32 ${inputClass}`}
            />
          </FieldRow>

          <p className="text-xs text-ink-mute">
            To update FedEx credentials, open the Supabase dashboard → Project Settings → Edge Functions → Secrets and update <code className="rounded bg-canvas px-1 py-0.5 font-mono text-[11px]">FEDEX_API_KEY</code>, <code className="rounded bg-canvas px-1 py-0.5 font-mono text-[11px]">FEDEX_API_SECRET</code>, and <code className="rounded bg-canvas px-1 py-0.5 font-mono text-[11px]">FEDEX_ACCOUNT_NUMBER</code>.
          </p>
        </div>
      </section>

      {/* ── Reply templates ──────────────────────────────────── */}
      <AdminTemplatesSection />
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
        <span className="text-sm font-medium text-ink">Not tested this session</span>
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
          <span className="text-sm font-medium text-in-stock">Connected</span>
        </div>
        {state.mailboxName && (
          <p className="mt-1 text-xs text-ink-soft">
            Mailbox: <span className="font-medium text-ink">{state.mailboxName}</span>
          </p>
        )}
        {verifiedAt && (
          <p className="mt-0.5 text-xs text-ink-dim">Last verified at {verifiedAt}</p>
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
        <span className="text-sm font-medium text-out">Not connected — {message}</span>
      </div>
      {state.detail && (
        <p className="mt-1 break-all text-xs text-ink-mute" title={state.detail}>{state.detail}</p>
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
    ? 'bg-in-stock'
    : color === 'red'
      ? 'bg-out'
      : 'bg-low'
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
        <label className="text-sm font-medium text-ink-soft">{label}</label>
        {working && <span className="text-xs text-ink-dim">Saving…</span>}
        {saved && !working && <span className="text-xs text-in-stock">Saved</span>}
        {error && <span className="text-xs text-out">{error}</span>}
      </div>
      {children}
      <p className="mt-1.5 text-xs text-ink-mute">{help}</p>
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
        value ? 'bg-ink' : 'bg-line',
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
      ].join(' ')}
    >
      <span
        className={[
          'inline-block h-5 w-5 translate-y-0.5 transform rounded-full bg-surface transition-transform',
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
                ? 'bg-ink text-on-ink'
                : 'bg-surface text-ink-soft ring-1 ring-line hover:bg-canvas',
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
    approvals_enabled: 'Customer-facing approval flow enabled',
    approve_confirmation_copy: 'Approve confirmation copy',
    request_changes_confirmation_copy: 'Request changes confirmation copy',
    fedex_box_weight_grams: 'FedEx box weight (grams)',
    fedex_intl_adjust_percent: 'International shipping adjustment (%)',
    domestic_uk_mainland_rate_gbp: 'UK mainland shipping rate (£, inc VAT)',
    domestic_uk_ni_rate_gbp: 'Northern Ireland shipping rate (£, inc VAT)',
  }[field]
}

const inputClass = 'w-full rounded border border-line px-3 py-2 text-[17px] sm:text-sm focus:border-[var(--c-brand)] focus:bg-[var(--c-brand-50)] focus:outline-none'
