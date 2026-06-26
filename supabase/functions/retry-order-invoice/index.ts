// retry-order-invoice — re-attempt the Xero invoice for a paid order whose
// invoice never got created (the webhook's Xero step is best-effort, so a
// rejection leaves xero_invoice_id null + xero_invoice_error set, 000240).
//
// Triggered by a designer from the Orders page "Retry invoice" button. Runs
// the EXACT same line-building + create path as the live webhook (shared
// _shared/invoiceBuild.ts + _shared/xero.ts), so a retry produces precisely
// the invoice the webhook would have. The order is already paid with its
// price breakdown stamped, so no payment is involved — this only writes the
// missing invoice into Xero.
//
// Auth: designer or admin (requireDesigner) — the same audience that can see
// the Orders page. verify_jwt is on at the platform level too.

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { requireDesigner, json, CORS_HEADERS } from '../_shared/admin.ts'
import { getAccessContext, createSalesInvoice } from '../_shared/xero.ts'
import { buildOrderInvoiceLines } from '../_shared/invoiceBuild.ts'
import { logAudit } from '../_shared/audit.ts'

const round2 = (n: number) => Math.round(n * 100) / 100

interface OrderRow {
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
  amount_card_discount: number | null
  currency: string
  status: string
  payment_method: string | null
  xero_invoice_id: string | null
  xero_contact_id: string | null
  payment_reference: string | null
  ship_to_name: string | null
  ship_to_email: string | null
  ship_to_address: {
    line1?: string | null
    line2?: string | null
    city?: string | null
    region?: string | null
    postal_code?: string | null
    country?: string | null
  } | null
  ship_dest_country: string | null
  proofs: { contacts: { full_name: string | null; email: string | null } | null } | null
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const ctxOrResp = await requireDesigner(req)
  if (ctxOrResp instanceof Response) return ctxOrResp

