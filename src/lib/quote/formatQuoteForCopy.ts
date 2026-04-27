import { formatPrice } from '../currency'
import type { QuoteResult, QuoteSelection } from './calculate'

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

export interface FormatQuoteArgs {
  selection: QuoteSelection
  result: QuoteResult
  materialDisplayName: string
  variantDisplayName: string | null
  finishOption: { displayName: string; isBase: boolean } | null
  vatRate: number | null
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

export function formatQuoteForCopy(args: FormatQuoteArgs): FormattedQuote {
  const { selection, result, materialDisplayName, variantDisplayName, finishOption, vatRate } = args
  const { quantity, currency, names } = selection
  const { total, baseTotal, splitNameSurcharge, finishSurcharge } = result

  if (total == null || baseTotal == null || quantity == null || !currency) return EMPTY

  // Shared intermediate values — computed once, used by both
  // plain-text and html builders. Round ex-VAT at the same 2dp
  // boundary HeadlinePrice does so the two outputs agree.
  const cardsPrice = baseTotal + (finishSurcharge ?? 0)
  const showSplitName = names > 1 && (splitNameSurcharge ?? 0) > 0
  const showVat = currency === 'GBP' && vatRate != null
  const exVatTotal = showVat ? Math.round((total / (1 + vatRate)) * 100) / 100 : null

  // Spec parenthetical, shared between plain and html paths. The
  // html version escapes its parts; the plain version doesn't
  // need to. Build once with raw strings, escape on the html
  // side at use.
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

  const qtyStr = quantity.toLocaleString()
  const cardsPriceStr = formatPrice(cardsPrice, currency)
  const splitNameStr = showSplitName ? formatPrice(splitNameSurcharge!, currency) : null
  const totalStr = formatPrice(total, currency)
  const exVatStr = exVatTotal != null ? formatPrice(exVatTotal, 'GBP', 2) : null

  // ── Plain-text (unchanged spacing) ───────────────────────────
  const plainLines: string[] = []
  plainLines.push(`${qtyStr} ${materialDisplayName} cards${parenPlain} = ${cardsPriceStr}`)
  if (showSplitName) {
    plainLines.push(`Extra setup to split batch between ${names} layouts = ${splitNameStr}`)
  }
  plainLines.push('')
  let totalLinePlain = `Total = ${totalStr}`
  if (showVat) totalLinePlain += ` inc VAT (${exVatStr} ex VAT)`
  plainLines.push(totalLinePlain)
  plainLines.push('')
  plainLines.push('This quote excludes shipping.')
  const plainText = plainLines.join('\n')

  // ── HTML (tight spacing, bolded Total) ───────────────────────
  // Content lines join with single <br>; a leading <br> before
  // the disclaimer produces the one blank-line gap.
  const htmlLines: string[] = []
  htmlLines.push(`${escapeHtml(qtyStr)} ${escapeHtml(materialDisplayName)} cards${parenHtml} = ${escapeHtml(cardsPriceStr)}`)
  if (showSplitName) {
    htmlLines.push(`Extra setup to split batch between ${names} layouts = ${escapeHtml(splitNameStr!)}`)
  }
  // Total line — strong wraps up to and including " inc VAT" on
  // GBP, the ex-VAT parenthetical sits outside; on EUR/USD the
  // whole "Total = $X" is wrapped.
  const totalCore = `Total = ${escapeHtml(totalStr)}`
  const totalLineHtml = showVat
    ? `<strong>${totalCore} inc VAT</strong> (${escapeHtml(exVatStr!)} ex VAT)`
    : `<strong>${totalCore}</strong>`
  htmlLines.push(totalLineHtml)
  // Each content line followed by <br>; extra <br> before the
  // disclaimer produces the blank-line gap.
  const html =
    htmlLines.map((l) => l + '<br>').join('') +
    '<br>' +
    'This quote excludes shipping.'

  return { plainText, html }
}
