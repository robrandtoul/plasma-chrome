import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { formatPrice } from '../lib/currency'
import type { Currency } from '../lib/types'
import type { QuoteMaterial, QuoteVariant } from '../lib/quote/types'
import { calculate, splitNameSurchargeFor } from '../lib/quote/calculate'
import { usePricing } from '../lib/quote/usePricing'
import { usePersonalisationPricing } from '../lib/quote/usePersonalisationPricing'
import { personalisationSurchargeForQty, personalisationBreakeven } from '../lib/personalisation'
import { getVatRateGbp } from '../lib/vatRateGbp'
import { MaterialPicker } from '../components/quote/MaterialPicker'
import { CollapsedMaterialBar } from '../components/quote/CollapsedMaterialBar'
import { VariantPicker } from '../components/quote/VariantPicker'
import { CurrencyToggle } from '../components/quote/CurrencyToggle'
import { QuantityInput } from '../components/quote/QuantityInput'
import { NamesInput } from '../components/quote/NamesInput'
import { FinishToggle } from '../components/quote/FinishToggle'
import { SpecSummary } from '../components/quote/SpecSummary'
import {
  CustomQuoteFlags,
  EMPTY_CUSTOM_QUOTE_FLAGS,
  isCustomQuote,
  type CustomQuoteFlagsState,
} from '../components/quote/CustomQuoteFlags'
import { CustomQuotePanel } from '../components/quote/CustomQuotePanel'
import { HeadlinePrice } from '../components/quote/HeadlinePrice'
import { AdjacentTiers } from '../components/quote/AdjacentTiers'
import { AdjacentVariants } from '../components/quote/AdjacentVariants'
import { CopyQuoteButton } from '../components/quote/CopyQuoteButton'
import { formatQuoteForCopy } from '../lib/quote/formatQuoteForCopy'
import { SpreadQuoteToggle } from '../components/quote/SpreadQuoteToggle'
import { SpreadQuantityInput } from '../components/quote/SpreadQuantityInput'
import { SpreadQuoteResults } from '../components/quote/SpreadQuoteResults'
import { DiscountInput } from '../components/quote/DiscountInput'
import { LeadTimeCard } from '../components/quote/LeadTimeCard'
import { resolveLeadTimeState } from '../lib/quote/leadTime'
import { ShippingDestinationInput } from '../components/quote/ShippingDestinationInput'
import { QuoteViewToggle, type QuoteView } from '../components/quote/QuoteViewToggle'
import { ShippingCard } from '../components/quote/ShippingCard'
import {
  deriveParcelWeightGrams,
  resolveShippingState,
  type ShippingRate,
} from '../lib/quote/shipping'
import { getShippingSettings, type ShippingSettings } from '../lib/shippingSettings'

// Quote compiler — v1 read-only.
//
// Lives at /quote. Reachable from the persistent QuoteLink in the
// header of every authenticated page and from the global Cmd-K /
// Ctrl-K shortcut (see src/lib/useQuoteShortcut.ts). Opens in a new
// tab so a designer can answer the phone without losing their
// in-progress work.
//
// Commit 3 brings in the live price lookup: usePricing fetches
// price_tiers on material/currency change, calculate.ts resolves
// the typed quantity to a total, HeadlinePrice renders the result.
// Adjacent tier strips, split-name surcharge, finish toggles and
// the custom-quote bailout follow in commits 4–8.
// Local extension of QuoteVariant — the picker doesn't need
// weight_grams but the shipping fetch does, so we widen the type
// for the variants array and let the picker ignore the extra
// column.
type QuoteVariantWithWeight = QuoteVariant & { weight_grams: number }