  let body: { order_id?: string }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }
  const orderId = typeof body.order_id === 'string' ? body.order_id : null
  if (!orderId) return json({ error: 'Missing order_id' }, 400)

  // Service-role client (bypasses RLS) for the reads/writes the webhook also
  // does. The proofs schema is pinned, matching every other order path.
  const admin = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { db: { schema: 'proofs' }, auth: { persistSession: false, autoRefreshToken: false } },
  )

  const { data: order, error: orderErr } = await admin
    .from('orders')
    .select('proof_id, material_variant_id, material_option_id, quantity, names_count, custom_quote_total, amount_cards, amount_tooling, amount_personalisation, amount_shipping, amount_card_discount, currency, status, payment_method, xero_invoice_id, xero_contact_id, payment_reference, ship_to_name, ship_to_email, ship_to_address, ship_dest_country, proofs(contacts(full_name, email))')
    .eq('id', orderId)
    .single<OrderRow>()
  if (orderErr || !order) return json({ error: 'Order not found' }, 404)

  // Only sensible for a paid (or already-fulfilled) order that has no invoice
  // yet — a retry must never duplicate an existing one.
  if (order.status !== 'paid' && order.status !== 'fulfilled') {
    return json({ error: 'Only a paid order can be invoiced.' }, 409)
  }
  if (order.xero_invoice_id) {
    return json({ error: 'This order already has a Xero invoice.', invoiceId: order.xero_invoice_id }, 409)
  }
  // Offline (bank-transfer) orders are invoiced manually in Xero and never carry
  // an auto-invoice, so a "retry" here would DUPLICATE the manual invoice. Reject.
  if (order.payment_method === 'offline') {
    return json({ error: 'This is an offline (bank-transfer) order — its invoice is raised manually in Xero, so there is nothing to retry.' }, 409)
  }

  const ctx = await getAccessContext(admin)
  if (!ctx) {
    const msg = 'Xero is not connected — reconnect Xero in Settings, then retry.'
    await admin.from('orders').update({ xero_invoice_error: msg }).eq('id', orderId)
    return json({ ok: false, error: msg }, 200)
  }

  const currency = String(order.currency ?? 'GBP').toUpperCase()
  const reference = order.payment_reference ?? orderId

  // The charged total the itemised lines must sum to (within a penny) or they
  // collapse to a single summary line. Rebuilt from the stamped breakdown:
  // custom quote → agreed figure + shipping; grid → cards (incl. folded-in
  // personalisation and finish) + tooling + personalisation + shipping.
  const cards = Number(order.amount_cards ?? 0)
  const tooling = Number(order.amount_tooling ?? 0)
  const personalisation = Number(order.amount_personalisation ?? 0)
  const shipping = Number(order.amount_shipping ?? 0)
  const cardDiscount = Number(order.amount_card_discount ?? 0)
  const expectedTotal = order.custom_quote_total != null
    ? round2(Number(order.custom_quote_total) - cardDiscount + shipping)
    : round2(cards + tooling + personalisation - cardDiscount + shipping)

  // Delivery country drives domestic vs international shipping item; prefer the
  // address Stripe collected, fall back to the rating country we stored.
  const country = order.ship_to_address?.country ?? order.ship_dest_country ?? null

  const { lines } = await buildOrderInvoiceLines(admin, order, { reference, currency, expectedTotal, country })

  // Contact: the delivery name/email Stripe collected, falling back to the
  // proof's contact so the invoice is never "Customer" with no email.
  const contact = order.proofs?.contacts ?? null
  const contactName = (order.ship_to_name?.trim() || contact?.full_name?.trim() || contact?.email?.trim() || 'Customer')
  const contactEmail = order.ship_to_email?.trim() || contact?.email?.trim() || null

  const addr = order.ship_to_address
  const invoiceAddress = addr
    ? {
        line1: addr.line1 ?? null,
        line2: addr.line2 ?? null,
        city: addr.city ?? null,
        region: addr.region ?? null,
        postalCode: addr.postal_code ?? null,
        country: addr.country ?? null,
      }
    : null

  // Bind to the designer-chosen Xero contact (000275) so the retried invoice
  // files under the customer's record, exactly as the webhook would have.
  const boundContactId = order.xero_contact_id ?? null

  const created = await createSalesInvoice(ctx.accessToken, ctx.tenantId, {
    contactName,
    contactEmail,
    currency,
    reference,
    lines,
    address: invoiceAddress,
    contactId: boundContactId,
  })
  let invoiceId = created.invoiceId
  let createdInvoice = created.invoice
  let lastError = created.error

  // Same single-summary-line fallback the webhook uses for a code Xero won't
  // accept, so a retry degrades the same way rather than failing outright.
  const wasItemised = lines.some((l) => l.itemCode)
  if (!invoiceId && wasItemised) {
    const retry = await createSalesInvoice(ctx.accessToken, ctx.tenantId, {
      contactName,
      contactEmail,
      currency,
      reference,
      lines: [{ description: `Order ${reference}`, amount: expectedTotal, itemCode: null }],
      address: invoiceAddress,
      contactId: boundContactId,
    })
    invoiceId = retry.invoiceId
    if (retry.invoice) createdInvoice = retry.invoice
    if (retry.error) lastError = retry.error
  }

  if (invoiceId) {
    await admin.from('orders').update({ xero_invoice_id: invoiceId, xero_invoice_error: null }).eq('id', orderId)

    // Auto-remember (000275): an unbound retry still creates a Xero contact, so
    // capture its ContactID for the customer's next order, mirroring the webhook.
    if (!boundContactId) {
      const c = (createdInvoice?.Contact as { ContactID?: string; Name?: string } | undefined) ?? null
      if (c?.ContactID) {
        await admin
          .from('orders')
          .update({ xero_contact_id: c.ContactID, ...(c.Name ? { xero_contact_name: c.Name } : {}) })
          .eq('id', orderId)
      }
    }
    // A manual retry mints a real Xero invoice — record who triggered it.
    await logAudit(admin, {
      actorId: ctxOrResp.callerId,
      actorEmail: ctxOrResp.callerEmail,
      actorLabel: ctxOrResp.callerLabel,
      action: 'order.invoice_retried',
      targetType: 'order',
      targetId: orderId,
      targetLabel: `Order ${reference}`,
      afterValue: { orderId, invoiceId, currency },
    })
    return json({ ok: true, invoiceId })
  }

  const msg = lastError ?? 'Xero did not return an invoice'
  await admin.from('orders').update({ xero_invoice_error: msg }).eq('id', orderId)
  await logAudit(admin, {
    actorId: ctxOrResp.callerId,
    actorEmail: ctxOrResp.callerEmail,
    actorLabel: ctxOrResp.callerLabel,
    action: 'order.invoice_retry_failed',
    targetType: 'order',
    targetId: orderId,
    targetLabel: `Order ${reference}`,
    afterValue: { orderId, error: msg },
  })
  return json({ ok: false, error: msg }, 200)
})
