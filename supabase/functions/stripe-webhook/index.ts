// stripe-webhook — receives Stripe events, verifies the signature, and
// marks the matching order paid. Step 5a of the Ordering & checkout build
// (docs/ordering-checkout-spec.md). The Xero invoice write is Step 5b.
//
// Per Architecture rule #2, the app does NOT record the payment into the
// books — the existing near-real-time Stripe→Xero bank feed settles it.
// On a verified event this function: flips the order to 'paid' (idempotently),
// creates the Xero invoice (once — gated on xero_invoice_id) and, if a clearing
// account is set, marks it paid; emails that invoice to the customer as their
// VAT receipt (once — gated on invoice_emailed_at); and posts a branded
// order-paid confirmation to the customer on the proof's Help Scout thread
// (once — gated on confirmation_sent_at). Steps after the flip are best-effort.
//
// Auth: none / verify_jwt = false — Stripe calls this server-to-server
// and authenticates via the Stripe-Signature header, which we verify
// against STRIPE_WEBHOOK_SECRET below. Do not add a Supabase JWT gate.

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { getAccessContext, createSalesInvoice, recordInvoicePayment, emailSalesInvoice } from '../_shared/xero.ts'
import { buildOrderInvoiceLines } from '../_shared/invoiceBuild.ts'
import { getAccessToken, fetchConversation, postStaffReply, hideThread, HsError } from '../_shared/helpscout.ts'
import { renderTemplate, ORDER_CONFIRMATION_DEFAULT_BODY } from '../_shared/replyTemplates.ts'

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

  // Two event types fulfil an order, normalised into one shape below:
  //   * payment_intent.succeeded   — the current Stripe Elements pay-page.
  //   * checkout.session.completed — the older hosted/embedded Checkout, kept
  //     so any in-flight session still fulfils.
  // We capture: order id, delivery name/email/address (StripeAddr shape:
  // state + postal_code), the charged total (major units), currency, and the
  // shared payment reference.
  let orderId: string | undefined
  let reference: string | undefined
  let currencyUpper = 'GBP'
  let amountMajor: number | undefined
  let shipName: string | null = null
  let shipEmail: string | null = null
  let shipAddr: StripeAddr | null = null

  if (event.type === 'checkout.session.completed') {
    const session = event.data?.object ?? {}
    orderId = (session.metadata as Record<string, unknown> | undefined)?.order_id as string | undefined
    const paymentStatus = session.payment_status as string | undefined
    if (!orderId || paymentStatus !== 'paid') return new Response('ok', { status: 200 })
    const ship = extractShipping(session)
    shipName = ship.name
    shipEmail = ship.email
    shipAddr = ship.address
      ? {
          line1: ship.address.line1,
          line2: ship.address.line2,
          city: ship.address.city,
          state: ship.address.region,
          postal_code: ship.address.postal_code,
          country: ship.address.country,
        }
      : null
    reference = (session.metadata as { payment_reference?: string } | undefined)?.payment_reference ?? orderId
    currencyUpper = String(session.currency ?? 'gbp').toUpperCase()
    const amt = session.amount_total as number | undefined
    amountMajor = typeof amt === 'number' ? amt / 100 : undefined
  } else if (event.type === 'payment_intent.succeeded') {
    const pi = event.data?.object ?? {}
    orderId = (pi.metadata as Record<string, unknown> | undefined)?.order_id as string | undefined
    if (!orderId) return new Response('ok', { status: 200 })
    const shipping = pi.shipping as { name?: string; address?: StripeAddr } | undefined
    shipName = shipping?.name ?? null
    shipEmail = (pi.receipt_email as string | undefined) ?? null
    shipAddr = shipping?.address ?? null
    reference = (pi.metadata as { payment_reference?: string } | undefined)?.payment_reference ?? orderId
    currencyUpper = String(pi.currency ?? 'gbp').toUpperCase()
    const amt = pi.amount as number | undefined
    amountMajor = typeof amt === 'number' ? amt / 100 : undefined
  } else {
    // Not an event we fulfil on — acknowledge so Stripe doesn't retry.
    return new Response('ok', { status: 200 })
  }

  const admin = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { db: { schema: 'proofs' }, auth: { persistSession: false, autoRefreshToken: false } },
  )

  // Delivery details for the team's fulfilment surface (Step 6), stored in our
  // jsonb shape (region + postal_code), persisted with the sent → paid flip.
  const storedAddress = shipAddr
    ? {
        line1: shipAddr.line1 ?? null,
        line2: shipAddr.line2 ?? null,
        city: shipAddr.city ?? null,
        region: shipAddr.state ?? null,
        postal_code: shipAddr.postal_code ?? null,
        country: shipAddr.country ?? null,
      }
    : null

  // Idempotent: only flip from 'sent' → 'paid'. A Stripe retry (or a
  // duplicate event) finds the row already paid and updates nothing.
  const { error } = await admin
    .from('orders')
    .update({
      status: 'paid',
      paid_at: new Date().toISOString(),
      ship_to_name: shipName,
      ship_to_email: shipEmail,
      ship_to_address: storedAddress,
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
    if (ctx && typeof amountMajor === 'number') {
      const referenceSafe = reference ?? orderId
      const currency = currencyUpper
      const expectedTotal = amountMajor

      // Pull the order's price breakdown (stamped at checkout) + the two
      // idempotency guards: xero_invoice_id (so a duplicate Stripe event mints
      // no second invoice / clearing-account payment) and invoice_emailed_at
      // (so the VAT invoice is emailed exactly once).
      const { data: order } = await admin
        .from('orders')
        .select('proof_id, material_variant_id, material_option_id, quantity, names_count, custom_quote_total, amount_cards, amount_tooling, amount_personalisation, amount_shipping, xero_invoice_id, invoice_emailed_at')
        .eq('id', orderId)
        .single()
      let invoiceId: string | null = (order?.xero_invoice_id as string | null) ?? null

      // Address for the Xero contact + the delivery country that drives
      // domestic vs international shipping. Normalised from whichever event
      // fulfilled this order (Elements Address element, or Checkout's address).
      const country = shipAddr?.country ?? null
      const invoiceAddress = shipAddr
        ? {
            line1: shipAddr.line1 ?? null,
            line2: shipAddr.line2 ?? null,
            city: shipAddr.city ?? null,
            region: shipAddr.state ?? null,
            postalCode: shipAddr.postal_code ?? null,
            country: shipAddr.country ?? null,
          }
        : null

      const contactName = shipName || shipEmail || 'Customer'
      const contactEmail = shipEmail

      // Create the invoice only if we haven't already (a duplicate event must
      // never mint a second invoice or record a second clearing payment).
      if (!invoiceId) {
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
          { reference: referenceSafe, currency, expectedTotal, country },
        )

        const created = await createSalesInvoice(ctx.accessToken, ctx.tenantId, {
          contactName,
          contactEmail,
          currency,
          reference: referenceSafe,
          lines,
          address: invoiceAddress,
        })
        invoiceId = created.invoiceId
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
            reference: referenceSafe,
            lines: [{ description: `Order ${referenceSafe}`, amount: expectedTotal, itemCode: null }],
            address: invoiceAddress,
          })
          invoiceId = retry.invoiceId
          if (retry.error) lastError = retry.error
        }
        if (invoiceId) {
          // Success — store the id and clear any prior error so a row that has
          // since invoiced never keeps a stale "failed" flag.
          await admin.from('orders').update({ xero_invoice_id: invoiceId, xero_invoice_error: null }).eq('id', orderId)

          // If a Stripe clearing account is configured (000242), record the
          // payment into it so the invoice is marked PAID immediately, matching
          // Xero's own Pay-now flow. The Stripe account feed later reconciles
          // against this payment rather than double-counting. Best-effort: a
          // failure here leaves the invoice created-but-unpaid for the feed to
          // settle, and never fails the webhook.
          const { data: payCfg } = await admin.from('settings').select('xero_stripe_account_code').eq('id', 1).single()
          const stripeAcctCode = payCfg?.xero_stripe_account_code as string | null | undefined
          if (stripeAcctCode) {
            const pay = await recordInvoicePayment(ctx.accessToken, ctx.tenantId, {
              invoiceId,
              accountCode: stripeAcctCode,
              amount: expectedTotal,
            })
            if (!pay.ok) console.error(`[stripe-webhook] xero payment record failed for order ${orderId}:`, pay.error)
          }
        } else {
          console.error(`[stripe-webhook] xero invoice not created for order ${orderId}:`, lastError)
          await admin.from('orders').update({ xero_invoice_error: lastError ?? 'Xero did not return an invoice' }).eq('id', orderId)
        }
      }

      // Email the invoice to the customer as their VAT receipt — once
      // (idempotent on invoice_emailed_at). Runs after the clearing-account
      // payment above, so the emailed invoice reads as PAID. Best-effort: a
      // miss is cosmetic (the invoice exists in Xero + the pay-page shows a
      // download link), logged not stamped as a hard error.
      if (invoiceId && !order?.invoice_emailed_at) {
        const emailed = await emailSalesInvoice(ctx.accessToken, ctx.tenantId, invoiceId)
        if (emailed.ok) {
          await admin.from('orders').update({ invoice_emailed_at: new Date().toISOString() }).eq('id', orderId)
          console.log('[stripe-webhook] invoice emailed', { orderId, invoiceId })
        } else {
          console.warn('[stripe-webhook] invoice email failed', { orderId, error: emailed.error })
        }
      }
    }
  } catch (e) {
    console.error('[stripe-webhook] xero invoice failed:', (e as Error).message)
    // Stamp the caught error too, so an exception path is just as visible as a
    // Xero rejection. Best-effort: this update must not throw out of the catch.
    await admin.from('orders').update({ xero_invoice_error: (e as Error).message }).eq('id', orderId).then(undefined, () => {})
  }

  // Branded order-paid confirmation, emailed to the customer via Help Scout
  // (the same channel the pay-link went out on). Mirrors proof-action's
  // confirmation-reply path: post a staff reply on the linked conversation —
  // Help Scout emails it to the customer at creation time — then hide it so the
  // team's view stays tidy. One-shot on confirmation_sent_at; skipped silently
  // when the proof has no linked conversation; never fails the webhook. (The
  // VAT invoice goes to the customer as its own email — the Xero invoice email
  // above — plus a pay-page download link, so this warm note doesn't carry it.)
  try {
    const { data: ord } = await admin
      .from('orders')
      .select('proof_id, created_by, payment_reference, confirmation_sent_at')
      .eq('id', orderId)
      .single()
    if (ord && !ord.confirmation_sent_at) {
      const { data: proofCtx } = await admin
        .from('proofs')
        .select('helpscout_conversation_id, contacts:contact_id ( full_name, companies:company_id ( name ) )')
        .eq('id', ord.proof_id)
        .single()
      const conversationId = (proofCtx?.helpscout_conversation_id as string | null) ?? null
      const appId = Deno.env.get('HELPSCOUT_APP_ID')
      const appSecret = Deno.env.get('HELPSCOUT_APP_SECRET')
      if (!conversationId) {
        // No linked thread — the pay-link was sent manually; nothing to reply to.
        console.log('[stripe-webhook] confirmation skipped: proof has no linked conversation', { orderId })
      } else if (!appId || !appSecret) {
        console.warn('[stripe-webhook] confirmation skipped: Help Scout not configured')
      } else {
        const token = await getAccessToken(appId, appSecret)
        const conv = await fetchConversation(token, conversationId)
        const primaryCustomerId = conv?.primaryCustomer?.id ?? null
        if (!conv || primaryCustomerId == null) {
          console.warn('[stripe-webhook] confirmation skipped: conversation/customer missing', { conversationId })
        } else {
          // Sender resolution, mirroring proof-action (PV-2026W20-007):
          //   1. order.created_by → profiles.helpscout_user_id
          //   2. conversation assignee
          //   3. HELPSCOUT_DEFAULT_USER_ID env
          //   4. skip + warn (courtesy gap only — the on-screen confirmation
          //      and the self-serve invoice link already covered the customer).
          let senderId: number | null = null
          const createdBy = (ord.created_by as string | null) ?? null
          if (createdBy) {
            const { data: profileRow } = await admin.from('profiles').select('helpscout_user_id').eq('id', createdBy).maybeSingle()
            const value = (profileRow as { helpscout_user_id: number | null } | null)?.helpscout_user_id ?? null
            if (typeof value === 'number' && Number.isInteger(value) && value > 0) senderId = value
          }
          if (senderId == null && conv.assignee?.id != null) senderId = conv.assignee.id
          if (senderId == null) {
            const raw = Deno.env.get('HELPSCOUT_DEFAULT_USER_ID')?.trim()
            if (raw) {
              const parsed = Number(raw)
              if (Number.isInteger(parsed) && parsed > 0) senderId = parsed
              else console.warn('[stripe-webhook] HELPSCOUT_DEFAULT_USER_ID not a positive integer', { raw })
            }
          }
          if (senderId == null) {
            console.warn('[stripe-webhook] confirmation skipped: no sender resolvable', { orderId, createdBy })
          } else {
            // first_name: contact full_name's first token, else the HS primary
            // customer's first name, else a friendly fallback so the greeting is
            // never "Hi ,". company: the contact's company (conditional in copy).
            const contact = (proofCtx?.contacts ?? null) as
              | { full_name?: string | null; companies?: { name?: string | null } | null }
              | null
            const fullName = contact?.full_name ?? null
            const firstName = (fullName?.trim().split(/\s+/)[0]) || (conv.primaryCustomer?.first ?? '') || 'there'
            const company = contact?.companies?.name ?? ''
            const { data: tplRow } = await admin
              .from('reply_templates')
              .select('body')
              .eq('id', 'order_paid_confirmation')
              .maybeSingle()
            const body = renderTemplate(
              ((tplRow as { body: string } | null)?.body) ?? ORDER_CONFIRMATION_DEFAULT_BODY,
              {
                first_name: firstName,
                company,
                payment_reference: (ord.payment_reference as string | null) ?? reference ?? orderId,
              },
            )
            const replyThreadId = await postStaffReply(token, conversationId, {
              text: body,
              userId: senderId,
              customerId: primaryCustomerId,
              // No status flip — a confirmation, not a designer asking for input.
            })
            // Stamp before the (cosmetic) hide so a hide failure can't cause a
            // resend on a Stripe retry.
            await admin.from('orders').update({ confirmation_sent_at: new Date().toISOString() }).eq('id', orderId)
            console.log('[stripe-webhook] confirmation reply sent', { orderId, senderId, replyThreadId })
            if (replyThreadId > 0) {
              try {
                await hideThread(token, conversationId, replyThreadId)
              } catch (hideErr) {
                console.warn('[stripe-webhook] confirmation hide failed', hideErr)
              }
            }
          }
        }
      }
    }
  } catch (e) {
    const msg = e instanceof HsError ? `${e.status} ${e.message}` : (e as Error).message
    console.warn('[stripe-webhook] confirmation reply failed:', msg)
  }

  return new Response('ok', { status: 200 })
})
