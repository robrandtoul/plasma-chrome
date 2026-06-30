// record-offline-payment — designer-only. Converts an existing 'sent' order
// (a live online pay-link) into an offline-PAID order, in place, when the
// customer pays by bank transfer instead of card.
//
// Why this exists: the offline path in create-order only applies when an order
// is FIRST created. Once a pay link has gone out, the only ways to change the
// order were to cancel it (which emails the customer "we've cancelled it") or
// let it expire — neither records the payment or moves the order to "To order".
// This function records the bank-transfer payment quietly: no email, no Stripe,
// no Xero (the designer raises the Xero invoice by hand, exactly as for an order
// created offline). The order keeps its id / token / reference / history — it's
// the SAME order, now marked paid offline — and lands in the "To order" queue.
//
// An online order can be created open-quantity (the customer picks on the pay
// page) and with address-dependent shipping (full_cost / goodwill, rated live
// at checkout). Neither works without the pay page, so the caller supplies the
// two missing locked inputs here: a fixed quantity and a settle-able shipping
// choice (free or a manual amount). Everything else (material, finish, currency,
// names, personalisation, card discount, custom quote) is read from the stored
// order — the client never sends or computes money.
//
// The price breakdown is computed + stamped with the SAME shared helpers the
// online checkout and the create-order offline branch use (computeOrderTotal),
// so the figure can't drift between paths.
//
// Auth: requireDesigner (admin or designer; anon/customers rejected). Writes go
// through the service-role client. Deploy with verify_jwt = true (the designer
// frontend always sends a fresh session JWT), matching create-order /
// order-lifecycle.

import { json, requireDesigner } from '../_shared/admin.ts'
import { logAudit } from '../_shared/audit.ts'
import { cardTotalForQuantity, computeOrderTotal, resolveCardDiscount, type Tier } from '../_shared/orderPricing.ts'

type Currency = 'GBP' | 'EUR' | 'USD'
type OfflineShipping = 'free' | 'manual'

