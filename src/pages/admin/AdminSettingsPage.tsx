import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { logAudit } from '../../lib/audit'
import { invalidatePublicSettings } from '../../lib/publicSettings'
import { invalidateApprovalSettings } from '../../lib/approvalSettings'
import { invalidateShippingSettings } from '../../lib/shippingSettings'
import { invalidateOrderingEnabled } from '../../lib/orderingEnabled'
import { invalidateReorderDeskSettings } from '../../lib/reorderDesk'
import { FieldRow, RadioGroup, Toggle, inputClass } from './settingsControls'

// /admin/settings — the operational cards only: Customer approvals,
// Designer defaults, Help Scout, Shipping. The customer-facing copy
// fields moved to /admin/site-copy and the reply templates to
// /admin/templates; each page loads just the settings columns it owns.

// ── Types ────────────────────────────────────────────────────────────────────

type PricingDisplayValue = 'standard' | 'custom_quote'
type CurrencyValue = 'GBP' | 'EUR' | 'USD'
type HandoffMode = 'off' | 'shadow' | 'live'

interface Settings {
  /** null means "no default — force the designer to choose". */
  default_pricing_display: PricingDisplayValue | null
  default_currency: CurrencyValue | null
  /** Phase 2 customer approval flow (migration 000116). */
  approvals_enabled: boolean
  proof_callouts_enabled: boolean
  proof_pins_enabled: boolean
  approve_confirmation_copy: string
  request_changes_confirmation_copy: string
  /** Ordering & checkout master switch (migration 000228). Off keeps the
   *  whole ordering feature inert — no "Create order" button, no pay-page. */
  ordering_enabled: boolean
  /** Unpaid-order reminder automation switch (migration 000238). Off keeps
   *  the send-order-reminders job in dry-run (logs only, sends nothing). */
  auto_order_reminders_enabled: boolean
  /** Unpaid-order reminder cadence (migration 000270). How many reminders an
   *  unpaid order may receive, and the days between them (counted from when the
   *  pay link was sent). Only consumed when auto_order_reminders_enabled is on. */
  order_reminders_max: number
  order_reminder_interval_days: number
  /** Decline-recovery discount (migration 000279). When enabled, the proof page
   *  offers this % off to a customer who flags price as the blocker. Off by
   *  default — auto-discounting touches margin, so a human sets the size. */
  decline_recovery_discount_enabled: boolean
  decline_recovery_discount_percent: number
  /** Stripe payment mode (migration 000241): 'test' (sandbox) or 'live'. The
   *  checkout functions read this to pick which Stripe key set to use. */
  payment_mode: 'test' | 'live'
  /** Workshop hand-off mode (migration 000332, docs/order-handoff-spec.md §3.6).
   *  'off' = the old behaviour, where Stock Control picked the order out of the
   *  Help Scout message. 'shadow' = old behaviour plus a dry-run of the direct
   *  write, for checking. 'live' = the order is written into Stock Control
   *  directly when it's placed, which is what frees the message wording. */
  direct_handoff_mode: HandoffMode
  /** Xero account code of the Stripe clearing account (migration 000242). When
   *  set, paid orders are marked paid in Xero instantly. Null = create-only. */
  xero_stripe_account_code: string | null
  /** Zero-rated Xero tax rates for non-UK invoices (migration 000306): the
   *  TaxType codes behind the org's "0% EU" and "0% ROW" rates. A VAT-free
   *  invoice (EUR/USD, or GBP to the Channel Islands) books every line to
   *  the one matching its delivery region. Null = book as "No VAT". */
  xero_eu_tax_type: string | null
  xero_row_tax_type: string | null
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
  /** Customer order tracking (Phase 3, migration 000265). Master switch +
   *  per-route/per-supplier disclosure. Off by default → customers see nothing
   *  after "Paid". The projection is resolved server-side; this only controls
   *  how much is disclosed. */
  customer_tracking_enabled: boolean
  customer_tracking_config: CustomerTrackingConfig
  /** Push-notification master switch (migration 000283). Off pauses every staff
   *  push for everyone; the per-person Notifications screen + the database
   *  triggers all defer to it. */
  push_enabled: boolean
  /** Reorder desk (migration 000389). `enabled` gates the dashboard desk card;
   *  the daily limit is how many past customers the desk serves per working day;
   *  follow-up days is how long after the outreach before an opened-but-quiet
   *  customer resurfaces for a personal follow-up. */
  reorder_desk_enabled: boolean
  reorder_desk_daily_limit: number
  reorder_desk_followup_days: number
}

type TrackingLevel = 'off' | 'broad' | 'granular'
interface CustomerTrackingConfig {
  inhouse: TrackingLevel
  outsourced_default: TrackingLevel
  suppliers: Record<string, TrackingLevel>
}
const TRACKING_DEFAULT_CONFIG: CustomerTrackingConfig = { inhouse: 'granular', outsourced_default: 'broad', suppliers: {} }

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
  taxRates?: { name: string; taxType: string; effectiveRate: number | null }[]
  stripeAccountCode?: string | null
}

