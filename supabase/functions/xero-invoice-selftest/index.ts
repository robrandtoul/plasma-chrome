// xero-invoice-selftest — admin-only. Verifies that EVERY product type produces
// a Xero invoice carrying the correct item code (and surfaces the tax rate Xero
// resolves from it), without anyone clicking through Stripe checkout dozens of
// times.
//
// How it works: for each active variant, each option that carries its own code
// (the wood species), plus one case each for split-name tooling and UK /
// international shipping, it synthesises an order in memory, runs it through the
// SAME line builder the live stripe-webhook uses (_shared/invoiceBuild.ts), and
// creates a DRAFT invoice in whatever Xero org the app is connected to. Xero
// echoes back the ItemCode, TaxType and AccountCode it resolved per line, so we
// assert the product code matches the database and report the tax rate alongside.
//
// Drafts never touch the ledger and are trivially removed: the 'cleanup' action
// deletes every draft whose Reference starts with "SELFTEST". Run it against the
// Demo org as a sanity check; the meaningful run is after the app is pointed at
// the live Xero org, just before going live.
//
// Auth: admin only (requireAdmin). Invoked from Admin → Xero self-test.

import { requireAdmin, json, CORS_HEADERS } from '../_shared/admin.ts'
import { getAccessContext, buildInvoicePayload } from '../_shared/xero.ts'
import { buildOrderInvoiceLines, resolveZeroRatedTaxType, type OrderForInvoice } from '../_shared/invoiceBuild.ts'

const XERO_API = 'https://api.xero.com/api.xro/2.0/Invoices'
const SELFTEST_PREFIX = 'SELFTEST'
// Xero accepts large invoice arrays but throttles on request rate; chunking
// keeps each POST comfortably sized and lets one bad chunk fail in isolation.
const CHUNK_SIZE = 40

// A blank order with every field null; specs override just what they exercise.
const EMPTY_ORDER: OrderForInvoice = {
  proof_id: null,
  material_variant_id: null,
  material_option_id: null,
  quantity: null,
  names_count: null,
  custom_quote_total: null,
  amount_cards: null,
  amount_tooling: null,
  amount_personalisation: null,
  amount_shipping: null,
  amount_us_tariff: null,
}

// Which line in the built invoice a spec is asserting, and the code it should
// carry. 'product' = the first line; 'tooling' / 'shipping' are matched by
// their description keyword (they're never the first line).
interface Spec {
  label: string
  group: string
  target: 'product' | 'tooling' | 'shipping' | 'tariff'
  expectedCode: string | null
  order: OrderForInvoice
  currency: string
  expectedTotal: number
  country: string | null
}

interface ResultRow {
  test: string
  group: string
  expectedCode: string | null
  resolvedCode: string | null
  taxType: string | null
  accountCode: string | null
  status: 'pass' | 'fail' | 'error'
  message: string
  invoiceId: string | null
}

