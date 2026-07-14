// create-checkout-session — anonymous, token-scoped. Builds a Stripe
// Checkout session for one order and returns the hosted payment URL.
// Step 4 of the Ordering & checkout build (docs/ordering-checkout-spec.md).
//
// GROUP MODE (bundle orders Slice 2, docs/bundle-orders-spec.md §13): pass
// group_id + the GROUP's token instead of order_id, and the function prices
// every member order of the payment group (goods + tooling per card; open
// specs resolve from the request's member_choices with the single-order
// doctrine — request wins while the flag is set, validated, persisted),
// computes ONE combined shipping figure for the single consignment (+ ONE US
// tariff line when US-bound), and creates ONE PaymentIntent for the whole
// group. A member order's own link refuses payment while its group is
// active, so the same card can never be charged twice.
//
// The amount is ALWAYS computed SERVER-SIDE (never trust the client):
//   * custom-quote orders → the agreed total,
//   * grid-priced orders → price tiers (+ interpolation for non-standard
//     quantities) + split-name tooling + personalisation, via the shared
//     orderPricing helper (the single source of truth, kept in lockstep
//     with the Quote-compiler engine).
// Shipping is added on top, computed server-side too:
//   * free     → 0,
//   * manual   → the designer's fixed figure,
//   * full_cost / goodwill → the live carriage for the order's rating
//     destination — UK flat DPD rate, or a FedEx account rate for
//     international — converted to the order currency, with goodwill
//     taking the designer's per-order discount % off (Rob, 2026-06-15).
// If a rate can't be obtained (e.g. FedEx won't quote the lane, or an
// international order with no material at all to weigh — a custom quote with
// no variant falls back to a representative weight for its material), we fall
// back to a clear "we'll confirm shipping" message rather than charging a guess.
//
// Auth: none — the pay-page is anonymous. The order id + secret token
// are validated against proofs.orders (service-role read) exactly like
// public_get_order. Stripe charges only fake money while STRIPE_SECRET_KEY
// is a test key (sk_test_…).

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { cardTotalForQuantity, computeOrderTotal, resolveCardDiscount, resolveUsTariff, pricesFlatAboveTopTier, MAX_ONLINE_FLAT_QUANTITY, type Tier } from '../_shared/orderPricing.ts'
import {
  applyIntlAdjustment,
  fetchGbpRates,
  gbpToCurrency,
  resolveDomesticGbp,
  splitIntoBoxes,
  type Currency,
} from '../_shared/shipping.ts'
import { getFedExToken, requestRate, parseRateResponse, FedExError } from '../_shared/fedex.ts'
import { exVat, isVatFreeGbpDestination, normaliseShipDestination } from '../_shared/ukVatArea.ts'

function splitNameForCurrency(
  m: { split_name_surcharge_gbp: number | null; split_name_surcharge_eur: number | null; split_name_surcharge_usd: number | null } | null,
  currency: string,
): number | null {
  if (!m) return null
  const v = currency === 'GBP' ? m.split_name_surcharge_gbp : currency === 'EUR' ? m.split_name_surcharge_eur : m.split_name_surcharge_usd
  return v == null ? null : Number(v)
}

