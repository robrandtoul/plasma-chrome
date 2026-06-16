// stripe-webhook — receives Stripe events, verifies the signature, and
// marks the matching order paid. Step 5a of the Ordering & checkout build
// (docs/ordering-checkout-spec.md). The Xero invoice write is Step 5b.
//
// Per Architecture rule #2, the app does NOT record the payment into the
// books — the existing near-real-time Stripe→Xero bank feed settles it.
// This function's job is just: verify the event is genuinely from Stripe,
// then flip our order's status to 'paid' (idempotently).
//
// Auth: none / verify_jwt = false — Stripe calls this server-to-server
// and authenticates via the Stripe-Signature header, which we verify
// against STRIPE_WEBHOOK_SECRET below. Do not add a Supabase JWT gate.

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { getAccessContext, createSalesInvoice } from '../_shared/xero.ts'
import { buildOrderInvoiceLines } from '../_shared/invoiceBuild.ts'

const encoder = new TextEncoder()

// Pull the delivery name / email / structured address from a Stripe Checkout
// session. Prefers the collected shipping address (what we asked for to ship
// the cards), falling back to the billing address. Used to persist the
// delivery details onto the order for the team's fulfilment surface (Step 6).
// Mirrors the address-source precedence the Xero block below uses.
type StripeAddr = {
  line1?: string | null
  line2?: string | null
  city?: string | null
  state?: string | null
  postal_code?: string | null
  country?: string | null
}
function extractShipping(session: Record<string, unknown>): {
  name: string | null
  email: string | null
  address: {
    line1: string | null
    line2: string | null
    city: string | null
    region: string | null
    postal_code: string | null
    country: string | null
  } | null
} {
  const cust = (session.customer_details ?? {}) as { name?: string; email?: string; address?: StripeAddr }
  const shipDetails =
    (session.shipping_details as { name?: string; address?: StripeAddr } | undefined) ??
    ((session.collected_information as { shipping_details?: { name?: string; address?: StripeAddr } } | undefined)?.shipping_details)
  const a = shipDetails?.address ?? cust.address ?? null
  return {
    name: shipDetails?.name ?? cust.name ?? null,
    email: cust.email ?? null,
    address: a
      ? {
          line1: a.line1 ?? null,
          line2: a.line2 ?? null,
          city: a.city ?? null,
          region: a.state ?? null,
          postal_code: a.postal_code ?? null,
          country: a.country ?? null,
        }
      : null,
  }
}