export default function QuotePage() {
  const [materials, setMaterials] = useState<QuoteMaterial[]>([])
  const [materialsLoading, setMaterialsLoading] = useState(true)

  const [selectedMaterialId, setSelectedMaterialId] = useState<string | null>(null)
  const [variants, setVariants] = useState<QuoteVariantWithWeight[]>([])
  const [variantsLoading, setVariantsLoading] = useState(false)
  const [selectedVariantId, setSelectedVariantId] = useState<string | null>(null)

  // Currency starts unselected on every page load — no
  // sessionStorage / localStorage persistence. Quoting in the
  // wrong currency is the worst possible bug; forcing the
  // designer to make a deliberate currency choice each session
  // beats any convenience win from auto-selecting.
  const [currency, setCurrency] = useState<Currency | null>(null)
  const [quantity, setQuantity] = useState<number | null>(null)
  // Default 1 — "every card has the same details" — keeps the
  // surcharge breakdown silent until the designer explicitly
  // enters a recipient count > 1.
  const [names, setNames] = useState<number>(1)
  // Active finish (or other material_option) code. Defaults to
  // the base option's code on every material change so a stale
  // "Mirror" can't carry across into a material that doesn't
  // have one. Null when the active material exposes no options.
  const [finishCode, setFinishCode] = useState<string | null>(null)
  // Membership-card personalisation add-on (migration 000172).
  // Lives in the same UI slot as NamesInput: a membership card
  // with personalisation is a different product to a split-name
  // run, so the two are mutually exclusive in this form. Ticking
  // personalisation hides NamesInput and forces names back to 1.
  const [hasPersonalisation, setHasPersonalisation] = useState(false)
  // Custom-quote bailout flags. Either or both on => the
  // pricing column collapses to a CustomQuotePanel. Project-
  // level state, not per-pricing-context — persists across
  // material and currency switches.
  const [customFlags, setCustomFlags] = useState<CustomQuoteFlagsState>(EMPTY_CUSTOM_QUOTE_FLAGS)
  // Spread quote mode: presentation switch over the same
  // per-quantity calculation. Internal-only — used when a
  // customer asks for prices across multiple quantities at
  // once. When ON, the quantity input swaps for a multi-entry
  // chip field and the price column renders a results table.
  const [spreadMode, setSpreadMode] = useState(false)
  const [spreadQuantities, setSpreadQuantities] = useState<number[]>([])
  // Internal discount percentage (0–100). Threaded into calculate /
  // spreadCalculate / format* so the headline, copy output, spread
  // table and adjacent strips all reflect the post-discount figure.
  // Resets on every material change (see useEffect below).
  const [discountPercent, setDiscountPercent] = useState(0)

  // ── Shipping state (migration 000178) ─────────────────────────
  // FedEx international rate fetch. All compiler-local — never
  // persisted. The fetch effect below debounces on the relevant
  // inputs (currency, quantity, variant weight, destination), so
  // designers can type a postcode without firing one request per
  // keystroke. quoteView is the designer-only product/shipping/both
  // switch over the price column; defaults to 'both' so a fresh
  // session shows everything.
  const [destCountry, setDestCountry] = useState<string | null>(null)
  const [destPostcode, setDestPostcode] = useState<string | null>(null)
  const [quoteView, setQuoteView] = useState<QuoteView>('both')
  const [shippingRate, setShippingRate] = useState<ShippingRate | null>(null)
  const [shippingLoading, setShippingLoading] = useState(false)
  const [shippingError, setShippingError] = useState<string | null>(null)
  const [shippingSettings, setShippingSettings] = useState<ShippingSettings | null>(null)

  // "Include lead time" toggle for the copy-paste quote body. The
  // checkbox tracks an explicit boolean; an `overridden` flag
  // distinguishes "designer made a deliberate choice" from "we are
  // still tracking the default". Until they tick the box themselves
  // the value follows the default (on when every material in the
  // quote — today exactly one — is in-range AND has a recorded lead
  // time; off otherwise). After a click, the toggle stays where the
  // designer left it across material / currency / quantity changes.
  const [includeLeadTime, setIncludeLeadTime] = useState(false)
  const [includeLeadTimeOverridden, setIncludeLeadTimeOverridden] = useState(false)

  // Material picker auto-collapses once a material is selected so
  // the spec controls below sit closer to the top of the viewport
  // — designers should be able to see Variant / Currency /
  // Quantity / Names / Finish / etc. without scrolling on a
  // 13-inch laptop. Default true (no material yet → expanded);
  // collapses on every material change; user can re-expand by
  // clicking the collapsed bar.
  const [isMaterialPickerExpanded, setIsMaterialPickerExpanded] = useState(true)
  useEffect(() => {
    if (selectedMaterialId) setIsMaterialPickerExpanded(false)
  }, [selectedMaterialId])

  // Distinct document.title so a designer with both the dashboard
  // and the compiler open in Chrome can tell the tabs apart.
  // Mirrors the per-proof title pattern in CustomerProofPage:
  // restore whatever was there on unmount.
  useEffect(() => {
    const previous = document.title
    document.title = 'Quote compiler — Proof Viewer'
    return () => { document.title = previous }
  }, [])

  // GBP VAT rate from settings (migration 000115). Loaded once on
  // mount via the cached helper in src/lib/vatRateGbp.ts; null
  // until the first fetch resolves (HeadlinePrice suppresses the
  // VAT note + ex-VAT line during that brief window rather than
  // flashing a stale rate). Reload picks up admin-side changes
  // within one cache TTL.
  const [vatRate, setVatRate] = useState<number | null>(null)
  useEffect(() => {
    let cancelled = false
    getVatRateGbp().then((rate) => {
      if (!cancelled) setVatRate(rate)
    })
    return () => { cancelled = true }
  }, [])

  // Cached shipping settings — fed-ex box weight and the international
  // % adjustment. Mounted once; the cached helper handles its own
  // TTL/invalidation. Drives the parcel-weight calculation and the
  // ShippingCard's adjustment line.
  useEffect(() => {
    let cancelled = false
    getShippingSettings().then((value) => {
      if (!cancelled) setShippingSettings(value)
    })
    return () => { cancelled = true }
  }, [])

  // Materials: filtered to is_active = true AND is_published = true
  // AND archived_at IS NULL. Mirrors the new-version form's filter
  // so the compiler exposes exactly the same catalogue a designer
  // would see when adding a version.
  useEffect(() => {
    let cancelled = false
    supabase.from('materials')
      .select('id, code, display_name, category, variant_type, option_label, split_name_surcharge_gbp, split_name_surcharge_eur, split_name_surcharge_usd, supports_personalisation, lead_time_min_days, lead_time_max_days')
      .eq('is_active', true)
      .eq('is_published', true)
      .is('archived_at', null)
      .order('sort_order')
      .then(({ data }) => {
        if (cancelled) return
        setMaterials((data ?? []) as QuoteMaterial[])
        setMaterialsLoading(false)
      })
    return () => { cancelled = true }
  }, [])

  // Variants for the chosen material. Pre-selects the first variant
  // so the form has a working default the moment a material lands.
  // Default-variant materials still get their one 'default' row
  // applied here — the picker chooses to render nothing — but the
  // selection is real so price lookups have a variant id to key
  // against.
  useEffect(() => {
    if (!selectedMaterialId) {
      setVariants([])
      setSelectedVariantId(null)
      return
    }
    let cancelled = false
    setVariantsLoading(true)
    supabase.from('material_variants')
      .select('id, code, display_name, variant_type, sort_order, weight_grams')
      .eq('material_id', selectedMaterialId)
      .eq('is_active', true)
      .order('sort_order')
      .then(({ data }) => {
        if (cancelled) return
        const list = (data ?? []) as QuoteVariantWithWeight[]
        setVariants(list)
        setSelectedVariantId(list[0]?.id ?? null)
        setVariantsLoading(false)
      })
    return () => { cancelled = true }
  }, [selectedMaterialId])

  // Live pricing — fetched on material/currency change, reused on
  // variant/quantity navigation. See src/lib/quote/usePricing.ts
  // for the cache discipline.
  const pricing = usePricing(selectedMaterialId, currency)

  // Per-extra-name surcharge resolved per material × currency.
  // Materials that don't bill split-name tooling (wood, acrylic,
  // paper standard, carbon fibre, CNC carbon) leave their column
  // null; we map that to "hide the names input entirely".
  const selectedMaterial = useMemo(
    () => materials.find((m) => m.id === selectedMaterialId) ?? null,
    [materials, selectedMaterialId],
  )

  // Live personalisation rate + min charge for the active currency
  // (migration 000172). Null until the row arrives or when there's
  // no currency selected. The page treats null as "personalisation
  // unavailable" — the checkbox stays inert until the row loads.
  const { pricing: personalisationPricing } = usePersonalisationPricing(currency)

  // Personalisation surcharge at the current quantity. Zero when
  // off (checkbox unticked or material doesn't support it). Same
  // pattern as finishSurchargeAtCurrent below; threaded into the
  // calculate selection so total reflects the all-in number.
  // Names input and personalisation describe mutually exclusive
  // billing models in this form: split-name tooling bills extra
  // setup for N unique names sharing a design, personalisation
  // bills unique-per-card data on a single design. The toggle
  // already resets names to 1 on tick (symmetry-from-the-tick);
  // hiding the toggle when names > 1 closes the loop the other
  // way so a designer with 3 names typed doesn't see an
  // affordance whose tick would silently wipe their input.
  const showPersonalisationToggle =
    selectedMaterial?.supports_personalisation === true
    && currency !== null
    && personalisationPricing !== null
    && names <= 1
  const personalisationActive = showPersonalisationToggle && hasPersonalisation
  const personalisationSurchargeAtCurrent =
    personalisationActive && personalisationPricing && quantity != null
      ? personalisationSurchargeForQty(quantity, personalisationPricing)
      : 0
  const personalisationBreakevenQty =
    personalisationActive && personalisationPricing
      ? personalisationBreakeven(personalisationPricing)
      : null

  // Reset personalisation on every material swap. Keeps the form
  // honest: a material that doesn't support personalisation
  // shouldn't carry a checked flag, and a designer switching
  // between supporting materials should re-affirm the choice each
  // time so they don't get a silent persistent surcharge.
  // Discount resets on the same boundary — a forgotten 10% off
  // following the designer onto a different product is a worse
  // bug than re-entering the number.
  useEffect(() => {
    setHasPersonalisation(false)
    setDiscountPercent(0)
  }, [selectedMaterialId])
  const perExtraNameSurcharge: number | null = useMemo(() => {
    if (!selectedMaterial || !currency) return null
    const raw = currency === 'GBP'
      ? selectedMaterial.split_name_surcharge_gbp
      : currency === 'EUR'
        ? selectedMaterial.split_name_surcharge_eur
        : selectedMaterial.split_name_surcharge_usd
    // Treat null and 0 the same — "no surcharge for this combo".
    return raw && raw > 0 ? Number(raw) : null
  }, [selectedMaterial, currency])

  // Reset names back to 1 whenever the surcharge column goes
  // null/0 — switching from Steel to Wood, say. Keeps the page
  // from carrying a stale "names = 3" through into a no-surcharge
  // material where the input isn't even visible.
  useEffect(() => {
    if (perExtraNameSurcharge == null && names !== 1) setNames(1)
  }, [perExtraNameSurcharge, names])

  // Pin finishCode to the base option of the freshly-loaded
  // material's option set. The page resets it on every (material,
  // currency) change so the toggle can't keep "Mirror" selected
  // across into a material that doesn't have one.
  useEffect(() => {
    if (pricing.options.length === 0) {
      if (finishCode !== null) setFinishCode(null)
      return
    }
    const base = pricing.options.find((o) => o.is_base) ?? pricing.options[0]
    if (!finishCode || !pricing.options.some((o) => o.code === finishCode)) {
      setFinishCode(base.code)
    }
  }, [pricing.options, finishCode])

  // Surchargeable options only — those with at least one row in
  // material_option_surcharges for the active currency. Drives
  // the FinishToggle visibility: wood species and any other
  // option dimension without a surcharge schedule stay invisible.
  const surchargeableOptions = useMemo(() => {
    return pricing.options.filter((o) => {
      const map = pricing.surchargesByOptionId.get(o.id)
      return map && Object.keys(map).length > 0
    })
  }, [pricing.options, pricing.surchargesByOptionId])

  // Show the toggle only when at least one option carries a
  // surcharge schedule. We always include the base option (which
  // by definition has no surcharge rows) at the leftmost so the
  // designer can flip back to Standard.
  const showFinishToggle = surchargeableOptions.length > 0
  const finishToggleOptions = useMemo(() => {
    if (!showFinishToggle) return []
    const base = pricing.options.find((o) => o.is_base) ?? pricing.options[0]
    if (!base) return []
    const others = surchargeableOptions.filter((o) => o.id !== base.id)
    return [base, ...others]
  }, [showFinishToggle, pricing.options, surchargeableOptions])

  // Active option lookup for surcharge resolution. May be the
  // base option (zero surcharge) or one of the surcharged ones.
  const activeOption = useMemo(
    () => pricing.options.find((o) => o.code === finishCode) ?? null,
    [pricing.options, finishCode],
  )

  // Per-cell additive surcharge — split-name (constant across qty)
  // plus finish (varies per qty from material_option_surcharges)
  // plus personalisation (closed-form formula, varies per qty).
  // The strips and calculate.ts call this with the active cell's
  // quantity so neighbour rows reflect their own tier's surcharge.
  function extraTotalAt(qty: number): number {
    const splitName = splitNameSurchargeFor(names, perExtraNameSurcharge)
    const finishMap = activeOption ? pricing.surchargesByOptionId.get(activeOption.id) : null
    const finish = finishMap ? (finishMap[qty] ?? 0) : 0
    const personalisation =
      personalisationActive && personalisationPricing
        ? personalisationSurchargeForQty(qty, personalisationPricing)
        : 0
    return splitName + finish + personalisation
  }
  const finishLabel = activeOption && !activeOption.is_base ? activeOption.display_name : null
  const finishSurchargeAtCurrent =
    activeOption && quantity != null
      ? (pricing.surchargesByOptionId.get(activeOption.id)?.[quantity] ?? 0)
      : 0

  // Variant-scoped tier list, fed to QuantityInput + calculate.
  const variantTiers = useMemo(() => {
    if (!selectedVariantId) return []
    return pricing.tiersByVariantId.get(selectedVariantId) ?? []
  }, [pricing, selectedVariantId])

  // Treat tiers as "stale" when the loaded currency/material
  // doesn't match the current selection. Avoids a stale flash of
  // the previous currency's prices while the new fetch is in
  // flight.
  const tiersFresh =
    pricing.loadedCurrency === currency && pricing.loadedMaterialId === selectedMaterialId

  // Above-max custom-quote trigger. Returns the typed quantity +
  // the variant's largest priced tier when the designer has typed
  // a quantity above the priced range; null otherwise. Composed
  // with the user-driven flags below to drive the bailout.
  // Below-min stays in snap-suggestion territory (snap to the
  // minimum tier) — only above-max bails out.
  const aboveMax = useMemo(() => {
    if (!tiersFresh || quantity == null || variantTiers.length === 0) return null
    let maxQty = -Infinity
    for (const t of variantTiers) if (t.quantity > maxQty) maxQty = t.quantity
    if (quantity <= maxQty) return null
    return { typedQuantity: quantity, maxQuantity: maxQty }
  }, [tiersFresh, quantity, variantTiers])

  // Composite custom-quote flag. Multiple triggers can stack —
  // the panel renders one Why bullet per active reason.
  const customQuote = isCustomQuote(customFlags) || aboveMax !== null

  // Lead-time panel state (migration 000175). Resolved from the
  // material's stored min/max pair plus the custom-quote signal.
  // Driving the panel render and the copy-paste line off the same
  // helper keeps the two surfaces in lockstep.
  const leadTimeState = useMemo(() => {
    if (!selectedMaterial) return null
    return resolveLeadTimeState(selectedMaterial, customQuote)
  }, [selectedMaterial, customQuote])

  // ── Shipping derived state + fetch effect ────────────────────────
  // Weight of one card on the active variant. Drives the parcel-
  // weight calculation below.
  const selectedVariantWeightGrams = useMemo(() => {
    if (!selectedVariantId) return null
    const v = variants.find((x) => x.id === selectedVariantId)
    return v?.weight_grams ?? null
  }, [variants, selectedVariantId])

  // Derived parcel weight in grams. Null whenever any input is
  // missing so the fetch effect can guard cleanly.
  const parcelWeightGrams = useMemo(() => {
    if (!shippingSettings) return null
    return deriveParcelWeightGrams(
      selectedVariantWeightGrams,
      quantity,
      shippingSettings.boxWeightGrams,
    )
  }, [selectedVariantWeightGrams, quantity, shippingSettings])

  // Debounced FedEx rate fetch. Fires only when:
  //   * the compiler is in single-quantity mode (no shipping in spread)
  //   * the compiler isn't in the custom-quote bailout
  //   * currency, quantity, parcel weight, country and postcode are
  //     all populated
  // Resets cleanly on input changes so a stale rate from a previous
  // lane can't render under fresh inputs.
  useEffect(() => {
    if (spreadMode || customQuote) {
      setShippingRate(null)
      setShippingLoading(false)
      setShippingError(null)
      return
    }
    if (
      !currency
      || !quantity
      || !destCountry
      || !destPostcode
      || parcelWeightGrams == null
    ) {
      setShippingRate(null)
      setShippingLoading(false)
      setShippingError(null)
      return
    }
    let cancelled = false
    setShippingLoading(true)
    setShippingError(null)
    // 350ms debounce — long enough to absorb a postcode being typed
    // out character by character, short enough that a designer who
    // pastes a postcode sees the rate appear in well under a second.
    const handle = window.setTimeout(() => {
      void supabase.functions.invoke<ShippingRate & { error?: string }>(
        'fedex-rate',
        {
          body: {
            destCountry,
            destPostcode,
            weightGrams: parcelWeightGrams,
            currency,
          },
        },
      ).then(({ data, error }) => {
        if (cancelled) return
        setShippingLoading(false)
        if (error) {
          setShippingError(error.message ?? 'Shipping rate request failed')
          setShippingRate(null)
          return
        }
        if (!data) {
          setShippingError('Empty response from shipping rate service')
          setShippingRate(null)
          return
        }
        // Edge function returns { ...ParsedRate, cached, quotedAt }.
        // If it returned an error envelope, surface it; otherwise
        // accept the rate.
        if ((data as { error?: string }).error) {
          setShippingError((data as { error?: string }).error ?? null)
          setShippingRate(null)
          return
        }
        setShippingRate(data as ShippingRate)
      })
    }, 350)
    return () => { cancelled = true; window.clearTimeout(handle) }
  }, [spreadMode, customQuote, currency, quantity, parcelWeightGrams, destCountry, destPostcode])

  const shippingState = useMemo(
    () => resolveShippingState({
      spreadMode,
      customQuote,
      currency,
      quantity,
      destCountry,
      destPostcode,
      variantWeightGrams: selectedVariantWeightGrams,
      loading: shippingLoading,
      rate: shippingRate,
      error: shippingError,
    }),
    [spreadMode, customQuote, currency, quantity, destCountry, destPostcode, selectedVariantWeightGrams, shippingLoading, shippingRate, shippingError],
  )

  // Default state for the "Include lead time" checkbox: on only when
  // every material in the quote (today: one) is in-range AND has a
  // recorded lead time. Off in every other case so the designer is
  // never caught quoting a fabricated number. The designer can
  // override either way; the override persists until handleReset.
  const includeLeadTimeDefault = leadTimeState?.kind === 'standard'
  const effectiveIncludeLeadTime = includeLeadTimeOverridden
    ? includeLeadTime
    : includeLeadTimeDefault
  useEffect(() => {
    if (!includeLeadTimeOverridden) setIncludeLeadTime(includeLeadTimeDefault)
  }, [includeLeadTimeDefault, includeLeadTimeOverridden])
  function handleIncludeLeadTimeChange(next: boolean) {
    setIncludeLeadTime(next)
    setIncludeLeadTimeOverridden(true)
  }

  // Variants pruned to those with at least one tier in the active
  // currency. Empty-tier placeholders (e.g. plastic_translucent /
  // plastic_tinted's 7-ink and 8-ink rows, which were left
  // unpriced by migration 000109 — only satin got the 7/8 fill)
  // drop out of the picker entirely so the designer can't pick
  // a chip the headline can't resolve. Falls back to the
  // unfiltered list while pricing is still stale, so chips don't
  // disappear under the designer mid-fetch.
  const availableVariants = useMemo(() => {
    if (!tiersFresh) return variants
    return variants.filter((v) => (pricing.tiersByVariantId.get(v.id)?.length ?? 0) > 0)
  }, [variants, tiersFresh, pricing.tiersByVariantId])

  // Auto-snap if the selected variant just got filtered out —
  // material change lands you on a different variant set; a
  // currency switch could in theory take the current variant out
  // of availability if the priced-currency-coverage isn't
  // uniform (current data has it uniform, but defensive). Also
  // fires when an empty-priced variant was pre-selected before
  // pricing loaded — once tiers arrive, snap to the first
  // available.
  useEffect(() => {
    if (!tiersFresh || availableVariants.length === 0) return
    if (selectedVariantId && availableVariants.some((v) => v.id === selectedVariantId)) return
    setSelectedVariantId(availableVariants[0].id)
  }, [tiersFresh, availableVariants, selectedVariantId])

  // Defensive: every variant filtered out of the picker means no
  // priced variants at all in the active currency. Today this
  // can't happen with the seeded data — every published material
  // has at least one variant priced in every currency — but the
  // future-proof shape lets us swap the price column to a
  // "No prices available in {currency}" affordance instead of
  // showing a partially-loaded placeholder.
  const noVariantsAvailable = tiersFresh && variants.length > 0 && availableVariants.length === 0

  // Reset form — wipes every field back to the initial empty state
  // a fresh page load would land on. Cheaper than a full window
  // reload (keeps the cached materials list and VAT rate) and
  // avoids losing the tab. Disabled when the form is already
  // pristine so clicking it can't confuse a designer who pressed
  // it expecting something visible to happen.
  const isFormDirty =
    selectedMaterialId !== null ||
    currency !== null ||
    quantity !== null ||
    names !== 1 ||
    spreadMode ||
    spreadQuantities.length > 0 ||
    customFlags.nfc ||
    hasPersonalisation ||
    discountPercent > 0 ||
    destCountry !== null ||
    destPostcode !== null ||
    quoteView !== 'both'
  function handleReset() {
    setSelectedMaterialId(null)
    setVariants([])
    setSelectedVariantId(null)
    setCurrency(null)
    setQuantity(null)
    setNames(1)
    setFinishCode(null)
    setHasPersonalisation(false)
    setCustomFlags(EMPTY_CUSTOM_QUOTE_FLAGS)
    setSpreadMode(false)
    setSpreadQuantities([])
    setDiscountPercent(0)
    setIsMaterialPickerExpanded(true)
    setIncludeLeadTime(false)
    setIncludeLeadTimeOverridden(false)
    setDestCountry(null)
    setDestPostcode(null)
    setQuoteView('both')
    setShippingRate(null)
    setShippingError(null)
  }

  const result = useMemo(() => {
    if (!tiersFresh) {
      return {
        total: null,
        baseTotal: null,
        splitNameSurcharge: null,
        finishSurcharge: null,
        personalisationSurcharge: null,
        subtotal: null,
        discountPercent,
        discountAmount: null,
        unitPrice: null,
        validTier: false,
        currency,
        snap: { lower: null, upper: null },
      }
    }
    return calculate(
      {
        variantId: selectedVariantId,
        quantity,
        currency,
        names,
        perExtraNameSurcharge,
        finishSurcharge: finishSurchargeAtCurrent,
        personalisationSurcharge: personalisationSurchargeAtCurrent,
        discountPercent,
      },
      variantTiers,
    )
  }, [selectedVariantId, quantity, currency, names, perExtraNameSurcharge, finishSurchargeAtCurrent, personalisationSurchargeAtCurrent, discountPercent, variantTiers, tiersFresh])

  return (
    <div className="min-h-dvh bg-gray-50">
      <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6 lg:px-8">
        <div className="mb-8 flex items-center justify-between">
          <div>
            <p className="text-sm font-medium uppercase tracking-widest text-gray-400">PlasmaDesign</p>
            <h1 className="mt-1 text-2xl font-bold text-gray-900">Quote compiler</h1>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleReset}
              disabled={!isFormDirty}
              className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm hover:border-gray-400 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-gray-200"
            >
              Reset form
            </button>
            <Link
              to="/"
              className="rounded-lg px-4 py-2 text-sm font-medium text-gray-500 hover:bg-gray-100"
            >
              ← Projects
            </Link>
          </div>
        </div>

        <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
          {/* ── Selection card ───────────────────────────────────────────── */}
          <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-gray-200 sm:p-8">
            {/* Tab order: material → variant → currency → quantity →
                names → add-on toggles → metadata → custom-quote flags.
                Currency precedes quantity because QuantityInput is
                disabled until currency is picked — landing in the
                disabled field with no way to type would force a
                back-tab. */}
            <div className="space-y-8">
              {materialsLoading ? (
                <p className="text-sm text-gray-400">Loading materials…</p>
              ) : (
                <div className="space-y-3">
                  {/* Collapsed bar — only renders when a material
                      is selected AND the designer hasn't re-
                      expanded the picker. Single-line card,
                      whole row clickable, restores vertical
                      space to the spec controls below. */}
                  {selectedMaterialId && !isMaterialPickerExpanded && selectedMaterial && (
                    <CollapsedMaterialBar
                      materialName={selectedMaterial.display_name}
                      onExpand={() => setIsMaterialPickerExpanded(true)}
                    />
                  )}
                  {/* Picker stays mounted across collapse/expand
                      so the height transition has content to
                      interpolate against (and so the search
                      query persists). The grid-template-rows
                      trick animates between 0 and auto smoothly
                      at content speed. */}
                  <div
                    className="grid transition-[grid-template-rows] duration-150 ease-out"
                    style={{ gridTemplateRows: isMaterialPickerExpanded ? '1fr' : '0fr' }}
                  >
                    <div className="overflow-hidden">
                      <MaterialPicker
                        materials={materials}
                        value={selectedMaterialId}
                        onChange={(id) => {
                          setSelectedMaterialId(id)
                          // Quantity carries forward across material
                          // changes intentionally — designer often
                          // re-quotes the same run on a different
                          // material. The headline collapses to "snap
                          // to N" if the carried-over quantity isn't a
                          // tier on the new material.
                        }}
                        isExpanded={isMaterialPickerExpanded}
                      />
                    </div>
                  </div>
                </div>
              )}

              {selectedMaterialId && !noVariantsAvailable && (
                <VariantPicker
                  variants={availableVariants}
                  value={selectedVariantId}
                  onChange={setSelectedVariantId}
                  loading={variantsLoading}
                />
              )}

              {/* Currency renders even before a material is picked
                  so the designer can make the currency choice
                  deliberately on every fresh session. No
                  sessionStorage stickiness — quoting in the wrong
                  currency is the worst possible bug. */}
              <CurrencyToggle value={currency} onChange={setCurrency} />

              {/* Spread quote toggle — presentation switch over
                  the same per-quantity calculation. Sits flush
                  above the quantity input so the swap reads as
                  one mode change rather than two fields. */}
              <SpreadQuoteToggle
                value={spreadMode}
                onChange={setSpreadMode}
                disabled={!selectedMaterialId || !currency}
              />

              {/* Quantity renders too, but disabled until BOTH
                  material AND currency are picked. The disabled
                  state shows a "Pick a material and currency to
                  enable" hint. */}
              {spreadMode ? (
                <SpreadQuantityInput
                  values={spreadQuantities}
                  onChange={setSpreadQuantities}
                  variantTiers={variantTiers}
                  currency={currency}
                  disabled={!selectedMaterialId || !currency}
                />
              ) : (
                <QuantityInput
                  value={quantity}
                  onChange={setQuantity}
                  variantTiers={variantTiers}
                  currency={currency}
                  disabled={!selectedMaterialId || !currency}
                  // Live preview reuses the same calculate() result
                  // the headline + CopyQuoteButton already use, so
                  // the preview can never drift from those.
                  previewTotal={result.total}
                  previewUnitPrice={result.unitPrice}
                  previewValidTier={result.validTier}
                />
              )}

              {/* Names + Personalisation share the same conceptual
                  slot: split-name tooling describes N unique names
                  on a single design, personalisation describes
                  unique data per card on a membership-style run.
                  A given quote is either one or the other, never
                  both, so the personalisation checkbox hides the
                  Names input when ticked (and vice versa: a
                  material that supports personalisation but the
                  designer hasn't ticked it still shows Names if
                  the material bills extra names). */}
              {selectedMaterialId && currency && perExtraNameSurcharge != null && !personalisationActive && (
                <NamesInput
                  value={names}
                  onChange={setNames}
                  perExtraNameSurcharge={perExtraNameSurcharge}
                  currency={currency}
                />
              )}

              {/* Personalisation checkbox (migration 000172). Shows
                  when the material is admin-flagged as supporting
                  personalisation and the live rate has loaded. The
                  helper text below quotes the live rate so a
                  designer sees the magnitude at a glance.
                  Conceptually replaces the Names input above for
                  membership-card quotes — see comment block on the
                  Names render. */}
              {showPersonalisationToggle && personalisationPricing && (
                <div>
                  <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-gray-200 bg-white px-4 py-3">
                    <input
                      type="checkbox"
                      checked={hasPersonalisation}
                      onChange={(e) => {
                        const next = e.target.checked
                        setHasPersonalisation(next)
                        // Personalisation and split-name tooling are
                        // mutually exclusive in the quote flow.
                        // Force names back to 1 on tick so the price
                        // column doesn't carry a stale split-name
                        // surcharge under the personalisation total.
                        if (next && names !== 1) setNames(1)
                      }}
                      className="mt-0.5 h-4 w-4 cursor-pointer rounded border-gray-300 text-gray-900 focus:ring-gray-400"
                    />
                    <div>
                      <div className="text-sm font-medium text-gray-700">
                        Add personalisation
                      </div>
                      <div className="text-xs text-gray-500">
                        {currency === 'USD'
                          ? `$${personalisationPricing.per_card_rate.toFixed(2)} per card with a $${personalisationPricing.min_charge.toFixed(0)} minimum charge.`
                          : currency === 'EUR'
                            ? `€${personalisationPricing.per_card_rate.toFixed(2)} per card with a €${personalisationPricing.min_charge.toFixed(0)} minimum charge.`
                            : `£${personalisationPricing.per_card_rate.toFixed(2)} per card with a £${personalisationPricing.min_charge.toFixed(0)} minimum charge.`}
                      </div>
                    </div>
                  </label>
                </div>
              )}

              {/* Finish toggle — only renders when the active
                  material has at least one option with a surcharge
                  schedule in the active currency. Today: Steel and
                  Gold with Brushed/Mirror. Wood species, etc. live
                  in material_options too but carry no surcharge
                  rows so the toggle stays hidden there.
                  tiersFresh-gated so the toggle doesn't flash a
                  prior material's options during a material-change
                  fetch. */}
              {selectedMaterialId && currency && tiersFresh && showFinishToggle && finishCode && (
                <FinishToggle
                  label={selectedMaterial?.option_label ?? null}
                  options={finishToggleOptions}
                  value={finishCode}
                  onChange={setFinishCode}
                />
              )}

              {/* Custom-quote bailout flags. Amber-tinted block
                  signals "this branches off live pricing"; either
                  on routes the price column to CustomQuotePanel
                  below. */}
              {selectedMaterialId && (
                <CustomQuoteFlags value={customFlags} onChange={setCustomFlags} />
              )}

              {/* Internal discount % — designer-only price modifier.
                  Applies to headline + copy + spread. Hidden in the
                  custom-quote bailout state since there's no number
                  to discount; resets on every material change. */}
              {selectedMaterialId && !customQuote && (
                <DiscountInput value={discountPercent} onChange={setDiscountPercent} />
              )}

              {/* Shipping destination (migration 000178). Hidden in
                  spread mode (no resolved quantity to weigh against)
                  and in the custom-quote bailout (same). Otherwise
                  available the moment the form has a material —
                  designers often type the postcode while still
                  picking the variant. */}
              {selectedMaterialId && !spreadMode && !customQuote && (
                <ShippingDestinationInput
                  country={destCountry}
                  postcode={destPostcode}
                  onCountryChange={setDestCountry}
                  onPostcodeChange={setDestPostcode}
                />
              )}
            </div>
          </div>

          {/* ── Price column ─────────────────────────────────────────────── */}
          <div className="space-y-4">
            {/* Designer-only view switch. Suppressed in spread mode
                (shipping card is never rendered in spread, so the
                toggle has nothing to gate) and in the custom-quote
                bailout (no product price to hide either). The price-
                column blocks below honour quoteView so the toggle
                actually flips what's rendered. */}
            {!spreadMode && !customQuote && selectedMaterialId && (
              <div className="flex items-center justify-end">
                <QuoteViewToggle value={quoteView} onChange={setQuoteView} />
              </div>
            )}

            {/* Lead-time card sits at the top of the results column
                in both single and spread modes. Reads as "when can
                we make it" → "how much". Render predicate is mode-
                aware: single mode waits for a typed quantity, spread
                mode waits for currency + at least one quantity chip
                (the same moment SpreadQuoteResults switches from its
                empty-state placeholder to the stacked list). The
                card returns null in its not_set state so the slot
                is simply absent rather than rendering a placeholder. */}
            {selectedMaterial && leadTimeState && (
              spreadMode
                ? (currency != null && spreadQuantities.length > 0)
                : quantity != null
            ) && (
              <LeadTimeCard
                state={leadTimeState}
                materialDisplayName={selectedMaterial.display_name}
              />
            )}
            {spreadMode ? (
              /* Spread quote mode — table-shaped results card
                 replaces the headline + adjacent strips + snap
                 chips entirely. Lead-time card renders above per
                 the block immediately preceding this ternary;
                 custom-quote flags still flow through to the bottom
                 of the spread card. */
              <SpreadQuoteResults
                quantities={spreadQuantities}
                onChangeQuantities={setSpreadQuantities}
                variantTiers={variantTiers}
                finishSurchargesByQty={
                  activeOption ? pricing.surchargesByOptionId.get(activeOption.id) ?? null : null
                }
                currency={currency}
                materialDisplayName={selectedMaterial?.display_name ?? null}
                variantDisplayName={
                  selectedVariantId && variants[0]?.variant_type !== 'default'
                    ? variants.find((v) => v.id === selectedVariantId)?.display_name ?? null
                    : null
                }
                finishOption={
                  showFinishToggle && activeOption
                    ? { displayName: activeOption.display_name, isBase: activeOption.is_base }
                    : null
                }
                splitNameSurcharge={
                  perExtraNameSurcharge != null && names > 1
                    ? (names - 1) * perExtraNameSurcharge
                    : 0
                }
                names={names}
                perExtraNameSurcharge={perExtraNameSurcharge}
                personalisationAt={(qty) =>
                  personalisationActive && personalisationPricing
                    ? personalisationSurchargeForQty(qty, personalisationPricing)
                    : 0
                }
                personalisationActive={personalisationActive}
                personalisationBreakevenQty={personalisationBreakevenQty}
                customFlags={customFlags}
                discountPercent={discountPercent}
                includeLeadTime={effectiveIncludeLeadTime}
                onIncludeLeadTimeChange={handleIncludeLeadTimeChange}
                leadTimeState={leadTimeState}
                loading={pricing.loading && !tiersFresh}
              />
            ) : (
              <>
                {customQuote ? (
                  /* Custom-quote bailout. Replaces the price card
                     entirely — no partial number, no fall-through.
                     SpecSummary still renders below so the designer
                     can read the customer's spec aloud while
                     flagging for Rob. */
                  <CustomQuotePanel
                    flags={customFlags}
                    aboveMax={aboveMax && selectedMaterial ? {
                      typedQuantity: aboveMax.typedQuantity,
                      maxQuantity: aboveMax.maxQuantity,
                      materialName: selectedMaterial.display_name,
                      variantName:
                        selectedVariantId && variants[0]?.variant_type !== 'default'
                          ? variants.find((v) => v.id === selectedVariantId)?.display_name ?? null
                          : null,
                    } : null}
                  />
                ) : noVariantsAvailable ? (
                  /* Defensive: no variant of this material has prices
                     in the active currency. Today no published
                     material trips this branch — every active variant
                     is priced across all three currencies — but we
                     surface a clear affordance rather than a stale
                     placeholder if it ever does. */
                  quoteView !== 'shipping' && (
                    <div className="rounded-2xl border-2 border-amber-200 bg-amber-50 p-8">
                      <p className="text-xs font-semibold uppercase tracking-widest text-amber-700">
                        No prices available
                      </p>
                      <p className="mt-3 text-2xl font-bold leading-tight text-amber-900">
                        {selectedMaterial?.display_name ?? 'This material'} isn't priced in {currency} yet
                      </p>
                      <p className="mt-3 text-sm text-amber-800">
                        Try a different currency, pick another material, or flag this for Rob — there's no live tier data to quote against here.
                      </p>
                    </div>
                  )
                ) : quoteView !== 'shipping' ? (
                  <HeadlinePrice
                    total={result.total}
                    baseTotal={result.baseTotal}
                    splitNameSurcharge={result.splitNameSurcharge}
                    perExtraNameSurcharge={perExtraNameSurcharge}
                    names={names}
                    finishSurcharge={result.finishSurcharge}
                    finishLabel={finishLabel}
                    personalisationSurcharge={result.personalisationSurcharge}
                    personalisationBreakevenQty={personalisationBreakevenQty}
                    subtotal={result.subtotal}
                    discountPercent={result.discountPercent}
                    discountAmount={result.discountAmount}
                    unitPrice={result.unitPrice}
                    quantity={quantity}
                    currency={currency}
                    loading={pricing.loading && !tiersFresh}
                    vatRate={vatRate}
                  />
                ) : null}

                {/* FedEx shipping card. Sits beneath the headline so
                    the "product price → shipping price" read order
                    matches the two questions the designer is
                    answering. Hidden in spread mode, in the custom-
                    quote bailout, and when quoteView is 'product'.
                    resolveShippingState handles the other inputs;
                    ShippingCard renders nothing when state is
                    not_ready. */}
                {!customQuote && shippingSettings && quoteView !== 'product' && (
                  <ShippingCard
                    state={shippingState}
                    currency={currency}
                    intlAdjustPercent={shippingSettings.intlAdjustPercent}
                  />
                )}
              </>
            )}

            {/* Spec readout — what the designer says aloud when
                confirming the quote. Mirrors the form order so
                the eye can pair input and summary. Stays visible
                in the bailout state — the spec is still the
                spec, the panel just replaces the price. Hidden
                in spread mode — the spread results card carries
                its own header. */}
            {!spreadMode && selectedMaterialId && (
              <SpecSummary
                materialName={selectedMaterial?.display_name ?? null}
                variantType={variants[0]?.variant_type ?? null}
                variantDisplayName={
                  selectedVariantId && variants[0]?.variant_type !== 'default'
                    ? variants.find((v) => v.id === selectedVariantId)?.display_name ?? null
                    : null
                }
                // Surface the active finish option only when the
                // material has a finish dimension (showFinishToggle).
                // Includes the base option (e.g. Steel's "Natural")
                // so the row appears whenever the picker did, even
                // when no surcharge applies.
                finishName={showFinishToggle && activeOption ? activeOption.display_name : null}
                quantity={quantity}
                names={names}
                personalisationActive={personalisationActive}
              />
            )}

            {/* Copy quote — primary action below the headline area.
                Hidden in the custom-quote bailout (no number to
                copy), the no-prices defensive panel (same), and
                while the typed quantity isn't a valid tier (the
                snap chips own the resolution path there). The
                formatter is pure and runs on every render of the
                price column; cheap. */}
            {!spreadMode && !customQuote && !noVariantsAvailable && tiersFresh && result.validTier
              && selectedMaterial && (() => {
                const formatted = formatQuoteForCopy({
                  selection: {
                    variantId: selectedVariantId,
                    quantity,
                    currency,
                    names,
                    perExtraNameSurcharge,
                    finishSurcharge: finishSurchargeAtCurrent,
                    personalisationSurcharge: personalisationSurchargeAtCurrent,
                    discountPercent,
                  },
                  result,
                  materialDisplayName: selectedMaterial.display_name,
                  variantDisplayName:
                    selectedVariantId && variants[0]?.variant_type !== 'default'
                      ? variants.find((v) => v.id === selectedVariantId)?.display_name ?? null
                      : null,
                  // Pass the active option only when the
                  // material has a finish dimension (at least
                  // one option carries surcharges). Wood species
                  // and other option dimensions without
                  // surcharge rows leave finishOption null so
                  // the formatter drops the "with X finish"
                  // suffix entirely. Base options (Natural,
                  // Standard) still flow through here — the
                  // formatter renders them as "natural finish"
                  // per Plasma's customer-facing wording.
                  finishOption: showFinishToggle && activeOption
                    ? { displayName: activeOption.display_name, isBase: activeOption.is_base }
                    : null,
                  // Settings-loaded rate so the copy's GBP
                  // total line + ex-VAT figure track whatever
                  // HeadlinePrice is rendering. Stays null
                  // briefly during the first paint while the
                  // cached helper resolves; the formatter
                  // suppresses both VAT lines for that window
                  // rather than baking in a stale rate.
                  vatRate,
                  // Lead-time paragraph in the copied body. The
                  // formatter handles omission internally when
                  // the toggle is off or the resolved state is
                  // not-set.
                  includeLeadTime: effectiveIncludeLeadTime,
                  leadTimeState,
                  // Shipping section in the copied body (migration
                  // 000178). View follows the designer's quoteView
                  // pill so a 'product' selection yields the same
                  // byte-identical output the formatter has always
                  // produced. The rate + adjustment % flow through
                  // so 'shipping' and 'both' get the live breakdown.
                  view: quoteView,
                  shippingRate,
                  shippingIntlAdjustPercent: shippingSettings?.intlAdjustPercent ?? 0,
                })
                return (
                  /* Copy-quote group. The "Include lead time" toggle
                     gates the lead-time line in the copied body, so
                     it lives right next to the Copy button — cause
                     and effect in one place. Hidden when no lead
                     time is recorded for the material (nothing to
                     include); the not-set case can't reach this
                     branch's other paths either. The custom-quote
                     branch never renders the copy block at all, so
                     'custom' lead-time state is unreachable here. */
                  <div className="space-y-3">
                    {leadTimeState?.kind === 'standard' && (
                      <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-gray-200 bg-white px-4 py-3">
                        <input
                          type="checkbox"
                          checked={effectiveIncludeLeadTime}
                          onChange={(e) => handleIncludeLeadTimeChange(e.target.checked)}
                          className="mt-0.5 h-4 w-4 cursor-pointer rounded border-gray-300 text-gray-900 focus:ring-gray-400"
                        />
                        <div>
                          <div className="text-sm font-medium text-gray-700">
                            Include lead time in copied quote
                          </div>
                          <div className="text-xs text-gray-500">
                            Appends a short lead-time line to the copied quote body.
                          </div>
                        </div>
                      </label>
                    )}
                    <CopyQuoteButton plainText={formatted.plainText} html={formatted.html} />
                  </div>
                )
              })()}

            {/* Adjacent strips — consultative, smaller scale than
                the headline. Suppressed when the typed quantity
                isn't a tier (snap chips already nudge), when
                there are no neighbours to show, and when the
                custom-quote bailout is active. AdjacentVariants
                additionally suppresses for default-variant
                materials. */}
            {!spreadMode && !customQuote && quoteView !== 'shipping' && tiersFresh && result.validTier && (
              <AdjacentTiers
                tiers={variantTiers}
                materialCode={selectedMaterial?.code ?? null}
                currentQuantity={quantity}
                currency={currency}
                extraTotalAt={extraTotalAt}
                discountPercent={discountPercent}
              />
            )}
            {!spreadMode && !customQuote && quoteView !== 'shipping' && tiersFresh && result.validTier && (
              <AdjacentVariants
                variants={variants}
                currentVariantId={selectedVariantId}
                tiersByVariantId={pricing.tiersByVariantId}
                currentQuantity={quantity}
                currency={currency}
                extraTotalAt={extraTotalAt}
                discountPercent={discountPercent}
              />
            )}

            {/* Snap suggestions — surfaced when the typed quantity
                isn't a valid tier and tiers have loaded. Click to
                jump to the suggested quantity. Suppressed in the
                bailout state. */}
            {!spreadMode && !customQuote && quoteView !== 'shipping' && tiersFresh && quantity != null && !result.validTier && (result.snap.lower || result.snap.upper) && (
              <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-amber-200">
                <p className="text-xs font-semibold uppercase tracking-widest text-amber-700">
                  No tier at {quantity.toLocaleString()}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {result.snap.lower && currency && (
                    <button
                      type="button"
                      onClick={() => setQuantity(result.snap.lower!.quantity)}
                      className="rounded-lg border border-amber-200 bg-white px-3 py-2 text-sm font-medium text-amber-900 hover:bg-amber-50"
                    >
                      Snap to {result.snap.lower.quantity.toLocaleString()} ({formatPrice(result.snap.lower.totalPrice, currency)})
                    </button>
                  )}
                  {result.snap.upper && currency && (
                    <button
                      type="button"
                      onClick={() => setQuantity(result.snap.upper!.quantity)}
                      className="rounded-lg border border-amber-200 bg-white px-3 py-2 text-sm font-medium text-amber-900 hover:bg-amber-50"
                    >
                      Snap to {result.snap.upper.quantity.toLocaleString()} ({formatPrice(result.snap.upper.totalPrice, currency)})
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