// Representative per-card weight (grams) for a material — the median across its
// active variants' weights. A shipping-only fallback for a custom-quote order
// that has a material but no pinned variant to read a weight from (a pre-fix
// order, or a bespoke quote the designer didn't attach a thickness to).
// International shipping needs SOME weight to rate the parcel; the agreed goods
// price and the Xero invoice line are untouched. Null when the material has no
// weighed variants — the caller then falls back to the "confirm shipping"
// message exactly as before.
async function representativeWeightGrams(
  admin: SupabaseClient,
  materialId: string,
): Promise<number | null> {
  const { data: vs } = await admin
    .from('material_variants')
    .select('weight_grams')
    .eq('material_id', materialId)
    .eq('is_active', true)
  const weights = (vs ?? [])
    .map((v) => Number(v.weight_grams))
    .filter((w) => Number.isFinite(w) && w > 0)
    .sort((a, b) => a - b)
  if (weights.length === 0) return null
  return weights[Math.floor((weights.length - 1) / 2)]
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

// Stripe wants the smallest currency unit (pence/cents). All three of
// our currencies are 2-decimal, so ×100 rounded is correct.
function minorUnits(amountMajor: number): number {
  return Math.round(amountMajor * 100)
}

// Destination countries offered for shipping — Stripe's address allow-list.
// Mirror of SHIP_COUNTRY_CODES in src/lib/shipCountries.ts (Deno can't import
// the src module); keep the two in step. Embargoed/non-serviceable
// destinations are omitted.
const SHIP_COUNTRY_CODES = [
  'AD', 'AE', 'AG', 'AI', 'AL', 'AM', 'AO', 'AR', 'AT', 'AU', 'AW', 'AZ',
  'BA', 'BB', 'BD', 'BE', 'BF', 'BH', 'BI', 'BJ', 'BM', 'BN', 'BO', 'BR',
  'BS', 'BT', 'BW', 'BZ', 'CA', 'CD', 'CG', 'CH', 'CI', 'CK', 'CL', 'CM',
  'CN', 'CO', 'CR', 'CV', 'CW', 'CY', 'CZ', 'DE', 'DJ', 'DK', 'DM', 'DO',
  'DZ', 'EC', 'EE', 'EG', 'ER', 'ES', 'ET', 'FI', 'FJ', 'FK', 'FO',
  'FR', 'GA', 'GB', 'GD', 'GE', 'GF', 'GG', 'GH', 'GI', 'GL', 'GM', 'GN',
  'GP', 'GQ', 'GR', 'GT', 'GU', 'GW', 'GY', 'HK', 'HN', 'HR', 'HT', 'HU',
  'ID', 'IE', 'IL', 'IM', 'IN', 'IS', 'IT', 'JE', 'JM', 'JO', 'JP', 'KE',
  'KG', 'KH', 'KN', 'KR', 'KW', 'KY', 'KZ', 'LA', 'LB', 'LC', 'LI', 'LK',
  'LR', 'LS', 'LT', 'LU', 'LV', 'MA', 'MC', 'MD', 'ME', 'MG', 'MK', 'ML',
  'MM', 'MN', 'MO', 'MQ', 'MR', 'MS', 'MT', 'MU', 'MV', 'MW', 'MX', 'MY',
  'MZ', 'NA', 'NC', 'NE', 'NG', 'NI', 'NL', 'NO', 'NP', 'NZ', 'OM', 'PA',
  'PE', 'PF', 'PG', 'PH', 'PK', 'PL', 'PR', 'PT', 'PY', 'QA', 'RE',
  'RO', 'RS', 'RW', 'SA', 'SB', 'SC', 'SE', 'SG', 'SI', 'SK', 'SL', 'SM',
  'SN', 'SR', 'ST', 'SV', 'SZ', 'TC', 'TD', 'TG', 'TH', 'TJ', 'TL', 'TN',
  'TO', 'TR', 'TT', 'TW', 'TZ', 'UA', 'UG', 'US', 'UY', 'UZ', 'VC', 'VE',
  'VG', 'VN', 'VU', 'WS', 'YE', 'ZA', 'ZM', 'ZW',
]

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  // Fast fail if Stripe isn't configured at all. The ACTUAL key is chosen
  // below by settings.payment_mode (test → _TEST key, live → _LIVE key), with
  // the legacy single STRIPE_SECRET_KEY as a fallback so an env that hasn't
  // been split yet keeps working.
  if (
    !Deno.env.get('STRIPE_SECRET_KEY')
    && !Deno.env.get('STRIPE_SECRET_KEY_TEST')
    && !Deno.env.get('STRIPE_SECRET_KEY_LIVE')
  ) {
    return json({ error: 'Payments are not configured yet.' }, 503)
  }

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }

  const orderId = typeof body.order_id === 'string' ? body.order_id : null
  // Group mode: the id of a proofs.order_groups row; token below is then the
  // GROUP's token, never a member order's.
  const groupId = typeof body.group_id === 'string' ? body.group_id : null
  const token = typeof body.token === 'string' ? body.token : null
  // The page passes its own origin so the success/cancel redirects come
  // back to the right host (prod vs a Netlify preview). Must be an
  // https?:// URL we echo only into Stripe's redirect — reject anything
  // that isn't a plain origin to avoid open-redirect surprises.
  const origin = typeof body.origin === 'string' ? body.origin : null
  // Customer-chosen quantity for an open-quantity order. Only trusted to
  // the extent that it must be a positive integer AND (below) match one of
  // the variant's listed price tiers — never an arbitrary value the client
  // could use to bend the price.
  const bodyQuantity =
    typeof body.quantity === 'number' && Number.isInteger(body.quantity) && body.quantity > 0
      ? body.quantity
      : null
  // Customer-chosen thickness / finish for an open-spec order (000298). Only
  // honoured when the order's thickness_open / finish_open flag is set, and
  // validated below against the order's material — never trusted to change a
  // designer-locked spec or to point at another material's pricing.
  const bodyVariantId = typeof body.material_variant_id === 'string' ? body.material_variant_id : null
  const bodyOptionId = typeof body.material_option_id === 'string' ? body.material_option_id : null
  // Per-person split (combined-total pricing). Each entry's quantity must be a
  // positive integer; the combined sum drives the tier price (interpolated if
  // it isn't an exact tier). The breakdown is persisted for production.
  const personQuantities = Array.isArray(body.person_quantities)
    ? (body.person_quantities as unknown[])
        .map((p) =>
          p && typeof p === 'object'
            ? {
                name: String((p as Record<string, unknown>).name ?? ''),
                quantity: Number((p as Record<string, unknown>).quantity),
              }
            : null,
        )
        .filter(
          (p): p is { name: string; quantity: number } =>
            p != null && p.name !== '' && Number.isInteger(p.quantity) && p.quantity > 0,
        )
    : []
  // Per-member customer choices for a GROUP checkout (the in-bundle open-spec
  // choosers). Keyed by member order id; each entry carries the same fields the
  // single-order body does (quantity / person_quantities / material_variant_id /
  // material_option_id) and earns the same trust: shape-checked here, then
  // honoured only where that member's *_open flag is set and the id survives
  // validation against the member's own material.
  const memberChoices = new Map<string, MemberChoice>()
  if (Array.isArray(body.member_choices)) {
    for (const raw of body.member_choices as unknown[]) {
      if (!raw || typeof raw !== 'object') continue
      const r = raw as Record<string, unknown>
      const oid = typeof r.order_id === 'string' ? r.order_id : null
      if (!oid) continue
      memberChoices.set(oid, {
        quantity:
          typeof r.quantity === 'number' && Number.isInteger(r.quantity) && r.quantity > 0 ? r.quantity : null,
        personQuantities: Array.isArray(r.person_quantities)
          ? (r.person_quantities as unknown[])
              .map((p) =>
                p && typeof p === 'object'
                  ? {
                      name: String((p as Record<string, unknown>).name ?? ''),
                      quantity: Number((p as Record<string, unknown>).quantity),
                    }
                  : null,
              )
              .filter(
                (p): p is { name: string; quantity: number } =>
                  p != null && p.name !== '' && Number.isInteger(p.quantity) && p.quantity > 0,
              )
          : [],
        materialVariantId: typeof r.material_variant_id === 'string' ? r.material_variant_id : null,
        materialOptionId: typeof r.material_option_id === 'string' ? r.material_option_id : null,
      })
    }
  }
  if ((!orderId && !groupId) || !token) return json({ error: 'Missing order_id/group_id or token' }, 400)
  if (!origin || !/^https?:\/\/[^/]+$/.test(origin)) return json({ error: 'Missing or invalid origin' }, 400)

  // Customer-entered rating destination for full_cost / goodwill orders. The
  // pay-page collects country + postcode (support rarely knows the postcode
  // upfront); we rate against these. Country is normalised to a 2-letter
  // upper-case code; anything else is treated as absent.
  const reqDestCountryRaw = typeof body.ship_dest_country === 'string' ? body.ship_dest_country.trim().toUpperCase() : ''
  const reqDestCountry = /^[A-Z]{2}$/.test(reqDestCountryRaw) ? reqDestCountryRaw : null
  const reqDestPostcode = typeof body.ship_dest_postcode === 'string' && body.ship_dest_postcode.trim()
    ? body.ship_dest_postcode.trim()
    : null
  // The customer's choice on the US tariff & customs handling service (default
  // included; true = they opted out and will deal with US Customs themselves).
  const optedOutOfUsTariff = body.us_tariff_opted_out === true

  const admin = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { db: { schema: 'proofs' }, auth: { persistSession: false, autoRefreshToken: false } },
  )

  // Choose the Stripe key by the admin-set payment mode (000241). test → the
  // sandbox key, live → the live key; both held in the env so flipping the
  // mode needs no redeploy. Legacy single STRIPE_SECRET_KEY is the fallback
  // for an env that predates the split. The customer is only ever charged real
  // money when the mode is 'live' AND a live (sk_live_…) key is present.
  const { data: modeRow } = await admin
    .from('settings')
    .select('payment_mode, us_tariff_fee_gbp, us_tariff_fee_eur, us_tariff_fee_usd')
    .eq('id', 1)
    .single()
  const paymentMode = modeRow?.payment_mode === 'live' ? 'live' : 'test'
  const stripeKey = paymentMode === 'live'
    ? (Deno.env.get('STRIPE_SECRET_KEY_LIVE') ?? Deno.env.get('STRIPE_SECRET_KEY'))
    : (Deno.env.get('STRIPE_SECRET_KEY_TEST') ?? Deno.env.get('STRIPE_SECRET_KEY'))
  if (!stripeKey) {
    return json({ error: `Payments are not configured for ${paymentMode} mode yet.` }, 503)
  }
  // Publishable key for the embedded checkout (loaded client-side). Not secret,
  // safe to return to the browser; chosen by the same mode so the embedded form
  // matches the session. Mode-specific, with the legacy single var as fallback.
  const publishableKey = paymentMode === 'live'
    ? (Deno.env.get('STRIPE_PUBLISHABLE_KEY_LIVE') ?? Deno.env.get('STRIPE_PUBLISHABLE_KEY'))
    : (Deno.env.get('STRIPE_PUBLISHABLE_KEY_TEST') ?? Deno.env.get('STRIPE_PUBLISHABLE_KEY'))
  if (!publishableKey) {
    return json({ error: `Payments are not fully configured for ${paymentMode} mode (missing publishable key).` }, 503)
  }

  // ── Group mode (bundle orders Slice 2) ─────────────────────────────
  if (groupId) {
    return await handleGroupCheckout({
      admin,
      stripeKey,
      publishableKey,
      tariffFees: {
        GBP: Number(modeRow?.us_tariff_fee_gbp ?? 0),
        EUR: Number(modeRow?.us_tariff_fee_eur ?? 0),
        USD: Number(modeRow?.us_tariff_fee_usd ?? 0),
      },
      groupId,
      token,
      reqDestCountry,
      reqDestPostcode,
      optedOutOfUsTariff,
      memberChoices,
    })
  }

  const { data: order, error: orderErr } = await admin
    .from('orders')
    .select('id, token, status, currency, custom_quote_total, shipping_treatment, shipping_charged, shipping_discount_percent, card_discount_type, card_discount_value, ship_dest_country, ship_dest_postcode, payment_reference, expires_at, material_variant_id, material_option_id, material_id, thickness_open, finish_open, quantity_open, quantity, names_count, has_personalisation, order_kind, proof_id, order_group_id')
    .eq('id', orderId)
    .eq('token', token)
    .single()
  if (orderErr || !order) return json({ error: 'Order not found' }, 404)

  if (order.status === 'paid' || order.status === 'fulfilled') {
    return json({ error: 'This order has already been paid.' }, 409)
  }
  if (order.status !== 'sent') return json({ error: 'This order is not payable.' }, 409)
  if (order.expires_at && new Date(order.expires_at).getTime() < Date.now()) {
    return json({ error: 'This order link has expired.' }, 409)
  }

  // A member of a payment group must pay through the group link — paying it
  // standalone too would charge the same card twice. Blocked whenever the
  // group is anything other than 'cancelled' (the #438 review fix): 'sent' is
  // the normal case, and 'paid' covers the freak path where the webhook's
  // member flip didn't land and a member sits 'sent' under a paid group —
  // that card's money was already taken, so its own link must never charge.
  // Only a cancelled group (which releases its members; a lingering pointer
  // is a husk) falls through to standalone payment.
  if (order.order_group_id) {
    const { data: grp } = await admin
      .from('order_groups')
      .select('status')
      .eq('id', order.order_group_id)
      .maybeSingle()
    if (grp && grp.status !== 'cancelled') {
      return json({
        error: 'order_in_group',
        message: 'This order is part of a combined payment covering several items — please use the combined payment link we sent you. If you can’t find it, just reply to the email and we’ll re-send it.',
      }, 409)
    }
  }

  // ── Open-spec resolution (000298) ─────────────────────────────────
  // When the designer left the thickness / finish for the customer, resolve the
  // effective variant/option from the request — the body wins on every call
  // while the flag is set (the same request-wins pattern as the rating
  // destination), so "Edit order details" can change the pick right up to
  // payment. A previously-persisted choice is the fallback for a stale client.
  // Choices are validated against the order's material: a value pointing at
  // another material's (differently-priced) variant is rejected, never priced.
  let effectiveVariantId = order.material_variant_id as string | null
  let effectiveOptionId = order.material_option_id as string | null
  if (order.thickness_open === true && order.custom_quote_total == null) {
    const requested = bodyVariantId ?? effectiveVariantId
    if (!requested) {
      return json({ error: 'variant_required', message: 'Please choose a thickness before paying.' }, 422)
    }
    const { data: v } = await admin
      .from('material_variants')
      .select('id, material_id, is_active')
      .eq('id', requested)
      .maybeSingle()
    if (!v || v.is_active === false || (order.material_id != null && v.material_id !== order.material_id)) {
      return json({ error: 'variant_required', message: 'Please choose a thickness before paying.' }, 422)
    }
    effectiveVariantId = requested
  }
  if (order.finish_open === true && order.custom_quote_total == null) {
    const requestedOpt = bodyOptionId ?? effectiveOptionId
    if (!requestedOpt) {
      return json({ error: 'finish_required', message: 'Please choose a finish before paying.' }, 422)
    }
    const { data: mo } = await admin
      .from('material_options')
      .select('id, material_id')
      .eq('id', requestedOpt)
      .maybeSingle()
    if (!mo || (order.material_id != null && mo.material_id !== order.material_id)) {
      return json({ error: 'finish_required', message: 'Please choose a finish before paying.' }, 422)
    }
    effectiveOptionId = requestedOpt
  }

  // ── Delivery destination + VAT treatment (resolved up front) ─────
  // The customer-entered destination wins; the order's stored values are the
  // fallback (the designer's hint, or a previous checkout call's persisted
  // pick). GB with a Jersey / Guernsey / Isle of Man postcode is normalised
  // to the island's own ISO code so the pricing, the shipping rating and the
  // Xero invoice all agree on where the order is really going.
  const effectiveDestPostcode = (reqDestPostcode ?? order.ship_dest_postcode ?? '').trim()
  const effectiveDestCountry = normaliseShipDestination(
    reqDestCountry ?? (order.ship_dest_country as string | null) ?? '',
    effectiveDestPostcode,
  )
  // GBP prices are VAT-inclusive, and the Channel Islands are outside the UK
  // VAT area — a GBP order delivering there is charged ex-VAT. The strip is
  // applied to every VAT-inclusive INPUT (tier totals, split-name tooling,
  // personalisation rates, finish surcharges) before the pricing maths, so
  // the stamped breakdown and the pay-page mirror run identical sums.
  // Custom-quote figures and the designer's fixed discount are charged as
  // agreed. The Isle of Man is INSIDE the UK VAT area — no relief there.
  // See _shared/ukVatArea.ts.
  const vatFree = order.currency === 'GBP' && isVatFreeGbpDestination(effectiveDestCountry)
  const exv = (n: number) => (vatFree ? exVat(n) : n)

  // ── Goods total (server-authoritative) ───────────────────────────
  // custom-quote → the agreed figure; grid → priced from tiers + tooling
  // + personalisation via the shared helper. The per-component split is
  // captured so the webhook can rebuild the itemised Xero invoice without
  // re-pricing (null components → a single summary line at invoice time).
  let goods: number
  let amountCards: number | null = null
  let amountTooling: number | null = null
  let amountPersonalisation: number | null = null
  // The quantity we actually charge + persist (so the Stripe→Xero webhook's
  // invoice Qty column is right). For a locked order it's order.quantity;
  // for an open order it's the customer's choice, validated below.
  let resolvedQuantity: number | null = null
  // Per-card weight of the chosen variant, needed to weigh an international
  // parcel for the FedEx rate. A custom-quote order with no pinned variant
  // falls back to a representative weight for its material (below) so it can
  // still be rated; only a truly material-less quote leaves this null.
  let variantWeightGrams: number | null = null
  // True when the weight above came from the material-median fallback rather
  // than a pinned variant — surfaced in the shipping log for support.
  let weightFromMaterialFallback = false
  // Human label for the Stripe summary's product line (e.g. "500 × Stainless
  // Steel 500µm — Mirror"). Built in the grid branch from the variant/option;
  // a generic fallback for custom quotes.
  let productLabel = ''
  if (order.custom_quote_total != null) {
    goods = Number(order.custom_quote_total)
    productLabel = order.order_kind === 'prototype' ? 'Plasma prototype sample' : 'Plasma cards (bespoke quote)'
    // A prototype (and any custom-quote order that kept its variant) carries a
    // material_variant_id + a fixed quantity (the prototype's 1–3 copies). Read
    // the per-card weight + copies so international shipping can be rated below.
    // A custom quote with no pinned variant falls back to a material-median
    // weight (just after) so it can still be rated; only a quote with no
    // material or no quantity leaves the parcel unweighable → "confirm shipping".
    if (order.material_variant_id) {
      const { data: variant } = await admin
        .from('material_variants')
        .select('weight_grams')
        .eq('id', order.material_variant_id)
        .maybeSingle()
      if (variant?.weight_grams != null) variantWeightGrams = Number(variant.weight_grams)
    }
    // Fallback: a custom quote with a material but no pinned variant (a pre-fix
    // order, or a bespoke quote with no thickness attached) still needs a
    // per-card weight to rate international shipping. Use a representative
    // weight for the material — shipping-only; the $ total + invoice are as-is.
    if (variantWeightGrams == null && order.material_id) {
      variantWeightGrams = await representativeWeightGrams(admin, order.material_id as string)
      if (variantWeightGrams != null) weightFromMaterialFallback = true
    }
    if (order.quantity != null) resolvedQuantity = order.quantity
  } else {
    if (!effectiveVariantId) {
      return json({
        error: 'pricing_not_supported',
        message: 'Online checkout for this order isn’t available yet — please reply to the email you received and we’ll take it from there.',
      }, 422)
    }
    const { data: tierRows } = await admin
      .from('price_tiers')
      .select('quantity, total_price')
      .eq('material_variant_id', effectiveVariantId)
      .eq('currency', order.currency)
    const tiers: Tier[] = (tierRows ?? []).map((t) => ({
      quantity: t.quantity as number,
      total_price: exv(Number(t.total_price)),
    }))

    // Resolve the quantity. Designer-locked (quantity set, flag off) → use it
    // as-is (may be an interpolated in-between). Customer-open (quantity_open,
    // 000302) → the REQUEST wins on every call — per-person split (sum drives
    // the price) or a single chosen quantity — with a previously-persisted
    // pick as the fallback for a stale client, exactly like the open-spec
    // thickness/finish resolution above. The customer can enter any quantity;
    // the price interpolates between the listed tiers (same as the per-person
    // split + the Quote compiler); computeOrderTotal returns no_card_price
    // outside the tier range, surfaced as pricing_not_supported below.
    const quantityIsOpen = order.quantity_open === true
    if (!quantityIsOpen && order.quantity != null) {
      resolvedQuantity = order.quantity
    } else if (personQuantities.length > 0) {
      resolvedQuantity = personQuantities.reduce((acc, p) => acc + p.quantity, 0)
    } else if (bodyQuantity != null) {
      resolvedQuantity = bodyQuantity
    } else if (order.quantity != null) {
      // Open order, no choice in this request — fall back to the pick a
      // previous checkout call persisted (stale client / legacy row).
      resolvedQuantity = order.quantity
    } else {
      return json({
        error: 'quantity_required',
        message: 'Please choose a quantity before paying.',
      }, 422)
    }

    // Split-name surcharge: variant → material → per-currency column.
    // weight_grams comes back on the same read for the FedEx parcel weight.
    const { data: variant } = await admin
      .from('material_variants')
      .select('material_id, weight_grams, display_name, materials(display_name)')
      .eq('id', effectiveVariantId)
      .single()
    if (variant?.weight_grams != null) variantWeightGrams = Number(variant.weight_grams)
    let perExtraName: number | null = null
    // Some materials have no volume discount past their top listed tier
    // (metal + carbon fibre at 1000), so an order above the top tier is
    // priced flat at the top per-card rate rather than rejected. Detected by
    // the material code via the shared pricesFlatAboveTopTier predicate.
    let flatAboveTop = false
    if (variant?.material_id) {
      const { data: material } = await admin
        .from('materials')
        .select('code, split_name_surcharge_gbp, split_name_surcharge_eur, split_name_surcharge_usd')
        .eq('id', variant.material_id)
        .single()
      perExtraName = splitNameForCurrency(material, order.currency)
      flatAboveTop = pricesFlatAboveTopTier(material?.code as string | null)
    }

    // Sanity cap on a customer-CHOSEN quantity (open order): a designer can
    // lock any quantity, but a customer typing their own number is bounded so
    // a fat-finger can't auto-price a huge run. Applies whenever the customer
    // owns the quantity (quantity_open, incl. re-picks over a persisted
    // figure); designer-locked orders skip it — chosen deliberately.
    if ((order.quantity_open === true || order.quantity == null) && flatAboveTop && resolvedQuantity > MAX_ONLINE_FLAT_QUANTITY) {
      return json({
        error: 'pricing_not_supported',
        message: 'For an order this large, please reply to the email you received and we’ll confirm the price and send a payment link.',
      }, 422)
    }

    // Personalisation rates for the currency, when the order has it.
    let personalisation: { perCardRate: number; minCharge: number } | null = null
    if (order.has_personalisation) {
      const { data: p } = await admin
        .from('personalisation_pricing')
        .select('per_card_rate, min_charge')
        .eq('currency', order.currency)
        .single()
      if (p) personalisation = { perCardRate: exv(Number(p.per_card_rate)), minCharge: exv(Number(p.min_charge)) }
    }

    // Material-option (finish) surcharge: when the order pinned a non-base
    // option (metal Brushed/Mirror), price its surcharge for the quantity from
    // material_option_surcharges, interpolated the SAME way base cards are so
    // the figure equals what the pay-page mirror shows. Base option / no
    // finish → no surcharge rows → 0.
    let optionSurcharge = 0
    if (effectiveOptionId) {
      const { data: surRows } = await admin
        .from('material_option_surcharges')
        .select('quantity, surcharge')
        .eq('material_option_id', effectiveOptionId)
        .eq('currency', order.currency)
      const surTiers: Tier[] = (surRows ?? []).map((s) => ({
        quantity: s.quantity as number,
        total_price: exv(Number(s.surcharge)),
      }))
      if (surTiers.length > 0) optionSurcharge = cardTotalForQuantity(surTiers, resolvedQuantity, undefined, { flatAboveTop }) ?? 0
    }

    const priced = computeOrderTotal({
      tiers,
      quantity: resolvedQuantity,
      perExtraNameSurcharge: perExtraName == null ? null : exv(perExtraName),
      namesCount: order.names_count ?? 1,
      personalisation,
      optionSurcharge,
      flatAboveTop,
      shipping: 0, // shipping is computed + added separately below
    })
    if (!priced.ok) {
      return json({
        error: 'pricing_not_supported',
        message: 'We couldn’t price this quantity online — please reply to the email you received and we’ll confirm the price and send a payment link.',
      }, 422)
    }
    goods = priced.goods
    // Fold the finish surcharge into the cards component: the Stripe→Xero
    // webhook itemises amount_cards + tooling + personalisation + shipping and
    // checks the sum equals the charge, so finish has to ride one of those
    // lines rather than add an un-summed column. Cards is the natural home.
    amountCards = Math.round((priced.cards + priced.finish) * 100) / 100
    amountTooling = priced.splitName
    amountPersonalisation = priced.personalisation

    // Build the human product label for the Stripe summary: "500 × Stainless
    // Steel 500µm — Mirror". Mirrors the webhook's invoice-line naming so the
    // pay-page and the Xero line read the same.
    let optionName = ''
    if (effectiveOptionId) {
      const { data: mo } = await admin
        .from('material_options')
        .select('display_name')
        .eq('id', effectiveOptionId)
        .maybeSingle()
      optionName = (mo?.display_name as string | null) ?? ''
    }
    const variantName = (variant?.display_name as string | null) ?? ''
    const materialName = ((variant?.materials as { display_name?: string } | null)?.display_name) ?? ''
    const qtyPrefix = resolvedQuantity != null ? `${resolvedQuantity.toLocaleString()} × ` : ''
    const variantSuffix = variantName && variantName !== materialName ? ` ${variantName}` : ''
    const optionSuffix = optionName ? ` — ${optionName}` : ''
    productLabel = `${qtyPrefix}${materialName || 'Cards'}${variantSuffix}${optionSuffix}`.trim()
  }

  // ── Shipping (server-authoritative) ──────────────────────────────
  // free → 0; manual → the designer's fixed figure; full_cost / goodwill →
  // the live carriage for the rating destination (UK flat DPD, or a FedEx
  // account rate for international), converted to the order currency, with
  // goodwill taking the per-order discount % off. A rate we can't obtain
  // (FedEx won't quote the lane, or an international order with no variant to
  // weigh) falls back to the same "we'll confirm shipping" message rather
  // than charging a guess.
  const round2 = (n: number) => Math.round(n * 100) / 100
  let shipping = 0
  // The destination we actually rated against — persisted onto the order
  // below so fulfilment + records carry the customer's entered country/postcode.
  let resolvedDestCountry: string | null = null
  let resolvedDestPostcode: string | null = null
  if (order.shipping_treatment === 'free') {
    shipping = 0
  } else if (order.shipping_treatment === 'manual') {
    shipping = round2(Number(order.shipping_charged ?? 0))
  } else {
    // full_cost / goodwill — compute the carriage from the destination
    // resolved up front (customer-entered values win; the order's stored
    // values are the fallback, e.g. a designer-set country hint). Already
    // normalised, so a "GB" entry with a Channel Islands / Isle of Man
    // postcode rates as the island itself (FedEx) rather than getting the
    // mainland DPD flat rate DPD wouldn't honour there.
    const destCountry = effectiveDestCountry
    const destPostcode = effectiveDestPostcode
    if (!destCountry || !destPostcode) {
      return json({
        error: 'shipping_destination_required',
        message: 'Please enter the delivery country and postcode so we can calculate shipping.',
      }, 422)
    }
    resolvedDestCountry = destCountry
    resolvedDestPostcode = destPostcode

    // Shipping settings: DPD flat rates + FedEx box tare + intl adjustment %.
    const { data: settings } = await admin
      .from('settings')
      .select('fedex_box_weight_grams, fedex_intl_adjust_percent, domestic_uk_mainland_rate_gbp, domestic_uk_ni_rate_gbp')
      .eq('id', 1)
      .single()
    const boxTareGrams = Number(settings?.fedex_box_weight_grams ?? 250)
    const intlAdjustPercent = Number(settings?.fedex_intl_adjust_percent ?? 0)
    const mainlandGbp = Number(settings?.domestic_uk_mainland_rate_gbp ?? 12.90)
    const niGbp = Number(settings?.domestic_uk_ni_rate_gbp ?? 18.90)

    let baseGbp: number | null = null
    let shipReason = ''
    let shipDetail: string | null = null
    if (destCountry === 'GB') {
      // Domestic UK — flat DPD rate (mainland vs Northern Ireland). No
      // weight needed, so this works for custom-quote and open orders too.
      baseGbp = resolveDomesticGbp(destPostcode, mainlandGbp, niGbp)
      shipReason = 'domestic_uk'
    } else {
      // International — FedEx account rate. Needs a weighable parcel.
      const boxes = splitIntoBoxes(variantWeightGrams, resolvedQuantity, boxTareGrams)
      const apiKey = Deno.env.get('FEDEX_API_KEY')
      const apiSecret = Deno.env.get('FEDEX_API_SECRET')
      const accountNumber = Deno.env.get('FEDEX_ACCOUNT_NUMBER')
      if (!boxes) {
        shipReason = 'no_parcel_weight'
      } else if (!apiKey || !apiSecret || !accountNumber) {
        shipReason = 'fedex_creds_missing'
      } else {
        try {
          const fxToken = await getFedExToken(apiKey, apiSecret)
          // Request in GBP — FedEx invoices Plasma's account in GBP and we
          // convert to the order currency ourselves, matching the Quote
          // compiler's render path exactly.
          const raw = await requestRate(fxToken, {
            destCountry,
            destPostcode: destPostcode.toUpperCase(),
            boxWeightsKg: boxes.map((g) => g / 1000),
            currency: 'GBP',
            accountNumber,
          })
          const parsed = parseRateResponse(raw, 'GBP')
          if (parsed.available && parsed.netCharge != null) {
            baseGbp = applyIntlAdjustment(parsed.netCharge, intlAdjustPercent)
            shipReason = 'fedex_ok'
          } else {
            shipReason = 'fedex_unavailable'
          }
        } catch (err) {
          // FedEx error or transient failure — leave baseGbp null so we fall
          // through to the "confirm shipping" message below.
          shipReason = 'fedex_error'
          shipDetail = err instanceof FedExError ? `${err.status} ${err.message}` : String(err)
          console.error('[create-checkout-session] fedex rate failed:', shipDetail)
        }
      }
    }

    console.log('[create-checkout-session] shipping', JSON.stringify({
      order_id: order.id,
      treatment: order.shipping_treatment,
      destCountry,
      destPostcode,
      resolvedQuantity,
      variantWeightGrams,
      weightFromMaterialFallback,
      baseGbp,
      reason: shipReason,
    }))

    if (baseGbp == null) {
      // reason is kept in the body (a short internal enum, useful for support);
      // the verbatim FedEx detail stays server-side in the log above and is not
      // leaked to the anonymous customer response.
      return json({
        error: 'shipping_not_supported',
        reason: shipReason,
        message: 'We couldn’t confirm shipping for this destination online — please reply to the email you received and we’ll send a payment link with shipping included.',
      }, 422)
    }

    // Convert GBP → order currency, then apply the goodwill discount %.
    const rates = await fetchGbpRates()
    const baseInCurrency = baseGbp * gbpToCurrency(order.currency as Currency, rates)
    const discountPercent =
      order.shipping_treatment === 'goodwill'
        ? Math.max(0, Math.min(100, Number(order.shipping_discount_percent ?? 0)))
        : 0
    shipping = round2(baseInCurrency * (1 - discountPercent / 100))
  }

  // ── US tariff & customs handling (server-authoritative) ──────────
  // Added by default to US-bound orders (the US ended the $800 de-minimis
  // import exemption on 2025-08-29); the customer can opt out on the pay-page
  // and is then responsible for US Customs. Destination is the effective
  // country resolved up front — the same resolution pricing and shipping use.
  // Rides on top as its own line; opt-out / non-US / a 0 fee → 0.
  const usTariffFee =
    order.currency === 'GBP' ? Number(modeRow?.us_tariff_fee_gbp ?? 0)
    : order.currency === 'EUR' ? Number(modeRow?.us_tariff_fee_eur ?? 0)
    : Number(modeRow?.us_tariff_fee_usd ?? 0)
  const usTariff = resolveUsTariff(effectiveDestCountry, usTariffFee, optedOutOfUsTariff)

  // ── Cards discount (server-authoritative) ────────────────────────
  // The designer's per-order discount applies to the GOODS subtotal — cards +
  // finish + split-name tooling + personalisation (or the custom-quote figure),
  // i.e. everything above shipping + tariff, so a percent discount matches the
  // item figure the customer sees. Resolved + capped here, stamped as
  // amount_card_discount, shown as its own negative line on the pay page +
  // invoice, and netted off the charged total.
  const cardDiscount = resolveCardDiscount(
    order.card_discount_type as string | null,
    order.card_discount_value as number | null,
    goods,
  )

  // Stamp the resolved breakdown so the Stripe→Xero webhook can itemise the
  // invoice. Best-effort: a failure here must not block checkout (the webhook
  // falls back to a single summary line if the breakdown is absent).
  await admin
    .from('orders')
    .update({
      // Persist the charged quantity for open orders so the Stripe→Xero
      // webhook itemises the invoice at the quantity actually paid.
      ...(resolvedQuantity != null ? { quantity: resolvedQuantity } : {}),
      // Persist the per-person split (production instruction) for open orders
      // — including re-picks over a previously-persisted split (quantity_open).
      ...((order.quantity_open === true || order.quantity == null) && personQuantities.length > 0
        ? { person_quantities: personQuantities }
        : {}),
      // Persist the customer-entered rating destination for fulfilment/records.
      ...(resolvedDestCountry ? { ship_dest_country: resolvedDestCountry } : {}),
      ...(resolvedDestPostcode ? { ship_dest_postcode: resolvedDestPostcode } : {}),
      // Persist the customer-chosen thickness/finish for an open-spec order so
      // the webhook's Xero item-code resolution + the place-order fulfilment
      // snapshot read the paid spec. The *_open flags stay true, so a later
      // "Edit order details" call can still change the pick pre-payment.
      ...(order.thickness_open === true && effectiveVariantId ? { material_variant_id: effectiveVariantId } : {}),
      ...(order.finish_open === true && effectiveOptionId ? { material_option_id: effectiveOptionId } : {}),
      amount_cards: amountCards,
      amount_tooling: amountTooling,
      amount_personalisation: amountPersonalisation,
      amount_shipping: shipping,
      amount_us_tariff: usTariff,
      amount_card_discount: cardDiscount,
      us_tariff_opted_out: optedOutOfUsTariff,
      updated_at: new Date().toISOString(),
    })
    .eq('id', order.id)

  const currency = String(order.currency).toLowerCase()
  const ref = order.payment_reference ?? order.id

  // ── Create the Stripe PaymentIntent ──────────────────────────────
  // We use a PaymentIntent (not a Checkout Session) because the pay-page mounts
  // Stripe Elements in our own two-column layout rather than Stripe's prebuilt
  // checkout. The amount is the authoritative server-computed total (goods +
  // shipping) in the order's currency; currency is locked here, so there's no
  // adaptive-pricing currency swap. The shipping address + email are collected
  // by the Address/Link Elements on the page and ride the confirmPayment call,
  // surfacing on payment_intent.succeeded for the webhook's fulfilment + Xero.
  const total = Math.round((goods - cardDiscount + shipping + usTariff) * 100) / 100
  const params = new URLSearchParams()
  params.set('amount', String(minorUnits(total)))
  params.set('currency', currency)
  params.set('automatic_payment_methods[enabled]', 'true')
  params.set('description', productLabel || `Order ${ref}`)
  params.set('metadata[order_id]', order.id)
  params.set('metadata[payment_reference]', ref)
  if (resolvedQuantity != null) params.set('metadata[quantity]', String(resolvedQuantity))

  let stripeRes: Response
  try {
    stripeRes = await fetch('https://api.stripe.com/v1/payment_intents', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${stripeKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    })
  } catch {
    return json({ error: 'Could not reach the payment provider. Please try again.' }, 502)
  }

  const intent = await stripeRes.json().catch(() => null)
  if (!stripeRes.ok || !intent?.client_secret) {
    // Full Stripe error stays in the function logs for diagnosis; the customer
    // sees only a friendly message (never raw Stripe text).
    console.error('[create-checkout-session] stripe error:', JSON.stringify(intent))
    return json({ error: 'Could not start checkout. Please try again, or reply to your email.' }, 502)
  }

  // The browser mounts Stripe Elements with the client secret + publishable
  // key; amount + currency + breakdown let the pay-page summary show the exact
  // charged total and its components (cards incl. finish, tooling, personalisation,
  // shipping) rather than one rolled-up figure.
  return json({
    client_secret: intent.client_secret as string,
    publishable_key: publishableKey,
    amount: total,
    currency: order.currency,
    // GBP order delivering to the Channel Islands — priced ex-VAT, so the
    // pay-page swaps its "Includes VAT." caption for the VAT-free one.
    vat_free: vatFree,
    breakdown: {
      cards: order.custom_quote_total != null ? Number(order.custom_quote_total) : (amountCards ?? 0),
      tooling: amountTooling ?? 0,
      personalisation: amountPersonalisation ?? 0,
      shipping,
      us_tariff: usTariff,
      card_discount: cardDiscount,
    },
  })
})

