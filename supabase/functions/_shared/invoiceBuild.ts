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

export async function buildOrderInvoiceLines(
  admin: SupabaseClient,
  order: OrderForInvoice,
  ctx: InvoiceBuildContext,
): Promise<InvoiceBuildResult> {
  const { reference, currency, expectedTotal } = ctx

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

  // Shipping item depends on the delivery country: UK → domestic code, else
  // international. Null country infers from currency (GBP ⇒ UK), matching the
  // live fallback when Stripe didn't surface an address.
  const country = ctx.country
  const domestic = country ? country === 'GB' : currency === 'GBP'
  const toolingItem = Deno.env.get('XERO_TOOLING_ITEM_CODE') ?? '020'
  const shippingItem = domestic
    ? (Deno.env.get('XERO_SHIPPING_DOMESTIC_ITEM_CODE') ?? '052')
    : (Deno.env.get('XERO_SHIPPING_INTL_ITEM_CODE') ?? '050')

  const lines: InvoiceLine[] = []
  const cards = Number(order.amount_cards ?? 0)
  const tooling = Number(order.amount_tooling ?? 0)
  const personalisation = Number(order.amount_personalisation ?? 0)
  const shipping = Number(order.amount_shipping ?? 0)
  const usTariff = Number(order.amount_us_tariff ?? 0)
  // The code that lands on the product line, before any summary-fallback below.
  let productItemCode: string | null = null

  if (order.custom_quote_total != null) {
    // Custom quote: one product line for the agreed figure.
    lines.push({ description: `Order ${reference}`, amount: Number(order.custom_quote_total), itemCode })
    productItemCode = itemCode
  } else if (order.amount_cards != null) {
    // Grid order: product line (cards + personalisation folded in),
    // then tooling, then shipping. The card count goes in the Qty column
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
  if (shipping > 0) {
    lines.push({
      description: domestic ? 'Domestic shipping' : 'International shipping',
      amount: shipping,
      itemCode: shippingItem,
    })
  }
  // US tariff & customs handling — its own line. The item code is admin-editable
  // in settings (Rob's choice), unlike the env-based tooling/shipping codes;
  // read only when there's a tariff to book, and fall back to the known live
  // item '910' if the column is unset. Xero derives the (export, no-VAT) tax
  // rate from that item.
  if (usTariff > 0) {
    const { data: tariffSettings } = await admin
      .from('settings')
      .select('xero_us_tariff_item_code')
      .eq('id', 1)
      .maybeSingle()
    const usTariffItem = (tariffSettings?.xero_us_tariff_item_code as string | null)?.trim() || '910'
    lines.push({ description: 'US tariff & customs handling', amount: usTariff, itemCode: usTariffItem })
  }

  // Safety net: the itemised lines MUST sum to the amount Stripe charged, or
  // the Stripe→Xero bank-feed match breaks. If the breakdown is missing
  // (legacy order) or drifts by more than a penny, fall back to the single
  // summary line on the Sales account.
  const sum = round2(lines.reduce((acc, l) => acc + l.amount, 0))
  if (lines.length === 0 || Math.abs(sum - expectedTotal) > 0.01) {
    if (lines.length > 0) {
      console.warn(`[invoiceBuild] line sum ${sum} != charged ${expectedTotal} for ${reference}; falling back to single line`)
    }
    lines.length = 0
    lines.push({ description: `Order ${reference}`, amount: expectedTotal, itemCode: null })
    productItemCode = null
  }

  return { lines, productItemCode, domestic }
}
