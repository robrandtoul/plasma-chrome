// create-order — designer-only. Creates a proofs.orders row for an
// approved proof and returns the row + the pay-page token. Step 3 of
// the Ordering & checkout build (docs/ordering-checkout-spec.md).
//
// The order captures the designer's locked decisions (quantity mode,
// shipping treatment, custom-quote total). The final price is computed
// later on the customer pay-page (Step 4) from these inputs; this
// function does not price anything or move any money.
//
// Auth: requireDesigner (admin or designer; anon/customers rejected).
// Writes go through the service-role client. The order is created
// 'sent' (the pay-link is live) with the caller stamped as created_by.

import { json, requireDesigner } from '../_shared/admin.ts'
import { logAudit } from '../_shared/audit.ts'

type ShippingTreatment = 'full_cost' | 'goodwill' | 'free' | 'manual'
type Currency = 'GBP' | 'EUR' | 'USD'

const SHIPPING_TREATMENTS: ShippingTreatment[] = ['full_cost', 'goodwill', 'free', 'manual']
const CURRENCIES: Currency[] = ['GBP', 'EUR', 'USD']

// URL-safe random token for the pay-page bearer. 32 hex chars from the
// platform CSPRNG — unguessable and collision-safe for this volume.
function randomToken(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

// Human-ish reference stamped on both the Stripe payment and the Xero
// invoice (Architecture rule #2) so the existing Stripe bank feed
// auto-matches the statement line to the invoice. Short + uppercase.
function paymentReference(): string {
  const bytes = new Uint8Array(5)
  crypto.getRandomValues(bytes)
  const suffix = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase()
  return `ORD-${suffix}`
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' } })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const check = await requireDesigner(req)
  if (check instanceof Response) return check
  const { admin, callerId, callerEmail, callerLabel } = check

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }

  // ── Validate ────────────────────────────────────────────────────
  const proofId = typeof body.proof_id === 'string' ? body.proof_id : null
  if (!proofId) return json({ error: 'Missing proof_id' }, 400)

  const currency = body.currency as Currency
  if (!CURRENCIES.includes(currency)) {
    return json({ error: 'Missing or invalid currency' }, 400)
  }

  const shippingTreatment = (body.shipping_treatment as ShippingTreatment) ?? 'full_cost'
  if (!SHIPPING_TREATMENTS.includes(shippingTreatment)) {
    return json({ error: 'Invalid shipping_treatment' }, 400)
  }

  // quantity: null = customer chooses on the pay-page; a number = locked.
  let quantity: number | null = null
  if (body.quantity != null) {
    const q = Number(body.quantity)
    if (!Number.isInteger(q) || q <= 0) return json({ error: 'quantity must be a positive integer' }, 400)
    quantity = q
  }

  const namesCount = (() => {
    const n = Number(body.names_count ?? 1)
    return Number.isInteger(n) && n >= 1 ? n : 1
  })()

  const hasPersonalisation = body.has_personalisation === true

  // material_variant_id is optional in v1 — the pay-page (Step 4)
  // resolves the precise variant/price. Pass through when supplied.
  const materialVariantId = typeof body.material_variant_id === 'string' ? body.material_variant_id : null

  // Chosen material option — e.g. metal finish (Natural/Brushed/Mirror). The
  // checkout applies the matching option surcharge; null = base / no finish.
  const materialOptionId = typeof body.material_option_id === 'string' ? body.material_option_id : null

  // shipping_charged: only meaningful for the manual treatment; a
  // resolved figure for the other treatments is computed at pay time.
  let shippingCharged: number | null = null
  if (body.shipping_charged != null) {
    const s = Number(body.shipping_charged)
    if (!Number.isFinite(s) || s < 0) return json({ error: 'shipping_charged must be zero or greater' }, 400)
    shippingCharged = Math.round(s * 100) / 100
  }
  if (shippingTreatment === 'manual' && shippingCharged == null) {
    return json({ error: 'shipping_charged is required for the manual treatment' }, 400)
  }

  // Rating destination. The postcode (and usually the exact country) is
  // supplied by the CUSTOMER on the pay-page — support rarely knows the
  // postcode at order-creation time — so neither is required here. A country
  // may be passed as an optional pre-fill hint for the pay-page; the customer
  // confirms it and adds their postcode before paying, and create-checkout-
  // session rates against those. Stored null until then for free / manual.
  let shipDestCountry: string | null = null
  const shipDestPostcode: string | null = null
  if (typeof body.ship_dest_country === 'string' && body.ship_dest_country.trim()) {
    const c = body.ship_dest_country.trim().toUpperCase()
    if (!/^[A-Z]{2}$/.test(c)) {
      return json({ error: 'ship_dest_country must be a 2-letter ISO code' }, 400)
    }
    shipDestCountry = c
  }

  // shipping_discount_percent — the per-order goodwill discount (0–100). Only
  // meaningful for the goodwill treatment; required there, ignored otherwise.
  let shippingDiscountPercent: number | null = null
  if (shippingTreatment === 'goodwill') {
    const d = Number(body.shipping_discount_percent)
    if (!Number.isFinite(d) || d < 0 || d > 100) {
      return json({ error: 'shipping_discount_percent (0–100) is required for the goodwill treatment' }, 400)
    }
    shippingDiscountPercent = Math.round(d * 100) / 100
  }

  let customQuoteTotal: number | null = null
  if (body.custom_quote_total != null) {
    const c = Number(body.custom_quote_total)
    if (!Number.isFinite(c) || c < 0) return json({ error: 'custom_quote_total must be zero or greater' }, 400)
    customQuoteTotal = Math.round(c * 100) / 100
  }

  // expires_at: an explicit ISO string wins; otherwise default to 14 days from
  // now. The pay-page shows this date to the customer and refuses payment past
  // it; a designer can extend/reissue an expired link (reactivate-order).
  const ORDER_EXPIRY_DAYS = 14
  const expiresAt = typeof body.expires_at === 'string'
    ? body.expires_at
    : new Date(Date.now() + ORDER_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString()

  // ── Confirm the proof exists (and is approved) ──────────────────
  const { data: proof, error: proofErr } = await admin
    .from('proofs')
    .select('id, status')
    .eq('id', proofId)
    .single()
  if (proofErr || !proof) return json({ error: 'Proof not found' }, 404)
  if (proof.status !== 'approved') {
    return json({ error: 'Orders can only be created for approved proofs' }, 409)
  }

  // ── Insert ──────────────────────────────────────────────────────
  const token = randomToken()
  const payment_reference = paymentReference()
  const nowIso = new Date().toISOString()

  const { data: order, error: insertErr } = await admin
    .from('orders')
    .insert({
      proof_id: proofId,
      status: 'sent',
      material_variant_id: materialVariantId,
      material_option_id: materialOptionId,
      quantity,
      names_count: namesCount,
      has_personalisation: hasPersonalisation,
      custom_quote_total: customQuoteTotal,
      shipping_treatment: shippingTreatment,
      shipping_charged: shippingCharged,
      shipping_discount_percent: shippingDiscountPercent,
      ship_dest_country: shipDestCountry,
      ship_dest_postcode: shipDestPostcode,
      currency,
      token,
      expires_at: expiresAt,
      payment_reference,
      created_by: callerId,
      sent_at: nowIso,
    })
    .select('id, token, status, payment_reference')
    .single()

  if (insertErr || !order) {
    return json({ error: `Could not create order: ${insertErr?.message ?? 'unknown error'}` }, 500)
  }

  await logAudit(admin, {
    actorId: callerId,
    actorEmail: callerEmail,
    actorLabel: callerLabel,
    action: 'order.created',
    targetType: 'order',
    targetId: order.id,
    targetLabel: `Order ${order.payment_reference} for proof ${proofId}`,
    afterValue: {
      status: order.status,
      currency,
      quantity,
      shipping_treatment: shippingTreatment,
      shipping_discount_percent: shippingDiscountPercent,
      ship_dest_country: shipDestCountry,
      ship_dest_postcode: shipDestPostcode,
      has_personalisation: hasPersonalisation,
      custom_quote_total: customQuoteTotal,
      material_option_id: materialOptionId,
    },
  })

  return json({
    id: order.id,
    token: order.token,
    status: order.status,
    payment_reference: order.payment_reference,
  })
})