// ── Group checkout (bundle orders Slice 2) ──────────────────────────────────
// Prices EVERY member order of a payment group and creates ONE PaymentIntent.
// Members were validated at grouping time (order-group `create`): all 'sent',
// online, one currency, priceable. A member with open specs (thickness_open /
// finish_open / quantity_open, 000298/000302) resolves the customer's pick
// from member_choices first — the same request-wins doctrine, validation and
// persistence as the single-order path above — then prices exactly like a
// designer-locked single order (the same tier + tooling + personalisation +
// finish maths as the single path above; kept in step with it). What's new:
//   * ONE combined shipping figure — the group's own treatment, rated for the
//     single consignment (UK flat rate, or FedEx on the members' combined
//     weight) — and ONE US tariff line when US-bound (spec §8 defaults).
//   * Per-member goods breakdowns are stamped on each member row (their
//     shipping/tariff stamped 0 — those live on the group), so the webhook
//     can build the per-card invoice lines without re-pricing.
//   * metadata.order_group_id on the PaymentIntent routes the webhook into
//     group mode; metadata.payment_reference is the GROUP's GRP- reference —
//     the 1:1 payment ↔ invoice spine, exactly as single orders.

interface GroupMemberRow {
  id: string
  status: string
  currency: string
  custom_quote_total: number | null
  quantity: number | null
  names_count: number | null
  has_personalisation: boolean
  material_id: string | null
  material_variant_id: string | null
  material_option_id: string | null
  thickness_open: boolean
  finish_open: boolean
  quantity_open: boolean
  card_discount_type: string | null
  card_discount_value: number | null
  order_kind: string | null
  payment_reference: string | null
}

