// order-group — designer-only. Manages combined-payment groups over existing
// orders (bundle orders Slice 2, docs/bundle-orders-spec.md §13 + the design
// note docs/order-groups-slice2.md). Three actions:
//
//   create   — put N existing orders into ONE payment group and mint its pay
//              link. The group owns the money (one token, one GRP- payment
//              reference, combined shipping billing); each order keeps its own
//              production/fulfilment life.
//   release  — take one order back out of a still-unpaid group (the "release a
//              ready card early" decision, spec §7.1). The order becomes a
//              normal standalone order again with its own live pay link → its
//              own payment → its own invoice.
//   dissolve — unwind a still-unpaid group entirely; members go back to
//              standalone, the group is marked cancelled.
//
// Grouping conditions enforced here (spec §7/§13): every order awaiting
// payment ('sent'), online, not already grouped, ONE currency across the
// group, every proof still approved, and every member PRICEABLE — quantity
// set, or left open for the customer (open thickness/finish/quantity members
// are welcome; the group pay page runs the same guided choosers as a
// single-order link), or a custom quote with an agreed total. One payer
// and one delivery address are the designer's call, confirmed in the modal —
// the machine can't know who will pay.
//
// Auth: requireDesigner. Writes via the service-role client; attach is a
// single conditional UPDATE so a partial group can't be half-created (any
// mismatch rolls the group back).

import { json, requireDesigner } from '../_shared/admin.ts'
import { logAudit } from '../_shared/audit.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

type ShippingTreatment = 'full_cost' | 'goodwill' | 'free' | 'manual'
const SHIPPING_TREATMENTS: ShippingTreatment[] = ['full_cost', 'goodwill', 'free', 'manual']

// Same expiry window as create-order — the group link is a fresh send.
const ORDER_EXPIRY_DAYS = 14