/** Stable audit action string per field. */
const AUDIT_ACTION: Record<keyof Settings, string> = {
  default_pricing_display:           'setting.default_pricing_display_updated',
  default_currency:                  'setting.default_currency_updated',
  approvals_enabled:                 'setting.approvals_enabled_updated',
  proof_callouts_enabled:            'setting.proof_callouts_enabled_updated',
  proof_pins_enabled:                'setting.proof_pins_enabled_updated',
  approve_confirmation_copy:         'setting.approve_confirmation_copy_updated',
  request_changes_confirmation_copy: 'setting.request_changes_confirmation_copy_updated',
  ordering_enabled:                  'setting.ordering_enabled_updated',
  auto_order_reminders_enabled:      'setting.auto_order_reminders_enabled_updated',
  order_reminders_max:               'setting.order_reminders_max_updated',
  order_reminder_interval_days:      'setting.order_reminder_interval_days_updated',
  decline_recovery_discount_enabled: 'setting.decline_recovery_discount_enabled_updated',
  decline_recovery_discount_percent: 'setting.decline_recovery_discount_percent_updated',
  payment_mode:                      'setting.payment_mode_updated',
  direct_handoff_mode:               'setting.direct_handoff_mode_updated',
  xero_stripe_account_code:          'setting.xero_stripe_account_code_updated',
  xero_eu_tax_type:                  'setting.xero_eu_tax_type_updated',
  xero_row_tax_type:                 'setting.xero_row_tax_type_updated',
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
  customer_tracking_enabled:         'setting.customer_tracking_enabled_updated',
  customer_tracking_config:          'setting.customer_tracking_config_updated',
  push_enabled:                      'setting.push_enabled_updated',
  reorder_desk_enabled:              'setting.reorder_desk_enabled_updated',
  reorder_desk_daily_limit:          'setting.reorder_desk_daily_limit_updated',
  reorder_desk_followup_days:        'setting.reorder_desk_followup_days_updated',
}

// ── Page ─────────────────────────────────────────────────────────────────────

// The on-page sections, in render order — drives the sticky jump nav
// under the page heading and its scrollspy highlight. Each id is stamped on
// the matching <section> below via SECTION_CLASS, whose scroll-mt makes a
// jump land clear of the sticky app bar + jump nav (~50px + ~44px).
const SECTIONS = [
  { id: 'customer-approvals', label: 'Customer approvals' },
  { id: 'ordering-checkout', label: 'Ordering & checkout' },
  { id: 'workshop-handoff', label: 'Workshop hand-off' },
  { id: 'order-tracking', label: 'Order tracking' },
  { id: 'reorder-desk', label: 'Reorder desk' },
  { id: 'designer-defaults', label: 'Designer defaults' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'help-scout', label: 'Help Scout' },
  { id: 'shipping', label: 'Shipping' },
  { id: 'us-tariff', label: 'US tariff' },
] as const

const SECTION_CLASS =
  'scroll-mt-[calc(env(safe-area-inset-top)+104px)] rounded-2xl bg-surface p-6 shadow-sm ring-1 ring-line'