function splitNameForCurrency(
  m: { split_name_surcharge_gbp: number | null; split_name_surcharge_eur: number | null; split_name_surcharge_usd: number | null } | null,
  currency: string,
): number | null {
  if (!m) return null
  const v = currency === 'GBP' ? m.split_name_surcharge_gbp : currency === 'EUR' ? m.split_name_surcharge_eur : m.split_name_surcharge_usd
  return v == null ? null : Number(v)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      },
    })
  }
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

  // ── Validate inputs ─────────────────────────────────────────────
  const orderId = typeof body.order_id === 'string' ? body.order_id.trim() : ''
  if (!orderId) return json({ error: 'order_id is required' }, 400)

  // quantity is required: an online order may be open-quantity, and an offline
  // order can't be without the pay page. The caller pre-fills the order's locked
  // quantity when it has one, so this is usually a confirmation, not a re-key.
  const quantity = Number(body.quantity)
  if (!Number.isInteger(quantity) || quantity <= 0) {
    return json({ error: 'A whole-number quantity (greater than zero) is required to record an offline payment.' }, 400)
  }

  const shipping = (body.shipping_treatment === 'manual' ? 'manual' : 'free') as OfflineShipping
  let shippingCharged: number | null = null
  if (shipping === 'manual') {
    const s = Number(body.shipping_charged)
    if (!Number.isFinite(s) || s < 0) {
      return json({ error: 'A shipping amount (zero or greater) is required for a manual shipping charge.' }, 400)
    }
    shippingCharged = Math.round(s * 100) / 100
  }

  // ── Load the order (must be a live pay-link) ────────────────────
  const { data: order, error: orderErr } = await admin
    .from('orders')
    .select(
      'id, proof_id, status, payment_method, currency, material_variant_id, material_option_id, names_count, ' +
        'has_personalisation, custom_quote_total, card_discount_type, card_discount_value, payment_reference',
    )
    .eq('id', orderId)
    .maybeSingle()
  if (orderErr) return json({ error: `Order lookup failed: ${orderErr.message}` }, 500)
  if (!order) return json({ error: 'Order not found' }, 404)
  if (order.status !== 'sent') {
    return json({ error: `This order is '${order.status}', so it can't be recorded as an offline payment.` }, 409)
  }

  const currency = order.currency as Currency
  const materialVariantId = (order.material_variant_id as string | null) ?? null
  const materialOptionId = (order.material_option_id as string | null) ?? null
  const customQuoteTotal = order.custom_quote_total == null ? null : Number(order.custom_quote_total)
  const namesCount = Number.isInteger(order.names_count) && (order.names_count as number) >= 1 ? (order.names_count as number) : 1
  const hasPersonalisation = order.has_personalisation === true

  if (customQuoteTotal == null && !materialVariantId) {
    return json({ error: 'This order has no material variant to price the cards — record it as a custom quote instead.' }, 422)
  }

  // ── Price the breakdown (same maths as create-order's offline branch) ──
  const round2 = (n: number) => Math.round(n * 100) / 100
  let amountCards: number
  let amountTooling: number
  let amountPersonalisation: number

  if (customQuoteTotal != null) {
    amountCards = customQuoteTotal
    amountTooling = 0
    amountPersonalisation = 0
  } else {
    const { data: tierRows } = await admin
      .from('price_tiers')
      .select('quantity, total_price')
      .eq('material_variant_id', materialVariantId)
      .eq('currency', currency)
    const tiers: Tier[] = (tierRows ?? []).map((t) => ({ quantity: t.quantity as number, total_price: Number(t.total_price) }))

    const { data: variant } = await admin
      .from('material_variants')
      .select('material_id')
      .eq('id', materialVariantId)
      .single()
    let perExtraName: number | null = null
    if (variant?.material_id) {
      const { data: material } = await admin
        .from('materials')
        .select('split_name_surcharge_gbp, split_name_surcharge_eur, split_name_surcharge_usd')
        .eq('id', variant.material_id)
        .single()
      perExtraName = splitNameForCurrency(material, currency)
    }

    let personalisation: { perCardRate: number; minCharge: number } | null = null
    if (hasPersonalisation) {
      const { data: p } = await admin
        .from('personalisation_pricing')
        .select('per_card_rate, min_charge')
        .eq('currency', currency)
        .single()
      if (p) personalisation = { perCardRate: Number(p.per_card_rate), minCharge: Number(p.min_charge) }
    }

    let optionSurcharge = 0
    if (materialOptionId) {
      const { data: surRows } = await admin
        .from('material_option_surcharges')
        .select('quantity, surcharge')
        .eq('material_option_id', materialOptionId)
        .eq('currency', currency)
      const surTiers: Tier[] = (surRows ?? []).map((s) => ({ quantity: s.quantity as number, total_price: Number(s.surcharge) }))
      if (surTiers.length > 0) optionSurcharge = cardTotalForQuantity(surTiers, quantity) ?? 0
    }

    const priced = computeOrderTotal({
      tiers,
      quantity,
      perExtraNameSurcharge: perExtraName,
      namesCount,
      personalisation,
      optionSurcharge,
      shipping: 0,
    })
    if (!priced.ok) {
      return json({ error: 'Couldn’t price this quantity — check it’s within the material’s price tiers.' }, 422)
    }
    amountCards = round2(priced.cards + priced.finish)
    amountTooling = priced.splitName
    amountPersonalisation = priced.personalisation
  }

  const amountShipping = shipping === 'manual' ? round2(Number(shippingCharged ?? 0)) : 0
  const cardsBase = customQuoteTotal != null ? customQuoteTotal : amountCards
  const amountCardDiscount = resolveCardDiscount(
    order.card_discount_type as string | null,
    order.card_discount_value == null ? null : Number(order.card_discount_value),
    cardsBase,
  )

  // ── Flip the order to paid / offline, in place ──────────────────
  // Conditional on status still 'sent' so a double-submit (or a race with the
  // customer actually paying online) can't double-process: the second update
  // matches zero rows and we report the conflict.
  const nowIso = new Date().toISOString()
  const { data: updated, error: updErr } = await admin
    .from('orders')
    .update({
      status: 'paid',
      payment_method: 'offline',
      quantity,
      shipping_treatment: shipping,
      shipping_charged: shipping === 'manual' ? shippingCharged : null,
      // goodwill leftover (a % subsidy) is meaningless once shipping is free /
      // manual — clear it so the row stays coherent.
      shipping_discount_percent: null,
      amount_cards: amountCards,
      amount_tooling: amountTooling,
      amount_personalisation: amountPersonalisation,
      amount_shipping: amountShipping,
      amount_card_discount: amountCardDiscount,
      paid_at: nowIso,
      updated_at: nowIso,
    })
    .eq('id', orderId)
    .eq('status', 'sent')
    .select('id, payment_reference')
    .maybeSingle()
  if (updErr) return json({ error: `Order update failed: ${updErr.message}` }, 500)
  if (!updated) {
    return json({ error: 'Order is no longer awaiting payment — it may have just been paid or cancelled.' }, 409)
  }

  const total = round2(amountCards + amountTooling + amountPersonalisation + amountShipping - amountCardDiscount)

  // ── Audit (caller-attributed) ───────────────────────────────────
  await logAudit(admin, {
    actorId: callerId,
    actorEmail: callerEmail,
    actorLabel: callerLabel,
    action: 'order.offline_payment_recorded',
    targetType: 'order',
    targetId: orderId,
    targetLabel: `Order ${order.payment_reference ?? orderId}`,
    beforeValue: { status: 'sent', payment_method: order.payment_method ?? 'online' },
    afterValue: {
      status: 'paid',
      payment_method: 'offline',
      quantity,
      shipping_treatment: shipping,
      shipping_charged: amountShipping,
      total,
    },
  })

  return json({ ok: true, status: 'paid', total, currency })
})