// Constant-time-ish hex compare (avoids leaking match position via early
// return timing). Both inputs are hex strings.
function hexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// Verify a Stripe webhook signature manually (no SDK): the header is
// `t=<unix>,v1=<hex>[,v1=<hex>…]`; the signed payload is `${t}.${rawBody}`
// HMAC-SHA256'd with the endpoint secret. Tolerance guards against replay.
async function verifyStripeSignature(rawBody: string, sigHeader: string, secret: string): Promise<boolean> {
  const items = sigHeader.split(',').map((s) => s.split('='))
  const t = items.find((i) => i[0] === 't')?.[1]
  const v1s = items.filter((i) => i[0] === 'v1').map((i) => i[1])
  if (!t || v1s.length === 0) return false
  const ts = Number(t)
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sigBuf = await crypto.subtle.sign('HMAC', key, encoder.encode(`${t}.${rawBody}`))
  const computed = Array.from(new Uint8Array(sigBuf), (b) => b.toString(16).padStart(2, '0')).join('')
  return v1s.some((v1) => hexEqual(computed, v1))
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  // Verify against BOTH mode signing secrets (plus the legacy single one),
  // since Stripe signs an event with the secret for whichever mode it came
  // from — and one endpoint serves both test and live. The webhook trusts the
  // signature, not the DB payment_mode, so a test event is still accepted when
  // we're in live mode and vice versa (each books to the connected Xero org).
  const secrets = [
    Deno.env.get('STRIPE_WEBHOOK_SECRET_LIVE'),
    Deno.env.get('STRIPE_WEBHOOK_SECRET_TEST'),
    Deno.env.get('STRIPE_WEBHOOK_SECRET'),
  ].filter((s): s is string => !!s)
  if (secrets.length === 0) return new Response('Webhook not configured', { status: 503 })

  const sig = req.headers.get('Stripe-Signature')
  // Must read the RAW body for signature verification — re-serialising
  // parsed JSON would change bytes and break the HMAC.
  const rawBody = await req.text()
  let verified = false
  if (sig) {
    for (const secret of secrets) {
      if (await verifyStripeSignature(rawBody, sig, secret)) { verified = true; break }
    }
  }
  if (!verified) {
    return new Response('Invalid signature', { status: 400 })
  }

  let event: { type?: string; data?: { object?: Record<string, unknown> } }
  try {
    event = JSON.parse(rawBody)
  } catch {
    return new Response('Invalid JSON', { status: 400 })
  }

  // We only care about a completed, paid checkout for now.
  if (event.type !== 'checkout.session.completed') {
    return new Response('ok', { status: 200 })
  }
  const session = event.data?.object ?? {}
  const orderId = (session.metadata as Record<string, unknown> | undefined)?.order_id as string | undefined
  const paymentStatus = session.payment_status as string | undefined
  if (!orderId || paymentStatus !== 'paid') {
    // Acknowledge so Stripe doesn't retry; nothing for us to do.
    return new Response('ok', { status: 200 })
  }

  const admin = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { db: { schema: 'proofs' }, auth: { persistSession: false, autoRefreshToken: false } },
  )

  // Delivery details for the team's fulfilment surface (Step 6),
  // persisted atomically with the sent → paid flip below.
  const ship = extractShipping(session)

  // Idempotent: only flip from 'sent' → 'paid'. A Stripe retry (or a
  // duplicate event) finds the row already paid and updates nothing.
  const { error } = await admin
    .from('orders')
    .update({
      status: 'paid',
      paid_at: new Date().toISOString(),
      ship_to_name: ship.name,
      ship_to_email: ship.email,
      ship_to_address: ship.address,
      updated_at: new Date().toISOString(),
    })
    .eq('id', orderId)
    .eq('status', 'sent')
  if (error) {
    console.error('[stripe-webhook] order update failed:', error.message)
    // 500 → Stripe retries, which is what we want on a transient DB error.
    return new Response('update failed', { status: 500 })
  }

  // Best-effort: create the Xero invoice (Step 5b). Per Architecture
  // rule #2 we only CREATE it — the Stripe bank feed settles it via the
  // shared Reference. Any failure here is logged and leaves
  // xero_invoice_id null for retry; it never fails the webhook (the
  // order is already paid, and Stripe must get its 200).
  try {
    const ctx = await getAccessContext(admin)
    const amountTotal = session.amount_total as number | undefined
    if (ctx && typeof amountTotal === 'number') {
      const cust = (session.customer_details ?? {}) as { name?: string; email?: string }
      const meta = (session.metadata ?? {}) as { payment_reference?: string }
      const reference = meta.payment_reference ?? orderId
      const currency = String(session.currency ?? 'gbp').toUpperCase()
      const expectedTotal = amountTotal / 100

      // Pull the order's price breakdown (stamped at checkout) so the
      // invoice mirrors Xero's usual line split: product (with its
      // inventory item) + tooling (020) + shipping (050/052).
      const { data: order } = await admin
        .from('orders')
        .select('proof_id, material_variant_id, material_option_id, quantity, names_count, custom_quote_total, amount_cards, amount_tooling, amount_personalisation, amount_shipping')
        .eq('id', orderId)
        .single()

      // Address for the Xero contact (delivery → billing fallback) + the
      // delivery country that drives domestic vs international shipping. Stripe
      // exposes the collected shipping address under shipping_details (older
      // API) or collected_information.shipping_details (newer); fall back to the
      // billing address, then (inside the line builder) to the order currency.
      const shipDetails =
        (session.shipping_details as { address?: StripeAddr } | undefined) ??
        ((session.collected_information as { shipping_details?: { address?: StripeAddr } } | undefined)?.shipping_details)
      const billingAddr = (session.customer_details as { address?: StripeAddr } | undefined)?.address ?? null
      const addr = (shipDetails?.address ?? null) ?? billingAddr
      const country = addr?.country ?? null
      const invoiceAddress = addr
        ? {
            line1: addr.line1 ?? null,
            line2: addr.line2 ?? null,
            city: addr.city ?? null,
            region: addr.state ?? null,
            postalCode: addr.postal_code ?? null,
            country: addr.country ?? null,
          }
        : null

      // Resolve the invoice lines (product item code + tooling + shipping) via
      // the shared builder — the SAME resolution the Xero self-test exercises,
      // so a green self-test means the live path books to the same codes.
      const { lines } = await buildOrderInvoiceLines(
        admin,
        order ?? {
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
        },
        { reference, currency, expectedTotal, country },
      )

      const contactName = cust.name || cust.email || 'Customer'
      const contactEmail = cust.email ?? null
      const created = await createSalesInvoice(ctx.accessToken, ctx.tenantId, {
        contactName,
        contactEmail,
        currency,
        reference,
        lines,
        address: invoiceAddress,
      })
      let invoiceId = created.invoiceId
      // Xero's rejection text, kept so we can stamp it on the order when both
      // attempts fail — that's what the Orders page surfaces as "Invoice
      // failed" and what makes a silent miss visible (000240).
      let lastError = created.error

      // On-error fallback: if the itemised lines were rejected by Xero
      // (e.g. an item code that doesn't exist in this org — the classic
      // case being a Demo org without the live item codes, or codes that
      // lost their leading zero on import), retry once as a single summary
      // line so an invoice is still created. The sum-mismatch fallback
      // above runs *before* the call; this one catches a post-call
      // rejection. Both degrade gracefully rather than leaving no invoice.
      const wasItemised = lines.some((l) => l.itemCode)
      if (!invoiceId && wasItemised) {
        console.warn(`[stripe-webhook] itemised invoice rejected for order ${orderId}; retrying as a single summary line`)
        const retry = await createSalesInvoice(ctx.accessToken, ctx.tenantId, {
          contactName,
          contactEmail,
          currency,
          reference,
          lines: [{ description: `Order ${reference}`, amount: expectedTotal, itemCode: null }],
          address: invoiceAddress,
        })
        invoiceId = retry.invoiceId
        if (retry.error) lastError = retry.error
      }
      if (invoiceId) {
        // Success — store the id and clear any prior error so a row that has
        // since invoiced never keeps a stale "failed" flag.
        await admin.from('orders').update({ xero_invoice_id: invoiceId, xero_invoice_error: null }).eq('id', orderId)
      } else {
        console.error(`[stripe-webhook] xero invoice not created for order ${orderId}:`, lastError)
        await admin.from('orders').update({ xero_invoice_error: lastError ?? 'Xero did not return an invoice' }).eq('id', orderId)
      }
    }
  } catch (e) {
    console.error('[stripe-webhook] xero invoice failed:', (e as Error).message)
    // Stamp the caught error too, so an exception path is just as visible as a
    // Xero rejection. Best-effort: this update must not throw out of the catch.
    await admin.from('orders').update({ xero_invoice_error: (e as Error).message }).eq('id', orderId).then(undefined, () => {})
  }

  return new Response('ok', { status: 200 })
})
