import { useEffect, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { formatPrice } from '../lib/currency'
import { getPublicSettings } from '../lib/publicSettings'
import { Pill, PanelShell } from '../design'
import { LoadingProofAnimation } from '../components/LoadingProofAnimation'
import { interpolateValue } from '../lib/quote/interpolation'
import { SHIP_COUNTRIES } from '../lib/shipCountries'
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
  status: 'draft' | 'sent' | 'paid' | 'fulfilled' | 'expired' | 'cancelled'
  material_variant_id: string | null
  material_option_id: string | null
  quantity: number | null
  names_count: number
  has_personalisation: boolean
  custom_quote_total: number | null
  shipping_treatment: 'full_cost' | 'goodwill' | 'free' | 'manual'
  shipping_charged: number | null
  ship_dest_country: string | null
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
}

// One-line spec shown in the artwork recap on the post-payment confirmation.
type RecapSpec = {
  material: string
  variant: string | null
  finish: string | null
  approvedAt: string | null
  inks: string[]
}

const SHIPPING_LABEL: Record<OrderPayload['shipping_treatment'], string> = {
  full_cost: 'Standard shipping',
  goodwill: 'Shipping (partly covered by us)',
  free: 'Free shipping',
  manual: 'Shipping',
}

// Load Stripe.js from Stripe's CDN (required — Stripe.js must not be bundled,
// for PCI). Resolves the global Stripe factory, loading the script once and
// reusing it on subsequent calls. Returns null if the script can't load.
const STRIPE_JS_SRC = 'https://js.stripe.com/v3/'
function loadStripeJs(): Promise<((key: string) => StripeLike) | null> {
  const w = window as unknown as { Stripe?: (key: string) => StripeLike }
  if (w.Stripe) return Promise.resolve(w.Stripe)
  return new Promise((resolve) => {
    const existing = document.querySelector(`script[src="${STRIPE_JS_SRC}"]`) as HTMLScriptElement | null
    if (existing) {
      existing.addEventListener('load', () => resolve(w.Stripe ?? null))
      existing.addEventListener('error', () => resolve(null))
      if (w.Stripe) resolve(w.Stripe)
      return
    }
    const s = document.createElement('script')
    s.src = STRIPE_JS_SRC
    s.async = true
    s.onload = () => resolve(w.Stripe ?? null)
    s.onerror = () => resolve(null)
    document.head.appendChild(s)
  })
}

// Minimal shapes of the bits of Stripe.js Elements we use — avoids a bundled
// @stripe/stripe-js dependency (Stripe.js is loaded from their CDN). We build
// our own checkout layout and mount Stripe's Payment / Address / Link elements
// into it, then confirm the PaymentIntent.
interface StripeElementLike {
  mount: (selector: string) => void
  unmount?: () => void
  // Link / address elements emit a 'change' event carrying the entered value.
  // We listen on the Link element to capture the buyer's email (see below).
  on?: (event: string, handler: (e: { value?: { email?: string } }) => void) => void
}
interface StripeElementsLike {
  create: (type: string, options?: Record<string, unknown>) => StripeElementLike
}
interface StripeConfirmResult {
  error?: { message?: string }
}
interface StripeLike {
  elements: (options: { clientSecret: string; appearance?: Record<string, unknown> }) => StripeElementsLike
  confirmPayment: (options: {
    elements: StripeElementsLike
    // receipt_email must be passed explicitly — Stripe does NOT auto-promote the
    // Link element's email onto the PaymentIntent. Without it the webhook gets a
    // null email and the Xero VAT invoice can't be sent.
    confirmParams: { return_url: string; receipt_email?: string }
  }) => Promise<StripeConfirmResult>
}