type XeroLine = { Description?: string; ItemCode?: string; TaxType?: string; AccountCode?: string }
type XeroInvoice = {
  InvoiceID?: string
  Reference?: string
  Type?: string
  Status?: string
  LineItems?: XeroLine[]
  ValidationErrors?: Array<{ Message?: string }>
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const gate = await requireAdmin(req)
  if (gate instanceof Response) return gate
  const { admin } = gate

  let body: { action?: string } = {}
  try {
    body = await req.json()
  } catch {
    /* default action */
  }
  const action = body.action === 'cleanup' ? 'cleanup' : 'run'

  const ctx = await getAccessContext(admin)
  if (!ctx) return json({ error: 'Xero is not connected. Connect Xero under Admin → Settings first.' }, 400)

  const headers = {
    Authorization: `Bearer ${ctx.accessToken}`,
    'Xero-tenant-id': ctx.tenantId,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  }

  // ── Cleanup: delete every DRAFT invoice we created (Reference startsWith
  // SELFTEST). Loops Xero's pages and only ever touches drafts. ──────────────
  if (action === 'cleanup') {
    const toDelete: string[] = []
    for (let page = 1; page <= 20; page++) {
      const res = await fetch(`${XERO_API}?Statuses=DRAFT&page=${page}`, { headers })
      if (!res.ok) return json({ error: `Xero read failed: ${res.status} ${await res.text().catch(() => '')}` }, 502)
      const data = await res.json().catch(() => null)
      const invoices = (data?.Invoices ?? []) as XeroInvoice[]
      if (invoices.length === 0) break
      for (const inv of invoices) {
        if (inv.Type === 'ACCREC' && inv.InvoiceID && (inv.Reference ?? '').startsWith(SELFTEST_PREFIX)) {
          toDelete.push(inv.InvoiceID)
        }
      }
      if (invoices.length < 100) break
    }
    let deleted = 0
    for (const ids of chunk(toDelete, CHUNK_SIZE)) {
      const res = await fetch(XERO_API, {
        method: 'POST',
        headers,
        body: JSON.stringify({ Invoices: ids.map((InvoiceID) => ({ InvoiceID, Status: 'DELETED' })) }),
      })
      if (res.ok) deleted += ids.length
      else console.error('[xero-invoice-selftest] delete chunk failed:', res.status, await res.text().catch(() => ''))
    }
    return json({ action: 'cleanup', deleted, found: toDelete.length })
  }

  // ── Run: assemble one synthetic order per product type. ────────────────────
  const toolingCode = Deno.env.get('XERO_TOOLING_ITEM_CODE') ?? '020'
  const shippingDomCode = Deno.env.get('XERO_SHIPPING_DOMESTIC_ITEM_CODE') ?? '052'
  const shippingIntlCode = Deno.env.get('XERO_SHIPPING_INTL_ITEM_CODE') ?? '050'
  // US tariff item code lives in settings (admin-editable), not env — read the
  // same value invoiceBuild will use so the assertion matches the live path.
  const { data: tariffSettingRow } = await admin
    .from('settings').select('xero_us_tariff_item_code').eq('id', 1).maybeSingle()
  const usTariffCode = (tariffSettingRow?.xero_us_tariff_item_code as string | null)?.trim() || '910'

  // Active variants on active/published/non-archived materials.
  const { data: vData, error: vErr } = await admin
    .from('material_variants')
    .select('id, display_name, variant_type, xero_item_code, material_id, materials!inner(display_name, code, is_active, is_published, archived_at)')
    .eq('is_active', true)
  if (vErr) return json({ error: `Could not load variants: ${vErr.message}` }, 500)
  type VRow = {
    id: string
    display_name: string
    variant_type: string
    xero_item_code: string | null
    material_id: string
    materials: { display_name: string; code: string; is_active: boolean; is_published: boolean; archived_at: string | null } | null
  }
  const variants = ((vData ?? []) as unknown as VRow[]).filter(
    (v) => v.materials && v.materials.is_active && v.materials.is_published && !v.materials.archived_at,
  )
  if (variants.length === 0) return json({ error: 'No active variants found to test.' }, 500)

  // Options that carry their own code (wood species). These override the
  // variant's code on the product line, so each needs its own assertion.
  const { data: oData, error: oErr } = await admin
    .from('material_options')
    .select('id, display_name, code, xero_item_code, material_id, materials!inner(display_name)')
    .not('xero_item_code', 'is', null)
  if (oErr) return json({ error: `Could not load options: ${oErr.message}` }, 500)
  type ORow = { id: string; display_name: string; xero_item_code: string | null; material_id: string; materials: { display_name: string } | null }
  const options = (oData ?? []) as unknown as ORow[]

  const anchor = variants[0] // any real variant, used for the tooling/shipping cases

  const specs: Spec[] = []

  // One product-line case per active variant.
  for (const v of variants) {
    specs.push({
      label: `${v.materials!.display_name} — ${v.variant_type === 'default' ? v.materials!.code : v.display_name}`,
      group: 'Products',
      target: 'product',
      expectedCode: v.xero_item_code,
      order: { ...EMPTY_ORDER, material_variant_id: v.id, quantity: 100, names_count: 1, amount_cards: 100 },
      currency: 'GBP',
      expectedTotal: 100,
      country: 'GB',
    })
  }

  // One product-line case per coded option (wood species), pinned to a variant
  // of the same material so the override path fires.
  for (const o of options) {
    const matVariant = variants.find((v) => v.material_id === o.material_id)
    if (!matVariant) continue
    specs.push({
      label: `${o.materials!.display_name} — ${o.display_name}`,
      group: 'Options',
      target: 'product',
      expectedCode: o.xero_item_code,
      order: { ...EMPTY_ORDER, material_variant_id: matVariant.id, material_option_id: o.id, quantity: 100, names_count: 1, amount_cards: 100 },
      currency: 'GBP',
      expectedTotal: 100,
      country: 'GB',
    })
  }

  // Split-name tooling, UK shipping, international shipping — one case each.
  specs.push({
    label: 'Split-name tooling',
    group: 'Add-ons',
    target: 'tooling',
    expectedCode: toolingCode,
    order: { ...EMPTY_ORDER, material_variant_id: anchor.id, quantity: 100, names_count: 2, amount_cards: 100, amount_tooling: 39 },
    currency: 'GBP',
    expectedTotal: 139,
    country: 'GB',
  })
  specs.push({
    label: 'Domestic shipping (UK)',
    group: 'Add-ons',
    target: 'shipping',
    expectedCode: shippingDomCode,
    order: { ...EMPTY_ORDER, material_variant_id: anchor.id, quantity: 100, names_count: 1, amount_cards: 100, amount_shipping: 12.9 },
    currency: 'GBP',
    expectedTotal: 112.9,
    country: 'GB',
  })
  specs.push({
    label: 'International shipping',
    group: 'Add-ons',
    target: 'shipping',
    expectedCode: shippingIntlCode,
    order: { ...EMPTY_ORDER, material_variant_id: anchor.id, quantity: 100, names_count: 1, amount_cards: 100, amount_shipping: 30 },
    currency: 'GBP',
    expectedTotal: 130,
    country: 'US',
  })
  specs.push({
    label: 'US tariff & customs handling',
    group: 'Add-ons',
    target: 'tariff',
    expectedCode: usTariffCode,
    order: { ...EMPTY_ORDER, material_variant_id: anchor.id, quantity: 100, names_count: 1, amount_cards: 100, amount_us_tariff: 39 },
    currency: 'USD',
    expectedTotal: 139,
    country: 'US',
  })

  // VAT treatment: one EU and one rest-of-world case. A VAT-free invoice
  // books its lines to the org's "0% EU" / "0% ROW" rates once those are
  // configured in Admin → Settings (000306) — until then both book as
  // "No VAT". The assertion stays on the item code; the interesting column
  // is the tax rate Xero echoes back per line.
  specs.push({
    label: 'EU order (EUR → Germany)',
    group: 'VAT treatment',
    target: 'product',
    expectedCode: anchor.xero_item_code,
    order: { ...EMPTY_ORDER, material_variant_id: anchor.id, quantity: 100, names_count: 1, amount_cards: 100 },
    currency: 'EUR',
    expectedTotal: 100,
    country: 'DE',
  })
  specs.push({
    label: 'Rest-of-world order (USD → United States)',
    group: 'VAT treatment',
    target: 'product',
    expectedCode: anchor.xero_item_code,
    order: { ...EMPTY_ORDER, material_variant_id: anchor.id, quantity: 100, names_count: 1, amount_cards: 100 },
    currency: 'USD',
    expectedTotal: 100,
    country: 'US',
  })

  // Build each invoice payload through the shared line builder + payload builder.
  const payloads: Record<string, unknown>[] = []
  for (const spec of specs) {
    const reference = `${SELFTEST_PREFIX} ${spec.label}`.slice(0, 255)
    const built = await buildOrderInvoiceLines(admin, spec.order, {
      reference,
      currency: spec.currency,
      expectedTotal: spec.expectedTotal,
      country: spec.country,
    })
    // Same zero-rated EU/ROW resolution the live webhook runs, so a
    // VAT-free draft books to the same tax rate a real order would.
    const zeroRatedTaxType = await resolveZeroRatedTaxType(admin, spec.country, spec.currency)
    payloads.push(
      buildInvoicePayload(
        { contactName: 'Plasma self-test', contactEmail: null, currency: spec.currency, reference, lines: built.lines, zeroRatedTaxType },
        { status: 'DRAFT' },
      ),
    )
  }

  // POST in chunks; Xero (summarizeErrors=false) returns each invoice with its
  // own ValidationErrors instead of failing the whole batch, and preserves order.
  const returned: XeroInvoice[] = []
  for (const part of chunk(payloads, CHUNK_SIZE)) {
    const res = await fetch(`${XERO_API}?summarizeErrors=false`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ Invoices: part }),
    })
    const data = await res.json().catch(() => null)
    if (!res.ok && !data?.Invoices) {
      return json({ error: `Xero rejected the batch: ${res.status} ${JSON.stringify(data ?? {}).slice(0, 500)}` }, 502)
    }
    returned.push(...((data?.Invoices ?? []) as XeroInvoice[]))
  }

  // Match each returned invoice back to its spec by index and assert.
  const results: ResultRow[] = specs.map((spec, i) => {
    const inv = returned[i]
    if (!inv) {
      return { test: spec.label, group: spec.group, expectedCode: spec.expectedCode, resolvedCode: null, taxType: null, accountCode: null, status: 'error', message: 'No invoice returned by Xero', invoiceId: null }
    }
    const errs = inv.ValidationErrors ?? []
    if (errs.length > 0) {
      return { test: spec.label, group: spec.group, expectedCode: spec.expectedCode, resolvedCode: null, taxType: null, accountCode: null, status: 'error', message: errs.map((e) => e.Message).filter(Boolean).join('; ').slice(0, 300) || 'Xero validation error', invoiceId: inv.InvoiceID ?? null }
    }
    const lineItems = inv.LineItems ?? []
    const line =
      spec.target === 'product'
        ? lineItems[0]
        : lineItems.find((l) => (l.Description ?? '').toLowerCase().includes(spec.target))
    const resolvedCode = line?.ItemCode ?? null
    const expected = spec.expectedCode ?? null
    const ok = (resolvedCode ?? null) === expected
    return {
      test: spec.label,
      group: spec.group,
      expectedCode: expected,
      resolvedCode,
      taxType: line?.TaxType ?? null,
      accountCode: line?.AccountCode ?? null,
      status: ok ? 'pass' : 'fail',
      message: ok
        ? 'Booked to the expected item code'
        : `Expected ${expected ?? '(no code)'}, Xero used ${resolvedCode ?? '(no code)'}`,
      invoiceId: inv.InvoiceID ?? null,
    }
  })

  const summary = {
    total: results.length,
    pass: results.filter((r) => r.status === 'pass').length,
    fail: results.filter((r) => r.status === 'fail').length,
    error: results.filter((r) => r.status === 'error').length,
  }

  return json({ action: 'run', tenantId: ctx.tenantId, summary, results })
})
