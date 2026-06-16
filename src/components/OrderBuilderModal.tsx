import { useEffect, useState } from 'react'
import Modal from './Modal'
import { Field, Input, ButtonCoral, ButtonGhost } from '../design'
import { supabase } from '../lib/supabase'
import { customerOrderUrl } from '../lib/customerOrderUrl'
import { SHIP_COUNTRIES, REPRESENTATIVE_POSTCODES } from '../lib/shipCountries'
import { renderTemplate, DEFAULT_BODIES } from '../lib/replyTemplates'
import { formatPrice } from '../lib/currency'
import { getShippingSettings, type ShippingSettings } from '../lib/shippingSettings'
import { getExchangeRates, gbpToCurrency, type ExchangeRates } from '../lib/exchangeRates'
import {
  splitIntoBoxes,
  resolveDomesticRate,
  applyIntlAdjustment,
  type ShippingRate,
} from '../lib/quote/shipping'

// Order builder (Ordering & checkout, Step 3). Opens from the "Create
// order" button on an approved proof. Captures the designer's locked
// decisions — quantity (open vs locked), shipping treatment, custom
// quote — and calls the create-order edge function. The final price is
// computed later on the customer pay-page (Step 4); this builder does
// not price anything.
//
// Gated behind settings.ordering_enabled at the call site, so the whole
// surface is inert until an admin turns ordering on.

type ShippingTreatment = 'full_cost' | 'goodwill' | 'free' | 'manual'
type Currency = 'GBP' | 'EUR' | 'USD'

const TREATMENT_OPTIONS: { value: ShippingTreatment; label: string }[] = [
  { value: 'full_cost', label: 'Charge full cost' },
  { value: 'goodwill', label: 'Goodwill (subsidise)' },
  { value: 'free', label: 'Free shipping' },
  { value: 'manual', label: 'Manual amount' },
]

interface VariantOption {
  id: string
  display_name: string
  weight_grams: number | null
  // 'thickness' | 'ink_count' | 'finish' | 'default'. Drives whether the order
  // locks to the proof's variant (ink_count = artwork-defined) or lets the
  // designer change it (thickness = a substrate choice the customer can change).
  variant_type: string | null
}

// Indicative shipping estimate shown in the builder. Resolved against a
// representative postcode for the chosen country so the designer has a ballpark
// to inform the goodwill decision — the real rate is computed from the
// customer's postcode at checkout.
type ShipEstimate =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; amount: number; serviceLabel: string }
  | { kind: 'unavailable' }
  | { kind: 'error' }

interface MaterialOptionRow {
  id: string
  code: string
  display_name: string
  is_base: boolean
}

interface OrderBuilderModalProps {
  proofId: string
  currentVersionId: string
  materialId: string | null
  // The variant id(s) the proof's current version actually showed pricing for
  // (proof_versions.displayed_variant_ids). When it's a single variant — the
  // common case, including letterpress ink counts — the builder locks the
  // order to it instead of re-asking the designer to pick.
  displayedVariantIds: string[]
  // The option codes the proof version offered (proof_versions.material_options,
  // e.g. metal finishes). Used to pre-select the finish picker when the version
  // offered exactly one.
  materialOptionCodes: string[]
  customerLabel: string | null
  materialDisplay: string | null
  currency: Currency | null
  namesCount: number
  hasPersonalisation: boolean
  isCustomQuote: boolean
  // Whether the proof is linked to a Help Scout conversation — gates the
  // "Send to customer" action in the success step.
  hasHelpScoutConversation: boolean
  onClose: () => void
  onCreated?: () => void
}

