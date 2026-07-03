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
// Writes go through the service-role client. The order is normally created
// 'sent' (the pay-link is live) with the caller stamped as created_by.
//
// Offline payment (payment_method='offline'): for a customer paying by bank
// transfer etc., the order is created already 'paid' — no pay link, no Stripe,
// no Xero (the designer raises the invoice themselves). The price breakdown is
// computed + stamped here (so the To-order queue + records have a total) using
// the SAME shared pricing maths the online checkout uses. Offline requires a
// fixed quantity and free/manual shipping (live rates need the online pay page).

import { json, requireDesigner } from '../_shared/admin.ts'
import { logAudit } from '../_shared/audit.ts'
import { cardTotalForQuantity, computeOrderTotal, resolveCardDiscount, pricesFlatAboveTopTier, type Tier } from '../_shared/orderPricing.ts'
import { buildOrderSpecSnapshot } from '../_shared/orderSpecSnapshot.ts'

type ShippingTreatment = 'full_cost' | 'goodwill' | 'free' | 'manual'
type Currency = 'GBP' | 'EUR' | 'USD'
type CardDiscountType = 'none' | 'percent' | 'fixed'
type PaymentMethod = 'online' | 'offline'

const SHIPPING_TREATMENTS: ShippingTreatment[] = ['full_cost', 'goodwill', 'free', 'manual']
const CURRENCIES: Currency[] = ['GBP', 'EUR', 'USD']
const CARD_DISCOUNT_TYPES: CardDiscountType[] = ['none', 'percent', 'fixed']