export default function AdminSettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Per-field UI state: last save timestamp, in-flight saves, errors.
  const [savedAt, setSavedAt] = useState<Partial<Record<keyof Settings, number>>>({})
  const [errors, setErrors] = useState<Partial<Record<keyof Settings, string>>>({})
  const [working, setWorking] = useState<Partial<Record<keyof Settings, boolean>>>({})

  // Local drafts so text fields don't round-trip on every keystroke.
  const [drafts, setDrafts] = useState<Partial<Settings>>({})

  // Stock Control suppliers (public schema), for the per-supplier tracking
  // overrides. Best-effort; the override keys are the supplier id. Loaded once.
  const [trackingSuppliers, setTrackingSuppliers] = useState<{ id: string; name: string; active: boolean }[]>([])
  useEffect(() => {
    void supabase.schema('public').from('outsourced_suppliers').select('id, name, active').then(({ data }) => {
      if (data) setTrackingSuppliers(data as { id: string; name: string; active: boolean }[])
    })
  }, [])

  // Help Scout connection state. No mount-time check — test only
  // fires when the admin clicks the Test connection button.
  const [hsTestState, setHsTestState] = useState<HelpScoutTestState>({ kind: 'untested' })
  const [hsTesting, setHsTesting] = useState(false)

  // Scrollspy for the jump nav: highlight the section currently under the
  // sticky chrome. Depends on whether settings have loaded because the
  // sections only exist in the DOM once the first fetch renders them.
  const [activeSection, setActiveSection] = useState<string>(SECTIONS[0].id)
  const settingsLoaded = settings != null
  useEffect(() => {
    if (!settingsLoaded) return
    const visible = new Set<string>()
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.add(e.target.id)
          else visible.delete(e.target.id)
        }
        // First visible section in page order wins, so at a boundary the
        // one whose heading sits under the jump nav stays highlighted.
        const first = SECTIONS.find((s) => visible.has(s.id))
        if (first) setActiveSection(first.id)
      },
      // Top edge sits just below the sticky app bar + jump nav; the -55%
      // bottom margin keeps the highlight on the section being read rather
      // than one only peeking in at the foot of the screen.
      { rootMargin: '-100px 0px -55% 0px' },
    )
    for (const s of SECTIONS) {
      const el = document.getElementById(s.id)
      if (el) observer.observe(el)
    }
    return () => observer.disconnect()
  }, [settingsLoaded])

  // Deep-link support: a "/admin/settings#help-scout" URL (used by the admin
  // feature search to land on a specific section) scrolls that section into
  // view once settings have rendered. location.key is in the deps so
  // re-selecting the same section from the palette scrolls again; the rAF lets
  // the section paint on the same tick settings first load.
  const location = useLocation()
  useEffect(() => {
    if (!settingsLoaded) return
    const id = location.hash.replace(/^#/, '')
    if (!id || !SECTIONS.some((s) => s.id === id)) return
    const el = document.getElementById(id)
    if (!el) return
    const raf = requestAnimationFrame(() => {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      setActiveSection(id)
    })
    return () => cancelAnimationFrame(raf)
  }, [settingsLoaded, location.key, location.hash])

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

  // Workshop hand-off mode. Turning it back OFF or to SHADOW is the move that
  // needs a warning: those modes rely on Stock Control picking the order out of
  // the wording of the production note / supplier email, which only works while
  // that wording is still the standard one. Phase 3 lets anyone rewrite it — so
  // a rollback after an edit means the old way can't read the message and the
  // order lands in neither place. See docs/order-handoff-spec.md §3.6 / §6.
  async function changeHandoffMode(next: HandoffMode) {
    if (!settings || next === settings.direct_handoff_mode) return
    if (settings.direct_handoff_mode === 'live' && next !== 'live') {
      const ok = window.confirm(
        `Stop sending orders straight to Stock Control?\n\nOrders would go back to being picked out of the wording of the production note or the supplier email, the way they used to be.\n\nThat only works while that wording is still the standard one. If anyone has edited the production note (Admin → Content → Messages) or a supplier email (Admin → Outsourcing), the old way can no longer read it — and an order could end up in neither system.\n\nReset any edited hand-off wording back to the default first.`,
      )
      if (!ok) return
    }
    await saveField('direct_handoff_mode', next)
  }

  useEffect(() => { load(); void loadPaymentsStatus() }, [])

  async function load() {
    const { data, error } = await supabase
      .from('settings')
      .select('default_pricing_display, default_currency, approvals_enabled, proof_callouts_enabled, proof_pins_enabled, approve_confirmation_copy, request_changes_confirmation_copy, ordering_enabled, auto_order_reminders_enabled, order_reminders_max, order_reminder_interval_days, payment_mode, direct_handoff_mode, xero_stripe_account_code, xero_eu_tax_type, xero_row_tax_type, fedex_box_weight_grams, fedex_intl_adjust_percent, domestic_uk_mainland_rate_gbp, domestic_uk_ni_rate_gbp, us_tariff_fee_gbp, us_tariff_fee_eur, us_tariff_fee_usd, xero_us_tariff_item_code, us_tariff_intro_copy, us_tariff_optout_warning, customer_tracking_enabled, customer_tracking_config, decline_recovery_discount_enabled, decline_recovery_discount_percent, push_enabled, reorder_desk_enabled, reorder_desk_daily_limit, reorder_desk_followup_days')
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
      field === 'proof_callouts_enabled' ||
      field === 'proof_pins_enabled' ||
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
    if (field.startsWith('reorder_desk')) {
      invalidateReorderDeskSettings()
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

  // Blur handler for the decline-recovery discount percent (000279). Allows
  // decimals 0–100; surfaces a pill rather than snapping back.
  function onDiscountPercentBlur() {
    if (!settings) return
    const draft = drafts.decline_recovery_discount_percent
    if (draft === undefined) return
    const value = Number(draft)
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      setErrors((e) => ({ ...e, decline_recovery_discount_percent: 'Between 0 and 100.' }))
      return
    }
    if (errors.decline_recovery_discount_percent) setErrors((e) => ({ ...e, decline_recovery_discount_percent: undefined }))
    void saveField('decline_recovery_discount_percent', value)
  }

  // Blur handler for the two unpaid-order reminder cadence inputs (000270).
  // Both are whole numbers within their column CHECK range; same surface-a-pill
  // philosophy as onShippingNumberBlur above (no silent snap-back).
  function onReminderNumberBlur(field: 'order_reminders_max' | 'order_reminder_interval_days') {
    if (!settings) return
    const draft = drafts[field]
    if (draft === undefined) return
    const value = Number(draft)
    if (!Number.isInteger(value)) {
      setErrors((e) => ({ ...e, [field]: 'Whole number only.' }))
      return
    }
    if (field === 'order_reminders_max' && (value < 1 || value > 5)) {
      setErrors((e) => ({ ...e, [field]: 'Between 1 and 5.' }))
      return
    }
    if (field === 'order_reminder_interval_days' && (value < 1 || value > 30)) {
      setErrors((e) => ({ ...e, [field]: 'Between 1 and 30.' }))
      return
    }
    if (errors[field]) setErrors((e) => ({ ...e, [field]: undefined }))
    void saveField(field, value)
  }

  // Blur handler for the two Reorder desk number inputs (000389). Both are
  // whole numbers within their column CHECK range; same surface-a-pill
  // philosophy as onReminderNumberBlur above (no silent snap-back).
  function onReorderDeskNumberBlur(field: 'reorder_desk_daily_limit' | 'reorder_desk_followup_days') {
    if (!settings) return
    const draft = drafts[field]
    if (draft === undefined) return
    const value = Number(draft)
    if (!Number.isInteger(value)) {
      setErrors((e) => ({ ...e, [field]: 'Whole number only.' }))
      return
    }
    if (field === 'reorder_desk_daily_limit' && (value < 1 || value > 20)) {
      setErrors((e) => ({ ...e, [field]: 'Between 1 and 20.' }))
      return
    }
    if (field === 'reorder_desk_followup_days' && (value < 1 || value > 30)) {
      setErrors((e) => ({ ...e, [field]: 'Between 1 and 30.' }))
      return
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

  // Blur handler for the zero-rated VAT tax-type fields when they render as
  // plain code inputs (connection not yet carrying the rate-list scope).
  // Unlike the tariff item code, empty means "not set" (NULL) — the invoice
  // then books those lines as "No VAT", the pre-000306 behaviour.
  function onXeroTaxTypeBlur(field: 'xero_eu_tax_type' | 'xero_row_tax_type') {
    if (!settings) return
    const draft = drafts[field]
    if (draft === undefined) return
    void saveField(field, (draft as string).trim().toUpperCase() || null)
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

      {/* Jump nav — ten long sections; this pins under the app bar (same
          offset trick as the Orders page section headers) so any section is
          one tap away mid-scroll. Buttons rather than #hash anchors so the
          router URL stays clean. Bleeds to the screen edge below lg, in
          step with the page container's px-4 / sm:px-6 padding. */}
      <nav
        aria-label="Settings sections"
        className="sticky top-[calc(env(safe-area-inset-top)+50px)] z-[4] -mx-4 flex gap-1 overflow-x-auto bg-canvas/95 px-4 py-2 backdrop-blur-sm sm:-mx-6 sm:px-6 lg:mx-0 lg:px-0"
      >
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => document.getElementById(s.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            className={[
              'whitespace-nowrap rounded-[8px] px-2.5 py-1.5 text-xs transition-colors',
              activeSection === s.id
                ? 'bg-surface border border-line text-ink font-medium'
                : 'border border-transparent text-ink-mute hover:bg-surface hover:text-ink',
            ].join(' ')}
          >
            {s.label}
          </button>
        ))}
      </nav>

      {/* ── Customer approvals (Phase 2) ──────────────────────────── */}
      <section id="customer-approvals" className={SECTION_CLASS}>
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

          {/* Proof annotations (migration 000347). Two switches rather than one,
              so the designer half can go live without opening the anonymous
              write path — the phasing in docs/proof-annotation-proposal.md. */}
          <FieldRow
            label="Designer notes on proofs"
            help="Lets designers leave notes on a proof for the customer to read. They appear beside the card as a collapsed strip, never drawn on the artwork; a numbered marker only shows if the customer zooms in. Off hides both the authoring button and the customer-facing strip."
            saved={recentlySaved('proof_callouts_enabled')}
            working={working.proof_callouts_enabled}
            error={errors.proof_callouts_enabled}
          >
            <Toggle
              value={settings.proof_callouts_enabled}
              onChange={(v) => void saveField('proof_callouts_enabled', v)}
              disabled={!!working.proof_callouts_enabled}
              label="Designer notes on proofs"
            />
          </FieldRow>

          <FieldRow
            label="Let customers point at what they mean"
            help="Adds an optional step to Request changes where the customer can tap the artwork to place a pin and describe that spot. The notes box stays primary — a change request with no pins is still complete. Pins arrive as a tickable checklist on the proof page and as a numbered list on the Help Scout thread."
            saved={recentlySaved('proof_pins_enabled')}
            working={working.proof_pins_enabled}
            error={errors.proof_pins_enabled}
          >
            <Toggle
              value={settings.proof_pins_enabled}
              onChange={(v) => void saveField('proof_pins_enabled', v)}
              disabled={!!working.proof_pins_enabled}
              label="Let customers point at what they mean"
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
      <section id="ordering-checkout" className={SECTION_CLASS}>
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
            help="When on, a customer who's been sent an order link but hasn't paid gets automated reminders on their Help Scout thread, using the cadence set below. The moment they pay (or the link expires) the reminders stop. When off (the default), the daily job still runs but only logs what it would have sent — nothing is emailed. Edit the wording under Templates → Order messages. Saves immediately."
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

          {/* Reminder cadence (migration 000270). Both inert until the switch
              above is on; the sender clamps to these same bounds. */}
          <FieldRow
            label="Maximum reminders per order"
            help="How many reminders a single unpaid order can receive before the sender stops (1–5). Reminders also stop the moment the order is paid or its pay link expires. Only used when the switch above is on."
            saved={recentlySaved('order_reminders_max')}
            working={working.order_reminders_max}
            error={errors.order_reminders_max}
          >
            <input
              type="number"
              min={1}
              max={5}
              step={1}
              inputMode="numeric"
              value={drafts.order_reminders_max ?? settings.order_reminders_max}
              onChange={(e) => setDrafts((d) => ({ ...d, order_reminders_max: e.target.value === '' ? 1 : Number(e.target.value) }))}
              onBlur={() => onReminderNumberBlur('order_reminders_max')}
              className={`w-32 ${inputClass}`}
            />
          </FieldRow>

          <FieldRow
            label="Days between reminders"
            help="Gap in days between reminders, counted from when the pay link was sent (1–30). For example, 3 sends the first reminder 3 days after the link goes out, the next at day 6, and so on, up to the maximum above. Only used when the switch above is on."
            saved={recentlySaved('order_reminder_interval_days')}
            working={working.order_reminder_interval_days}
            error={errors.order_reminder_interval_days}
          >
            <input
              type="number"
              min={1}
              max={30}
              step={1}
              inputMode="numeric"
              value={drafts.order_reminder_interval_days ?? settings.order_reminder_interval_days}
              onChange={(e) => setDrafts((d) => ({ ...d, order_reminder_interval_days: e.target.value === '' ? 1 : Number(e.target.value) }))}
              onBlur={() => onReminderNumberBlur('order_reminder_interval_days')}
              className={`w-32 ${inputClass}`}
            />
          </FieldRow>

          {/* Decline-recovery discount (migration 000279). Off by default —
              when on, the proof page offers this % off to a customer who flags
              price as the blocker, and notes it to the designer. */}
          <FieldRow
            label="Decline-recovery discount"
            help="When a customer says the price is too high on a proof, offer them this % off to win the order. Off by default. The discount is shown on the proof page and noted to the designer to apply at order time. Saves immediately."
            saved={recentlySaved('decline_recovery_discount_enabled')}
            working={working.decline_recovery_discount_enabled}
            error={errors.decline_recovery_discount_enabled}
          >
            <Toggle
              value={settings.decline_recovery_discount_enabled}
              onChange={(v) => void saveField('decline_recovery_discount_enabled', v)}
              disabled={!!working.decline_recovery_discount_enabled}
              label="Offer a discount when price is the blocker"
            />
          </FieldRow>

          <FieldRow
            label="Discount offered (%)"
            help="The percentage off shown to a customer who flags price (0–100). Only used when the toggle above is on."
            saved={recentlySaved('decline_recovery_discount_percent')}
            working={working.decline_recovery_discount_percent}
            error={errors.decline_recovery_discount_percent}
          >
            <input
              type="number"
              min={0}
              max={100}
              step={0.5}
              inputMode="decimal"
              value={drafts.decline_recovery_discount_percent ?? settings.decline_recovery_discount_percent}
              onChange={(e) => setDrafts((d) => ({ ...d, decline_recovery_discount_percent: e.target.value === '' ? 0 : Number(e.target.value) }))}
              onBlur={onDiscountPercentBlur}
              className={`w-32 ${inputClass}`}
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

          {/* Zero-rated VAT rates for non-UK invoices (migration 000306).
              A VAT-free invoice (EUR/USD, or GBP to the Channel Islands)
              books every line to the org's "0% EU" or "0% ROW" rate by
              delivery region, so exports file in the right VAT-return box
              instead of "No VAT". The pickers list the org's 0% revenue
              rates via payments-status; until the Xero connection carries
              the rate-list scope (one reconnect), a plain code field shows
              instead. */}
          <div className="border-t border-line-soft pt-5">
            <p className="text-sm font-medium text-ink">VAT rates on non-UK invoices</p>
            <p className="mt-1 text-[13px] text-ink-mute">
              Orders delivered outside the UK are zero-rated. Choose which Xero tax rate each region&rsquo;s invoices book to — EU deliveries use the first, everywhere else the second. An unset field books those invoices as &ldquo;No VAT&rdquo;, as before.
            </p>
            <div className="mt-3 space-y-4">
              {(['xero_eu_tax_type', 'xero_row_tax_type'] as const).map((field) => {
                const zeroRates = (payStatus?.taxRates ?? []).filter(
                  (t) => t.effectiveRate === 0 || t.effectiveRate == null,
                )
                const isEu = field === 'xero_eu_tax_type'
                return (
                  <FieldRow
                    key={field}
                    label={isEu ? 'EU deliveries' : 'Rest of the world'}
                    help={isEu
                      ? 'The zero rate for deliveries into the EU VAT area — normally your “0% EU” rate.'
                      : 'The zero rate for deliveries everywhere else, including the Channel Islands — normally your “0% ROW” rate.'}
                    saved={recentlySaved(field)}
                    working={working[field]}
                    error={errors[field]}
                  >
                    {zeroRates.length > 0 ? (
                      <select
                        value={settings[field] ?? ''}
                        onChange={(e) => void saveField(field, e.target.value || null)}
                        disabled={!!working[field]}
                        className="h-[38px] w-full max-w-sm rounded-[8px] border border-line bg-surface px-3 text-sm text-ink focus:border-[var(--c-brand)] focus:outline-2 focus:outline-offset-1 focus:outline-[var(--c-brand)]"
                      >
                        <option value="">Not set — book as &ldquo;No VAT&rdquo;</option>
                        {zeroRates.map((t) => (
                          <option key={t.taxType} value={t.taxType}>{t.name} ({t.taxType})</option>
                        ))}
                        {settings[field] && !zeroRates.some((t) => t.taxType === settings[field]) && (
                          <option value={settings[field]}>{settings[field]} (not in the org&rsquo;s current rate list)</option>
                        )}
                      </select>
                    ) : (
                      <div className="max-w-sm">
                        <input
                          type="text"
                          value={(drafts[field] ?? settings[field] ?? '') as string}
                          onChange={(e) => setDrafts((d) => ({ ...d, [field]: e.target.value }))}
                          onBlur={() => onXeroTaxTypeBlur(field)}
                          placeholder={isEu ? 'e.g. TAX004' : 'e.g. TAX003'}
                          className="h-[38px] w-full rounded-[8px] border border-line bg-surface px-3 text-sm text-ink focus:border-[var(--c-brand)] focus:outline-2 focus:outline-offset-1 focus:outline-[var(--c-brand)]"
                        />
                        <p className="mt-1 text-[12px] text-ink-mute">
                          The rate&rsquo;s TaxType code. Reconnect Xero (above) to pick from the organisation&rsquo;s rate list instead.
                        </p>
                      </div>
                    )}
                  </FieldRow>
                )
              })}
            </div>
          </div>
        </div>
      </section>

      {/* ── Workshop hand-off (migration 000332) ──────────────────────
          How a placed order reaches Stock Control: written straight into
          it (Live), or picked out of the wording of the Help Scout
          production note / supplier email the way it used to be. Live is
          what makes that wording freely editable, so stepping back down
          is the move that carries a risk — hence the warning on the way
          out. See docs/order-handoff-spec.md §3.6. */}
      <section id="workshop-handoff" className={SECTION_CLASS}>
        <h3 className="mb-4 text-sm font-semibold text-ink">Workshop hand-off</h3>
        <div className="space-y-5">
          <FieldRow
            label="How orders reach Stock Control"
            help="Straight there — placing an order writes the job into Stock Control itself, and the production note and supplier email are ordinary messages you can word however you like. Old way — Stock Control picks the order out of the wording of that message instead, which only works while the wording is the standard one. Both — the old way, plus a silent dry run of the new one for checking."
            saved={recentlySaved('direct_handoff_mode')}
            working={working.direct_handoff_mode}
            error={errors.direct_handoff_mode}
          >
            <RadioGroup<HandoffMode>
              value={settings.direct_handoff_mode}
              onChange={(v) => void changeHandoffMode(v)}
              options={[
                { value: 'live', label: 'Straight there' },
                { value: 'shadow', label: 'Both' },
                { value: 'off', label: 'Old way' },
              ]}
            />
          </FieldRow>

          {settings.direct_handoff_mode === 'live' && (
            <div className="rounded-lg bg-low-soft px-3 py-2 text-[12px] text-low ring-1 ring-low">
              <p className="font-medium">Before ever switching this back</p>
              <p className="mt-1">
                Going back to the old way only works while the hand-off wording is still the standard
                one. Once the production note (Admin &rarr; Content &rarr; Messages) or a supplier email
                (Admin &rarr; Outsourcing) has been edited, the old way can no longer read it &mdash; and an
                order could end up in neither system. Reset any edited wording to the default first.
              </p>
            </div>
          )}
        </div>
      </section>

      {/* ── Customer order tracking (Phase 3) ─────────────────────── */}
      {(() => {
        const cfg: CustomerTrackingConfig = {
          ...TRACKING_DEFAULT_CONFIG,
          ...(settings.customer_tracking_config ?? {}),
          suppliers: settings.customer_tracking_config?.suppliers ?? {},
        }
        const levelOptions: { value: TrackingLevel; label: string }[] = [
          { value: 'off', label: 'Off' },
          { value: 'broad', label: 'Broad' },
          { value: 'granular', label: 'Granular' },
        ]
        const setSupplier = (id: string, v: TrackingLevel | null) => {
          const suppliers = { ...cfg.suppliers }
          if (v == null) delete suppliers[id]
          else suppliers[id] = v
          void saveField('customer_tracking_config', { ...cfg, suppliers })
        }
        const sortedSuppliers = [...trackingSuppliers].sort(
          (a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name),
        )
        const knownIds = new Set(trackingSuppliers.map((s) => s.id))
        const orphanIds = Object.keys(cfg.suppliers).filter((id) => !knownIds.has(id))
        return (
          <section id="order-tracking" className={SECTION_CLASS}>
            <h3 className="mb-1 text-sm font-semibold text-ink">Customer order tracking</h3>
            <p className="mb-4 text-xs text-ink-mute">
              Shows a quiet order-progress strip on the customer&rsquo;s paid screen — and, since the proof page learned about orders, on their proof page too. Off by default — turn it on, then choose how much detail each route and supplier reveals. <span className="font-medium">Broad</span> shows date-free stages (In production → On its way → Delivered) so a late supplier stays invisible; <span className="font-medium">Granular</span> adds the customer&rsquo;s outbound tracking number, on the paid screen only.
            </p>
            <div className="space-y-5">
              <FieldRow
                label="Customer order tracking enabled"
                help="The master switch. When off, the customer sees nothing after Paid on either the paid screen or their proof page. Turn on to start showing the progress strip, governed by the levels below. Delivered only appears for carriers that report it — FedEx does, DPD does not, so a UK parcel shows a shorter journey that finishes at 'On its way' rather than a step it can never reach."
                saved={recentlySaved('customer_tracking_enabled')}
                working={working.customer_tracking_enabled}
                error={errors.customer_tracking_enabled}
              >
                <Toggle
                  value={settings.customer_tracking_enabled}
                  onChange={(v) => void saveField('customer_tracking_enabled', v)}
                  disabled={!!working.customer_tracking_enabled}
                  label="Customer order tracking enabled"
                />
              </FieldRow>

              {settings.customer_tracking_enabled && (
                <>
                  <FieldRow
                    label="In-house orders"
                    help="Disclosure level for orders you produce in-house. In-house parcels carry no tracking number through to the customer, so Granular behaves like Broad here."
                    saved={recentlySaved('customer_tracking_config')}
                    working={working.customer_tracking_config}
                    error={errors.customer_tracking_config}
                  >
                    <RadioGroup<TrackingLevel>
                      value={cfg.inhouse}
                      onChange={(v) => saveField('customer_tracking_config', { ...cfg, inhouse: v })}
                      options={levelOptions}
                    />
                  </FieldRow>

                  <FieldRow
                    label="Outsourced orders — default"
                    help="The level for supplier-produced orders that don't have their own override below. Default is Broad, so a supplier's dates and reliability stay private until you choose to expose them per supplier."
                    saved={recentlySaved('customer_tracking_config')}
                    working={working.customer_tracking_config}
                    error={errors.customer_tracking_config}
                  >
                    <RadioGroup<TrackingLevel>
                      value={cfg.outsourced_default}
                      onChange={(v) => saveField('customer_tracking_config', { ...cfg, outsourced_default: v })}
                      options={levelOptions}
                    />
                  </FieldRow>

                  <div className="border-t border-line-soft pt-4">
                    <p className="text-sm font-medium text-ink-soft">Per-supplier overrides</p>
                    <p className="mt-1 mb-3 text-xs text-ink-mute">
                      Dial a trusted supplier up to Granular, or hold an unreliable one at Broad / Off, regardless of the outsourced default. &ldquo;Use default&rdquo; removes the override.
                    </p>
                    {sortedSuppliers.length === 0 && orphanIds.length === 0 ? (
                      <p className="text-[13px] text-ink-mute">No suppliers found.</p>
                    ) : (
                      <div className="space-y-3">
                        {sortedSuppliers.map((s) => (
                          <div key={s.id} className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between">
                            <span className="text-[13px] text-ink">
                              {s.name}
                              {!s.active && <span className="ml-1.5 text-[11px] text-ink-mute">(inactive)</span>}
                            </span>
                            <RadioGroup<TrackingLevel | null>
                              value={cfg.suppliers[s.id] ?? null}
                              onChange={(v) => setSupplier(s.id, v)}
                              options={[
                                { value: null, label: 'Use default' },
                                { value: 'off', label: 'Off' },
                                { value: 'broad', label: 'Broad' },
                                { value: 'granular', label: 'Granular' },
                              ]}
                            />
                          </div>
                        ))}
                        {orphanIds.map((id) => (
                          <div key={id} className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between">
                            <span className="text-[13px] text-ink-mute">
                              Unknown supplier <span className="font-mono text-[11px]">{id.slice(0, 8)}…</span>
                            </span>
                            <button
                              type="button"
                              onClick={() => setSupplier(id, null)}
                              className="self-start rounded px-2.5 py-1 text-[12px] text-ink-soft ring-1 ring-line hover:bg-canvas"
                            >
                              Clear override
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          </section>
        )
      })()}

      {/* ── Reorder desk (migration 000389) ───────────────────────── */}
      <section id="reorder-desk" className={SECTION_CLASS}>
        <h3 className="mb-4 text-sm font-semibold text-ink">Reorder desk</h3>
        <div className="space-y-5">
          <FieldRow
            label="Reorder desk enabled"
            help="Shows the Reorder desk on the dashboard — a small daily list of past customers most likely to need a top-up. Off hides the desk; nothing is ever sent automatically either way."
            saved={recentlySaved('reorder_desk_enabled')}
            working={working.reorder_desk_enabled}
            error={errors.reorder_desk_enabled}
          >
            <Toggle
              value={settings.reorder_desk_enabled}
              onChange={(v) => void saveField('reorder_desk_enabled', v)}
              disabled={!!working.reorder_desk_enabled}
              label="Reorder desk enabled"
            />
          </FieldRow>

          <FieldRow
            label="Customers served per day"
            help="How many past customers the desk puts in front of the team each working day (1–20). A small number keeps every note personal — the desk is a short daily list, not a mailshot."
            saved={recentlySaved('reorder_desk_daily_limit')}
            working={working.reorder_desk_daily_limit}
            error={errors.reorder_desk_daily_limit}
          >
            <input
              type="number"
              min={1}
              max={20}
              step={1}
              inputMode="numeric"
              value={drafts.reorder_desk_daily_limit ?? settings.reorder_desk_daily_limit}
              onChange={(e) => setDrafts((d) => ({ ...d, reorder_desk_daily_limit: e.target.value === '' ? 1 : Number(e.target.value) }))}
              onBlur={() => onReorderDeskNumberBlur('reorder_desk_daily_limit')}
              className={`w-32 ${inputClass}`}
            />
          </FieldRow>

          <FieldRow
            label="Days before the follow-up"
            help="How long after the outreach before a customer who opened their page but went quiet resurfaces on the desk for a personal follow-up (1–30). Customers who reply, order, or ask to be left alone never resurface."
            saved={recentlySaved('reorder_desk_followup_days')}
            working={working.reorder_desk_followup_days}
            error={errors.reorder_desk_followup_days}
          >
            <input
              type="number"
              min={1}
              max={30}
              step={1}
              inputMode="numeric"
              value={drafts.reorder_desk_followup_days ?? settings.reorder_desk_followup_days}
              onChange={(e) => setDrafts((d) => ({ ...d, reorder_desk_followup_days: e.target.value === '' ? 1 : Number(e.target.value) }))}
              onBlur={() => onReorderDeskNumberBlur('reorder_desk_followup_days')}
              className={`w-32 ${inputClass}`}
            />
          </FieldRow>
        </div>
      </section>

      {/* ── Designer defaults ─────────────────────────────────────── */}
      <section id="designer-defaults" className={SECTION_CLASS}>
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

      {/* ── Notifications (migration 000283) ──────────────────────── */}
      <section id="notifications" className={SECTION_CLASS}>
        <h3 className="mb-4 text-sm font-semibold text-ink">Notifications</h3>
        <div className="space-y-5">
          <FieldRow
            label="Staff push notifications"
            help="Master switch for push notifications to staff devices (approvals, change requests, replies, orders). Off pauses every notification for everyone. Each person additionally chooses which events they receive on their own Notifications screen."
            saved={recentlySaved('push_enabled')}
            working={working.push_enabled}
            error={errors.push_enabled}
          >
            <Toggle
              value={settings.push_enabled}
              onChange={(v) => void saveField('push_enabled', v)}
              disabled={!!working.push_enabled}
              label="Staff push notifications"
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
      <section id="help-scout" className={SECTION_CLASS}>
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
      <section id="shipping" className={SECTION_CLASS}>
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
      <section id="us-tariff" className={SECTION_CLASS}>
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
function humanFieldLabel(field: keyof Settings): string {
  return {
    default_pricing_display: 'Default pricing display',
    default_currency: 'Default currency',
    approvals_enabled: 'Customer-facing approval flow enabled',
    proof_callouts_enabled: 'Designer notes on proofs',
    proof_pins_enabled: 'Let customers point at what they mean',
    approve_confirmation_copy: 'Approve confirmation copy',
    request_changes_confirmation_copy: 'Request changes confirmation copy',
    ordering_enabled: 'Ordering & checkout enabled',
    auto_order_reminders_enabled: 'Send unpaid-order reminders automatically',
    order_reminders_max: 'Maximum reminders per order',
    order_reminder_interval_days: 'Days between reminders',
    decline_recovery_discount_enabled: 'Decline-recovery discount enabled',
    decline_recovery_discount_percent: 'Decline-recovery discount (%)',
    payment_mode: 'Stripe payment mode',
    direct_handoff_mode: 'How orders reach Stock Control',
    xero_stripe_account_code: 'Xero Stripe clearing account',
    xero_eu_tax_type: 'Xero tax rate for EU deliveries',
    xero_row_tax_type: 'Xero tax rate for rest-of-world deliveries',
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
    customer_tracking_enabled: 'Customer order tracking enabled',
    customer_tracking_config: 'Customer order tracking config',
    push_enabled: 'Push notifications enabled',
    reorder_desk_enabled: 'Reorder desk enabled',
    reorder_desk_daily_limit: 'Reorder desk daily limit',
    reorder_desk_followup_days: 'Days before the reorder follow-up',
  }[field]
}