export default function OrderBuilderModal({
  proofId,
  currentVersionId,
  materialId,
  displayedVariantIds,
  materialOptionCodes,
  customerLabel,
  materialDisplay,
  currency,
  namesCount,
  hasPersonalisation,
  isCustomQuote,
  hasHelpScoutConversation,
  onClose,
  onCreated,
}: OrderBuilderModalProps) {
  const [quantityMode, setQuantityMode] = useState<'open' | 'locked'>('open')
  const [quantity, setQuantity] = useState('')
  const [shippingTreatment, setShippingTreatment] = useState<ShippingTreatment>('full_cost')
  const [shippingCharged, setShippingCharged] = useState('')
  // Optional destination-country pre-fill for full_cost / goodwill. The
  // customer confirms the country and enters their postcode on the pay-page
  // (support rarely knows the postcode upfront), and the rate is computed
  // there — so this is just a convenience hint, not required.
  const [shipDestCountry, setShipDestCountry] = useState('')
  // Per-order goodwill discount, % off the computed rate (Rob, 2026-06-15).
  const [shippingDiscountPercent, setShippingDiscountPercent] = useState('')
  const [customQuoteTotal, setCustomQuoteTotal] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ id: string; token: string; payment_reference: string } | null>(null)
  const [copied, setCopied] = useState(false)
  // Send-to-customer (Help Scout) state for the success step. message is the
  // editable email body the designer can tweak before sending. The starting
  // text comes from the admin-editable `order_payment_link` reply template
  // (Admin → Templates), falling back to the code default.
  const [message, setMessage] = useState('')
  const [orderTemplateBody, setOrderTemplateBody] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)

  // Variant capture for grid-priced orders. The server prices a grid
  // order from the chosen variant's price tiers, so we must pick one.
  // Auto-selected when the material has a single priced variant; a
  // dropdown when there are several. Not needed for custom quotes.
  const [variants, setVariants] = useState<VariantOption[]>([])
  const [variantId, setVariantId] = useState<string | null>(null)
  const [variantsLoading, setVariantsLoading] = useState(false)

  // Material options — the finish dimension (metal: Natural / Brushed / Mirror).
  // Unlike the ink count, finish is a substrate choice the customer can change
  // at order time, so the designer picks it here. Empty for materials with no
  // option dimension (most). The label comes from materials.option_label.
  const [materialOptions, setMaterialOptions] = useState<MaterialOptionRow[]>([])
  const [optionId, setOptionId] = useState<string | null>(null)
  const [optionLabel, setOptionLabel] = useState<string>('Finish')
  // True when the order is locked to the single variant the proof showed
  // pricing for (so we display it read-only rather than as a picker).
  const [lockedFromProof, setLockedFromProof] = useState(false)

  // Indicative shipping estimate (full_cost / goodwill). Quantity it's based on
  // defaults to the locked quantity, else a representative 250.
  const [shippingSettings, setShippingSettings] = useState<ShippingSettings | null>(null)
  const [exchangeRates, setExchangeRates] = useState<ExchangeRates | null>(null)
  const [estimateQty, setEstimateQty] = useState('250')
  const [estimate, setEstimate] = useState<ShipEstimate>({ kind: 'idle' })

  useEffect(() => {
    if (isCustomQuote || !materialId || !currency) return
    let cancelled = false
    void (async () => {
      setVariantsLoading(true)
      const { data: vs } = await supabase
        .from('material_variants')
        .select('id, display_name, sort_order, weight_grams, variant_type')
        .eq('material_id', materialId)
        .eq('is_active', true)
        .order('sort_order')
      const ids = (vs ?? []).map((v) => v.id as string)
      // Which variants have at least one price tier in this currency. A single
      // fetch-all-tiers query hits supabase-js's 1000-row cap once a material
      // has many tiers (e.g. 8 ink variants × ~197 tiers > 1000), silently
      // dropping variants from the list. A per-variant head count (no rows
      // transferred) is exact regardless of tier volume.
      const checks = await Promise.all(
        ids.map(async (id) => {
          const { count } = await supabase
            .from('price_tiers')
            .select('id', { count: 'exact', head: true })
            .eq('material_variant_id', id)
            .eq('currency', currency)
          return { id, has: (count ?? 0) > 0 }
        }),
      )
      const priced = new Set(checks.filter((c) => c.has).map((c) => c.id))
      const options = (vs ?? [])
        .filter((v) => priced.has(v.id as string))
        .map((v) => ({
          id: v.id as string,
          display_name: (v.display_name as string) ?? 'Option',
          weight_grams: typeof v.weight_grams === 'number' ? v.weight_grams : null,
          variant_type: (v.variant_type as string | null) ?? null,
        }))
      if (cancelled) return
      setVariants(options)
      // Pre-select the variant the proof priced (when it's a single displayed
      // variant priced in this currency). Lock it read-only only when it's
      // defined by the approved artwork — ink count for letterpress / plastics.
      // Substrate choices the customer can still change at order time (metal
      // thickness) stay an editable picker, just pre-selected to the proof's.
      const fromProofOpt = displayedVariantIds.length === 1
        ? options.find((o) => o.id === displayedVariantIds[0]) ?? null
        : null
      setLockedFromProof(!!fromProofOpt && fromProofOpt.variant_type === 'ink_count')
      setVariantId(fromProofOpt?.id ?? (options.length === 1 ? options[0].id : null))
      setVariantsLoading(false)
    })()
    return () => { cancelled = true }
  }, [isCustomQuote, materialId, currency, displayedVariantIds])

  // Material options (the finish dimension). Fetched alongside the material's
  // option_label so the picker reads "Finish" / "Species" etc. Default: the
  // version's single offered option when it offered exactly one, else the base
  // option — the designer changes it to whatever finish the customer wants.
  useEffect(() => {
    if (isCustomQuote || !materialId) { setMaterialOptions([]); setOptionId(null); return }
    let cancelled = false
    void (async () => {
      const [optsRes, matRes] = await Promise.all([
        supabase
          .from('material_options')
          .select('id, code, display_name, is_base, sort_order')
          .eq('material_id', materialId)
          .order('sort_order'),
        supabase.from('materials').select('option_label').eq('id', materialId).maybeSingle(),
      ])
      if (cancelled) return
      const list: MaterialOptionRow[] = (optsRes.data ?? []).map((o) => ({
        id: o.id as string,
        code: o.code as string,
        display_name: (o.display_name as string) ?? 'Option',
        is_base: !!o.is_base,
      }))
      setMaterialOptions(list)
      if (matRes.data?.option_label) setOptionLabel(matRes.data.option_label as string)
      const offered = materialOptionCodes.length === 1 ? list.find((o) => o.code === materialOptionCodes[0]) : null
      const base = list.find((o) => o.is_base) ?? list[0] ?? null
      setOptionId((offered ?? base)?.id ?? null)
    })()
    return () => { cancelled = true }
    // materialOptionCodes intentionally omitted — read once at mount; it's
    // stable for a given proof and re-running on identity churn isn't wanted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCustomQuote, materialId])

  // Shipping settings (box tare, intl adjustment %, domestic flat rates) +
  // live GBP→EUR/USD rates, for the indicative estimate. Both have their own
  // module caches + fail-safe defaults, so this never blocks the builder.
  useEffect(() => {
    let cancelled = false
    void getShippingSettings().then((v) => { if (!cancelled) setShippingSettings(v) })
    void getExchangeRates().then((v) => { if (!cancelled) setExchangeRates(v) })
    return () => { cancelled = true }
  }, [])

  // Resolve the indicative shipping estimate. Mirrors the Quote compiler's
  // tested path: split the parcel into boxes, GBP DPD flat rate for UK or a
  // FedEx account rate (against a representative postcode) for international,
  // then convert GBP → order currency. Debounced + cancellable so rapid input
  // changes don't race. Only runs for full_cost / goodwill on a grid order
  // with a chosen, weighable variant.
  const selectedVariant = variants.find((v) => v.id === variantId) ?? null
  const estimateWeightGrams = selectedVariant?.weight_grams ?? null
  // The quantity the estimate is based on: a locked order's quantity (so the
  // estimate tracks the real order size), else the editable estimate field.
  // One source per mode — no second input competing with the order quantity.
  const estimateBasisQty = quantityMode === 'locked' ? quantity : estimateQty
  useEffect(() => {
    const needsEstimate = shippingTreatment === 'full_cost' || shippingTreatment === 'goodwill'
    const qty = parseInt(estimateBasisQty, 10)
    if (
      isCustomQuote ||
      !needsEstimate ||
      !shipDestCountry ||
      !currency ||
      !shippingSettings ||
      estimateWeightGrams == null ||
      !Number.isFinite(qty) ||
      qty <= 0
    ) {
      setEstimate({ kind: 'idle' })
      return
    }
    // For a non-GBP order we must convert the GBP-billed rate, so wait for the
    // live exchange rates rather than show the raw GBP figure under a € / $
    // symbol (gbpToCurrency returns 1 for null rates). GBP needs no conversion.
    if (currency !== 'GBP' && !exchangeRates) {
      setEstimate({ kind: 'loading' })
      return
    }

    const boxes = splitIntoBoxes(estimateWeightGrams, qty, shippingSettings.boxWeightGrams)
    if (!boxes) {
      setEstimate({ kind: 'idle' })
      return
    }
    const multiplier = gbpToCurrency(currency, exchangeRates)

    // Domestic UK — flat DPD rate (mainland representative postcode). No fetch.
    if (shipDestCountry === 'GB') {
      const dom = resolveDomesticRate(REPRESENTATIVE_POSTCODES.GB, shippingSettings)
      setEstimate({
        kind: 'ready',
        amount: Math.round(dom.totalGbp * multiplier * 100) / 100,
        serviceLabel: 'DPD (UK mainland)',
      })
      return
    }

    const repPostcode = REPRESENTATIVE_POSTCODES[shipDestCountry]
    if (!repPostcode) {
      setEstimate({ kind: 'unavailable' })
      return
    }

    let cancelled = false
    setEstimate({ kind: 'loading' })
    const handle = window.setTimeout(() => {
      void supabase.functions
        .invoke<ShippingRate & { error?: string }>('fedex-rate', {
          body: {
            destCountry: shipDestCountry,
            destPostcode: repPostcode,
            boxWeightsGrams: boxes.boxWeightsGrams,
            currency: 'GBP',
          },
        })
        .then(({ data, error }) => {
          if (cancelled) return
          if (error || !data || data.error || !data.available || data.netCharge == null) {
            // FedEx declined the lane / errored — show "not available" rather
            // than a misleading guess. The real rate is still tried at checkout.
            setEstimate({ kind: error || data?.error ? 'error' : 'unavailable' })
            return
          }
          const baseGbp = applyIntlAdjustment(data.netCharge, shippingSettings.intlAdjustPercent)
          setEstimate({
            kind: 'ready',
            amount: Math.round(baseGbp * multiplier * 100) / 100,
            serviceLabel: data.serviceName ?? 'FedEx',
          })
        })
    }, 350)
    return () => {
      cancelled = true
      window.clearTimeout(handle)
    }
  }, [
    shippingTreatment,
    shipDestCountry,
    currency,
    estimateBasisQty,
    estimateWeightGrams,
    shippingSettings,
    exchangeRates,
    isCustomQuote,
  ])

  // Load the admin-editable order message template once on mount, so it's
  // ready by the time an order is created. Failure leaves it null → the result
  // effect falls back to the code default.
  useEffect(() => {
    let cancelled = false
    void supabase
      .from('reply_templates')
      .select('body')
      .eq('id', 'order_payment_link')
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled && data && typeof data.body === 'string') setOrderTemplateBody(data.body)
      })
    return () => { cancelled = true }
  }, [])

  // Pre-fill the customer email body once the order (and its pay-link) exists,
  // rendering the order template with the pay-page link. The designer can edit
  // this before sending it via Help Scout.
  useEffect(() => {
    if (!result) return
    const url = customerOrderUrl(result.id, result.token)
    const body = orderTemplateBody ?? DEFAULT_BODIES.order_payment_link
    setMessage(renderTemplate(body, { order_url: url }))
  }, [result, orderTemplateBody])

  // Send the pay-link to the customer on the proof's linked Help Scout
  // conversation (the same send-helpscout-reply path the detail page uses).
  async function sendToCustomer() {
    if (!result || !message.trim()) return
    setSendError(null)
    setSending(true)
    try {
      const { data, error: fnErr } = await supabase.functions.invoke<{ thread_id?: number; error?: string }>(
        'send-helpscout-reply',
        { body: { proof_id: proofId, version_id: currentVersionId, body: message } },
      )
      if (fnErr || !data || 'error' in data) {
        let msg = (data as { error?: string } | null)?.error ?? null
        const ctx = (fnErr as { context?: Response } | null)?.context
        if (!msg && ctx && typeof ctx.json === 'function') {
          try { const b = await ctx.json(); if (b && typeof b.error === 'string') msg = b.error } catch { /* not JSON */ }
        }
        setSendError(msg ?? 'Could not send the link via Help Scout — you can copy it and send it manually.')
        return
      }
      setSent(true)
    } catch {
      setSendError('Could not send the link via Help Scout — you can copy it and send it manually.')
    } finally {
      setSending(false)
    }
  }

  // A proof with no single currency (a per-direction-pricing variant
  // round) can't be ordered through this v1 flow — block with a clear
  // message rather than sending a null currency the edge function rejects.
  const currencyMissing = currency == null

  async function submit() {
    setError(null)
    if (currencyMissing) {
      setError('This proof has no single currency, so it can’t be ordered here yet.')
      return
    }
    if (!isCustomQuote && variants.length > 0 && !variantId) {
      setError('Please choose which option this order is for.')
      return
    }
    let quantityValue: number | null = null
    if (quantityMode === 'locked') {
      const q = Number(quantity)
      if (!Number.isInteger(q) || q <= 0) {
        setError('Enter a whole quantity greater than zero, or let the customer choose.')
        return
      }
      quantityValue = q
    }
    let shippingChargedValue: number | null = null
    if (shippingTreatment === 'manual') {
      const s = Number(shippingCharged)
      if (!Number.isFinite(s) || s < 0) {
        setError('Enter a manual shipping amount (zero or greater).')
        return
      }
      shippingChargedValue = s
    }

    // full_cost / goodwill: an optional destination-country hint (the customer
    // confirms country + enters postcode on the pay-page). goodwill also needs
    // the discount %. free / manual send neither.
    const shipDestCountryValue: string | null =
      (shippingTreatment === 'full_cost' || shippingTreatment === 'goodwill') && shipDestCountry
        ? shipDestCountry
        : null
    let shippingDiscountPercentValue: number | null = null
    if (shippingTreatment === 'goodwill') {
      const d = Number(shippingDiscountPercent)
      if (!Number.isFinite(d) || d < 0 || d > 100) {
        setError('Enter a goodwill discount between 0 and 100%.')
        return
      }
      shippingDiscountPercentValue = d
    }
    let customQuoteValue: number | null = null
    if (isCustomQuote) {
      const c = Number(customQuoteTotal)
      if (!Number.isFinite(c) || c < 0) {
        setError('This is a custom-quote proof — enter the agreed total.')
        return
      }
      customQuoteValue = c
    }

    setSubmitting(true)
    try {
      const { data, error: fnError } = await supabase.functions.invoke<
        | { id: string; token: string; status: string; payment_reference: string }
        | { error: string }
      >('create-order', {
        body: {
          proof_id: proofId,
          currency,
          quantity: quantityValue,
          names_count: namesCount,
          has_personalisation: hasPersonalisation,
          shipping_treatment: shippingTreatment,
          shipping_charged: shippingChargedValue,
          shipping_discount_percent: shippingDiscountPercentValue,
          ship_dest_country: shipDestCountryValue,
          custom_quote_total: customQuoteValue,
          material_variant_id: isCustomQuote ? undefined : variantId,
          material_option_id: isCustomQuote ? undefined : (optionId ?? undefined),
        },
      })
      if (fnError) {
        setError('Could not create the order. Please try again.')
        return
      }
      if (!data || 'error' in data) {
        setError((data as { error?: string } | null)?.error ?? 'Could not create the order.')
        return
      }
      setResult({ id: data.id, token: data.token, payment_reference: data.payment_reference })
      onCreated?.()
    } catch {
      setError('Could not create the order. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  async function copyLink() {
    if (!result) return
    const url = customerOrderUrl(result.id, result.token)
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard blocked (insecure context / permissions) — leave the
      // link visible for manual copy rather than failing loudly.
    }
  }

  const selectClass =
    'h-[38px] w-full rounded-[8px] border border-line bg-surface px-3 text-sm text-ink ' +
    'focus:outline-2 focus:outline-offset-1 focus:border-[var(--c-brand)] focus:outline-[var(--c-brand)]'

  // Derived display values for the indicative shipping estimate panel.
  const estimateCountryName =
    SHIP_COUNTRIES.find((c) => c.code === shipDestCountry)?.name ?? shipDestCountry
  const estimatePct = (() => {
    const d = Number(shippingDiscountPercent)
    return Number.isFinite(d) && d >= 0 && d <= 100 ? d : null
  })()
  const estimateCurrency = currency ?? 'GBP'

  return (
    <Modal open onClose={onClose} ariaLabel="Create order" panelClassName="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl">
      {result ? (
        // ── Success ──────────────────────────────────────────────
        <div>
          <h2 className="text-lg font-semibold text-ink">Order created</h2>
          <p className="mt-1 text-sm text-ink-soft">
            Reference <span className="font-medium text-ink">{result.payment_reference}</span>
            {customerLabel ? ` for ${customerLabel}` : ''}.
          </p>

          {sent ? (
            // Sent confirmation.
            <>
              <div className="mt-4 rounded-lg border border-in-stock bg-in-stock-soft px-3 py-2.5 text-[13px] text-ink">
                Payment link sent to the customer on Help Scout. They&rsquo;ll get it by email.
              </div>
              <div className="mt-5 flex items-center justify-end gap-2">
                <ButtonGhost onClick={copyLink}>{copied ? 'Copied' : 'Copy link'}</ButtonGhost>
                <ButtonCoral onClick={onClose}>Done</ButtonCoral>
              </div>
            </>
          ) : hasHelpScoutConversation ? (
            // Send via Help Scout — editable message with the link embedded.
            <>
              <p className="mt-3 text-[13px] text-ink-soft">
                Send the payment link to the customer on the linked Help Scout conversation:
              </p>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={8}
                className="mt-2 w-full rounded-lg border border-line bg-surface p-3 text-sm text-ink focus:border-[var(--c-brand)] focus:outline-2 focus:outline-offset-1 focus:outline-[var(--c-brand)]"
              />
              {sendError && (
                <div className="mt-2 rounded-lg border border-out bg-out-soft px-3 py-2 text-[13px] text-out">{sendError}</div>
              )}
              <div className="mt-4 flex items-center justify-end gap-2">
                <ButtonGhost onClick={copyLink}>{copied ? 'Copied' : 'Copy link'}</ButtonGhost>
                <ButtonGhost onClick={onClose} disabled={sending}>Close</ButtonGhost>
                <ButtonCoral onClick={() => void sendToCustomer()} disabled={sending || !message.trim()}>
                  {sending ? 'Sending…' : 'Send to customer'}
                </ButtonCoral>
              </div>
            </>
          ) : (
            // No linked conversation — copy the link to send it manually.
            <>
              <div className="mt-4 rounded-lg border border-line bg-canvas p-3">
                <p className="break-all font-mono text-[12px] text-ink-soft">{customerOrderUrl(result.id, result.token)}</p>
              </div>
              <p className="mt-2 text-[12px] text-ink-mute">
                This proof has no linked Help Scout conversation, so copy the link and send it to the customer yourself.
              </p>
              <div className="mt-5 flex items-center justify-end gap-2">
                <ButtonGhost onClick={copyLink}>{copied ? 'Copied' : 'Copy link'}</ButtonGhost>
                <ButtonCoral onClick={onClose}>Done</ButtonCoral>
              </div>
            </>
          )}
        </div>
      ) : (
        // ── Form ─────────────────────────────────────────────────
        <div>
          <h2 className="text-lg font-semibold text-ink">Create order</h2>
          <p className="mt-1 text-sm text-ink-soft">
            {customerLabel ? `For ${customerLabel}. ` : ''}
            {materialDisplay ?? 'Material'} · {currency ?? '—'}
            {namesCount > 1 ? ` · ${namesCount} people` : ''}
            {hasPersonalisation ? ' · personalisation' : ''}
          </p>

          {currencyMissing && (
            <div className="mt-4 rounded-lg border border-low bg-low-soft px-3 py-2 text-[13px] text-ink">
              This proof has no single currency (a per-direction-pricing round), so it can&rsquo;t be ordered through this flow yet.
            </div>
          )}

          <div className="mt-4 space-y-5">
            {/* Variant — grid orders only; sets the price tiers the
                server prices against. */}
            {!isCustomQuote && (
              <Field label="Option" htmlFor="order-variant" hint="Which variant this order is for — sets the price used at checkout.">
                {variantsLoading ? (
                  <p className="text-sm text-ink-mute">Loading options…</p>
                ) : variants.length === 0 ? (
                  <p className="text-sm text-ink-mute">
                    No priced options found for this material/currency. You can still create the order, but it won&rsquo;t be payable online yet.
                  </p>
                ) : lockedFromProof ? (
                  <p className="text-sm text-ink">
                    {variants.find((v) => v.id === variantId)?.display_name}
                    <span className="text-ink-mute"> · from the proof</span>
                  </p>
                ) : variants.length === 1 ? (
                  <p className="text-sm text-ink">{variants[0].display_name}</p>
                ) : (
                  <select
                    id="order-variant"
                    value={variantId ?? ''}
                    onChange={(e) => setVariantId(e.target.value || null)}
                    className={selectClass}
                  >
                    <option value="">Choose…</option>
                    {variants.map((v) => (
                      <option key={v.id} value={v.id}>{v.display_name}</option>
                    ))}
                  </select>
                )}
              </Field>
            )}

            {/* Finish (material option) — metals etc. The customer can change
                the finish at order time, so the designer picks it here; the
                price includes any finish surcharge at checkout. */}
            {!isCustomQuote && materialOptions.length > 0 && (
              <Field
                label={optionLabel}
                asLabel={false}
                hint={`Which ${optionLabel.toLowerCase()} the customer is ordering — the price includes any ${optionLabel.toLowerCase()} surcharge at checkout.`}
              >
                <div className="flex flex-wrap gap-2">
                  {materialOptions.map((o) => (
                    <button
                      key={o.id}
                      type="button"
                      onClick={() => setOptionId(o.id)}
                      className={[
                        'rounded-full px-4 py-1.5 text-sm font-medium transition-colors',
                        optionId === o.id ? 'bg-ink text-on-ink' : 'bg-surface text-ink-soft ring-1 ring-line hover:bg-canvas',
                      ].join(' ')}
                    >
                      {o.display_name}
                    </button>
                  ))}
                </div>
              </Field>
            )}

            {/* Quantity */}
            <Field label="Quantity" asLabel={false} hint="Let the customer choose on the pay-page, or lock a specific quantity now.">
              <div className="flex flex-wrap gap-2">
                {([['open', 'Customer chooses'], ['locked', 'Lock a quantity']] as const).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setQuantityMode(mode)}
                    className={[
                      'rounded-full px-4 py-1.5 text-sm font-medium transition-colors',
                      quantityMode === mode ? 'bg-ink text-on-ink' : 'bg-surface text-ink-soft ring-1 ring-line hover:bg-canvas',
                    ].join(' ')}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {quantityMode === 'locked' && (
                <Input
                  type="number"
                  min={1}
                  step={1}
                  inputMode="numeric"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  placeholder="e.g. 250"
                  className="mt-2 max-w-[200px]"
                />
              )}
            </Field>

            {/* Shipping treatment */}
            <Field label="Shipping" htmlFor="order-shipping-treatment" hint="Full cost / Goodwill quote the live carriage at checkout (UK flat DPD rate, or FedEx internationally) — the customer enters their postcode on the pay-page. Goodwill takes a % off. Free = no charge; Manual = a fixed amount.">
              <select
                id="order-shipping-treatment"
                value={shippingTreatment}
                onChange={(e) => setShippingTreatment(e.target.value as ShippingTreatment)}
                className={selectClass}
              >
                {TREATMENT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>

              {/* Optional destination-country pre-fill — full_cost / goodwill.
                  The customer confirms it and enters their postcode at checkout. */}
              {(shippingTreatment === 'full_cost' || shippingTreatment === 'goodwill') && (
                <div className="mt-2">
                  <select
                    aria-label="Destination country (optional)"
                    value={shipDestCountry}
                    onChange={(e) => setShipDestCountry(e.target.value)}
                    className={selectClass}
                  >
                    <option value="">Destination country (optional — customer confirms at checkout)</option>
                    {SHIP_COUNTRIES.map((c) => (
                      <option key={c.code} value={c.code}>{c.name}</option>
                    ))}
                  </select>
                </div>
              )}

              {/* Goodwill discount %. */}
              {shippingTreatment === 'goodwill' && (
                <div className="mt-2 flex items-center gap-2">
                  <Input
                    aria-label="Goodwill shipping discount percent"
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    inputMode="numeric"
                    value={shippingDiscountPercent}
                    onChange={(e) => setShippingDiscountPercent(e.target.value)}
                    placeholder="e.g. 50"
                    className="max-w-[120px]"
                  />
                  <span className="text-sm text-ink-soft">% off the computed rate</span>
                </div>
              )}

              {/* Indicative shipping estimate — full_cost / goodwill, once a
                  country is chosen. Gives the designer a ballpark to inform the
                  goodwill decision; the real rate is computed at checkout. */}
              {(shippingTreatment === 'full_cost' || shippingTreatment === 'goodwill') && shipDestCountry && (
                <div className="mt-3 rounded-lg border border-line bg-canvas p-3 text-[13px]">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium text-ink">Estimated shipping</span>
                    {/* Open orders: the designer picks a quantity to estimate
                        against. Locked orders: estimate against the order's own
                        quantity (read-only) — no second input to conflict. */}
                    {quantityMode === 'open' ? (
                      <label className="flex items-center gap-1.5 text-ink-soft">
                        for
                        <input
                          aria-label="Estimate quantity"
                          type="number"
                          min={1}
                          step={1}
                          inputMode="numeric"
                          value={estimateQty}
                          onChange={(e) => setEstimateQty(e.target.value)}
                          className="h-8 w-20 rounded-md border border-line bg-surface px-2 text-right text-ink focus:outline-2 focus:outline-offset-1 focus:border-[var(--c-brand)] focus:outline-[var(--c-brand)]"
                        />
                        cards
                      </label>
                    ) : (
                      quantity && <span className="text-ink-soft">for {Number(quantity).toLocaleString()} cards</span>
                    )}
                  </div>
                  <div className="mt-2">
                    {estimate.kind === 'loading' && <p className="text-ink-mute">Estimating…</p>}
                    {estimate.kind === 'idle' && (
                      <p className="text-ink-mute">
                        {isCustomQuote
                          ? 'Not estimated for custom quotes.'
                          : variants.length > 1 && !variantId
                            ? 'Choose an option above to estimate shipping.'
                            : estimateWeightGrams == null
                              ? 'A shipping estimate isn’t available for this option.'
                              : 'Enter a quantity to estimate shipping.'}
                      </p>
                    )}
                    {estimate.kind === 'unavailable' && (
                      <p className="text-ink-soft">
                        We can&rsquo;t estimate shipping to {estimateCountryName} here — it&rsquo;ll be calculated from the customer&rsquo;s postcode at checkout.
                      </p>
                    )}
                    {estimate.kind === 'error' && (
                      <p className="text-ink-soft">Couldn&rsquo;t fetch an estimate just now — shipping is calculated at checkout.</p>
                    )}
                    {estimate.kind === 'ready' && (
                      <>
                        <p className="text-ink">
                          ≈ <span className="font-semibold">{formatPrice(estimate.amount, estimateCurrency)}</span> to a typical {estimateCountryName} address
                          <span className="text-ink-mute"> · {estimate.serviceLabel}</span>
                        </p>
                        {shippingTreatment === 'goodwill' && estimatePct != null && estimatePct > 0 && (
                          <p className="mt-1 text-ink-soft">
                            With {estimatePct}% off, the customer pays ≈ {formatPrice(Math.round(estimate.amount * (1 - estimatePct / 100) * 100) / 100, estimateCurrency)} and you cover ≈ {formatPrice(Math.round(estimate.amount * (estimatePct / 100) * 100) / 100, estimateCurrency)}.
                          </p>
                        )}
                        <p className="mt-1 text-[12px] text-ink-mute">
                          Indicative only — the final rate uses the customer&rsquo;s actual postcode at checkout.
                        </p>
                      </>
                    )}
                  </div>
                </div>
              )}

              {shippingTreatment === 'manual' && (
                <Input
                  type="number"
                  min={0}
                  step={0.01}
                  inputMode="decimal"
                  value={shippingCharged}
                  onChange={(e) => setShippingCharged(e.target.value)}
                  placeholder={`Shipping amount (${currency ?? 'GBP'})`}
                  className="mt-2 max-w-[240px]"
                />
              )}
            </Field>

            {/* Custom quote total — only for custom-quote proofs */}
            {isCustomQuote && (
              <Field label="Custom quote total" htmlFor="order-custom-total" hint="This proof is a custom quote, so enter the agreed total.">
                <Input
                  id="order-custom-total"
                  type="number"
                  min={0}
                  step={0.01}
                  inputMode="decimal"
                  value={customQuoteTotal}
                  onChange={(e) => setCustomQuoteTotal(e.target.value)}
                  placeholder={`Total (${currency ?? 'GBP'})`}
                  className="max-w-[240px]"
                />
              </Field>
            )}
          </div>

          {error && (
            <div className="mt-4 rounded-lg border border-out bg-out-soft px-3 py-2 text-[13px] text-out">{error}</div>
          )}

          <div className="mt-6 flex items-center justify-end gap-2">
            <ButtonGhost onClick={onClose} disabled={submitting}>Cancel</ButtonGhost>
            <ButtonCoral onClick={() => void submit()} disabled={submitting || currencyMissing}>
              {submitting ? 'Creating…' : 'Create order'}
            </ButtonCoral>
          </div>
        </div>
      )}
    </Modal>
  )
}
