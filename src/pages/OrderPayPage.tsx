import { useEffect, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { formatPrice } from '../lib/currency'
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

// Minimal shapes of the bits of Stripe.js embedded checkout we use — avoids a
// bundled @stripe/stripe-js dependency (Stripe.js is loaded from their CDN).
interface EmbeddedCheckoutInstance {
  mount: (selector: string) => void
  destroy: () => void
}
interface StripeLike {
  initEmbeddedCheckout: (opts: { clientSecret: string }) => Promise<EmbeddedCheckoutInstance>
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
  const [notFound, setNotFound] = useState(false)
  const [paying, setPaying] = useState(false)
  const [payError, setPayError] = useState<string | null>(null)
  // Embedded checkout: once the session is created, this holds the client
  // secret + publishable key; an effect mounts Stripe's form into the page.
  const [checkout, setCheckout] = useState<{ clientSecret: string; pk: string } | null>(null)
  // True once Stripe's iframe is mounted, so we can show a loading state in the
  // reserved space until then (avoids a collapse-then-grow jump).
  const [formMounted, setFormMounted] = useState(false)
  const mountWrapRef = useRef<HTMLDivElement | null>(null)
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
      const { data, error } = await supabase.functions.invoke<{ client_secret?: string; publishable_key?: string; error?: string; message?: string }>(
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
          },
        },
      )
      if (error || !data || data.error || !data.client_secret || !data.publishable_key) {
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
      // Reveal the embedded checkout form in-page (the mount effect below
      // picks this up). Keep `paying` true so the button stays disabled while
      // the form loads in its place.
      setCheckout({ clientSecret: data.client_secret, pk: data.publishable_key })
    } catch {
      setPayError('We couldn’t start checkout. Please reply to the email you received and we’ll help.')
      setPaying(false)
    }
  }

  // Mount Stripe's embedded checkout once we have a client secret. Loads
  // Stripe.js from the CDN, inits the embedded instance, and mounts it into the
  // page. Tears down on unmount / re-create so we never leak an iframe.
  useEffect(() => {
    if (!checkout) return
    let instance: EmbeddedCheckoutInstance | null = null
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
        instance = await stripe.initEmbeddedCheckout({ clientSecret: checkout.clientSecret })
        if (cancelled) { instance.destroy(); return }
        instance.mount('#embedded-checkout-mount')
        setFormMounted(true)
        // Bring the form into view (it mounts below the recap) so the customer
        // sees it immediately rather than appearing to have nothing happen.
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
      if (instance) { try { instance.destroy() } catch { /* already gone */ } }
    }
  }, [checkout])

  // Customer-accent brand ramp while this page is mounted (same trick
  // as CustomerProofPage), cleared on unmount.
  useEffect(() => {
    document.documentElement.classList.add('customer-accent')
    return () => document.documentElement.classList.remove('customer-accent')
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
    return (
      <Screen>
        <PanelShell className="max-w-md text-center">
          <Pill colour="in-stock">Paid</Pill>
          <h1 className="mt-3 text-lg font-semibold text-ink">Thank you — this order is paid</h1>
          <p className="mt-2 text-sm text-ink-soft">
            Your order {order.payment_reference ? `(${order.payment_reference})` : ''} has been paid and is now in production. We&rsquo;ll be in touch with dispatch details.
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
  // Step 5 webhook flips status to 'paid' in our DB.
  if (justPaid) {
    return (
      <Screen>
        <PanelShell className="max-w-md text-center">
          <Pill colour="in-stock">Payment received</Pill>
          <h1 className="mt-3 text-lg font-semibold text-ink">Thank you — payment received</h1>
          <p className="mt-2 text-sm text-ink-soft">
            We&rsquo;re confirming your payment{order.payment_reference ? ` (${order.payment_reference})` : ''} and will be in touch with the next steps. You can close this page.
          </p>
        </PanelShell>
      </Screen>
    )
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
    return round2(round2(cards + splitName + pers + finish) + shippingAmount)
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
      ? order.custom_quote_total + shippingAmount
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

  // ── Embedded checkout (wide) ──────────────────────────────────────
  // Once the customer has clicked through to payment, give Stripe's embedded
  // checkout a WIDE container so it renders its two-column layout (order
  // summary expanded on the left, payment on the right) instead of the cramped
  // single column + "View details" collapse it falls back to in a narrow box.
  if (canCheckout && checkout) {
    return (
      <div className="flex min-h-screen justify-center bg-canvas px-4 py-8">
        <div className="w-full max-w-4xl">
          <p className="eyebrow">Complete your order</p>
          <h1 className="mt-1 text-xl font-semibold text-ink">
            {company ? company : 'Your order'}
          </h1>
          <p className="mt-1 text-sm text-ink-soft">Reference {order.payment_reference}</p>
          <div ref={mountWrapRef} className="relative mt-6 min-h-[520px]">
            {!formMounted && (
              <div className="absolute inset-x-0 top-20 flex flex-col items-center gap-2 text-ink-mute">
                <div className="h-6 w-6 animate-spin rounded-full border-2 border-line border-t-ink" />
                <span className="text-sm">Loading secure payment…</span>
              </div>
            )}
            <div id="embedded-checkout-mount" />
          </div>
        </div>
      </div>
    )
  }

  // ── Payable (status 'sent') ───────────────────────────────────────
  return (
    <Screen>
      <PanelShell className="w-full max-w-lg">
        <p className="eyebrow">Complete your order</p>
        <h1 className="mt-1 text-xl font-semibold text-ink">
          {company ? company : 'Your order'}
        </h1>
        <p className="mt-1 text-sm text-ink-soft">
          Reference {order.payment_reference}
        </p>

        {/* Recap — large previews of the approved artwork + spec + the
            date it was approved, as a trust anchor before the customer
            commits to pay. Images keep their natural aspect ratio (no
            cropping). Hidden entirely if neither images nor spec loaded. */}
        {(thumbs.length > 0 || spec) && (
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
        )}

        <div className="mt-5 space-y-3 border-t border-line pt-5 text-sm">
          {isSplitOpen ? (
            <div className="space-y-2.5">
              <p className="text-ink-soft">Quantity for each person</p>
              {personNames.map((name) => (
                <div key={name} className="flex items-center justify-between gap-4">
                  <label htmlFor={`q-${name}`} className="truncate text-ink">{name}</label>
                  <input
                    id={`q-${name}`}
                    type="number"
                    min={1}
                    step={1}
                    inputMode="numeric"
                    value={personQty[name] ?? ''}
                    onChange={(e) => setPersonQty((prev) => ({ ...prev, [name]: e.target.value }))}
                    placeholder="0"
                    className="h-[38px] w-24 rounded-lg border border-line bg-surface px-3 text-right text-sm text-ink focus:border-[var(--c-brand)] focus:outline-2 focus:outline-offset-1 focus:outline-[var(--c-brand)]"
                  />
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
                <input
                  id="order-quantity"
                  type="number"
                  min={singleMin ?? 1}
                  max={singleMax ?? undefined}
                  step={1}
                  inputMode="numeric"
                  value={chosenQuantity ?? ''}
                  onChange={(e) => {
                    const n = parseInt(e.target.value, 10)
                    setChosenQuantity(Number.isFinite(n) && n > 0 ? n : null)
                  }}
                  placeholder={singleMin != null ? `${singleMin.toLocaleString()}+` : 'e.g. 250'}
                  className="h-[38px] w-28 rounded-lg border border-line bg-surface px-3 text-right text-sm text-ink focus:border-[var(--c-brand)] focus:outline-2 focus:outline-offset-1 focus:outline-[var(--c-brand)]"
                />
              </div>
              {singleMin != null && singleMax != null && (
                <p className="text-right text-[12px] text-ink-mute">
                  Any quantity from {singleMin.toLocaleString()} to {singleMax.toLocaleString()}.
                </p>
              )}
              {singleRangeHint && <p className="text-[13px] text-low">{singleRangeHint}</p>}
            </div>
          ) : (
            <Row
              label="Quantity"
              value={
                order.quantity != null
                  ? order.names_count > 1
                    ? `${order.quantity.toLocaleString()} cards in total`
                    : order.quantity.toLocaleString()
                  : 'You choose below'
              }
            />
          )}
          {order.names_count > 1 && !isSplitOpen && <Row label="People" value={String(order.names_count)} />}
          {order.has_personalisation && <Row label="Personalisation" value="Included" />}
          {/* Card subtotal — shown when the all-in total is deferred to Stripe
              (shipping-rated orders) so the card price is still visible. */}
          {shippingComputedAtCheckout && order.custom_quote_total == null && cardsSubtotal != null && (
            <Row label="Cards" value={formatPrice(cardsSubtotal, order.currency)} />
          )}
          <Row label={SHIPPING_LABEL[order.shipping_treatment]} value={
            order.shipping_treatment === 'free'
              ? 'Free'
              : order.shipping_charged != null
                ? formatPrice(order.shipping_charged, order.currency)
                : 'Calculated at checkout'
          } />
          {order.custom_quote_total != null && (
            <Row label="Agreed total" value={formatPrice(order.custom_quote_total, order.currency)} bold />
          )}
        </div>

        {/* Delivery destination — full_cost / goodwill orders rate the carriage
            against this. We ask here because we rarely know the postcode upfront. */}
        {canCheckout && shippingComputedAtCheckout && !checkout && (
          <div className="mt-5 space-y-2.5 border-t border-line pt-4 text-sm">
            <p className="font-medium text-ink">Where should we ship these?</p>
            <p className="text-[13px] text-ink-soft">
              So we can calculate shipping. You’ll confirm your full delivery address at the payment step.
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <select
                aria-label="Delivery country"
                value={destCountry}
                onChange={(e) => setDestCountry(e.target.value)}
                className="h-[38px] flex-1 rounded-lg border border-line bg-surface px-3 text-sm text-ink focus:border-[var(--c-brand)] focus:outline-2 focus:outline-offset-1 focus:outline-[var(--c-brand)]"
              >
                <option value="">Select country…</option>
                {SHIP_COUNTRIES.map((c) => (
                  <option key={c.code} value={c.code}>{c.name}</option>
                ))}
              </select>
              <input
                aria-label="Delivery postcode"
                value={destPostcode}
                onChange={(e) => setDestPostcode(e.target.value)}
                placeholder="Postcode / ZIP"
                className="h-[38px] flex-1 rounded-lg border border-line bg-surface px-3 text-sm text-ink focus:border-[var(--c-brand)] focus:outline-2 focus:outline-offset-1 focus:outline-[var(--c-brand)]"
              />
            </div>
          </div>
        )}

        {canCheckout ? (
          // ── Pay / continue to checkout ─────────────────────────────
          <div className="mt-6">
            {payTotal != null && (
              <>
                <div className="flex items-center justify-between border-t border-line pt-4 text-base">
                  <span className="font-semibold text-ink">Total to pay</span>
                  <span className="font-semibold text-ink">{formatPrice(payTotal, order.currency)}</span>
                </div>
                {order.currency === 'GBP' && (
                  <p className="mt-1 text-[12px] text-ink-mute">Includes VAT.</p>
                )}
              </>
            )}
            {payError && (
              <div className="mt-3 rounded-lg border border-out bg-out-soft px-3 py-2 text-[13px] text-out">{payError}</div>
            )}
            <button
              type="button"
              onClick={() => void startCheckout()}
              disabled={paying || awaitingQuantity || !destinationComplete}
              className="mt-4 inline-flex w-full items-center justify-center rounded-lg bg-ink px-5 py-3 text-sm font-semibold text-on-ink transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {paying
                ? 'Loading secure payment…'
                : awaitingQuantity
                  ? 'Choose a quantity to continue'
                  : !destinationComplete
                    ? 'Enter delivery country & postcode'
                    : payTotal != null
                      ? `Continue to payment — ${formatPrice(payTotal, order.currency)}`
                      : 'Continue to payment'}
            </button>
            <p className="mt-2 text-center text-[12px] text-ink-mute">
              {awaitingQuantity
                ? 'Select a quantity above to see your total.'
                : !destinationComplete
                  ? 'Enter where we’re shipping to so we can calculate shipping.'
                  : payTotal == null
                    ? 'A secure card form will open below to enter your card and delivery details, where you’ll see the full price including VAT.'
                    : 'A secure card form will open below to enter your card and delivery details.'}
            </p>
          </div>
        ) : (
          // Grid-priced / engine-shipping orders — the next increment.
          <div className="mt-6 rounded-xl border border-dashed border-line bg-canvas p-4 text-center">
            <p className="text-sm font-medium text-ink">Online payment for this order is being set up</p>
            <p className="mt-1 text-[13px] text-ink-soft">
              Please reply to the email you received and we&rsquo;ll confirm the price and send you a secure payment link.
            </p>
          </div>
        )}

        {/* Link validity — let the customer know it isn't open-ended. */}
        {order.expires_at && (
          <p className="mt-4 text-center text-[12px] text-ink-mute">
            This payment link is valid until {formatApprovedDate(order.expires_at)}. After that, just reply to your email and we&rsquo;ll send a fresh one.
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
    <div className="flex min-h-screen items-center justify-center bg-canvas p-4">
      {children}
    </div>
  )
}
