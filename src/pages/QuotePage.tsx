import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { formatPrice } from '../lib/currency'
import type { Currency } from '../lib/types'
import type { QuoteMaterial, QuoteVariant } from '../lib/quote/types'
import { calculate, splitNameSurchargeFor } from '../lib/quote/calculate'
import { usePricing } from '../lib/quote/usePricing'
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
export default function QuotePage() {
  const [materials, setMaterials] = useState<QuoteMaterial[]>([])
  const [materialsLoading, setMaterialsLoading] = useState(true)

  const [selectedMaterialId, setSelectedMaterialId] = useState<string | null>(null)
  const [variants, setVariants] = useState<QuoteVariant[]>([])
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
  // Custom-quote bailout flags. Either or both on => the
  // pricing column collapses to a CustomQuotePanel. Project-
  // level state, not per-pricing-context — persists across
  // material and currency switches.
  const [customFlags, setCustomFlags] = useState<CustomQuoteFlagsState>(EMPTY_CUSTOM_QUOTE_FLAGS)

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

  // Materials: filtered to is_active = true AND is_published = true
  // AND archived_at IS NULL. Mirrors the new-version form's filter
  // so the compiler exposes exactly the same catalogue a designer
  // would see when adding a version.
  useEffect(() => {
    let cancelled = false
    supabase.from('materials')
      .select('id, code, display_name, category, variant_type, option_label, split_name_surcharge_gbp, split_name_surcharge_eur, split_name_surcharge_usd')
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
      .select('id, code, display_name, variant_type, sort_order')
      .eq('material_id', selectedMaterialId)
      .eq('is_active', true)
      .order('sort_order')
      .then(({ data }) => {
        if (cancelled) return
        const list = (data ?? []) as QuoteVariant[]
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
  // plus finish (varies per qty from material_option_surcharges).
  // The strips and calculate.ts call this with the active cell's
  // quantity so neighbour rows reflect their own tier's surcharge.
  function extraTotalAt(qty: number): number {
    const splitName = splitNameSurchargeFor(names, perExtraNameSurcharge)
    const finishMap = activeOption ? pricing.surchargesByOptionId.get(activeOption.id) : null
    const finish = finishMap ? (finishMap[qty] ?? 0) : 0
    return splitName + finish
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

  const result = useMemo(() => {
    if (!tiersFresh) {
      return {
        total: null,
        baseTotal: null,
        splitNameSurcharge: null,
        finishSurcharge: null,
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
      },
      variantTiers,
    )
  }, [selectedVariantId, quantity, currency, names, perExtraNameSurcharge, finishSurchargeAtCurrent, variantTiers, tiersFresh])

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6 lg:px-8">
        <div className="mb-8 flex items-center justify-between">
          <div>
            <p className="text-sm font-medium uppercase tracking-widest text-gray-400">PlasmaDesign</p>
            <h1 className="mt-1 text-2xl font-bold text-gray-900">Quote compiler</h1>
          </div>
          <Link
            to="/"
            className="rounded-lg px-4 py-2 text-sm font-medium text-gray-500 hover:bg-gray-100"
          >
            ← Projects
          </Link>
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

              {/* Quantity renders too, but disabled until BOTH
                  material AND currency are picked. The disabled
                  state shows a "Pick a material and currency to
                  enable" hint. */}
              <QuantityInput
                value={quantity}
                onChange={setQuantity}
                variantTiers={variantTiers}
                currency={currency}
                disabled={!selectedMaterialId || !currency}
              />

              {/* Names input — only renders when the active
                  (material × currency) actually bills extra names.
                  Wood, acrylic, paper standard, carbon fibre and
                  CNC carbon all skip the input; their split-name
                  columns are null in materials. */}
              {selectedMaterialId && currency && perExtraNameSurcharge != null && (
                <NamesInput
                  value={names}
                  onChange={setNames}
                  perExtraNameSurcharge={perExtraNameSurcharge}
                  currency={currency}
                />
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
            </div>
          </div>

          {/* ── Price column ─────────────────────────────────────────────── */}
          <div className="space-y-4">
            {customQuote ? (
              /* Custom-quote bailout. Replaces the entire pricing
                 area — no partial number, no fall-through to base.
                 SpecSummary still renders below so the designer can
                 read the customer's spec aloud while flagging for
                 Rob. */
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
            ) : (
              <HeadlinePrice
                total={result.total}
                baseTotal={result.baseTotal}
                splitNameSurcharge={result.splitNameSurcharge}
                perExtraNameSurcharge={perExtraNameSurcharge}
                names={names}
                finishSurcharge={result.finishSurcharge}
                finishLabel={finishLabel}
                unitPrice={result.unitPrice}
                quantity={quantity}
                currency={currency}
                loading={pricing.loading && !tiersFresh}
                vatRate={vatRate}
              />
            )}

            {/* Spec readout — what the designer says aloud when
                confirming the quote. Mirrors the form order so
                the eye can pair input and summary. Stays visible
                in the bailout state — the spec is still the
                spec, the panel just replaces the price. */}
            {selectedMaterialId && (
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
              />
            )}

            {/* Copy quote — primary action below the headline area.
                Hidden in the custom-quote bailout (no number to
                copy), the no-prices defensive panel (same), and
                while the typed quantity isn't a valid tier (the
                snap chips own the resolution path there). The
                formatter is pure and runs on every render of the
                price column; cheap. */}
            {!customQuote && !noVariantsAvailable && tiersFresh && result.validTier
              && selectedMaterial && (() => {
                const formatted = formatQuoteForCopy({
                  selection: {
                    variantId: selectedVariantId,
                    quantity,
                    currency,
                    names,
                    perExtraNameSurcharge,
                    finishSurcharge: finishSurchargeAtCurrent,
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
                })
                return (
                  <CopyQuoteButton plainText={formatted.plainText} html={formatted.html} />
                )
              })()}

            {/* Adjacent strips — consultative, smaller scale than
                the headline. Suppressed when the typed quantity
                isn't a tier (snap chips already nudge), when
                there are no neighbours to show, and when the
                custom-quote bailout is active. AdjacentVariants
                additionally suppresses for default-variant
                materials. */}
            {!customQuote && tiersFresh && result.validTier && (
              <AdjacentTiers
                tiers={variantTiers}
                materialCode={selectedMaterial?.code ?? null}
                currentQuantity={quantity}
                currency={currency}
                extraTotalAt={extraTotalAt}
              />
            )}
            {!customQuote && tiersFresh && result.validTier && (
              <AdjacentVariants
                variants={variants}
                currentVariantId={selectedVariantId}
                tiersByVariantId={pricing.tiersByVariantId}
                currentQuantity={quantity}
                currency={currency}
                extraTotalAt={extraTotalAt}
              />
            )}

            {/* Snap suggestions — surfaced when the typed quantity
                isn't a valid tier and tiers have loaded. Click to
                jump to the suggested quantity. Suppressed in the
                bailout state. */}
            {!customQuote && tiersFresh && quantity != null && !result.validTier && (result.snap.lower || result.snap.upper) && (
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
