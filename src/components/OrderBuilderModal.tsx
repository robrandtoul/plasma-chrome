import { useEffect, useState } from 'react'
import Modal from './Modal'
import { Field, Input, ButtonCoral, ButtonGhost } from '../design'
import XeroContactPicker, { type XeroContact } from './XeroContactPicker'
import { supabase } from '../lib/supabase'
import { parseReengagementContext, previousSpecFromReengagement } from '../lib/reengagement'
import { fetchBundleHint } from '../lib/proofSets'
import type { BundleHint } from '../lib/bundleOrderLabels'
import { customerOrderUrl } from '../lib/customerOrderUrl'
import { finishIsPreferenceOnly } from '../lib/materialTraits'
import { SHIP_COUNTRIES, REPRESENTATIVE_POSTCODES } from '../lib/shipCountries'
import { isGbpOrderVatFree, type VatTreatment } from '../lib/ukVatArea'
import { renderTemplate, DEFAULT_BODIES } from '../lib/replyTemplates'
import type { StrandedCard } from '../lib/strandedApprovals'
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
type CardDiscountType = 'none' | 'percent' | 'fixed'

const TREATMENT_OPTIONS: { value: ShippingTreatment; label: string }[] = [
  { value: 'full_cost', label: 'Charge full cost' },
  { value: 'goodwill', label: 'Goodwill (subsidise)' },
  { value: 'free', label: 'Free shipping' },
  { value: 'manual', label: 'Manual amount' },
]

const CARD_DISCOUNT_OPTIONS: { value: CardDiscountType; label: string }[] = [
  { value: 'none', label: 'No discount' },
  { value: 'percent', label: '% off' },
  { value: 'fixed', label: 'Fixed amount off' },
]

// "March 2026" from a paid_at timestamp — the human "when" the pay page shows
// in the "Your last order · March 2026" badge. Month-level on purpose: a
// years-old order's exact day is noise, and the designer can edit it anyway.
function formatMonthYear(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
}

