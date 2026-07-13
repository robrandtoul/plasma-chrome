// Builds the Xero invoice line items for a paid order.
//
// Extracted verbatim from stripe-webhook so the xero-invoice-selftest function
// exercises the EXACT same variant/option → Xero ItemCode resolution the live
// payment path uses — a copy would be free to drift and prove nothing. Both
// callers run in Deno, so this is a genuine shared module (unlike the src/
// vs functions/ pricing split, which has to keep two copies in lockstep).
//
// The product line's ItemCode comes from material_variants.xero_item_code,
// overridden by material_options.xero_item_code when the chosen option carries
// its own (each wood species does). Tooling books to 020, shipping to 052 (UK)
// or 050 (international) — all overridable via env. Xero then derives each
// line's sales account and tax rate from the item, so getting the code right is
// what gets the tax right.

import { type SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { type InvoiceLine } from './xero.ts'
import { isUkVatAreaCountry } from './ukVatArea.ts'
import { zeroRatedRegion } from './euVatArea.ts'

const round2 = (n: number) => Math.round(n * 100) / 100

// The order fields the line builder needs. The live path passes a row read from
// proofs.orders; the self-test synthesises one per product so it never has to
// insert (and clean up) real order rows.
export interface OrderForInvoice {
  proof_id: string | null
  material_variant_id: string | null
  material_option_id: string | null
  quantity: number | null
  names_count: number | null
  custom_quote_total: number | null
  amount_cards: number | null
  amount_tooling: number | null
  amount_personalisation: number | null
  amount_shipping: number | null
  amount_us_tariff: number | null
  // Designer-set per-order discount on the goods subtotal (cards + tooling +
  // personalisation), stamped at checkout. Booked as a separate negative line
  // carrying the product's own item code so it inherits the correct VAT rate
  // (every goods line shares one rate per invoice); null / 0 → no discount line.
  amount_card_discount: number | null
  // 'production' (default) | 'prototype'. A prototype is a custom-quote order
  // (custom_quote_total = the flat prototyping fee) that kept its variant, so
  // it's labelled as the material it samples rather than the generic "Order".
  order_kind?: string | null
}

export interface InvoiceBuildContext {
  reference: string
  currency: string // GBP | EUR | USD, upper-case
  // The charged total. The itemised lines MUST sum to this (within a penny) or
  // they collapse to a single summary line so the Stripe→Xero bank-feed match
  // can't break. The self-test passes the exact built sum so they never collapse.
  expectedTotal: number
  // ISO-2 delivery country. Drives domestic (UK) vs international shipping item.
  // Null → infer from currency (GBP ⇒ UK), matching the live fallback.
  country: string | null
}

export interface InvoiceBuildResult {
  lines: InvoiceLine[]
  // The ItemCode resolved for the product line (variant code, or the option
  // override when the chosen option carries its own). Null for custom quotes or
  // an unmapped variant. Informational for the self-test, which also reads the
  // code Xero echoes back on the created invoice.
  productItemCode: string | null
  domestic: boolean
}

// The Xero TaxType a VAT-free invoice's lines should carry: the org's
// "0% EU" rate for deliveries into the EU VAT area, "0% ROW" for everywhere
// else (see _shared/euVatArea.ts for the classification, including the
// currency fallback when no delivery country is known). The codes are
// admin-configured (settings 000306, picked from the org's rate list in
// Admin → Settings); null — region unresolvable or the code unset — keeps
// the legacy NoTax treatment, so this can never block an invoice.
export async function resolveZeroRatedTaxType(
  admin: SupabaseClient,
  country: string | null,
  currency: string,
): Promise<string | null> {
  const region = zeroRatedRegion(country, currency)
  if (!region) return null
  const { data } = await admin
    .from('settings')
    .select('xero_eu_tax_type, xero_row_tax_type')
    .eq('id', 1)
    .maybeSingle()
  const code = region === 'eu'
    ? (data?.xero_eu_tax_type as string | null | undefined)
    : (data?.xero_row_tax_type as string | null | undefined)
  return code?.trim() || null
}

// The per-order GOODS lines: the product line (custom quote or grid, with the
// item-code resolution described in the header), the tooling line, and the
// designer-discount line. NO shipping / US tariff / sum-check — those are the
// caller's: buildOrderInvoiceLines appends one of each for a standalone order,
// buildGroupInvoiceLines appends ONE combined pair for a whole order group
// (bundle orders Slice 2 — a product + tooling line per card, one shipping,
// one tariff, spec §6).
export async function buildOrderGoodsLines(
  admin: SupabaseClient,
  order: OrderForInvoice,
  reference: string,
): Promise<{ lines: InvoiceLine[]; productItemCode: string | null }> {
  // Resolve the product's Xero item + a human label for the line.
  let itemCode: string | null = null
  let materialName = ''
  let variantName = ''
  let optionName = ''
  let materialId: string | null = null
  if (order.material_variant_id) {
    const { data: v } = await admin
      .from('material_variants')
      .select('xero_item_code, display_name, material_id, materials(display_name)')
      .eq('id', order.material_variant_id)
      .single()
    itemCode = (v?.xero_item_code as string | null) ?? null
    variantName = (v?.display_name as string | null) ?? ''
    materialId = (v?.material_id as string | null) ?? null
    materialName = ((v?.materials as { display_name?: string } | null)?.display_name) ?? ''
  }

  // Per-option Xero code + label. Prefer the option the ORDER pinned
  // (material_option_id, 000239 — e.g. the customer's metal finish choice);
  // fall back to the version's single offered option for orders created
  // before that column. Some materials map to a different Xero item per
  // option (wood species each have their own code — Bamboo 0153, …); when
  // the chosen option carries its own code, use it instead of the variant's
  // generic one. The option is named on the line either way ("Steel 500µm
  // — Mirror" / "Wood — Bamboo").
  if (materialId) {
    let mo: { display_name: string | null; xero_item_code: string | null } | null = null
    if (order.material_option_id) {
      const { data } = await admin
        .from('material_options')
        .select('display_name, xero_item_code')
        .eq('id', order.material_option_id)
        .maybeSingle()
      mo = (data as typeof mo) ?? null
    } else if (order.proof_id) {
      const { data: pv } = await admin
        .from('proof_versions')
        .select('material_options')
        .eq('proof_id', order.proof_id)
        .eq('is_current', true)
        .maybeSingle()
      const opts = (pv?.material_options as string[] | null) ?? []
      if (opts.length === 1) {
        const { data } = await admin
          .from('material_options')
          .select('display_name, xero_item_code')
          .eq('material_id', materialId)
          .eq('code', opts[0])
          .maybeSingle()
        mo = (data as typeof mo) ?? null
      }
    }
    if (mo) {
      optionName = (mo.display_name as string | null) ?? optionName
      if (mo.xero_item_code) itemCode = mo.xero_item_code as string
    }
  }

  const toolingItem = Deno.env.get('XERO_TOOLING_ITEM_CODE') ?? '020'

  const lines: InvoiceLine[] = []
  const cards = Number(order.amount_cards ?? 0)
  const tooling = Number(order.amount_tooling ?? 0)
  const personalisation = Number(order.amount_personalisation ?? 0)
  const cardDiscount = round2(Number(order.amount_card_discount ?? 0))
  // The code that lands on the product line, before any summary-fallback below.
  let productItemCode: string | null = null

  if (order.custom_quote_total != null) {
    // Custom quote: one product line for the agreed figure. A prototype is a
    // custom quote whose figure is the flat per-family fee; it kept its variant
    // so the resolved item code is correct — label it as the material it
    // samples rather than the generic "Order <ref>".
    let description = `Order ${reference}`
    if (order.order_kind === 'prototype') {
      const variantSuffix = variantName && variantName !== materialName ? ` ${variantName}` : ''
      const optionSuffix = optionName ? ` — ${optionName}` : ''
      description = `${materialName || 'Cards'}${variantSuffix}${optionSuffix} — prototype sample`.trim()
    }
    lines.push({ description, amount: Number(order.custom_quote_total), itemCode })
    productItemCode = itemCode
  } else if (order.amount_cards != null) {
    // Grid order: product line (cards + personalisation folded in),
    // then tooling. The card count goes in the Qty column
    // (with a per-unit price) rather than the description — see the
    // quantity handling in createSalesInvoice.
    const variantSuffix = variantName && variantName !== materialName ? ` ${variantName}` : ''
    const optionSuffix = optionName ? ` — ${optionName}` : ''
    const productLabel = `${materialName || 'Cards'}${variantSuffix}${optionSuffix}`.trim()
    lines.push({
      description: productLabel,
      amount: round2(cards + personalisation),
      itemCode,
      quantity: order.quantity != null ? Number(order.quantity) : null,
    })
    productItemCode = itemCode
    if (tooling > 0) {
      const n = Number(order.names_count ?? 1)
      lines.push({
        description: n > 1 ? `Extra tooling (split between ${n} names)` : 'Extra tooling',
        amount: tooling,
        itemCode: toolingItem,
      })
    }
  }
  // Designer-set goods discount (base: cards + tooling + personalisation) — a
  // separate negative line carrying the SAME item code as the product line, so
  // Xero applies the goods lines' own VAT rate to the (negative) discount and
  // the net VAT comes out right (all goods lines share one rate per invoice;
  // the discount can exceed the product line alone but never the goods sum, so
  // the invoice total stays >= 0). The goods lines stay at full price; this
  // shows the saving and nets the total down.
  if (cardDiscount > 0 && lines.length > 0) {
    lines.push({ description: 'Discount', amount: -cardDiscount, itemCode })
  }

  return { lines, productItemCode }
}

// The domestic-vs-international shipping item for a delivery country. Follows
// the UK VAT AREA: GB + Isle of Man → the domestic (VAT-bearing) code; the
// Channel Islands and everywhere else → the zero-rated international one. Null
// country infers from currency (GBP ⇒ UK), matching the live fallback when
// Stripe didn't surface an address. See _shared/ukVatArea.ts.
function shippingItemFor(country: string | null, currency: string): { domestic: boolean; shippingItem: string } {
  const domestic = country ? isUkVatAreaCountry(country) : currency === 'GBP'
  const shippingItem = domestic
    ? (Deno.env.get('XERO_SHIPPING_DOMESTIC_ITEM_CODE') ?? '052')
    : (Deno.env.get('XERO_SHIPPING_INTL_ITEM_CODE') ?? '050')
  return { domestic, shippingItem }
}

// US tariff & customs handling — its own line. The item code is admin-editable
// in settings (Rob's choice), unlike the env-based tooling/shipping codes;
// read only when there's a tariff to book, and fall back to the known live
// item '910' if the column is unset. Xero derives the (export, no-VAT) tax
// rate from that item.
async function usTariffLine(admin: SupabaseClient, usTariff: number): Promise<InvoiceLine | null> {
  if (usTariff <= 0) return null
  const { data: tariffSettings } = await admin
    .from('settings')
    .select('xero_us_tariff_item_code')
    .eq('id', 1)
    .maybeSingle()
  const usTariffItem = (tariffSettings?.xero_us_tariff_item_code as string | null)?.trim() || '910'
  return { description: 'US tariff & customs handling', amount: usTariff, itemCode: usTariffItem }
}

// Safety net shared by the single-order and group builders: the itemised lines
// MUST sum to the amount Stripe charged, or the Stripe→Xero bank-feed match
// breaks. If the breakdown is missing (legacy order) or drifts by more than a
// penny, fall back to the single summary line on the Sales account.
function enforceSum(lines: InvoiceLine[], expectedTotal: number, reference: string): boolean {
  const sum = round2(lines.reduce((acc, l) => acc + l.amount, 0))
  if (lines.length === 0 || Math.abs(sum - expectedTotal) > 0.01) {
    if (lines.length > 0) {
      console.warn(`[invoiceBuild] line sum ${sum} != charged ${expectedTotal} for ${reference}; falling back to single line`)
    }
    lines.length = 0
    lines.push({ description: `Order ${reference}`, amount: expectedTotal, itemCode: null })
    return false
  }
  return true
}

export async function buildOrderInvoiceLines(
  admin: SupabaseClient,
  order: OrderForInvoice,
  ctx: InvoiceBuildContext,
): Promise<InvoiceBuildResult> {
  const { reference, currency, expectedTotal } = ctx

  const goods = await buildOrderGoodsLines(admin, order, reference)
  const lines = goods.lines
  let productItemCode = goods.productItemCode

  const { domestic, shippingItem } = shippingItemFor(ctx.country, currency)
  const shipping = Number(order.amount_shipping ?? 0)
  if (shipping > 0) {
    lines.push({
      description: domestic ? 'Domestic shipping' : 'International shipping',
      amount: shipping,
      itemCode: shippingItem,
    })
  }
  const tariff = await usTariffLine(admin, Number(order.amount_us_tariff ?? 0))
  if (tariff) lines.push(tariff)

  if (!enforceSum(lines, expectedTotal, reference)) productItemCode = null

  return { lines, productItemCode, domestic }
}

// The group fields the group invoice needs (bundle orders Slice 2 — the money
// shell over N member orders). Shipping + tariff are billed ONCE at group
// level; each member contributes only its goods lines.
export interface GroupForInvoice {
  amount_shipping: number | null
  amount_us_tariff: number | null
}

// One itemised invoice for a whole order group: a product (+ tooling
// + discount) line per member card, then ONE combined shipping line and ONE
// US-tariff line from the group row (spec §6). Same expectedTotal safety net —
// a drifting breakdown collapses to a single summary line so the 1:1
// payment_reference ↔ invoice bank-feed match can never break.
export async function buildGroupInvoiceLines(
  admin: SupabaseClient,
  members: OrderForInvoice[],
  group: GroupForInvoice,
  ctx: InvoiceBuildContext,
): Promise<{ lines: InvoiceLine[]; domestic: boolean }> {
  const { reference, currency, expectedTotal } = ctx

  const lines: InvoiceLine[] = []
  for (const member of members) {
    const goods = await buildOrderGoodsLines(admin, member, reference)
    lines.push(...goods.lines)
  }

  const { domestic, shippingItem } = shippingItemFor(ctx.country, currency)
  const shipping = Number(group.amount_shipping ?? 0)
  if (shipping > 0) {
    lines.push({
      description: domestic ? 'Domestic shipping' : 'International shipping',
      amount: shipping,
      itemCode: shippingItem,
    })
  }
  const tariff = await usTariffLine(admin, Number(group.amount_us_tariff ?? 0))
  if (tariff) lines.push(tariff)

  enforceSum(lines, expectedTotal, reference)

  return { lines, domestic }
}
