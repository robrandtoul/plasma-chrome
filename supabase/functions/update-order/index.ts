// update-order — designer-only. Edits the spec of an UNPAID, live order link
// in place, so a customer who changed their mind (e.g. 500µm → 800µm) keeps the
// SAME pay link and gets no cancellation email. The sibling to create-order;
// see docs/ordering-checkout-spec.md.
//
// Only a 'sent' production order is editable: an offline order is created
// already 'paid' (so never 'sent'), and a paid/cancelled/expired/revision order
// must go through the order-lifecycle revision flow, not an edit. The update is
// CONDITIONAL on status='sent' so a customer paying mid-edit can never have a
// paid order clobbered (the flip lands zero rows → 409).
//
// Pricing is NOT recomputed here. An online order's price is computed
// SERVER-SIDE at pay time by create-checkout-session, which reads the order row
// fresh and builds a NEW Stripe PaymentIntent every time it runs — so once the
// customer (re)opens the link, changing material_variant_id / quantity here
// flows straight through to the charge. We clear the stamped amount_* breakdown
// so the Orders card + the invoice path fall back to recompute rather than show
// a figure for the superseded spec.
//
// KNOWN GAP (see docs / PR): if the customer ALREADY has the pay page open and
// pays without reopening, they confirm the PaymentIntent that page already built
// for the OLD spec, so the old amount is charged + invoiced while the order row
// carries the new spec. This bites only the orders whose pay page builds the
// intent on load (locked quantity, free/manual shipping, non-US) — a full_cost /
// goodwill order builds its intent on the Pay click, so it always reflects the
// latest edit. The mitigation is procedural: the edit's success screen tells the
// designer to ask the customer to reopen the link before paying. A bulletproof
// fix (store + cancel the live PaymentIntent on edit) is a deliberate follow-up
// because it touches the live checkout path + needs a new column.
//
// Editable: material_variant_id (thickness), material_option_id (finish),
// quantity (+ per-person split), custom_quote_total (custom orders), and the
// per-order card discount. Everything else — currency, payment method, shipping
// treatment, Xero binding, order kind, personalisation, names count — is kept
// from the existing row (shipping recomputes from the new variant's weight at
// checkout under the unchanged treatment).
//
// Auth: requireDesigner (admin or designer; anon/customers rejected). Deploy via
// the supabase CLI (`supabase functions deploy update-order --project-ref
// bjvinrzbdrwebylkmbwy`) so the _shared imports bundle, exactly as create-order.

import { json, requireDesigner } from '../_shared/admin.ts'
import { logAudit } from '../_shared/audit.ts'
import { buildOrderSpecSnapshot } from '../_shared/orderSpecSnapshot.ts'

