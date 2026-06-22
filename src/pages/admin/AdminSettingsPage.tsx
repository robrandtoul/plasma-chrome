import { useEffect, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { logAudit } from '../../lib/audit'
import { invalidatePublicSettings } from '../../lib/publicSettings'
import { invalidateApprovalSettings } from '../../lib/approvalSettings'
import { invalidateShippingSettings } from '../../lib/shippingSettings'
import { invalidateOrderingEnabled } from '../../lib/orderingEnabled'
import { FieldRow, inputClass } from './settingsControls'

// /admin/settings — the operational cards only: Customer approvals,
// Designer defaults, Help Scout, Shipping. The customer-facing copy
// fields moved to /admin/site-copy and the reply templates to
// /admin/templates; each page loads just the settings columns it owns.

// ── Types ────────────────────────────────────────────────────────────────────

type PricingDisplayValue = 'standard' | 'custom_quote'
type CurrencyValue = 'GBP' | 'EUR' | 'USD'

interface Settings {
  /** null means "no default — force the designer to choose". */
  default_pricing_display: PricingDisplayValue | null
  default_currency: CurrencyValue | null
  /** Phase 2 customer approval flow (migration 000116). */
  approvals_enabled: boolean
  approve_confirmation_copy: string
  request_changes_confirmation_copy: string
  /** Ordering & checkout master switch (migration 000228). Off keeps the
   *  whole ordering feature inert — no "Create order" button, no pay-page. */
  ordering_enabled: boolean
  /** Unpaid-order reminder automation switch (migration 000238). Off keeps
   *  the send-order-reminders job in dry-run (logs only, sends nothing). */
  auto_order_reminders_enabled: boolean
  /** Stripe payment mode (migration 000241): 'test' (sandbox) or 'live'. The
   *  checkout functions read this to pick which Stripe key set to use. */
  payment_mode: 'test' | 'live'
  /** Xero account code of the Stripe clearing account (migration 000242). When
   *  set, paid orders are marked paid in Xero instantly. Null = create-only. */
  xero_stripe_account_code: string | null
  /** Shipping (migration 000178). */
  fedex_box_weight_grams: number
  fedex_intl_adjust_percent: number
  /** Domestic UK flat rates (migration 000179), GBP VAT-inclusive. */
  domestic_uk_mainland_rate_gbp: number
  domestic_uk_ni_rate_gbp: number
  /** US tariff & customs handling (migration 000249). Per-currency fee added
   *  by default to US-bound orders, the Xero item code its invoice line books
   *  to, and the customer-facing pay-page copy. A 0 fee disables the service. */
  us_tariff_fee_gbp: number
  us_tariff_fee_eur: number
  us_tariff_fee_usd: number
  xero_us_tariff_item_code: string
  us_tariff_intro_copy: string
  us_tariff_optout_warning: string
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

// Shape returned by the payments-status edge function (go-live readiness).
interface PaymentsStatus {
  stripe: {
    mode: 'test' | 'live'
    selectedKeyKind: 'test' | 'live' | 'unknown' | 'absent'
    testKeyPresent: boolean
    liveKeyPresent: boolean
    webhookTestSecretPresent: boolean
    webhookLiveSecretPresent: boolean
    consistent: boolean
  }
  xero: {
    connected: boolean
    orgName: string | null
    isDemoCompany: boolean | null
    baseCurrency: string | null
    error: string | null
  }
  verdict: 'test' | 'ready' | 'danger' | 'incomplete'
  bankAccounts?: { name: string; code: string }[]
  stripeAccountCode?: string | null
}

/** Stable audit action string per field. */
const AUDIT_ACTION: Record<keyof Settings, string> = {
  default_pricing_display:           'setting.default_pricing_display_updated',
  default_currency:                  'setting.default_currency_updated',
  approvals_enabled:                 'setting.approvals_enabled_updated',
  approve_confirmation_copy:         'setting.approve_confirmation_copy_updated',
  request_changes_confirmation_copy: 'setting.request_changes_confirmation_copy_updated',
  ordering_enabled:                  'setting.ordering_enabled_updated',
  auto_order_reminders_enabled:      'setting.auto_order_reminders_enabled_updated',
  payment_mode:                      'setting.payment_mode_updated',
  xero_stripe_account_code:          'setting.xero_stripe_account_code_updated',
  fedex_box_weight_grams:            'setting.fedex_box_weight_grams_updated',
  fedex_intl_adjust_percent:         'setting.fedex_intl_adjust_percent_updated',
  domestic_uk_mainland_rate_gbp:     'setting.domestic_uk_mainland_rate_gbp_updated',
  domestic_uk_ni_rate_gbp:           'setting.domestic_uk_ni_rate_gbp_updated',
  us_tariff_fee_gbp:                 'setting.us_tariff_fee_gbp_updated',
  us_tariff_fee_eur:                 'setting.us_tariff_fee_eur_updated',
  us_tariff_fee_usd:                 'setting.us_tariff_fee_usd_updated',
  xero_us_tariff_item_code:          'setting.xero_us_tariff_item_code_updated',
  us_tariff_intro_copy:              'setting.us_tariff_intro_copy_updated',
  us_tariff_optout_warning:          'setting.us_tariff_optout_warning_updated',
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

  // Xero connect (Ordering & checkout, Step 5b). Kicks off the one-time
  // OAuth authorisation; the returned consent URL opens in a new tab and
  // Xero redirects to the callback function, which stores the tokens.
  const [xeroBusy, setXeroBusy] = useState(false)
  const [xeroMsg, setXeroMsg] = useState<string | null>(null)

  async function connectXero() {
    if (xeroBusy) return
    setXeroBusy(true)
    setXeroMsg(null)
    const { data, error } = await supabase.functions.invoke<{ url?: string; error?: string }>('xero-oauth-start')
    setXeroBusy(false)
    if (error || !data || data.error || !data.url) {
      setXeroMsg(data?.error ?? 'Could not start the Xero connection. Check the Xero credentials are set.')
      return
    }
    window.open(data.url, '_blank', 'noopener')
    setXeroMsg(`Opened Xero in a new tab — authorise there. If it errors, copy this exact URL and send it over:\n\n${data.url}`)
  }

  // Payments & accounting status (go-live readiness). Read once on mount and
  // on demand — shows which Stripe mode + Xero org the pipeline is pointed at,
  // and flags a money/books mismatch.
  const [payStatus, setPayStatus] = useState<PaymentsStatus | null>(null)
  const [payStatusLoading, setPayStatusLoading] = useState(false)

  async function loadPaymentsStatus() {
    setPayStatusLoading(true)
    const { data, error } = await supabase.functions.invoke<PaymentsStatus>('payments-status', { body: {} })
    setPayStatusLoading(false)
    if (!error && data) setPayStatus(data)
  }

  // Switch Stripe mode. Going LIVE charges real cards, so it gets a hard
  // confirm; going back to test is unguarded. Refreshes the status panel after.
  async function changePaymentMode(next: 'test' | 'live') {
    if (!settings || next === settings.payment_mode) return
    if (next === 'live') {
      const ok = window.confirm(
        'Switch Stripe to LIVE mode?\n\nReal customer cards will be charged real money. Before continuing, make sure:\n• the live Stripe key (sk_live_…) is set in the environment, and\n• Xero is connected to your REAL organisation, not the Demo Company.\n\nThe status panel below will flag a mismatch if not.',
      )
      if (!ok) return
    }
    await saveField('payment_mode', next)
    void loadPaymentsStatus()
  }

  // Enabling ordering while Stripe is still in test mode means a real customer
  // who opens a pay-link gets a sandbox checkout they can't actually pay —
  // fine for internal testing, worth a heads-up before it's on.
  async function changeOrderingEnabled(v: boolean) {
    if (!settings) return
    if (v && settings.payment_mode === 'test') {
      const ok = window.confirm(
        'Enable ordering while Stripe is in TEST mode?\n\nA real customer who opens a pay-link will get a sandbox checkout and cannot actually pay. This is fine for internal testing, but switch Stripe to LIVE before sending real customers a payment link.',
      )
      if (!ok) return
    }
    await saveField('ordering_enabled', v)
  }

  useEffect(() => { load(); void loadPaymentsStatus() }, [])

  async function load() {
    const { data, error } = await supabase
      .from('settings')
      .select('default_pricing_display, default_currency, approvals_enabled, approve_confirmation_copy, request_changes_confirmation_copy, ordering_enabled, auto_order_reminders_enabled, payment_mode, xero_stripe_account_code, fedex_box_weight_grams, fedex_intl_adjust_percent, domestic_uk_mainland_rate_gbp, domestic_uk_ni_rate_gbp, us_tariff_fee_gbp, us_tariff_fee_eur, us_tariff_fee_usd, xero_us_tariff_item_code, us_tariff_intro_copy, us_tariff_optout_warning')
      .eq('id', 1)
      .single()
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
    if (field === 'ordering_enabled') {
      invalidateOrderingEnabled()
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
      | 'domestic_uk_ni_rate_gbp'
      | 'us_tariff_fee_gbp'
      | 'us_tariff_fee_eur'
      | 'us_tariff_fee_usd',
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
      // domestic UK rates + US tariff fees — non-negative amounts
      if (value < 0) {
        setErrors((e) => ({ ...e, [field]: 'Must be zero or greater.' }))
        return
      }
    }
    if (errors[field]) setErrors((e) => ({ ...e, [field]: undefined }))
    void saveField(field, value)
  }

  // Blur handler for the US tariff text fields (Xero item code + the two
  // pay-page copy strings). Saves the trimmed draft; empty is allowed —
  // publicSettings.ts and invoiceBuild fall back to the shipped defaults / item
  // 910, so clearing a field resets it to default rather than breaking the page.
  function onTariffTextBlur(
    field: 'xero_us_tariff_item_code' | 'us_tariff_intro_copy' | 'us_tariff_optout_warning',
  ) {
    if (!settings) return
    const draft = drafts[field]
    if (draft === undefined) return
    void saveField(field, (draft as string).trim())
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

      {/* ── Ordering & checkout (migration 000228) ────────────────────
          Master switch for the Ordering & checkout feature. Off (the
          default) keeps the whole feature inert — no "Create order"
          button on approved proofs, no customer pay-page. Built behind
          this gate so the existing approve → manual-Xero-invoice flow is
          unaffected until Rob turns ordering on. See
          docs/ordering-checkout-spec.md. */}
      <section className="rounded-2xl bg-surface p-6 shadow-sm ring-1 ring-line">
        <h3 className="mb-4 text-sm font-semibold text-ink">Ordering &amp; checkout</h3>
        <div className="space-y-5">
          <FieldRow
            label="Ordering &amp; checkout enabled"
            help="When off, nothing changes — designers carry on sending invoices the existing way. Turn on to reveal the Create order builder on approved proofs and activate the customer pay-page. Leave off until the ordering feature is ready to go live."
            saved={recentlySaved('ordering_enabled')}
            working={working.ordering_enabled}
            error={errors.ordering_enabled}
          >
            <Toggle
              value={settings.ordering_enabled}
              onChange={(v) => void changeOrderingEnabled(v)}
              disabled={!!working.ordering_enabled}
              label="Ordering & checkout enabled"
            />
          </FieldRow>

          <FieldRow
            label="Send unpaid-order reminders automatically"
            help="When on, a customer who's been sent an order link but hasn't paid gets up to two gentle email reminders on their Help Scout thread — a first nudge about a week after the link is sent, and a second just before the link expires. The moment they pay (or the link expires) the reminders stop. When off (the default), the daily job still runs but only logs what it would have sent — nothing is emailed. Edit the wording under Templates → Order messages. Saves immediately."
            saved={recentlySaved('auto_order_reminders_enabled')}
            working={working.auto_order_reminders_enabled}
            error={errors.auto_order_reminders_enabled}
          >
            <Toggle
              value={settings.auto_order_reminders_enabled}
              onChange={(v) => void saveField('auto_order_reminders_enabled', v)}
              disabled={!!working.auto_order_reminders_enabled}
              label="Send unpaid-order reminders automatically"
            />
          </FieldRow>

          {/* Stripe payment mode (migration 000241). Test = sandbox (fake
              money); Live = real cards charged. Going live charges real money,
              so the switch confirms first. The status panel below shows whether
              the keys behind each mode are actually present + consistent. */}
          <FieldRow
            label="Stripe payment mode"
            help="Test uses the Stripe sandbox — no real money moves. Live charges real customer cards. Switching to Live needs the live Stripe key set in the environment and Xero connected to your real organisation. Use the status panel below to confirm before and after switching."
            saved={recentlySaved('payment_mode')}
            working={working.payment_mode}
            error={errors.payment_mode}
          >
            <div className="inline-flex overflow-hidden rounded-lg ring-1 ring-line">
              {(['test', 'live'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => void changePaymentMode(m)}
                  disabled={!!working.payment_mode}
                  className={[
                    'px-4 py-2 text-sm font-medium capitalize transition-colors disabled:opacity-50',
                    settings.payment_mode === m
                      ? (m === 'live' ? 'bg-out text-on-ink' : 'bg-ink text-on-ink')
                      : 'bg-surface text-ink-soft hover:bg-canvas',
                  ].join(' ')}
                >
                  {m === 'live' ? 'Live (real money)' : 'Test (sandbox)'}
                </button>
              ))}
            </div>
          </FieldRow>

          {/* Payments & accounting status — the go-live readiness panel. Shows
              which Stripe mode + Xero org the pipeline is actually pointed at,
              and flags a money/books mismatch (the dangerous state). */}
          <div className="border-t border-line-soft pt-5">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-medium text-ink">Payments &amp; accounting status</p>
              <button
                type="button"
                onClick={() => void loadPaymentsStatus()}
                disabled={payStatusLoading}
                className="rounded px-2.5 py-1 text-[13px] font-medium text-ink-soft ring-1 ring-line hover:bg-canvas disabled:opacity-50"
              >
                {payStatusLoading ? 'Checking…' : 'Refresh'}
              </button>
            </div>
            {payStatus ? (
              <div className="mt-3 space-y-2">
                {(() => {
                  const v = payStatus.verdict
                  const banner = v === 'ready'
                    ? { cls: 'bg-in-stock-soft text-in-stock ring-in-stock', text: 'Live & consistent — real payments will invoice into your live Xero org.' }
                    : v === 'test'
                      ? { cls: 'bg-low-soft text-low ring-low', text: 'Sandbox — everything is in test mode. No real money moves. Safe to test.' }
                      : v === 'danger'
                        ? { cls: 'bg-out-soft text-out ring-out', text: 'Mismatch — one side is live and the other is not. Fix before taking real orders.' }
                        : { cls: 'bg-out-soft text-out ring-out', text: 'Incomplete — a key or connection needed for this mode is missing.' }
                  return (
                    <div className={`rounded-lg px-3 py-2 text-[13px] font-medium ring-1 ${banner.cls}`}>{banner.text}</div>
                  )
                })()}
                <dl className="grid grid-cols-1 gap-1.5 text-[13px] sm:grid-cols-2">
                  <div className="flex items-center justify-between gap-2 rounded-lg bg-canvas px-3 py-2">
                    <dt className="text-ink-mute">Stripe mode</dt>
                    <dd className="font-medium text-ink">
                      {payStatus.stripe.mode === 'live' ? 'Live' : 'Test'}
                      {!payStatus.stripe.consistent && (
                        <span className="ml-1 text-out">· key is {payStatus.stripe.selectedKeyKind}</span>
                      )}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-2 rounded-lg bg-canvas px-3 py-2">
                    <dt className="text-ink-mute">Xero organisation</dt>
                    <dd className="font-medium text-ink">
                      {!payStatus.xero.connected
                        ? 'Not connected'
                        : payStatus.xero.orgName ?? 'Connected'}
                      {payStatus.xero.isDemoCompany === true && (
                        <span className="ml-1 rounded-full bg-out-soft px-1.5 py-0.5 text-[11px] font-medium text-out">DEMO</span>
                      )}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-2 rounded-lg bg-canvas px-3 py-2">
                    <dt className="text-ink-mute">Stripe keys present</dt>
                    <dd className="font-medium text-ink">
                      test {payStatus.stripe.testKeyPresent ? '✓' : '—'} · live {payStatus.stripe.liveKeyPresent ? '✓' : '—'}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-2 rounded-lg bg-canvas px-3 py-2">
                    <dt className="text-ink-mute">Webhook secrets</dt>
                    <dd className="font-medium text-ink">
                      test {payStatus.stripe.webhookTestSecretPresent ? '✓' : '—'} · live {payStatus.stripe.webhookLiveSecretPresent ? '✓' : '—'}
                    </dd>
                  </div>
                </dl>
                {payStatus.xero.error && (
                  <p className="text-[12px] text-ink-mute">Xero: {payStatus.xero.error}</p>
                )}
              </div>
            ) : (
              <p className="mt-2 text-[13px] text-ink-mute">{payStatusLoading ? 'Checking…' : 'Status unavailable — press Refresh.'}</p>
            )}
          </div>

          {/* Xero connection (Step 5b): paid orders create an invoice in
              the connected Xero org. One-time OAuth authorise. */}
          <div className="border-t border-line-soft pt-5">
            <p className="text-sm font-medium text-ink">Xero connection</p>
            <p className="mt-1 text-[13px] text-ink-mute">
              Connect your Xero organisation so a paid order creates an invoice automatically. Connect to your Demo Company to test; reconnect to your real organisation to go live. After reconnecting, press Refresh on the status panel above to confirm which org is live.
            </p>
            <button
              type="button"
              onClick={() => void connectXero()}
              disabled={xeroBusy}
              className="mt-3 rounded px-3 py-2 text-sm font-medium text-ink-soft ring-1 ring-line hover:bg-canvas disabled:opacity-50"
            >
              {xeroBusy ? 'Starting…' : 'Connect Xero'}
            </button>
            {xeroMsg && <p className="mt-2 whitespace-pre-wrap break-all text-[13px] text-ink-soft">{xeroMsg}</p>}
          </div>

          {/* Stripe clearing account (migration 000242). When set, paid orders
              are marked PAID in Xero instantly (payment recorded into this
              account; the Stripe feed reconciles against it). Options come from
              the connected org's bank accounts via payments-status. */}
          <div className="border-t border-line-soft pt-5">
            <FieldRow
              label="Mark invoices paid in Xero"
              help="Choose your Stripe clearing account (the Xero bank account that receives Stripe funds). When set, a paid order's Xero invoice is marked paid immediately, matching Xero's own Pay-now flow; the Stripe feed later reconciles against it. Leave as 'Don't record' to only create the invoice and let the bank feed settle it (~a day)."
              saved={recentlySaved('xero_stripe_account_code')}
              working={working.xero_stripe_account_code}
              error={errors.xero_stripe_account_code}
            >
              {payStatus?.bankAccounts && payStatus.bankAccounts.length > 0 ? (
                <select
                  value={settings.xero_stripe_account_code ?? ''}
                  onChange={(e) => void saveField('xero_stripe_account_code', e.target.value || null)}
                  disabled={!!working.xero_stripe_account_code}
                  className="h-[38px] w-full max-w-sm rounded-[8px] border border-line bg-surface px-3 text-sm text-ink focus:border-[var(--c-brand)] focus:outline-2 focus:outline-offset-1 focus:outline-[var(--c-brand)]"
                >
                  <option value="">Don&rsquo;t record payment (create invoice only)</option>
                  {payStatus.bankAccounts.map((a) => (
                    <option key={a.code} value={a.code}>{a.name} ({a.code})</option>
                  ))}
                </select>
              ) : (
                <p className="text-[13px] text-ink-mute">
                  {payStatus?.xero.connected
                    ? 'No bank accounts found on the connected Xero org. Press Refresh on the status panel, or add a Stripe clearing account in Xero.'
                    : 'Connect Xero (above) to choose the Stripe clearing account.'}
                </p>
              )}
            </FieldRow>
          </div>
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
            className="shrink-0 rounded px-3 py-2 text-sm font-medium text-ink-soft ring-1 ring-line hover:bg-canvas disabled:opacity-50"
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

      {/* ── US tariff & customs handling (migration 000249) ───────────
          The flat service added by default to US-bound orders, covering
          import tariffs + customs clearance. Fee per currency, the Xero item
          code the invoice line books to, and the customer-facing pay-page
          copy. A 0 fee disables the service for that currency. */}
      <section className="rounded-2xl bg-surface p-6 shadow-sm ring-1 ring-line">
        <h3 className="mb-1 text-sm font-semibold text-ink">US tariff &amp; customs handling</h3>
        <p className="mb-4 text-[13px] text-ink-mute">
          Added by default to orders shipping to the US — the customer can opt out at checkout. US orders are billed in USD in practice; the GBP/EUR fees cover the rare non-USD US order. Set a fee to 0 to switch the service off for that currency.
        </p>
        <div className="space-y-5">
          <FieldRow
            label="Fee — USD ($)"
            help="The flat US tariff & customs handling charge on US orders billed in USD. The customer sees this as its own line and can opt out."
            saved={recentlySaved('us_tariff_fee_usd')}
            working={working.us_tariff_fee_usd}
            error={errors.us_tariff_fee_usd}
          >
            <input
              type="number"
              min={0}
              step={0.01}
              inputMode="decimal"
              value={drafts.us_tariff_fee_usd ?? settings.us_tariff_fee_usd}
              onChange={(e) => setDrafts((d) => ({ ...d, us_tariff_fee_usd: e.target.value === '' ? 0 : Number(e.target.value) }))}
              onBlur={() => onShippingNumberBlur('us_tariff_fee_usd')}
              className={`w-32 ${inputClass}`}
            />
          </FieldRow>

          <FieldRow
            label="Fee — GBP (£)"
            help="Used when a US-bound order is billed in GBP (rare). VAT treatment is set by the Xero item code below, not here."
            saved={recentlySaved('us_tariff_fee_gbp')}
            working={working.us_tariff_fee_gbp}
            error={errors.us_tariff_fee_gbp}
          >
            <input
              type="number"
              min={0}
              step={0.01}
              inputMode="decimal"
              value={drafts.us_tariff_fee_gbp ?? settings.us_tariff_fee_gbp}
              onChange={(e) => setDrafts((d) => ({ ...d, us_tariff_fee_gbp: e.target.value === '' ? 0 : Number(e.target.value) }))}
              onBlur={() => onShippingNumberBlur('us_tariff_fee_gbp')}
              className={`w-32 ${inputClass}`}
            />
          </FieldRow>

          <FieldRow
            label="Fee — EUR (€)"
            help="Used when a US-bound order is billed in EUR (rare)."
            saved={recentlySaved('us_tariff_fee_eur')}
            working={working.us_tariff_fee_eur}
            error={errors.us_tariff_fee_eur}
          >
            <input
              type="number"
              min={0}
              step={0.01}
              inputMode="decimal"
              value={drafts.us_tariff_fee_eur ?? settings.us_tariff_fee_eur}
              onChange={(e) => setDrafts((d) => ({ ...d, us_tariff_fee_eur: e.target.value === '' ? 0 : Number(e.target.value) }))}
              onBlur={() => onShippingNumberBlur('us_tariff_fee_eur')}
              className={`w-32 ${inputClass}`}
            />
          </FieldRow>

          <FieldRow
            label="Xero item code"
            help="The Xero ItemCode the tariff line invoices as (pre-existing item 910). Xero derives the tax rate — set up as an export / no-VAT item — from this code. Leave blank to fall back to 910."
            saved={recentlySaved('xero_us_tariff_item_code')}
            working={working.xero_us_tariff_item_code}
            error={errors.xero_us_tariff_item_code}
          >
            <input
              type="text"
              value={drafts.xero_us_tariff_item_code ?? settings.xero_us_tariff_item_code}
              onChange={(e) => setDrafts((d) => ({ ...d, xero_us_tariff_item_code: e.target.value }))}
              onBlur={() => onTariffTextBlur('xero_us_tariff_item_code')}
              className={`w-32 ${inputClass}`}
            />
          </FieldRow>

          <FieldRow
            label="Customer intro copy"
            help="Shown to the customer on the pay-page above the charge. The fee amount is shown on its own line, so leave it out of this text. Plain text, no markdown."
            saved={recentlySaved('us_tariff_intro_copy')}
            working={working.us_tariff_intro_copy}
            error={errors.us_tariff_intro_copy}
          >
            <textarea
              value={drafts.us_tariff_intro_copy ?? settings.us_tariff_intro_copy}
              onChange={(e) => setDrafts((d) => ({ ...d, us_tariff_intro_copy: e.target.value }))}
              onBlur={() => onTariffTextBlur('us_tariff_intro_copy')}
              rows={4}
              className={inputClass}
            />
          </FieldRow>

          <FieldRow
            label="Opt-out warning copy"
            help="Shown when the customer chooses to remove the charge, to confirm the consequence: they deal with US Customs and any tariffs themselves. Plain text, no markdown."
            saved={recentlySaved('us_tariff_optout_warning')}
            working={working.us_tariff_optout_warning}
            error={errors.us_tariff_optout_warning}
          >
            <textarea
              value={drafts.us_tariff_optout_warning ?? settings.us_tariff_optout_warning}
              onChange={(e) => setDrafts((d) => ({ ...d, us_tariff_optout_warning: e.target.value }))}
              onBlur={() => onTariffTextBlur('us_tariff_optout_warning')}
              rows={3}
              className={inputClass}
            />
          </FieldRow>
        </div>
      </section>
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
    default_pricing_display: 'Default pricing display',
    default_currency: 'Default currency',
    approvals_enabled: 'Customer-facing approval flow enabled',
    approve_confirmation_copy: 'Approve confirmation copy',
    request_changes_confirmation_copy: 'Request changes confirmation copy',
    ordering_enabled: 'Ordering & checkout enabled',
    auto_order_reminders_enabled: 'Send unpaid-order reminders automatically',
    payment_mode: 'Stripe payment mode',
    xero_stripe_account_code: 'Xero Stripe clearing account',
    fedex_box_weight_grams: 'FedEx box weight (grams)',
    fedex_intl_adjust_percent: 'International shipping adjustment (%)',
    domestic_uk_mainland_rate_gbp: 'UK mainland shipping rate (£, inc VAT)',
    domestic_uk_ni_rate_gbp: 'Northern Ireland shipping rate (£, inc VAT)',
    us_tariff_fee_gbp: 'US tariff fee (GBP)',
    us_tariff_fee_eur: 'US tariff fee (EUR)',
    us_tariff_fee_usd: 'US tariff fee (USD)',
    xero_us_tariff_item_code: 'US tariff Xero item code',
    us_tariff_intro_copy: 'US tariff intro copy',
    us_tariff_optout_warning: 'US tariff opt-out warning',
  }[field]
}