// URL-safe random token for the group pay-page bearer (mirror of create-order).
function randomToken(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

// Group payment reference: GRP- prefix (single orders use ORD-) so a combined
// payment is instantly recognisable in Xero and on the bank feed. Stamped on
// the Stripe payment AND the invoice — the 1:1 reconciliation spine.
function paymentReference(): string {
  const bytes = new Uint8Array(5)
  crypto.getRandomValues(bytes)
  const suffix = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase()
  return `GRP-${suffix}`
}

interface MemberRow {
  id: string
  status: string
  payment_method: string | null
  order_group_id: string | null
  currency: string
  thickness_open: boolean
  finish_open: boolean
  quantity_open: boolean
  quantity: number | null
  custom_quote_total: number | null
  proof_id: string
  payment_reference: string | null
  ship_dest_country: string | null
  vat_treatment: string | null
  xero_contact_id: string | null
  xero_contact_name: string | null
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
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

  const action = typeof body.action === 'string' ? body.action : null

  // ── create ─────────────────────────────────────────────────────────
  if (action === 'create') {
    const orderIds = Array.isArray(body.order_ids)
      ? (body.order_ids as unknown[]).filter((x): x is string => typeof x === 'string')
      : []
    const uniqueIds = [...new Set(orderIds)]
    if (uniqueIds.length < 2) {
      return json({ error: 'Pick at least two orders to combine into one payment.' }, 400)
    }

    // Group-level combined-shipping BILLING (spec §8 default: one combined
    // consignment billed once). Same vocabulary + validation as create-order.
    const shippingTreatment = (body.shipping_treatment as ShippingTreatment) ?? 'full_cost'
    if (!SHIPPING_TREATMENTS.includes(shippingTreatment)) {
      return json({ error: 'Invalid shipping_treatment' }, 400)
    }
    let shippingCharged: number | null = null
    if (body.shipping_charged != null) {
      const s = Number(body.shipping_charged)
      if (!Number.isFinite(s) || s < 0) return json({ error: 'shipping_charged must be zero or greater' }, 400)
      shippingCharged = Math.round(s * 100) / 100
    }
    if (shippingTreatment === 'manual' && shippingCharged == null) {
      return json({ error: 'shipping_charged is required for the manual treatment' }, 400)
    }
    let shippingDiscountPercent: number | null = null
    if (shippingTreatment === 'goodwill') {
      const d = Number(body.shipping_discount_percent)
      if (!Number.isFinite(d) || d < 0 || d > 100) {
        return json({ error: 'shipping_discount_percent (0–100) is required for the goodwill treatment' }, 400)
      }
      shippingDiscountPercent = Math.round(d * 100) / 100
    }

    // Optional destination hint (the customer confirms + adds the postcode on
    // the group pay page, exactly like single orders).
    let shipDestCountry: string | null = null
    if (typeof body.ship_dest_country === 'string' && body.ship_dest_country.trim()) {
      const c = body.ship_dest_country.trim().toUpperCase()
      if (!/^[A-Z]{2}$/.test(c)) return json({ error: 'ship_dest_country must be a 2-letter ISO code' }, 400)
      shipDestCountry = c
    }

    const { data: memberRows, error: memberErr } = await admin
      .from('orders')
      .select('id, status, payment_method, order_group_id, currency, thickness_open, finish_open, quantity_open, quantity, custom_quote_total, proof_id, payment_reference, ship_dest_country, vat_treatment, xero_contact_id, xero_contact_name')
      .in('id', uniqueIds)
    if (memberErr) return json({ error: `Could not read the orders: ${memberErr.message}` }, 500)
    const members = (memberRows ?? []) as MemberRow[]
    if (members.length !== uniqueIds.length) {
      return json({ error: 'One or more of the selected orders was not found.' }, 404)
    }

    // Human-readable refusal per condition, naming the offending order so the
    // designer can fix it (Rob is a non-coder — errors must say what to do).
    for (const m of members) {
      const ref = m.payment_reference ?? m.id
      if (m.status !== 'sent') {
        return json({ error: `Order ${ref} isn’t awaiting payment (it’s ${m.status}), so it can’t join a payment group.` }, 409)
      }
      if (m.payment_method !== 'online') {
        return json({ error: `Order ${ref} is an offline (bank-transfer) order — only online orders can share a pay link.` }, 409)
      }
      if (m.order_group_id != null) {
        return json({ error: `Order ${ref} is already in a payment group. Release it first if you want to regroup it.` }, 409)
      }
      // Open-spec members (thickness_open / finish_open / quantity_open) are
      // welcome — the group pay page runs the same guided choosers as a
      // single-order link, and checkout prices + persists each pick. The only
      // unpriceable case left is an order with no quantity, no open-quantity
      // flag and no custom-quote total: nothing to price against.
      if (m.quantity == null && !m.quantity_open && m.custom_quote_total == null) {
        return json({
          error: `Order ${ref} has no quantity and no custom-quote total, so it can’t be priced. Set a quantity on the order (or leave it open for the customer) first.`,
        }, 409)
      }
    }
    const currencies = [...new Set(members.map((m) => m.currency))]
    if (currencies.length > 1) {
      return json({ error: `These orders use different currencies (${currencies.join(', ')}). A combined payment needs one currency — see the split rules.` }, 409)
    }
    const currency = currencies[0]

    // Every member's proof must still be approved (an order outlives a reopen).
    const proofIds = [...new Set(members.map((m) => m.proof_id))]
    const { data: proofRows } = await admin
      .from('proofs')
      .select('id, status')
      .in('id', proofIds)
    const notApproved = (proofRows ?? []).filter((p) => p.status !== 'approved')
    if (notApproved.length > 0 || (proofRows ?? []).length !== proofIds.length) {
      return json({ error: 'Every project in a combined payment must still be approved.' }, 409)
    }

    // Destination hint: explicit body value wins; otherwise adopt the members'
    // hint only when they unanimously agree (a mixed bag means the designer
    // needs to say where the ONE parcel is going).
    if (!shipDestCountry) {
      const hints = [...new Set(members.map((m) => m.ship_dest_country).filter((c): c is string => !!c))]
      if (hints.length === 1) shipDestCountry = hints[0]
    }

    // VAT treatment (000316): adopt the members' choice when they unanimously
    // agree on a non-default override; a mixed bag (or all 'auto') falls back
    // to 'auto', which lets the group's single destination decide. So a set of
    // orders the designer already forced to 'export' stays zero-rated once
    // combined, instead of silently losing the override at group level.
    const memberTreatments = [...new Set(members.map((m) => m.vat_treatment ?? 'auto'))]
    const groupVatTreatment = memberTreatments.length === 1 && memberTreatments[0] !== 'auto'
      ? memberTreatments[0]
      : 'auto'

    // Xero contact binding: adopt the members' choice when they unanimously
    // agree on an existing contact; otherwise leave unbound (the webhook lets
    // Xero create the contact from the payer, exactly like a single order).
    const contactIds = [...new Set(members.map((m) => m.xero_contact_id).filter((c): c is string => !!c))]
    const xeroContactId = contactIds.length === 1 && members.every((m) => m.xero_contact_id === contactIds[0])
      ? contactIds[0]
      : null
    const xeroContactName = xeroContactId
      ? (members.find((m) => m.xero_contact_id === xeroContactId)?.xero_contact_name ?? null)
      : (() => {
          // New-customer path: adopt the designer-entered name when unanimous.
          const names = [...new Set(members.map((m) => m.xero_contact_name).filter((n): n is string => !!n))]
          return names.length === 1 ? names[0] : null
        })()

    const nowIso = new Date().toISOString()
    const token = randomToken()
    const payment_reference = paymentReference()
    const expiresAt = new Date(Date.now() + ORDER_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString()

    const { data: group, error: insertErr } = await admin
      .from('order_groups')
      .insert({
        status: 'sent',
        currency,
        shipping_treatment: shippingTreatment,
        shipping_charged: shippingCharged,
        shipping_discount_percent: shippingDiscountPercent,
        ship_dest_country: shipDestCountry,
        vat_treatment: groupVatTreatment,
        xero_contact_id: xeroContactId,
        xero_contact_name: xeroContactName,
        token,
        payment_reference,
        expires_at: expiresAt,
        created_by: callerId,
        sent_at: nowIso,
      })
      .select('id, token, payment_reference, expires_at')
      .single()
    if (insertErr || !group) {
      return json({ error: `Could not create the payment group: ${insertErr?.message ?? 'unknown error'}` }, 500)
    }

    // Attach every member in ONE conditional update — the WHERE re-checks the
    // joinability conditions, so a race (an order paid or grouped between our
    // read and now) attaches fewer rows than asked and we roll the group back
    // rather than leave a half-built group.
    const { data: attached, error: attachErr } = await admin
      .from('orders')
      .update({ order_group_id: group.id, updated_at: nowIso })
      .in('id', uniqueIds)
      .eq('status', 'sent')
      .eq('payment_method', 'online')
      .is('order_group_id', null)
      .eq('currency', currency)
      .select('id')
    if (attachErr || (attached ?? []).length !== uniqueIds.length) {
      await admin.from('orders').update({ order_group_id: null }).eq('order_group_id', group.id)
      await admin.from('order_groups').delete().eq('id', group.id)
      return json({ error: 'One of the orders changed while the group was being created — nothing was grouped. Refresh and try again.' }, 409)
    }

    await logAudit(admin, {
      actorId: callerId,
      actorEmail: callerEmail,
      actorLabel: callerLabel,
      action: 'order_group.created',
      targetType: 'order_group',
      targetId: group.id,
      targetLabel: `Payment group ${payment_reference} (${uniqueIds.length} orders)`,
      afterValue: {
        order_ids: uniqueIds,
        currency,
        shipping_treatment: shippingTreatment,
        shipping_charged: shippingCharged,
        shipping_discount_percent: shippingDiscountPercent,
        ship_dest_country: shipDestCountry,
        vat_treatment: groupVatTreatment,
        xero_contact_id: xeroContactId,
        xero_contact_name: xeroContactName,
      },
    })

    return json({
      id: group.id,
      token: group.token,
      payment_reference: group.payment_reference,
      expires_at: group.expires_at,
    })
  }

  // ── release ────────────────────────────────────────────────────────
  // Take one order out of a still-unpaid group. Its own pay link becomes the
  // live one again; if that link had lapsed while grouped, extend it so
  // "release early → send its own link" works without a second step.
  if (action === 'release') {
    const groupId = typeof body.group_id === 'string' ? body.group_id : null
    const orderId = typeof body.order_id === 'string' ? body.order_id : null
    if (!groupId || !orderId) return json({ error: 'Missing group_id or order_id' }, 400)

    const { data: group } = await admin
      .from('order_groups')
      .select('id, status, payment_reference')
      .eq('id', groupId)
      .maybeSingle()
    if (!group) return json({ error: 'Payment group not found' }, 404)
    if (group.status !== 'sent') {
      return json({ error: `This payment group is ${group.status} — only an unpaid group can be changed.` }, 409)
    }

    const nowIso = new Date().toISOString()
    const { data: released } = await admin
      .from('orders')
      .update({ order_group_id: null, updated_at: nowIso })
      .eq('id', orderId)
      .eq('order_group_id', groupId)
      .select('id, expires_at, payment_reference')
    const releasedRow = (released ?? [])[0] as { id: string; expires_at: string | null; payment_reference: string | null } | undefined
    if (!releasedRow) return json({ error: 'That order isn’t in this payment group.' }, 404)

    // Re-liven the standalone pay link if it lapsed while grouped.
    if (releasedRow.expires_at && new Date(releasedRow.expires_at).getTime() < Date.now()) {
      const newExpiry = new Date(Date.now() + ORDER_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString()
      await admin.from('orders').update({ expires_at: newExpiry, updated_at: nowIso }).eq('id', orderId)
    }

    // A group emptied by releases has nothing left to pay — cancel it.
    const { count } = await admin
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('order_group_id', groupId)
    const remaining = count ?? 0
    if (remaining === 0) {
      await admin.from('order_groups').update({ status: 'cancelled', updated_at: nowIso }).eq('id', groupId).eq('status', 'sent')
    }

    await logAudit(admin, {
      actorId: callerId,
      actorEmail: callerEmail,
      actorLabel: callerLabel,
      action: 'order_group.released',
      targetType: 'order_group',
      targetId: groupId,
      targetLabel: `Payment group ${group.payment_reference}`,
      afterValue: { order_id: orderId, order_reference: releasedRow.payment_reference, remaining },
    })

    return json({ ok: true, remaining })
  }

  // ── dissolve ───────────────────────────────────────────────────────
  // Unwind a still-unpaid group: every member back to standalone, group
  // cancelled. Member links keep their own expiry (reactivate individually
  // if needed — dissolving returns to exactly the pre-group state).
  if (action === 'dissolve') {
    const groupId = typeof body.group_id === 'string' ? body.group_id : null
    if (!groupId) return json({ error: 'Missing group_id' }, 400)

    const { data: group } = await admin
      .from('order_groups')
      .select('id, status, payment_reference')
      .eq('id', groupId)
      .maybeSingle()
    if (!group) return json({ error: 'Payment group not found' }, 404)
    if (group.status !== 'sent') {
      return json({ error: `This payment group is ${group.status} — only an unpaid group can be dissolved.` }, 409)
    }

    const nowIso = new Date().toISOString()
    const { data: detached } = await admin
      .from('orders')
      .update({ order_group_id: null, updated_at: nowIso })
      .eq('order_group_id', groupId)
      .select('id')
    await admin.from('order_groups').update({ status: 'cancelled', updated_at: nowIso }).eq('id', groupId).eq('status', 'sent')

    await logAudit(admin, {
      actorId: callerId,
      actorEmail: callerEmail,
      actorLabel: callerLabel,
      action: 'order_group.dissolved',
      targetType: 'order_group',
      targetId: groupId,
      targetLabel: `Payment group ${group.payment_reference}`,
      afterValue: { released_order_ids: (detached ?? []).map((d) => d.id) },
    })

    return json({ ok: true, released: (detached ?? []).length })
  }

  return json({ error: 'Unknown action — use create, release or dissolve.' }, 400)
})
