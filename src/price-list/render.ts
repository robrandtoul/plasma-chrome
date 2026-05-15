// Pure rendering + data-shaping. Reused by both the marketing-site
// entry (./main.ts) and the test harness's golden-master check
// (./golden-master.ts) so the two cannot drift.
//
// The shape consumed here mirrors public_get_price_list's jsonb
// payload (see migration 000184). Anything that wants to render a
// table needs only that payload plus a TableConfig.

import type { Dimension, SurchargeColumn, TableConfig } from './tables-config'

export interface ApiTier {
  quantity: number
  total_price: number
}

export interface ApiVariant {
  id: string
  code: string
  display_name: string
  variant_type: Dimension | string
  ink_count: number | null
  sort_order: number
  tiers: ApiTier[]
}

export interface ApiOptionSurcharge {
  option_code: string
  quantity: number
  surcharge: number
}

export interface ApiMaterial {
  code: string
  display_name: string
  variants: ApiVariant[]
  option_surcharges: ApiOptionSurcharge[]
}

export interface ApiPayload {
  currency: string
  materials: ApiMaterial[]
}

// One rendered cell per (row × column) for a given table. `total` is
// the integer pound/euro/dollar amount the live page shows; `null`
// means the underlying data isn't there. Surcharge cells live in
// their own array so column counts can stay aligned without
// interleaving.
export interface RenderedCell {
  quantity: number
  total: number | null
}

export interface RenderedRow {
  quantity: number
  cells: Array<number | null>
  surcharge: number | null
}

export interface RenderedTable {
  key: string
  title: string
  column_headers: string[]
  surcharge_header: string | null
  rows: RenderedRow[]
}

// Currency symbol — the marketing pages already render the symbol per
// page, but the script generates the cell text including it so the
// rendered HTML doesn't require an upstream prefix step.
const CURRENCY_SYMBOLS: Record<string, string> = {
  GBP: '£',
  EUR: '€',
  USD: '$',
}

export function currencySymbol(code: string): string {
  return CURRENCY_SYMBOLS[code.toUpperCase()] ?? ''
}

// Render a numeric total as e.g. "£1,234". No decimals — the live
// CommonNinja tables round to the pound. Returns the empty string for
// null so the cell stays blank instead of saying "—".
export function formatPrice(value: number | null, currency: string): string {
  if (value == null || !Number.isFinite(value)) return ''
  const rounded = Math.round(value)
  return `${currencySymbol(currency)}${rounded.toLocaleString('en-GB')}`
}

export function formatSurcharge(value: number | null, currency: string): string {
  if (value == null || !Number.isFinite(value)) return ''
  const rounded = Math.round(value)
  return `add ${currencySymbol(currency)}${rounded.toLocaleString('en-GB')}`
}

// Pick the variant for a given column. The dimension determines what
// to match on; returns undefined when no variant matches (which leaves
// the cell blank rather than crashing the row).
export function pickVariant(
  material: ApiMaterial,
  dimension: Dimension,
  columnKey: string | number,
): ApiVariant | undefined {
  if (dimension === 'default') {
    return material.variants[0]
  }
  if (dimension === 'ink_count') {
    const wanted = typeof columnKey === 'number' ? columnKey : Number(columnKey)
    return material.variants.find((v) => v.ink_count === wanted)
  }
  if (dimension === 'finish') {
    const wanted = String(columnKey)
    return material.variants.find((v) => v.code === wanted)
  }
  if (dimension === 'thickness') {
    // Match the leading micron number on the display_name, e.g.
    // "300 micron" → 300. The seed data is consistent on this prefix
    // (see migration 000009).
    const wanted = String(columnKey)
    return material.variants.find((v) => {
      const leading = v.display_name.match(/^(\d+)/)?.[1]
      return leading === wanted
    })
  }
  return undefined
}

function priceAt(variant: ApiVariant | undefined, quantity: number): number | null {
  if (!variant) return null
  const tier = variant.tiers.find((t) => t.quantity === quantity)
  return tier ? Number(tier.total_price) : null
}

function lookupSurcharge(
  payload: ApiPayload,
  material: ApiMaterial,
  surchargeColumn: SurchargeColumn,
  quantity: number,
): number | null {
  if (surchargeColumn.type === 'metal_finish') {
    // brushed and mirror are seeded identically — pick the first one
    // we find at this quantity. If neither row exists, return null.
    const row = material.option_surcharges.find(
      (s) =>
        s.quantity === quantity &&
        (s.option_code === 'brushed' || s.option_code === 'mirror'),
    )
    return row ? Number(row.surcharge) : null
  }
  if (surchargeColumn.type === 'cnc' || surchargeColumn.type === 'gilding') {
    const source = payload.materials.find(
      (m) => m.code === surchargeColumn.source_material_code,
    )
    if (!source) return null
    // Both upgrade materials use the 'default' dimension (single
    // variant). For gilding we look at the 1-ink letterpress total —
    // the difference is documented as constant across ink counts, so
    // any column gives the same number; 1-ink is the canonical pick.
    const sourceVariant =
      source.variants[0] ??
      undefined
    const baseVariant =
      surchargeColumn.type === 'gilding'
        ? material.variants.find((v) => v.ink_count === 1)
        : material.variants[0]
    const sourceTotal = priceAt(sourceVariant, quantity)
    const baseTotal = priceAt(baseVariant, quantity)
    if (sourceTotal == null || baseTotal == null) return null
    return sourceTotal - baseTotal
  }
  return null
}

