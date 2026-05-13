import { formatPrice } from '../currency'
import type { Currency } from '../types'
import type { SpreadRow } from './spreadCalculate'

// Help Scout-friendly multi-quantity quote formatter. Plain-text
// for terminals / Notes / plain reply boxes, HTML for Help
// Scout's rich-text editor.
//
// Help Scout quirks the format works around:
// - Markdown tables don't render — uses real <table>.
// - <p> renders with no gap around it — uses <br><br> between
//   paragraphs.
// - All styling has to be inline; HS strips classnames.
// - No sign-off line — HS appends the agent signature for us.
//
// Column order (customer-facing): Quantity, Total, Unit price.
// The savings column lives only in the internal on-screen view —
// useful nudge for the designer but customers don't need it
// hardcoded into the email.
//
// includeUnitPrice toggles the Unit-price column in BOTH paths.
// Default off in the caller (presentation choice on the results
// card), so the simplest customer-facing copy is just Quantity +
// Total.
//
// Caller responsibilities:
// - Filter rows to valid ones before passing in. The formatter
//   doesn't render placeholders for invalid rows.
// - Pass display names — the formatter never reads from the DB;
//   it just composes strings and escapes them for HTML.

export interface FormatSpreadArgs {
  rows: readonly SpreadRow[] // valid rows only, sorted ascending
  currency: Currency
  materialDisplayName: string
  variantDisplayName: string | null
  finishOption: { displayName: string; isBase: boolean } | null
  // Quantity-independent items.
  splitNameSurcharge: number
  names: number
  perExtraNameSurcharge: number | null
  // Custom-quote flags carried through to the bottom of the
  // copy as red-flag bullets.
  customFlags: { nfc: boolean }
  // Migration 000172. When personalisationActive is true the
  // copy emits a dedicated Personalisation column matching the
  // on-screen Spread table, plus a "minimum applies below N
  // cards" footnote keyed off personalisationBreakevenQty.
  // Without these the customer would read the table's Total
  // figures (which already include personalisation per row from
  // spreadCalculate) with no disclosure — a high-severity gap
  // surfaced by the bug sweep.
  personalisationActive: boolean
  personalisationBreakevenQty: number | null
  // Whether to include the Unit-price column in the output.
  // Default off in the caller; designer flips ON when the
  // customer has asked for per-card prices.
  includeUnitPrice: boolean
}

export interface FormattedSpreadQuote {
  plainText: string
  html: string
}

const EMPTY: FormattedSpreadQuote = { plainText: '', html: '' }

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function finishWord(option: { displayName: string; isBase: boolean }): string {
  return option.isBase ? 'natural' : option.displayName.toLowerCase()
}