interface VariantOption {
  id: string
  display_name: string
  weight_grams: number | null
  // 'thickness' | 'ink_count' | 'finish' | 'default'. Drives whether the order
  // locks to the proof's variant (ink_count + finish = artwork-defined, fixed at
  // proof time) or lets the designer change it (thickness = a substrate choice
  // the customer can still change at order time).
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
  // Whether the PROOF VERSION is a custom quote (proof_versions.custom_quote) —
  // i.e. the customer was never shown a price grid. That forces the agreed-price
  // basis below. A standard-priced proof can still be ordered at an agreed price
  // (the designer picks the basis per order); this prop only says what the proof
  // itself did, never what this order must do.
  versionIsCustomQuote: boolean
  // Whether the proof is linked to a Help Scout conversation — gates the
  // "Send to customer" action in the success step.
  hasHelpScoutConversation: boolean
  // Cards approved on a superseded version in a DIFFERENT material than the
  // current one (bundle-orders spec §12.2). This order only covers the current
  // version's card, so these approved cards can't be ordered from here — we
  // warn about them by name. Empty in the normal single-product case.
  strandedApprovals?: StrandedCard[]
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
  versionIsCustomQuote,
  hasHelpScoutConversation,
  strandedApprovals = [],
  onClose,
  onCreated,
}: OrderBuilderModalProps) {
  // Payment method: 'online' sends a pay link; 'offline' records the order as
  // already paid (bank transfer etc.) — no link, no Stripe, no Xero. Offline
  // forces a locked quantity + free/manual shipping (handled below).
  const [paymentMethod, setPaymentMethod] = useState<'online' | 'offline'>('online')
  const [quantityMode, setQuantityMode] = useState<'open' | 'locked'>('open')
  const [quantity, setQuantity] = useState('')
  // Recipient names for a split-name proof, so a LOCKED order can capture a
  // per-person quantity split (the production instruction) rather than only a
  // total. Open orders collect this from the customer on the pay-page instead.
  const [personNames, setPersonNames] = useState<string[]>([])
  const [personQty, setPersonQty] = useState<Record<string, string>>({})
  const [shippingTreatment, setShippingTreatment] = useState<ShippingTreatment>('full_cost')
  const [shippingCharged, setShippingCharged] = useState('')
  // Optional destination-country pre-fill for full_cost / goodwill. The
  // customer confirms the country and enters their postcode on the pay-page
  // (support rarely knows the postcode upfront), and the rate is computed
  // there — so this is just a convenience hint, not required.
  const [shipDestCountry, setShipDestCountry] = useState('')
  // Manual VAT-treatment override (000316). 'auto' decides from the delivery
  // destination (VAT for UK + Isle of Man, zero-rated export elsewhere); the
  // designer can force a GBP order to zero-rate as an export or to charge UK
  // VAT for the rare case the destination alone gets it wrong. GBP only.
  const [vatTreatment, setVatTreatment] = useState<VatTreatment>('auto')
  // Per-order goodwill discount, % off the computed rate (Rob, 2026-06-15).
  const [shippingDiscountPercent, setShippingDiscountPercent] = useState('')
  // Per-order discount on the GOODS subtotal (cards + tooling +
  // personalisation) — none / % off / fixed amount off, with an optional
  // reason. Resolved + capped at checkout against the priced goods figure;
  // shows as its own negative line on the pay page + invoice.
  const [cardDiscountType, setCardDiscountType] = useState<CardDiscountType>('none')
  const [cardDiscountValue, setCardDiscountValue] = useState('')
  const [cardDiscountReason, setCardDiscountReason] = useState('')

  // Recovery discount the customer was offered on a price objection (proof_feedback,
  // 000279). Surfaced here so the designer can apply it in one click at order time.
  const [offeredDiscount, setOfferedDiscount] = useState<number | null>(null)
  useEffect(() => {
    if (!proofId) return
    let cancelled = false
    void supabase
      .from('proof_feedback')
      .select('recovery_offer')
      .eq('proof_id', proofId)
      .eq('reason_code', 'price_too_high')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return
        const pct = Number((data?.recovery_offer as { discount_percent?: number } | null)?.discount_percent ?? 0)
        setOfferedDiscount(Number.isFinite(pct) && pct > 0 ? pct : null)
      })
    return () => { cancelled = true }
  }, [proofId])
  // Bundle context, read once as the form opens (and again at creation, above).
  useEffect(() => {
    if (!proofId) return
    let cancelled = false
    void fetchBundleHint(proofId).then((h) => { if (!cancelled) setBundle(h) })
    return () => { cancelled = true }
  }, [proofId])
  const [customQuoteTotal, setCustomQuoteTotal] = useState('')
  // How THIS order is priced, independent of how the proof displayed prices:
  //   'catalogue' — priced from the material's price tiers at checkout
  //   'custom'    — one agreed total, typed below and taken at face value
  // A custom-quote PROOF forces 'custom' (there was never a grid to price
  // from), but a standard-priced proof can still be ordered at an agreed
  // figure — the common "we settled a price by email" case, which previously
  // had no route through this form at all. The whole stack downstream already
  // works off orders.custom_quote_total alone (create-order accepts it on any
  // order; the pay page and Xero invoice label it "Agreed price"), so this is
  // purely about offering the choice here.
  const [pricingBasis, setPricingBasis] = useState<'catalogue' | 'custom'>('catalogue')
  // The effective basis every gate below reads. OR-ing rather than seeding
  // state from the prop keeps the two impossible to desync.
  const isCustomQuote = versionIsCustomQuote || pricingBasis === 'custom'

  // An agreed price needs a locked quantity: the pay page's quantity chooser
  // is disabled whenever custom_quote_total is set (a fixed total can't be
  // re-priced by the customer's pick), so leaving the mode on "Customer
  // chooses" would send an order with no quantity recorded or shown anywhere
  // — not on the pay page, not on the invoice, not for production.
  useEffect(() => {
    if (isCustomQuote) setQuantityMode('locked')
  }, [isCustomQuote])

  // Order type: a normal production order, or the flat-fee prototyping service
  // (up to three exact copies of the approved design). Prototype is modelled
  // as a custom-quote order whose total is the per-family fee, keeping the
  // material variant for the Xero item code + shipping weight. Eligibility +
  // the fee come from prototype_prices (000287), resolved below.
  const [orderType, setOrderType] = useState<'production' | 'prototype'>('production')
  const [prototypeFee, setPrototypeFee] = useState<number | null>(null)
  // null = still loading; true/false once the material's family + fee resolve.
  const [prototypeEligible, setPrototypeEligible] = useState<boolean | null>(null)
  // The variant the prototype attaches to (proof's displayed variant, else the
  // material's first active variant) — carries the Xero item code + weight.
  const [prototypeVariantId, setPrototypeVariantId] = useState<string | null>(null)
  const [copies, setCopies] = useState<'1' | '2' | '3'>('1')

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
  // Offline orders send an order CONFIRMATION (no "pay" language) instead of the
  // pay-link message; loaded alongside it below.
  const [orderConfirmTemplateBody, setOrderConfirmTemplateBody] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)

  // Is this card one of a bundle the customer is reviewing together, and are
  // the other cards signed off? Fetched here rather than passed in, so both
  // entry points (the Orders worklist and the proof page) get it for free.
  //
  // Read TWICE, deliberately. Once when the form opens, to inform the decision
  // to build an order at all — and again the moment the order is created, right
  // before the send step, because the customer can act while the form is open
  // and the last read before the link reaches them should be the fresh one. On
  // 12 August a change request landed 3 seconds before a link went out; the
  // second read is what would have caught that.
  const [bundle, setBundle] = useState<BundleHint | null>(null)

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
  // materials.code for the selected material — gates the preference-only
  // finish rule (finishIsPreferenceOnly) without a second lookup.
  const [materialCode, setMaterialCode] = useState<string | null>(null)
  // True when the order is locked to the single variant the proof showed
  // pricing for (so we display it read-only rather than as a picker).
  const [lockedFromProof, setLockedFromProof] = useState(false)

  // Open-spec modes (000298): leave the thickness and/or finish for the
  // customer to choose on the pay page, with guided copy + live prices —
  // instead of settling them by email after approval. 'customer' is the
  // DEFAULT where it makes sense (a multi-thickness material like metal; a
  // finish the proof actually offered in 2+ tabs); the designer can lock
  // either per order (e.g. a repeat customer who always orders 800µm).
  // Offline orders force 'locked' — the customer never sees the pay page.
  const [thicknessMode, setThicknessMode] = useState<'customer' | 'locked'>('locked')
  const [finishMode, setFinishMode] = useState<'customer' | 'locked'>('locked')

  // Xero customer the paid invoice files under (online orders only). Pre-filled
  // from this customer's last order so a returning customer is one click;
  // designer can change it or leave it blank for a new customer (000275).
  const [xeroContact, setXeroContact] = useState<XeroContact | null>(null)
  // Whether the designer has changed anything yet. Guards an accidental
  // backdrop / Esc / Cancel dismissal from silently binning a part-filled form
  // (the auto-loaded variant / finish / Xero pre-fill don't count — they set
  // state directly, not through a DOM change event or a picker click).
  const [dirty, setDirty] = useState(false)
  // Existing vs new Xero customer — an explicit, REQUIRED choice for online
  // orders so a new contact is never created by accident (a blank field used to
  // silently make one). null = not chosen yet; the pre-fill flips it to
  // 'existing'. Offline orders don't ask (invoiced in Xero by hand).
  const [xeroMode, setXeroMode] = useState<'existing' | 'new' | null>(null)
  // Name the new Xero contact is created under (the 'new' path). Defaults to the
  // proof's company (or contact) name, so a new contact is the customer — not
  // whoever happens to pay. Editable.
  const [newCustomerName, setNewCustomerName] = useState(customerLabel ?? '')

  // "Their last order" (000364): what this customer ordered on their previous
  // paid order, confirmed here so the pay-page choosers can badge the matching
  // option "Your last order" and nudge gently if they pick differently.
  // Auto-suggested from their order history (same company-else-contact
  // matching as the Xero pre-fill below) with a one-click apply; manual entry
  // covers the customers whose history lives only in old Help Scout threads
  // or Xero invoices — the designer does that detective work once and it's
  // recorded for good. Display guidance only: it never feeds pricing.
  const [prevSuggestion, setPrevSuggestion] = useState<{
    variantId: string | null
    variantLabel: string | null
    optionId: string | null
    optionLabel: string | null
    quantity: number | null
    paidAt: string | null
    /** Where the suggestion came from. An order we hold is a fact; the register
     *  is Xero history, so the designer is told which they are looking at. */
    sourceKind: 'order' | 'register'
    /** Register path only: the month, already formatted. ⚠ NOT derived from a
     *  timestamp — see the fetch below. */
    whenLabel: string | null
  } | null>(null)
  const [prevDismissed, setPrevDismissed] = useState(false)
  // Engaged = the fields are showing and a spec will be sent (if meaningful).
  const [prevEngaged, setPrevEngaged] = useState(false)
  const [prevSource, setPrevSource] = useState<'auto' | 'manual'>('manual')
  const [prevVariantId, setPrevVariantId] = useState('')
  // Frozen display labels ride alongside the ids so the pay page can still
  // name the old spec if the variant/finish is later retired or renamed.
  const [prevVariantLabel, setPrevVariantLabel] = useState('')
  const [prevOptionId, setPrevOptionId] = useState('')
  const [prevOptionLabel, setPrevOptionLabel] = useState('')
  const [prevQuantity, setPrevQuantity] = useState('')
  const [prevWhen, setPrevWhen] = useState('')

  // Indicative shipping estimate (full_cost / goodwill). Quantity it's based on
  // defaults to the locked quantity, else a representative 250.
  const [shippingSettings, setShippingSettings] = useState<ShippingSettings | null>(null)
  const [exchangeRates, setExchangeRates] = useState<ExchangeRates | null>(null)
  const [estimateQty, setEstimateQty] = useState('250')
  const [estimate, setEstimate] = useState<ShipEstimate>({ kind: 'idle' })

  useEffect(() => {
    if (!materialId || !currency) return
    let cancelled = false
    void (async () => {
      setVariantsLoading(true)
      const { data: vs } = await supabase
        .from('material_variants')
        .select('id, display_name, sort_order, weight_grams, variant_type')
        .eq('material_id', materialId)
        .eq('is_active', true)
        .order('sort_order')
      const all = (vs ?? []).map((v) => ({
        id: v.id as string,
        display_name: (v.display_name as string) ?? 'Option',
        weight_grams: typeof v.weight_grams === 'number' ? v.weight_grams : null,
        variant_type: (v.variant_type as string | null) ?? null,
      }))
      // Grid orders price from tiers, so list only variants that HAVE a tier in
      // this currency — a per-variant head count avoids supabase-js's 1000-row
      // cap (8 ink variants × ~197 tiers > 1000 would silently drop rows). A
      // custom quote has an agreed total (no tier lookup), so it lists every
      // active variant: the designer picks the thickness the quote is for, which
      // captures the shipping weight + the Xero item code that were otherwise
      // missing (the "no parcel weight" checkout failure on custom quotes).
      let options = all
      if (!isCustomQuote) {
        const checks = await Promise.all(
          all.map(async (v) => {
            const { count } = await supabase
              .from('price_tiers')
              .select('id', { count: 'exact', head: true })
              .eq('material_variant_id', v.id)
              .eq('currency', currency)
            return { id: v.id, has: (count ?? 0) > 0 }
          }),
        )
        const priced = new Set(checks.filter((c) => c.has).map((c) => c.id))
        options = all.filter((v) => priced.has(v.id))
      }
      if (cancelled) return
      setVariants(options)
      // Pre-select the variant the proof priced (when it's a single displayed
      // variant). Lock it read-only only when it's defined by the approved
      // artwork and can't change at order time:
      //   * ink_count — letterpress / plastics (the artwork has that many inks)
      //   * finish    — standard paper (Standard / UV Spot / Foiling is printed
      //                 into the approved artwork)
      // Substrate choices the customer can still change at order time (metal /
      // full-colour-plastic thickness) stay an editable picker, just pre-selected
      // to the proof's. Metal finish is a separate option picker, not this variant.
      const fromProofOpt = displayedVariantIds.length === 1
        ? options.find((o) => o.id === displayedVariantIds[0]) ?? null
        : null
      const artworkPinned =
        !!fromProofOpt && (fromProofOpt.variant_type === 'ink_count' || fromProofOpt.variant_type === 'finish')
      setLockedFromProof(artworkPinned)
      setVariantId(fromProofOpt?.id ?? (options.length === 1 ? options[0].id : null))
      // Default the thickness to "customer chooses at checkout" when the
      // material genuinely offers a thickness choice (2+ thickness variants —
      // the metal family and friends) and the artwork doesn't pin the variant.
      // A custom quote never offers that (open-spec is disabled for agreed-price
      // orders), so it stays locked — the designer just picks the thickness.
      setThicknessMode(
        !isCustomQuote && !artworkPinned && options.length > 1 && options.every((o) => o.variant_type === 'thickness')
          ? 'customer'
          : 'locked',
      )
      setVariantsLoading(false)
    })()
    return () => { cancelled = true }
  }, [isCustomQuote, materialId, currency, displayedVariantIds])

  // Prototype data: resolve the material family (= materials.category), its
  // flat prototyping fee for this currency, and an attach-variant for the Xero
  // item code + shipping weight. Runs regardless of the chosen order type so
  // the "Prototype" toggle knows whether to enable. Eligibility = an active,
  // priced prototype_prices row for the family + currency.
  useEffect(() => {
    if (!materialId || !currency) { setPrototypeEligible(false); setPrototypeFee(null); setPrototypeVariantId(null); return }
    let cancelled = false
    void (async () => {
      const matRes = await supabase.from('materials').select('category').eq('id', materialId).maybeSingle()
      const family = (matRes.data?.category as string | null) ?? null
      let fee: number | null = null
      let eligible = false
      if (family) {
        const { data: feeRow } = await supabase
          .from('prototype_prices')
          .select('amount, is_active')
          .eq('family', family)
          .eq('currency', currency)
          .maybeSingle()
        if (feeRow?.is_active && feeRow.amount != null) {
          fee = Number(feeRow.amount)
          eligible = true
        }
      }
      // Attach-variant: the proof's displayed variant, else the material's
      // first active variant. A prototype doesn't need price tiers — only a
      // variant to carry the Xero item code + per-card weight.
      let attachVariant: string | null = displayedVariantIds[0] ?? null
      if (!attachVariant) {
        const { data: v } = await supabase
          .from('material_variants')
          .select('id')
          .eq('material_id', materialId)
          .eq('is_active', true)
          .order('sort_order')
          .limit(1)
          .maybeSingle()
        attachVariant = (v?.id as string | null) ?? null
      }
      if (cancelled) return
      setPrototypeFee(fee)
      setPrototypeEligible(eligible)
      setPrototypeVariantId(attachVariant)
    })()
    return () => { cancelled = true }
  }, [materialId, currency, displayedVariantIds])

  // Material options (the finish dimension). Fetched alongside the material's
  // option_label so the picker reads "Finish" / "Species" etc. Default: the
  // version's single offered option when it offered exactly one, else the base
  // option — the designer changes it to whatever finish the customer wants.
  useEffect(() => {
    // Load + auto-select the finish even for a custom quote — it's production
    // spec the supplier needs, so the offered/base finish is applied and
    // persisted whether or not the designer touches it. The picker below now
    // shows on an agreed price too (it used to be hidden), so that automatic
    // choice is visible and correctable rather than silent; what it can't do
    // is offer the CUSTOMER the pick, since a fixed total can't be repriced.
    if (!materialId) { setMaterialOptions([]); setOptionId(null); setMaterialCode(null); return }
    let cancelled = false
    void (async () => {
      const [optsRes, matRes] = await Promise.all([
        supabase
          .from('material_options')
          .select('id, code, display_name, is_base, sort_order')
          .eq('material_id', materialId)
          .order('sort_order'),
        supabase.from('materials').select('code, option_label').eq('id', materialId).maybeSingle(),
      ])
      if (cancelled) return
      const list: MaterialOptionRow[] = (optsRes.data ?? []).map((o) => ({
        id: o.id as string,
        code: o.code as string,
        display_name: (o.display_name as string) ?? 'Option',
        is_base: !!o.is_base,
      }))
      setMaterialOptions(list)
      const code = (matRes.data?.code as string | null) ?? null
      setMaterialCode(code)
      if (matRes.data?.option_label) setOptionLabel(matRes.data.option_label as string)
      const offered = materialOptionCodes.length === 1 ? list.find((o) => o.code === materialOptionCodes[0]) : null
      const base = list.find((o) => o.is_base) ?? list[0] ?? null
      setOptionId((offered ?? base)?.id ?? null)
      // Default the finish to "customer chooses at checkout" only when the
      // proof genuinely offered a choice (2+ finish tabs on the approved
      // version) — a single-finish proof's artwork IS that finish, so it
      // stays locked, matching the artwork-defined rule for variants.
      // Preference-only finishes (full-colour plastic gloss/matte) are
      // invisible on the artwork, so the proof never tabs them — the
      // catalogue alone opens the choice.
      setFinishMode(
        list.length > 1 && (materialOptionCodes.length >= 2 || finishIsPreferenceOnly(code))
          ? 'customer'
          : 'locked',
      )
    })()
    return () => { cancelled = true }
    // materialOptionCodes intentionally omitted — read once at mount; it's
    // stable for a given proof and re-running on identity churn isn't wanted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCustomQuote, materialId])

  // Recipient names for the per-person locked-quantity split. Only needed when
  // the proof has multiple names; read from the current version (designer-side,
  // RLS-allowed). Empty → the locked path falls back to a single total input.
  useEffect(() => {
    if (namesCount <= 1 || !currentVersionId) return
    let cancelled = false
    void (async () => {
      const { data } = await supabase
        .from('proof_versions')
        .select('names')
        .eq('id', currentVersionId)
        .maybeSingle()
      if (cancelled) return
      const names = Array.isArray(data?.names) ? (data!.names as string[]).filter(Boolean) : []
      setPersonNames(names)
    })()
    return () => { cancelled = true }
  }, [namesCount, currentVersionId])

  // Pre-fill the Xero customer from this customer's most recent order (matched
  // by company, or the contact itself when they have no company). Returning
  // customer → one click; new customer → empty, designer searches or leaves it
  // blank. Best-effort: a miss just leaves the picker empty.
  useEffect(() => {
    if (!proofId) return
    let cancelled = false
    void supabase
      .rpc('last_xero_contact_for_proof', { p_proof_id: proofId })
      .then(({ data }) => {
        if (cancelled || !Array.isArray(data) || data.length === 0) return
        const row = data[0] as { xero_contact_id: string | null; xero_contact_name: string | null }
        // Only pre-fill when we have a human-readable name too — never surface a
        // raw Xero ContactID as the customer label. The name is written
        // alongside the id on every order, so this is just belt-and-braces.
        if (row?.xero_contact_id && row?.xero_contact_name) {
          setXeroContact({ id: row.xero_contact_id, name: row.xero_contact_name })
          // A returning customer we already have → default to Existing, with
          // them pre-selected (visible — the designer confirms or changes it).
          setXeroMode('existing')
        }
      })
    return () => { cancelled = true }
  }, [proofId])

  // "Their last order" auto-suggest (000364): this customer's most recent PAID
  // order of the same material, resolved server-side by
  // last_paid_order_for_proof (company-else-contact matching, prototypes
  // excluded, labels frozen from the catalogue). Best-effort: a miss just
  // means the designer sees the manual "Add their last order" affordance.
  useEffect(() => {
    if (!proofId || !materialId) return
    let cancelled = false
    void supabase
      .rpc('last_paid_order_for_proof', { p_proof_id: proofId, p_material_id: materialId })
      .then(({ data }) => {
        if (cancelled || !Array.isArray(data) || data.length === 0) return
        const row = data[0] as {
          variant_id: string | null
          variant_label: string | null
          option_id: string | null
          option_label: string | null
          quantity: number | null
          paid_at: string | null
        }
        // Belt-and-braces beside the RPC's own guard: a row with nothing
        // displayable would render "Last time they ordered — paid June 2026".
        if (!row.variant_label && !row.option_label && row.quantity == null) return
        setPrevSuggestion({
          variantId: row.variant_id,
          variantLabel: row.variant_label,
          optionId: row.option_id,
          optionLabel: row.option_label,
          quantity: row.quantity,
          paidAt: row.paid_at,
          sourceKind: 'order',
          whenLabel: null,
        })
      })
    return () => { cancelled = true }
  }, [proofId, materialId])

  // Second source: the Reorder desk's own snapshot, for a customer whose
  // history predates this app (docs/reorder-register-rescrape-spec.md Part B).
  //
  // ⚠ Reads the PROOF's own reengagement_context rather than querying the
  // register. That is the whole design. A register lookup keyed on the contact
  // cannot tell "the customer's previous purchase" from "the order already sitting
  // on this proof" — the nightly reconcile folds app payments back into the
  // register, and the only available discriminator is a date whose two sides
  // come from different clocks (Xero's invoice date vs Stripe's payment stamp,
  // measured 1-16 days apart on live). Measured: 14 of 17 answers such a lookup
  // returned were the proof's OWN order handed back as the previous one. The
  // snapshot on the proof was written once, at outreach time, from history that
  // was already complete then — so it cannot echo an order placed afterwards.
  //
  // ⚠ Converted by previousSpecFromReengagement, never re-derived here. That
  // helper refuses the WHOLE spec on a material mismatch, never emits a label
  // without its id, and never emits a finish — and it is the same function the
  // customer's own proof page uses, so the two can never disagree about what
  // this customer last bought. Anything that re-implements those rules in this
  // modal is a bug.
  useEffect(() => {
    if (!proofId || !materialId) return
    if (prevSuggestion?.sourceKind === 'order') return // an order we hold always wins
    let cancelled = false
    void supabase
      .from('proofs')
      .select('reengagement_context')
      .eq('id', proofId)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled || !data) return
        const ctx = parseReengagementContext(
          (data as { reengagement_context?: unknown }).reengagement_context,
        )
        const spec = previousSpecFromReengagement(ctx, { materialId })
        if (!spec) return
        setPrevSuggestion((cur) => {
          if (cur?.sourceKind === 'order') return cur
          return {
            variantId: spec.variant_id,
            variantLabel: spec.variant_label,
            optionId: spec.option_id,
            optionLabel: spec.option_label,
            quantity: spec.quantity,
            // ⚠ No timestamp on this path, deliberately. The register stores a
            // DATE; casting it to a timestamptz uses the server's timezone
            // while the client formats in the browser's, which slides a
            // 1st-of-month into the previous month west of Greenwich. The
            // month is pre-formatted by formatOrderMonth instead.
            paidAt: null,
            sourceKind: 'register',
            whenLabel: spec.label,
          }
        })
      })
    return () => { cancelled = true }
  }, [proofId, materialId, prevSuggestion?.sourceKind])

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
  // Open-spec eligibility (000298): pills are offered when the choice is real.
  // The MODE is what's authoritative for the payload; eligibility only drives
  // the UI + defaults, so a material change that removes the choice can't
  // strand a stale 'customer' mode in the payload.
  const thicknessEligible =
    !lockedFromProof && variants.length > 1 && variants.every((v) => v.variant_type === 'thickness')
  const finishEligible =
    materialOptions.length > 1 &&
    (materialOptionCodes.length >= 2 || finishIsPreferenceOnly(materialCode))
  const thicknessCustomer = thicknessEligible && thicknessMode === 'customer' && !isCustomQuote && orderType !== 'prototype'
  const finishCustomer = finishEligible && finishMode === 'customer' && !isCustomQuote && orderType !== 'prototype'
  // "Their last order" (000364) render helpers. The section only shows when
  // some pay-page chooser could actually carry the guidance (an all-locked
  // order would store a spec the customer never sees, with the designer
  // believing otherwise), and the preview line states what will genuinely
  // render given the current open/locked choices rather than always
  // promising the badge.
  const prevSectionAvailable = thicknessEligible || finishEligible || quantityMode === 'open'
  const prevQtyParsed = parseInt(prevQuantity, 10)
  const prevQtyValid = Number.isInteger(prevQtyParsed) && prevQtyParsed > 0
  const prevBadgeShows = (thicknessCustomer && prevVariantId !== '') || (finishCustomer && prevOptionId !== '')
  const prevHintShows = quantityMode === 'open' && prevQtyValid
  // Estimate weight: the chosen variant's; when the customer will choose the
  // thickness at checkout, estimate at the HEAVIEST offered variant so the
  // indicative figure is the ceiling, not a lowball (the real charge is rated
  // at checkout against their actual pick).
  const heaviestVariant = variants.reduce<VariantOption | null>(
    (acc, v) => (v.weight_grams != null && (acc?.weight_grams == null || v.weight_grams > acc.weight_grams) ? v : acc),
    null,
  )
  const estimateVariant = thicknessCustomer ? heaviestVariant : selectedVariant
  const estimateWeightGrams = estimateVariant?.weight_grams ?? null
  // Per-person split: whether to use it (locked + multiple names) and its sum.
  const usePerPersonSplit = personNames.length > 1
  const lockedSplitSum = personNames.reduce((acc, n) => {
    const v = parseInt(personQty[n] ?? '', 10)
    return acc + (Number.isFinite(v) && v > 0 ? v : 0)
  }, 0)
  // The locked order's total quantity: the per-person sum when splitting, else
  // the single quantity field.
  const lockedQty = usePerPersonSplit ? lockedSplitSum : (Number(quantity) || 0)
  // The quantity the estimate is based on: a locked order's quantity (so the
  // estimate tracks the real order size), else the editable estimate field.
  // One source per mode — no second input competing with the order quantity.
  const estimateBasisQty = quantityMode === 'locked' ? (lockedQty > 0 ? String(lockedQty) : '') : estimateQty
  useEffect(() => {
    const needsEstimate = shippingTreatment === 'full_cost' || shippingTreatment === 'goodwill'
    const qty = parseInt(estimateBasisQty, 10)
    if (
      isCustomQuote ||
      orderType === 'prototype' ||
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
    orderType,
  ])

  // Load the admin-editable order message template once on mount, so it's
  // ready by the time an order is created. Failure leaves it null → the result
  // effect falls back to the code default.
  useEffect(() => {
    let cancelled = false
    void supabase
      .from('reply_templates')
      .select('id, body')
      .in('id', ['order_payment_link', 'order_confirmation_link'])
      .then(({ data }) => {
        if (cancelled || !data) return
        for (const row of data as { id: string; body: string }[]) {
          if (typeof row.body !== 'string') continue
          if (row.id === 'order_payment_link') setOrderTemplateBody(row.body)
          else if (row.id === 'order_confirmation_link') setOrderConfirmTemplateBody(row.body)
        }
      })
    return () => { cancelled = true }
  }, [])

  // Pre-fill the customer email body once the order (and its pay-link) exists,
  // rendering the order template with the pay-page link. The designer can edit
  // this before sending it via Help Scout.
  useEffect(() => {
    if (!result) return
    const url = customerOrderUrl(result.id, result.token)
    const body = paymentMethod === 'offline'
      ? (orderConfirmTemplateBody ?? DEFAULT_BODIES.order_confirmation_link)
      : (orderTemplateBody ?? DEFAULT_BODIES.order_payment_link)
    setMessage(renderTemplate(body, { order_url: url }))
  }, [result, orderTemplateBody, orderConfirmTemplateBody, paymentMethod])

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
  const isPrototype = orderType === 'prototype'

  async function submit() {
    setError(null)
    if (currencyMissing) {
      setError('This proof has no single currency, so it can’t be ordered here yet.')
      return
    }
    if (!isPrototype && !isCustomQuote && variants.length > 0 && !variantId && !thicknessCustomer) {
      setError('Please choose which option this order is for, or let the customer choose at checkout.')
      return
    }
    // Custom quote with a real thickness choice (metal etc.): the designer must
    // pick which one, so the order carries a weighable variant. Without it an
    // international order can't be rated at checkout ("no parcel weight").
    if (!isPrototype && isCustomQuote && thicknessEligible && !variantId) {
      setError('Please choose the card thickness — it sets the shipping weight and production spec (the agreed price is unchanged).')
      return
    }
    let quantityValue: number | null = null
    let personQuantitiesPayload: { name: string; quantity: number }[] | null = null
    if (isPrototype) {
      // A prototype is the flat per-family fee (server-resolved) for 1–3 copies.
      if (!prototypeEligible || prototypeFee == null) {
        setError('Prototyping isn’t available for this material — an admin can enable it under Admin → Prototype prices.')
        return
      }
      if (!prototypeVariantId) {
        setError('Couldn’t resolve the material for this prototype — close and reopen the order.')
        return
      }
      const c = parseInt(copies, 10)
      if (!Number.isInteger(c) || c < 1 || c > 3) {
        setError('Choose how many copies (1–3) for this prototype.')
        return
      }
      quantityValue = c
    } else if (quantityMode === 'locked') {
      if (namesCount > 1) {
        // Multi-name proof: a per-person split is REQUIRED so production knows
        // how many of each name to make — a locked total alone is ambiguous.
        // (Open "customer chooses" orders capture the split at checkout.)
        if (personNames.length === 0) {
          setError("Recipient names haven't loaded yet — close and reopen the order, then try again.")
          return
        }
        const entries = personNames.map((n) => ({ name: n, quantity: parseInt(personQty[n] ?? '', 10) }))
        if (entries.some((e) => !Number.isInteger(e.quantity) || e.quantity <= 0)) {
          setError(isCustomQuote
            ? 'Enter a quantity (greater than zero) for each person — the agreed price needs the quantities it covers.'
            : 'Enter a quantity (greater than zero) for each person, or let the customer choose.')
          return
        }
        personQuantitiesPayload = entries
        quantityValue = entries.reduce((acc, e) => acc + e.quantity, 0)
      } else {
        const q = Number(quantity)
        if (!Number.isInteger(q) || q <= 0) {
          setError(isCustomQuote
            ? 'Enter a whole quantity greater than zero — the agreed price needs the quantity it covers.'
            : 'Enter a whole quantity greater than zero, or let the customer choose.')
          return
        }
        quantityValue = q
      }
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

    // Destination-country hint, persisted for every treatment: full_cost /
    // goodwill use it to pre-fill the pay-page rating, and any treatment uses
    // it to flag a US order for tariff & customs handling (added by default,
    // opt-out at checkout). goodwill also needs the discount %.
    const shipDestCountryValue: string | null = shipDestCountry || null
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
    if (!isPrototype && isCustomQuote) {
      // An EMPTY box must not save. Number('') is 0, so a blank field used to
      // sail past this check and store an agreed price of £0 — which then also
      // wiped any card discount (resolveCardDiscount returns 0 on a zero base)
      // and left checkout charging shipping only. Reject blank explicitly, and
      // require a total above zero: a genuine £0 order is a prototype (handled
      // above) or a reprint (created elsewhere), never a custom quote.
      const raw = customQuoteTotal.trim()
      const c = Number(raw)
      if (raw === '' || !Number.isFinite(c) || c <= 0) {
        setError(versionIsCustomQuote
          ? 'This is a custom-quote proof — enter the agreed total.'
          : 'Enter the agreed total, or switch Pricing back to the catalogue price.')
        return
      }
      customQuoteValue = c
    }
    let cardDiscountValueParsed: number | null = null
    if (!isPrototype && cardDiscountType !== 'none') {
      const v = Number(cardDiscountValue)
      if (!Number.isFinite(v) || v <= 0) {
        setError(cardDiscountType === 'percent' ? 'Enter a card discount percentage above 0.' : 'Enter a card discount amount above 0.')
        return
      }
      if (cardDiscountType === 'percent' && v > 100) {
        setError('Enter a card discount percentage between 0 and 100%.')
        return
      }
      cardDiscountValueParsed = v
    }

    // Offline orders are recorded as already paid, so they need a fixed
    // quantity and a shipping figure we can settle without the pay page. The
    // UI enforces both (locked quantity, free/manual shipping); guard anyway.
    if (paymentMethod === 'offline') {
      if (thicknessCustomer || finishCustomer) {
        setError('Offline orders need the thickness and finish locked — the customer never sees the pay page.')
        return
      }
      if (quantityValue == null) {
        setError('Offline orders need a locked quantity — switch to “Lock a quantity”.')
        return
      }
      if (shippingTreatment !== 'free' && shippingTreatment !== 'manual') {
        setError('Offline orders use free or manual shipping (live rates need the online pay page).')
        return
      }
      if (!shipDestCountryValue) {
        setError('Choose a destination for the order — it sets the packaging (UK = domestic box, anywhere else = international box).')
        return
      }
    }

    // Xero customer is a required, explicit choice for online orders, so a new
    // Xero contact is never created by accident. (Offline is invoiced by hand.)
    if (paymentMethod === 'online') {
      if (xeroMode === null) {
        setError('Choose whether this is an existing Xero customer or a new one.')
        return
      }
      if (xeroMode === 'existing' && !xeroContact) {
        setError('Search and pick the existing Xero customer — or switch to “New customer”.')
        return
      }
      if (xeroMode === 'new' && !newCustomerName.trim()) {
        setError('Enter a name for the new Xero customer.')
        return
      }
    }

    // "Their last order" (000364): assembled only when the section is engaged
    // (and still visible — a hidden section must never send its stale state)
    // and names at least one of thickness / finish / quantity — a bare "when"
    // guides nobody. Online production only; the server enforces the same.
    const previousSpecPayload = (() => {
      if (!prevEngaged || isPrototype || isCustomQuote || paymentMethod !== 'online') return null
      if (!prevSectionAvailable) return null
      const q = parseInt(prevQuantity, 10)
      const spec = {
        variant_id: prevVariantId || null,
        variant_label: prevVariantLabel.trim() || null,
        option_id: prevOptionId || null,
        option_label: prevOptionLabel.trim() || null,
        quantity: Number.isInteger(q) && q > 0 ? q : null,
        label: prevWhen.trim() || null,
        source: prevSource,
      }
      return spec.variant_id || spec.option_id || spec.quantity != null ? spec : null
    })()

    setSubmitting(true)
    try {
      const { data, error: fnError } = await supabase.functions.invoke<
        | { id: string; token: string; status: string; payment_reference: string }
        | { error: string }
      >('create-order', {
        body: {
          proof_id: proofId,
          // 'production' (default) | 'prototype'. For a prototype, create-order
          // resolves the flat per-family fee itself and sets custom_quote_total
          // — so the client never sends a price here.
          order_kind: isPrototype ? 'prototype' : 'production',
          currency,
          payment_method: paymentMethod,
          // Prototype: the copies count (1–3) drives shipping weight + the
          // production instruction; the fee is flat regardless.
          quantity: quantityValue,
          person_quantities: isPrototype ? null : personQuantitiesPayload,
          names_count: isPrototype ? 1 : namesCount,
          has_personalisation: isPrototype ? false : hasPersonalisation,
          shipping_treatment: shippingTreatment,
          shipping_charged: shippingChargedValue,
          shipping_discount_percent: shippingDiscountPercentValue,
          // A prototype is a flat fee — no card discount.
          card_discount_type: isPrototype ? 'none' : cardDiscountType,
          card_discount_value: isPrototype ? null : cardDiscountValueParsed,
          card_discount_reason: isPrototype ? undefined : (cardDiscountReason.trim() || undefined),
          ship_dest_country: shipDestCountryValue,
          // Manual VAT-treatment override (GBP only; server ignores it for
          // EUR/USD, which are VAT-free regardless). 'auto' = decide from the
          // destination.
          vat_treatment: currency === 'GBP' ? vatTreatment : 'auto',
          // Prototype: server resolves + sets the fee, so don't send a total.
          custom_quote_total: isPrototype ? null : customQuoteValue,
          // Persist the chosen thickness + finish even on a custom quote: they're
          // the production spec (what the supplier makes), not pricing. The custom
          // total still drives the charge; dropping these used to leave the supplier
          // hand-off with no Thickness/Finish line. Null when none was picked (e.g. a
          // mixed-material variant round), which stays harmless. A prototype attaches
          // the resolved prototype variant (its Xero item code + weight).
          material_variant_id: isPrototype ? prototypeVariantId : thicknessCustomer ? null : variantId,
          material_option_id: finishCustomer ? undefined : (optionId ?? undefined),
          // Open-spec (000298): the customer chooses these on the pay page.
          // material_id lets the server validate their pick + the pay page
          // list the offerable variants when no variant is locked.
          material_id: materialId ?? undefined,
          thickness_open: thicknessCustomer,
          finish_open: finishCustomer,
          // "Their last order" (000364): display guidance for the pay-page
          // choosers. Only sent when the designer engaged the section and it
          // says something (a bare date guides nobody); the server sanitises
          // and drops it for offline/prototype/custom-quote orders anyway.
          previous_spec: previousSpecPayload,
          // Online only — an offline order is invoiced manually in Xero.
          // Existing → bind to the chosen contact (id + name). New → no id (the
          // webhook lets Xero create one) but we pass the name so the new contact
          // is the customer, not whoever pays; null id + null name only on offline.
          xero_contact_id: paymentMethod === 'online' && xeroMode === 'existing' ? (xeroContact?.id ?? null) : null,
          xero_contact_name:
            paymentMethod === 'online'
              ? xeroMode === 'existing'
                ? (xeroContact?.name ?? null)
                : xeroMode === 'new'
                  ? (newCustomerName.trim() || null)
                  : null
              : null,
        },
      })
      if (fnError || !data || 'error' in data) {
        // A guard rejection (e.g. a live pay link already exists — 409) comes
        // back as a FunctionsHttpError with the message in the Response body,
        // not in `data`, so read it out to show the real reason. Mirrors the
        // send-helpscout-reply handler above.
        let msg = (data as { error?: string } | null)?.error ?? null
        const ctx = (fnError as { context?: Response } | null)?.context
        if (!msg && ctx && typeof ctx.json === 'function') {
          try { const b = await ctx.json(); if (b && typeof b.error === 'string') msg = b.error } catch { /* not JSON */ }
        }
        setError(msg ?? 'Could not create the order. Please try again.')
        return
      }
      setResult({ id: data.id, token: data.token, payment_reference: data.payment_reference })
      // Re-read the bundle NOW, not from what the form opened with. This is the
      // last look before the send button appears, and a customer can approve or
      // ask for changes while a designer fills the form in.
      void fetchBundleHint(proofId).then(setBundle)
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

  // Backdrop / Esc / Cancel all route through here so an accidental click-off
  // can't wipe a part-filled form. Once the order's created (result set) there's
  // nothing to lose, and a pristine form closes without nagging.
  function handleDismiss() {
    if (result || !dirty) {
      onClose()
      return
    }
    if (window.confirm('Discard this order? Anything you’ve entered will be lost.')) onClose()
  }

  return (
    <Modal
      open
      onClose={handleDismiss}
      ariaLabel="Create order"
      panelClassName="w-full max-w-lg md:max-w-3xl md:max-h-[88vh] overflow-y-auto rounded-2xl bg-white shadow-xl"
    >
      {result ? (
        // ── Success ──────────────────────────────────────────────
        <div className="p-6">
          <h2 className="text-lg font-semibold text-ink">{paymentMethod === 'offline' ? 'Order recorded as paid' : 'Order created'}</h2>
          <p className="mt-1 text-sm text-ink-soft">
            Reference <span className="font-medium text-ink">{result.payment_reference}</span>
            {customerLabel ? ` for ${customerLabel}` : ''}.
          </p>

          {/* Offline → recorded as paid; the link below is an order confirmation
              (not a pay link), which the designer sends manually. */}
          {paymentMethod === 'offline' && (
            <div className="mt-4 rounded-lg border border-in-stock bg-in-stock-soft px-3 py-2.5 text-[13px] text-ink">
              Recorded as paid (offline) — it&rsquo;s now in the order queue, ready to order. Raise the invoice in Xero when you&rsquo;re ready. You can send the customer their order link below — it doubles as their tracking page.
            </div>
          )}

          {sent ? (
            // Sent confirmation.
            <>
              <div className="mt-4 rounded-lg border border-in-stock bg-in-stock-soft px-3 py-2.5 text-[13px] text-ink">
                {paymentMethod === 'offline'
                  ? 'Order confirmation sent to the customer on Help Scout. They’ll get it by email.'
                  : 'Payment link sent to the customer on Help Scout. They’ll get it by email.'}
              </div>
              <div className="mt-5 flex items-center justify-end gap-2">
                <ButtonGhost onClick={copyLink}>{copied ? 'Copied' : 'Copy link'}</ButtonGhost>
                <ButtonCoral onClick={onClose}>Done</ButtonCoral>
              </div>
            </>
          ) : hasHelpScoutConversation ? (
            // Send via Help Scout — editable message with the link embedded.
            <>
              {/* The last gate. The order exists, but the customer has seen
                  nothing until this button is pressed — and this reading of
                  the bundle was taken when the order was created, seconds
                  ago, not when the form was opened. */}
              {bundle && bundle.outstanding.length > 0 && (
                <div className="mt-4">
                  <BundleWarning bundle={bundle} beforeSend />
                </div>
              )}
              <p className="mt-3 text-[13px] text-ink-soft">
                {paymentMethod === 'offline'
                  ? 'Send an order confirmation with their order link to the customer on the linked Help Scout conversation:'
                  : 'Send the payment link to the customer on the linked Help Scout conversation:'}
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
                This proof has no linked Help Scout conversation, so copy the order link and send it to the customer yourself.
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
          {/* Sticky header — stays put while the body scrolls, so the customer
              + material context is always visible. */}
          <div className="sticky top-0 z-10 border-b border-line-soft bg-white px-6 pt-6 pb-4">
            <h2 className="text-lg font-semibold text-ink">Create order</h2>
            <p className="mt-1 text-sm text-ink-soft">
              {customerLabel ? `For ${customerLabel}. ` : ''}
              {materialDisplay ?? 'Material'} · {currency ?? '—'}
              {namesCount > 1 ? ` · ${namesCount} people` : ''}
              {hasPersonalisation ? ' · personalisation' : ''}
            </p>
          </div>

          {/* Scrollable body. Two columns on desktop (md+), a single stack on
              mobile. The onChange catches any input/select/textarea edit and
              marks the form dirty so the dismiss guard can warn before binning
              it; the button pickers below call setDirty themselves. */}
          <div className="px-6 py-5" onChange={() => setDirty(true)}>
            {currencyMissing && (
              <div className="mb-4 rounded-lg border border-low bg-low-soft px-3 py-2 text-[13px] text-ink">
                This proof has no single currency (a per-direction-pricing round), so it can&rsquo;t be ordered through this flow yet.
              </div>
            )}

            {/* Stranded-approval guard (bundle-orders spec §12.2). Cards
                approved on a superseded version in a different material can't
                be ordered from here — only the current version's card is. Warn
                by name so the designer doesn't assume they're covered. */}
            {/* Bundle guard. This card is one of several the customer is
                reviewing on one link, and the others aren't signed off — so
                this order covers one card of a set they may well expect to
                buy together. Advisory: sometimes selling the approved card
                now is exactly right, and the rest can join a combined
                payment later. */}
            {bundle && bundle.outstanding.length > 0 && (
              <BundleWarning bundle={bundle} />
            )}

            {strandedApprovals.length > 0 && (
              <div className="mb-4 rounded-lg border border-low bg-low-soft p-3 text-[13px] leading-[1.6] text-ink-soft">
                <p className="font-semibold text-ink">Some approved cards aren’t part of this order</p>
                <p className="mt-1">
                  This order covers the current card{materialDisplay ? ` (${materialDisplay})` : ''} only.
                  These were approved on an earlier version in a different material and{' '}
                  <strong>can’t be ordered from here</strong>:
                </p>
                <ul className="mt-1.5 list-disc space-y-0.5 pl-5">
                  {strandedApprovals.map((c) => (
                    <li key={c.versionId}>
                      {c.names.join(', ')} — v{c.versionNumber}{c.material ? ` (${c.material})` : ''}
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-ink-mute">To sell those too, build them as a separate project.</p>
              </div>
            )}

            <div className="grid grid-cols-1 gap-x-5 gap-y-5 md:grid-cols-2">
            {/* Order type — a normal production order, or the flat-fee
                prototyping service (up to three copies of the approved design).
                Internal-only; never shown to customers except on their private
                pay link. */}
            <Field
              label="Order type"
              asLabel={false}
              className="md:col-span-2"
              hint="A normal card order, or a prototype: up to three exact copies of the approved design at a flat fee, shipping on top."
            >
              <div className="flex flex-wrap gap-2">
                {([['production', 'Production order'], ['prototype', 'Prototype sample']] as const).map(([t, label]) => {
                  const blocked = t === 'prototype' && prototypeEligible === false
                  return (
                    <button
                      key={t}
                      type="button"
                      disabled={blocked}
                      title={blocked ? 'Prototyping isn’t set up for this material — enable it under Admin → Prototype prices' : undefined}
                      onClick={() => { setDirty(true); setOrderType(t); if (t === 'prototype') setCardDiscountType('none') }}
                      className={[
                        'rounded-full px-4 py-1.5 text-sm font-medium transition-colors',
                        orderType === t ? 'bg-ink text-on-ink' : 'bg-surface text-ink-soft ring-1 ring-line hover:bg-canvas',
                        blocked ? 'cursor-not-allowed opacity-40' : '',
                      ].join(' ')}
                    >
                      {label}
                    </button>
                  )
                })}
              </div>
              {orderType === 'prototype' && prototypeEligible === false && (
                <p className="mt-2 text-[13px] text-ink-soft">Prototyping isn’t available for this material yet.</p>
              )}
            </Field>

            {/* Pricing basis — how THIS order is priced. Sits second, directly
                under Order type, so everything it changes (the Option field's
                open-spec pills, whether a variant must be picked, the agreed
                total) is below it rather than above. A custom-quote proof has
                no choice to offer: there was never a price grid to bill from. */}
            {!isPrototype && (
              <Field
                label="Pricing"
                asLabel={false}
                className="md:col-span-2"
                // One explanation at a time, in the Field's own hint slot —
                // an inline note plus the hint stacked two paragraphs of
                // near-identical prose under the pills.
                hint={versionIsCustomQuote
                  ? 'This proof is a custom quote, so the order is billed at the figure you agreed. Shipping and any US tariff are added on top.'
                  : isCustomQuote
                    ? 'Billed as a single “Agreed price” line at checkout and on the invoice — shipping and any US tariff are added on top. The proof page keeps showing its own price grid.'
                    : 'Bill from the catalogue price tiers at checkout, or charge one figure you’ve agreed with the customer. The proof page keeps showing its own price grid either way.'}
              >
                {!versionIsCustomQuote && (
                  <div className="flex flex-wrap gap-2">
                    {([['catalogue', 'Catalogue price'], ['custom', 'Agreed price']] as const).map(([b, label]) => (
                      <button
                        key={b}
                        type="button"
                        onClick={() => {
                          setPricingBasis(b)
                          setDirty(true)
                          // Don't leave a typed figure behind when switching back.
                          // submit() ignores it, but a stale number reappearing on
                          // a second switch reads as something already saved.
                          if (b === 'catalogue') setCustomQuoteTotal('')
                        }}
                        className={[
                          'rounded-full px-4 py-1.5 text-sm font-medium transition-colors',
                          pricingBasis === b ? 'bg-ink text-on-ink' : 'bg-surface text-ink-soft ring-1 ring-line hover:bg-canvas',
                        ].join(' ')}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                )}
                {isCustomQuote && (
                  <div className={versionIsCustomQuote ? '' : 'mt-3'}>
                    <label htmlFor="order-custom-total" className="mb-1 block text-[13px] text-ink-soft">
                      Agreed total ({currency ?? 'GBP'})
                    </label>
                    <Input
                      id="order-custom-total"
                      type="number"
                      min={0}
                      step={0.01}
                      inputMode="decimal"
                      value={customQuoteTotal}
                      onChange={(e) => { setCustomQuoteTotal(e.target.value); setDirty(true) }}
                      placeholder={`Total (${currency ?? 'GBP'})`}
                      className="max-w-[240px]"
                    />
                  </div>
                )}
              </Field>
            )}

            {/* Prototype fee + copies — replaces the variant/quantity/pricing
                fields when the order type is a prototype. */}
            {isPrototype && (
              <Field
                label="Prototype sample"
                asLabel={false}
                className="md:col-span-2"
                hint="Flat fee for up to three exact copies of the approved design. Shipping is added on top at checkout."
              >
                <div className="rounded-lg border border-line bg-canvas p-3">
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="text-ink-soft">{materialDisplay ?? 'Material'} prototype</span>
                    <span className="text-base font-semibold text-ink">
                      {prototypeFee != null ? formatPrice(prototypeFee, currency ?? 'GBP') : '—'}
                    </span>
                  </div>
                  <p className="mt-1 text-[12px] text-ink-mute">
                    Flat fee for 1–3 copies. {currency === 'GBP' ? (isGbpOrderVatFree(vatTreatment, shipDestCountry) ? 'VAT-free (export).' : 'Includes VAT.') : 'VAT-free.'} Shipping calculated at checkout.
                  </p>
                </div>
                <div className="mt-3">
                  <p className="text-[13px] text-ink-soft">Copies</p>
                  <div className="mt-1 flex flex-wrap gap-2">
                    {(['1', '2', '3'] as const).map((n) => (
                      <button
                        key={n}
                        type="button"
                        onClick={() => { setCopies(n); setDirty(true) }}
                        className={[
                          'rounded-full px-4 py-1.5 text-sm font-medium transition-colors',
                          copies === n ? 'bg-ink text-on-ink' : 'bg-surface text-ink-soft ring-1 ring-line hover:bg-canvas',
                        ].join(' ')}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                </div>
              </Field>
            )}

            {/* Variant — grid orders only; sets the price tiers the
                server prices against. */}
            {!isPrototype && (
              <Field
                label="Option"
                htmlFor="order-variant"
                hint={isCustomQuote
                  ? 'Which thickness these cards are — sets the shipping weight and production spec. The agreed price is unchanged.'
                  : 'Which variant this order is for — sets the price used at checkout.'}
              >
                {/* Open-spec pills (000298): a real thickness choice (metal
                    etc.) defaults to the customer picking on the pay page,
                    where they get the thickness guide + live prices. Locking
                    stays one click away; offline forces locked. Not offered on
                    a custom quote — its price is agreed, so the spec is locked. */}
                {thicknessEligible && !isCustomQuote && (
                  <div className="mb-2 flex flex-wrap gap-2">
                    {([['customer', 'Customer chooses at checkout'], ['locked', 'Lock it now']] as const).map(([m, label]) => {
                      const blocked = paymentMethod === 'offline' && m === 'customer'
                      return (
                        <button
                          key={m}
                          type="button"
                          disabled={blocked}
                          title={blocked ? 'Offline orders never reach the pay page, so the spec must be locked' : undefined}
                          onClick={() => { setThicknessMode(m); setDirty(true) }}
                          className={[
                            'rounded-full px-4 py-1.5 text-sm font-medium transition-colors',
                            thicknessMode === m ? 'bg-ink text-on-ink' : 'bg-surface text-ink-soft ring-1 ring-line hover:bg-canvas',
                            blocked ? 'cursor-not-allowed opacity-40' : '',
                          ].join(' ')}
                        >
                          {label}
                        </button>
                      )
                    })}
                  </div>
                )}
                {variantsLoading ? (
                  <p className="text-sm text-ink-mute">Loading options…</p>
                ) : variants.length === 0 ? (
                  <p className="text-sm text-ink-mute">
                    {isCustomQuote
                      ? 'No thickness options found for this material.'
                      : 'No priced options found for this material/currency. You can still create the order, but it won’t be payable online yet.'}
                  </p>
                ) : thicknessCustomer ? (
                  <p className="text-sm text-ink-soft">
                    They&rsquo;ll choose from {variants.map((v) => v.display_name).join(' / ')} on the pay page, with a thickness guide and live prices for each.
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
                price includes any finish surcharge at checkout. Hidden for a
                prototype — the finish is the approved design's, auto-applied. */}
            {!isPrototype && materialOptions.length > 0 && (
              <Field
                label={optionLabel}
                asLabel={false}
                hint={isCustomQuote
                  // An agreed price is billed at face value, so there's no
                  // surcharge to mention — but the finish is still a PRODUCTION
                  // spec that reaches the supplier, exactly like the thickness
                  // above. It was always CAPTURED on a custom quote (the effect
                  // that loads the options auto-applies the offered/base one);
                  // showing the picker just makes it visible and correctable,
                  // which matters now the agreed price can sit on a standard
                  // proof whose tabbed finish isn't necessarily what was agreed.
                  ? `Which ${optionLabel.toLowerCase()} these cards are — part of the production spec. The agreed price is unchanged.`
                  : `Which ${optionLabel.toLowerCase()} the customer is ordering — the price includes any ${optionLabel.toLowerCase()} surcharge at checkout.`}
              >
                {/* Open-spec pills (000298): offered when the approved
                    version carried 2+ finish tabs — a single-finish proof's
                    artwork IS that finish, so it stays a designer pick — or
                    when the finish is preference-only (gloss/matte, 000303),
                    which never appears on the artwork at all. Not offered on an
                    agreed price: the total is fixed, so there's nothing for the
                    customer's pick to reprice (mirrors the thickness rule). */}
                {finishEligible && !isCustomQuote && (
                  <div className="mb-2 flex flex-wrap gap-2">
                    {([['customer', 'Customer chooses at checkout'], ['locked', 'Lock it now']] as const).map(([m, label]) => {
                      const blocked = paymentMethod === 'offline' && m === 'customer'
                      return (
                        <button
                          key={m}
                          type="button"
                          disabled={blocked}
                          title={blocked ? 'Offline orders never reach the pay page, so the spec must be locked' : undefined}
                          onClick={() => { setFinishMode(m); setDirty(true) }}
                          className={[
                            'rounded-full px-4 py-1.5 text-sm font-medium transition-colors',
                            finishMode === m ? 'bg-ink text-on-ink' : 'bg-surface text-ink-soft ring-1 ring-line hover:bg-canvas',
                            blocked ? 'cursor-not-allowed opacity-40' : '',
                          ].join(' ')}
                        >
                          {label}
                        </button>
                      )
                    })}
                  </div>
                )}
                {finishCustomer ? (
                  <p className="text-sm text-ink-soft">
                    They&rsquo;ll pick {materialOptions.map((o) => o.display_name).join(' / ')} on the pay page — any {optionLabel.toLowerCase()} surcharge is priced in automatically.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {materialOptions.map((o) => (
                      <button
                        key={o.id}
                        type="button"
                        onClick={() => { setOptionId(o.id); setDirty(true) }}
                        className={[
                          'rounded-full px-4 py-1.5 text-sm font-medium transition-colors',
                          optionId === o.id ? 'bg-ink text-on-ink' : 'bg-surface text-ink-soft ring-1 ring-line hover:bg-canvas',
                        ].join(' ')}
                      >
                        {o.display_name}
                      </button>
                    ))}
                  </div>
                )}
              </Field>
            )}

            {/* "Their last order" (000364) — returning-customer guidance.
                Confirm what they ordered before and the pay-page choosers
                badge the matching option "Your last order" (with a gentle
                note if they pick differently). Auto-suggested from their
                order history when we have it; manual entry covers history
                that only lives in old Help Scout threads or Xero invoices.
                Placed BELOW the order's own Option/Finish fields so the two
                sets of pickers can't be mistaken for each other, and only
                rendered when some chooser could actually carry the guidance
                (prevSectionAvailable) — an all-locked order would store a
                spec the customer never sees. */}
            {!isPrototype && !isCustomQuote && paymentMethod === 'online' && prevSectionAvailable && (
              <Field
                label="Their last order"
                asLabel={false}
                className="md:col-span-2"
                hint="For returning customers: confirm what they had last time and the pay page marks it “Your last order” — same again is one obvious click, something different is a conscious choice."
              >
                {prevEngaged ? (
                  <div className="rounded-lg border border-line bg-canvas p-3">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      {thicknessEligible && (
                        <div>
                          <p className="mb-1 text-[13px] text-ink-soft">Thickness</p>
                          <select
                            value={prevVariantId}
                            onChange={(e) => {
                              const id = e.target.value
                              setPrevVariantId(id)
                              setPrevVariantLabel(
                                variants.find((v) => v.id === id)?.display_name ??
                                  (prevSuggestion?.variantId === id ? prevSuggestion.variantLabel ?? '' : ''),
                              )
                            }}
                            className={selectClass}
                          >
                            <option value="">Not recorded</option>
                            {/* A previous variant that's no longer in the priced
                                list (retired, or another currency) stays
                                selectable — keyed off the suggestion as well as
                                the current value, so picking a live option and
                                changing your mind can still get back to it. */}
                            {[
                              ...(prevVariantId && !variants.some((v) => v.id === prevVariantId)
                                ? [{ id: prevVariantId, label: prevVariantLabel || 'Previous option' }]
                                : []),
                              ...(prevSuggestion?.variantId &&
                              prevSuggestion.variantId !== prevVariantId &&
                              !variants.some((v) => v.id === prevSuggestion.variantId)
                                ? [{ id: prevSuggestion.variantId, label: prevSuggestion.variantLabel || 'Previous option' }]
                                : []),
                            ].map((o) => (
                              <option key={`prev-${o.id}`} value={o.id}>{o.label}</option>
                            ))}
                            {variants.map((v) => (
                              <option key={v.id} value={v.id}>{v.display_name}</option>
                            ))}
                          </select>
                        </div>
                      )}
                      {finishEligible && (
                        <div>
                          <p className="mb-1 text-[13px] text-ink-soft">{optionLabel}</p>
                          <select
                            value={prevOptionId}
                            onChange={(e) => {
                              const id = e.target.value
                              setPrevOptionId(id)
                              setPrevOptionLabel(
                                materialOptions.find((o) => o.id === id)?.display_name ??
                                  (prevSuggestion?.optionId === id ? prevSuggestion.optionLabel ?? '' : ''),
                              )
                            }}
                            className={selectClass}
                          >
                            <option value="">Not recorded</option>
                            {[
                              ...(prevOptionId && !materialOptions.some((o) => o.id === prevOptionId)
                                ? [{ id: prevOptionId, label: prevOptionLabel || 'Previous option' }]
                                : []),
                              ...(prevSuggestion?.optionId &&
                              prevSuggestion.optionId !== prevOptionId &&
                              !materialOptions.some((o) => o.id === prevSuggestion.optionId)
                                ? [{ id: prevSuggestion.optionId, label: prevSuggestion.optionLabel || 'Previous option' }]
                                : []),
                            ].map((o) => (
                              <option key={`prev-${o.id}`} value={o.id}>{o.label}</option>
                            ))}
                            {materialOptions.map((o) => (
                              <option key={o.id} value={o.id}>{o.display_name}</option>
                            ))}
                          </select>
                        </div>
                      )}
                      <div>
                        <p className="mb-1 text-[13px] text-ink-soft">Quantity</p>
                        <input
                          type="number"
                          min={1}
                          step={1}
                          inputMode="numeric"
                          value={prevQuantity}
                          onChange={(e) => setPrevQuantity(e.target.value)}
                          placeholder="e.g. 500"
                          className={selectClass}
                        />
                      </div>
                      <div>
                        <p className="mb-1 text-[13px] text-ink-soft">When (shown to the customer)</p>
                        <input
                          type="text"
                          value={prevWhen}
                          onChange={(e) => setPrevWhen(e.target.value)}
                          placeholder="e.g. March 2022"
                          className={selectClass}
                        />
                      </div>
                    </div>
                    <div className="mt-2.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                      {/* An honest preview: state what will actually render
                          given the current open/locked choices, and never
                          promise the badge when only the quantity hint (or
                          nothing at all) would show. */}
                      <p className="text-[12px] text-ink-mute">
                        {prevBadgeShows ? (
                          <>
                            Shown on the pay page as &ldquo;Your last order{prevWhen.trim() ? ` · ${prevWhen.trim()}` : ''}&rdquo;
                            {prevHintShows ? ', plus the previous quantity under the quantity box' : ''}.
                          </>
                        ) : prevHintShows ? (
                          <>Shown under the pay page&rsquo;s quantity box as &ldquo;Last time you ordered {prevQtyParsed.toLocaleString()}&rdquo;.</>
                        ) : (
                          <>Add the thickness, finish or quantity they had — whichever the customer will choose at checkout — and it&rsquo;ll show on the pay page.</>
                        )}
                      </p>
                      <button
                        type="button"
                        onClick={() => {
                          setPrevEngaged(false)
                          setPrevSource('manual')
                          setPrevVariantId('')
                          setPrevVariantLabel('')
                          setPrevOptionId('')
                          setPrevOptionLabel('')
                          setPrevQuantity('')
                          setPrevWhen('')
                          setDirty(true)
                        }}
                        className="text-[13px] font-medium text-ink-soft underline hover:text-ink"
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                ) : prevSuggestion && !prevDismissed ? (
                  <div className="rounded-lg border border-line bg-canvas p-3">
                    <p className="text-sm text-ink">
                      Last time they ordered{' '}
                      <span className="font-medium">
                        {[
                          prevSuggestion.variantLabel,
                          prevSuggestion.optionLabel,
                          prevSuggestion.quantity != null ? `${prevSuggestion.quantity.toLocaleString()} cards` : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                      {prevSuggestion.sourceKind === 'order' && prevSuggestion.paidAt && (
                        <span className="text-ink-mute"> — paid {formatMonthYear(prevSuggestion.paidAt)}</span>
                      )}
                      {prevSuggestion.sourceKind === 'register' && prevSuggestion.whenLabel && (
                        <span className="text-ink-mute"> — {prevSuggestion.whenLabel}</span>
                      )}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          // Only apply fields whose editors are on screen —
                          // an invisible, unclearable "thickness" on an
                          // ink-count material is state the designer can't
                          // see, in a section that exists to be a visible
                          // confirmation step.
                          setPrevEngaged(true)
                          setPrevSource('auto')
                          setPrevVariantId(thicknessEligible ? prevSuggestion.variantId ?? '' : '')
                          setPrevVariantLabel(thicknessEligible ? prevSuggestion.variantLabel ?? '' : '')
                          setPrevOptionId(finishEligible ? prevSuggestion.optionId ?? '' : '')
                          setPrevOptionLabel(finishEligible ? prevSuggestion.optionLabel ?? '' : '')
                          setPrevQuantity(prevSuggestion.quantity != null ? String(prevSuggestion.quantity) : '')
                          setPrevWhen(
                            prevSuggestion.sourceKind === 'register'
                              ? prevSuggestion.whenLabel ?? ''
                              : formatMonthYear(prevSuggestion.paidAt),
                          )
                          setDirty(true)
                        }}
                        className="rounded-full bg-ink px-4 py-1.5 text-sm font-medium text-on-ink transition-colors hover:opacity-90"
                      >
                        Highlight on the pay page
                      </button>
                      {/* No setDirty here — hiding a pre-fill changes nothing
                          that will be sent, so it mustn't arm the discard
                          nag (same reasoning as the auto-loaded pre-fills). */}
                      <button
                        type="button"
                        onClick={() => setPrevDismissed(true)}
                        className="rounded-full bg-surface px-4 py-1.5 text-sm font-medium text-ink-soft ring-1 ring-line transition-colors hover:bg-canvas"
                      >
                        Not now
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      // "Not now" must be reversible: with a suggestion on
                      // hand this restores its card rather than opening
                      // blank fields the designer would have to re-type.
                      if (prevSuggestion) {
                        setPrevDismissed(false)
                      } else {
                        setPrevEngaged(true)
                        setPrevSource('manual')
                        setDirty(true)
                      }
                    }}
                    className="rounded-full bg-surface px-4 py-1.5 text-sm font-medium text-ink-soft ring-1 ring-line transition-colors hover:bg-canvas"
                  >
                    Add their last order
                  </button>
                )}
              </Field>
            )}

            {/* Payment method */}
            <Field label="Payment" asLabel={false} hint="Send the customer a secure pay link, or record an order they're paying offline (e.g. bank transfer) — it's saved as paid and goes straight to the order queue. You raise the invoice in Xero yourself.">
              <div className="flex flex-wrap gap-2">
                {([['online', 'Send pay link'], ['offline', 'Offline / bank transfer']] as const).map(([m, label]) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => {
                      setDirty(true)
                      setPaymentMethod(m)
                      if (m === 'offline') {
                        // Offline records as paid + you invoice in Xero, so the
                        // app doesn't need shipping cost or an in-app discount.
                        // The customer never sees the pay page, so open-spec
                        // choices must be locked here too.
                        setQuantityMode('locked')
                        setThicknessMode('locked')
                        setFinishMode('locked')
                        setShippingTreatment('free')
                        setCardDiscountType('none')
                      } else {
                        // Back to online: undo the offline-only forcing so stale
                        // state can't leak into the online flow. 'ZZ' is the
                        // offline "International" sentinel — not a real country,
                        // so the online shipping estimate can't rate it; clear it
                        // (a 'GB' Domestic pick is real, so it can stay). Restore
                        // the online shipping + quantity defaults.
                        setQuantityMode('open')
                        setShippingTreatment('full_cost')
                        setShipDestCountry((c) => (c === 'ZZ' ? '' : c))
                      }
                    }}
                    className={[
                      'rounded-full px-4 py-1.5 text-sm font-medium transition-colors',
                      paymentMethod === m ? 'bg-ink text-on-ink' : 'bg-surface text-ink-soft ring-1 ring-line hover:bg-canvas',
                    ].join(' ')}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {paymentMethod === 'offline' && (
                <p className="mt-2 text-[13px] text-ink-soft">
                  Recorded as paid — no link, no Stripe. Needs a set quantity and free/manual shipping.
                </p>
              )}
            </Field>

            {/* Xero customer — online only; an offline order is invoiced
                manually in Xero, so the designer picks the customer there. Sets
                which existing Xero contact the paid invoice files under. */}
            {paymentMethod === 'online' && (
              <Field
                label="Xero customer"
                asLabel={false}
                className="md:col-span-2"
                hint="Choose whether this paid invoice files under an existing Xero customer or creates a new one — so a duplicate contact is never made by accident."
              >
                <div className="flex flex-wrap gap-2">
                  {([['existing', 'Existing customer'], ['new', 'New customer']] as const).map(([m, label]) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => { setXeroMode(m); setDirty(true) }}
                      className={[
                        'rounded-full px-4 py-1.5 text-sm font-medium transition-colors',
                        xeroMode === m ? 'bg-ink text-on-ink' : 'bg-surface text-ink-soft ring-1 ring-line hover:bg-canvas',
                      ].join(' ')}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {xeroMode === null && (
                  <p className="mt-2 text-[13px] text-ink-soft">
                    Pick one to continue — it stops a new Xero contact being created by accident.
                  </p>
                )}

                {/* Existing → search & select; the picker has no "leave blank"
                    escape here (that's the New toggle), so it's purely a finder. */}
                {xeroMode === 'existing' && (
                  <div className="mt-2">
                    <XeroContactPicker
                      value={xeroContact}
                      onChange={(v) => { setXeroContact(v); setDirty(true) }}
                      allowNew={false}
                    />
                  </div>
                )}

                {/* New → name the contact so it's created as the customer (the
                    company), not whoever happens to pay. Defaulted from the proof. */}
                {xeroMode === 'new' && (
                  <div className="mt-2 space-y-1.5">
                    <Input
                      aria-label="New Xero customer name"
                      type="text"
                      value={newCustomerName}
                      onChange={(e) => setNewCustomerName(e.target.value)}
                      placeholder="Name for the new Xero contact (e.g. the company name)"
                    />
                    <p className="text-[12px] text-ink-mute">
                      We&rsquo;ll create this contact in Xero under this name when they pay, and remember it for next time.
                    </p>
                  </div>
                )}
              </Field>
            )}

            {/* Quantity — production orders only; a prototype uses the copies
                picker above. */}
            {!isPrototype && (
            <Field
              label="Quantity"
              asLabel={false}
              hint={isCustomQuote
                ? 'The agreed price covers a set quantity — enter it so the customer sees what they’re paying for.'
                : 'Let the customer choose on the pay-page, or lock a specific quantity now.'}
            >
              <div className="flex flex-wrap gap-2">
                {([['open', 'Customer chooses'], ['locked', 'Lock a quantity']] as const).map(([mode, label]) => {
                  const blocked = (paymentMethod === 'offline' || isCustomQuote) && mode === 'open'
                  return (
                    <button
                      key={mode}
                      type="button"
                      disabled={blocked}
                      title={blocked
                        ? (isCustomQuote
                          ? 'An agreed price can’t be re-priced at checkout — enter the quantity it covers'
                          : 'Offline orders need a set quantity')
                        : undefined}
                      onClick={() => { setQuantityMode(mode); setDirty(true) }}
                      className={[
                        'rounded-full px-4 py-1.5 text-sm font-medium transition-colors',
                        quantityMode === mode ? 'bg-ink text-on-ink' : 'bg-surface text-ink-soft ring-1 ring-line hover:bg-canvas',
                        blocked ? 'cursor-not-allowed opacity-40' : '',
                      ].join(' ')}
                    >
                      {label}
                    </button>
                  )
                })}
              </div>
              {quantityMode === 'locked' && (
                namesCount > 1 ? (
                  personNames.length === 0 ? (
                    <p className="mt-2 text-[13px] text-ink-mute">Loading recipients…</p>
                  ) : (
                  <div className="mt-2 space-y-2">
                    <p className="text-[13px] text-ink-soft">Quantity for each person <span className="text-ink-mute">(required)</span></p>
                    {personNames.map((name) => (
                      <div key={name} className="flex w-full items-center justify-between gap-3">
                        <label htmlFor={`bq-${name}`} title={name} className="min-w-0 flex-1 truncate text-sm text-ink">{name}</label>
                        {/* Fixed-width wrapper: the design-system Input is `w-full`
                            by default, which (in Tailwind v4) beats a `w-24` passed
                            on the element and would stretch the box across the whole
                            row, collapsing the name label to nothing. Constrain the
                            width on the wrapper instead so the name stays visible. */}
                        <div className="w-24 shrink-0">
                          <Input
                            id={`bq-${name}`}
                            type="number"
                            min={1}
                            step={1}
                            inputMode="numeric"
                            value={personQty[name] ?? ''}
                            onChange={(e) => setPersonQty((p) => ({ ...p, [name]: e.target.value }))}
                            placeholder="0"
                            className="text-right"
                          />
                        </div>
                      </div>
                    ))}
                    <div className="flex w-full items-center justify-between gap-3 border-t border-line-soft pt-2 text-sm">
                      <span className="text-ink-soft">Total</span>
                      <span className="font-medium text-ink">{lockedSplitSum > 0 ? `${lockedSplitSum.toLocaleString()} cards` : '—'}</span>
                    </div>
                  </div>
                  )
                ) : (
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
                )
              )}
            </Field>
            )}

            {/* Offline: only the destination matters here (it sets the
                Domestic/International packaging line for production). Shipping
                cost + discount are skipped — you invoice in Xero yourself. */}
            {paymentMethod === 'offline' ? (
              <Field label="Destination" asLabel={false} className="md:col-span-2" hint="Required — sets the packaging line for production: the domestic box for the UK, the international box for everywhere else.">
                <div className="flex flex-wrap gap-2">
                  {/* Backs the production packaging line: Domestic stores 'GB',
                      International stores 'ZZ' (the ISO "international / unspecified"
                      code) — the hand-off reads GB = domestic, anything else =
                      international, so no specific country is needed offline. */}
                  {([['GB', 'Domestic'], ['ZZ', 'International']] as const).map(([code, label]) => {
                    const active = code === 'GB' ? shipDestCountry === 'GB' : (shipDestCountry !== '' && shipDestCountry !== 'GB')
                    return (
                      <button
                        key={code}
                        type="button"
                        onClick={() => { setShipDestCountry(code); setDirty(true) }}
                        className={[
                          'rounded-full px-4 py-1.5 text-sm font-medium transition-colors',
                          active ? 'bg-ink text-on-ink' : 'bg-surface text-ink-soft ring-1 ring-line hover:bg-canvas',
                        ].join(' ')}
                      >
                        {label}
                      </button>
                    )
                  })}
                </div>
              </Field>
            ) : (
            /* Shipping treatment (online) */
            <Field label="Shipping" htmlFor="order-shipping-treatment" className="md:col-span-2" hint="Full cost / Goodwill quote the live carriage at checkout (UK flat DPD rate, or FedEx internationally) — the customer enters their postcode on the pay-page. Goodwill takes a % off. Free = no charge; Manual = a fixed amount.">
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

              {/* Destination country. For full_cost / goodwill it pre-fills the
                  pay-page (the customer confirms it + adds their postcode, and
                  the carriage is rated there). For every treatment it also sets
                  whether US tariff & customs handling applies. */}
              <div className="mt-2">
                <select
                  aria-label="Destination country"
                  value={shipDestCountry}
                  onChange={(e) => setShipDestCountry(e.target.value)}
                  className={selectClass}
                >
                  <option value="">
                    {shippingTreatment === 'full_cost' || shippingTreatment === 'goodwill'
                      ? 'Destination country (optional — customer confirms at checkout)'
                      : 'Destination country (optional — sets US tariff handling)'}
                  </option>
                  {SHIP_COUNTRIES.map((c) => (
                    <option key={c.code} value={c.code}>{c.name}</option>
                  ))}
                </select>
                {shipDestCountry === 'US' && (
                  <p className="mt-2 rounded-lg border border-low bg-low-soft px-3 py-2 text-[13px] text-ink">
                    US destination — US tariff &amp; customs handling will be added to this order by default. The customer can opt out at checkout (and then deals with US Customs themselves).
                  </p>
                )}
                {currency === 'GBP' && isGbpOrderVatFree(vatTreatment, shipDestCountry) && (
                  <p className="mt-2 rounded-lg border border-low bg-low-soft px-3 py-2 text-[13px] text-ink">
                    VAT-free (zero-rated export) — grid prices are charged ex-VAT at checkout (the GBP list price with the VAT element removed) and the invoice carries no VAT. Custom-quote figures are charged exactly as agreed. Keep your proof of export.
                  </p>
                )}
              </div>

              {/* Manual VAT-treatment override (000316). GBP only — EUR/USD are
                  VAT-free regardless. Automatic (default) charges VAT for UK +
                  Isle of Man and zero-rates any other destination as an export;
                  the override is for the rare case the destination alone gets it
                  wrong (e.g. a UK company having us ship straight abroad, or a
                  non-UK delivery that must still carry VAT). */}
              {currency === 'GBP' && (
                <div className="mt-3">
                  <label htmlFor="vat-treatment" className="mb-1 block text-[13px] font-medium text-ink-soft">
                    VAT treatment
                  </label>
                  <select
                    id="vat-treatment"
                    aria-label="VAT treatment"
                    value={vatTreatment}
                    onChange={(e) => setVatTreatment(e.target.value as VatTreatment)}
                    className={selectClass}
                  >
                    <option value="auto">Automatic — decide from the delivery country</option>
                    <option value="export">Zero-rate as export (VAT-free)</option>
                    <option value="standard">Charge UK VAT</option>
                  </select>
                  <p className="mt-1 text-[12px] text-ink-mute">
                    Automatic zero-rates deliveries outside the UK &amp; Isle of Man as exports and charges VAT elsewhere. Override only when the destination alone would get it wrong.
                  </p>
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
              {!isPrototype && (shippingTreatment === 'full_cost' || shippingTreatment === 'goodwill') && shipDestCountry && (
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
                      lockedQty > 0 && <span className="text-ink-soft">for {lockedQty.toLocaleString()} cards</span>
                    )}
                  </div>
                  <div className="mt-2">
                    {estimate.kind === 'loading' && <p className="text-ink-mute">Estimating…</p>}
                    {estimate.kind === 'idle' && (
                      <p className="text-ink-mute">
                        {isCustomQuote
                          ? 'Not estimated for custom quotes.'
                          : variants.length > 1 && !variantId && !thicknessCustomer
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
                          {thicknessCustomer && estimateVariant
                            ? ` Weighed at ${estimateVariant.display_name} (the heaviest they can pick).`
                            : ''}
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
            )}

            {/* Card discount — online only; designer-set, reduces the goods
                subtotal (cards + tooling + personalisation), shown as its own
                negative line on the pay page + invoice. Skipped for offline
                (you invoice in Xero) and for prototypes (the flat fee is the
                price). */}
            {!isPrototype && paymentMethod !== 'offline' && (
            <Field label="Card discount" htmlFor="order-card-discount" className="md:col-span-2" hint="Optional. Reduces the cards, tooling and personalisation subtotal — shows as its own discount line on the pay page and invoice. Shipping and US tariff are not discounted; shipping has its own subsidy above.">
              {offeredDiscount != null && offeredDiscount > 0 && cardDiscountType === 'none' && (
                <div
                  className="mb-2 flex flex-wrap items-center gap-2 rounded-lg px-3 py-2 text-[13px]"
                  style={{ backgroundColor: 'var(--c-in-stock-soft)', boxShadow: 'inset 0 0 0 1px var(--c-in-stock)' }}
                >
                  <span className="text-ink-soft">A <strong>{offeredDiscount}%</strong> recovery discount was offered to this customer.</span>
                  <button
                    type="button"
                    onClick={() => { setCardDiscountType('percent'); setCardDiscountValue(String(offeredDiscount)); setCardDiscountReason('Price-recovery offer') }}
                    className="rounded-md bg-surface px-2.5 py-1 text-[12px] font-medium"
                    style={{ color: 'var(--c-in-stock)', boxShadow: 'inset 0 0 0 1px var(--c-in-stock)' }}
                  >
                    Apply {offeredDiscount}%
                  </button>
                </div>
              )}
              <select
                id="order-card-discount"
                value={cardDiscountType}
                onChange={(e) => setCardDiscountType(e.target.value as CardDiscountType)}
                className={selectClass}
              >
                {CARD_DISCOUNT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              {cardDiscountType !== 'none' && (
                <div className="mt-2 space-y-2">
                  <Input
                    aria-label={cardDiscountType === 'percent' ? 'Card discount percentage' : 'Card discount amount'}
                    type="number"
                    min={0}
                    max={cardDiscountType === 'percent' ? 100 : undefined}
                    step={cardDiscountType === 'percent' ? 1 : 0.01}
                    inputMode={cardDiscountType === 'percent' ? 'numeric' : 'decimal'}
                    value={cardDiscountValue}
                    onChange={(e) => setCardDiscountValue(e.target.value)}
                    placeholder={cardDiscountType === 'percent' ? '% off the cards (e.g. 10)' : `Amount off the cards (${currency ?? 'GBP'})`}
                    className="max-w-[240px]"
                  />
                  <Input
                    aria-label="Card discount reason (optional)"
                    type="text"
                    value={cardDiscountReason}
                    onChange={(e) => setCardDiscountReason(e.target.value)}
                    placeholder="Reason (optional — e.g. goodwill, loyalty)"
                    className="max-w-[320px]"
                  />
                </div>
              )}
            </Field>
            )}

            {/* The agreed total lives with the Pricing basis near the top of
                the form, not down here — one place, and its knock-on effects
                on the Option field are visible below it rather than above. */}
            </div>

            {error && (
              <div className="mt-4 rounded-lg border border-out bg-out-soft px-3 py-2 text-[13px] text-out">{error}</div>
            )}
          </div>

          {/* Sticky footer — Cancel + Create stay reachable however tall the
              form gets, on both the desktop card and the mobile sheet. */}
          <div className="sticky bottom-0 z-10 flex items-center justify-end gap-2 border-t border-line-soft bg-white px-6 py-4">
            <ButtonGhost onClick={handleDismiss} disabled={submitting}>Cancel</ButtonGhost>
            <ButtonCoral onClick={() => void submit()} disabled={submitting || currencyMissing}>
              {submitting ? 'Creating…' : 'Create order'}
            </ButtonCoral>
          </div>
        </div>
      )}
    </Modal>
  )
}

// "The customer is reviewing this card alongside others, and they haven't all
// been signed off."
//
// Same amber callout the Orders worklist card uses, worded for the two moments
// it appears at: while the order is being built ("this order covers…"), and
// once it exists with the send button beneath it ("sending now tells them…").
// The second wording matters — by then the choice isn't whether to build an
// order, it's whether the customer hears about it yet.
//
// It never blocks. Selling one card of a bundle is a real thing to do, and the
// remaining cards can still join a combined payment afterwards; the point is
// that it's a decision somebody made on purpose.
function BundleWarning({ bundle, beforeSend = false }: { bundle: BundleHint; beforeSend?: boolean }) {
  return (
    <div className="rounded-lg border border-low bg-low-soft p-3 text-[13px] leading-[1.6] text-ink-soft">
      <p className="font-semibold text-ink">
        This is one card of a bundle — {bundle.progress}
      </p>
      <p className="mt-1">
        The customer is reviewing these together on one link. Still outstanding:
      </p>
      <ul className="mt-1.5 list-disc space-y-0.5 pl-5">
        {bundle.outstanding.map((o) => (
          <li key={o.id}>
            <span className="text-ink">{o.name}</span> — {o.reason}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-ink-mute">
        {beforeSend
          ? 'Sending now asks them to pay for this card on its own. If the rest are close, hold off and combine the payments once they’re all approved.'
          : 'This order covers this card only. If the rest are close, it’s usually one payment for the lot — wait for them, then combine.'}
      </p>
    </div>
  )
}