export function buildTable(payload: ApiPayload, config: TableConfig): RenderedTable {
  const material = payload.materials.find((m) => m.code === config.material_code)
  const rows: RenderedRow[] = config.quantities.map((quantity) => {
    const cells: Array<number | null> = config.column_match.map((key) => {
      if (!material) return null
      const variant = pickVariant(material, config.dimension, key)
      return priceAt(variant, quantity)
    })
    const surcharge =
      config.surcharge_column && material
        ? lookupSurcharge(payload, material, config.surcharge_column, quantity)
        : null
    return { quantity, cells, surcharge }
  })
  return {
    key: config.key,
    title: config.title,
    column_headers: config.column_headers,
    surcharge_header: config.surcharge_column?.header ?? null,
    rows,
  }
}

// ── DOM rendering ────────────────────────────────────────────────────
//
// Vanilla DOM — no innerHTML interpolation of dynamic strings (the
// values themselves are numbers we format, but we still use
// textContent everywhere so the script is safe against any future
// shape change that lets a string slip in).

export function renderTableInto(
  host: HTMLElement,
  table: RenderedTable,
  currency: string,
): void {
  host.replaceChildren(buildTableElement(table, currency))
}

export function buildTableElement(table: RenderedTable, currency: string): HTMLTableElement {
  const el = document.createElement('table')
  el.className = 'plasma-price-table'
  el.setAttribute('data-price-table', table.key)

  const thead = document.createElement('thead')
  const headerRow = document.createElement('tr')

  // Blank top-left corner (intentional — matches the live tables).
  headerRow.appendChild(document.createElement('th'))

  for (const header of table.column_headers) {
    const th = document.createElement('th')
    th.textContent = header
    headerRow.appendChild(th)
  }
  if (table.surcharge_header) {
    const th = document.createElement('th')
    th.textContent = table.surcharge_header
    headerRow.appendChild(th)
  }
  thead.appendChild(headerRow)
  el.appendChild(thead)

  const tbody = document.createElement('tbody')
  for (const row of table.rows) {
    const tr = document.createElement('tr')
    const qtyCell = document.createElement('td')
    qtyCell.className = 'plasma-price-qty'
    qtyCell.textContent = String(row.quantity)
    tr.appendChild(qtyCell)

    for (const cell of row.cells) {
      const td = document.createElement('td')
      td.textContent = formatPrice(cell, currency)
      tr.appendChild(td)
    }

    if (table.surcharge_header) {
      const td = document.createElement('td')
      td.textContent = formatSurcharge(row.surcharge, currency)
      tr.appendChild(td)
    }
    tbody.appendChild(tr)
  }
  el.appendChild(tbody)

  return el
}

// Visual spec is captured here as a CSS string injected once into
// <head>. Values are taken from the live GBP CommonNinja page,
// 2026-05-15.
//
// The "no row striping, transparent backgrounds" rule is enforced by
// not setting any background colour — keep it that way.
export const STYLE_TAG_ID = 'plasma-price-list-style'

export const STYLES = `
.plasma-price-table {
  border-collapse: collapse;
  text-align: center;
  font-family: Poppins, sans-serif;
  width: 100%;
  margin: 0 auto;
}
.plasma-price-table thead th {
  font-size: 16px;
  font-weight: 700;
  color: rgb(153, 153, 153);
  padding: 10px;
  text-align: center;
  border-bottom: 1px solid rgb(170, 170, 170);
  background: transparent;
}
.plasma-price-table tbody tr {
  border-bottom: 1px solid rgb(221, 221, 221);
  background: transparent;
}
.plasma-price-table tbody td {
  font-size: 14px;
  font-weight: 300;
  color: rgb(68, 68, 68);
  padding: 10px;
  text-align: center;
}
.plasma-price-table tbody td.plasma-price-qty {
  font-size: 16px;
  font-weight: 300;
  color: rgb(34, 34, 34);
  padding: 10px 15px;
  text-align: left;
}
.plasma-price-list-placeholder[data-state="loading"]::before,
.plasma-price-list-placeholder[data-state="error"]::before {
  display: block;
  font-family: Poppins, sans-serif;
  font-size: 14px;
  font-weight: 300;
  color: rgb(153, 153, 153);
  padding: 20px 10px;
  text-align: center;
}
.plasma-price-list-placeholder[data-state="loading"]::before {
  content: 'Loading prices…';
}
.plasma-price-list-placeholder[data-state="error"]::before {
  content: 'Pricing is being updated — please refresh in a moment.';
}
`

export function ensureStylesInjected(doc: Document = document): void {
  if (doc.getElementById(STYLE_TAG_ID)) return
  const style = doc.createElement('style')
  style.id = STYLE_TAG_ID
  style.textContent = STYLES
  doc.head.appendChild(style)
}

// Poppins font is loaded from Google Fonts to match the CommonNinja
// embed's setup. Idempotent — the marketing site already loads
// Poppins via Squarespace's theme, so the script appends a second
// reference only when the font isn't already present.
const FONT_TAG_ID = 'plasma-price-list-font'

export function ensureFontLoaded(doc: Document = document): void {
  if (doc.getElementById(FONT_TAG_ID)) return
  const link = doc.createElement('link')
  link.id = FONT_TAG_ID
  link.rel = 'stylesheet'
  link.href = 'https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;700&display=swap'
  doc.head.appendChild(link)
}
