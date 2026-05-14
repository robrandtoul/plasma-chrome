import { formatPrice } from '../currency'
import type { QuoteResult, QuoteSelection } from './calculate'
import type { LeadTimeState } from './leadTime'
import { leadTimeQuoteLine } from './leadTime'
import type { ShippingRate, DomesticRate, ParcelSplit } from './shipping'
import { applyIntlAdjustment } from './shipping'
import { gbpToCurrency, type ExchangeRates } from '../exchangeRates'

// Pure formatter that turns the compiler's current state into a
// plain-text and HTML pair suitable for a multi-format clipboard
// write. Plain-text destinations (Notes, terminals, plain-text
// reply boxes) get the well-spaced version; rich-text editors
// (Help Scout, Gmail, Apple Mail) get the tighter HTML with the
// Total line bolded.
//
// Caller responsibilities:
// - Gate on `result.validTier` so we never produce a quote with a
//   placeholder dash. The function returns empty strings in the
//   defensive case where total is null.
// - Pass display names — the formatter never reads from the DB;
//   it just composes strings and escapes them for HTML.
//
// Plain-text shape (\n-separated, blank lines around Total and
// before the disclaimer — UNCHANGED from the previous shipped
// format):
//
//   {qty} {Material} cards{paren} = {cards-price-incl-finish}
//   Extra setup to split batch between {N} layouts = {split-name-surcharge}
//   <blank>
//   Total = {inclusive}{ inc VAT (£X ex VAT)}
//   <blank>
//   This quote excludes shipping.
//
// HTML shape — tight: single <br> between every content line, a
// single blank-line gap (rendered as <br><br>) only before the
// disclaimer. Total is wrapped in <strong>:
//
//   - GBP: "<strong>Total = £X inc VAT</strong> (£Y ex VAT)" —
//     the ex-VAT parenthetical is OUTSIDE the strong so the
//     designer's eye locks onto the inclusive figure.
//   - EUR/USD: "<strong>Total = €X</strong>" — no parenthetical
//     to exclude, the whole Total stays bold.
//
// Parenthetical / capitalisation rules unchanged from the
// previous version of this file. Material display_name as-is;
// variant + finish lowercased; base option always renders as
// "natural finish" regardless of DB display_name.

// Quote-view switch from the compiler (migration 000178). Drives
// which sections this formatter emits: 'product' is the legacy
// product-only output (byte-identical to before the shipping
// feature shipped), 'shipping' emits only the shipping section,
// 'both' emits product followed by shipping.
export type QuoteCopyView = 'product' | 'shipping' | 'both'

export interface FormatQuoteArgs {
  selection: QuoteSelection
  result: QuoteResult
  materialDisplayName: string
  variantDisplayName: string | null
  finishOption: { displayName: string; isBase: boolean } | null
  vatRate: number | null
  // Lead-time line gate + payload (migration 000175). When
  // `leadTimeState` is null OR the toggle is off, the formatter
  // emits no lead-time line. Standard / custom states each render
  // their own sentence; not-set silently drops the line per the
  // brief (we never invent a lead time the admin hasn't recorded).
  includeLeadTime: boolean
  leadTimeState: LeadTimeState | null
  // Shipping copy gate + payload (migration 000178). Default is
  // 'product' so callers that haven't opted in get the same output
  // they did before this argument existed. The shipping section is
  // emitted only when a valid `shippingRate` is supplied and the
  // view is 'shipping' or 'both'.
  view?: QuoteCopyView
  shippingRate?: ShippingRate | null
  shippingIntlAdjustPercent?: number
  /** Domestic UK flat rate (migration 000179). Mutually exclusive
   *  with shippingRate — the resolver returns one or the other
   *  based on the destination country. */
  domesticRate?: DomesticRate | null
  /** Live GBP → EUR / USD multipliers. FedEx always invoices in GBP
   *  so EUR / USD shipping figures are conversions of the GBP base
   *  at this rate. Null falls through to GBP figures (same fail-safe
   *  as the on-screen card). */
  exchangeRates?: ExchangeRates | null
  /** Multi-box split (per-box weights, total, count). Surfaced as
   *  a "X boxes shipped" note in the shipping section when the
   *  parcel needs more than one box. */
  parcelSplit?: ParcelSplit | null
}

export interface FormattedQuote {
  plainText: string
  html: string
}

const EMPTY: FormattedQuote = { plainText: '', html: '' }

// Minimal HTML escape for content interpolated into the html
// output. The DB strings (material / variant / finish display
// names) are nominally clean, but defensive escaping costs
// nothing and means a future material like "Tom & Jerry" can't
// accidentally inject markup.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function finishWord(option: { displayName: string; isBase: boolean }): string {
  return option.isBase ? 'natural' : option.displayName.toLowerCase()
}

