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

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { getAccessContext, createSalesInvoice, recordInvoicePayment, emailSalesInvoice, ensureInvoiceEmailRecipient } from '../_shared/xero.ts'
import { buildOrderInvoiceLines, buildGroupInvoiceLines, resolveZeroRatedTaxType, type OrderForInvoice } from '../_shared/invoiceBuild.ts'
import { isVatFreeGbpDestination } from '../_shared/ukVatArea.ts'
import { getAccessToken, fetchConversation, postStaffReply, HsError } from '../_shared/helpscout.ts'
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
  phone: string | null
  address: {
    line1: string | null
    line2: string | null
    city: string | null
    region: string | null
    postal_code: string | null
    country: string | null
  } | null
} {
  const cust = (session.customer_details ?? {}) as { name?: string; email?: string; phone?: string; address?: StripeAddr }
  const shipDetails =
    (session.shipping_details as { name?: string; phone?: string; address?: StripeAddr } | undefined) ??
    ((session.collected_information as { shipping_details?: { name?: string; phone?: string; address?: StripeAddr } } | undefined)?.shipping_details)
  const a = shipDetails?.address ?? cust.address ?? null
  return {
    name: shipDetails?.name ?? cust.name ?? null,
    email: cust.email ?? null,
    phone: shipDetails?.phone ?? cust.phone ?? null,
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
  // We capture: order id (or the order GROUP id for a combined payment —
  // bundle orders Slice 2), delivery name/email/phone/address (StripeAddr
  // shape: state + postal_code), the charged total (major units), currency,
  // and the shared payment reference.
  let orderId: string | undefined
  let groupId: string | undefined
  let reference: string | undefined
  let currencyUpper = 'GBP'
  let amountMajor: number | undefined
  let shipName: string | null = null
  let shipEmail: string | null = null
  let shipPhone: string | null = null
  let shipAddr: StripeAddr | null = null

  if (event.type === 'checkout.session.completed') {
    const session = event.data?.object ?? {}
    const meta = (session.metadata ?? {}) as Record<string, unknown>
    orderId = meta.order_id as string | undefined
    groupId = meta.order_group_id as string | undefined
    const paymentStatus = session.payment_status as string | undefined
    if ((!orderId && !groupId) || paymentStatus !== 'paid') return new Response('ok', { status: 200 })
    const ship = extractShipping(session)
    shipName = ship.name
    shipEmail = ship.email
    shipPhone = ship.phone
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
    reference = (meta.payment_reference as string | undefined) ?? orderId ?? groupId
    currencyUpper = String(session.currency ?? 'gbp').toUpperCase()
    const amt = session.amount_total as number | undefined
    amountMajor = typeof amt === 'number' ? amt / 100 : undefined
  } else if (event.type === 'payment_intent.succeeded') {
    const pi = event.data?.object ?? {}
    const meta = (pi.metadata ?? {}) as Record<string, unknown>
    orderId = meta.order_id as string | undefined
    groupId = meta.order_group_id as string | undefined
    if (!orderId && !groupId) return new Response('ok', { status: 200 })
    const shipping = pi.shipping as { name?: string; phone?: string; address?: StripeAddr } | undefined
    shipName = shipping?.name ?? null
    shipEmail = (pi.receipt_email as string | undefined) ?? null
    // Recipient phone from the Address Element (fields.phone) — persisted for
    // the courier paperwork (FedEx requires a contact number).
    shipPhone = shipping?.phone ?? null
    shipAddr = shipping?.address ?? null
    reference = (meta.payment_reference as string | undefined) ?? orderId ?? groupId
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

  // ── Group mode (bundle orders Slice 2) ─────────────────────────────
  // metadata.order_group_id routes here: flip the group + EVERY member order
  // to paid, then run the money side ONCE at group level — one itemised Xero
  // invoice (a product + tooling line per card, one shipping, one tariff),
  // one clearing payment, one VAT-invoice email, one HS confirmation. All
  // gated on the group's done-once columns so Stripe retries can't double up.
  if (groupId) {
    return await handleGroupPaid(admin, groupId, {
      reference,
      currencyUpper,
      amountMajor,
      shipName,
      shipEmail,
      shipPhone,
      shipAddr,
      storedAddress,
    })
  }
  if (!orderId) return new Response('ok', { status: 200 })

  // Idempotent: only flip from 'sent' → 'paid'. A Stripe retry (or a
  // duplicate event) finds the row already paid and updates nothing.
  const { error } = await admin
    .from('orders')
    .update({
      status: 'paid',
      paid_at: new Date().toISOString(),
      ship_to_name: shipName,
      ship_to_email: shipEmail,
      ship_to_phone: shipPhone,
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
        .select('proof_id, material_variant_id, material_option_id, quantity, names_count, custom_quote_total, amount_cards, amount_tooling, amount_personalisation, amount_shipping, amount_us_tariff, amount_card_discount, order_kind, ship_dest_country, xero_invoice_id, xero_contact_id, xero_contact_name, invoice_emailed_at')
        .eq('id', orderId)
        .single()
      let invoiceId: string | null = (order?.xero_invoice_id as string | null) ?? null

      // The existing Xero contact the designer chose at order time (000275). When
      // set, the invoice binds to it so it files under the customer's record;
      // when null, this is a new customer and we let Xero create the contact,
      // then write its ContactID back below so the next order pre-fills it.
      const boundContactId = (order?.xero_contact_id as string | null) ?? null

      // Delivery country that drives the domestic-vs-international shipping line.
      // Use the destination the order was RATED against (ship_dest_country, set
      // by create-checkout from the customer's pay-page choice) so the invoice's
      // shipping code matches the shipping charge + US tariff computed from it.
      // The Stripe-collected address country can differ (the buyer may type a
      // different country into the card form than the destination they picked),
      // so it's only the fallback when the order has no rated destination
      // (e.g. a free/manual order with no hint).
      const country = (order?.ship_dest_country as string | null) ?? shipAddr?.country ?? null
      // GBP + Channel Islands destination → the order was priced ex-VAT at
      // checkout, so the invoice must book VAT-free (NoTax) or Xero would
      // carve VAT back out of the ex-VAT figures. Derived from the RATED
      // destination only (ship_dest_country, normalised + persisted by
      // create-checkout-session) — the same source the pricing used — never
      // from the card-form address, so the tax treatment always matches the
      // stamped amounts.
      const vatFree =
        currency === 'GBP' && isVatFreeGbpDestination((order?.ship_dest_country as string | null) ?? null)
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

      const payerName = shipName || shipEmail || 'Customer'
      const contactEmail = shipEmail
      // For a NEW customer (no bound id) the designer may have named the contact
      // (e.g. the company) so it's created as the customer, not whoever pays —
      // use that, falling back to the payer. Ignored on the bound path, where the
      // ContactID wins and the Name is never sent. The payer's own name still
      // drives the email-recipient person added to a bound company contact below.
      const newContactName = (order?.xero_contact_name as string | null)?.trim() || payerName

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
            amount_us_tariff: null,
            amount_card_discount: null,
            order_kind: null,
          },
          { reference: referenceSafe, currency, expectedTotal, country },
        )

        // Zero-rated rate for a VAT-free invoice ("0% EU" / "0% ROW",
        // settings 000306), classified from the same delivery country that
        // drives the shipping line. Null → the legacy "No VAT" treatment.
        const zeroRatedTaxType = await resolveZeroRatedTaxType(admin, country, currency)

        const created = await createSalesInvoice(ctx.accessToken, ctx.tenantId, {
          contactName: newContactName,
          contactEmail,
          currency,
          reference: referenceSafe,
          lines,
          address: invoiceAddress,
          contactId: boundContactId,
          vatFree,
          zeroRatedTaxType,
        })
        invoiceId = created.invoiceId
        // The created invoice object echoes back the resolved Contact (incl. the
        // ContactID Xero assigned for a new customer) — kept so we can remember
        // it on the order below.
        let createdInvoice = created.invoice
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
        // The retry also drops the zero-rated TaxType — an org that rejects
        // the item codes may equally not know the custom rate, and a "No
        // VAT" invoice beats no invoice.
        const wasItemised = lines.some((l) => l.itemCode) || !!zeroRatedTaxType
        if (!invoiceId && wasItemised) {
          console.warn(`[stripe-webhook] itemised invoice rejected for order ${orderId}; retrying as a single summary line`)
          const retry = await createSalesInvoice(ctx.accessToken, ctx.tenantId, {
            contactName: newContactName,
            contactEmail,
            currency,
            reference: referenceSafe,
            lines: [{ description: `Order ${referenceSafe}`, amount: expectedTotal, itemCode: null }],
            address: invoiceAddress,
            contactId: boundContactId,
            vatFree,
          })
          invoiceId = retry.invoiceId
          if (retry.invoice) createdInvoice = retry.invoice
          if (retry.error) lastError = retry.error
        }
        if (invoiceId) {
          // Success — store the id and clear any prior error so a row that has
          // since invoiced never keeps a stale "failed" flag.
          await admin.from('orders').update({ xero_invoice_id: invoiceId, xero_invoice_error: null }).eq('id', orderId)

          // Auto-remember (000275): when this order wasn't bound to a Xero
          // contact (a new customer), capture the ContactID Xero just created so
          // the customer's NEXT order pre-fills it in the Create order modal.
          // Only on the unbound path — a bound order already has the right id,
          // and re-reading it from the echoed invoice would be a no-op.
          if (!boundContactId) {
            const c = (createdInvoice?.Contact as { ContactID?: string; Name?: string } | undefined) ?? null
            if (c?.ContactID) {
              await admin
                .from('orders')
                .update({ xero_contact_id: c.ContactID, ...(c.Name ? { xero_contact_name: c.Name } : {}) })
                .eq('id', orderId)
            }
          }

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
        if (!contactEmail) {
          // No buyer email on the order — the Xero contact has no address to
          // send to, so emailing would just fail. (The pay-page now passes
          // receipt_email, so this should be rare; an older pay-page or a
          // payment method without an email lands here.) The invoice still
          // exists in Xero and the pay-page download link covers the customer;
          // a human can backfill the email and resend. Not stamped as an
          // invoice error — the invoice itself is fine.
          console.warn('[stripe-webhook] invoice email skipped: no buyer email on order', { orderId, invoiceId })
        } else {
          // When the invoice is filed under an existing (company) Xero contact,
          // Xero would email it to THAT contact's address, not the person who
          // paid. To keep the VAT receipt reaching the payer (Rob's choice), add
          // them as an "include in emails" person on the bound contact first —
          // a no-op when they're already the primary email or an included person
          // (the common B2B case where the buyer is the company contact), and
          // skipped entirely on the new-customer path (the contact already IS
          // the payer). Best-effort: a miss just means Xero emails the company,
          // and the payer still has the pay-page invoice link + Stripe receipt.
          if (boundContactId) {
            const rec = await ensureInvoiceEmailRecipient(ctx.accessToken, ctx.tenantId, boundContactId, contactEmail, payerName)
            if (!rec.ok) console.warn('[stripe-webhook] could not add payer as invoice email recipient', { orderId, error: rec.error })
            else if (rec.added) console.log('[stripe-webhook] payer added as invoice email recipient on bound contact', { orderId })
          }
          const emailed = await emailSalesInvoice(ctx.accessToken, ctx.tenantId, invoiceId)
          if (emailed.ok) {
            await admin.from('orders').update({ invoice_emailed_at: new Date().toISOString() }).eq('id', orderId)
            console.log('[stripe-webhook] invoice emailed', { orderId, invoiceId })
          } else {
            console.warn('[stripe-webhook] invoice email failed', { orderId, error: emailed.error })
          }
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
  // (the same channel the pay-link went out on): post a staff reply on the
  // linked conversation — Help Scout emails it to the customer at creation
  // time — and leave it expanded in the thread so the team can see the
  // confirmation went out. One-shot on confirmation_sent_at; skipped silently
  // when the proof has no linked conversation; never fails the webhook. (The
  // VAT invoice goes to the customer as its own email — the Xero invoice email
  // above — plus a pay-page download link, so this warm note doesn't carry it.)
  try {
    const { data: ord } = await admin
      .from('orders')
      .select('proof_id, created_by, payment_reference, confirmation_sent_at, token')
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
            // Link back to the customer's order page (which doubles as the
            // tracking page once tracking is enabled). The template wraps it in
            // a {? order_url}…{/?} conditional, so an unset base URL / token just
            // drops the line cleanly. Same base-URL env the reminder sender uses.
            const baseUrl = (Deno.env.get('PROOF_VIEWER_BASE_URL')?.trim() ?? '').replace(/\/+$/, '')
            const orderToken = (ord.token as string | null) ?? ''
            const orderUrl = baseUrl && orderToken ? `${baseUrl}/order/${orderId}?token=${encodeURIComponent(orderToken)}` : ''
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
                order_url: orderUrl,
              },
            )
            const replyThreadId = await postStaffReply(token, conversationId, {
              text: body,
              userId: senderId,
              customerId: primaryCustomerId,
              // No status flip — a confirmation, not a designer asking for input.
            })
            // Stamp once the reply is sent so a Stripe retry can't resend it.
            await admin.from('orders').update({ confirmation_sent_at: new Date().toISOString() }).eq('id', orderId)
            console.log('[stripe-webhook] confirmation reply sent', { orderId, senderId, replyThreadId })
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

// ── Group payment fulfilment (bundle orders Slice 2) ────────────────────────
// The group-mode mirror of the single-order flow above, structured the same
// way and gated on the group's own done-once columns:
//   1. Flip the group 'sent' → 'paid' (idempotent), then EVERY member order —
//      each card enters the To-order queue on its own, exactly like a
//      standalone paid order (making fans out, spec §6).
//   2. ONE itemised Xero invoice, gated on group.xero_invoice_id: a product
//      (+ tooling + discount) line per card from each member's stamped
//      breakdown, plus ONE combined shipping line and ONE US-tariff line from
//      the group row. Reference = the group's GRP- payment_reference, so the
//      Stripe→Xero bank-feed match stays exactly 1:1.
//   3. Optional clearing-account payment, then ONE VAT-invoice email (gated
//      on group.invoice_emailed_at).
//   4. ONE branded confirmation on the Help Scout thread of the group's first
//      member that has a linked conversation (gated on
//      group.confirmation_sent_at); sender resolved from group.created_by.
// Steps 2–4 are best-effort: failures log / stamp xero_invoice_error and never
// fail the webhook (Stripe must get its 200 once the flips have landed).
async function handleGroupPaid(
  admin: SupabaseClient,
  groupId: string,
  evt: {
    reference: string | undefined
    currencyUpper: string
    amountMajor: number | undefined
    shipName: string | null
    shipEmail: string | null
    shipPhone: string | null
    shipAddr: StripeAddr | null
    storedAddress: Record<string, unknown> | null
  },
): Promise<Response> {
  const nowIso = new Date().toISOString()

  // 1. Flip the group, then its members. Conditional updates keep both
  // idempotent — a duplicate event matches nothing. Member flips also carry
  // the Stripe delivery details so each card's fulfilment surface reads the
  // same address a standalone order would.
  const { error: groupFlipErr } = await admin
    .from('order_groups')
    .update({
      status: 'paid',
      paid_at: nowIso,
      ship_to_name: evt.shipName,
      ship_to_email: evt.shipEmail,
      ship_to_phone: evt.shipPhone,
      ship_to_address: evt.storedAddress,
      updated_at: nowIso,
    })
    .eq('id', groupId)
    .eq('status', 'sent')
  if (groupFlipErr) {
    console.error('[stripe-webhook] group update failed:', groupFlipErr.message)
    // 500 → Stripe retries, which is what we want on a transient DB error.
    return new Response('update failed', { status: 500 })
  }
  const { error: memberFlipErr } = await admin
    .from('orders')
    .update({
      status: 'paid',
      paid_at: nowIso,
      ship_to_name: evt.shipName,
      ship_to_email: evt.shipEmail,
      ship_to_phone: evt.shipPhone,
      ship_to_address: evt.storedAddress,
      updated_at: nowIso,
    })
    .eq('order_group_id', groupId)
    .eq('status', 'sent')
  if (memberFlipErr) {
    console.error('[stripe-webhook] group member update failed:', memberFlipErr.message)
    return new Response('update failed', { status: 500 })
  }

  // 2. ONE Xero invoice for the whole group (best-effort from here on).
  try {
    const ctx = await getAccessContext(admin)
    if (ctx && typeof evt.amountMajor === 'number') {
      const { data: group } = await admin
        .from('order_groups')
        .select('payment_reference, currency, ship_dest_country, amount_shipping, amount_us_tariff, xero_invoice_id, xero_contact_id, xero_contact_name, invoice_emailed_at')
        .eq('id', groupId)
        .single()
      const { data: memberRows } = await admin
        .from('orders')
        .select('id, proof_id, material_variant_id, material_option_id, quantity, names_count, custom_quote_total, amount_cards, amount_tooling, amount_personalisation, amount_shipping, amount_us_tariff, amount_card_discount, order_kind')
        .eq('order_group_id', groupId)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
      const members = (memberRows ?? []) as (OrderForInvoice & { id: string })[]

      const referenceSafe = (group?.payment_reference as string | null) ?? evt.reference ?? groupId
      const currency = evt.currencyUpper
      const expectedTotal = evt.amountMajor
      let invoiceId: string | null = (group?.xero_invoice_id as string | null) ?? null
      const boundContactId = (group?.xero_contact_id as string | null) ?? null

      // Delivery country: the destination the GROUP was rated against (one
      // address per group), falling back to the card-form country — the same
      // precedence as single orders, for the same reason.
      const country = (group?.ship_dest_country as string | null) ?? evt.shipAddr?.country ?? null
      const vatFree =
        currency === 'GBP' && isVatFreeGbpDestination((group?.ship_dest_country as string | null) ?? null)
      const invoiceAddress = evt.shipAddr
        ? {
            line1: evt.shipAddr.line1 ?? null,
            line2: evt.shipAddr.line2 ?? null,
            city: evt.shipAddr.city ?? null,
            region: evt.shipAddr.state ?? null,
            postalCode: evt.shipAddr.postal_code ?? null,
            country: evt.shipAddr.country ?? null,
          }
        : null

      const payerName = evt.shipName || evt.shipEmail || 'Customer'
      const contactEmail = evt.shipEmail
      const newContactName = (group?.xero_contact_name as string | null)?.trim() || payerName

      if (!invoiceId && members.length > 0 && group) {
        const { lines } = await buildGroupInvoiceLines(
          admin,
          members,
          {
            amount_shipping: group.amount_shipping as number | null,
            amount_us_tariff: group.amount_us_tariff as number | null,
          },
          { reference: referenceSafe, currency, expectedTotal, country },
        )
        const zeroRatedTaxType = await resolveZeroRatedTaxType(admin, country, currency)

        const created = await createSalesInvoice(ctx.accessToken, ctx.tenantId, {
          contactName: newContactName,
          contactEmail,
          currency,
          reference: referenceSafe,
          lines,
          address: invoiceAddress,
          contactId: boundContactId,
          vatFree,
          zeroRatedTaxType,
        })
        invoiceId = created.invoiceId
        let createdInvoice = created.invoice
        let lastError = created.error

        // Same single-summary-line degradation as single orders: an org that
        // rejects an item code (or the custom tax rate) still gets an invoice
        // that matches the charge.
        const wasItemised = lines.some((l) => l.itemCode) || !!zeroRatedTaxType
        if (!invoiceId && wasItemised) {
          console.warn(`[stripe-webhook] itemised group invoice rejected for group ${groupId}; retrying as a single summary line`)
          const retry = await createSalesInvoice(ctx.accessToken, ctx.tenantId, {
            contactName: newContactName,
            contactEmail,
            currency,
            reference: referenceSafe,
            lines: [{ description: `Order ${referenceSafe}`, amount: expectedTotal, itemCode: null }],
            address: invoiceAddress,
            contactId: boundContactId,
            vatFree,
          })
          invoiceId = retry.invoiceId
          if (retry.invoice) createdInvoice = retry.invoice
          if (retry.error) lastError = retry.error
        }
        if (invoiceId) {
          await admin.from('order_groups').update({ xero_invoice_id: invoiceId, xero_invoice_error: null }).eq('id', groupId)

          // Auto-remember a newly-created Xero contact on the group (mirror of
          // the single-order path; the members' own bindings are untouched).
          if (!boundContactId) {
            const c = (createdInvoice?.Contact as { ContactID?: string; Name?: string } | undefined) ?? null
            if (c?.ContactID) {
              await admin
                .from('order_groups')
                .update({ xero_contact_id: c.ContactID, ...(c.Name ? { xero_contact_name: c.Name } : {}) })
                .eq('id', groupId)
            }
          }

          const { data: payCfg } = await admin.from('settings').select('xero_stripe_account_code').eq('id', 1).single()
          const stripeAcctCode = payCfg?.xero_stripe_account_code as string | null | undefined
          if (stripeAcctCode) {
            const pay = await recordInvoicePayment(ctx.accessToken, ctx.tenantId, {
              invoiceId,
              accountCode: stripeAcctCode,
              amount: expectedTotal,
            })
            if (!pay.ok) console.error(`[stripe-webhook] xero payment record failed for group ${groupId}:`, pay.error)
          }
        } else {
          console.error(`[stripe-webhook] xero invoice not created for group ${groupId}:`, lastError)
          await admin.from('order_groups').update({ xero_invoice_error: lastError ?? 'Xero did not return an invoice' }).eq('id', groupId)
        }
      }

      // 3. Email the group's VAT invoice once (gated on invoice_emailed_at).
      if (invoiceId && !group?.invoice_emailed_at) {
        if (!contactEmail) {
          console.warn('[stripe-webhook] group invoice email skipped: no buyer email', { groupId, invoiceId })
        } else {
          if (boundContactId) {
            const rec = await ensureInvoiceEmailRecipient(ctx.accessToken, ctx.tenantId, boundContactId, contactEmail, payerName)
            if (!rec.ok) console.warn('[stripe-webhook] could not add payer as invoice email recipient (group)', { groupId, error: rec.error })
          }
          const emailed = await emailSalesInvoice(ctx.accessToken, ctx.tenantId, invoiceId)
          if (emailed.ok) {
            await admin.from('order_groups').update({ invoice_emailed_at: nowIso }).eq('id', groupId)
            console.log('[stripe-webhook] group invoice emailed', { groupId, invoiceId })
          } else {
            console.warn('[stripe-webhook] group invoice email failed', { groupId, error: emailed.error })
          }
        }
      }
    }
  } catch (e) {
    console.error('[stripe-webhook] group xero invoice failed:', (e as Error).message)
    await admin.from('order_groups').update({ xero_invoice_error: (e as Error).message }).eq('id', groupId).then(undefined, () => {})
  }

  // 4. ONE branded confirmation, on the first member's linked Help Scout
  // conversation. Mirrors the single-order confirmation block; the order_url
  // is the GROUP pay page (its paid state doubles as the receipt).
  try {
    const { data: grp } = await admin
      .from('order_groups')
      .select('payment_reference, confirmation_sent_at, created_by, token')
      .eq('id', groupId)
      .single()
    if (grp && !grp.confirmation_sent_at) {
      // First member (by creation) whose proof has a linked conversation.
      const { data: memberProofs } = await admin
        .from('orders')
        .select('proof_id, created_at, proofs(helpscout_conversation_id, contacts:contact_id ( full_name, companies:company_id ( name ) ))')
        .eq('order_group_id', groupId)
        .order('created_at', { ascending: true })
      type MemberProof = {
        proof_id: string
        proofs: {
          helpscout_conversation_id: string | null
          contacts: { full_name?: string | null; companies?: { name?: string | null } | null } | null
        } | null
      }
      const withConv = ((memberProofs ?? []) as unknown as MemberProof[]).find(
        (m) => m.proofs?.helpscout_conversation_id,
      )
      const conversationId = withConv?.proofs?.helpscout_conversation_id ?? null
      const appId = Deno.env.get('HELPSCOUT_APP_ID')
      const appSecret = Deno.env.get('HELPSCOUT_APP_SECRET')
      if (!conversationId) {
        console.log('[stripe-webhook] group confirmation skipped: no member has a linked conversation', { groupId })
      } else if (!appId || !appSecret) {
        console.warn('[stripe-webhook] group confirmation skipped: Help Scout not configured')
      } else {
        const token = await getAccessToken(appId, appSecret)
        const conv = await fetchConversation(token, conversationId)
        const primaryCustomerId = conv?.primaryCustomer?.id ?? null
        if (!conv || primaryCustomerId == null) {
          console.warn('[stripe-webhook] group confirmation skipped: conversation/customer missing', { conversationId })
        } else {
          // Sender resolution, same ladder as single orders: the designer who
          // created the GROUP → conversation assignee → env default → skip.
          let senderId: number | null = null
          const createdBy = (grp.created_by as string | null) ?? null
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
            }
          }
          if (senderId == null) {
            console.warn('[stripe-webhook] group confirmation skipped: no sender resolvable', { groupId, createdBy })
          } else {
            const contact = withConv?.proofs?.contacts ?? null
            const fullName = contact?.full_name ?? null
            const firstName = (fullName?.trim().split(/\s+/)[0]) || (conv.primaryCustomer?.first ?? '') || 'there'
            const company = contact?.companies?.name ?? ''
            const baseUrl = (Deno.env.get('PROOF_VIEWER_BASE_URL')?.trim() ?? '').replace(/\/+$/, '')
            const groupToken = (grp.token as string | null) ?? ''
            const orderUrl = baseUrl && groupToken ? `${baseUrl}/order/group/${groupId}?token=${encodeURIComponent(groupToken)}` : ''
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
                payment_reference: (grp.payment_reference as string | null) ?? evt.reference ?? groupId,
                order_url: orderUrl,
              },
            )
            const replyThreadId = await postStaffReply(token, conversationId, {
              text: body,
              userId: senderId,
              customerId: primaryCustomerId,
            })
            await admin.from('order_groups').update({ confirmation_sent_at: new Date().toISOString() }).eq('id', groupId)
            console.log('[stripe-webhook] group confirmation reply sent', { groupId, senderId, replyThreadId })
          }
        }
      }
    }
  } catch (e) {
    const msg = e instanceof HsError ? `${e.status} ${e.message}` : (e as Error).message
    console.warn('[stripe-webhook] group confirmation reply failed:', msg)
  }

  return new Response('ok', { status: 200 })
}