// One member's picks from the group pay page's choosers — the group-mode
// counterpart of the single-order body fields (quantity / person_quantities /
// material_variant_id / material_option_id).
interface MemberChoice {
  quantity: number | null
  personQuantities: { name: string; quantity: number }[]
  materialVariantId: string | null
  materialOptionId: string | null
}

async function handleGroupCheckout(ctx: {
  admin: SupabaseClient
  stripeKey: string
  publishableKey: string
  tariffFees: Record<'GBP' | 'EUR' | 'USD', number>
  groupId: string
  token: string
  reqDestCountry: string | null
  reqDestPostcode: string | null
  optedOutOfUsTariff: boolean
  memberChoices: Map<string, MemberChoice>
}): Promise<Response> {
  const { admin, groupId, token } = ctx
  const round2 = (n: number) => Math.round(n * 100) / 100

  const { data: group, error: groupErr } = await admin
    .from('order_groups')
    .select('id, token, status, currency, shipping_treatment, shipping_charged, shipping_discount_percent, ship_dest_country, ship_dest_postcode, payment_reference, expires_at')
    .eq('id', groupId)
    .eq('token', token)
    .single()
  if (groupErr || !group) return json({ error: 'Order not found' }, 404)

  if (group.status === 'paid') return json({ error: 'This order has already been paid.' }, 409)
  if (group.status !== 'sent') return json({ error: 'This order is not payable.' }, 409)
  if (group.expires_at && new Date(group.expires_at).getTime() < Date.now()) {
    return json({ error: 'This order link has expired.' }, 409)
  }

  const { data: memberRows, error: memberErr } = await admin
    .from('orders')
    .select('id, status, currency, custom_quote_total, quantity, names_count, has_personalisation, material_id, material_variant_id, material_option_id, thickness_open, finish_open, quantity_open, card_discount_type, card_discount_value, order_kind, payment_reference')
    .eq('order_group_id', groupId)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
  if (memberErr) return json({ error: 'Could not read this order. Please try again.' }, 500)
  const members = (memberRows ?? []) as GroupMemberRow[]
  if (members.length === 0) return json({ error: 'This order is not payable.' }, 409)
  for (const m of members) {
    // A member cancelled after grouping (or re-opened) makes the combined
    // total dishonest — refuse with a human explanation rather than charging
    // a stale sum. The designer releases/fixes the card and the link revives.
    if (m.status !== 'sent') {
      return json({
        error: 'group_member_not_payable',
        message: 'One of the items in this combined payment has changed — please reply to the email you received and we’ll send an updated link.',
      }, 409)
    }
  }

  // A missing/invalid choice on an open-spec member. Carries the member's
  // order id so the group pay page can point at the exact card (its own
  // gating makes this belt-and-braces, but a stale tab can still land here).
  const choiceRequired = (code: string, m: GroupMemberRow, what: string) =>
    json({
      error: code,
      order_id: m.id,
      message: `Please choose a ${what} for ${m.payment_reference ?? 'each item'} before paying.`,
    }, 422)

  // ── Delivery destination + VAT treatment (one for the whole group) ──
  const effectiveDestPostcode = (ctx.reqDestPostcode ?? group.ship_dest_postcode ?? '').trim()
  const effectiveDestCountry = normaliseShipDestination(
    ctx.reqDestCountry ?? (group.ship_dest_country as string | null) ?? '',
    effectiveDestPostcode,
  )
  const vatFree = group.currency === 'GBP' && isVatFreeGbpDestination(effectiveDestCountry)
  const exv = (n: number) => (vatFree ? exVat(n) : n)

  // ── Price each member (server-authoritative, same maths as single) ──
  let goodsSum = 0
  let discountSum = 0
  // Combined parcel weight; null once any member can't be weighed (custom
  // quote with no variant/quantity) → international shipping can't be rated.
  let totalCardsGrams: number | null = 0
  const memberLines: {
    order_id: string
    payment_reference: string | null
    label: string
    quantity: number | null
    goods: number
    card_discount: number
  }[] = []
  const memberStamps: { id: string; patch: Record<string, unknown> }[] = []

  for (const m of members) {
    let goods: number
    let amountCards: number | null = null
    let amountTooling: number | null = null
    let amountPersonalisation: number | null = null
    let label = ''
    let variantWeightGrams: number | null = null

    // ── Open-spec resolution per member (000298/000302) ─────────────
    // Mirrors the single-order path above, member-scoped: the request's
    // member_choices entry wins on every call while the member's flag is
    // set (so "change your mind" works right up to payment), a previously
    // persisted pick is the fallback for a stale client, and every id is
    // validated against the member's own material — a value pointing at
    // another material's (differently-priced) variant is rejected, never
    // priced.
    const choice = ctx.memberChoices.get(m.id)
    let effectiveVariantId = m.material_variant_id
    let effectiveOptionId = m.material_option_id
    if (m.thickness_open === true && m.custom_quote_total == null) {
      const requested = choice?.materialVariantId ?? effectiveVariantId
      if (!requested) return choiceRequired('variant_required', m, 'thickness')
      const { data: v } = await admin
        .from('material_variants')
        .select('id, material_id, is_active')
        .eq('id', requested)
        .maybeSingle()
      if (!v || v.is_active === false || (m.material_id != null && v.material_id !== m.material_id)) {
        return choiceRequired('variant_required', m, 'thickness')
      }
      effectiveVariantId = requested
    }
    if (m.finish_open === true && m.custom_quote_total == null) {
      const requestedOpt = choice?.materialOptionId ?? effectiveOptionId
      if (!requestedOpt) return choiceRequired('finish_required', m, 'finish')
      const { data: mo } = await admin
        .from('material_options')
        .select('id, material_id')
        .eq('id', requestedOpt)
        .maybeSingle()
      if (!mo || (m.material_id != null && mo.material_id !== m.material_id)) {
        return choiceRequired('finish_required', m, 'finish')
      }
      effectiveOptionId = requestedOpt
    }
    // Quantity: designer-locked → as-is; customer-open (quantity_open) → the
    // request wins — per-person split (sum drives the price) or a single
    // chosen figure — falling back to a pick a previous call persisted.
    const personQuantities = choice?.personQuantities ?? []
    let resolvedQuantity: number | null
    if (m.custom_quote_total != null) {
      resolvedQuantity = m.quantity // prototype-style fixed copies; may be null
    } else if (m.quantity_open !== true && m.quantity != null) {
      resolvedQuantity = m.quantity
    } else if (personQuantities.length > 0) {
      resolvedQuantity = personQuantities.reduce((acc, p) => acc + p.quantity, 0)
    } else if (choice?.quantity != null) {
      resolvedQuantity = choice.quantity
    } else if (m.quantity != null) {
      resolvedQuantity = m.quantity
    } else {
      return choiceRequired('quantity_required', m, 'quantity')
    }

    if (m.custom_quote_total != null) {
      goods = Number(m.custom_quote_total)
      label = m.order_kind === 'prototype' ? 'Plasma prototype sample' : 'Plasma cards (bespoke quote)'
      if (m.material_variant_id) {
        const { data: variant } = await admin
          .from('material_variants')
          .select('weight_grams, display_name, materials(display_name)')
          .eq('id', m.material_variant_id)
          .maybeSingle()
        if (variant?.weight_grams != null) variantWeightGrams = Number(variant.weight_grams)
        const materialName = ((variant?.materials as { display_name?: string } | null)?.display_name) ?? ''
        if (materialName) {
          label = m.order_kind === 'prototype' ? `${materialName} — prototype sample` : `${materialName} (bespoke quote)`
        }
      }
      // Fallback (mirrors the single-order path): a grouped custom-quote member
      // with no pinned variant still contributes weight to the combined parcel,
      // so one unweighable member can't null the whole group's rating.
      if (variantWeightGrams == null && m.material_id) {
        variantWeightGrams = await representativeWeightGrams(admin, m.material_id as string)
      }
    } else {
      // Grid member — the effective (locked or customer-chosen) variant +
      // quantity, priced exactly like the single-order path.
      if (!effectiveVariantId || resolvedQuantity == null) {
        return json({
          error: 'group_member_not_payable',
          message: 'One of the items in this combined payment can’t be priced online — please reply to the email you received.',
        }, 409)
      }
      const { data: tierRows } = await admin
        .from('price_tiers')
        .select('quantity, total_price')
        .eq('material_variant_id', effectiveVariantId)
        .eq('currency', group.currency)
      const tiers: Tier[] = (tierRows ?? []).map((t) => ({
        quantity: t.quantity as number,
        total_price: exv(Number(t.total_price)),
      }))

      const { data: variant } = await admin
        .from('material_variants')
        .select('material_id, weight_grams, display_name, materials(display_name)')
        .eq('id', effectiveVariantId)
        .single()
      if (variant?.weight_grams != null) variantWeightGrams = Number(variant.weight_grams)
      let perExtraName: number | null = null
      let flatAboveTop = false
      if (variant?.material_id) {
        const { data: material } = await admin
          .from('materials')
          .select('code, split_name_surcharge_gbp, split_name_surcharge_eur, split_name_surcharge_usd')
          .eq('id', variant.material_id)
          .single()
        perExtraName = splitNameForCurrency(material, group.currency)
        flatAboveTop = pricesFlatAboveTopTier(material?.code as string | null)
      }

      // Sanity cap on a customer-CHOSEN quantity, exactly as the single path:
      // a designer can lock any figure, but a fat-fingered customer entry on a
      // flat-above-top material is bounded rather than auto-priced.
      if ((m.quantity_open === true || m.quantity == null) && flatAboveTop && resolvedQuantity > MAX_ONLINE_FLAT_QUANTITY) {
        return json({
          error: 'pricing_not_supported',
          order_id: m.id,
          message: 'For an order this large, please reply to the email you received and we’ll confirm the price and send a payment link.',
        }, 422)
      }

      let personalisation: { perCardRate: number; minCharge: number } | null = null
      if (m.has_personalisation) {
        const { data: p } = await admin
          .from('personalisation_pricing')
          .select('per_card_rate, min_charge')
          .eq('currency', group.currency)
          .single()
        if (p) personalisation = { perCardRate: exv(Number(p.per_card_rate)), minCharge: exv(Number(p.min_charge)) }
      }

      let optionSurcharge = 0
      let optionName = ''
      if (effectiveOptionId) {
        const { data: surRows } = await admin
          .from('material_option_surcharges')
          .select('quantity, surcharge')
          .eq('material_option_id', effectiveOptionId)
          .eq('currency', group.currency)
        const surTiers: Tier[] = (surRows ?? []).map((s) => ({
          quantity: s.quantity as number,
          total_price: exv(Number(s.surcharge)),
        }))
        if (surTiers.length > 0) optionSurcharge = cardTotalForQuantity(surTiers, resolvedQuantity, undefined, { flatAboveTop }) ?? 0
        const { data: mo } = await admin
          .from('material_options')
          .select('display_name')
          .eq('id', effectiveOptionId)
          .maybeSingle()
        optionName = (mo?.display_name as string | null) ?? ''
      }

      const priced = computeOrderTotal({
        tiers,
        quantity: resolvedQuantity,
        perExtraNameSurcharge: perExtraName == null ? null : exv(perExtraName),
        namesCount: m.names_count ?? 1,
        personalisation,
        optionSurcharge,
        flatAboveTop,
        shipping: 0,
      })
      if (!priced.ok) {
        return json({
          error: 'group_member_not_payable',
          message: 'One of the items in this combined payment couldn’t be priced online — please reply to the email you received.',
        }, 409)
      }
      goods = priced.goods
      amountCards = round2(priced.cards + priced.finish)
      amountTooling = priced.splitName
      amountPersonalisation = priced.personalisation

      const variantName = (variant?.display_name as string | null) ?? ''
      const materialName = ((variant?.materials as { display_name?: string } | null)?.display_name) ?? ''
      const qtyPrefix = `${resolvedQuantity.toLocaleString()} × `
      const variantSuffix = variantName && variantName !== materialName ? ` ${variantName}` : ''
      const optionSuffix = optionName ? ` — ${optionName}` : ''
      label = `${qtyPrefix}${materialName || 'Cards'}${variantSuffix}${optionSuffix}`.trim()
    }

    // Combined parcel weight for the FedEx rating below.
    if (totalCardsGrams != null && variantWeightGrams != null && resolvedQuantity != null) {
      totalCardsGrams += variantWeightGrams * resolvedQuantity
    } else {
      totalCardsGrams = null
    }

    // Discount base = the member's goods figure (cards + finish + tooling +
    // personalisation; custom quotes carry their agreed figure) — the same
    // number shown as the member's item line, so a percent discount matches it.
    const cardDiscount = resolveCardDiscount(m.card_discount_type, m.card_discount_value, goods)

    goodsSum = round2(goodsSum + goods)
    discountSum = round2(discountSum + cardDiscount)
    memberLines.push({
      order_id: m.id,
      payment_reference: m.payment_reference,
      label,
      quantity: resolvedQuantity,
      goods,
      card_discount: cardDiscount,
    })
    memberStamps.push({
      id: m.id,
      patch: {
        // Persist the customer's resolved picks for an open-spec member, the
        // same durable pattern as the single path: the *_open flags stay set
        // (openness ≠ resolvedness, 000302), so a later call can re-pick
        // right up to payment, and the webhook's invoice lines + place-order
        // fulfilment snapshot read the spec actually paid for.
        ...(resolvedQuantity != null ? { quantity: resolvedQuantity } : {}),
        ...((m.quantity_open === true || m.quantity == null) && personQuantities.length > 0
          ? { person_quantities: personQuantities }
          : {}),
        ...(m.thickness_open === true && effectiveVariantId ? { material_variant_id: effectiveVariantId } : {}),
        ...(m.finish_open === true && effectiveOptionId ? { material_option_id: effectiveOptionId } : {}),
        // Null for custom-quote members, exactly like the single online path —
        // display + invoicing read custom_quote_total directly, and stamping
        // it here too would risk a double-count anywhere that sums both.
        amount_cards: amountCards,
        amount_tooling: amountTooling,
        amount_personalisation: amountPersonalisation,
        // Shipping + US tariff are billed ONCE at group level — zero here so
        // the member's stamped breakdown sums to its own goods figure and the
        // group invoice's per-card lines don't double-book carriage.
        amount_shipping: 0,
        amount_us_tariff: 0,
        amount_card_discount: cardDiscount,
      },
    })
  }

  // ── ONE combined shipping figure (the group's own treatment) ────────
  let shipping = 0
  let resolvedDestCountry: string | null = null
  let resolvedDestPostcode: string | null = null
  if (group.shipping_treatment === 'free') {
    shipping = 0
  } else if (group.shipping_treatment === 'manual') {
    shipping = round2(Number(group.shipping_charged ?? 0))
  } else {
    const destCountry = effectiveDestCountry
    const destPostcode = effectiveDestPostcode
    if (!destCountry || !destPostcode) {
      return json({
        error: 'shipping_destination_required',
        message: 'Please enter the delivery country and postcode so we can calculate shipping.',
      }, 422)
    }
    resolvedDestCountry = destCountry
    resolvedDestPostcode = destPostcode

    const { data: settings } = await admin
      .from('settings')
      .select('fedex_box_weight_grams, fedex_intl_adjust_percent, domestic_uk_mainland_rate_gbp, domestic_uk_ni_rate_gbp')
      .eq('id', 1)
      .single()
    const boxTareGrams = Number(settings?.fedex_box_weight_grams ?? 250)
    const intlAdjustPercent = Number(settings?.fedex_intl_adjust_percent ?? 0)
    const mainlandGbp = Number(settings?.domestic_uk_mainland_rate_gbp ?? 12.90)
    const niGbp = Number(settings?.domestic_uk_ni_rate_gbp ?? 18.90)

    let baseGbp: number | null = null
    let shipReason = ''
    if (destCountry === 'GB') {
      baseGbp = resolveDomesticGbp(destPostcode, mainlandGbp, niGbp)
      shipReason = 'domestic_uk'
    } else {
      // International — FedEx on the members' COMBINED weight (one
      // consignment, spec §8). splitIntoBoxes works off cards-weight × qty,
      // so pass the summed grams with qty 1.
      const boxes = totalCardsGrams != null && totalCardsGrams > 0
        ? splitIntoBoxes(totalCardsGrams, 1, boxTareGrams)
        : null
      const apiKey = Deno.env.get('FEDEX_API_KEY')
      const apiSecret = Deno.env.get('FEDEX_API_SECRET')
      const accountNumber = Deno.env.get('FEDEX_ACCOUNT_NUMBER')
      if (!boxes) {
        shipReason = 'no_parcel_weight'
      } else if (!apiKey || !apiSecret || !accountNumber) {
        shipReason = 'fedex_creds_missing'
      } else {
        try {
          const fxToken = await getFedExToken(apiKey, apiSecret)
          const raw = await requestRate(fxToken, {
            destCountry,
            destPostcode: destPostcode.toUpperCase(),
            boxWeightsKg: boxes.map((g) => g / 1000),
            currency: 'GBP',
            accountNumber,
          })
          const parsed = parseRateResponse(raw, 'GBP')
          if (parsed.available && parsed.netCharge != null) {
            baseGbp = applyIntlAdjustment(parsed.netCharge, intlAdjustPercent)
            shipReason = 'fedex_ok'
          } else {
            shipReason = 'fedex_unavailable'
          }
        } catch (err) {
          shipReason = 'fedex_error'
          const detail = err instanceof FedExError ? `${err.status} ${err.message}` : String(err)
          console.error('[create-checkout-session] group fedex rate failed:', detail)
        }
      }
    }

    console.log('[create-checkout-session] group shipping', JSON.stringify({
      group_id: group.id,
      treatment: group.shipping_treatment,
      destCountry,
      destPostcode,
      members: members.length,
      totalCardsGrams,
      baseGbp,
      reason: shipReason,
    }))

    if (baseGbp == null) {
      return json({
        error: 'shipping_not_supported',
        reason: shipReason,
        message: 'We couldn’t confirm shipping for this destination online — please reply to the email you received and we’ll send a payment link with shipping included.',
      }, 422)
    }

    const rates = await fetchGbpRates()
    const baseInCurrency = baseGbp * gbpToCurrency(group.currency as Currency, rates)
    const discountPercent =
      group.shipping_treatment === 'goodwill'
        ? Math.max(0, Math.min(100, Number(group.shipping_discount_percent ?? 0)))
        : 0
    shipping = round2(baseInCurrency * (1 - discountPercent / 100))
  }

  // ── ONE US tariff line for the group (one customs entry, spec §8) ───
  const usTariffFee = ctx.tariffFees[(group.currency as 'GBP' | 'EUR' | 'USD')] ?? 0
  const usTariff = resolveUsTariff(effectiveDestCountry, usTariffFee, ctx.optedOutOfUsTariff)

  // ── Stamp the breakdowns (best-effort, mirrors the single path) ─────
  const nowIso = new Date().toISOString()
  for (const stamp of memberStamps) {
    await admin
      .from('orders')
      .update({
        ...stamp.patch,
        // The whole group ships to ONE place — copy the rated destination to
        // each member so fulfilment + records read the same address.
        ...(resolvedDestCountry ? { ship_dest_country: resolvedDestCountry } : {}),
        ...(resolvedDestPostcode ? { ship_dest_postcode: resolvedDestPostcode } : {}),
        updated_at: nowIso,
      })
      .eq('id', stamp.id)
  }
  await admin
    .from('order_groups')
    .update({
      amount_shipping: shipping,
      amount_us_tariff: usTariff,
      us_tariff_opted_out: ctx.optedOutOfUsTariff,
      ...(resolvedDestCountry ? { ship_dest_country: resolvedDestCountry } : {}),
      ...(resolvedDestPostcode ? { ship_dest_postcode: resolvedDestPostcode } : {}),
      updated_at: nowIso,
    })
    .eq('id', group.id)

  // ── ONE PaymentIntent for the whole group ───────────────────────────
  const total = round2(goodsSum - discountSum + shipping + usTariff)
  const currency = String(group.currency).toLowerCase()
  const ref = group.payment_reference ?? group.id
  const params = new URLSearchParams()
  params.set('amount', String(minorUnits(total)))
  params.set('currency', currency)
  params.set('automatic_payment_methods[enabled]', 'true')
  params.set('description', `Combined payment — ${members.length} card orders (${ref})`)
  params.set('metadata[order_group_id]', group.id)
  params.set('metadata[payment_reference]', ref)

  let stripeRes: Response
  try {
    stripeRes = await fetch('https://api.stripe.com/v1/payment_intents', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ctx.stripeKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    })
  } catch {
    return json({ error: 'Could not reach the payment provider. Please try again.' }, 502)
  }

  const intent = await stripeRes.json().catch(() => null)
  if (!stripeRes.ok || !intent?.client_secret) {
    console.error('[create-checkout-session] group stripe error:', JSON.stringify(intent))
    return json({ error: 'Could not start checkout. Please try again, or reply to your email.' }, 502)
  }

  return json({
    client_secret: intent.client_secret as string,
    publishable_key: ctx.publishableKey,
    amount: total,
    currency: group.currency,
    vat_free: vatFree,
    members: memberLines,
    breakdown: {
      goods: goodsSum,
      card_discount: discountSum,
      shipping,
      us_tariff: usTariff,
    },
  })
}