type CardDiscountType = 'none' | 'percent' | 'fixed'
const CARD_DISCOUNT_TYPES: CardDiscountType[] = ['none', 'percent', 'fixed']

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

  const orderId = typeof body.order_id === 'string' ? body.order_id.trim() : ''
  if (!orderId) return json({ error: 'order_id is required' }, 400)

  // ── Load the order (guards + kind detection + snapshot rebuild inputs) ──
  const { data: order, error: orderErr } = await admin
    .from('orders')
    .select('id, proof_id, status, order_kind, currency, custom_quote_total, material_variant_id, quantity, names_count, has_personalisation, payment_reference')
    .eq('id', orderId)
    .maybeSingle()
  if (orderErr) return json({ error: `Order lookup failed: ${orderErr.message}` }, 500)
  if (!order) return json({ error: 'Order not found' }, 404)

  if (order.status !== 'sent') {
    return json({ error: `Order is '${order.status}', so it can no longer be edited (it may have been paid or cancelled).` }, 409)
  }
  // Prototype + reprint orders carry server-resolved pricing of their own;
  // editing them through this generic path would corrupt that. (A reprint is
  // always offline/paid anyway, so it's never 'sent'.)
  const orderKind = (order.order_kind as string | null) ?? 'production'
  if (orderKind !== 'production') {
    return json({ error: `A ${orderKind} order can’t be edited here.` }, 409)
  }

  const currency = order.currency as string
  const existingIsCustom = order.custom_quote_total != null

  // ── Validate the editable fields ────────────────────────────────────────
  // material_variant_id — the chosen thickness/option the price tiers key on.
  const materialVariantId =
    typeof body.material_variant_id === 'string' && body.material_variant_id.trim()
      ? body.material_variant_id.trim()
      : null
  // A grid order MUST keep a variant (it's what create-checkout-session prices
  // from). A custom-quote order may legitimately have none.
  if (!existingIsCustom && !materialVariantId) {
    return json({ error: 'A grid-priced order needs a variant to price against.' }, 400)
  }

  const materialOptionId =
    typeof body.material_option_id === 'string' && body.material_option_id.trim()
      ? body.material_option_id.trim()
      : null

  // quantity: null = customer chooses on the pay-page; a positive integer =
  // locked. A per-person split (when present) is authoritative — quantity is its
  // sum — so production knows how many of each name to make.
  let personQuantities: { name: string; quantity: number }[] | null = null
  if (Array.isArray(body.person_quantities)) {
    const pq = (body.person_quantities as unknown[])
      .map((p) =>
        p && typeof p === 'object'
          ? { name: String((p as Record<string, unknown>).name ?? ''), quantity: Number((p as Record<string, unknown>).quantity) }
          : null,
      )
      .filter((p): p is { name: string; quantity: number } => p != null && p.name !== '' && Number.isInteger(p.quantity) && p.quantity > 0)
    if (pq.length > 0) personQuantities = pq
  }

  let quantity: number | null = null
  if (personQuantities) {
    quantity = personQuantities.reduce((acc, p) => acc + p.quantity, 0)
  } else if (body.quantity != null) {
    const q = Number(body.quantity)
    if (!Number.isInteger(q) || q <= 0) return json({ error: 'quantity must be a positive integer' }, 400)
    quantity = q
  }

  // custom_quote_total — kept on custom orders, forced null on grid orders so an
  // edit can never silently flip a grid order into a custom-quote one.
  let customQuoteTotal: number | null = null
  if (existingIsCustom) {
    if (body.custom_quote_total == null) return json({ error: 'This is a custom-quote order — enter the agreed total.' }, 400)
    const c = Number(body.custom_quote_total)
    if (!Number.isFinite(c) || c < 0) return json({ error: 'custom_quote_total must be zero or greater' }, 400)
    customQuoteTotal = Math.round(c * 100) / 100
  }

  // card_discount — the per-order discount on the CARDS line. The resolved
  // amount is recomputed + stamped at checkout against the (possibly new) priced
  // cards figure; here we only persist the rule.
  const cardDiscountType = (body.card_discount_type as CardDiscountType) ?? 'none'
  if (!CARD_DISCOUNT_TYPES.includes(cardDiscountType)) {
    return json({ error: 'Invalid card_discount_type' }, 400)
  }
  let cardDiscountValue: number | null = null
  if (cardDiscountType !== 'none') {
    const v = Number(body.card_discount_value)
    if (!Number.isFinite(v) || v <= 0) return json({ error: 'card_discount_value must be greater than zero for a card discount' }, 400)
    if (cardDiscountType === 'percent' && v > 100) {
      return json({ error: 'card_discount_value must be between 0 and 100 for a percent discount' }, 400)
    }
    cardDiscountValue = Math.round(v * 100) / 100
  }
  const cardDiscountReason =
    typeof body.card_discount_reason === 'string' && body.card_discount_reason.trim()
      ? body.card_discount_reason.trim().slice(0, 255)
      : null

  // ── Rebuild the durable spec snapshot for the new spec ──────────────────
  // Same shape + reads as create-order's snapshot block, so the admin order log
  // reads back the edited spec rather than the original. Best-effort: a read
  // miss leaves the existing snapshot untouched and the log falls back to the
  // live join, so a snapshot failure must never block the edit.
  const nowIso = new Date().toISOString()
  let orderSpecSnapshot: ReturnType<typeof buildOrderSpecSnapshot> | null = null
  try {
    const [pvRes, contactRes, variantRes, optionRes] = await Promise.all([
      admin
        .from('proof_versions')
        .select('material_display, ink_names, front_colour_id, core_colour_id, back_colour_id, materials(code, display_name)')
        .eq('proof_id', order.proof_id)
        .eq('is_current', true)
        .maybeSingle(),
      admin
        .from('proofs')
        .select('contacts:contact_id ( full_name, email, companies:company_id ( name ) )')
        .eq('id', order.proof_id)
        .maybeSingle(),
      materialVariantId
        ? admin.from('material_variants').select('display_name, variant_type').eq('id', materialVariantId).maybeSingle()
        : Promise.resolve({ data: null }),
      materialOptionId
        ? admin.from('material_options').select('display_name').eq('id', materialOptionId).maybeSingle()
        : Promise.resolve({ data: null }),
    ])

    const pv = pvRes.data as {
      material_display?: string | null
      ink_names?: string[] | null
      front_colour_id?: string | null
      core_colour_id?: string | null
      back_colour_id?: string | null
      materials?: { code?: string | null; display_name?: string | null } | null
    } | null
    const contact = (contactRes.data as { contacts?: { full_name?: string | null; email?: string | null; companies?: { name?: string | null } | null } | null } | null)?.contacts ?? null
    const variant = variantRes.data as { display_name?: string | null; variant_type?: string | null } | null
    const option = optionRes.data as { display_name?: string | null } | null

    let lpFront: string | null = null, lpCore: string | null = null, lpBack: string | null = null
    const colourIds = [pv?.front_colour_id, pv?.core_colour_id, pv?.back_colour_id].filter(Boolean) as string[]
    if (colourIds.length) {
      const { data: cols } = await admin.from('letterpress_core_colours').select('id, name').in('id', colourIds)
      const byId = new Map((cols ?? []).map((c: { id: string; name: string }) => [c.id, c.name]))
      lpFront = (pv?.front_colour_id && byId.get(pv.front_colour_id)) || null
      lpCore = (pv?.core_colour_id && byId.get(pv.core_colour_id)) || null
      lpBack = (pv?.back_colour_id && byId.get(pv.back_colour_id)) || null
    }

    orderSpecSnapshot = buildOrderSpecSnapshot({
      materialCode: pv?.materials?.code ?? null,
      materialDisplay: pv?.materials?.display_name ?? pv?.material_display ?? null,
      variantDisplay: variant?.display_name ?? null,
      variantType: variant?.variant_type ?? null,
      optionDisplay: option?.display_name ?? null,
      inkNames: pv?.ink_names ?? null,
      letterpressFront: lpFront,
      letterpressCore: lpCore,
      letterpressBack: lpBack,
      quantity,
      personQuantities,
      hasPersonalisation: order.has_personalisation === true,
      customQuoteTotal,
      contactEmail: contact?.email ?? null,
      contactName: contact?.full_name ?? null,
      companyName: contact?.companies?.name ?? null,
      stage: 'edit',
      capturedBy: callerId,
      capturedAt: nowIso,
    })
  } catch {
    orderSpecSnapshot = null
  }

  // ── Conditional update (guards against editing a just-paid order) ────────
  // Clear the stamped amount_* breakdown + the US-tariff opt-out so the next
  // pay-page visit recomputes cleanly for the new spec (an online 'sent' order's
  // natural state is amount_* = null until a Pay click stamps them).
  const patch: Record<string, unknown> = {
    material_variant_id: materialVariantId,
    material_option_id: materialOptionId,
    quantity,
    person_quantities: personQuantities,
    custom_quote_total: customQuoteTotal,
    card_discount_type: cardDiscountType,
    card_discount_value: cardDiscountValue,
    card_discount_reason: cardDiscountReason,
    amount_cards: null,
    amount_tooling: null,
    amount_personalisation: null,
    amount_shipping: null,
    amount_us_tariff: null,
    amount_card_discount: null,
    us_tariff_opted_out: false,
    updated_at: nowIso,
    ...(orderSpecSnapshot ? { order_spec_snapshot: orderSpecSnapshot } : {}),
  }

  const { data: updated, error: updErr } = await admin
    .from('orders')
    .update(patch)
    .eq('id', orderId)
    .eq('status', 'sent')
    .select('id')
    .maybeSingle()
  if (updErr) return json({ error: `Order update failed: ${updErr.message}` }, 500)
  if (!updated) {
    return json({ error: 'Order is no longer editable (it may have just been paid or cancelled).' }, 409)
  }

  await logAudit(admin, {
    actorId: callerId,
    actorEmail: callerEmail,
    actorLabel: callerLabel,
    action: 'order.updated',
    targetType: 'order',
    targetId: orderId,
    targetLabel: `Order ${order.payment_reference ?? orderId}`,
    beforeValue: {
      material_variant_id: order.material_variant_id,
      quantity: order.quantity,
      custom_quote_total: order.custom_quote_total,
    },
    afterValue: {
      material_variant_id: materialVariantId,
      material_option_id: materialOptionId,
      quantity,
      person_quantities: personQuantities,
      custom_quote_total: customQuoteTotal,
      card_discount_type: cardDiscountType,
      card_discount_value: cardDiscountValue,
      card_discount_reason: cardDiscountReason,
    },
  })

  return json({ ok: true, id: orderId, currency })
})
