// order-vat-invoice — anon, token-scoped. Returns the shareable Xero
// "online invoice" URL for a paid order's VAT invoice, but ONLY once the
// invoice has reconciled to PAID in Xero (per the product decision: don't
// surface a VAT invoice that still reads "awaiting payment"). Stripe's
// emailed receipt covers the immediate proof-of-payment in the meantime.
//
// The Xero invoice is created by the stripe-webhook (Step 5b) and settled by
// the existing Stripe→Xero bank feed (~daily), so there's a window after
// payment where the invoice exists but isn't yet PAID — we report that as
// "pending" so the customer page can say "available shortly".
//
// Access model: the order id + secret token in the URL are the access token
// (same posture as public_get_order / customer-proof-images). The returned
// OnlineInvoiceUrl is itself a shareable Xero link. No customer/proof data is
// returned beyond the invoice URL.
//
// Auth: none / verify_jwt = false. Uses a service-role client for the order
// lookup and the existing Xero connection for the invoice calls.

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { getAccessContext } from '../_shared/xero.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }
  const orderId = typeof body.order_id === 'string' ? body.order_id : null
  const token = typeof body.token === 'string' ? body.token : null
  if (!orderId || !token) return json({ error: 'Missing order_id or token' }, 400)

  const admin = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { db: { schema: 'proofs' }, auth: { persistSession: false, autoRefreshToken: false } },
  )

  const { data: order, error: orderErr } = await admin
    .from('orders')
    .select('id, token, status, xero_invoice_id, xero_invoice_error')
    .eq('id', orderId)
    .eq('token', token)
    .single()
  if (orderErr || !order) return json({ error: 'Order not found' }, 404)

  // Only meaningful for a paid order that actually has a Xero invoice.
  if (order.status !== 'paid' && order.status !== 'fulfilled') {
    return json({ ready: false, reason: 'not_paid' })
  }
  if (!order.xero_invoice_id) {
    // No invoice id yet — two cases the customer page MUST NOT conflate:
    //   * a genuine creation failure (the webhook stamped xero_invoice_error,
    //     e.g. a foreign-currency reject) → 'invoice_failed', the only state
    //     that should ever hint at contacting us.
    //   * the invoice simply not created yet — the webhook runs a beat after
    //     Stripe's success redirect, so an immediate check races ahead of it →
    //     'invoice_pending', i.e. "available shortly", never a failure.
    if (order.xero_invoice_error) return json({ ready: false, reason: 'invoice_failed' })
    return json({ ready: false, reason: 'invoice_pending' })
  }

  const ctx = await getAccessContext(admin)
  if (!ctx) return json({ ready: false, reason: 'xero_unavailable' })

  try {
    // 1) Check the invoice has reconciled to PAID. Until the bank feed settles
    //    it, we deliberately don't surface the VAT invoice.
    const invRes = await fetch(`https://api.xero.com/api.xro/2.0/Invoices/${order.xero_invoice_id}`, {
      headers: { Authorization: `Bearer ${ctx.accessToken}`, 'Xero-tenant-id': ctx.tenantId, Accept: 'application/json' },
    })
    if (!invRes.ok) return json({ ready: false, reason: 'xero_error' })
    const invData = await invRes.json().catch(() => null)
    const invoice = invData?.Invoices?.[0] ?? null
    const status = (invoice?.Status as string | undefined) ?? null
    const amountDue = typeof invoice?.AmountDue === 'number' ? invoice.AmountDue : null
    const isPaid = status === 'PAID' || (status !== 'VOIDED' && status !== 'DELETED' && amountDue === 0)
    if (!isPaid) return json({ ready: false, reason: 'awaiting_reconciliation' })

    // 2) Fetch the shareable online-invoice URL (the customer-facing VAT invoice).
    const onlineRes = await fetch(`https://api.xero.com/api.xro/2.0/Invoices/${order.xero_invoice_id}/OnlineInvoice`, {
      headers: { Authorization: `Bearer ${ctx.accessToken}`, 'Xero-tenant-id': ctx.tenantId, Accept: 'application/json' },
    })
    if (!onlineRes.ok) return json({ ready: false, reason: 'online_invoice_unavailable' })
    const onlineData = await onlineRes.json().catch(() => null)
    const url = onlineData?.OnlineInvoices?.[0]?.OnlineInvoiceUrl as string | undefined
    if (!url) return json({ ready: false, reason: 'online_invoice_unavailable' })

    return json({ ready: true, url })
  } catch (e) {
    console.error('[order-vat-invoice] failed:', (e as Error).message)
    return json({ ready: false, reason: 'xero_error' })
  }
})