export default function OrderPayPage() {
  const { id } = useParams<{ id: string }>()
  const [params] = useSearchParams()
  const token = params.get('token')

  const [loading, setLoading] = useState(true)
  const [order, setOrder] = useState<OrderPayload | null>(null)
  const [company, setCompany] = useState<string | null>(null)
  // Recap (trust anchor): a few thumbnails of the approved artwork +
  // a one-line spec (material + locked variant). Pulled best-effort
  // from the same proof graph + customer-proof-images edge function the
  // proof page uses; failure leaves the recap off without blocking pay.
  const [thumbs, setThumbs] = useState<GridImage[]>([])
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
  const [perExtraName, setPerExtraName] = useState<number | null>(null)
  const [personalisation, setPersonalisation] = useState<{ perCardRate: number; minCharge: number } | null>(null)
  // Per-quantity finish (material-option) surcharge schedule, set when the
  // order pinned a non-base finish (metal Brushed/Mirror). Read from the same
  // customer-proof graph; interpolated client-side the same way the server
  // does so the shown total equals the charge. The finish name itself lives on
  // `spec.finish` for the recap.
  const [finishTiers, setFinishTiers] = useState<{ quantity: number; surcharge: number }[]>([])
  const [chosenQuantity, setChosenQuantity] = useState<number | null>(null)
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
      const { data, error } = await supabase.functions.invoke<{ client_secret?: string; publishable_key?: string; amount?: number; currency?: Currency; breakdown?: { cards: number; tooling: number; personalisation: number; shipping: number; us_tariff: number; card_discount: number }; error?: string; message?: string }>(
        'create-checkout-session',
        {
          body: {
            order_id: id,
            token,
            origin: window.location.origin,
            quantity: chosenQuantity ?? undefined,
            person_quantities: personPayload.length > 0 ? personPayload : undefined,
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
  // Address element rides confirmPayment automatically (→ payment_intent.shipping),
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
        elements.create('address', { mode: 'shipping' }).mount('#address-element')
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
      // Pre-fill the destination country from the designer's optional hint so
      // the customer usually just adds their postcode.
      if (o.ship_dest_country) setDestCountry(o.ship_dest_country)
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
                const front = versionImgs.find((img) => img.side === 'front')
                const back = versionImgs.find((img) => img.side === 'back')
                const bySide = [front, back].filter((img): img is GridImage => !!img)
                setThumbs(bySide.length > 0 ? bySide : versionImgs.slice(0, 2))
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
    const needsQty = order.custom_quote_total == null && order.material_variant_id != null && order.quantity == null
    const needsDest = order.shipping_treatment === 'full_cost' || order.shipping_treatment === 'goodwill'
    // A US destination always shows the inputs panel (don't auto-advance), so the
    // customer sees the US tariff & customs handling line and its opt-out before
    // the PaymentIntent is created. For full_cost/goodwill needsDest already does
    // this; this covers free/manual US orders with a designer-set US destination.
    const isUsDest = (order.ship_dest_country ?? '').toUpperCase() === 'US'
    const canPay = order.custom_quote_total != null || (order.material_variant_id != null && order.quantity != null)
    if (canPay && !needsQty && !needsDest && !isUsDest) void startCheckout()
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

  // Rich post-payment confirmation, shared by the confirmed and optimistic
  // (?paid=1, pre-webhook) states. Shows the approved-artwork recap, an itemised
  // paid summary (from the breakdown stamped at checkout), the delivery address
  // (confirmed only), what-happens-next, and the self-serve VAT-invoice link
  // (renderVatInvoice). `confirmed` distinguishes the two moments.
  function renderConfirmation(confirmed: boolean, o: OrderPayload) {
    const round2 = (n: number) => Math.round(n * 100) / 100
    const amt = (n: number | null) => (n == null ? 0 : Number(n))
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
    return (
      <Screen>
        <PanelShell className="w-full max-w-lg">
          <Pill colour="in-stock">{confirmed ? 'Paid' : 'Payment received'}</Pill>
          <h1 className="mt-3 text-xl font-semibold text-ink">
            {confirmed ? 'Order confirmed' : 'Thank you — payment received'}
          </h1>
          {company && <p className="mt-1 text-sm text-ink-soft">{company}</p>}
          {o.payment_reference && (
            <p className="mt-0.5 text-sm text-ink-soft">Reference {o.payment_reference}</p>
          )}

          <Recap thumbs={thumbs} spec={spec} />

          {/* What was ordered + paid — from the breakdown stamped at checkout. */}
          {haveSummary && (
            <div className="mt-5 space-y-2 border-t border-line pt-5 text-sm">
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
              {o.currency === 'GBP' && <p className="text-[12px] text-ink-mute">Includes VAT.</p>}
            </div>
          )}

          {/* Delivery address — only once the webhook has stored what Stripe collected. */}
          {haveAddress && (
            <div className="mt-5 border-t border-line pt-4 text-sm">
              <p className="text-[11px] font-medium uppercase tracking-wide text-ink-mute">Shipping to</p>
              <p className="mt-1 text-ink">
                {o.ship_to_name && (
                  <>
                    {o.ship_to_name}
                    <br />
                  </>
                )}
                {addressLine}
              </p>
            </div>
          )}

          {/* What happens next. */}
          <div className="mt-5 rounded-xl border border-line bg-canvas p-4 text-sm text-ink-soft">
            <p className="font-medium text-ink">What happens next</p>
            {confirmed ? (
              <ul className="mt-2 list-disc space-y-1.5 pl-5">
                <li>Your cards are now in production.</li>
                <li>We&rsquo;ll email you dispatch details as soon as they&rsquo;re on their way.</li>
              </ul>
            ) : (
              <ul className="mt-2 list-disc space-y-1.5 pl-5">
                <li>We&rsquo;re just confirming your payment — this only takes a moment.</li>
                <li>A receipt is on its way to your email.</li>
                <li>You can safely close this page.</li>
              </ul>
            )}
          </div>

          {/* Self-serve VAT invoice (Xero online-invoice link, once it reconciles). */}
          {renderVatInvoice()}

          <p className="mt-4 text-center text-[12px] text-ink-mute">
            Questions about your order? Just reply to your order email and we&rsquo;ll help.
          </p>
        </PanelShell>
      </Screen>
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
    order.status === 'cancelled' ||
    (order.status === 'sent' && order.expires_at != null && new Date(order.expires_at).getTime() < Date.now())

  if (order.status === 'paid' || order.status === 'fulfilled') {
    return renderConfirmation(true, order)
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
  // mirrors the server's resolution. Fee is from public_settings for the order
  // currency; a 0 fee disables it. Included by default; drops to 0 on opt-out.
  const effectiveDestCountry = (shippingComputedAtCheckout ? destCountry : order.ship_dest_country ?? '').toUpperCase()
  const tariffFee = tariff ? tariff.fees[order.currency] ?? 0 : 0
  const tariffApplies = effectiveDestCountry === 'US' && tariffFee > 0
  const tariffAmount = tariffApplies && !tariffOptedOut ? tariffFee : 0
  // Open-quantity grid order: the designer left quantity for the customer
  // and the variant has listed tiers. Split = a quantity per person; single
  // = one tier selector.
  const isOpenGrid =
    order.custom_quote_total == null &&
    order.material_variant_id != null &&
    order.quantity == null &&
    tiers.length > 0
  const isSplitOpen = isOpenGrid && personNames.length > 1
  const isSingleOpen = isOpenGrid && personNames.length <= 1

  // Base card total for a quantity: exact listed tier, or interpolated
  // between the two bracketing tiers (combined-total basis). Mirrors the
  // server's cardTotalForQuantity so the shown figure equals the charge;
  // null below the lowest / above the highest tier.
  function cardTotalForQty(qty: number): number | null {
    if (tiers.length === 0) return null
    const exact = tiers.find((t) => t.quantity === qty)
    if (exact) return exact.total_price
    let lower: { quantity: number; total_price: number } | null = null
    let upper: { quantity: number; total_price: number } | null = null
    for (const t of tiers) {
      if (t.quantity < qty) lower = t
      else if (t.quantity > qty) { upper = t; break }
    }
    if (lower && upper) {
      return interpolateValue(lower.quantity, lower.total_price, upper.quantity, upper.total_price, qty)
    }
    return null
  }

  // Finish (material-option) surcharge for a quantity: exact tier or
  // interpolated, mirroring the server's cardTotalForQuantity over the
  // surcharge schedule. 0 when there's no non-base finish. Out of range → 0
  // (the server treats an unpriceable surcharge as 0 too).
  function finishSurchargeForQty(qty: number): number {
    if (finishTiers.length === 0) return 0
    const exact = finishTiers.find((t) => t.quantity === qty)
    if (exact) return exact.surcharge
    let lower: { quantity: number; surcharge: number } | null = null
    let upper: { quantity: number; surcharge: number } | null = null
    for (const t of finishTiers) {
      if (t.quantity < qty) lower = t
      else if (t.quantity > qty) { upper = t; break }
    }
    if (lower && upper) {
      return interpolateValue(lower.quantity, lower.surcharge, upper.quantity, upper.surcharge, qty)
    }
    return 0
  }

  // Full pay total for a combined quantity: cards + tooling + personalisation
  // + finish surcharge + shipping. Shared by the single-selector and per-person
  // paths.
  function payTotalForQty(qty: number): number | null {
    if (!order || qty <= 0) return null
    const cards = cardTotalForQty(qty)
    if (cards == null) return null
    const splitName = perExtraName && order.names_count > 1 ? (order.names_count - 1) * perExtraName : 0
    const pers = personalisation ? Math.max(personalisation.minCharge, qty * personalisation.perCardRate) : 0
    const finish = finishSurchargeForQty(qty)
    return round2(round2(cards + splitName + pers + finish) + shippingAmount + tariffAmount)
  }

  // Per-person entries → combined sum. Complete only when every person has a
  // quantity of at least one.
  const personParsed = personNames.map((n) => {
    const v = parseInt(personQty[n] ?? '', 10)
    return Number.isFinite(v) && v > 0 ? v : 0
  })
  const splitSum = personParsed.reduce((a, b) => a + b, 0)
  const splitComplete = isSplitOpen && personParsed.every((q) => q >= 1)
  const splitTotal = splitComplete ? payTotalForQty(splitSum) : null
  // When every person has a quantity but the combined total can't be priced,
  // explain why (below the minimum / above the online maximum) rather than
  // just disabling the button silently.
  const splitRangeHint =
    isSplitOpen && splitComplete && splitTotal == null
      ? (() => {
          const min = tiers[0]?.quantity
          const max = tiers[tiers.length - 1]?.quantity
          if (min != null && splitSum < min) return `Our minimum order is ${min.toLocaleString()} cards in total.`
          if (max != null && splitSum > max)
            return `For more than ${max.toLocaleString()} cards, please reply to the email you received and we’ll sort it.`
          return 'We couldn’t price this quantity — please reply to the email you received.'
        })()
      : null

  // Single-person open order: the customer types any quantity within the
  // listed range and the price interpolates (matching the split path + the
  // Quote compiler). min/max bound the type-in; an out-of-range entry shows a
  // hint and blocks checkout rather than silently failing server-side.
  const singleMin = tiers[0]?.quantity ?? null
  const singleMax = tiers[tiers.length - 1]?.quantity ?? null
  const singleCardTotal =
    isSingleOpen && chosenQuantity != null ? cardTotalForQty(chosenQuantity) : null
  const singleRangeHint =
    isSingleOpen && chosenQuantity != null && singleCardTotal == null
      ? singleMin != null && chosenQuantity < singleMin
        ? `Our minimum order is ${singleMin.toLocaleString()} cards.`
        : singleMax != null && chosenQuantity > singleMax
          ? `For more than ${singleMax.toLocaleString()} cards, please reply to the email you received and we’ll sort it.`
          : 'We couldn’t price this quantity — please reply to the email you received.'
      : null

  const awaitingQuantity = isSplitOpen
    ? splitTotal == null
    : isSingleOpen
      ? chosenQuantity == null || singleCardTotal == null
      : false
  const canCheckout =
    shippingResolvable &&
    (order.custom_quote_total != null ||
      (order.material_variant_id != null && order.quantity != null) ||
      isOpenGrid)
  // full_cost / goodwill orders need the customer's delivery country + postcode
  // before we can rate the carriage at checkout.
  const destinationComplete =
    !shippingComputedAtCheckout || (!!destCountry && destPostcode.trim().length > 0)
  // Total is known client-side for a custom quote, a chosen single quantity,
  // or a completed per-person split; a designer-locked grid quantity is shown
  // on Stripe's hosted page (it may be an interpolated in-between). When
  // shipping is rated at checkout (full_cost / goodwill) the final figure
  // isn't known here, so we defer the whole total to Stripe rather than show
  // a goods-only figure the customer would mistake for the all-in price.
  const payTotal = shippingComputedAtCheckout
    ? null
    : order.custom_quote_total != null
      ? order.custom_quote_total + shippingAmount + tariffAmount
      : isSplitOpen
        ? splitTotal
        : isSingleOpen
          ? payTotalForQty(chosenQuantity ?? 0)
          : null

  // The quantity we'd charge for, for display. Locked → order.quantity;
  // open → the customer's chosen / per-person total once entered.
  const displayQty =
    order.quantity ??
    (isSplitOpen ? (splitComplete ? splitSum : null) : isSingleOpen ? chosenQuantity : null)
  // Card subtotal (cards + tooling + personalisation; shipping is 0 here for
  // shipping-rated orders). Shown so the customer always sees the card price,
  // even when the all-in total is finalised on Stripe (full_cost / goodwill).
  const cardsSubtotal =
    order.custom_quote_total != null
      ? order.custom_quote_total
      : displayQty != null
        ? payTotalForQty(displayQty)
        : null

  // ── Single-screen checkout ────────────────────────────────────────
  // One page: order recap + cost summary on the left; on the right either the
  // inputs we still need (quantity / shipping destination) or — once those are
  // set and the PaymentIntent is created — the Stripe payment form. No-input
  // orders auto-advance (see the effect above), so the customer lands straight
  // on the full checkout with the form already showing.
  if (canCheckout) {
    return (
      <div className="flex min-h-screen justify-center bg-canvas px-4 py-8">
        <div className="w-full max-w-5xl">
          <p className="eyebrow">Complete your order</p>
          <h1 className="mt-1 text-xl font-semibold text-ink">{company ? company : 'Your order'}</h1>
          <p className="mt-1 text-sm text-ink-soft">Reference {order.payment_reference}</p>

          <div ref={mountWrapRef} className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
            {/* LEFT — recap + cost summary */}
            <PanelShell className="self-start">
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-[11px] font-medium uppercase tracking-wide text-ink-mute">Order summary</p>
                {spec?.approvedAt && (
                  <p className="text-[12px] text-ink-mute">Approved {formatApprovedDate(spec.approvedAt)}</p>
                )}
              </div>
              {thumbs.length > 0 && (
                <div className={`mt-3 grid gap-3 ${thumbs.length > 1 ? 'sm:grid-cols-2' : ''}`}>
                  {thumbs.map((img) => (
                    <img key={img.id} src={img.signed_url} alt="Approved proof artwork" className="w-full rounded-lg bg-surface ring-1 ring-line" />
                  ))}
                </div>
              )}
              {spec && (
                <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                  <dt className="text-ink-mute">Material</dt>
                  <dd className="text-ink">{spec.material}</dd>
                  {spec.variant && (<><dt className="text-ink-mute">Option</dt><dd className="text-ink">{spec.variant}</dd></>)}
                  {spec.finish && (<><dt className="text-ink-mute">Finish</dt><dd className="text-ink">{spec.finish}</dd></>)}
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
                    <Row label={order.custom_quote_total != null ? 'Agreed price' : 'Cards'} value={formatPrice(checkout.breakdown.cards, checkout.currency)} />
                    {checkout.breakdown.card_discount > 0 && <Row label="Discount" value={formatPrice(-checkout.breakdown.card_discount, checkout.currency)} />}
                    {checkout.breakdown.tooling > 0 && <Row label="Tooling" value={formatPrice(checkout.breakdown.tooling, checkout.currency)} />}
                    {checkout.breakdown.personalisation > 0 && <Row label="Personalisation" value={formatPrice(checkout.breakdown.personalisation, checkout.currency)} />}
                    <Row label="Shipping" value={checkout.breakdown.shipping > 0 ? formatPrice(checkout.breakdown.shipping, checkout.currency) : 'Free'} />
                    {checkout.breakdown.us_tariff > 0 && <Row label="US tariff & customs handling" value={formatPrice(checkout.breakdown.us_tariff, checkout.currency)} />}
                  </>
                ) : (
                  <>
                    {order.custom_quote_total == null && cardsSubtotal != null && (
                      <Row label="Cards" value={formatPrice(cardsSubtotal, order.currency)} />
                    )}
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
                  {order.currency === 'GBP' && <p className="mt-1 text-[12px] text-ink-mute">Includes VAT.</p>}
                </>
              )}
            </PanelShell>

            {/* RIGHT — inputs (until the intent exists), then the payment form */}
            <PanelShell className="relative min-h-[300px]">
              {!checkout ? (
                <div className="space-y-4 text-sm">
                  {isSplitOpen ? (
                    <div className="space-y-2.5">
                      <p className="text-ink-soft">Quantity for each person</p>
                      {personNames.map((name) => (
                        <div key={name} className="flex items-center justify-between gap-4">
                          <label htmlFor={`q-${name}`} className="truncate text-ink">{name}</label>
                          <input id={`q-${name}`} type="number" min={1} step={1} inputMode="numeric"
                            value={personQty[name] ?? ''}
                            onChange={(e) => setPersonQty((prev) => ({ ...prev, [name]: e.target.value }))}
                            placeholder="0"
                            className="h-[38px] w-24 rounded-lg border border-line bg-surface px-3 text-right text-sm text-ink focus:border-[var(--c-brand)] focus:outline-2 focus:outline-offset-1 focus:outline-[var(--c-brand)]" />
                        </div>
                      ))}
                      <div className="flex items-center justify-between gap-4 border-t border-line-soft pt-2.5">
                        <span className="text-ink-soft">Total</span>
                        <span className="font-medium text-ink">{splitSum > 0 ? `${splitSum.toLocaleString()} cards` : '—'}</span>
                      </div>
                      {splitRangeHint && <p className="text-[13px] text-low">{splitRangeHint}</p>}
                    </div>
                  ) : isSingleOpen ? (
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between gap-4">
                        <label htmlFor="order-quantity" className="text-ink-soft">Quantity</label>
                        <input id="order-quantity" type="number" min={singleMin ?? 1} max={singleMax ?? undefined} step={1} inputMode="numeric"
                          value={chosenQuantity ?? ''}
                          onChange={(e) => { const n = parseInt(e.target.value, 10); setChosenQuantity(Number.isFinite(n) && n > 0 ? n : null) }}
                          placeholder={singleMin != null ? `${singleMin.toLocaleString()}+` : 'e.g. 250'}
                          className="h-[38px] w-28 rounded-lg border border-line bg-surface px-3 text-right text-sm text-ink focus:border-[var(--c-brand)] focus:outline-2 focus:outline-offset-1 focus:outline-[var(--c-brand)]" />
                      </div>
                      {singleMin != null && singleMax != null && (
                        <p className="text-right text-[12px] text-ink-mute">Any quantity from {singleMin.toLocaleString()} to {singleMax.toLocaleString()}.</p>
                      )}
                      {singleRangeHint && <p className="text-[13px] text-low">{singleRangeHint}</p>}
                    </div>
                  ) : null}

                  {shippingComputedAtCheckout && (
                    <div className="space-y-2.5">
                      <p className="font-medium text-ink">Where should we ship these?</p>
                      <p className="text-[13px] text-ink-soft">So we can calculate shipping. You’ll confirm your full delivery address below.</p>
                      <div className="flex flex-col gap-2 sm:flex-row">
                        <select aria-label="Delivery country" value={destCountry} onChange={(e) => setDestCountry(e.target.value)}
                          className="h-[38px] flex-1 rounded-lg border border-line bg-surface px-3 text-sm text-ink focus:border-[var(--c-brand)] focus:outline-2 focus:outline-offset-1 focus:outline-[var(--c-brand)]">
                          <option value="">Select country…</option>
                          {SHIP_COUNTRIES.map((c) => (<option key={c.code} value={c.code}>{c.name}</option>))}
                        </select>
                        <input aria-label="Delivery postcode" value={destPostcode} onChange={(e) => setDestPostcode(e.target.value)}
                          placeholder="Postcode / ZIP"
                          className="h-[38px] flex-1 rounded-lg border border-line bg-surface px-3 text-sm text-ink focus:border-[var(--c-brand)] focus:outline-2 focus:outline-offset-1 focus:outline-[var(--c-brand)]" />
                      </div>
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
                    <div className="rounded-lg border border-out bg-out-soft px-3 py-2 text-[13px] text-out">{payError}</div>
                  )}

                  <button type="button" onClick={() => void startCheckout()} disabled={paying || awaitingQuantity || !destinationComplete}
                    className="inline-flex w-full items-center justify-center rounded-lg bg-ink px-5 py-3 text-sm font-semibold text-on-ink transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50">
                    {paying ? 'Loading secure payment…'
                      : awaitingQuantity ? 'Choose a quantity to continue'
                        : !destinationComplete ? 'Enter delivery country & postcode'
                          : payTotal != null ? `Continue to payment — ${formatPrice(payTotal, order.currency)}`
                            : 'Continue to payment'}
                  </button>
                  <p className="text-center text-[12px] text-ink-mute">
                    {awaitingQuantity ? 'Select a quantity to see your total.'
                      : !destinationComplete ? 'Enter where we’re shipping to so we can calculate shipping.'
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
                    <div id="link-auth" />
                    <div id="address-element" />
                    <div id="payment-element" />
                  </div>
                  {formError && (
                    <div className="mt-3 rounded-lg border border-out bg-out-soft px-3 py-2 text-[13px] text-out">{formError}</div>
                  )}
                  <button type="button" onClick={() => void confirmPay()} disabled={submitting || !formMounted}
                    className="mt-4 inline-flex w-full items-center justify-center rounded-lg bg-ink px-5 py-3 text-sm font-semibold text-on-ink transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50">
                    {submitting ? 'Processing…' : `Pay ${formatPrice(checkout.amount, checkout.currency)}`}
                  </button>
                  <p className="mt-2 text-center text-[12px] text-ink-mute">
                    Secured by Stripe.{checkout.currency === 'GBP' ? ' Includes VAT.' : ''}
                  </p>
                  {(isOpenGrid || shippingComputedAtCheckout || tariffApplies) && (
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

// Approved-artwork recap (thumbnails + one-line spec + approved date), shown on
// the post-payment confirmation. Renders nothing when neither resolved.
function Recap({ thumbs, spec }: { thumbs: GridImage[]; spec: RecapSpec | null }) {
  if (thumbs.length === 0 && !spec) return null
  return (
    <div className="mt-5 rounded-xl border border-line bg-canvas p-4">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-[11px] font-medium uppercase tracking-wide text-ink-mute">Approved artwork</p>
        {spec?.approvedAt && (
          <p className="text-[12px] text-ink-mute">Approved {formatApprovedDate(spec.approvedAt)}</p>
        )}
      </div>
      {thumbs.length > 0 && (
        <div className={`mt-3 grid gap-3 ${thumbs.length > 1 ? 'sm:grid-cols-2' : ''}`}>
          {thumbs.map((img) => (
            <img
              key={img.id}
              src={img.signed_url}
              alt="Approved proof artwork"
              className="w-full rounded-lg bg-surface ring-1 ring-line"
            />
          ))}
        </div>
      )}
      {spec && (
        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-ink-mute">Material</dt>
          <dd className="text-ink">{spec.material}</dd>
          {spec.variant && (
            <>
              <dt className="text-ink-mute">Option</dt>
              <dd className="text-ink">{spec.variant}</dd>
            </>
          )}
          {spec.finish && (
            <>
              <dt className="text-ink-mute">Finish</dt>
              <dd className="text-ink">{spec.finish}</dd>
            </>
          )}
          {spec.inks.length > 0 && (
            <>
              <dt className="text-ink-mute">Ink</dt>
              <dd className="text-ink">{spec.inks.join(', ')}</dd>
            </>
          )}
        </dl>
      )}
    </div>
  )
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
    <div className="flex min-h-screen items-center justify-center bg-canvas p-4">
      {children}
    </div>
  )
}