function splitNameForCurrency(
  m: { split_name_surcharge_gbp: number | null; split_name_surcharge_eur: number | null; split_name_surcharge_usd: number | null } | null,
  currency: string,
): number | null {
  if (!m) return null
  const v = currency === 'GBP' ? m.split_name_surcharge_gbp : currency === 'EUR' ? m.split_name_surcharge_eur : m.split_name_surcharge_usd
  return v == null ? null : Number(v)
}

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

  let currency = body.currency as Currency
  if (!CURRENCIES.includes(currency)) {
    return json({ error: 'Missing or invalid currency' }, 400)
  }

  let shippingTreatment = (body.shipping_treatment as ShippingTreatment) ?? 'full_cost'
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

  let namesCount = (() => {
    const n = Number(body.names_count ?? 1)
    return Number.isInteger(n) && n >= 1 ? n : 1
  })()

  // Per-person quantity split (production instruction) for a locked split-name
  // order. Each entry's quantity must be a positive integer; the designer enters
  // these in the order builder and we persist them so production knows how many
  // each named person gets. Open orders capture this from the customer instead.
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

  let hasPersonalisation = body.has_personalisation === true

  // material_variant_id is optional in v1 — the pay-page (Step 4)
  // resolves the precise variant/price. Pass through when supplied. A reprint
  // inherits the original order's variant (set in the reprint block below).
  let materialVariantId = typeof body.material_variant_id === 'string' ? body.material_variant_id : null

  // Chosen material option — e.g. metal finish (Natural/Brushed/Mirror). The
  // checkout applies the matching option surcharge; null = base / no finish.
  let materialOptionId = typeof body.material_option_id === 'string' ? body.material_option_id : null

  // Open-spec orders (000298): the designer leaves thickness and/or finish for
  // the customer to choose on the pay page, with guided copy + live prices —
  // instead of settling them by email after approval. thickness_open rides with
  // a null material_variant_id; finish_open is an explicit flag because a null
  // material_option_id already means "base / no finish". Both are online-only
  // production-order concepts (offline orders never reach the pay page;
  // prototypes/reprints carry a fixed variant) — validated below once the
  // order kind + payment method are resolved. material_id is stamped on EVERY
  // order: derived from the variant when one is locked (so old clients that
  // don't send it stay correct), else taken from the body for open-spec.
  let thicknessOpen = body.thickness_open === true
  let finishOpen = body.finish_open === true
  const bodyMaterialId = typeof body.material_id === 'string' ? body.material_id : null

  // Chosen Xero customer — the EXISTING Xero contact this order's invoice should
  // file under, so paid invoices consolidate under the customer's Xero record
  // (rather than spawning a fresh contact from the payer). Designer-picked in
  // the Create order modal via the xero-search-contacts typeahead. Null = no
  // pick / a new customer, in which case stripe-webhook lets Xero create the
  // contact and writes its ContactID back onto the order for next time. The name
  // is denormalised for the Orders log + the modal pre-fill. Online only; an
  // offline order is invoiced manually in Xero, so this is irrelevant there.
  const xeroContactId =
    typeof body.xero_contact_id === 'string' && body.xero_contact_id.trim()
      ? body.xero_contact_id.trim()
      : null
  const xeroContactName =
    typeof body.xero_contact_name === 'string' && body.xero_contact_name.trim()
      ? body.xero_contact_name.trim().slice(0, 255)
      : null

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

  // card_discount — the per-order discount on the CARDS line (mirrors the
  // shipping subsidy). type none/percent/fixed; value required for the two
  // active types (percent 0–100, fixed >= 0); reason is an optional audit note.
  // The actual discount amount is resolved + stamped at checkout against the
  // priced cards figure (create-checkout-session), not here.
  const cardDiscountType = (body.card_discount_type as CardDiscountType) ?? 'none'
  if (!CARD_DISCOUNT_TYPES.includes(cardDiscountType)) {
    return json({ error: 'Invalid card_discount_type' }, 400)
  }
  let cardDiscountValue: number | null = null
  if (cardDiscountType !== 'none') {
    const v = Number(body.card_discount_value)
    if (!Number.isFinite(v) || v <= 0) {
      return json({ error: 'card_discount_value must be greater than zero for a card discount' }, 400)
    }
    if (cardDiscountType === 'percent' && v > 100) {
      return json({ error: 'card_discount_value must be between 0 and 100 for a percent discount' }, 400)
    }
    cardDiscountValue = Math.round(v * 100) / 100
  }
  const cardDiscountReason =
    typeof body.card_discount_reason === 'string' && body.card_discount_reason.trim()
      ? body.card_discount_reason.trim().slice(0, 255)
      : null

  let customQuoteTotal: number | null = null
  if (body.custom_quote_total != null) {
    const c = Number(body.custom_quote_total)
    if (!Number.isFinite(c) || c < 0) return json({ error: 'custom_quote_total must be zero or greater' }, 400)
    customQuoteTotal = Math.round(c * 100) / 100
  }

  // ── Prototype service (000287) ──────────────────────────────────
  // A prototype is the flat per-material-family prototyping fee (up to three
  // exact copies of the approved design), NOT a grid-priced order. We model it
  // as a custom-quote order that KEEPS its material_variant_id, so the existing
  // Xero item-code resolution books it to the right material (Rob's call: reuse
  // the material's own codes). The fee is resolved here from prototype_prices —
  // server-authoritative, never trusted from the client — and overrides
  // custom_quote_total. quantity carries the copies (1–3): it drives shipping
  // weight + the production instruction, but the fee is flat regardless.
  const orderKind: 'production' | 'prototype' | 'reprint' =
    body.order_kind === 'prototype' ? 'prototype' : body.order_kind === 'reprint' ? 'reprint' : 'production'
  if (orderKind === 'prototype') {
    if (quantity == null || quantity < 1 || quantity > 3) {
      return json({ error: 'A prototype order needs a copies count between 1 and 3.' }, 400)
    }
    if (!materialVariantId) {
      return json({ error: 'A prototype order needs a material variant (for the invoice item code and shipping weight).' }, 400)
    }
    const { data: variantRow } = await admin
      .from('material_variants')
      .select('materials(category)')
      .eq('id', materialVariantId)
      .single()
    const family = (variantRow?.materials as { category?: string } | null)?.category ?? null
    if (!family) {
      return json({ error: 'Could not resolve the material family for this prototype.' }, 422)
    }
    // A family is orderable only when there's an active, priced row for this
    // currency (paper / plastic ship inactive until an admin sets a price).
    const { data: feeRow } = await admin
      .from('prototype_prices')
      .select('amount, is_active')
      .eq('family', family)
      .eq('currency', currency)
      .maybeSingle()
    if (!feeRow?.is_active || feeRow.amount == null) {
      return json({ error: 'Prototyping isn’t available for this material yet — set its price under Admin → Prototype prices first.' }, 422)
    }
    // Override into the custom-quote shape: the fee is the order total, and a
    // prototype is never split-name / personalised.
    customQuoteTotal = Math.round(Number(feeRow.amount) * 100) / 100
    namesCount = 1
    personQuantities = null
    hasPersonalisation = false
  }

  // ── Reprint (000295) ────────────────────────────────────────────
  // A reprint is a FREE remake after a complaint/damage, raised off an existing
  // proof. It is a NEW order on the SAME proof (the original stays an untouched
  // record), inheriting the original order's commercial spec server-side so the
  // Stock Control hand-off is complete and the client can't drift it. Forced
  // free + offline so it skips Stripe/Xero and lands 'paid' in the To-order
  // queue. reprint_of_order_id links it back to the order it replaces. quantity
  // defaults to the original's; an explicit body.quantity (e.g. only some were
  // faulty) overrides it.
  let reprintOfOrderId: string | null = null
  if (orderKind === 'reprint') {
    reprintOfOrderId = typeof body.reprint_of_order_id === 'string' ? body.reprint_of_order_id : null
    if (!reprintOfOrderId) {
      return json({ error: 'A reprint needs the original order it is replacing.' }, 400)
    }
    const { data: original } = await admin
      .from('orders')
      .select('id, proof_id, material_variant_id, material_option_id, quantity, names_count, person_quantities, has_personalisation, currency, ship_dest_country')
      .eq('id', reprintOfOrderId)
      .maybeSingle()
    if (!original || original.proof_id !== proofId) {
      return json({ error: 'The original order for this reprint was not found on this proof.' }, 404)
    }
    // Inherit the original's commercial spec (server-authoritative).
    currency = (original.currency as Currency) ?? currency
    materialVariantId = (original.material_variant_id as string | null) ?? materialVariantId
    materialOptionId = (original.material_option_id as string | null) ?? materialOptionId
    hasPersonalisation = original.has_personalisation === true
    shipDestCountry = (original.ship_dest_country as string | null) ?? shipDestCountry

    // quantity: an explicit body override is a PARTIAL reprint (only some were
    // faulty); otherwise reprint the original's full quantity.
    const originalQty = Number.isInteger(original.quantity) && (original.quantity as number) > 0 ? (original.quantity as number) : null
    const isPartial = quantity != null && quantity !== originalQty
    if (quantity == null) quantity = originalQty
    if (quantity == null) {
      return json({ error: 'A reprint needs a quantity — the original order had none recorded.' }, 422)
    }

    // A FULL reprint inherits the original's per-name split; a PARTIAL reprint is
    // a plain batch of N (the inherited split no longer sums to the new total),
    // so the designer notes whose cards in the Stock Control hand-off.
    if (isPartial) {
      namesCount = 1
      personQuantities = null
    } else {
      namesCount = Number.isInteger(original.names_count) && (original.names_count as number) >= 1 ? (original.names_count as number) : 1
      personQuantities =
        Array.isArray(original.person_quantities) && (original.person_quantities as unknown[]).length > 0
          ? (original.person_quantities as { name: string; quantity: number }[])
          : null
    }

    // FREE: zero total, free shipping. The offline path then stamps all amounts 0.
    shippingTreatment = 'free'
    customQuoteTotal = 0
  }

  // payment_method — 'online' (default; pay link) or 'offline' (bank transfer
  // etc.). Offline is created already paid, so it needs a fixed quantity and a
  // shipping figure we can settle without the online pay page (free / manual).
  // A reprint is always offline (it's free — nothing to pay).
  const paymentMethod: PaymentMethod =
    orderKind === 'reprint' ? 'offline' : body.payment_method === 'offline' ? 'offline' : 'online'
  if (paymentMethod === 'offline') {
    if (quantity == null) {
      return json({ error: 'An offline order needs a fixed quantity (the customer can’t pick one without the pay page).' }, 400)
    }
    if (shippingTreatment !== 'free' && shippingTreatment !== 'manual') {
      return json({ error: 'An offline order must use free or manual shipping — live rates need the online pay page.' }, 400)
    }
    if (customQuoteTotal == null && !materialVariantId) {
      return json({ error: 'An offline grid order needs a material variant to price the cards.' }, 400)
    }
  }

  // ── Open-spec resolution (000298) ───────────────────────────────
  // Only a plain online production grid order can leave thickness/finish open:
  // prototypes and reprints resolve their variant above, a custom quote has an
  // agreed price, and an offline order never reaches the pay page. Force the
  // flags off for those kinds rather than erroring — a stale client flag must
  // not block the classic flows.
  if (orderKind !== 'production' || paymentMethod === 'offline' || customQuoteTotal != null) {
    thicknessOpen = false
    finishOpen = false
  }
  if (thicknessOpen) {
    // The customer picks the variant later, so any variant the client sent is
    // ignored — the null column + flag are what the pay page keys off.
    materialVariantId = null
  }
  if (finishOpen) {
    materialOptionId = null
  }

  // material_id: derived from the locked variant when there is one (keeps old
  // clients + reprints/prototypes correct without sending it), else the body's
  // material for open-spec orders. An open thickness with no resolvable
  // material can't be priced or chosen on the pay page, so it's rejected.
  let materialId: string | null = null
  if (materialVariantId) {
    const { data: variantRow } = await admin
      .from('material_variants')
      .select('material_id')
      .eq('id', materialVariantId)
      .maybeSingle()
    materialId = (variantRow?.material_id as string | null) ?? null
    if (!materialId) {
      return json({ error: 'The chosen variant was not found.' }, 422)
    }
  } else if (bodyMaterialId) {
    const { data: materialRow } = await admin
      .from('materials')
      .select('id')
      .eq('id', bodyMaterialId)
      .maybeSingle()
    materialId = (materialRow?.id as string | null) ?? null
    if (!materialId) {
      return json({ error: 'The order material was not found.' }, 422)
    }
  }
  if (thicknessOpen && !materialId) {
    return json({ error: 'An order with the thickness left open needs its material (material_id).' }, 400)
  }
  if (finishOpen && !materialId) {
    return json({ error: 'An order with the finish left open needs its material (material_id).' }, 400)
  }

  // Open quantity (000302): the durable sibling of thickness_open/finish_open.
  // A flag rather than "quantity IS NULL" because create-checkout-session
  // persists the customer's pick onto `quantity` at PaymentIntent time (the
  // webhook invoices the paid figure) — which would otherwise erase the
  // "customer chooses" marker and freeze their first pick against revisits.
  // Offline/prototype/reprint orders already required a quantity above, and a
  // custom quote has no quantity selector, so this reduces to the online
  // production grid case.
  const quantityOpen =
    quantity == null && customQuoteTotal == null && paymentMethod === 'online' && orderKind === 'production'

  // Offline orders are invoiced manually in Xero, so a Xero-contact binding is
  // meaningless there. Null it regardless of what the client sent, so an offline
  // row never carries an irrelevant (never-used) binding even if a direct API
  // call bypasses the modal's online-only guard.
  const effectiveXeroContactId = paymentMethod === 'offline' ? null : xeroContactId
  const effectiveXeroContactName = paymentMethod === 'offline' ? null : xeroContactName

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

  // ── Offline breakdown (priced + stamped now, like the online checkout) ──
  // Grid order → cards (incl. the folded finish surcharge) + split-name tooling
  // + personalisation, via the shared computeOrderTotal (same maths as the
  // online checkout; the reads mirror create-checkout-session's grid branch).
  // Custom quote → the agreed figure as the cards line. Shipping is free (0) or
  // the manual figure. Card discount resolved + capped against the cards figure.
  let amountCards: number | null = null
  let amountTooling: number | null = null
  let amountPersonalisation: number | null = null
  let amountShipping: number | null = null
  let amountCardDiscount: number | null = null
  if (paymentMethod === 'offline') {
    const round2 = (n: number) => Math.round(n * 100) / 100
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
      // Metal + carbon fibre: price a locked quantity above the top tier flat
      // at the top per-card rate (no volume discount past 1000). Mirrors the
      // online checkout so an offline order matches what the pay page charges.
      let flatAboveTop = false
      if (variant?.material_id) {
        const { data: material } = await admin
          .from('materials')
          .select('code, split_name_surcharge_gbp, split_name_surcharge_eur, split_name_surcharge_usd')
          .eq('id', variant.material_id)
          .single()
        perExtraName = splitNameForCurrency(material, currency)
        flatAboveTop = pricesFlatAboveTopTier(material?.code as string | null)
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
        if (surTiers.length > 0) optionSurcharge = cardTotalForQuantity(surTiers, quantity as number, undefined, { flatAboveTop }) ?? 0
      }

      const priced = computeOrderTotal({
        tiers,
        quantity: quantity as number,
        perExtraNameSurcharge: perExtraName,
        namesCount,
        personalisation,
        optionSurcharge,
        flatAboveTop,
        shipping: 0,
      })
      if (!priced.ok) {
        return json({ error: 'Couldn’t price this quantity offline — check it’s within the material’s price tiers.' }, 422)
      }
      amountCards = round2(priced.cards + priced.finish)
      amountTooling = priced.splitName
      amountPersonalisation = priced.personalisation
    }
    amountShipping = shippingTreatment === 'manual' ? round2(Number(shippingCharged ?? 0)) : 0
    const cardsBase = customQuoteTotal != null ? customQuoteTotal : (amountCards ?? 0)
    amountCardDiscount = resolveCardDiscount(cardDiscountType, cardDiscountValue, cardsBase)
  }

  // ── Insert ──────────────────────────────────────────────────────
  const token = randomToken()
  const payment_reference = paymentReference()
  const nowIso = new Date().toISOString()
  const isOffline = paymentMethod === 'offline'

  // ── Durable spec snapshot (Order log Phase 2) ───────────────────
  // Freeze the spec as at order time: the proof can be revised, or a material
  // renamed, after this — the snapshot is what the admin order log reads back
  // (via admin_search_orders' COALESCE) so the record never drifts. The same
  // shape is rebuilt + overwritten at place-order. Best-effort: a read miss
  // leaves order_spec_snapshot null and the log falls back to the live join, so
  // a snapshot failure must never block creating the order.
  let orderSpecSnapshot: ReturnType<typeof buildOrderSpecSnapshot> | null = null
  try {
    const [pvRes, contactRes, variantRes, optionRes] = await Promise.all([
      admin
        .from('proof_versions')
        .select('material_display, ink_names, front_colour_id, core_colour_id, back_colour_id, materials(code, display_name)')
        .eq('proof_id', proofId)
        .eq('is_current', true)
        .maybeSingle(),
      admin
        .from('proofs')
        .select('contacts:contact_id ( full_name, email, companies:company_id ( name ) )')
        .eq('id', proofId)
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

    // Resolve the version's letterpress layer colours (ids → names).
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
      hasPersonalisation,
      customQuoteTotal,
      contactEmail: contact?.email ?? null,
      contactName: contact?.full_name ?? null,
      companyName: contact?.companies?.name ?? null,
      stage: 'create',
      capturedBy: callerId,
      capturedAt: nowIso,
    })
  } catch {
    // Snapshot is best-effort; never block order creation on it.
    orderSpecSnapshot = null
  }

  const { data: order, error: insertErr } = await admin
    .from('orders')
    .insert({
      proof_id: proofId,
      status: isOffline ? 'paid' : 'sent',
      order_spec_snapshot: orderSpecSnapshot,
      material_variant_id: materialVariantId,
      material_option_id: materialOptionId,
      material_id: materialId,
      thickness_open: thicknessOpen,
      finish_open: finishOpen,
      quantity_open: quantityOpen,
      xero_contact_id: effectiveXeroContactId,
      xero_contact_name: effectiveXeroContactName,
      quantity,
      names_count: namesCount,
      person_quantities: personQuantities,
      has_personalisation: hasPersonalisation,
      custom_quote_total: customQuoteTotal,
      shipping_treatment: shippingTreatment,
      shipping_charged: shippingCharged,
      shipping_discount_percent: shippingDiscountPercent,
      card_discount_type: cardDiscountType,
      card_discount_value: cardDiscountValue,
      card_discount_reason: cardDiscountReason,
      ship_dest_country: shipDestCountry,
      ship_dest_postcode: shipDestPostcode,
      currency,
      token,
      expires_at: expiresAt,
      payment_reference,
      created_by: callerId,
      sent_at: nowIso,
      payment_method: paymentMethod,
      order_kind: orderKind,
      reprint_of_order_id: reprintOfOrderId,
      // Offline → created already paid, with the breakdown stamped so the
      // To-order queue + records have a total (no Stripe, no Xero here).
      ...(isOffline
        ? {
            paid_at: nowIso,
            amount_cards: amountCards,
            amount_tooling: amountTooling,
            amount_personalisation: amountPersonalisation,
            amount_shipping: amountShipping,
            amount_us_tariff: 0,
            amount_card_discount: amountCardDiscount,
          }
        : {}),
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
      payment_method: paymentMethod,
      order_kind: orderKind,
      reprint_of_order_id: reprintOfOrderId,
      currency,
      quantity,
      shipping_treatment: shippingTreatment,
      shipping_discount_percent: shippingDiscountPercent,
      card_discount_type: cardDiscountType,
      card_discount_value: cardDiscountValue,
      card_discount_reason: cardDiscountReason,
      ship_dest_country: shipDestCountry,
      ship_dest_postcode: shipDestPostcode,
      has_personalisation: hasPersonalisation,
      custom_quote_total: customQuoteTotal,
      material_option_id: materialOptionId,
      material_id: materialId,
      thickness_open: thicknessOpen,
      finish_open: finishOpen,
      quantity_open: quantityOpen,
      xero_contact_id: effectiveXeroContactId,
      xero_contact_name: effectiveXeroContactName,
      ...(isOffline ? { amount_cards: amountCards, amount_shipping: amountShipping, amount_card_discount: amountCardDiscount } : {}),
    },
  })

  return json({
    id: order.id,
    token: order.token,
    status: order.status,
    payment_reference: order.payment_reference,
  })
})
