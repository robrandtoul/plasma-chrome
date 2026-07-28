import { useEffect, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { formatPrice } from '../lib/currency'
import { getPublicSettings } from '../lib/publicSettings'
import { Lock } from 'lucide-react'
import { Pill, PanelShell } from '../design'
import { CustomerHeader } from '../components/CustomerHeader'
import { FinishChoiceCard } from '../components/FinishChoiceCard'
import { RecapArtwork, buildRecapTiles } from '../components/ArtworkFade'
import { LoadingProofAnimation } from '../components/LoadingProofAnimation'
import { pricesFlatAboveTopTier, MAX_ONLINE_FLAT_QUANTITY } from '../lib/quote/interpolation'
import { totalFromTiers, surchargeFromTiers, thicknessNoteFor, type SpecVariantChoice, type SpecFinishChoice } from '../lib/openSpecTiers'
import { exVat, isGbpOrderVatFree, normaliseShipDestination } from '../lib/ukVatArea'
import { isEuVatCountry } from '../lib/euVatArea'
import { hasThicknessGuide, thicknessSetForMaterial, type ThicknessOption } from '../lib/metalThicknessNotes'
import { parsePreviousSpec, chooserGuidance, quantityHint } from '../lib/previousSpec'
import { finishIsPreferenceOnly } from '../lib/materialTraits'
import { SHIP_COUNTRIES } from '../lib/shipCountries'
import { loadStripeJs, type StripeLike, type StripeElementsLike } from '../lib/stripeJs'
import type { GridImage } from '../components/ImageGrid'
import type { Currency, CustomerProofGraph } from '../lib/types'

// Customer pay-page (Ordering & checkout, Step 4 — shell).
//
// Anonymous, tokenised: reads one order via the public_get_order RPC
// (migration 000230), scoped to the order id + the secret token in the
// URL (?token=). The page never signs in — same anon posture as the
// proof page (/p/:id).
//
// THIS IS THE SHELL: it resolves the order, renders the recap + the
// payable / already-paid / expired states, and shows where the price
// and Pay button will go. The live price computation and the Stripe
// Checkout handoff land in the next increment, once the Stripe test
// key is set. The whole feature is gated behind settings.ordering_enabled
// on the staff side, so no live order reaches here until ordering is on.

interface OrderPayload {
  id: string
  proof_id: string
  status: 'draft' | 'sent' | 'paid' | 'fulfilled' | 'expired' | 'cancelled' | 'revision'
  material_variant_id: string | null
  material_option_id: string | null
  // Open-spec (000298): the designer left the thickness / finish for the
  // customer to choose here. material_id scopes the chooser to the order's
  // material; the *_open flags stay true even after a choice is persisted at
  // checkout, so "Edit order details" can change the pick pre-payment.
  material_id: string | null
  thickness_open: boolean
  finish_open: boolean
  // Open quantity (000302): durable like the two flags above — a checkout
  // call persists the customer's pick onto `quantity` (for the invoice), so
  // the flag, not quantity-is-null, is what keeps the field editable on a
  // revisit. person_quantities carries a persisted per-person split back so
  // the inputs can pre-fill.
  quantity_open: boolean
  // "Same as last time" guidance (000364): what this customer ordered on
  // their previous paid order, confirmed by the designer at order time.
  // Parsed defensively via parsePreviousSpec — display guidance only, and
  // null (no guidance) for the overwhelming majority of orders.
  previous_spec: unknown
  person_quantities: { name: string; quantity: number }[] | null
  quantity: number | null
  names_count: number
  has_personalisation: boolean
  custom_quote_total: number | null
  // 'production' (default) | 'prototype' — labels the cost row as a prototype
  // sample rather than the generic "Agreed price".
  order_kind: string | null
  shipping_treatment: 'full_cost' | 'goodwill' | 'free' | 'manual'
  shipping_charged: number | null
  // The rating destination. Doubles as the designer's optional country hint
  // AND the customer's own answer, which create-checkout-session persists —
  // so both halves must pre-fill on a revisit, or the form comes back looking
  // finished with one empty box (see the load effect).
  ship_dest_country: string | null
  ship_dest_postcode: string | null
  vat_treatment: string | null
  currency: Currency
  expires_at: string | null
  payment_reference: string | null
  paid_at: string | null
  // Price breakdown stamped at checkout (create-checkout-session), so present
  // on the post-payment confirmation. Null on legacy rows → the summary falls
  // back to the figures it can compute.
  amount_cards: number | null
  amount_tooling: number | null
  amount_personalisation: number | null
  amount_shipping: number | null
  // US tariff & customs handling (migration 000249): the charged fee + the
  // customer's opt-out choice, stamped at checkout. Null/false on legacy rows.
  amount_us_tariff: number | null
  // Designer-set cards discount stamped at checkout (the resolved amount, >= 0).
  // Shown as a separate negative line; null on legacy rows → no discount.
  amount_card_discount: number | null
  // Designer-set cards discount RULE (type + value). public_get_order returns
  // the whole order row, so these are already on the wire — the open-quantity
  // pre-checkout summary uses them to show the discount + the correct button
  // total before create-checkout-session stamps the resolved amount. Mirrors
  // the server's resolveCardDiscount.
  card_discount_type: 'none' | 'percent' | 'fixed' | null
  card_discount_value: number | null
  us_tariff_opted_out: boolean
  // Delivery details Stripe collected, persisted by the webhook on the
  // sent → paid flip — so only present once the payment is confirmed.
  ship_to_name: string | null
  ship_to_address: {
    line1: string | null
    line2: string | null
    city: string | null
    region: string | null
    postal_code: string | null
    country: string | null
  } | null
  // Optional VAT / EORI number the customer gave at checkout (migration 000341),
  // for the customs paperwork on EU-bound B2B exports. public_get_order returns
  // the whole order row (minus token), so it flows here automatically; used only
  // to pre-fill the field on a revisit. Written back via record_order_customs_tax_id.
  customs_tax_id: string | null
  // Server-computed customer order-tracking projection (Order log Phase 3).
  // Always present; level 'off' = nothing shown (the OFF-by-default master
  // switch + the per-route/per-supplier disclosure rules are resolved entirely
  // server-side, so the raw production status / supplier dates never reach here).
  tracking_projection?: TrackingProjection
  // Combined-payment group membership (bundle orders Slice 2, migration
  // 000309). While the group is active ('sent'), this order pays through the
  // GROUP's link — checkout here would double-charge, so the page shows a
  // quiet redirect message instead of the pay form.
  order_group_id: string | null
  order_group_status: 'sent' | 'paid' | 'cancelled' | null
}

// Only the projected result crosses to the client — never a raw Stock Control
// row. 'broad' is date-free; 'granular' adds the customer's outbound tracking
// number (a clickable carrier link is deferred until a carrier URL is available).
type TrackingStage = 'paid' | 'in_production' | 'on_its_way' | 'delivered'
type TrackingProjection =
  | { level: 'off' }
  | { level: 'broad' | 'granular'; stage?: TrackingStage; tracking_number?: string }

// Customer-facing copy per tracking stage: the headline + the one line that
// replaces the old static "what happens next" box, so it stays accurate on
// every visit (not just right after payment).
const STAGE_META: Record<TrackingStage, { label: string; line: string }> = {
  paid:          { label: 'Paid',          line: 'We’ve got your order and we’re getting it ready.' },
  in_production: { label: 'In production', line: 'We’re making your cards now — we’ll email you the moment they’re on their way.' },
  on_its_way:    { label: 'On its way',    line: 'Your cards are on their way.' },
  delivered:     { label: 'Delivered',     line: 'Delivered — we hope they look great.' },
}
const STAGE_STEPS: { key: TrackingStage; label: string }[] = [
  { key: 'paid', label: 'Paid' },
  { key: 'in_production', label: 'In production' },
  { key: 'on_its_way', label: 'On its way' },
  { key: 'delivered', label: 'Delivered' },
]
function stageIndex(stage: TrackingStage): number {
  return stage === 'delivered' ? 3 : stage === 'on_its_way' ? 2 : stage === 'in_production' ? 1 : 0
}

// Metals (and similar) express their variant as a thickness ("300 micron"),
// which reads clearer to a customer than the generic "Option" label.
function variantLabel(variant: string): string {
  return /micron|µm|\bum\b/i.test(variant) ? 'Thickness' : 'Option'
}

const SHIPPING_LABEL: Record<OrderPayload['shipping_treatment'], string> = {
  full_cost: 'Standard shipping',
  goodwill: 'Shipping (partly covered by us)',
  free: 'Free shipping',
  manual: 'Shipping',
}

// Stripe.js loader + the minimal Elements types — shared with the group pay
// page via src/lib/stripeJs.ts (extracted verbatim; one copy of the
// PCI-relevant loading code). We build our own checkout layout and mount
// Stripe's Payment / Address / Link elements into it, then confirm the
// PaymentIntent.

export default function OrderPayPage() {
  const { id } = useParams<{ id: string }>()
  const [params] = useSearchParams()
  const token = params.get('token')

  const [loading, setLoading] = useState(true)
  const [order, setOrder] = useState<OrderPayload | null>(null)
  const [company, setCompany] = useState<string | null>(null)
  // Recap (trust anchor): thumbnails of the approved artwork + a one-line
  // spec. Pulled best-effort from the same proof graph + customer-proof-images
  // edge function the proof page uses; failure leaves the recap off without
  // blocking pay. ALL current-version images are kept (not just one
  // front/back) so the preview can re-filter to the finish the customer picks
  // in the open-spec chooser — choose Mirror, see the mirror artwork.
  const [versionImages, setVersionImages] = useState<GridImage[]>([])
  // Finish code locked on the order (or persisted from an earlier checkout
  // call), so the recap shows the right finish tab even without a live pick.
  const [lockedFinishCode, setLockedFinishCode] = useState<string | null>(null)
  const [spec, setSpec] = useState<{
    material: string
    variant: string | null
    finish: string | null
    approvedAt: string | null
    inks: string[]
  } | null>(null)
  // Open-quantity support: when the designer left the quantity for the
  // customer to choose (order.quantity == null on a grid order), the
  // selector is populated from the order variant's listed price tiers,
  // and the total recomputes live as the customer picks. The chosen
  // quantity is re-validated + re-priced server-side at checkout — the
  // client total is for display only and (because the selector is locked
  // to exact listed tiers) is byte-equal to what the server charges.
  const [tiers, setTiers] = useState<{ quantity: number; total_price: number }[]>([])
  // Metal + carbon fibre: above the top listed tier, hold the top per-card
  // rate flat (no volume discount past 1000) instead of blocking the quantity.
  // Set from the material code so the pay-page figure matches the server charge.
  const [flatAboveTop, setFlatAboveTop] = useState(false)
  const [perExtraName, setPerExtraName] = useState<number | null>(null)
  const [personalisation, setPersonalisation] = useState<{ perCardRate: number; minCharge: number } | null>(null)
  // Per-quantity finish (material-option) surcharge schedule, set when the
  // order pinned a non-base finish (metal Brushed/Mirror). Read from the same
  // customer-proof graph; interpolated client-side the same way the server
  // does so the shown total equals the charge. The finish name itself lives on
  // `spec.finish` for the recap.
  const [finishTiers, setFinishTiers] = useState<{ quantity: number; surcharge: number }[]>([])
  const [chosenQuantity, setChosenQuantity] = useState<number | null>(null)
  // Open-spec chooser (000298): the offerable thicknesses (with their tiers)
  // and finishes (with surcharge schedules + a per-finish artwork swatch),
  // scoped to the order's material from the same proof graph. The customer's
  // picks feed `tiers` / `finishTiers` above so every downstream calculation
  // works unchanged, and ride the create-checkout-session call for
  // server-side validation + persistence.
  const [specVariants, setSpecVariants] = useState<SpecVariantChoice[]>([])
  const [chosenVariantId, setChosenVariantId] = useState<string | null>(null)
  const [specFinishes, setSpecFinishes] = useState<SpecFinishChoice[]>([])
  const [chosenOptionId, setChosenOptionId] = useState<string | null>(null)
  // Admin-editable thickness education copy (settings.metal_thickness_notes),
  // resolved for this material. Empty for non-metal open-spec orders — the
  // cards then show the variant name + price without a description.
  const [thicknessNotes, setThicknessNotes] = useState<ThicknessOption[]>([])
  // "Not sure? Ask us" escape hatch → the order-question edge fn.
  const [askOpen, setAskOpen] = useState(false)
  const [askText, setAskText] = useState('')
  const [askState, setAskState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')
  // Per-person quantities (split-name orders). The people come from the
  // proof's current version; the customer enters a quantity for each, and
  // the combined total drives the price. Empty for single-person orders.
  const [personNames, setPersonNames] = useState<string[]>([])
  const [personQty, setPersonQty] = useState<Record<string, string>>({})
  // Delivery destination for full_cost / goodwill: the customer picks the
  // country + enters their postcode here so we can rate the carriage at
  // checkout (support rarely knows the postcode upfront). Country pre-fills
  // from the designer's optional hint on the order.
  const [destCountry, setDestCountry] = useState('')
  const [destPostcode, setDestPostcode] = useState('')
  // Optional VAT / EORI number for EU-bound customs paperwork (migration 000341).
  // Pre-filled from the order if already stored (staff-entered or a prior visit)
  // without clobbering anything the customer is typing; saved at Pay time.
  const [customsTaxId, setCustomsTaxId] = useState('')
  // US tariff & customs handling: per-currency fee + copy (from public_settings),
  // the customer's opt-out, and the inline opt-out confirmation. Included by
  // default; opting out requires confirming the consequence (they then deal with
  // US Customs themselves). The opt-out feeds the create-checkout call, so the
  // PaymentIntent total reflects it; toggling it after the intent re-prices via
  // "Edit order details".
  const [tariff, setTariff] = useState<{ intro: string; warning: string; fees: Record<Currency, number> } | null>(null)
  const [tariffOptedOut, setTariffOptedOut] = useState(false)
  const [tariffConfirmingOptOut, setTariffConfirmingOptOut] = useState(false)
  const [notFound, setNotFound] = useState(false)
  const [paying, setPaying] = useState(false)
  const [payError, setPayError] = useState<string | null>(null)
  // Custom checkout (Stripe Elements): once the PaymentIntent is created, this
  // holds the client secret, publishable key, and the authoritative total; an
  // effect mounts the Payment / Address / Link elements into our own layout.
  const [checkout, setCheckout] = useState<{
    clientSecret: string
    pk: string
    amount: number
    currency: Currency
    // Server-confirmed VAT relief (GBP order delivering to the Channel
    // Islands, priced ex-VAT) — drives the caption by the pay button.
    vatFree: boolean
    breakdown: { cards: number; tooling: number; personalisation: number; shipping: number; us_tariff: number; card_discount: number }
  } | null>(null)
  // True once the elements are mounted (drives the loading state).
  const [formMounted, setFormMounted] = useState(false)
  // True while confirmPayment is in flight, + any inline confirm error.
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  // VAT invoice (self-serve): once the order is paid, we check Xero for the
  // shareable online-invoice URL — but only surface it once the invoice has
  // reconciled to PAID (Stripe's receipt covers the immediate proof-of-payment).
  const [vat, setVat] = useState<{ state: 'loading' | 'ready' | 'pending' | 'unavailable'; url?: string } | null>(null)
  const mountWrapRef = useRef<HTMLDivElement | null>(null)
  // Held so the Pay button's handler can call confirmPayment on the same
  // Stripe + Elements instances the mount effect created.
  const stripeRef = useRef<StripeLike | null>(null)
  const elementsRef = useRef<StripeElementsLike | null>(null)
  // Buyer email captured from the Link element's change event, so we can pass it
  // as confirmParams.receipt_email at confirm time (Stripe doesn't do this for
  // us). This is what lands on the PaymentIntent and flows to the Xero invoice.
  const emailRef = useRef<string>('')
  // Set by Stripe's success_url redirect. Optimistic until the Step 5
  // webhook flips order.status to 'paid'; a later reload shows the real
  // paid state from the DB.
  const justPaid = params.get('paid') === '1'

  // Open-spec picks: feed the same `tiers` / `finishTiers` state the locked
  // path uses, so every downstream price calculation works unchanged.
  function chooseThickness(variantId: string) {
    setChosenVariantId(variantId)
    const v = specVariants.find((s) => s.id === variantId)
    setTiers(v?.tiers ?? [])
  }
  function chooseFinish(optionId: string) {
    setChosenOptionId(optionId)
    const f = specFinishes.find((s) => s.id === optionId)
    setFinishTiers(f && !f.is_base ? f.surTiers : [])
  }

  // "Not sure? Ask us" — posts the question to the team's Help Scout thread
  // via the order-question edge fn (token-scoped) and flags the order for
  // staff. Never blocks or navigates; the customer can still pay after.
  async function sendQuestion() {
    if (!id || !token || !askText.trim() || askState === 'sending') return
    setAskState('sending')
    try {
      const { data, error } = await supabase.functions.invoke<{ status?: string; error?: string }>(
        'order-question',
        { body: { order_id: id, token, question: askText.trim() } },
      )
      if (error || !data || data.error) {
        setAskState('error')
        return
      }
      setAskState('sent')
    } catch {
      setAskState('error')
    }
  }

  async function startCheckout() {
    if (!order || !id || !token) return
    setPayError(null)
    setPaying(true)
    // Per-person split (combined-total pricing): send each person's quantity
    // so the server sums + validates + prices it. Only for multi-person orders;
    // otherwise omitted and the server uses the single quantity (chosen or
    // locked). chosenQuantity is only set for single-person open orders.
    const personPayload =
      personNames.length > 1
        ? personNames
            .map((n) => ({ name: n, quantity: parseInt(personQty[n] ?? '', 10) }))
            .filter((p) => Number.isFinite(p.quantity) && p.quantity > 0)
        : []
    try {
      const { data, error } = await supabase.functions.invoke<{ client_secret?: string; publishable_key?: string; amount?: number; currency?: Currency; vat_free?: boolean; breakdown?: { cards: number; tooling: number; personalisation: number; shipping: number; us_tariff: number; card_discount: number }; error?: string; message?: string }>(
        'create-checkout-session',
        {
          body: {
            order_id: id,
            token,
            origin: window.location.origin,
            quantity: chosenQuantity ?? undefined,
            person_quantities: personPayload.length > 0 ? personPayload : undefined,
            // Open-spec picks (000298) — validated server-side against the
            // order's material and persisted onto the order before pricing.
            material_variant_id: order.thickness_open && chosenVariantId ? chosenVariantId : undefined,
            material_option_id: order.finish_open && chosenOptionId ? chosenOptionId : undefined,
            ship_dest_country: destCountry || undefined,
            ship_dest_postcode: destPostcode.trim() || undefined,
            us_tariff_opted_out: tariffOptedOut,
          },
        },
      )
      if (error || !data || data.error || !data.client_secret || !data.publishable_key || data.amount == null || !data.currency) {
        // On a non-2xx, supabase-js sets `error` (FunctionsHttpError) and
        // leaves `data` null — the friendly message we returned lives on the
        // error's Response body, so dig it out before falling back.
        let serverMessage = data?.message ?? null
        const ctx = (error as { context?: Response } | null)?.context
        if (!serverMessage && ctx && typeof ctx.json === 'function') {
          try {
            const body = await ctx.json()
            if (body && typeof body.message === 'string') serverMessage = body.message
          } catch {
            // body wasn't JSON — fall through to the generic message
          }
        }
        setPayError(serverMessage ?? 'We couldn’t start checkout. Please reply to the email you received and we’ll help.')
        setPaying(false)
        return
      }
      // Switch to the in-page checkout (the mount effect below renders the
      // Elements). Keep `paying` true so the button stays disabled in the
      // moment before the layout swaps.
      setCheckout({
        clientSecret: data.client_secret,
        pk: data.publishable_key,
        amount: data.amount,
        currency: data.currency,
        vatFree: data.vat_free === true,
        breakdown: data.breakdown ?? { cards: data.amount, tooling: 0, personalisation: 0, shipping: 0, us_tariff: 0, card_discount: 0 },
      })
    } catch {
      setPayError('We couldn’t start checkout. Please reply to the email you received and we’ll help.')
      setPaying(false)
    }
  }

  // Mount Stripe Elements once we have a PaymentIntent client secret. Loads
  // Stripe.js from the CDN, creates the Elements group, and mounts the Link
  // (email), Address (shipping) and Payment elements into our own layout. The
  // Address element rides confirmPayment automatically (→ payment_intent.shipping,
  // including the required recipient phone we collect for the courier paperwork),
  // but the Link element's email does NOT — we capture it via its change event
  // and pass it as confirmParams.receipt_email at confirm time (see confirmPay).
  useEffect(() => {
    if (!checkout) return
    let cancelled = false
    void (async () => {
      const StripeFactory = await loadStripeJs()
      if (cancelled) return
      if (!StripeFactory) {
        setPayError('We couldn’t load the secure payment form. Please reply to the email you received and we’ll help.')
        setCheckout(null)
        setPaying(false)
        return
      }
      try {
        const stripe = StripeFactory(checkout.pk)
        const elements = stripe.elements({ clientSecret: checkout.clientSecret, appearance: { theme: 'stripe' } })
        stripeRef.current = stripe
        elementsRef.current = elements
        const linkAuth = elements.create('linkAuthentication')
        // Capture the email so confirmPay can stamp it onto the PaymentIntent.
        linkAuth.on?.('change', (e) => { emailRef.current = e?.value?.email ?? '' })
        linkAuth.mount('#link-auth')
        // Phone is required: FedEx (and DPD) need a recipient contact number on
        // the shipping paperwork. It lands on payment_intent.shipping.phone and
        // the webhook persists it as orders.ship_to_phone.
        elements
          .create('address', {
            mode: 'shipping',
            fields: { phone: 'always' },
            validation: { phone: { required: 'always' } },
          })
          .mount('#address-element')
        elements.create('payment').mount('#payment-element')
        if (cancelled) return
        setFormMounted(true)
        requestAnimationFrame(() => {
          mountWrapRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        })
      } catch {
        setPayError('We couldn’t load the secure payment form. Please reply to the email you received and we’ll help.')
        setCheckout(null)
        setPaying(false)
      }
    })()
    return () => {
      cancelled = true
      setFormMounted(false)
      stripeRef.current = null
      elementsRef.current = null
    }
  }, [checkout])

  // Confirm the payment. On success Stripe redirects to return_url (?paid=1);
  // only an immediate validation/card error returns here, which we surface
  // inline so the customer can fix it without losing the page.
  async function confirmPay() {
    if (!stripeRef.current || !elementsRef.current || !id || !token) return
    setSubmitting(true)
    setFormError(null)
    // Persist the optional VAT / EORI number before handing off to Stripe, so
    // the webhook (Xero invoice) and Stock Control (customs paperwork) have it.
    // Best-effort and independent of payment — a failure here must never block
    // the charge, and an empty field is skipped server-side so it can't wipe a
    // value staff entered on the shipping screen.
    const taxId = customsTaxId.trim()
    if (taxId) {
      const { error: taxErr } = await supabase.rpc('record_order_customs_tax_id', { p_order_id: id, p_token: token, p_tax_id: taxId })
      if (taxErr) console.warn('[pay] VAT/EORI save failed:', taxErr.message)
    }
    const { error } = await stripeRef.current.confirmPayment({
      elements: elementsRef.current,
      confirmParams: {
        return_url: `${window.location.origin}/order/${id}?token=${encodeURIComponent(token)}&paid=1`,
        // The buyer's email, so it lands on the PaymentIntent → the webhook →
        // the Xero contact, which is what lets the VAT invoice be emailed.
        ...(emailRef.current ? { receipt_email: emailRef.current } : {}),
      },
    })
    if (error) {
      setFormError(error.message ?? 'Your payment couldn’t be completed. Please check your details and try again.')
      setSubmitting(false)
    }
  }

  // Customer-accent brand ramp while this page is mounted (same trick
  // as CustomerProofPage), cleared on unmount.
  useEffect(() => {
    document.documentElement.classList.add('customer-accent')
    return () => document.documentElement.classList.remove('customer-accent')
  }, [])

  // Pre-fill the VAT / EORI field from a value already on the order, without
  // clobbering anything the customer has started typing (functional update, so
  // customsTaxId stays out of the deps).
  useEffect(() => {
    setCustomsTaxId((prev) => prev || (order?.customs_tax_id ?? ''))
  }, [order])

  // US tariff fee + copy (anon public_settings, cached). Loaded independently of
  // the order so the panel is ready by the time the order resolves.
  useEffect(() => {
    let cancelled = false
    void getPublicSettings().then((s) => {
      if (cancelled) return
      setTariff({
        intro: s.us_tariff_intro_copy,
        warning: s.us_tariff_optout_warning,
        fees: { GBP: s.us_tariff_fee_gbp, EUR: s.us_tariff_fee_eur, USD: s.us_tariff_fee_usd },
      })
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!id || !token) { setNotFound(true); setLoading(false); return }
    let cancelled = false
    void (async () => {
      const { data, error } = await supabase.rpc('public_get_order', {
        p_order_id: id,
        p_token: token,
      })
      if (cancelled) return
      if (error || data == null) {
        setNotFound(true)
        setLoading(false)
        return
      }
      const o = data as OrderPayload
      setOrder(o)
      // Record that the customer opened a still-payable pay link (most-recent
      // open). Fire-and-forget, ~1.5s after the page mounts in the browser, so
      // an email scanner that fetches the link without running JS — or an
      // instant bounce — doesn't log a false open. Token-validated server-side
      // (record_order_pay_link_opened), exactly like the read above.
      if (o.status === 'sent') {
        setTimeout(() => {
          if (cancelled) return
          void supabase
            .rpc('record_order_pay_link_opened', { p_order_id: id, p_token: token })
            .then(({ error: e }) => { if (e) console.error('[OrderPayPage] record pay-link open failed:', e.message) })
        }, 1500)
      }
      // Pre-fill the destination from the designer's optional hint so the
      // customer usually just adds their postcode — and, on a revisit, from
      // whatever a previous checkout call persisted. Both halves or neither:
      // restoring only the country left the form looking complete with an
      // empty postcode box, and the button then named the country (visibly
      // filled) as the thing to fix, which reads as a broken button.
      if (o.ship_dest_country) setDestCountry(o.ship_dest_country)
      if (o.ship_dest_postcode) setDestPostcode(o.ship_dest_postcode)
      // Open-quantity revisit: pre-fill the inputs with the pick a previous
      // checkout call persisted, so the customer sees (and can change) their
      // earlier choice rather than a mysteriously fixed figure.
      if (o.quantity_open) {
        if (o.quantity != null) setChosenQuantity(o.quantity)
        if (Array.isArray(o.person_quantities) && o.person_quantities.length > 0) {
          setPersonQty(Object.fromEntries(o.person_quantities.map((p) => [p.name, String(p.quantity)])))
        }
      }
      // Reflect a previously-persisted opt-out (a returning customer); default included.
      if (o.us_tariff_opted_out) setTariffOptedOut(true)
      // Best-effort recap: pull the company/customer name, the spec, and
      // the approved artwork from the proof graph (anon RPC) + the images
      // edge function. Failure just leaves the recap thinner — never
      // blocks the pay-page.
      try {
        const { data: graph } = await supabase.rpc('public_get_customer_proof', { p_proof_id: o.proof_id })
        if (!cancelled && graph) {
          const g = graph as CustomerProofGraph
          setCompany(g.proof?.company?.trim() || g.proof?.customer_name?.trim() || null)

          // Spec line reads from the current (approved) version; the
          // variant label comes from the order's locked variant when set
          // (custom-quote orders have no variant, so it stays null).
          const current =
            g.versions?.find((v) => v.is_current) ?? g.versions?.[g.versions.length - 1] ?? null
          if (current) {
            const variant = o.material_variant_id
              ? g.material_variants?.find((mv) => mv.id === o.material_variant_id) ?? null
              : null
            const variantLabel =
              variant && variant.variant_type !== 'default' ? variant.display_name : null

            // Chosen finish (material option): name it on the spec, and when
            // it's a non-base finish, capture its surcharge schedule so the
            // displayed total includes the surcharge (mirroring the server).
            let finishName: string | null = null
            if (o.material_option_id) {
              const opt = (g.material_options ?? []).find((mo) => mo.id === o.material_option_id) ?? null
              if (opt) {
                finishName = opt.display_name
                setLockedFinishCode(opt.code)
                if (!opt.is_base && o.currency) {
                  setFinishTiers(
                    (g.material_option_surcharges ?? [])
                      .filter((s) => s.material_option_id === o.material_option_id && s.currency === o.currency)
                      .map((s) => ({ quantity: s.quantity, surcharge: Number(s.surcharge) }))
                      .sort((a, b) => a.quantity - b.quantity),
                  )
                }
              }
            }

            setSpec({
              material: current.material_display,
              variant: variantLabel,
              finish: finishName,
              approvedAt: g.proof?.approved_at ?? null,
              inks: current.ink_names ?? [],
            })
            setFlatAboveTop(pricesFlatAboveTopTier(current.material_code))

            // Open-quantity inputs (only meaningful when order.quantity is
            // null on a grid order, but harmless to capture either way):
            // the variant's listed tiers, the split-name surcharge
            // snapshot, and the per-currency personalisation rate.
            if (o.material_variant_id && o.currency) {
              const variantTiers = (g.price_tiers ?? [])
                .filter((t) => t.material_variant_id === o.material_variant_id && t.currency === o.currency)
                .map((t) => ({ quantity: t.quantity, total_price: Number(t.total_price) }))
                .sort((a, b) => a.quantity - b.quantity)
              setTiers(variantTiers)
            }

            // Open-spec chooser data (000298). Thickness: every priced variant
            // of the order's material, in catalogue order — the same set the
            // proof's pricing grid showed. A choice persisted by an earlier
            // checkout call (returning customer) pre-selects; its tiers were
            // already captured by the block above.
            if (o.thickness_open && o.material_id && o.currency) {
              const offerable: SpecVariantChoice[] = (g.material_variants ?? [])
                .filter((mv) => mv.material_id === o.material_id)
                .sort((a, b) => a.sort_order - b.sort_order)
                .map((mv) => ({
                  id: mv.id,
                  display_name: mv.display_name,
                  tiers: (g.price_tiers ?? [])
                    .filter((t) => t.material_variant_id === mv.id && t.currency === o.currency)
                    .map((t) => ({ quantity: t.quantity, total_price: Number(t.total_price) }))
                    .sort((a, b) => a.quantity - b.quantity),
                }))
                .filter((mv) => mv.tiers.length > 0)
              setSpecVariants(offerable)
              if (o.material_variant_id && offerable.some((v) => v.id === o.material_variant_id)) {
                setChosenVariantId(o.material_variant_id)
              }
              // Thickness education copy — the materials with a written set
              // (the metal family + Full Colour Plastic); anything else
              // renders name-only cards.
              if (hasThicknessGuide(current.material_code)) {
                try {
                  const s = await getPublicSettings()
                  if (!cancelled) {
                    setThicknessNotes(thicknessSetForMaterial(s.metal_thickness_notes, current.material_code))
                  }
                } catch {
                  // copy stays empty — cards render without descriptions
                }
              }
            }

            // Finish chooser: the options the approved version actually
            // offered (its 2+ finish tabs), with each one's surcharge
            // schedule. A persisted earlier pick pre-selects; its surcharge
            // tiers were captured by the block further up.
            if (o.finish_open && o.material_id && o.currency) {
              // Preference-only finishes (gloss/matte, 000303) never appear
              // as proof tabs — the artwork is identical in both — so the
              // chooser offers the whole catalogue. Artwork-visible finishes
              // (metal) stay scoped to the tabs the customer actually saw.
              const offeredCodes = finishIsPreferenceOnly(current.material_code)
                ? new Set<string>()
                : new Set(current.material_options ?? [])
              const finishes: SpecFinishChoice[] = (g.material_options ?? [])
                .filter((mo) => mo.material_id === o.material_id)
                .filter((mo) => offeredCodes.size === 0 || offeredCodes.has(mo.code))
                .sort((a, b) => a.sort_order - b.sort_order)
                .map((mo) => ({
                  id: mo.id,
                  code: mo.code,
                  display_name: mo.display_name,
                  is_base: mo.is_base,
                  surTiers: (g.material_option_surcharges ?? [])
                    .filter((s) => s.material_option_id === mo.id && s.currency === o.currency)
                    .map((s) => ({ quantity: s.quantity, surcharge: Number(s.surcharge) }))
                    .sort((a, b) => a.quantity - b.quantity),
                  photoUrl: mo.photo_url ?? null,
                  swatchUrl: null,
                  description: mo.description ?? null,
                }))
              setSpecFinishes(finishes)
              if (o.material_option_id && finishes.some((f) => f.id === o.material_option_id)) {
                setChosenOptionId(o.material_option_id)
              }
            }
            setPerExtraName(current.split_name_surcharge_snapshot ?? null)
            setPersonNames(current.names ?? [])
            if (o.has_personalisation) {
              const p = g.personalisation_pricing?.[o.currency]
              if (p) setPersonalisation({ perCardRate: Number(p.per_card_rate), minCharge: Number(p.min_charge) })
            }

            // Artwork thumbnails — same signed-URL edge function the proof
            // page uses. Scoped to the current version, QR rows excluded,
            // capped at three so the recap stays compact.
            try {
              const { data: imgData } = await supabase.functions.invoke<{ images: GridImage[] }>(
                'customer-proof-images',
                { body: { proofId: o.proof_id } },
              )
              if (!cancelled && imgData?.images) {
                const versionImgs = imgData.images
                  .filter(
                    (img) =>
                      (img as unknown as { proof_version_id: string }).proof_version_id === current.id,
                  )
                  .filter((img) => img.is_qr_code !== true)
                  .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
                // Show one image per side (front, then back) so the recap is the
                // real two-sided set rather than two of the same side (which the
                // first-two-by-sort-order approach picked when a version has
                // several images per side, e.g. per ink/option). Fall back to
                // the first two distinct images when there's no side data.
                // Keep the whole set; the render derives one front + one
                // back for the ACTIVE finish (see the thumbs derivation).
                setVersionImages(versionImgs)
                // Finish swatches for the open-spec chooser: one representative
                // (front-preferred) artwork image per finish tab, so the card
                // shows the customer's own design in that finish — honest
                // visuals, not stock imagery. Missing tab images → text card.
                if (o.finish_open) {
                  const byOption = new Map<string, string>()
                  for (const img of versionImgs) {
                    const code = img.material_option
                    if (!code || !img.signed_url) continue
                    if (!byOption.has(code) || img.side === 'front') byOption.set(code, img.signed_url)
                  }
                  setSpecFinishes((prev) =>
                    prev.map((f) => ({ ...f, swatchUrl: byOption.get(f.code) ?? null })),
                  )
                }
              }
            } catch {
              // ignore — recap shows the spec text without thumbnails
            }
          }
        }
      } catch {
        // ignore — recap heading falls back to a generic title
      }
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [id, token])

  // Auto-advance to the payment form for orders that need no customer input —
  // a locked/custom quantity AND non-rated shipping (free/manual). The customer
  // lands straight on the full checkout (recap + breakdown + card form) with no
  // intermediate click. Orders that still need a quantity or a shipping
  // destination keep the inline inputs + a Continue button. Fires once on load
  // (deps: order); checkout/paying are read via closure to avoid re-firing.
  useEffect(() => {
    if (!order || checkout || paying) return
    // An open-spec order with no persisted choice always shows the inputs
    // panel — the chooser IS the step. A returning customer whose earlier
    // choice was persisted at checkout can auto-advance as usual (their pick
    // pre-selects, and "Edit order details" reopens the chooser).
    const needsSpec =
      order.custom_quote_total == null &&
      ((order.thickness_open && order.material_variant_id == null) ||
        (order.finish_open && order.material_option_id == null))
    const needsQty = order.custom_quote_total == null && order.material_variant_id != null && order.quantity == null
    const needsDest = order.shipping_treatment === 'full_cost' || order.shipping_treatment === 'goodwill'
    // A US destination always shows the inputs panel (don't auto-advance), so the
    // customer sees the US tariff & customs handling line and its opt-out before
    // the PaymentIntent is created. For full_cost/goodwill needsDest already does
    // this; this covers free/manual US orders with a designer-set US destination.
    const isUsDest = (order.ship_dest_country ?? '').toUpperCase() === 'US'
    const canPay = order.custom_quote_total != null || (order.material_variant_id != null && order.quantity != null)
    if (canPay && !needsSpec && !needsQty && !needsDest && !isUsDest) void startCheckout()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order])

  // Once the order is paid, ask for the VAT invoice. Returns the Xero
  // online-invoice URL only when the invoice has reconciled to PAID. The webhook
  // creates the invoice a beat AFTER Stripe's success redirect, so the first
  // check often races ahead of it — we therefore poll a few times so the link
  // appears as soon as it's ready, and only treat a genuine creation failure
  // (reason 'invoice_failed') as "unavailable". Everything else is "pending"
  // (available shortly), never the chase-us copy.
  useEffect(() => {
    if (!order || !id || !token) return
    const isPaid = order.status === 'paid' || order.status === 'fulfilled' || justPaid
    if (!isPaid) return
    let cancelled = false
    let attempts = 0
    const MAX_ATTEMPTS = 6 // ~30s of polling at 5s spacing — covers the webhook lag
    setVat({ state: 'loading' })
    const poll = () => {
      void supabase.functions
        .invoke<{ ready?: boolean; url?: string; reason?: string }>('order-vat-invoice', { body: { order_id: id, token } })
        .then(({ data }) => {
          if (cancelled) return
          attempts++
          if (data?.ready && data.url) { setVat({ state: 'ready', url: data.url }); return }
          // Only a genuine creation failure hints at contacting us. The race
          // (invoice not created yet) and reconciliation lag are both "pending".
          if (data?.reason === 'invoice_failed') { setVat({ state: 'unavailable' }); return }
          setVat({ state: 'pending' })
          if (attempts < MAX_ATTEMPTS) {
            window.setTimeout(() => { if (!cancelled) poll() }, 5000)
          }
        })
        .catch(() => {
          // A rejected invoke (offline, CORS, function 500 before a body) would
          // otherwise leave vat stuck on 'loading' forever and render nothing.
          // Degrade to the reassuring "available shortly" copy and keep trying
          // within the same budget.
          if (cancelled) return
          attempts++
          setVat({ state: 'pending' })
          if (attempts < MAX_ATTEMPTS) {
            window.setTimeout(() => { if (!cancelled) poll() }, 5000)
          }
        })
    }
    poll()
    return () => { cancelled = true }
  }, [order, id, token, justPaid])

  // Shared VAT-invoice note for the paid / just-paid screens.
  function renderVatInvoice() {
    if (!vat || vat.state === 'loading') return null
    if (vat.state === 'ready' && vat.url) {
      return (
        <a
          href={vat.url}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-4 inline-block text-sm font-medium text-[var(--c-brand)] underline hover:opacity-80"
        >
          Download your VAT invoice
        </a>
      )
    }
    if (vat.state === 'pending') {
      return (
        <p className="mt-4 text-[13px] text-ink-mute">
          Your VAT invoice will be available here once your payment clears (usually within one working day) — just revisit this link.
        </p>
      )
    }
    // unavailable — genuine creation failure (rare). The team sees this flagged
    // on the Orders page and will follow up; the copy reassures without implying
    // the customer must chase us for a routine invoice.
    return (
      <p className="mt-4 text-[13px] text-ink-mute">
        We&rsquo;ll email your VAT invoice shortly. If it hasn&rsquo;t arrived, just reply to your order email and we&rsquo;ll send it straight over.
      </p>
    )
  }

  // Promoted order-status block (Phase 3): the hero of the return-visit screen.
  // Leads with the current stage + a stage-driven line (which replaces the old
  // static "what happens next" box), then a horizontal progress bar. Renders
  // nothing unless tracking is enabled AND resolves to a real stage, so with the
  // master switch off the screen is unchanged. Granular appends an ETA.
  function renderStatusBlock(p: TrackingProjection | undefined) {
    if (!p || p.level === 'off' || !p.stage) return null
    const stageIdx = stageIndex(p.stage)
    const meta = STAGE_META[p.stage]
    return (
      <div className="mt-5 rounded-xl border border-line bg-canvas p-4 sm:p-5">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-in-stock-soft" aria-hidden="true">
            <span className="h-2.5 w-2.5 rounded-full bg-[var(--c-in-stock)]" />
          </span>
          <div className="min-w-0">
            <p className="text-base font-semibold text-ink">{meta.label}</p>
            <p className="text-[12px] text-ink-mute">Step {stageIdx + 1} of 4</p>
          </div>
        </div>
        <p className="mt-3 text-[13px] leading-relaxed text-ink-soft">{meta.line}</p>
        {p.level === 'granular' && p.tracking_number && (
          <p className="mt-1.5 text-[13px] text-ink-soft">
            Tracking number <span className="font-medium text-ink">{p.tracking_number}</span>
          </p>
        )}
        <div className="relative mt-5">
          <div className="absolute left-[11px] right-[11px] top-[11px] h-0.5 bg-line" />
          <div
            className="absolute left-[11px] top-[11px] h-0.5 bg-[var(--c-in-stock)]"
            style={{ width: `calc((100% - 22px) * ${stageIdx} / 3)` }}
          />
          <ol className="relative flex justify-between">
            {STAGE_STEPS.map((s, i) => {
              const reached = i <= stageIdx
              const isCurrent = i === stageIdx
              return (
                <li key={s.key} className="flex w-16 flex-col items-center gap-1.5 text-center">
                  <span
                    className={`flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full text-[11px] ${
                      reached ? 'bg-[var(--c-in-stock)] text-white' : 'border-[1.5px] border-line bg-surface text-transparent'
                    }`}
                    aria-hidden="true"
                  >
                    ✓
                  </span>
                  <span className={`text-[11px] leading-tight ${isCurrent ? 'font-semibold text-ink' : reached ? 'text-ink-soft' : 'text-ink-mute'}`}>
                    {s.label}
                  </span>
                </li>
              )
            })}
          </ol>
        </div>
      </div>
    )
  }

  // Rich post-payment confirmation, shared by the confirmed and optimistic
  // (?paid=1, pre-webhook) states. Shows the approved-artwork recap, an itemised
  // paid summary (from the breakdown stamped at checkout), the delivery address
  // (confirmed only), what-happens-next, and the self-serve VAT-invoice link
  // (renderVatInvoice). `confirmed` distinguishes the two moments.
  function renderConfirmation(confirmed: boolean, o: OrderPayload) {
    const round2 = (n: number) => Math.round(n * 100) / 100
    const amt = (n: number | null) => (n == null ? 0 : Number(n))
    // Channel Islands orders were charged ex-VAT (see src/lib/ukVatArea.ts) —
    // the caption must say so rather than claim the total includes VAT.
    // ship_dest_country is the rated destination create-checkout-session
    // normalised + persisted; the Stripe postcode is only a belt-and-braces
    // fallback for orders that never rated (designer hint left as GB).
    const vatFreeOrder =
      o.currency === 'GBP' &&
      isGbpOrderVatFree(
        o.vat_treatment ?? null,
        normaliseShipDestination(o.ship_dest_country ?? '', o.ship_to_address?.postal_code ?? ''),
      )
    const cards = o.custom_quote_total != null ? Number(o.custom_quote_total) : amt(o.amount_cards)
    const tooling = amt(o.amount_tooling)
    const personalisation = amt(o.amount_personalisation)
    const shipping = amt(o.amount_shipping)
    const usTariff = amt(o.amount_us_tariff)
    const cardDiscount = amt(o.amount_card_discount)
    const total = round2(cards - cardDiscount + tooling + personalisation + shipping + usTariff)
    const haveSummary = total > 0
    const addr = o.ship_to_address
    const haveAddress = confirmed && !!addr && !!(addr.line1 || addr.postal_code)
    const addressLine = addr
      ? [addr.line1, addr.line2, addr.city, addr.region, addr.postal_code, addr.country].filter(Boolean).join(', ')
      : ''
    // The warm "thank you" intro is for the immediate post-payment view (the
    // ?paid=1 redirect, or the pre-webhook optimistic state). A later return
    // visit gets a quieter "Your order" header led by the live status block.
    const isImmediate = !confirmed || justPaid
    return (
      <div className="min-h-screen bg-canvas">
        <CustomerHeader innerClassName="max-w-4xl" />
        <div className="mx-auto max-w-4xl px-gutter py-8">
          {/* Header — full width across the top. */}
          {isImmediate ? (
            <>
              <Pill colour="in-stock">{confirmed ? 'Paid' : 'Payment received'}</Pill>
              <h1 className="mt-3 text-xl font-semibold text-ink">
                {confirmed ? 'Order confirmed' : 'Thank you — payment received'}
              </h1>
            </>
          ) : (
            <>
              <Pill colour="in-stock">Paid</Pill>
              <h1 className="mt-3 text-xl font-semibold text-ink">Your order</h1>
            </>
          )}
          {company && <p className="mt-1 text-sm text-ink-soft">{company}</p>}
          {o.payment_reference && (
            <p className="mt-0.5 text-sm text-ink-soft">Reference {o.payment_reference}</p>
          )}

          {/* Order status — full-width hero on a return visit. */}
          {!isImmediate && renderStatusBlock(o.tracking_projection)}

          {/* Two columns on desktop (lg+); stacks to one column on mobile. */}
          <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
            {/* LEFT — order summary: approved artwork + spec + what was paid. */}
            <PanelShell className="self-start">
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-[11px] font-medium uppercase tracking-wide text-ink-mute">Order summary</p>
                {spec?.approvedAt && (
                  <p className="text-[12px] text-ink-mute">Approved {formatApprovedDate(spec.approvedAt)}</p>
                )}
              </div>
              {recapTiles.length > 0 && (
                <RecapArtwork tiles={recapTiles} label={spec?.material ?? null} className="mt-3" />
              )}
              {spec && (
                <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                  <dt className="text-ink-mute">Material</dt>
                  <dd className="text-ink">{spec.material}</dd>
                  {spec.variant && (<><dt className="text-ink-mute">{variantLabel(spec.variant)}</dt><dd className="text-ink">{spec.variant}</dd></>)}
                  {spec.finish && (<><dt className="text-ink-mute">Finish</dt><dd className="text-ink">{spec.finish}</dd></>)}
                  {spec.inks.length > 0 && (<><dt className="text-ink-mute">Ink</dt><dd className="text-ink">{spec.inks.join(', ')}</dd></>)}
                </dl>
              )}
              {haveSummary && (
                <div className="mt-4 space-y-2 border-t border-line pt-4 text-sm">
                  {o.quantity != null && (
                    <Row
                      label="Quantity"
                      value={o.names_count > 1 ? `${o.quantity.toLocaleString()} cards in total` : o.quantity.toLocaleString()}
                    />
                  )}
                  <Row label="Cards" value={formatPrice(cards, o.currency)} />
                  {cardDiscount > 0 && <Row label="Discount" value={formatPrice(-cardDiscount, o.currency)} />}
                  {tooling > 0 && (
                    <Row
                      label={o.names_count > 1 ? `Extra tooling (${o.names_count} names)` : 'Extra tooling'}
                      value={formatPrice(tooling, o.currency)}
                    />
                  )}
                  {personalisation > 0 && <Row label="Personalisation" value={formatPrice(personalisation, o.currency)} />}
                  <Row
                    label={SHIPPING_LABEL[o.shipping_treatment]}
                    value={shipping > 0 ? formatPrice(shipping, o.currency) : 'Free'}
                  />
                  {usTariff > 0 && <Row label="US tariff & customs handling" value={formatPrice(usTariff, o.currency)} />}
                  <div className="flex items-center justify-between gap-4 border-t border-line pt-2.5 text-base">
                    <span className="font-semibold text-ink">{confirmed ? 'Total paid' : 'Total'}</span>
                    <span className="font-semibold text-ink">{formatPrice(total, o.currency)}</span>
                  </div>
                  {o.currency === 'GBP' && (
                    <p className="text-[12px] text-ink-mute">
                      {vatFreeOrder ? 'VAT-free — delivered outside the UK VAT area (zero-rated export).' : 'Includes VAT.'}
                    </p>
                  )}
                </div>
              )}
            </PanelShell>

            {/* RIGHT — next steps (immediate), delivery, invoice, help. */}
            <PanelShell className="self-start">
              {/* What happens next — only on the immediate post-payment view. */}
              {isImmediate && (
                <div className="text-sm text-ink-soft">
                  <p className="font-medium text-ink">What happens next</p>
                  {confirmed ? (
                    <ul className="mt-2 list-disc space-y-1.5 pl-5">
                      <li>We&rsquo;ve got your order and we&rsquo;re getting started.</li>
                      <li>We&rsquo;ll email you dispatch details as soon as your cards are on their way.</li>
                    </ul>
                  ) : (
                    <ul className="mt-2 list-disc space-y-1.5 pl-5">
                      <li>We&rsquo;re just confirming your payment — this only takes a moment.</li>
                      <li>A receipt is on its way to your email.</li>
                      <li>You can safely close this page.</li>
                    </ul>
                  )}
                </div>
              )}

              {/* Delivery address — once the webhook has stored what Stripe collected. */}
              {haveAddress && (
                <div className={`text-sm ${isImmediate ? 'mt-5 border-t border-line pt-5' : ''}`}>
                  <p className="text-[11px] font-medium uppercase tracking-wide text-ink-mute">Shipping to</p>
                  <p className="mt-1 text-ink">
                    {o.ship_to_name && (<>{o.ship_to_name}<br /></>)}
                    {addressLine}
                  </p>
                </div>
              )}

              {/* Self-serve VAT invoice (self-spaces with its own top margin). */}
              {renderVatInvoice()}

              <p className="mt-5 text-[12px] text-ink-mute">
                Questions about your order? Just reply to your order email and we&rsquo;ll help.
              </p>
            </PanelShell>
          </div>
        </div>
      </div>
    )
  }

  if (loading) return <Screen><LoadingProofAnimation /></Screen>

  if (notFound || !order) {
    return (
      <Screen>
        <PanelShell className="max-w-md text-center">
          <h1 className="text-lg font-semibold text-ink">Order not found</h1>
          <p className="mt-2 text-sm text-ink-soft">
            This order link is invalid or has been removed. If you were expecting to pay, please reply to the email you received and we&rsquo;ll sort it out.
          </p>
        </PanelShell>
      </Screen>
    )
  }

  const isExpired =
    order.status === 'expired' ||
    (order.status === 'sent' && order.expires_at != null && new Date(order.expires_at).getTime() < Date.now())

  // Recap thumbnails, finish-aware, with cross-fade layers while the finish
  // is still switchable — shared derivation with the group pay page (see
  // src/components/ArtworkFade.tsx for the full story).
  const activeFinishCode =
    (order.finish_open === true ? specFinishes.find((f) => f.id === chosenOptionId)?.code ?? null : null) ??
    lockedFinishCode
  const recapTiles = buildRecapTiles(
    versionImages,
    activeFinishCode,
    specFinishes.map((f) => f.code),
    order.finish_open === true && specFinishes.length > 1,
  )

  if (order.status === 'paid' || order.status === 'fulfilled') {
    return renderConfirmation(true, order)
  }

  // Order was cancelled (abort, or a reopen-for-changes on an unpaid link).
  // Calm and reorder-friendly, not an error tone.
  if (order.status === 'cancelled') {
    return (
      <Screen>
        <PanelShell className="max-w-md text-center">
          <h1 className="text-lg font-semibold text-ink">This order has been cancelled</h1>
          <p className="mt-2 text-sm text-ink-soft">
            This order is no longer active. If you&rsquo;d like to reorder, just reply to the email you received and we&rsquo;ll set it up for you.
          </p>
        </PanelShell>
      </Screen>
    )
  }

  // Paid/placed order held while the proof is being redesigned (revision).
  // The payment stands; a fresh proof follows once it's ready.
  if (order.status === 'revision') {
    return (
      <Screen>
        <PanelShell className="max-w-md text-center">
          <h1 className="text-lg font-semibold text-ink">We&rsquo;re updating your cards</h1>
          <p className="mt-2 text-sm text-ink-soft">
            We&rsquo;re making changes to your artwork. A new proof will follow once it&rsquo;s ready — there&rsquo;s nothing you need to do right now.
          </p>
        </PanelShell>
      </Screen>
    )
  }

  // Member of a combined-payment group (bundle orders Slice 2): this order is
  // paid through the group's own link, so the standalone form stays closed
  // (the server refuses its checkout too). Blocked whenever the group is
  // anything but 'cancelled' (the #438 review fix) — a paid group normally
  // flips this order to paid, but if that flip ever misses, the member's own
  // link must still never take a second payment. A cancelled group releases
  // its members, so that's the only state that falls through.
  if (order.status === 'sent' && order.order_group_id && order.order_group_status != null && order.order_group_status !== 'cancelled') {
    return (
      <Screen>
        <PanelShell className="max-w-md text-center">
          <h1 className="text-lg font-semibold text-ink">This order is part of a combined payment</h1>
          <p className="mt-2 text-sm text-ink-soft">
            We&rsquo;ve sent you a single payment link covering this and other items together. Please use that link to pay — if you can&rsquo;t find it, just reply to the email you received and we&rsquo;ll re-send it.
          </p>
        </PanelShell>
      </Screen>
    )
  }

  if (isExpired) {
    return (
      <Screen>
        <PanelShell className="max-w-md text-center">
          <h1 className="text-lg font-semibold text-ink">This order link has expired</h1>
          <p className="mt-2 text-sm text-ink-soft">
            Shipping and pricing move over time, so this link is no longer payable. Please reply to the email you received and we&rsquo;ll send you a fresh one.
          </p>
        </PanelShell>
      </Screen>
    )
  }

  // Optimistic thank-you straight after Stripe's redirect, before the
  // webhook flips status to 'paid' in our DB.
  if (justPaid) {
    return renderConfirmation(false, order)
  }

  // Checkout is available whenever the order is priceable server-side: a
  // custom quote, or a grid order with a locked quantity + a chosen variant,
  // or an open-quantity grid order once a quantity is entered. Every shipping
  // treatment is now computed at checkout (free / manual client-side; the
  // full_cost / goodwill carriage is rated server-side and shown on Stripe),
  // so shipping no longer gates checkout.
  const shippingResolvable = true
  // Shipping figure known client-side only for free (0) and manual (the set
  // figure). full_cost / goodwill are rated at checkout against the
  // destination + quantity, so their figure appears on Stripe's page.
  const shippingComputedAtCheckout =
    order.shipping_treatment === 'full_cost' || order.shipping_treatment === 'goodwill'
  const shippingAmount =
    order.shipping_treatment === 'manual' ? Number(order.shipping_charged ?? 0) : 0
  const round2 = (n: number) => Math.round(n * 100) / 100
  // US tariff & customs handling. Destination is the customer's pay-page
  // selection (full_cost/goodwill) or the order's stored hint (free/manual) —
  // mirrors the server's resolution, including the GB + Crown-dependency
  // postcode normalisation (a Jersey customer often picks "United Kingdom").
  // Fee is from public_settings for the order currency; a 0 fee disables it.
  // Included by default; drops to 0 on opt-out.
  const effectiveDestCountry = normaliseShipDestination(
    shippingComputedAtCheckout ? destCountry : order.ship_dest_country ?? '',
    shippingComputedAtCheckout ? destPostcode : '',
  )
  // Offer the optional VAT / EORI field only for EU-bound orders (migration
  // 000341) — the classification (isEuVatCountry) is the twin of the server's
  // "0% EU" set. Falls back to the EUR currency when no destination is known yet.
  const isEuBound = isEuVatCountry(effectiveDestCountry) || (!effectiveDestCountry && order.currency === 'EUR')
  const tariffFee = tariff ? tariff.fees[order.currency] ?? 0 : 0
  const tariffApplies = effectiveDestCountry === 'US' && tariffFee > 0
  const tariffAmount = tariffApplies && !tariffOptedOut ? tariffFee : 0
  // VAT relief (Channel Islands): GBP prices are VAT-inclusive and Jersey /
  // Guernsey are outside the UK VAT area, so a GBP order delivering there is
  // charged ex-VAT. Mirror the server EXACTLY: strip the VAT element from
  // every VAT-inclusive INPUT (tier totals, tooling, personalisation rates,
  // finish surcharges) before the interpolation maths — never from a computed
  // result, because the interpolation's round-up isn't scale-invariant. The
  // custom-quote figure and a fixed discount stay at face value, matching
  // create-checkout-session. See src/lib/ukVatArea.ts.
  const vatRelief = order.currency === 'GBP' && isGbpOrderVatFree(order.vat_treatment ?? null, effectiveDestCountry)
  const exv = (n: number) => (vatRelief ? exVat(n) : n)
  const exvTiers = (ts: { quantity: number; total_price: number }[]) =>
    vatRelief ? ts.map((t) => ({ ...t, total_price: exVat(t.total_price) })) : ts
  const exvSurTiers = (ts: { quantity: number; surcharge: number }[]) =>
    vatRelief ? ts.map((t) => ({ ...t, surcharge: exVat(t.surcharge) })) : ts
  // The tiny caption under money totals: what the shown figure includes.
  const vatCaption =
    order.currency === 'GBP'
      ? vatRelief
        ? 'VAT-free — Channel Islands orders are outside UK VAT.'
        : 'Includes VAT.'
      : null
  // Open-spec (000298): the customer confirms thickness / finish here before
  // the payment form unlocks. Resolved = every open field has a pick.
  const thicknessOpen = order.thickness_open === true && order.custom_quote_total == null
  const finishOpen = order.finish_open === true && order.custom_quote_total == null
  const specResolved =
    (!thicknessOpen || chosenVariantId != null) && (!finishOpen || chosenOptionId != null)
  const chosenVariantName = thicknessOpen
    ? specVariants.find((v) => v.id === chosenVariantId)?.display_name ?? null
    : null
  const chosenFinishName = finishOpen
    ? specFinishes.find((f) => f.id === chosenOptionId)?.display_name ?? null
    : null

  // "Same as last time" guidance (000364): badge the option they had before,
  // stand the catalogue "Most popular" down while it shows, and nudge gently
  // if they pick differently. All rendering is inside the open-chooser
  // blocks, so locked orders and the (vast) majority with no previous spec
  // are untouched.
  const previousSpec = parsePreviousSpec(order.previous_spec)
  const prevThickness = chooserGuidance('thickness', previousSpec, specVariants.map((v) => v.id), chosenVariantId)
  const prevFinish = chooserGuidance('finish', previousSpec, specFinishes.map((f) => f.id), chosenOptionId)

  // Thickness cards in the education copy's order when a set exists (the
  // notes array is the admin-editable display authority — metal reads
  // thinnest-first, Full Colour Plastic thickest-first), falling back to
  // catalogue sort_order for materials without copy. Matching is by micron
  // number, same as thicknessNoteFor; unmatched variants keep their
  // relative catalogue order at the end (Array.sort is stable).
  const orderedSpecVariants =
    thicknessNotes.length === 0
      ? specVariants
      : [...specVariants].sort((a, b) => {
          const pos = (v: SpecVariantChoice) => {
            const i = thicknessNotes.findIndex((n) => parseInt(n.label, 10) === parseInt(v.display_name, 10))
            return i === -1 ? Number.MAX_SAFE_INTEGER : i
          }
          return pos(a) - pos(b)
        })

  // Open-quantity grid order: the designer left quantity for the customer.
  // Quantity LEADS the form (before thickness/finish) so every option card
  // shows the true price for the customer's actual quantity — so for an
  // open-thickness order the input renders before any variant is chosen,
  // with pricing showing "from …" until tiers land on the thickness pick.
  const openQuantity =
    order.custom_quote_total == null &&
    (order.quantity_open === true || order.quantity == null) &&
    (order.material_variant_id != null || (thicknessOpen && specVariants.length > 0))
  const isOpenGrid = openQuantity && tiers.length > 0
  const isSplitOpen = openQuantity && personNames.length > 1
  const isSingleOpen = openQuantity && personNames.length <= 1

  // Base card total for a quantity: exact listed tier, or interpolated
  // between the two bracketing tiers (combined-total basis). Mirrors the
  // server's cardTotalForQuantity so the shown figure equals the charge;
  // null below the lowest / above the highest tier.
  function cardTotalForQty(qty: number): number | null {
    return totalFromTiers(exvTiers(tiers), qty, flatAboveTop)
  }

  // Finish (material-option) surcharge for a quantity: exact tier or
  // interpolated, mirroring the server's cardTotalForQuantity over the
  // surcharge schedule. 0 when there's no non-base finish. Out of range → 0
  // (the server treats an unpriceable surcharge as 0 too).
  function finishSurchargeForQty(qty: number): number {
    return surchargeFromTiers(exvSurTiers(finishTiers), qty, flatAboveTop)
  }

  // Designer discount for a given goods base, mirroring the server's
  // resolveCardDiscount EXACTLY so the displayed figure equals the charge. The
  // base is the goods subtotal (cards + finish + tooling + personalisation; a
  // custom quote's agreed figure), matching create-checkout-session.
  function cardDiscountForBase(base: number): number {
    const t = order?.card_discount_type
    const v = Number(order?.card_discount_value)
    if (t !== 'percent' && t !== 'fixed') return 0
    if (!Number.isFinite(v) || v <= 0) return 0
    const b = Number.isFinite(base) && base > 0 ? base : 0
    if (b <= 0) return 0
    const raw = t === 'percent' ? b * (v / 100) : v
    const capped = Math.min(Math.max(raw, 0), b)
    return Math.round(capped * 100) / 100
  }

  // Full pay total for a combined quantity: cards + tooling + personalisation
  // + finish surcharge − designer discount + shipping. Shared by the
  // single-selector and per-person paths.
  function payTotalForQty(qty: number): number | null {
    if (!order || qty <= 0) return null
    const cards = cardTotalForQty(qty)
    if (cards == null) return null
    const splitName = perExtraName && order.names_count > 1 ? (order.names_count - 1) * exv(perExtraName) : 0
    const pers = personalisation ? Math.max(exv(personalisation.minCharge), qty * exv(personalisation.perCardRate)) : 0
    const finish = finishSurchargeForQty(qty)
    // Designer discount applies to the goods subtotal (cards + tooling +
    // personalisation + finish), netted off the total exactly as
    // create-checkout-session does — so the button and Total match the charge.
    const discount = cardDiscountForBase(round2(cards + splitName + pers + finish))
    return round2(round2(cards + splitName + pers + finish) - discount + shippingAmount + tariffAmount)
  }

  // Quantity bounds: the chosen variant's tiers when known; before a
  // thickness is picked, the union across the offerable variants (the metal
  // family shares one quantity grid, so this is exact in practice).
  const boundsTiers = tiers.length > 0 ? tiers : specVariants.flatMap((v) => v.tiers)
  const singleMin = boundsTiers.length > 0 ? Math.min(...boundsTiers.map((t) => t.quantity)) : null
  const singleMax = boundsTiers.length > 0
    ? (flatAboveTop ? MAX_ONLINE_FLAT_QUANTITY : Math.max(...boundsTiers.map((t) => t.quantity)))
    : null

  // Per-person entries → combined sum. Complete only when every person has a
  // quantity of at least one.
  const personParsed = personNames.map((n) => {
    const v = parseInt(personQty[n] ?? '', 10)
    return Number.isFinite(v) && v > 0 ? v : 0
  })
  const splitSum = personParsed.reduce((a, b) => a + b, 0)
  const splitComplete = isSplitOpen && personParsed.every((q) => q >= 1)
  // Metal extends flat above the top tier only up to the online sanity cap; a
  // combined split above it can't be self-served and routes to "reply to us".
  const splitOverCap = flatAboveTop && splitSum > MAX_ONLINE_FLAT_QUANTITY
  const splitTotal = splitComplete && !splitOverCap ? payTotalForQty(splitSum) : null
  // When every person has a quantity but the combined total can't be priced,
  // explain why (below the minimum / above the online maximum) rather than
  // just disabling the button silently.
  const splitRangeHint =
    isSplitOpen && tiers.length > 0 && splitComplete && splitTotal == null
      ? (() => {
          if (singleMin != null && splitSum < singleMin) return `Our minimum order is ${singleMin.toLocaleString()} cards in total.`
          if (singleMax != null && splitSum > singleMax)
            return `For more than ${singleMax.toLocaleString()} cards, please reply to the email you received and we’ll sort it.`
          return 'We couldn’t price this quantity — please reply to the email you received.'
        })()
      : null

  // Single-person open order: the customer types any quantity within the
  // listed range and the price interpolates (matching the split path + the
  // Quote compiler). min/max bound the type-in; an out-of-range entry shows a
  // hint and blocks checkout rather than silently failing server-side. For
  // metal the max is the online sanity cap, since it prices flat above the
  // top listed tier up to there.
  const singleCardTotal =
    isSingleOpen && chosenQuantity != null && (singleMax == null || chosenQuantity <= singleMax)
      ? cardTotalForQty(chosenQuantity)
      : null
  const singleRangeHint =
    isSingleOpen && tiers.length > 0 && chosenQuantity != null && singleCardTotal == null
      ? singleMin != null && chosenQuantity < singleMin
        ? `Our minimum order is ${singleMin.toLocaleString()} cards.`
        : singleMax != null && chosenQuantity > singleMax
          ? `For more than ${singleMax.toLocaleString()} cards, please reply to the email you received and we’ll sort it.`
          : 'We couldn’t price this quantity — please reply to the email you received.'
      : null

  // "Quantity step incomplete" — price-validity only counts once a thickness
  // has landed tiers (before that, an entered quantity is provisionally fine;
  // the server re-validates at checkout regardless).
  const awaitingQuantity = isSplitOpen
    ? !splitComplete || splitOverCap || (tiers.length > 0 && splitTotal == null)
    : isSingleOpen
      ? chosenQuantity == null || (tiers.length > 0 && singleCardTotal == null)
      : false
  const canCheckout =
    shippingResolvable &&
    (order.custom_quote_total != null ||
      (order.material_variant_id != null && order.quantity != null) ||
      isOpenGrid ||
      // Open-spec order still awaiting its choices: the chooser is the step,
      // so the payable screen renders. No offerable variants (e.g. the proof
      // moved to a different material after the order was created) falls
      // through to the "reply to us" screen instead of a dead chooser.
      (thicknessOpen && specVariants.length > 0) ||
      (finishOpen && specFinishes.length > 0))
  // full_cost / goodwill orders need the customer's delivery country + postcode
  // before we can rate the carriage at checkout. The two halves are tracked
  // separately so the button can name the one that's actually outstanding:
  // "Enter delivery country & postcode" sitting next to an already-filled
  // country reads as the button being broken rather than as an instruction.
  const destCountryMissing = shippingComputedAtCheckout && !destCountry
  const destPostcodeMissing = shippingComputedAtCheckout && destPostcode.trim().length === 0
  const destinationComplete = !destCountryMissing && !destPostcodeMissing
  const destinationPrompt =
    destCountryMissing && destPostcodeMissing
      ? 'Enter delivery country & postcode'
      : destCountryMissing
        ? 'Select a delivery country'
        : destPostcodeMissing
          ? 'Enter a delivery postcode'
          : null
  const destinationHint =
    destCountryMissing && destPostcodeMissing
      ? 'Enter where we’re shipping to so we can calculate shipping.'
      : destCountryMissing
        ? 'Choose the delivery country so we can calculate shipping.'
        : destPostcodeMissing
          ? 'Add the delivery postcode so we can calculate shipping.'
          : null
  // Once the quantity (and any open spec) is settled, the delivery fields are
  // the only thing left — so mark the empty one instead of leaving the greyed
  // button as the only clue. On a phone that button sits below the fold, and
  // the numeric keypad covers this whole panel while the quantity is being
  // typed, which is how a customer came to report "I put in the amount of
  // cards and then there's nothing after that". Held back until the quantity
  // is done so we're pointing at the next step, not nagging on arrival.
  // border-out matches the version forms' required-field convention.
  const flagDest = specResolved && !awaitingQuantity
  const countryNeedsAttention = flagDest && destCountryMissing
  const postcodeNeedsAttention = flagDest && destPostcodeMissing
  // Total is known client-side for a custom quote, a chosen single quantity,
  // or a completed per-person split; a designer-locked grid quantity is shown
  // on Stripe's hosted page (it may be an interpolated in-between). When
  // shipping is rated at checkout (full_cost / goodwill) the final figure
  // isn't known here, so we defer the whole total to Stripe rather than show
  // a goods-only figure the customer would mistake for the all-in price.
  const payTotal = shippingComputedAtCheckout
    ? null
    : order.custom_quote_total != null
      ? round2(order.custom_quote_total - cardDiscountForBase(order.custom_quote_total) + shippingAmount + tariffAmount)
      : isSplitOpen
        ? splitTotal
        : isSingleOpen
          ? payTotalForQty(chosenQuantity ?? 0)
          : null

  // The quantity we'd charge for, for display. Locked → order.quantity;
  // open → the customer's chosen / per-person total once entered.
  // The quantity everything prices/displays at: for an open order the LIVE
  // inputs win (they're pre-filled from any persisted pick, so a revisit
  // starts from the earlier choice but re-typing re-prices instantly);
  // designer-locked orders use the stored figure.
  const displayQty = openQuantity
    ? (isSplitOpen ? (splitComplete ? splitSum : null) : chosenQuantity)
    : order.quantity
  // Pre-checkout preview components, mirroring the post-checkout breakdown so
  // the customer sees Cards / Discount before paying — not an undiscounted
  // lump. The Cards row shows cards + finish; the discount is computed on the
  // full goods subtotal (cards + finish + tooling + personalisation, or the
  // custom-quote figure), matching create-checkout-session.
  const previewCardsBase =
    order.custom_quote_total != null
      ? order.custom_quote_total
      : displayQty != null && cardTotalForQty(displayQty) != null
        ? round2((cardTotalForQty(displayQty) as number) + finishSurchargeForQty(displayQty))
        : null
  const previewTooling = perExtraName && order.names_count > 1 ? round2((order.names_count - 1) * exv(perExtraName)) : 0
  const previewPersonalisation =
    order.custom_quote_total == null && displayQty != null && personalisation
      ? round2(Math.max(exv(personalisation.minCharge), displayQty * exv(personalisation.perCardRate)))
      : 0
  const previewGoods =
    previewCardsBase != null
      ? order.custom_quote_total != null
        ? previewCardsBase
        : round2(previewCardsBase + previewTooling + previewPersonalisation)
      : null
  const previewDiscount = previewGoods != null ? cardDiscountForBase(previewGoods) : 0

  // Quantity inputs (open-quantity orders). One JSX block, two homes: inside
  // the "Confirm your card" section ABOVE the thickness/finish cards for
  // open-spec orders (quantity first, so every option shows its true price
  // for the customer's quantity — Rob, 2026-07-03), else standalone in the
  // inputs panel exactly as before.
  const quantityInputs = isSplitOpen ? (
    <div className="rounded-xl border border-line bg-canvas p-4">
      <p className="font-medium text-ink">How many cards for each person?</p>
      <div className="mt-3 space-y-2.5">
        {personNames.map((name) => (
          <div key={name} className="flex items-center justify-between gap-4">
            <label htmlFor={`q-${name}`} className="truncate text-ink">{name}</label>
            <input id={`q-${name}`} type="number" min={1} step={1} inputMode="numeric"
              value={personQty[name] ?? ''}
              onChange={(e) => setPersonQty((prev) => ({ ...prev, [name]: e.target.value }))}
              placeholder="0"
              className="h-11 w-28 rounded-lg border border-line bg-surface px-3 text-right text-base font-semibold text-ink focus:border-[var(--c-brand)] focus:outline-2 focus:outline-offset-1 focus:outline-[var(--c-brand)]" />
          </div>
        ))}
      </div>
      <div className="mt-2.5 flex items-center justify-between gap-4 border-t border-line-soft pt-2.5">
        <span className="text-ink-soft">Total</span>
        <span className="text-base font-semibold text-ink">{splitSum > 0 ? `${splitSum.toLocaleString()} cards` : '—'}</span>
      </div>
      {splitRangeHint && <p className="mt-1.5 text-[13px] text-low">{splitRangeHint}</p>}
      {quantityHint(previousSpec, { split: true }) && (
        <p className="mt-1.5 text-[13px] text-ink-soft">{quantityHint(previousSpec, { split: true })}</p>
      )}
    </div>
  ) : isSingleOpen ? (
    <div className="rounded-xl border border-line bg-canvas p-4">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <label htmlFor="order-quantity" className="block font-medium text-ink">How many cards?</label>
          {singleMin != null && singleMax != null && (
            <p className="mt-0.5 text-[12px] text-ink-mute">Any quantity from {singleMin.toLocaleString()} to {singleMax.toLocaleString()}.</p>
          )}
        </div>
        <input id="order-quantity" type="number" min={singleMin ?? 1} max={singleMax ?? undefined} step={1} inputMode="numeric"
          value={chosenQuantity ?? ''}
          onChange={(e) => { const n = parseInt(e.target.value, 10); setChosenQuantity(Number.isFinite(n) && n > 0 ? n : null) }}
          placeholder={singleMin != null ? `${singleMin.toLocaleString()}+` : 'e.g. 250'}
          className="h-12 w-32 shrink-0 rounded-lg border border-line bg-surface px-3 text-right text-base font-semibold text-ink focus:border-[var(--c-brand)] focus:outline-2 focus:outline-offset-1 focus:outline-[var(--c-brand)]" />
      </div>
      {singleRangeHint && <p className="mt-1.5 text-[13px] text-low">{singleRangeHint}</p>}
      {quantityHint(previousSpec) && (
        <p className="mt-1.5 text-[13px] text-ink-soft">{quantityHint(previousSpec)}</p>
      )}
    </div>
  ) : null

  // ── Single-screen checkout ────────────────────────────────────────
  // One page: order recap + cost summary on the left; on the right either the
  // inputs we still need (quantity / shipping destination) or — once those are
  // set and the PaymentIntent is created — the Stripe payment form. No-input
  // orders auto-advance (see the effect above), so the customer lands straight
  // on the full checkout with the form already showing.
  if (canCheckout) {
    return (
      <div className="min-h-screen bg-canvas">
        <CustomerHeader
          innerClassName="max-w-5xl"
          right={
            <span className="inline-flex items-center gap-1.5 text-[12px]" style={{ color: 'rgba(255,255,255,0.72)' }}>
              <Lock size={13} aria-hidden="true" /> Secure payment
            </span>
          }
        />
        <div className="mx-auto max-w-5xl px-gutter py-8">
          <p className="eyebrow">Complete your order</p>
          <h1 className="mt-1 text-xl font-semibold text-ink">{company ? company : 'Your order'}</h1>
          <p className="mt-1 text-sm text-ink-soft">Reference {order.payment_reference}</p>

          <div ref={mountWrapRef} className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
            {/* LEFT — recap + cost summary. Second on a phone (order-2): the
                summary with its artwork is a full screen on its own, and
                stacking it first pushed the quantity box to the fold and the
                delivery fields + button off it entirely — so the form the
                customer has to fill came after a screenful of confirmation
                they'd already seen on the proof. Desktop is unchanged. */}
            <PanelShell className="order-2 self-start lg:order-1">
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-[11px] font-medium uppercase tracking-wide text-ink-mute">Order summary</p>
                {spec?.approvedAt && (
                  <p className="text-[12px] text-ink-mute">Approved {formatApprovedDate(spec.approvedAt)}</p>
                )}
              </div>
              {recapTiles.length > 0 && (
                <RecapArtwork tiles={recapTiles} label={spec?.material ?? null} className="mt-3" />
              )}
              {spec && (
                <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                  <dt className="text-ink-mute">Material</dt>
                  <dd className="text-ink">{spec.material}</dd>
                  {(chosenVariantName ?? spec.variant) && (<><dt className="text-ink-mute">{variantLabel((chosenVariantName ?? spec.variant) as string)}</dt><dd className="text-ink">{chosenVariantName ?? spec.variant}</dd></>)}
                  {(chosenFinishName ?? spec.finish) && (<><dt className="text-ink-mute">Finish</dt><dd className="text-ink">{chosenFinishName ?? spec.finish}</dd></>)}
                  {spec.inks.length > 0 && (<><dt className="text-ink-mute">Ink</dt><dd className="text-ink">{spec.inks.join(', ')}</dd></>)}
                </dl>
              )}

              <div className="mt-4 space-y-1.5 border-t border-line pt-4 text-sm">
                {displayQty != null && (
                  <Row label="Quantity" value={order.names_count > 1 ? `${displayQty.toLocaleString()} cards in total` : displayQty.toLocaleString()} />
                )}
                {order.names_count > 1 && <Row label="People" value={String(order.names_count)} />}
                {order.has_personalisation && <Row label="Personalisation" value="Included" />}
                {checkout ? (
                  <>
                    <Row label={order.order_kind === 'prototype' ? 'Prototype sample' : order.custom_quote_total != null ? 'Agreed price' : 'Cards'} value={formatPrice(checkout.breakdown.cards, checkout.currency)} />
                    {checkout.breakdown.card_discount > 0 && <Row label="Discount" value={formatPrice(-checkout.breakdown.card_discount, checkout.currency)} />}
                    {checkout.breakdown.tooling > 0 && <Row label="Tooling" value={formatPrice(checkout.breakdown.tooling, checkout.currency)} />}
                    {checkout.breakdown.personalisation > 0 && <Row label="Personalisation" value={formatPrice(checkout.breakdown.personalisation, checkout.currency)} />}
                    <Row label="Shipping" value={checkout.breakdown.shipping > 0 ? formatPrice(checkout.breakdown.shipping, checkout.currency) : 'Free'} />
                    {checkout.breakdown.us_tariff > 0 && <Row label="US tariff & customs handling" value={formatPrice(checkout.breakdown.us_tariff, checkout.currency)} />}
                  </>
                ) : (
                  <>
                    {previewCardsBase != null && (
                      <Row label={order.order_kind === 'prototype' ? 'Prototype sample' : order.custom_quote_total != null ? 'Agreed price' : 'Cards'} value={formatPrice(previewCardsBase, order.currency)} />
                    )}
                    {previewDiscount > 0 && <Row label="Discount" value={formatPrice(-previewDiscount, order.currency)} />}
                    {previewTooling > 0 && <Row label="Tooling" value={formatPrice(previewTooling, order.currency)} />}
                    {previewPersonalisation > 0 && <Row label="Personalisation" value={formatPrice(previewPersonalisation, order.currency)} />}
                    <Row label={SHIPPING_LABEL[order.shipping_treatment]} value={
                      order.shipping_treatment === 'free' ? 'Free'
                        : order.shipping_charged != null ? formatPrice(order.shipping_charged, order.currency)
                          : 'Calculated at payment'
                    } />
                    {tariffApplies && <Row label="US tariff & customs handling" value={tariffOptedOut ? 'Removed' : formatPrice(tariffFee, order.currency)} />}
                  </>
                )}
              </div>

              {(checkout || payTotal != null) && (
                <>
                  <div className="mt-3 flex items-center justify-between border-t border-line pt-3 text-base">
                    <span className="font-semibold text-ink">Total</span>
                    <span className="font-semibold text-ink">{formatPrice(checkout ? checkout.amount : (payTotal as number), order.currency)}</span>
                  </div>
                  {vatCaption && <p className="mt-1 text-[12px] text-ink-mute">{vatCaption}</p>}
                </>
              )}
            </PanelShell>

            {/* RIGHT — inputs (until the intent exists), then the payment form.
                First on a phone (order-1) so the page opens on what still
                needs doing. */}
            <PanelShell className="relative order-1 min-h-[300px] lg:order-2">
              {!checkout ? (
                <div className="space-y-4 text-sm">
                  {/* Open-spec chooser (000298): confirm thickness / finish
                      before quantity, destination and payment. Explicit tap
                      required — no pre-selection — with a "Most popular"
                      badge doing the guidance instead. */}
                  {(thicknessOpen || finishOpen) && (
                    <div className="space-y-4">
                      <p className="font-medium text-ink">Confirm your card</p>

                      {/* Quantity FIRST, so the thickness prices and finish
                          premiums below are for the customer's real quantity
                          rather than "from" figures. */}
                      {quantityInputs}

                      {thicknessOpen && specVariants.length > 0 && (
                        <div className="space-y-2">
                          <p className="text-[13px] text-ink-soft">
                            Choose your thickness — the price updates as you pick.
                          </p>
                          {orderedSpecVariants.map((v) => {
                            const note = thicknessNoteFor(thicknessNotes, v.display_name)
                            // Fold a LOCKED non-base finish's surcharge (e.g.
                            // Brushed) into every thickness card so the shown
                            // price matches the total and the charge. When the
                            // finish is itself open, its premium is picked on a
                            // separate finish card, so don't add it here.
                            const priceBasisQty = displayQty ?? v.tiers[0]?.quantity ?? null
                            const lockedFinishAdd =
                              !finishOpen && finishTiers.length > 0 && priceBasisQty != null
                                ? surchargeFromTiers(exvSurTiers(finishTiers), priceBasisQty, flatAboveTop)
                                : 0
                            const base =
                              displayQty != null
                                ? totalFromTiers(exvTiers(v.tiers), displayQty, flatAboveTop)
                                : v.tiers[0] != null ? exv(v.tiers[0].total_price) : null
                            const price = base != null ? round2(base + lockedFinishAdd) : null
                            const priceLabel =
                              price != null
                                ? displayQty != null
                                  ? formatPrice(price, order.currency)
                                  : `from ${formatPrice(price, order.currency)}`
                                : null
                            const selected = chosenVariantId === v.id
                            return (
                              <button
                                key={v.id}
                                type="button"
                                aria-pressed={selected}
                                onClick={() => chooseThickness(v.id)}
                                className={[
                                  'block w-full rounded-xl border p-3 text-left transition-colors',
                                  selected
                                    ? 'border-[var(--c-brand)] bg-canvas ring-1 ring-[var(--c-brand)]'
                                    : 'border-line bg-surface hover:bg-canvas',
                                ].join(' ')}
                              >
                                <span className="flex items-baseline justify-between gap-3">
                                  <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                                    <span className="num text-[15px] font-medium text-brand">{note?.label ?? v.display_name}</span>
                                    {note?.name && <span className="text-sm font-medium text-ink">{note.name}</span>}
                                    {prevThickness.badgeId === v.id && prevThickness.badgeText && (
                                      <span className="rounded-full bg-brand-soft px-2 py-0.5 text-[11px] font-medium text-brand">
                                        {prevThickness.badgeText}
                                      </span>
                                    )}
                                    {note?.badge && !prevThickness.suppressCatalogueBadges && (
                                      <span className="rounded-full bg-in-stock-soft px-2 py-0.5 text-[11px] font-medium text-[var(--c-in-stock)]">
                                        {note.badge}
                                      </span>
                                    )}
                                  </span>
                                  {priceLabel && <span className="shrink-0 text-sm font-medium text-ink">{priceLabel}</span>}
                                </span>
                                {note?.description && (
                                  <span className="mt-1 block text-[12px] leading-[1.5] text-ink-soft">{note.description}</span>
                                )}
                              </button>
                            )
                          })}
                          {/* Always mounted: screen readers announce mutations
                              WITHIN an existing live region, not regions that
                              appear together with their text — and the
                              picked-something-different nudge is exactly the
                              note a blind customer must hear. sr-only keeps
                              the empty state invisible. */}
                          <p aria-live="polite" className={prevThickness.note ? 'text-[13px] text-ink-soft' : 'sr-only'}>
                            {prevThickness.note ?? ''}
                          </p>
                        </div>
                      )}

                      {finishOpen && specFinishes.length > 0 && (
                        <div className="space-y-2">
                          <p className="text-[13px] text-ink-soft">
                            {thicknessOpen ? 'And your finish:' : 'Choose your finish:'}
                          </p>
                          <div className="grid gap-2 sm:grid-cols-2">
                            {specFinishes.map((f) => {
                              const qtyBasis =
                                displayQty ?? tiers[0]?.quantity ?? specVariants[0]?.tiers[0]?.quantity ?? 0
                              const delta =
                                f.is_base || f.surTiers.length === 0
                                  ? 0
                                  : surchargeFromTiers(exvSurTiers(f.surTiers), qtyBasis, flatAboveTop)
                              return (
                                <FinishChoiceCard
                                  key={f.id}
                                  name={f.display_name}
                                  priceLabel={delta > 0 ? `+${formatPrice(delta, order.currency)}` : 'Included'}
                                  imageSrc={f.photoUrl ?? f.swatchUrl}
                                  imageAlt={f.photoUrl ? `${f.display_name} finish` : `Your design in ${f.display_name}`}
                                  description={f.description}
                                  badge={prevFinish.badgeId === f.id ? prevFinish.badgeText : null}
                                  selected={chosenOptionId === f.id}
                                  onChoose={() => chooseFinish(f.id)}
                                />
                              )
                            })}
                          </div>
                          <p aria-live="polite" className={prevFinish.note ? 'text-[13px] text-ink-soft' : 'sr-only'}>
                            {prevFinish.note ?? ''}
                          </p>
                        </div>
                      )}

                      {/* Escape hatch: hesitation becomes a tracked question on
                          the team's thread, not a closed tab. */}
                      <div className="border-t border-line-soft pt-3">
                        {askState === 'sent' ? (
                          <p className="text-[13px] text-ink-soft">
                            Thanks — we&rsquo;ve got your question and we&rsquo;ll reply by email shortly. You can also come back and pay here any time.
                          </p>
                        ) : !askOpen ? (
                          <button
                            type="button"
                            onClick={() => setAskOpen(true)}
                            className="text-[13px] font-medium text-ink-soft underline underline-offset-2 hover:text-ink"
                          >
                            Not sure which to pick? Ask us
                          </button>
                        ) : (
                          <div className="space-y-2">
                            <textarea
                              aria-label="Your question"
                              value={askText}
                              onChange={(e) => setAskText(e.target.value)}
                              rows={3}
                              maxLength={2000}
                              placeholder="e.g. Which thickness feels closest to a normal business card?"
                              className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink focus:border-[var(--c-brand)] focus:outline-2 focus:outline-offset-1 focus:outline-[var(--c-brand)]"
                            />
                            {askState === 'error' && (
                              <p className="text-[13px] text-out">
                                We couldn&rsquo;t send that just now — please reply to the email you received instead.
                              </p>
                            )}
                            <div className="flex flex-wrap gap-2">
                              <button
                                type="button"
                                onClick={() => void sendQuestion()}
                                disabled={askState === 'sending' || !askText.trim()}
                                className="rounded-lg bg-ink px-3 py-1.5 text-[13px] font-semibold text-on-ink transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                {askState === 'sending' ? 'Sending…' : 'Send question'}
                              </button>
                              <button
                                type="button"
                                onClick={() => { setAskOpen(false); setAskState('idle') }}
                                className="rounded-lg px-3 py-1.5 text-[13px] font-medium text-ink-soft ring-1 ring-line transition-colors hover:bg-surface"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Standalone quantity inputs for orders with no open spec
                      (locked thickness/finish, open quantity) — unchanged
                      position; open-spec orders render them inside the
                      Confirm-your-card section above instead. */}
                  {!(thicknessOpen || finishOpen) && quantityInputs}

                  {shippingComputedAtCheckout && (
                    <div className="space-y-2.5">
                      <p className="font-medium text-ink">Where should we ship these?</p>
                      <p className="text-[13px] text-ink-soft">So we can calculate shipping. You’ll confirm your full delivery address below.</p>
                      <div className="flex flex-col gap-2 sm:flex-row">
                        <select aria-label="Delivery country" aria-invalid={countryNeedsAttention || undefined}
                          value={destCountry} onChange={(e) => setDestCountry(e.target.value)}
                          className={`h-[38px] flex-1 rounded-lg border ${countryNeedsAttention ? 'border-out' : 'border-line'} bg-surface px-3 text-sm text-ink focus:border-[var(--c-brand)] focus:outline-2 focus:outline-offset-1 focus:outline-[var(--c-brand)]`}>
                          <option value="">Select country…</option>
                          {SHIP_COUNTRIES.map((c) => (<option key={c.code} value={c.code}>{c.name}</option>))}
                        </select>
                        <input aria-label="Delivery postcode" aria-invalid={postcodeNeedsAttention || undefined}
                          value={destPostcode} onChange={(e) => setDestPostcode(e.target.value)}
                          placeholder="Postcode / ZIP"
                          className={`h-[38px] flex-1 rounded-lg border ${postcodeNeedsAttention ? 'border-out' : 'border-line'} bg-surface px-3 text-sm text-ink focus:border-[var(--c-brand)] focus:outline-2 focus:outline-offset-1 focus:outline-[var(--c-brand)]`} />
                      </div>
                      {flagDest && destinationHint != null && (
                        <p className="text-[13px] font-medium text-out" aria-live="polite">{destinationHint}</p>
                      )}
                    </div>
                  )}

                  {/* US tariff & customs handling — shown for US-bound orders. Included
                      by default; opting out requires confirming the consequence (the
                      customer then deals with US Customs and any tariffs). The choice
                      is made here, before the PaymentIntent, so the charged total reflects it. */}
                  {tariffApplies && (
                    <div className="rounded-xl border border-line bg-canvas p-4">
                      <div className="flex items-baseline justify-between gap-3">
                        <p className="font-medium text-ink">US tariff &amp; customs handling</p>
                        <p className={tariffOptedOut ? 'text-ink-mute line-through' : 'font-medium text-ink'}>{formatPrice(tariffFee, order.currency)}</p>
                      </div>
                      {tariff?.intro && <p className="mt-2 text-[13px] leading-relaxed text-ink-soft">{tariff.intro}</p>}
                      {!tariffOptedOut ? (
                        tariffConfirmingOptOut ? (
                          <div className="mt-3 rounded-lg border border-low bg-low-soft p-3">
                            <p className="text-[13px] leading-relaxed text-ink">{tariff?.warning}</p>
                            <div className="mt-3 flex flex-wrap gap-2">
                              <button type="button" onClick={() => { setTariffOptedOut(true); setTariffConfirmingOptOut(false) }}
                                className="rounded-lg bg-ink px-3 py-1.5 text-[13px] font-semibold text-on-ink transition-opacity hover:opacity-90">
                                Yes, remove it — I&rsquo;ll handle US customs
                              </button>
                              <button type="button" onClick={() => setTariffConfirmingOptOut(false)}
                                className="rounded-lg px-3 py-1.5 text-[13px] font-medium text-ink-soft ring-1 ring-line transition-colors hover:bg-surface">
                                Keep it
                              </button>
                            </div>
                          </div>
                        ) : (
                          <button type="button" onClick={() => setTariffConfirmingOptOut(true)}
                            className="mt-3 text-[13px] font-medium text-ink-soft underline underline-offset-2 hover:text-ink">
                            Remove this charge
                          </button>
                        )
                      ) : (
                        <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-line bg-surface px-3 py-2">
                          <p className="text-[13px] text-ink-soft">Removed — you&rsquo;ll deal with US Customs and any tariffs directly.</p>
                          <button type="button" onClick={() => setTariffOptedOut(false)}
                            className="shrink-0 text-[13px] font-medium text-ink-soft underline underline-offset-2 hover:text-ink">
                            Add it back
                          </button>
                        </div>
                      )}
                    </div>
                  )}

                  {payError && (
                    <div role="alert" className="rounded-lg border border-out bg-out-soft px-3 py-2 text-[13px] text-out">{payError}</div>
                  )}

                  <button type="button" onClick={() => void startCheckout()} disabled={paying || !specResolved || awaitingQuantity || !destinationComplete}
                    className="inline-flex w-full items-center justify-center rounded-lg bg-ink px-5 py-3 text-sm font-semibold text-on-ink transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50">
                    {paying ? 'Loading secure payment…'
                      : awaitingQuantity ? 'Choose a quantity to continue'
                        : thicknessOpen && chosenVariantId == null ? 'Choose a thickness to continue'
                          : finishOpen && chosenOptionId == null ? 'Choose a finish to continue'
                            : destinationPrompt != null ? destinationPrompt
                              : payTotal != null ? `Continue to payment — ${formatPrice(payTotal, order.currency)}`
                                : 'Continue to payment'}
                  </button>
                  <p className="text-center text-[12px] text-ink-mute" aria-live="polite">
                    {/* The outstanding delivery field says its own piece in rose
                        next to the field itself, so this line stays out of the
                        way rather than repeating it under the button. */}
                    {awaitingQuantity ? 'Select a quantity to see exact prices for each option.'
                      : !specResolved ? 'Confirm your card above to see your total.'
                        : 'Secured by Stripe.'}
                  </p>
                </div>
              ) : (
                <>
                  {!formMounted && (
                    <div className="absolute inset-x-0 top-24 flex flex-col items-center gap-2 text-ink-mute">
                      <div className="h-6 w-6 animate-spin rounded-full border-2 border-line border-t-ink" />
                      <span className="text-sm">Loading secure payment…</span>
                    </div>
                  )}
                  <div className="space-y-4">
                    <div>
                      <p className="mb-1.5 text-[12px] font-medium text-ink-mute">Contact</p>
                      <div id="link-auth" aria-label="Contact details" />
                    </div>
                    <div>
                      <p className="mb-1.5 text-[12px] font-medium text-ink-mute">Shipping address</p>
                      <div id="address-element" aria-label="Shipping address" />
                    </div>
                    {isEuBound && (
                      <div>
                        <label htmlFor="customs-tax-id" className="mb-1.5 block text-[12px] font-medium text-ink-mute">
                          VAT / EORI number <span className="font-normal">(optional)</span>
                        </label>
                        <input id="customs-tax-id" type="text" value={customsTaxId} onChange={(e) => setCustomsTaxId(e.target.value)}
                          autoComplete="off" placeholder="e.g. DE123456789"
                          className="h-[38px] w-full rounded-lg border border-line bg-surface px-3 text-sm text-ink focus:border-[var(--c-brand)] focus:outline-2 focus:outline-offset-1 focus:outline-[var(--c-brand)]" />
                        <p className="mt-1 text-[12px] text-ink-mute">For business orders — helps your parcel clear customs without delay.</p>
                      </div>
                    )}
                    <div>
                      <p className="mb-1.5 text-[12px] font-medium text-ink-mute">Payment details</p>
                      <div id="payment-element" aria-label="Payment details" />
                    </div>
                  </div>
                  {formError && (
                    <div role="alert" className="mt-3 rounded-lg border border-out bg-out-soft px-3 py-2 text-[13px] text-out">{formError}</div>
                  )}
                  <button type="button" onClick={() => void confirmPay()} disabled={submitting || !formMounted}
                    className="mt-4 inline-flex w-full items-center justify-center rounded-lg bg-ink px-5 py-3 text-sm font-semibold text-on-ink transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50">
                    {submitting ? 'Processing…' : `Pay ${formatPrice(checkout.amount, checkout.currency)}`}
                  </button>
                  <p className="mt-2 text-center text-[12px] text-ink-mute">
                    Secured by Stripe.{checkout.currency === 'GBP' ? (checkout.vatFree ? ' VAT-free.' : ' Includes VAT.') : ''}
                  </p>
                  {(isOpenGrid || thicknessOpen || finishOpen || shippingComputedAtCheckout || tariffApplies) && (
                    <button type="button" onClick={() => { setCheckout(null); setFormError(null) }}
                      className="mt-3 block w-full text-center text-[12px] text-ink-mute underline hover:text-ink">
                      Edit order details
                    </button>
                  )}
                </>
              )}
            </PanelShell>
          </div>

          {order.expires_at && (
            <p className="mt-4 text-center text-[12px] text-ink-mute">
              This payment link is valid until {formatApprovedDate(order.expires_at)}. After that, just reply to your email and we&rsquo;ll send a fresh one.
            </p>
          )}
        </div>
      </div>
    )
  }

  // ── Not payable online ────────────────────────────────────────────
  // Reached only when the order can't be priced online (no custom quote and no
  // locked/open grid config). The payable path is the unified screen above.
  return (
    <Screen>
      <PanelShell className="w-full max-w-lg text-center">
        <p className="eyebrow">Complete your order</p>
        <h1 className="mt-1 text-xl font-semibold text-ink">{company ? company : 'Your order'}</h1>
        <p className="mt-1 text-sm text-ink-soft">Reference {order.payment_reference}</p>
        <div className="mt-6 rounded-xl border border-dashed border-line bg-canvas p-4">
          <p className="text-sm font-medium text-ink">Online payment for this order is being set up</p>
          <p className="mt-1 text-[13px] text-ink-soft">
            Please reply to the email you received and we&rsquo;ll confirm the price and send you a secure payment link.
          </p>
        </div>
        {order.expires_at && (
          <p className="mt-4 text-[12px] text-ink-mute">
            This payment link is valid until {formatApprovedDate(order.expires_at)}.
          </p>
        )}
      </PanelShell>
    </Screen>
  )
}

function formatApprovedDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

function Row({ label, value, bold = false }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-ink-soft">{label}</span>
      <span className={bold ? 'font-semibold text-ink' : 'text-ink'}>{value}</span>
    </div>
  )
}

function Screen({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-canvas">
      <CustomerHeader innerClassName="max-w-5xl" />
      <div className="flex flex-1 items-center justify-center p-4">
        {children}
      </div>
    </div>
  )
}