export function formatSpreadQuoteForCopy(args: FormatSpreadArgs): FormattedSpreadQuote {
  const {
    rows,
    currency,
    materialDisplayName,
    variantDisplayName,
    finishOption,
    splitNameSurcharge,
    names,
    perExtraNameSurcharge,
    customFlags,
    personalisationActive,
    personalisationBreakevenQty,
    includeUnitPrice,
  } = args

  if (rows.length === 0) return EMPTY

  const isGbp = currency === 'GBP'
  const headerNote = isGbp ? ' (inc VAT)' : ''

  // Spec line — "Steel cards (350 micron with brushed finish)"
  let specSuffixPlain = ''
  let specSuffixHtml = ''
  if (variantDisplayName) {
    const vlow = variantDisplayName.toLowerCase()
    if (finishOption) {
      const fw = finishWord(finishOption)
      specSuffixPlain = ` (${vlow} with ${fw} finish)`
      specSuffixHtml = ` (${escapeHtml(vlow)} with ${escapeHtml(fw)} finish)`
    } else {
      specSuffixPlain = ` (${vlow})`
      specSuffixHtml = ` (${escapeHtml(vlow)})`
    }
  } else if (finishOption) {
    const fw = finishWord(finishOption)
    specSuffixPlain = ` (${fw} finish)`
    specSuffixHtml = ` (${escapeHtml(fw)} finish)`
  }

  // ── Plain-text ────────────────────────────────────────────
  const plainLines: string[] = []
  plainLines.push(
    `Quote for ${materialDisplayName} cards${specSuffixPlain}, priced in ${currency}${headerNote}:`,
  )
  plainLines.push('')

  const qtyWidth = Math.max(
    8,
    ...rows.map((r) => r.quantity.toLocaleString().length),
  )
  const personalisationWidth = 15
  const totalWidth = 11
  const headerCols = [
    'Qty'.padEnd(qtyWidth),
  ]
  // Personalisation column sits between Qty and Total so the
  // customer reads the breakdown as base + add-on → total left to
  // right, same shape as the on-screen Spread table.
  if (personalisationActive) headerCols.push('Personalisation'.padEnd(personalisationWidth))
  headerCols.push('Total'.padEnd(totalWidth))
  if (includeUnitPrice) headerCols.push('Unit price')
  plainLines.push(headerCols.join('  '))

  for (const r of rows) {
    if (r.total == null) continue
    const cols = [
      r.quantity.toLocaleString().padEnd(qtyWidth),
    ]
    if (personalisationActive) {
      cols.push(formatPrice(r.personalisationSurcharge, currency).padEnd(personalisationWidth))
    }
    cols.push(formatPrice(r.total, currency).padEnd(totalWidth))
    if (includeUnitPrice && r.unitPrice != null) {
      cols.push(formatPrice(r.unitPrice, currency, 2))
    }
    plainLines.push(cols.join('  '))
  }

  // Split-name block — three-line shape that mirrors the
  // customer-facing proof viewer copy. Heading, value (total
  // surcharge × total name count), then the explanatory subtext.
  // Only renders when names >= 2; single-name orders are silent.
  const showSplitNameBlock = splitNameSurcharge > 0 && perExtraNameSurcharge != null && names >= 2
  if (showSplitNameBlock) {
    plainLines.push('')
    plainLines.push(
      `Split-name tooling - Totals already include ${formatPrice(splitNameSurcharge, currency)} charge to split batch between ${names} names. This covers the extra tooling and machine set up incurred.`,
    )
  }

  // Personalisation footnote — mirrors the on-screen "Minimum
  // personalisation charge applies below N cards" treatment. Only
  // renders when personalisationActive is true and a breakeven
  // was supplied; the column above already itemises the per-qty
  // surcharge, this band just discloses the floor.
  if (personalisationActive && personalisationBreakevenQty != null) {
    plainLines.push('')
    plainLines.push(
      `Personalisation - Totals already include personalisation. A minimum personalisation charge applies below ${personalisationBreakevenQty.toLocaleString()} cards.`,
    )
  }

  const flagLines: string[] = []
  if (customFlags.nfc) {
    flagLines.push('NFC chips selected — needs custom quote, prices above are without NFC.')
  }
  if (flagLines.length > 0) {
    plainLines.push('')
    plainLines.push(...flagLines)
  }

  if (isGbp) {
    plainLines.push('Prices include VAT. This quote excludes shipping.')
  } else {
    plainLines.push('This quote excludes shipping.')
  }
  const plainText = plainLines.join('\n')

  // ── HTML ──────────────────────────────────────────────────
  // Inline-styled table — Help Scout strips classnames but
  // honours inline style attributes.
  const tableStyle =
    'border-collapse:collapse;font-family:inherit;font-size:14px;margin:0;'
  const thStyle =
    'border:1px solid #d1d5db;padding:6px 10px;text-align:left;background:#f9fafb;font-weight:600;'
  const thNumStyle =
    'border:1px solid #d1d5db;padding:6px 10px;text-align:right;background:#f9fafb;font-weight:600;'
  const tdStyle =
    'border:1px solid #e5e7eb;padding:6px 10px;text-align:left;'
  const tdNumStyle =
    'border:1px solid #e5e7eb;padding:6px 10px;text-align:right;font-variant-numeric:tabular-nums;'

  const htmlParts: string[] = []
  htmlParts.push(
    `Quote for ${escapeHtml(materialDisplayName)} cards${specSuffixHtml}, priced in ${currency}${escapeHtml(headerNote)}:`,
  )
  htmlParts.push('<br><br>')

  htmlParts.push(`<table style="${tableStyle}"><thead><tr>`)
  htmlParts.push(`<th style="${thStyle}">Quantity</th>`)
  if (personalisationActive) {
    htmlParts.push(`<th style="${thNumStyle}">Personalisation</th>`)
  }
  htmlParts.push(`<th style="${thNumStyle}">Total</th>`)
  if (includeUnitPrice) {
    htmlParts.push(`<th style="${thNumStyle}">Unit price</th>`)
  }
  htmlParts.push(`</tr></thead><tbody>`)
  for (const r of rows) {
    if (r.total == null) continue
    let row =
      `<tr>` +
      `<td style="${tdStyle}">${escapeHtml(r.quantity.toLocaleString())}</td>`
    if (personalisationActive) {
      row += `<td style="${tdNumStyle}">${escapeHtml(formatPrice(r.personalisationSurcharge, currency))}</td>`
    }
    row += `<td style="${tdNumStyle}">${escapeHtml(formatPrice(r.total, currency))}</td>`
    if (includeUnitPrice && r.unitPrice != null) {
      row += `<td style="${tdNumStyle}">${escapeHtml(formatPrice(r.unitPrice, currency, 2))}</td>`
    }
    row += `</tr>`
    htmlParts.push(row)
  }
  htmlParts.push(`</tbody></table>`)

  if (showSplitNameBlock) {
    htmlParts.push('<br><br>')
    htmlParts.push(
      `<p><b>Split-name tooling</b> - Totals already include ${escapeHtml(formatPrice(splitNameSurcharge, currency))} charge to split batch between ${escapeHtml(String(names))} names. This covers the extra tooling and machine set up incurred.</p>`,
    )
  }

  if (personalisationActive && personalisationBreakevenQty != null) {
    htmlParts.push('<br><br>')
    htmlParts.push(
      `<p><b>Personalisation</b> - Totals already include personalisation. A minimum personalisation charge applies below ${escapeHtml(personalisationBreakevenQty.toLocaleString())} cards.</p>`,
    )
  }

  if (flagLines.length > 0) {
    htmlParts.push('<br><br>')
    htmlParts.push(
      `<strong>${escapeHtml(flagLines.length === 1 ? 'Note' : 'Notes')}:</strong><br>` +
        flagLines.map((l) => escapeHtml(l)).join('<br>'),
    )
  }

  htmlParts.push('<br>')
  htmlParts.push(
    isGbp
      ? 'Prices include VAT. This quote excludes shipping.'
      : 'This quote excludes shipping.',
  )

  const html = htmlParts.join('')

  return { plainText, html }
}
