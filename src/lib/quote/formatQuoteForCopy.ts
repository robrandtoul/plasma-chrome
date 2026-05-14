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
  // Builds the qty/material line plus any surcharge / discount
  // lines. The standalone product Total line is held back so the
  // compose step can either emit it (product-only output) or
  // suppress it in favour of the combined TOTAL when shipping is
  // included. Computed in a branch so the shipping-only view
  // doesn't need any of the product values resolved.
  let productBodyPlain: string[] = []
  let productBodyHtml: string[] = []
  // Standalone product Total line, emitted only in product-only
  // output. Null when the product section isn't included.
  let productTotalLinePlain: string | null = null
  let productTotalLineHtml: string | null = null
  // Product total in the same display currency. Used by the
  // combined TOTAL line below.
  let productTotalAmount: number | null = null
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

    productBodyPlain.push(`${qtyStr} ${materialDisplayName} cards${parenPlain} = ${cardsPriceStr}`)
    if (showSplitName) productBodyPlain.push(`Extra setup to split batch between ${names} layouts = ${splitNameStr}`)
    if (showPersonalisation) productBodyPlain.push(`Personalisation = ${personalisationStr}`)
    if (showDiscount) productBodyPlain.push(`Discount (${discountPctStr}) = −${discountStr}`)

    let totalLinePlain = `Total = ${totalStr}`
    if (showVat) totalLinePlain += ` inc VAT (${exVatStr} ex VAT)`
    productTotalLinePlain = totalLinePlain

    productBodyHtml.push(`${escapeHtml(qtyStr)} ${escapeHtml(materialDisplayName)} cards${parenHtml} = ${escapeHtml(cardsPriceStr)}`)
    if (showSplitName) productBodyHtml.push(`Extra setup to split batch between ${names} layouts = ${escapeHtml(splitNameStr!)}`)
    if (showPersonalisation) productBodyHtml.push(`Personalisation = ${escapeHtml(personalisationStr!)}`)
    if (showDiscount) productBodyHtml.push(`Discount (${escapeHtml(discountPctStr!)}) = −${escapeHtml(discountStr!)}`)
    const totalCore = `Total = ${escapeHtml(totalStr)}`
    productTotalLineHtml = showVat
      ? `<strong>${totalCore} inc VAT</strong> (${escapeHtml(exVatStr!)} ex VAT)`
      : `<strong>${totalCore}</strong>`

    productTotalAmount = total!
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

  // Shipping section flattens to a single line: "Shipping —
  // Service Name = $X". The total figure goes inline rather than
  // on its own line. Multi-box note still surfaces beneath when
  // applicable. The shipping figure also feeds the combined
  // TOTAL line below.
  let shippingLinePlain: string | null = null
  let shippingLineHtml: string | null = null
  // Total shipping in display currency. Combined TOTAL adds this
  // to productTotalAmount.
  let shippingTotalAmount: number | null = null
  // Whether shipping is VAT-bearing at the current vatRate.
  // Domestic UK shipping (DPD) is standard-rated, so its GBP
  // figure includes VAT. International export is zero-rated.
  // Drives the ex-VAT half of the combined TOTAL line.
  let shippingIsVatBearing = false
  if (showDomesticShipping && domesticRate) {
    const displayCurrency = currency ?? 'GBP'
    const multiplier = gbpToCurrency(displayCurrency, exchangeRates)
    const totalDisplay = domesticRate.totalGbp * multiplier
    const regionLabel = domesticRate.region === 'uk_ni'
      ? 'Northern Ireland delivery'
      : 'Mainland delivery'
    const totalStr = formatPrice(totalDisplay, displayCurrency, 2)
    shippingLinePlain = `Shipping — DPD UK · ${regionLabel} = ${totalStr}`
    shippingLineHtml = `Shipping — DPD UK · ${escapeHtml(regionLabel)} = ${escapeHtml(totalStr)}`
    shippingTotalAmount = totalDisplay
    shippingIsVatBearing = displayCurrency === 'GBP'
  } else if (showInternationalShipping && shippingRate) {
    const displayCurrency = currency ?? 'GBP'
    const multiplier = gbpToCurrency(displayCurrency, exchangeRates)
    // International total = FedEx net charge (already includes
    // base − discount + fuel + surcharges) plus the admin's
    // international adjustment percentage. The on-card render
    // shows the components; copy keeps just the total.
    const netGbp = shippingRate.netCharge!
    const adjustedTotalGbp = applyIntlAdjustment(netGbp, shippingIntlAdjustPercent)
    const totalDisplay = adjustedTotalGbp * multiplier
    const totalStr = formatPrice(totalDisplay, displayCurrency, 2)
    const serviceLabel = shippingRate.serviceName ?? 'FedEx International'
    shippingLinePlain = `Shipping — ${serviceLabel} = ${totalStr}`
    shippingLineHtml = `Shipping — ${escapeHtml(serviceLabel)} = ${escapeHtml(totalStr)}`
    shippingTotalAmount = totalDisplay
    shippingIsVatBearing = false
  }

  // ── Compose ──────────────────────────────────────────────────
  // Three shapes the formatter emits, decided by which sections
  // are included:
  //
  //   product-only:
  //     product body lines (qty + surcharges + discount)
  //     <blank>
  //     Total = $X (inc VAT (Y ex VAT) on GBP)
  //     <blank>
  //     This quote excludes shipping.
  //     [<blank> + lead-time line]
  //
  //   shipping-only:
  //     Shipping — Service = $X
  //     [Shipped as N boxes ...]
  //     [<blank> + lead-time line]
  //
  //   both (the new combined shape — replaces the duplicate
  //   product Total with a single combined TOTAL):
  //     product body lines (no standalone Total)
  //     Shipping — Service = $X
  //     [Shipped as N boxes ...]
  //     <blank>
  //     TOTAL = $X (inc VAT (Y ex VAT) on GBP)
  //     [<blank> + lead-time line]

  // Compute the combined TOTAL line, used only when both product
  // and shipping are included. GBP gets an inc VAT / ex VAT
  // qualifier; the ex-VAT half splits between the product (always
  // VAT-bearing on GBP) and shipping (VAT-bearing only on
  // domestic UK; zero-rated on international export).
  function buildCombinedTotalLines(): { plain: string; html: string } | null {
    if (!showProduct || !showShipping) return null
    if (productTotalAmount == null || shippingTotalAmount == null) return null
    const displayCurrency = currency!
    const combined = productTotalAmount + shippingTotalAmount
    const combinedStr = formatPrice(combined, displayCurrency, 2)
    if (displayCurrency === 'GBP' && vatRate != null) {
      const productExVat = productTotalAmount / (1 + vatRate)
      const shippingExVat = shippingIsVatBearing
        ? shippingTotalAmount / (1 + vatRate)
        : shippingTotalAmount
      const combinedExVat = Math.round((productExVat + shippingExVat) * 100) / 100
      const exVatStr = formatPrice(combinedExVat, 'GBP', 2)
      return {
        plain: `TOTAL = ${combinedStr} inc VAT (${exVatStr} ex VAT)`,
        html: `<strong>TOTAL = ${escapeHtml(combinedStr)} inc VAT</strong> (${escapeHtml(exVatStr)} ex VAT)`,
      }
    }
    return {
      plain: `TOTAL = ${combinedStr}`,
      html: `<strong>TOTAL = ${escapeHtml(combinedStr)}</strong>`,
    }
  }
  const combinedTotal = buildCombinedTotalLines()

  // ── Plain text ────────────────────────────────────────────────
  const plainLines: string[] = []
  if (showProduct) {
    plainLines.push(...productBodyPlain)
  }
  if (showShipping && shippingLinePlain) {
    plainLines.push(shippingLinePlain)
    if (multiBoxNote) plainLines.push(multiBoxNote)
  }
  if (combinedTotal) {
    plainLines.push('')
    plainLines.push(combinedTotal.plain)
  } else if (showProduct && !showShipping && productTotalLinePlain) {
    // Product-only: keep the legacy "Total" + "This quote
    // excludes shipping." footer.
    plainLines.push('')
    plainLines.push(productTotalLinePlain)
    plainLines.push('')
    plainLines.push('This quote excludes shipping.')
  }
  if (leadTimeLine) {
    plainLines.push('')
    plainLines.push(leadTimeLine)
  }
  const plainText = plainLines.join('\n')

  // ── HTML ──────────────────────────────────────────────────────
  let html = ''
  if (showProduct) {
    html += productBodyHtml.map((l) => l + '<br>').join('')
  }
  if (showShipping && shippingLineHtml) {
    html += shippingLineHtml + '<br>'
    if (multiBoxNote) html += escapeHtml(multiBoxNote) + '<br>'
  }
  if (combinedTotal) {
    html += '<br>' + combinedTotal.html
  } else if (showProduct && !showShipping && productTotalLineHtml) {
    html += '<br>' + productTotalLineHtml
    html += '<br><br>This quote excludes shipping.'
  }
  if (leadTimeLine) {
    html += '<br><br>' + escapeHtml(leadTimeLine)
  }

  return { plainText, html }
}
