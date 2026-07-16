import { useEffect, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { formatPrice } from '../lib/currency'
import { getPublicSettings } from '../lib/publicSettings'
import { PanelShell, Pill } from '../design'
import { CustomerHeader } from '../components/CustomerHeader'
import { FinishChoiceCard } from '../components/FinishChoiceCard'
import { ArtworkFade, buildRecapTiles } from '../components/ArtworkFade'
import { LoadingProofAnimation } from '../components/LoadingProofAnimation'
import { exVat, isGbpOrderVatFree, normaliseShipDestination } from '../lib/ukVatArea'
import { totalFromTiers, surchargeFromTiers, thicknessNoteFor, type SpecVariantChoice, type SpecFinishChoice } from '../lib/openSpecTiers'
import { pricesFlatAboveTopTier, MAX_ONLINE_FLAT_QUANTITY } from '../lib/quote/interpolation'
import { hasThicknessGuide, thicknessSetForMaterial, type ThicknessOption } from '../lib/metalThicknessNotes'
import { finishIsPreferenceOnly } from '../lib/materialTraits'
import { SHIP_COUNTRIES } from '../lib/shipCountries'
import { loadStripeJs, type StripeLike, type StripeElementsLike } from '../lib/stripeJs'
import type { GridImage } from '../components/ImageGrid'
import type { Currency, CustomerProofGraph } from '../lib/types'

// Combined-payment pay page (bundle orders Slice 2, docs/bundle-orders-spec.md
// §13): /order/group/:id?token=… — ONE page covering every order in a payment
// group. One line per card, one combined shipping figure, one US-tariff line
// where relevant, one total, ONE payment.
//
// Members whose spec the designer left open (thickness_open / finish_open /
// quantity_open, 000298/000302) get the SAME guided choosers as a
// single-order pay link — quantity first, then thickness cards, then finish
// cards, forced-choice with no pre-selection — one "Confirm your …" section
// per open card. Picks are sent to create-checkout-session's group mode as
// member_choices, priced server-side with the single-order maths, and
// persisted onto each member order. Locked members stay read-only priced
// lines. All money figures the customer PAYS come from the server; the
// in-page figures mirror its maths (shared tier helpers) so what's shown
// equals what's charged.
//
// Anonymous + tokenised via public_get_order_group (migration 000309) — the
// same house posture as the single pay page.

interface GroupPayload {
  id: string
  status: 'sent' | 'paid' | 'cancelled'
  currency: Currency
  shipping_treatment: 'full_cost' | 'goodwill' | 'free' | 'manual'
  shipping_charged: number | null
  ship_dest_country: string | null
  ship_dest_postcode: string | null
  vat_treatment: string | null
  amount_shipping: number | null
  amount_us_tariff: number | null
  us_tariff_opted_out: boolean
  payment_reference: string | null
  expires_at: string | null
  paid_at: string | null
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

// Member order — the slice of the row the page renders. order_spec_snapshot
// (frozen at order creation) labels each card without extra queries; the
// open-spec flags + persisted picks drive the per-member choosers.
interface GroupMemberPayload {
  id: string
  proof_id: string
  status: string
  quantity: number | null
  person_quantities: { name: string; quantity: number }[] | null
  names_count: number
  has_personalisation: boolean
  custom_quote_total: number | null
  material_id: string | null
  material_variant_id: string | null
  material_option_id: string | null
  thickness_open: boolean
  finish_open: boolean
  quantity_open: boolean
  card_discount_type: string | null
  card_discount_value: number | null
  amount_cards: number | null
  amount_tooling: number | null
  amount_personalisation: number | null
  amount_card_discount: number | null
  payment_reference: string | null
  order_kind: string | null
  order_spec_snapshot: {
    material?: { display_name?: string | null } | null
    variant?: { display_name?: string | null } | null
    finish?: { display_name?: string | null } | null
    quantity?: number | null
  } | null
}

interface GroupGraph {
  group: GroupPayload
  orders: GroupMemberPayload[]
  company_name: string | null
}

// Per-card price line returned by the group checkout (server-computed).
interface CheckoutMemberLine {
  order_id: string
  payment_reference: string | null
  label: string
  quantity: number | null
  goods: number
  card_discount: number
}

// Chooser catalogue for one OPEN member, loaded from its proof graph
// (public_get_customer_proof) — the same sources the single pay page uses.
interface MemberChooserData {
  materialName: string | null
  specVariants: SpecVariantChoice[]
  specFinishes: SpecFinishChoice[]
  // Tiers for a LOCKED variant (open quantity only) — the price basis when
  // there's no thickness chooser.
  lockedTiers: { quantity: number; total_price: number }[]
  // Surcharge schedule for a LOCKED non-base finish.
  lockedFinishSurTiers: { quantity: number; surcharge: number }[]
  // Finish tab code of a LOCKED finish, so the artwork preview shows the
  // finish the designer pinned (mirror of the single page's lockedFinishCode).
  lockedFinishCode: string | null
  thicknessNotes: ThicknessOption[]
  flatAboveTop: boolean
  perExtraName: number | null
  personNames: string[]
  personalisation: { perCardRate: number; minCharge: number } | null
  // The member's own approved artwork (current version, QRs excluded, sort
  // order) — drives the per-card preview that cross-fades with the finish
  // pick, exactly like the single-order checkout.
  versionImages: GridImage[]
}

// The customer's in-progress picks for one open member.
interface MemberPick {
  variantId: string | null
  optionId: string | null
  qty: string
  personQty: Record<string, string>
}

const SHIPPING_LABEL: Record<GroupPayload['shipping_treatment'], string> = {
  full_cost: 'Combined shipping',
  goodwill: 'Shipping (partly covered by us)',
  free: 'Free shipping',
  manual: 'Shipping',
}

const round2 = (n: number) => Math.round(n * 100) / 100

// Does this member still need customer input before it can be priced?
// Openness is always the flag (000302); the quantity == null arm is the
// defensive mirror of the single page's legacy-row handling.
function memberIsOpen(m: GroupMemberPayload): boolean {
  if (m.custom_quote_total != null) return false
  return m.thickness_open || m.finish_open || m.quantity_open || m.quantity == null
}

function memberQuantityOpen(m: GroupMemberPayload): boolean {
  return m.custom_quote_total == null && (m.quantity_open === true || m.quantity == null)
}

// Human label for a member card: "500 × Stainless Steel 500µm — Mirror" from
// the frozen spec snapshot, degrading gracefully to the payment reference.
function memberLabel(m: GroupMemberPayload): string {
  const snap = m.order_spec_snapshot
  const material = snap?.material?.display_name ?? null
  const variant = snap?.variant?.display_name ?? null
  const finish = snap?.finish?.display_name ?? null
  const qty = m.quantity ?? snap?.quantity ?? null
  const name = material
    ? `${material}${variant && variant !== material ? ` ${variant}` : ''}${finish ? ` — ${finish}` : ''}`
    : m.order_kind === 'prototype'
      ? 'Prototype sample'
      : `Card order${m.payment_reference ? ` ${m.payment_reference}` : ''}`
  if (m.order_kind === 'prototype' && material) return `${name} — prototype sample`
  return qty != null ? `${qty.toLocaleString()} × ${name}` : name
}

// A member's goods figure from its stamped breakdown (set by the group
// checkout; null components → 0). Custom quotes carry their agreed figure.
function memberGoods(m: GroupMemberPayload): number {
  if (m.custom_quote_total != null) return Number(m.custom_quote_total)
  return Number(m.amount_cards ?? 0) + Number(m.amount_tooling ?? 0) + Number(m.amount_personalisation ?? 0)
}

// Designer per-order discount, mirroring the server's resolveCardDiscount
// EXACTLY (percent-or-fixed on the member's goods base — cards + finish +
// tooling + personalisation, or the custom-quote figure — capped at the base).
function cardDiscountForBase(type: string | null, value: number | null, base: number): number {
  if (type !== 'percent' && type !== 'fixed') return 0
  const v = Number(value)
  if (!Number.isFinite(v) || v <= 0) return 0
  const b = Number.isFinite(base) && base > 0 ? base : 0
  if (b <= 0) return 0
  const raw = type === 'percent' ? b * (v / 100) : v
  return round2(Math.min(Math.max(raw, 0), b))
}

export default function OrderGroupPayPage() {
  const { id } = useParams<{ id: string }>()
  const [params] = useSearchParams()
  const token = params.get('token')
  const justPaid = params.get('paid') === '1'

  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [group, setGroup] = useState<GroupPayload | null>(null)
  const [members, setMembers] = useState<GroupMemberPayload[]>([])
  const [company, setCompany] = useState<string | null>(null)

  // Per-member chooser catalogues + the customer's picks, keyed by order id.
  // Only open members get entries; locked members never touch these.
  const [chooserData, setChooserData] = useState<Record<string, MemberChooserData>>({})
  const [picks, setPicks] = useState<Record<string, MemberPick>>({})

  // Delivery destination for full_cost / goodwill rating (pre-filled from the
  // designer's hint; the customer confirms + adds the postcode).
  const [destCountry, setDestCountry] = useState('')
  const [destPostcode, setDestPostcode] = useState('')

  // US tariff & customs handling (same copy + fee source as the single page).
  const [tariff, setTariff] = useState<{ intro: string; warning: string; fees: Record<Currency, number> } | null>(null)
  const [tariffOptedOut, setTariffOptedOut] = useState(false)
  const [tariffConfirmingOptOut, setTariffConfirmingOptOut] = useState(false)

  const [paying, setPaying] = useState(false)
  const [payError, setPayError] = useState<string | null>(null)
  const [checkout, setCheckout] = useState<{
    clientSecret: string
    pk: string
    amount: number
    currency: Currency
    vatFree: boolean
    members: CheckoutMemberLine[]
    breakdown: { goods: number; card_discount: number; shipping: number; us_tariff: number }
  } | null>(null)
  const [formMounted, setFormMounted] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [vat, setVat] = useState<{ state: 'loading' | 'ready' | 'pending' | 'unavailable'; url?: string } | null>(null)
  const mountWrapRef = useRef<HTMLDivElement | null>(null)
  const stripeRef = useRef<StripeLike | null>(null)
  const elementsRef = useRef<StripeElementsLike | null>(null)
  const emailRef = useRef<string>('')

  // Customer-accent brand ramp while mounted (same as the single pay page).
  useEffect(() => {
    document.documentElement.classList.add('customer-accent')
    return () => document.documentElement.classList.remove('customer-accent')
  }, [])

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
      const { data, error } = await supabase.rpc('public_get_order_group', {
        p_group_id: id,
        p_token: token,
      })
      if (cancelled) return
      if (error || data == null) {
        setNotFound(true)
        setLoading(false)
        return
      }
      const g = data as unknown as GroupGraph
      setGroup(g.group)
      setMembers(g.orders ?? [])
      setCompany(g.company_name?.trim() || null)
      if (g.group.ship_dest_country) setDestCountry(g.group.ship_dest_country)
      if (g.group.ship_dest_postcode) setDestPostcode(g.group.ship_dest_postcode)
      if (g.group.us_tariff_opted_out) setTariffOptedOut(true)
      // Most-recent open stamp, delayed so an email scanner that fetches the
      // link without running JS doesn't log a false open (mirror of the
      // single page's record_order_pay_link_opened call).
      if (g.group.status === 'sent') {
        setTimeout(() => {
          if (cancelled) return
          void supabase
            .rpc('record_order_group_pay_link_opened', { p_group_id: id, p_token: token })
            .then(({ error: e }) => { if (e) console.error('[OrderGroupPayPage] record open failed:', e.message) })
        }, 1500)
      }
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [id, token])

  // Catalogues for EVERY member — the same sources the single pay page reads:
  // the proof graph (variants + tiers + finishes + surcharges + personalisation
  // + names), the admin thickness copy, and (open members only) the member's
  // own artwork for finish swatches. Open members drive the choosers; locked
  // members need the price bases too, because online orders don't stamp
  // amount_cards until checkout — so their summary price is computed live from
  // the catalogue rather than read from a still-null stamped figure. Failure on
  // one member leaves it unpriced (the page shows the reply-to-us hint rather
  // than a dead card); it never blocks the rest.
  useEffect(() => {
    if (members.length === 0 || !group) return
    let cancelled = false
    void (async () => {
      const settings = await getPublicSettings().catch(() => null)
      await Promise.all(members.map(async (m) => {
        try {
          const { data: graph } = await supabase.rpc('public_get_customer_proof', { p_proof_id: m.proof_id })
          if (cancelled || !graph) return
          const g = graph as CustomerProofGraph
          const current = g.versions?.find((v) => v.is_current) ?? g.versions?.[g.versions.length - 1] ?? null
          if (!current) return
          const currency = group.currency

          const tiersFor = (variantId: string) =>
            (g.price_tiers ?? [])
              .filter((t) => t.material_variant_id === variantId && t.currency === currency)
              .map((t) => ({ quantity: t.quantity, total_price: Number(t.total_price) }))
              .sort((a, b) => a.quantity - b.quantity)
          const surTiersFor = (optionId: string) =>
            (g.material_option_surcharges ?? [])
              .filter((s) => s.material_option_id === optionId && s.currency === currency)
              .map((s) => ({ quantity: s.quantity, surcharge: Number(s.surcharge) }))
              .sort((a, b) => a.quantity - b.quantity)

          // Thickness chooser: every priced variant of the member's material,
          // catalogue order — the set the proof's pricing grid showed.
          let specVariants: SpecVariantChoice[] = []
          if (m.thickness_open && m.material_id) {
            specVariants = (g.material_variants ?? [])
              .filter((mv) => mv.material_id === m.material_id)
              .sort((a, b) => a.sort_order - b.sort_order)
              .map((mv) => ({ id: mv.id, display_name: mv.display_name, tiers: tiersFor(mv.id) }))
              .filter((mv) => mv.tiers.length > 0)
          }

          // Finish chooser: the finishes the approved version actually offered
          // (its 2+ tabs); preference-only materials (gloss/matte, 000303)
          // offer the whole catalogue since artwork is identical either way.
          let specFinishes: SpecFinishChoice[] = []
          if (m.finish_open && m.material_id) {
            const offeredCodes = finishIsPreferenceOnly(current.material_code)
              ? new Set<string>()
              : new Set(current.material_options ?? [])
            specFinishes = (g.material_options ?? [])
              .filter((mo) => mo.material_id === m.material_id)
              .filter((mo) => offeredCodes.size === 0 || offeredCodes.has(mo.code))
              .sort((a, b) => a.sort_order - b.sort_order)
              .map((mo) => ({
                id: mo.id,
                code: mo.code,
                display_name: mo.display_name,
                is_base: mo.is_base,
                surTiers: surTiersFor(mo.id),
                photoUrl: mo.photo_url ?? null,
                swatchUrl: null,
                description: mo.description ?? null,
              }))
          }

          // Locked-side price bases for members where only SOME dimensions
          // are open (e.g. open quantity on a locked thickness).
          const lockedTiers = !m.thickness_open && m.material_variant_id ? tiersFor(m.material_variant_id) : []
          let lockedFinishSurTiers: { quantity: number; surcharge: number }[] = []
          let lockedFinishCode: string | null = null
          if (!m.finish_open && m.material_option_id) {
            const opt = (g.material_options ?? []).find((mo) => mo.id === m.material_option_id)
            if (opt) {
              lockedFinishCode = opt.code
              if (!opt.is_base) lockedFinishSurTiers = surTiersFor(opt.id)
            }
          }

          const thicknessNotes =
            m.thickness_open && settings && hasThicknessGuide(current.material_code)
              ? thicknessSetForMaterial(settings.metal_thickness_notes, current.material_code)
              : []

          const data: MemberChooserData = {
            materialName: m.order_spec_snapshot?.material?.display_name ?? current.material_display ?? null,
            specVariants,
            specFinishes,
            lockedTiers,
            lockedFinishSurTiers,
            lockedFinishCode,
            thicknessNotes,
            flatAboveTop: pricesFlatAboveTopTier(current.material_code),
            perExtraName: current.split_name_surcharge_snapshot ?? null,
            personNames: current.names ?? [],
            personalisation: m.has_personalisation
              ? (() => {
                  const p = g.personalisation_pricing?.[currency]
                  return p ? { perCardRate: Number(p.per_card_rate), minCharge: Number(p.min_charge) } : null
                })()
              : null,
            versionImages: [],
          }
          if (cancelled) return
          setChooserData((prev) => ({ ...prev, [m.id]: data }))
          // Pre-fill from picks a previous checkout call persisted, so a
          // returning customer sees (and can change) their earlier choice.
          setPicks((prev) => ({
            ...prev,
            [m.id]: prev[m.id] ?? {
              variantId:
                m.material_variant_id && specVariants.some((v) => v.id === m.material_variant_id)
                  ? m.material_variant_id
                  : null,
              optionId:
                m.material_option_id && specFinishes.some((f) => f.id === m.material_option_id)
                  ? m.material_option_id
                  : null,
              qty: memberQuantityOpen(m) && m.quantity != null ? String(m.quantity) : '',
              personQty:
                memberQuantityOpen(m) && Array.isArray(m.person_quantities)
                  ? Object.fromEntries(m.person_quantities.map((p) => [p.name, String(p.quantity)]))
                  : {},
            },
          }))

          // Locked members show no chooser or finish swatches — the price
          // bases above are all they need, so skip the artwork fetch.
          if (!memberIsOpen(m)) return

          // The member's own artwork: the per-card preview (cross-fading with
          // the finish pick, exactly like the single-order checkout) plus the
          // finish-card swatches (front-preferred, per finish tab) — honest
          // visuals when there's no studio photo.
          try {
            const { data: imgData } = await supabase.functions.invoke<{ images: GridImage[] }>(
              'customer-proof-images',
              { body: { proofId: m.proof_id } },
            )
            if (cancelled || !imgData?.images) return
            const versionImgs = imgData.images
              .filter((img) => (img as unknown as { proof_version_id: string }).proof_version_id === current.id)
              .filter((img) => img.is_qr_code !== true)
              .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
            const byOption = new Map<string, string>()
            for (const img of versionImgs) {
              const code = img.material_option
              if (!code || !img.signed_url) continue
              if (!byOption.has(code) || img.side === 'front') byOption.set(code, img.signed_url)
            }
            setChooserData((prev) => {
              const d = prev[m.id]
              if (!d) return prev
              return {
                ...prev,
                [m.id]: {
                  ...d,
                  versionImages: versionImgs,
                  specFinishes: d.specFinishes.map((f) => ({ ...f, swatchUrl: byOption.get(f.code) ?? null })),
                },
              }
            })
          } catch {
            // ignore — the preview is absent and finish cards render with
            // studio photos or text-only
          }
        } catch {
          // ignore — this member's chooser stays unloaded
        }
      }))
    })()
    return () => { cancelled = true }
  }, [members, group])

  // Self-serve VAT invoice for the paid screen — the group's ONE invoice,
  // via order-vat-invoice's group mode. Poll briefly right after payment so
  // the link appears as soon as Xero settles it.
  useEffect(() => {
    if (!group || !id || !token) return
    if (group.status !== 'paid' && !justPaid) return
    let cancelled = false
    let attempts = 0
    const MAX_ATTEMPTS = justPaid ? 4 : 1
    setVat({ state: 'loading' })
    function poll() {
      void supabase.functions
        .invoke<{ ready?: boolean; url?: string; reason?: string }>('order-vat-invoice', {
          body: { group_id: id, token },
        })
        .then(({ data }) => {
          if (cancelled) return
          if (data?.ready && data.url) {
            setVat({ state: 'ready', url: data.url })
            return
          }
          const reason = data?.reason ?? 'pending'
          if (reason === 'invoice_failed' || reason === 'xero_unavailable' || reason === 'xero_error') {
            setVat({ state: 'unavailable' })
            return
          }
          attempts++
          setVat({ state: 'pending' })
          if (attempts < MAX_ATTEMPTS) {
            window.setTimeout(() => { if (!cancelled) poll() }, 5000)
          }
        })
        .catch(() => { if (!cancelled) setVat({ state: 'pending' }) })
    }
    poll()
    return () => { cancelled = true }
  }, [group, id, token, justPaid])

  async function startCheckout() {
    if (!group || !id || !token) return
    setPayError(null)
    setPaying(true)
    // Per-member picks for open-spec members — same field vocabulary as the
    // single-order body; the server validates + persists each one.
    const memberChoicesPayload = members.filter(memberIsOpen).map((m) => {
      const pick = picks[m.id]
      const data = chooserData[m.id]
      const names = data?.personNames ?? []
      const split =
        memberQuantityOpen(m) && names.length > 1
          ? names
              .map((n) => ({ name: n, quantity: parseInt(pick?.personQty[n] ?? '', 10) }))
              .filter((p) => Number.isFinite(p.quantity) && p.quantity > 0)
          : []
      const single = memberQuantityOpen(m) && names.length <= 1 ? parseInt(pick?.qty ?? '', 10) : NaN
      return {
        order_id: m.id,
        quantity: Number.isFinite(single) && single > 0 ? single : undefined,
        person_quantities: split.length > 0 ? split : undefined,
        material_variant_id: m.thickness_open && pick?.variantId ? pick.variantId : undefined,
        material_option_id: m.finish_open && pick?.optionId ? pick.optionId : undefined,
      }
    })
    try {
      const { data, error } = await supabase.functions.invoke<{
        client_secret?: string
        publishable_key?: string
        amount?: number
        currency?: Currency
        vat_free?: boolean
        members?: CheckoutMemberLine[]
        breakdown?: { goods: number; card_discount: number; shipping: number; us_tariff: number }
        error?: string
        message?: string
      }>('create-checkout-session', {
        body: {
          group_id: id,
          token,
          origin: window.location.origin,
          member_choices: memberChoicesPayload.length > 0 ? memberChoicesPayload : undefined,
          ship_dest_country: destCountry || undefined,
          ship_dest_postcode: destPostcode.trim() || undefined,
          us_tariff_opted_out: tariffOptedOut,
        },
      })
      if (error || !data || data.error || !data.client_secret || !data.publishable_key || data.amount == null || !data.currency) {
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
      setCheckout({
        clientSecret: data.client_secret,
        pk: data.publishable_key,
        amount: data.amount,
        currency: data.currency,
        vatFree: data.vat_free === true,
        members: data.members ?? [],
        breakdown: data.breakdown ?? { goods: data.amount, card_discount: 0, shipping: 0, us_tariff: 0 },
      })
    } catch {
      setPayError('We couldn’t start checkout. Please reply to the email you received and we’ll help.')
      setPaying(false)
    }
  }

  // Mount Stripe Elements once the PaymentIntent exists — identical flow to
  // the single pay page (shared loader, same three elements, same
  // receipt_email capture via the Link element).
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
        linkAuth.on?.('change', (e) => { emailRef.current = e?.value?.email ?? '' })
        linkAuth.mount('#link-auth')
        // Phone is required — same as the single pay page: the courier needs a
        // recipient contact number, persisted by the webhook as ship_to_phone
        // on the group and every member order.
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

  async function confirmPay() {
    if (!stripeRef.current || !elementsRef.current || !id || !token) return
    setSubmitting(true)
    setFormError(null)
    const { error } = await stripeRef.current.confirmPayment({
      elements: elementsRef.current,
      confirmParams: {
        return_url: `${window.location.origin}/order/group/${id}?token=${encodeURIComponent(token)}&paid=1`,
        ...(emailRef.current ? { receipt_email: emailRef.current } : {}),
      },
    })
    if (error) {
      setFormError(error.message ?? 'Your payment couldn’t be completed. Please check your details and try again.')
      setSubmitting(false)
    }
  }

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
    return (
      <p className="mt-4 text-[13px] text-ink-mute">
        We&rsquo;ll email your VAT invoice shortly. If it hasn&rsquo;t arrived, just reply to your order email and we&rsquo;ll send it straight over.
      </p>
    )
  }

  // Paid / just-paid confirmation: one paid summary with a line per card,
  // the combined shipping + tariff, the delivery address and the ONE VAT
  // invoice. `confirmed` distinguishes the webhook-flipped state from the
  // optimistic ?paid=1 moment, exactly like the single page.
  function renderConfirmation(confirmed: boolean, g: GroupPayload) {
    const shipping = Number(g.amount_shipping ?? 0)
    const usTariff = Number(g.amount_us_tariff ?? 0)
    const goods = members.reduce((acc, m) => acc + memberGoods(m), 0)
    const discount = members.reduce((acc, m) => acc + Number(m.amount_card_discount ?? 0), 0)
    const total = round2(goods - discount + shipping + usTariff)
    const vatFreeGroup =
      g.currency === 'GBP' &&
      isGbpOrderVatFree(g.vat_treatment ?? null, normaliseShipDestination(g.ship_dest_country ?? '', g.ship_to_address?.postal_code ?? ''))
    const addr = g.ship_to_address
    const haveAddress = confirmed && !!addr && !!(addr.line1 || addr.postal_code)
    const addressLine = addr
      ? [addr.line1, addr.line2, addr.city, addr.region, addr.postal_code, addr.country].filter(Boolean).join(', ')
      : ''
    const isImmediate = !confirmed || justPaid
    return (
      <div className="min-h-screen bg-canvas">
        <CustomerHeader innerClassName="max-w-4xl" />
        <div className="mx-auto max-w-4xl px-gutter py-8">
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
          {g.payment_reference && (
            <p className="mt-0.5 text-sm text-ink-soft">Reference {g.payment_reference}</p>
          )}

          <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
            <PanelShell className="self-start">
              <p className="text-[11px] font-medium uppercase tracking-wide text-ink-mute">
                Order summary — {members.length} {members.length === 1 ? 'item' : 'items'}, one payment
              </p>
              <div className="mt-4 space-y-2 text-sm">
                {members.map((m) => (
                  <div key={m.id} className="space-y-1 border-b border-line-soft pb-2 last:border-b-0 last:pb-0">
                    <Row label={memberLabel(m)} value={formatPrice(memberGoods(m), g.currency)} />
                    {Number(m.amount_card_discount ?? 0) > 0 && (
                      <Row label="Discount" value={formatPrice(-Number(m.amount_card_discount), g.currency)} />
                    )}
                  </div>
                ))}
                <Row
                  label={SHIPPING_LABEL[g.shipping_treatment]}
                  value={shipping > 0 ? formatPrice(shipping, g.currency) : 'Free'}
                />
                {usTariff > 0 && <Row label="US tariff & customs handling" value={formatPrice(usTariff, g.currency)} />}
                <div className="flex items-center justify-between gap-4 border-t border-line pt-2.5 text-base">
                  <span className="font-semibold text-ink">{confirmed ? 'Total paid' : 'Total'}</span>
                  <span className="font-semibold text-ink">{formatPrice(total, g.currency)}</span>
                </div>
                {g.currency === 'GBP' && (
                  <p className="text-[12px] text-ink-mute">
                    {vatFreeGroup ? 'VAT-free — delivered outside the UK VAT area (zero-rated export).' : 'Includes VAT.'}
                  </p>
                )}
              </div>
            </PanelShell>

            <PanelShell className="self-start">
              {isImmediate && (
                <div className="text-sm text-ink-soft">
                  <p className="font-medium text-ink">What happens next</p>
                  {confirmed ? (
                    <ul className="mt-2 list-disc space-y-1.5 pl-5">
                      <li>We&rsquo;ve got your order and we&rsquo;re getting started on every item.</li>
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
              {haveAddress && (
                <div className={`text-sm ${isImmediate ? 'mt-5 border-t border-line pt-5' : ''}`}>
                  <p className="text-[11px] font-medium uppercase tracking-wide text-ink-mute">Shipping to</p>
                  <p className="mt-1 text-ink">
                    {g.ship_to_name && (<>{g.ship_to_name}<br /></>)}
                    {addressLine}
                  </p>
                </div>
              )}
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

  if (notFound || !group) {
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

  if (group.status === 'paid') return renderConfirmation(true, group)

  if (group.status === 'cancelled') {
    return (
      <Screen>
        <PanelShell className="max-w-md text-center">
          <h1 className="text-lg font-semibold text-ink">This payment link is no longer active</h1>
          <p className="mt-2 text-sm text-ink-soft">
            The items on this link have changed. Please reply to the email you received and we&rsquo;ll send you an up-to-date one.
          </p>
        </PanelShell>
      </Screen>
    )
  }

  const isExpired = group.expires_at != null && new Date(group.expires_at).getTime() < Date.now()
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

  if (justPaid) return renderConfirmation(false, group)

  // ── Payable ────────────────────────────────────────────────────────
  const shippingComputedAtCheckout =
    group.shipping_treatment === 'full_cost' || group.shipping_treatment === 'goodwill'
  const destinationComplete = !shippingComputedAtCheckout || (!!destCountry && !!destPostcode.trim())
  const effectiveDestCountry = normaliseShipDestination(
    shippingComputedAtCheckout ? destCountry : group.ship_dest_country ?? '',
    shippingComputedAtCheckout ? destPostcode : '',
  )
  const tariffFee = tariff ? tariff.fees[group.currency] ?? 0 : 0
  const tariffApplies = effectiveDestCountry === 'US' && tariffFee > 0
  // GBP prices are VAT-inclusive; a delivery outside the UK VAT area (or a
  // forced export) strips VAT off every pricing input BEFORE the tier maths,
  // exactly as the server does.
  const vatRelief = group.currency === 'GBP' && isGbpOrderVatFree(group.vat_treatment ?? null, effectiveDestCountry)
  const exv = (n: number) => (vatRelief ? exVat(n) : n)
  const exvTiers = (ts: { quantity: number; total_price: number }[]) =>
    vatRelief ? ts.map((t) => ({ ...t, total_price: exVat(t.total_price) })) : ts
  const exvSurTiers = (ts: { quantity: number; surcharge: number }[]) =>
    vatRelief ? ts.map((t) => ({ ...t, surcharge: exVat(t.surcharge) })) : ts
  const vatCaption =
    group.currency === 'GBP'
      ? vatRelief
        ? 'VAT-free — Channel Islands orders are outside UK VAT.'
        : 'Includes VAT.'
      : null

  // ── Live per-member pricing (open members) ─────────────────────────
  // Mirrors the server's member maths so the shown line equals the charge:
  // cards (tier total, interpolated) + finish surcharge + split-name tooling
  // + personalisation − designer discount. Locked members show their stamped
  // figures (a returning visitor) or wait for checkout.
  interface MemberLive {
    open: boolean
    ready: boolean          // every open dimension picked + priceable
    goods: number | null    // cards + finish + tooling + personalisation
    discount: number
    qty: number | null
    hint: string | null     // range problem worth explaining
    label: string
  }
  const memberLive = new Map<string, MemberLive>()
  for (const m of members) {
    if (!memberIsOpen(m)) {
      // A fully-locked member is priced live from the catalogue — the same
      // maths the single pay page and the group checkout use — because online
      // orders don't stamp amount_cards until checkout, so a first-time visitor
      // has no stamped figure to read (only offline orders and returning
      // visitors do). Custom quotes carry their agreed face-value total; fall
      // back to any stamped breakdown when the catalogue can't price it live.
      const data = chooserData[m.id]
      const lockedQty = m.quantity
      let goods: number | null = null
      let discount = 0
      if (m.custom_quote_total != null) {
        goods = Number(m.custom_quote_total)
        discount = cardDiscountForBase(m.card_discount_type, m.card_discount_value, goods)
      } else if (data && lockedQty != null && data.lockedTiers.length > 0) {
        const cards = totalFromTiers(exvTiers(data.lockedTiers), lockedQty, data.flatAboveTop)
        if (cards != null) {
          const finish = surchargeFromTiers(exvSurTiers(data.lockedFinishSurTiers), lockedQty, data.flatAboveTop)
          const tooling =
            data.perExtraName != null && m.names_count > 1 ? round2((m.names_count - 1) * exv(data.perExtraName)) : 0
          const pers = data.personalisation
            ? Math.max(exv(data.personalisation.minCharge), lockedQty * exv(data.personalisation.perCardRate))
            : 0
          goods = round2(cards + finish + tooling + pers)
          discount = cardDiscountForBase(m.card_discount_type, m.card_discount_value, goods)
        }
      }
      if (goods == null) {
        const stamped = memberGoods(m)
        goods = stamped > 0 ? stamped : null
        discount = Number(m.amount_card_discount ?? 0)
      }
      memberLive.set(m.id, {
        open: false,
        ready: true,
        goods,
        discount,
        qty: m.quantity,
        hint: null,
        label: memberLabel(m),
      })
      continue
    }
    const data = chooserData[m.id]
    const pick = picks[m.id]
    if (!data || !pick) {
      // Catalogue still loading (or failed) — not ready, no figure.
      memberLive.set(m.id, { open: true, ready: false, goods: null, discount: 0, qty: null, hint: null, label: memberLabel(m) })
      continue
    }
    const qtyOpen = memberQuantityOpen(m)
    const isSplit = qtyOpen && data.personNames.length > 1
    // Quantity: open → live inputs (split sum or single figure); locked → stored.
    let qty: number | null = null
    let splitComplete = true
    if (!qtyOpen) {
      qty = m.quantity
    } else if (isSplit) {
      const parsed = data.personNames.map((n) => {
        const v = parseInt(pick.personQty[n] ?? '', 10)
        return Number.isFinite(v) && v > 0 ? v : 0
      })
      splitComplete = parsed.every((q) => q >= 1)
      qty = splitComplete ? parsed.reduce((a, b) => a + b, 0) : null
    } else {
      const v = parseInt(pick.qty, 10)
      qty = Number.isFinite(v) && v > 0 ? v : null
    }
    // Price basis tiers: chosen/locked thickness.
    const activeTiers = m.thickness_open
      ? (pick.variantId ? data.specVariants.find((v) => v.id === pick.variantId)?.tiers ?? [] : [])
      : data.lockedTiers
    const activeSurTiers = m.finish_open
      ? (() => {
          const f = pick.optionId ? data.specFinishes.find((x) => x.id === pick.optionId) : null
          return f && !f.is_base ? f.surTiers : []
        })()
      : data.lockedFinishSurTiers
    const specPicked =
      (!m.thickness_open || pick.variantId != null) && (!m.finish_open || pick.optionId != null)
    const cards =
      qty != null && activeTiers.length > 0 ? totalFromTiers(exvTiers(activeTiers), qty, data.flatAboveTop) : null
    const finish = qty != null ? surchargeFromTiers(exvSurTiers(activeSurTiers), qty, data.flatAboveTop) : 0
    const tooling =
      data.perExtraName != null && m.names_count > 1 ? round2((m.names_count - 1) * exv(data.perExtraName)) : 0
    const pers =
      qty != null && data.personalisation
        ? Math.max(exv(data.personalisation.minCharge), qty * exv(data.personalisation.perCardRate))
        : 0
    const overCap = qty != null && data.flatAboveTop && qty > MAX_ONLINE_FLAT_QUANTITY
    const goods = specPicked && qty != null && cards != null && !overCap ? round2(cards + finish + tooling + pers) : null
    // Discount base = the member's goods figure — the same number shown as the
    // item line — matching the group checkout's server computation.
    const discount = goods != null ? cardDiscountForBase(m.card_discount_type, m.card_discount_value, goods) : 0
    // Range hint once the quantity is entered but can't be priced.
    const bounds = activeTiers.length > 0 ? activeTiers : data.specVariants.flatMap((v) => v.tiers)
    const qmin = bounds.length > 0 ? Math.min(...bounds.map((t) => t.quantity)) : null
    const qmax = bounds.length > 0
      ? (data.flatAboveTop ? MAX_ONLINE_FLAT_QUANTITY : Math.max(...bounds.map((t) => t.quantity)))
      : null
    let hint: string | null = null
    if (qty != null && (overCap || (activeTiers.length > 0 && cards == null))) {
      if (qmin != null && qty < qmin) hint = `Our minimum order is ${qmin.toLocaleString()} cards${isSplit ? ' in total' : ''}.`
      else if (qmax != null && qty > qmax) hint = `For more than ${qmax.toLocaleString()} cards, please reply to the email you received and we’ll sort it.`
      else hint = 'We couldn’t price this quantity — please reply to the email you received.'
    }
    const ready = specPicked && qty != null && (activeTiers.length === 0 || (cards != null && !overCap))
    // Live label as picks land: "500 × Stainless Steel 500µm — Mirror".
    const variantName = m.thickness_open
      ? data.specVariants.find((v) => v.id === pick.variantId)?.display_name ?? null
      : m.order_spec_snapshot?.variant?.display_name ?? null
    const finishName = m.finish_open
      ? data.specFinishes.find((f) => f.id === pick.optionId)?.display_name ?? null
      : m.order_spec_snapshot?.finish?.display_name ?? null
    const materialName = data.materialName
    const label = materialName
      ? `${qty != null ? `${qty.toLocaleString()} × ` : ''}${materialName}${variantName && variantName !== materialName ? ` ${variantName}` : ''}${finishName ? ` — ${finishName}` : ''}`
      : memberLabel(m)
    memberLive.set(m.id, { open: true, ready, goods, discount, qty, hint, label })
  }

  const openMembers = members.filter(memberIsOpen)
  const allChoicesMade = openMembers.every((m) => memberLive.get(m.id)?.ready === true)
  const liveLines = members.map((m) => memberLive.get(m.id) as MemberLive)
  const goodsKnown = liveLines.length > 0 && liveLines.every((l) => l.goods != null)
  const liveGoodsSum = goodsKnown ? round2(liveLines.reduce((acc, l) => acc + (l.goods as number), 0)) : null
  const liveDiscountSum = goodsKnown ? round2(liveLines.reduce((acc, l) => acc + l.discount, 0)) : null
  // Pre-checkout combined total — only when shipping needs no live rating
  // (free / manual) AND every line has a figure. Rated shipping defers the
  // total to the payment step, exactly like the single page.
  const preTotal =
    !shippingComputedAtCheckout && goodsKnown
      ? round2(
          (liveGoodsSum as number) -
            (liveDiscountSum as number) +
            (group.shipping_treatment === 'manual' ? Number(group.shipping_charged ?? 0) : 0) +
            (tariffApplies && !tariffOptedOut ? tariffFee : 0),
        )
      : null

  function setPick(orderId: string, patch: Partial<MemberPick>) {
    setPicks((prev) => ({
      ...prev,
      [orderId]: { ...(prev[orderId] ?? { variantId: null, optionId: null, qty: '', personQty: {} }), ...patch },
    }))
  }

  // One "Confirm your …" chooser section per open member: quantity FIRST
  // (so every option card prices at the customer's real quantity), then
  // thickness cards, then finish cards — the single-order flow, per card.
  // A const arrow (not a hoisted declaration) so TS keeps the non-null
  // narrowing of `group` from the guards above.
  const renderMemberChooser = (m: GroupMemberPayload, index: number) => {
    const data = chooserData[m.id]
    const pick = picks[m.id]
    const live = memberLive.get(m.id)
    const heading = data?.materialName ?? memberLabel(m)
    if (!data || !pick) {
      return (
        <div key={m.id} className="rounded-xl border border-line bg-canvas p-4">
          <p className="text-[11px] font-medium uppercase tracking-wide text-ink-mute">
            Item {index + 1} of {openMembers.length}
          </p>
          <p className="mt-1 font-medium text-ink">{heading}</p>
          <p className="mt-2 text-[13px] text-ink-soft">Loading the options for this card…</p>
        </div>
      )
    }
    const qtyOpen = memberQuantityOpen(m)
    const isSplit = qtyOpen && data.personNames.length > 1
    const qty = live?.qty ?? null
    // Thickness cards in the education copy's order when a set exists,
    // catalogue order otherwise (same rule as the single page).
    const orderedVariants =
      data.thicknessNotes.length === 0
        ? data.specVariants
        : [...data.specVariants].sort((a, b) => {
            const pos = (v: SpecVariantChoice) => {
              const i = data.thicknessNotes.findIndex((n) => parseInt(n.label, 10) === parseInt(v.display_name, 10))
              return i === -1 ? Number.MAX_SAFE_INTEGER : i
            }
            return pos(a) - pos(b)
          })
    const bounds = (m.thickness_open && !pick.variantId ? data.specVariants.flatMap((v) => v.tiers) : (m.thickness_open ? data.specVariants.find((v) => v.id === pick.variantId)?.tiers ?? [] : data.lockedTiers))
    const qmin = bounds.length > 0 ? Math.min(...bounds.map((t) => t.quantity)) : null
    const qmax = bounds.length > 0
      ? (data.flatAboveTop ? MAX_ONLINE_FLAT_QUANTITY : Math.max(...bounds.map((t) => t.quantity)))
      : null

    // The member's own artwork in the ACTIVE finish — the live pick when the
    // finish is open (nothing shown as "chosen" until they tap), the locked
    // tab otherwise. While the finish is switchable, every candidate finish
    // mounts as cross-fade layers, so picking Mirror fades the preview to
    // their design in mirror — the single-order behaviour, per card.
    const activeFinishCode =
      (m.finish_open ? data.specFinishes.find((f) => f.id === pick.optionId)?.code ?? null : null) ??
      data.lockedFinishCode
    const recapTiles = buildRecapTiles(
      data.versionImages,
      activeFinishCode,
      data.specFinishes.map((f) => f.code),
      m.finish_open && data.specFinishes.length > 1,
    )

    return (
      <div key={m.id} className="space-y-3 rounded-xl border border-line bg-canvas p-4">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wide text-ink-mute">
            Item {index + 1} of {openMembers.length}
          </p>
          <p className="mt-1 font-medium text-ink">{heading}</p>
        </div>

        {recapTiles.length > 0 && (
          <div className={`grid gap-3 ${recapTiles.length > 1 ? 'sm:grid-cols-2' : ''}`}>
            {recapTiles.map((tile) => (
              <ArtworkFade key={tile.active.side ?? tile.active.id} layers={tile.layers} activeId={tile.active.id} />
            ))}
          </div>
        )}

        {isSplit ? (
          <div className="rounded-lg border border-line bg-surface p-3">
            <p className="text-[13px] font-medium text-ink">How many cards for each person?</p>
            <div className="mt-2.5 space-y-2">
              {data.personNames.map((name) => (
                <div key={name} className="flex items-center justify-between gap-4">
                  <label htmlFor={`q-${m.id}-${name}`} className="truncate text-[13px] text-ink">{name}</label>
                  <input
                    id={`q-${m.id}-${name}`} type="number" min={1} step={1} inputMode="numeric"
                    value={pick.personQty[name] ?? ''}
                    onChange={(e) => setPick(m.id, { personQty: { ...pick.personQty, [name]: e.target.value } })}
                    placeholder="0"
                    className="h-10 w-24 rounded-lg border border-line bg-canvas px-3 text-right text-sm font-semibold text-ink focus:border-[var(--c-brand)] focus:outline-2 focus:outline-offset-1 focus:outline-[var(--c-brand)]"
                  />
                </div>
              ))}
            </div>
            <div className="mt-2.5 flex items-center justify-between gap-4 border-t border-line-soft pt-2.5 text-[13px]">
              <span className="text-ink-soft">Total</span>
              <span className="font-semibold text-ink">{qty != null && qty > 0 ? `${qty.toLocaleString()} cards` : '—'}</span>
            </div>
          </div>
        ) : qtyOpen ? (
          <div className="rounded-lg border border-line bg-surface p-3">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <label htmlFor={`q-${m.id}`} className="block text-[13px] font-medium text-ink">How many cards?</label>
                {qmin != null && qmax != null && (
                  <p className="mt-0.5 text-[12px] text-ink-mute">Any quantity from {qmin.toLocaleString()} to {qmax.toLocaleString()}.</p>
                )}
              </div>
              <input
                id={`q-${m.id}`} type="number" min={qmin ?? 1} max={qmax ?? undefined} step={1} inputMode="numeric"
                value={pick.qty}
                onChange={(e) => setPick(m.id, { qty: e.target.value })}
                placeholder={qmin != null ? `${qmin.toLocaleString()}+` : 'e.g. 250'}
                className="h-11 w-28 shrink-0 rounded-lg border border-line bg-canvas px-3 text-right text-sm font-semibold text-ink focus:border-[var(--c-brand)] focus:outline-2 focus:outline-offset-1 focus:outline-[var(--c-brand)]"
              />
            </div>
          </div>
        ) : null}
        {live?.hint && <p className="text-[13px] text-low">{live.hint}</p>}

        {m.thickness_open && data.specVariants.length > 0 && (
          <div className="space-y-2">
            <p className="text-[13px] text-ink-soft">Choose your thickness — the price updates as you pick.</p>
            {orderedVariants.map((v) => {
              const note = thicknessNoteFor(data.thicknessNotes, v.display_name)
              // Fold a LOCKED non-base finish's surcharge (e.g. Brushed) into
              // every thickness card, so the shown price matches the line total
              // and the charge. The finish isn't pickable here (finish_open is
              // false), so its premium belongs in each card's price rather than
              // on a separate finish card.
              const priceBasisQty = qty ?? v.tiers[0]?.quantity ?? null
              const lockedFinishAdd =
                !m.finish_open && data.lockedFinishSurTiers.length > 0 && priceBasisQty != null
                  ? surchargeFromTiers(exvSurTiers(data.lockedFinishSurTiers), priceBasisQty, data.flatAboveTop)
                  : 0
              const base =
                qty != null
                  ? totalFromTiers(exvTiers(v.tiers), qty, data.flatAboveTop)
                  : v.tiers[0] != null ? exv(v.tiers[0].total_price) : null
              const price = base != null ? round2(base + lockedFinishAdd) : null
              const priceLabel =
                price != null
                  ? qty != null
                    ? formatPrice(price, group.currency)
                    : `from ${formatPrice(price, group.currency)}`
                  : null
              const selected = pick.variantId === v.id
              return (
                <button
                  key={v.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setPick(m.id, { variantId: v.id })}
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
                      {note?.badge && (
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
          </div>
        )}

        {m.finish_open && data.specFinishes.length > 0 && (
          <div className="space-y-2">
            <p className="text-[13px] text-ink-soft">
              {m.thickness_open ? 'And your finish:' : 'Choose your finish:'}
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              {data.specFinishes.map((f) => {
                const qtyBasis = qty ?? bounds[0]?.quantity ?? 0
                const delta =
                  f.is_base || f.surTiers.length === 0
                    ? 0
                    : surchargeFromTiers(exvSurTiers(f.surTiers), qtyBasis, data.flatAboveTop)
                return (
                  <FinishChoiceCard
                    key={f.id}
                    name={f.display_name}
                    priceLabel={delta > 0 ? `+${formatPrice(delta, group.currency)}` : 'Included'}
                    imageSrc={f.photoUrl ?? f.swatchUrl}
                    imageAlt={f.photoUrl ? `${f.display_name} finish` : `Your design in ${f.display_name}`}
                    description={f.description}
                    selected={pick.optionId === f.id}
                    onChoose={() => setPick(m.id, { optionId: f.id })}
                  />
                )
              })}
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-canvas">
      <CustomerHeader innerClassName="max-w-5xl" />
      <div className="mx-auto max-w-5xl px-gutter py-8">
        <p className="eyebrow">Complete your order</p>
        <h1 className="mt-1 text-xl font-semibold text-ink">{company ?? 'Your order'}</h1>
        {group.payment_reference && (
          <p className="mt-1 text-sm text-ink-soft">Reference {group.payment_reference}</p>
        )}
        <p className="mt-1 text-sm text-ink-soft">
          {members.length} {members.length === 1 ? 'item' : 'items'} in this order — one payment covers everything below.
        </p>

        <div ref={mountWrapRef} className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
          {/* LEFT — one line per card + the combined totals. */}
          <PanelShell className="self-start">
            <p className="text-[11px] font-medium uppercase tracking-wide text-ink-mute">Order summary</p>
            <div className="mt-4 space-y-2 text-sm">
              {checkout ? (
                <>
                  {checkout.members.map((line) => (
                    <div key={line.order_id} className="space-y-1 border-b border-line-soft pb-2 last:border-b-0 last:pb-0">
                      <Row label={line.label} value={formatPrice(line.goods, checkout.currency)} />
                      {line.card_discount > 0 && (
                        <Row label="Discount" value={formatPrice(-line.card_discount, checkout.currency)} />
                      )}
                    </div>
                  ))}
                  <Row
                    label={SHIPPING_LABEL[group.shipping_treatment]}
                    value={checkout.breakdown.shipping > 0 ? formatPrice(checkout.breakdown.shipping, checkout.currency) : 'Free'}
                  />
                  {checkout.breakdown.us_tariff > 0 && (
                    <Row label="US tariff & customs handling" value={formatPrice(checkout.breakdown.us_tariff, checkout.currency)} />
                  )}
                  <div className="mt-3 flex items-center justify-between border-t border-line pt-3 text-base">
                    <span className="font-semibold text-ink">Total</span>
                    <span className="font-semibold text-ink">{formatPrice(checkout.amount, checkout.currency)}</span>
                  </div>
                  {vatCaption && <p className="mt-1 text-[12px] text-ink-mute">{vatCaption}</p>}
                </>
              ) : (
                <>
                  {members.map((m) => {
                    const live = memberLive.get(m.id)
                    return (
                      <div key={m.id} className="space-y-1 border-b border-line-soft pb-2 last:border-b-0 last:pb-0">
                        <Row
                          label={live?.label ?? memberLabel(m)}
                          value={
                            live?.goods != null
                              ? formatPrice(live.goods, group.currency)
                              : live?.open
                                ? 'Choose options'
                                : ' '
                          }
                        />
                        {live != null && live.goods != null && live.discount > 0 && (
                          <Row label="Discount" value={formatPrice(-live.discount, group.currency)} />
                        )}
                      </div>
                    )
                  })}
                  <Row
                    label={SHIPPING_LABEL[group.shipping_treatment]}
                    value={
                      group.shipping_treatment === 'free' ? 'Free'
                        : group.shipping_treatment === 'manual' && group.shipping_charged != null
                          // Manual shipping is charged as entered (the server
                          // never VAT-strips it) — show it at face value.
                          ? formatPrice(Number(group.shipping_charged), group.currency)
                          : 'Calculated at payment'
                    }
                  />
                  {tariffApplies && (
                    <Row label="US tariff & customs handling" value={tariffOptedOut ? 'Removed' : formatPrice(tariffFee, group.currency)} />
                  )}
                  {preTotal != null ? (
                    <>
                      <div className="mt-3 flex items-center justify-between border-t border-line pt-3 text-base">
                        <span className="font-semibold text-ink">Total</span>
                        <span className="font-semibold text-ink">{formatPrice(preTotal, group.currency)}</span>
                      </div>
                      {vatCaption && <p className="mt-1 text-[12px] text-ink-mute">{vatCaption}</p>}
                    </>
                  ) : (
                    <p className="mt-2 text-[12px] text-ink-mute">
                      {openMembers.length > 0 && !allChoicesMade
                        ? 'Prices update as you choose — your exact total is confirmed at the payment step.'
                        : `Your exact total${goodsKnown ? '' : ' and per-item prices'} will be confirmed at the payment step.`}
                    </p>
                  )}
                </>
              )}
            </div>
          </PanelShell>

          {/* RIGHT — per-card choosers + destination + tariff inputs, then
              the payment form. */}
          <PanelShell className="relative min-h-[300px]">
            {!checkout ? (
              <div className="space-y-4 text-sm">
                {openMembers.length > 0 && (
                  <div className="space-y-3">
                    <p className="font-medium text-ink">
                      {openMembers.length === 1 ? 'Confirm your card' : 'Confirm your cards'}
                    </p>
                    {openMembers.map((m, i) => renderMemberChooser(m, i))}
                  </div>
                )}

                {shippingComputedAtCheckout && (
                  <div className="space-y-2.5">
                    <p className="font-medium text-ink">Where should we ship these?</p>
                    <p className="text-[13px] text-ink-soft">
                      Everything on this order ships together to one address. You&rsquo;ll confirm the full delivery address below.
                    </p>
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <select
                        aria-label="Delivery country"
                        value={destCountry}
                        onChange={(e) => setDestCountry(e.target.value)}
                        className="h-[38px] flex-1 rounded-lg border border-line bg-surface px-3 text-sm text-ink focus:border-[var(--c-brand)] focus:outline-2 focus:outline-offset-1 focus:outline-[var(--c-brand)]"
                      >
                        <option value="">Select country…</option>
                        {SHIP_COUNTRIES.map((c) => (<option key={c.code} value={c.code}>{c.name}</option>))}
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

                {tariffApplies && (
                  <div className="rounded-xl border border-line bg-canvas p-4">
                    <div className="flex items-baseline justify-between gap-3">
                      <p className="font-medium text-ink">US tariff &amp; customs handling</p>
                      <p className={tariffOptedOut ? 'text-ink-mute line-through' : 'font-medium text-ink'}>{formatPrice(tariffFee, group.currency)}</p>
                    </div>
                    {tariff?.intro && <p className="mt-2 text-[13px] leading-relaxed text-ink-soft">{tariff.intro}</p>}
                    {!tariffOptedOut ? (
                      tariffConfirmingOptOut ? (
                        <div className="mt-3 rounded-lg border border-low bg-low-soft p-3">
                          <p className="text-[13px] leading-relaxed text-ink">{tariff?.warning}</p>
                          <div className="mt-3 flex flex-wrap gap-2">
                            <button
                              type="button"
                              onClick={() => { setTariffOptedOut(true); setTariffConfirmingOptOut(false) }}
                              className="rounded-lg bg-ink px-3 py-1.5 text-[13px] font-semibold text-on-ink transition-opacity hover:opacity-90"
                            >
                              Yes, remove it — I&rsquo;ll handle US customs
                            </button>
                            <button
                              type="button"
                              onClick={() => setTariffConfirmingOptOut(false)}
                              className="rounded-lg px-3 py-1.5 text-[13px] font-medium text-ink-soft ring-1 ring-line transition-colors hover:bg-surface"
                            >
                              Keep it
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setTariffConfirmingOptOut(true)}
                          className="mt-3 text-[13px] font-medium text-ink-soft underline underline-offset-2 hover:text-ink"
                        >
                          Remove this charge
                        </button>
                      )
                    ) : (
                      <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-line bg-surface px-3 py-2">
                        <p className="text-[13px] text-ink-soft">Removed — you&rsquo;ll deal with US Customs and any tariffs directly.</p>
                        <button
                          type="button"
                          onClick={() => setTariffOptedOut(false)}
                          className="shrink-0 text-[13px] font-medium text-ink-soft underline underline-offset-2 hover:text-ink"
                        >
                          Add it back
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {payError && (
                  <div role="alert" className="rounded-lg border border-out bg-out-soft px-3 py-2 text-[13px] text-out">{payError}</div>
                )}

                <button
                  type="button"
                  onClick={() => void startCheckout()}
                  disabled={paying || !destinationComplete || !allChoicesMade}
                  className="inline-flex w-full items-center justify-center rounded-lg bg-ink px-5 py-3 text-sm font-semibold text-on-ink transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {paying ? 'Loading secure payment…'
                    : !allChoicesMade ? 'Choose your options above'
                      : !destinationComplete ? 'Enter delivery country & postcode'
                        : 'Continue to payment'}
                </button>
                <p className="text-center text-[12px] text-ink-mute" aria-live="polite">
                  {!allChoicesMade
                    ? 'A couple of choices are still needed above before payment.'
                    : !destinationComplete
                      ? 'Enter where we’re shipping to so we can calculate shipping.'
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
                  <div>
                    <p className="mb-1.5 text-[12px] font-medium text-ink-mute">Payment details</p>
                    <div id="payment-element" aria-label="Payment details" />
                  </div>
                </div>
                {formError && (
                  <div role="alert" className="mt-3 rounded-lg border border-out bg-out-soft px-3 py-2 text-[13px] text-out">{formError}</div>
                )}
                <button
                  type="button"
                  onClick={() => void confirmPay()}
                  disabled={submitting || !formMounted}
                  className="mt-4 inline-flex w-full items-center justify-center rounded-lg bg-ink px-5 py-3 text-sm font-semibold text-on-ink transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {submitting ? 'Processing…' : `Pay ${formatPrice(checkout.amount, checkout.currency)}`}
                </button>
                <p className="mt-2 text-center text-[12px] text-ink-mute">
                  Secured by Stripe.{checkout.currency === 'GBP' ? (checkout.vatFree ? ' VAT-free.' : ' Includes VAT.') : ''}
                </p>
                {(openMembers.length > 0 || shippingComputedAtCheckout || tariffApplies) && (
                  <button
                    type="button"
                    onClick={() => { setCheckout(null); setFormError(null); setPaying(false) }}
                    className="mt-3 block w-full text-center text-[12px] text-ink-mute underline hover:text-ink"
                  >
                    {openMembers.length > 0 ? 'Edit your choices' : 'Edit delivery details'}
                  </button>
                )}
              </>
            )}
          </PanelShell>
        </div>

        {group.expires_at && (
          <p className="mt-4 text-center text-[12px] text-ink-mute">
            This payment link is valid until {formatDate(group.expires_at)}. After that, just reply to your email and we&rsquo;ll send a fresh one.
          </p>
        )}
      </div>
    </div>
  )
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-ink-soft">{label}</span>
      <span className="text-ink">{value}</span>
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