// Trim trailing zeros on the discount % — "10" reads as "10%" not
// "10.00%". Matches HeadlinePrice's on-screen formatter so the
// copy line and the headline breakdown agree.
function formatDiscountPercent(value: number): string {
  const rounded = Math.round(value * 100) / 100
  return `${rounded}%`
}

// "2 boxes at 14.12 kg each" for an even split; "3 boxes (12.00,
// 12.00, 12.13 kg)" if rounding gave a different last-box weight.
// Used inside the multiBoxNote sentence.
function formatBoxesPhrase(split: ParcelSplit): string {
  const { boxWeightsGrams, boxCount } = split
  const allEqual = boxWeightsGrams.every((w) => w === boxWeightsGrams[0])
  if (allEqual) {
    return `${boxCount} boxes at ${(boxWeightsGrams[0] / 1000).toFixed(2)} kg each`
  }
  const parts = boxWeightsGrams.map((w) => (w / 1000).toFixed(2))
  return `${boxCount} boxes (${parts.join(', ')} kg)`
}

export function formatQuoteForCopy(args: FormatQuoteArgs): FormattedQuote {
  const {
    selection,
    result,
    materialDisplayName,
    variantDisplayName,
    finishOption,
    vatRate,
    includeLeadTime,
    leadTimeState,
    view = 'product',
    shippingRate = null,
    shippingIntlAdjustPercent = 0,
    domesticRate = null,
    exchangeRates = null,
    parcelSplit = null,
  } = args
  const { quantity, currency, names } = selection
  const { total, baseTotal, splitNameSurcharge, finishSurcharge, personalisationSurcharge, discountAmount, discountPercent } = result

  // Shipping-only path bails on a different gate than product-only:
  // the product section needs a resolved tier, the shipping section
  // needs a quoted rate. Compute both up front so the branches below
  // can compose without re-checking.
  const showProduct = view === 'product' || view === 'both'
  // International (FedEx) shipping is included only when a usable
  // rate object came through. Domestic is included on a parallel
  // gate; the two are mutually exclusive so at most one renders.
  const showInternationalShipping =
    (view === 'shipping' || view === 'both')
    && shippingRate != null
    && shippingRate.available
    && shippingRate.netCharge != null
    && shippingRate.currency != null
  const showDomesticShipping =
    (view === 'shipping' || view === 'both')
    && domesticRate != null
  const showShipping = showInternationalShipping || showDomesticShipping

  // Product section needs a resolved tier. When the view doesn't
  // include the product section we skip this check entirely so a
  // designer can copy a shipping-only quote for a quantity that
  // happens not to be a tier (rare but possible).
  if (showProduct && (total == null || baseTotal == null || quantity == null || !currency)) return EMPTY
  if (!showProduct && !showShipping) return EMPTY

  // One distinct material per quote in v1 of the compiler — the
  // resolver produces at most one sentence. Null means "the toggle
  // is off, or no sentence applies" (not-set state); both paths
  // suppress the line block.
  const leadTimeLine =
    includeLeadTime && leadTimeState
      ? leadTimeQuoteLine(leadTimeState, materialDisplayName)
      : null

  // ── Product section (when included) ─────────────────────────
  // Computed in a branch so the shipping-only view doesn't need
  // any of the product values resolved. When showProduct is true
  // the inputs have already been validated as non-null by the
  // guard above, so the non-null assertions are safe.
  let productPlain: string[] = []
  let productHtml: string[] = []
  if (showProduct) {
    const cardsPrice = baseTotal! + (finishSurcharge ?? 0)
    const showSplitName = names > 1 && (splitNameSurcharge ?? 0) > 0
    const showPersonalisation = (personalisationSurcharge ?? 0) > 0
    const showDiscount = (discountAmount ?? 0) > 0 && discountPercent > 0
    const showVat = currency === 'GBP' && vatRate != null
    const exVatTotal = showVat ? Math.round((total! / (1 + vatRate)) * 100) / 100 : null

    let parenPlain = ''
    let parenHtml = ''
    if (variantDisplayName) {
      const vlow = variantDisplayName.toLowerCase()
      if (finishOption) {
        const fw = finishWord(finishOption)
        parenPlain = ` (${vlow} with ${fw} finish)`
        parenHtml = ` (${escapeHtml(vlow)} with ${escapeHtml(fw)} finish)`
      } else {
        parenPlain = ` (${vlow})`
        parenHtml = ` (${escapeHtml(vlow)})`
      }
    }

    const qtyStr = quantity!.toLocaleString()
    const cardsPriceStr = formatPrice(cardsPrice, currency!)
    const splitNameStr = showSplitName ? formatPrice(splitNameSurcharge!, currency!) : null
    const personalisationStr = showPersonalisation ? formatPrice(personalisationSurcharge!, currency!) : null
    const discountStr = showDiscount ? formatPrice(discountAmount!, currency!) : null
    const discountPctStr = showDiscount ? formatDiscountPercent(discountPercent) : null
    const totalStr = formatPrice(total!, currency!)
    const exVatStr = exVatTotal != null ? formatPrice(exVatTotal, 'GBP', 2) : null

    productPlain.push(`${qtyStr} ${materialDisplayName} cards${parenPlain} = ${cardsPriceStr}`)
    if (showSplitName) productPlain.push(`Extra setup to split batch between ${names} layouts = ${splitNameStr}`)
    if (showPersonalisation) productPlain.push(`Personalisation = ${personalisationStr}`)
    if (showDiscount) productPlain.push(`Discount (${discountPctStr}) = −${discountStr}`)
    productPlain.push('')
    let totalLinePlain = `Total = ${totalStr}`
    if (showVat) totalLinePlain += ` inc VAT (${exVatStr} ex VAT)`
    productPlain.push(totalLinePlain)

    productHtml.push(`${escapeHtml(qtyStr)} ${escapeHtml(materialDisplayName)} cards${parenHtml} = ${escapeHtml(cardsPriceStr)}`)
    if (showSplitName) productHtml.push(`Extra setup to split batch between ${names} layouts = ${escapeHtml(splitNameStr!)}`)
    if (showPersonalisation) productHtml.push(`Personalisation = ${escapeHtml(personalisationStr!)}`)
    if (showDiscount) productHtml.push(`Discount (${escapeHtml(discountPctStr!)}) = −${escapeHtml(discountStr!)}`)
    const totalCore = `Total = ${escapeHtml(totalStr)}`
    const totalLineHtml = showVat
      ? `<strong>${totalCore} inc VAT</strong> (${escapeHtml(exVatStr!)} ex VAT)`
      : `<strong>${totalCore}</strong>`
    productHtml.push(totalLineHtml)
  }

  // ── Shipping section (when included) ─────────────────────────
  // Copy-paste output keeps the shipping section minimal — service
  // line + total + optional multi-box and currency-conversion
  // footnotes. The on-card render in ShippingCard keeps the full
  // breakdown (base − discount + fuel + surcharges + international
  // adjustment) for designers to read; customers don't need to
  // see the internal accounting. Shipping is zero-rated for VAT
  // on international export so no VAT language even on GBP;
  // domestic UK rates include UK VAT and surface inc/ex VAT.
  //
  // FedEx invoices Plasma in GBP regardless of preferredCurrency,
  // so the international rate's numbers are always GBP. When the
  // compiler currency is EUR / USD we multiply the total by the
  // live exchange rate (Frankfurter / ECB) and tag the figure
  // with the rate used in a footnote.
  // Multi-box note shared by both the domestic and international
  // shipping paths. Returns null when shipping fits in one box
  // (the common case) so the formatter can omit the line cleanly.
  const multiBoxNote = parcelSplit && parcelSplit.boxCount > 1
    ? `Shipped as ${formatBoxesPhrase(parcelSplit)}.`
    : null

  let shippingPlain: string[] = []
  let shippingHtml: string[] = []
  if (showDomesticShipping && domesticRate) {
    // Domestic UK flat rate — single line total. VAT shown
    // inclusive-of for GBP; conversion footnote for EUR / USD.
    const displayCurrency = currency ?? 'GBP'
    const multiplier = gbpToCurrency(displayCurrency, exchangeRates)
    const totalDisplay = domesticRate.totalGbp * multiplier
    const showVatNote = displayCurrency === 'GBP' && vatRate != null && vatRate > 0
    const exVatTotal = showVatNote
      ? Math.round((domesticRate.totalGbp / (1 + vatRate)) * 100) / 100
      : null
    const showConversionNote = displayCurrency !== 'GBP' && exchangeRates !== null
    const regionLabel = domesticRate.region === 'uk_ni'
      ? 'Northern Ireland delivery'
      : 'Mainland delivery'

    shippingPlain.push(`Shipping — DPD UK · ${regionLabel}`)
    let totalLine = `Total shipping = ${formatPrice(totalDisplay, displayCurrency, 2)}`
    if (showVatNote && exVatTotal != null) {
      totalLine += ` inc VAT (${formatPrice(exVatTotal, 'GBP', 2)} ex VAT)`
    }
    shippingPlain.push(totalLine)
    if (multiBoxNote) shippingPlain.push(multiBoxNote)
    if (showConversionNote && exchangeRates) {
      const symbol = displayCurrency === 'EUR' ? '€' : '$'
      const dateTag = exchangeRates.rateDate ? ` (ECB ${exchangeRates.rateDate})` : ''
      shippingPlain.push(`Converted from ${formatPrice(domesticRate.totalGbp, 'GBP', 2)} at 1 GBP = ${symbol}${multiplier.toFixed(4)}${dateTag}.`)
    }

    shippingHtml.push(`Shipping — DPD UK · ${escapeHtml(regionLabel)}`)
    let totalLineHtml = `<strong>Total shipping = ${escapeHtml(formatPrice(totalDisplay, displayCurrency, 2))}</strong>`
    if (showVatNote && exVatTotal != null) {
      totalLineHtml += ` inc VAT (${escapeHtml(formatPrice(exVatTotal, 'GBP', 2))} ex VAT)`
    }
    shippingHtml.push(totalLineHtml)
    if (multiBoxNote) shippingHtml.push(escapeHtml(multiBoxNote))
    if (showConversionNote && exchangeRates) {
      const symbol = displayCurrency === 'EUR' ? '€' : '$'
      const dateTag = exchangeRates.rateDate ? ` (ECB ${escapeHtml(exchangeRates.rateDate)})` : ''
      shippingHtml.push(`<span style="color:#6b7280">Converted from ${escapeHtml(formatPrice(domesticRate.totalGbp, 'GBP', 2))} at 1 GBP = ${symbol}${multiplier.toFixed(4)}${dateTag}.</span>`)
    }
  } else if (showInternationalShipping && shippingRate) {
    const displayCurrency = currency ?? 'GBP'
    const multiplier = gbpToCurrency(displayCurrency, exchangeRates)
    const showConversionNote = displayCurrency !== 'GBP' && exchangeRates !== null

    // International total = FedEx net charge (which already
    // includes base − discount + fuel + surcharges) plus the
    // admin's international adjustment percentage. The on-card
    // render shows the components; copy keeps the total only.
    const netGbp = shippingRate.netCharge!
    const adjustedTotalGbp = applyIntlAdjustment(netGbp, shippingIntlAdjustPercent)

    const serviceLabel = shippingRate.serviceName ?? 'FedEx International'
    shippingPlain.push(`Shipping — ${serviceLabel}`)
    shippingPlain.push(`Total shipping = ${formatPrice(adjustedTotalGbp * multiplier, displayCurrency, 2)} (zero-rated for VAT)`)
    if (multiBoxNote) shippingPlain.push(multiBoxNote)
    if (showConversionNote && exchangeRates) {
      const symbol = displayCurrency === 'EUR' ? '€' : '$'
      const dateTag = exchangeRates.rateDate ? ` (ECB ${exchangeRates.rateDate})` : ''
      shippingPlain.push(`Converted from GBP at 1 GBP = ${symbol}${multiplier.toFixed(4)}${dateTag}.`)
    }

    shippingHtml.push(`Shipping — ${escapeHtml(serviceLabel)}`)
    shippingHtml.push(`<strong>Total shipping = ${escapeHtml(formatPrice(adjustedTotalGbp * multiplier, displayCurrency, 2))}</strong> (zero-rated for VAT)`)
    if (multiBoxNote) shippingHtml.push(escapeHtml(multiBoxNote))
    if (showConversionNote && exchangeRates) {
      const symbol = displayCurrency === 'EUR' ? '€' : '$'
      const dateTag = exchangeRates.rateDate ? ` (ECB ${escapeHtml(exchangeRates.rateDate)})` : ''
      shippingHtml.push(`<span style="color:#6b7280">Converted from GBP at 1 GBP = ${symbol}${multiplier.toFixed(4)}${dateTag}.</span>`)
    }
  }

  // ── Compose ──────────────────────────────────────────────────
  // Product-only output is byte-identical to the pre-shipping shape
  // (qty line(s) → blank → Total → blank → "This quote excludes
  // shipping." → optional lead-time block). When shipping is
  // included we DROP the "excludes shipping" line because the
  // quote now includes it. When the view is shipping-only, the
  // product block is omitted entirely.

  const plainLines: string[] = []
  if (showProduct) {
    plainLines.push(...productPlain)
    if (!showShipping) {
      plainLines.push('')
      plainLines.push('This quote excludes shipping.')
    }
  }
  if (showShipping) {
    if (plainLines.length > 0) plainLines.push('')
    plainLines.push(...shippingPlain)
  }
  if (leadTimeLine) {
    plainLines.push('')
    plainLines.push(leadTimeLine)
  }
  const plainText = plainLines.join('\n')

  const productHtmlBlock = productHtml.map((l) => l + '<br>').join('')
  const shippingHtmlBlock = shippingHtml.map((l) => l + '<br>').join('')
  let html = ''
  if (showProduct) {
    html += productHtmlBlock
    if (!showShipping) html += '<br>This quote excludes shipping.'
  }
  if (showShipping) {
    if (html.length > 0) html += '<br>'
    html += shippingHtmlBlock
  }
  if (leadTimeLine) {
    html += '<br><br>' + escapeHtml(leadTimeLine)
  }

  return { plainText, html }
}
