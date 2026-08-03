// Fixtures for the customer PAY pages (/order/:id and /order/group/:id) in the
// verify harness.
//
// Owned by the pay-pages e2e work — mock-supabase.ts delegates to these hooks
// FIRST and falls through to its own fixtures when they return null. Only
// claim requests that belong to this page's fixture ids (prefix `pay-` /
// `grp-`), return null for everything else, and never edit mock-supabase.ts /
// entry.tsx from the same change that edits this file.
//
// Payload shapes mirror what the pages actually consume:
//   * public_get_order        → OrderPayload   (OrderPayPage.tsx)
//   * public_get_order_group  → GroupGraph     (OrderGroupPayPage.tsx)
//   * public_get_customer_proof → CustomerProofGraph slice the pay pages read
//     (versions / material_variants / price_tiers / material_options /
//     material_option_surcharges / personalisation_pricing)
//   * customer-proof-images   → { images: GridImage-ish[] } with
//     proof_version_id stamped per row (the page filters on it)
//   * create-checkout-session → an ERROR body, deliberately: js.stripe.com is
//     blocked in the harness, so a "successful" intent would only flash the
//     Elements skeleton before loadStripeJs() fails and bounces back anyway.
//     Failing at the invoke keeps the page deterministically on the inputs
//     panel with its inline error — the state the specs assert around.
//
// ── The shared price grid (GBP) and what the specs expect from it ─────────
//
//   variant           100    250    500    1000
//   300 micron       £119   £249   £449   £799
//   500 micron       £139   £299   £549   £999
//   Mirror surcharge  £20    £40    £60   £100    (Natural is the base: £0)
//   split-name tooling: £39 per extra name; shipping: fixture per order.
//
//   pay-fixed  (locked 500µm+Mirror, qty 500 persisted, 2 names, £15 manual
//               shipping): Cards 549+60=£609, Tooling £39, Shipping £15,
//               Total £663. Re-priced at qty 250: 299+40=£339 → Total £393.
//   pay-open   (thickness+finish+quantity all open, free shipping):
//               500 + 500µm + Mirror → £609; qty 250 → £339; 300µm @250 → £289.
//   pay-us     (custom quote $500, US destination): tariff $39 (the
//               publicSettings default — the mock serves no settings row),
//               total $539; opt-out drops it to $500.
//   pay-paid   (paid, stamped 609+39+15 = £663, granular tracking at
//               in_production → step 2 of 4).
//   grp-1      locked custom-quote member £500 + open member (same catalogue)
//               + £20 manual shipping → 500+609+20 = £1,129 fully picked.
//   grp-paid   stamped members 439 + 250, discount 20, shipping 25 → £694.
//
// The material_code is deliberately a made-up 'pay_test_steel': it must not
// start with 'metal_' (that would pull in the admin thickness copy and the
// flat-above-top-tier pricing, coupling these specs to editable copy and to
// MAX_ONLINE_FLAT_QUANTITY) and must not be 'plastic_full_colour' (the
// preference-only finish special case). Everything the specs assert derives
// from THIS file's data, not from app copy.

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { HookQueryState } from './customer-proof'

const TOKEN = 'tok'

const isPayId = (v: unknown): v is string => typeof v === 'string' && v.startsWith('pay-')
const isGrpId = (v: unknown): v is string => typeof v === 'string' && v.startsWith('grp-')

// Responses are deep-cloned so a page can never mutate the shared fixture
// between renders (StrictMode mounts everything twice).
const clone = <T,>(v: T): T => (v == null ? v : JSON.parse(JSON.stringify(v)))

const now = Date.now()
const daysAgo = (n: number) => new Date(now - n * 864e5).toISOString()
const daysAhead = (n: number) => new Date(now + n * 864e5).toISOString()

// Self-contained artwork so the recap renders without any network.
function cardSvg(bg: string, label: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="240"><rect width="400" height="240" rx="16" fill="${bg}"/><text x="200" y="128" font-family="sans-serif" font-size="24" fill="#ffffff" text-anchor="middle">${label}</text></svg>`
  return `data:image/svg+xml;base64,${btoa(svg)}`
}

// ── Catalogue ───────────────────────────────────────────────────────────────

const MAT_ID = 'pay-mat-1'
const VAR_300 = 'pay-var-300'
const VAR_500 = 'pay-var-500'
const OPT_NATURAL = 'pay-opt-natural'
const OPT_MIRROR = 'pay-opt-mirror'

const MATERIAL_VARIANTS = [
  { id: VAR_300, material_id: MAT_ID, display_name: '300 micron', variant_type: 'thickness', sort_order: 1 },
  { id: VAR_500, material_id: MAT_ID, display_name: '500 micron', variant_type: 'thickness', sort_order: 2 },
]

function tiersFor(variantId: string, grid: Array<[number, number]>) {
  return grid.map(([quantity, total_price], i) => ({
    id: `pt-${variantId}-${i}`,
    material_variant_id: variantId,
    currency: 'GBP',
    quantity,
    total_price,
    unit_price: total_price / quantity,
  }))
}

const PRICE_TIERS = [
  ...tiersFor(VAR_300, [[100, 119], [250, 249], [500, 449], [1000, 799]]),
  ...tiersFor(VAR_500, [[100, 139], [250, 299], [500, 549], [1000, 999]]),
]

const MATERIAL_OPTIONS = [
  { id: OPT_NATURAL, material_id: MAT_ID, code: 'natural', display_name: 'Natural', is_base: true, sort_order: 1, photo_url: null, description: null },
  { id: OPT_MIRROR, material_id: MAT_ID, code: 'mirror', display_name: 'Mirror', is_base: false, sort_order: 2, photo_url: null, description: null },
]

const OPTION_SURCHARGES = ([[100, 20], [250, 40], [500, 60], [1000, 100]] as Array<[number, number]>).map(
  ([quantity, surcharge], i) => ({
    id: `sur-${i}`,
    material_option_id: OPT_MIRROR,
    currency: 'GBP',
    quantity,
    surcharge,
  }),
)

// ── Proof graphs (public_get_customer_proof) ────────────────────────────────

function steelGraph(proofId: string, versionId: string) {
  return {
    proof: {
      customer_name: 'Nolan Bushnell',
      company: 'Vandelay Industries',
      status: 'approved',
      approved_at: daysAgo(5),
      abandoned_at: null,
      disclaimer_acknowledged_at: null,
    },
    versions: [
      {
        id: versionId,
        proof_id: proofId,
        version_number: 1,
        material_id: MAT_ID,
        material_display: 'Stainless Steel',
        material_code: 'pay_test_steel',
        ink_names: [],
        currency: 'GBP',
        is_current: true,
        created_at: daysAgo(6),
        material_options: ['natural', 'mirror'],
        display_quantities: [100, 250, 500, 1000],
        names: [],
        split_name_surcharge_snapshot: 39,
        custom_quote: false,
      },
    ],
    material_variants: MATERIAL_VARIANTS,
    price_tiers: PRICE_TIERS,
    material_options: MATERIAL_OPTIONS,
    material_option_surcharges: OPTION_SURCHARGES,
    personalisation_pricing: {},
  }
}

// Custom-quote wood proof for the US order + the locked group member.
function woodGraph(proofId: string, versionId: string) {
  return {
    proof: {
      customer_name: 'Nolan Bushnell',
      company: 'Vandelay Industries',
      status: 'approved',
      approved_at: daysAgo(9),
      abandoned_at: null,
      disclaimer_acknowledged_at: null,
    },
    versions: [
      {
        id: versionId,
        proof_id: proofId,
        version_number: 1,
        material_id: 'pay-mat-wood',
        material_display: 'Walnut Wood',
        material_code: 'wood',
        ink_names: [],
        currency: 'USD',
        is_current: true,
        created_at: daysAgo(10),
        material_options: [],
        display_quantities: null,
        names: [],
        split_name_surcharge_snapshot: null,
        custom_quote: true,
      },
    ],
    material_variants: [],
    price_tiers: [],
    material_options: [],
    material_option_surcharges: [],
    personalisation_pricing: {},
  }
}

const GRAPHS: Record<string, any> = {
  'pay-proof-fixed': steelGraph('pay-proof-fixed', 'pay-ver-fixed'),
  'pay-proof-open': steelGraph('pay-proof-open', 'pay-ver-open'),
  'pay-proof-paid': steelGraph('pay-proof-paid', 'pay-ver-paid'),
  'pay-proof-us': woodGraph('pay-proof-us', 'pay-ver-us'),
}

// customer-proof-images: one front + one back per proof, no finish tab
// (material_option null = shared across finishes), stamped with the graph's
// current version id so the page's proof_version_id filter keeps them.
const VERSION_FOR_PROOF: Record<string, string> = {
  'pay-proof-fixed': 'pay-ver-fixed',
  'pay-proof-open': 'pay-ver-open',
  'pay-proof-paid': 'pay-ver-paid',
  'pay-proof-us': 'pay-ver-us',
}

function imagesFor(proofId: string) {
  const ver = VERSION_FOR_PROOF[proofId]
  if (!ver) return []
  return [
    { id: `img-${proofId}-front`, signed_url: cardSvg('#1f2937', 'FRONT'), side: 'front', material_option: null, is_qr_code: false, sort_order: 1, proof_version_id: ver },
    { id: `img-${proofId}-back`, signed_url: cardSvg('#3f6212', 'BACK'), side: 'back', material_option: null, is_qr_code: false, sort_order: 2, proof_version_id: ver },
  ]
}

// ── Orders (public_get_order payloads) ──────────────────────────────────────

// Every field OrderPayPage reads, with per-order overrides on top.
function baseOrder(partial: Record<string, any>): Record<string, any> {
  return {
    id: partial.id,
    proof_id: 'pay-proof-fixed',
    status: 'sent',
    material_id: MAT_ID,
    material_variant_id: VAR_500,
    material_option_id: null,
    thickness_open: false,
    finish_open: false,
    quantity_open: false,
    previous_spec: null,
    person_quantities: null,
    quantity: 500,
    names_count: 1,
    has_personalisation: false,
    custom_quote_total: null,
    order_kind: 'production',
    shipping_treatment: 'manual',
    shipping_charged: 15,
    ship_dest_country: 'GB',
    ship_dest_postcode: null,
    vat_treatment: null,
    currency: 'GBP',
    expires_at: daysAhead(10),
    payment_reference: `ORD-${String(partial.id ?? '').toUpperCase()}`,
    paid_at: null,
    amount_cards: null,
    amount_tooling: null,
    amount_personalisation: null,
    amount_shipping: null,
    amount_us_tariff: null,
    amount_card_discount: null,
    card_discount_type: 'none',
    card_discount_value: null,
    us_tariff_opted_out: false,
    ship_to_name: null,
    ship_to_address: null,
    customs_tax_id: null,
    order_group_id: null,
    order_group_status: null,
    ...partial,
  }
}

const ORDERS: Record<string, any> = {
  // Closed thickness+finish (500µm Mirror locked), quantity persisted from an
  // earlier checkout call (quantity_open stays true per 000302 — openness is
  // the flag), 2 names for the tooling line, £15 manual shipping. Auto-advance
  // fires create-checkout-session on load; the hook's error reply keeps the
  // page on the inputs panel with the full client-computed breakdown.
  'pay-fixed': baseOrder({
    id: 'pay-fixed',
    material_option_id: OPT_MIRROR,
    quantity_open: true,
    quantity: 500,
    names_count: 2,
  }),
  // Everything left for the customer: thickness, finish and quantity all open,
  // nothing persisted, free shipping so the total is fully client-computed.
  'pay-open': baseOrder({
    id: 'pay-open',
    proof_id: 'pay-proof-open',
    material_variant_id: null,
    thickness_open: true,
    finish_open: true,
    quantity_open: true,
    quantity: null,
    shipping_treatment: 'free',
    shipping_charged: null,
  }),
  // US-bound agreed price: $500 custom quote, free shipping, designer-set US
  // destination — shows the tariff line + opt-out before any checkout call.
  'pay-us': baseOrder({
    id: 'pay-us',
    proof_id: 'pay-proof-us',
    material_id: null,
    material_variant_id: null,
    quantity: null,
    custom_quote_total: 500,
    currency: 'USD',
    shipping_treatment: 'free',
    shipping_charged: null,
    ship_dest_country: 'US',
  }),
  // Lapsed link. full_cost shipping keeps the auto-advance effect from firing
  // a pointless checkout call (it doesn't check expiry — needsDest does).
  'pay-expired': baseOrder({
    id: 'pay-expired',
    expires_at: daysAgo(3),
    shipping_treatment: 'full_cost',
    shipping_charged: null,
  }),
  // Paid, with the checkout-stamped breakdown (609+39+15 = 663) and a
  // granular tracking projection mid-journey.
  'pay-paid': baseOrder({
    id: 'pay-paid',
    proof_id: 'pay-proof-paid',
    status: 'paid',
    material_option_id: OPT_MIRROR,
    quantity: 500,
    names_count: 2,
    paid_at: daysAgo(2),
    amount_cards: 609,
    amount_tooling: 39,
    amount_personalisation: 0,
    amount_shipping: 15,
    amount_us_tariff: 0,
    amount_card_discount: 0,
    ship_to_name: 'Nolan Bushnell',
    ship_to_address: { line1: '12 Fixture Street', line2: null, city: 'Stoke-on-Trent', region: null, postal_code: 'FX1 2AB', country: 'GB' },
    tracking_projection: {
      level: 'granular',
      stage: 'in_production',
      tracking_number: 'TRK-0001',
    },
  }),
}

// ── Groups (public_get_order_group payloads) ────────────────────────────────

// A group MEMBER row — the GroupMemberPayload slice OrderGroupPayPage reads.
function member(partial: Record<string, any>): Record<string, any> {
  return {
    id: partial.id,
    proof_id: 'pay-proof-open',
    status: 'sent',
    quantity: null,
    person_quantities: null,
    names_count: 1,
    has_personalisation: false,
    custom_quote_total: null,
    material_id: null,
    material_variant_id: null,
    material_option_id: null,
    thickness_open: false,
    finish_open: false,
    quantity_open: false,
    previous_spec: null,
    card_discount_type: 'none',
    card_discount_value: null,
    amount_cards: null,
    amount_tooling: null,
    amount_personalisation: null,
    amount_card_discount: null,
    payment_reference: `ORD-${String(partial.id ?? '').toUpperCase()}`,
    order_kind: 'production',
    order_spec_snapshot: null,
    ...partial,
  }
}

function baseGroup(partial: Record<string, any>): Record<string, any> {
  return {
    id: partial.id,
    status: 'sent',
    currency: 'GBP',
    shipping_treatment: 'manual',
    shipping_charged: 20,
    ship_dest_country: 'GB',
    ship_dest_postcode: null,
    vat_treatment: null,
    amount_shipping: null,
    amount_us_tariff: null,
    us_tariff_opted_out: false,
    payment_reference: `GRP-${String(partial.id ?? '').toUpperCase()}`,
    expires_at: daysAhead(10),
    paid_at: null,
    ship_to_name: null,
    ship_to_address: null,
    customs_tax_id: null,
    ...partial,
  }
}

const GROUPS: Record<string, any> = {
  // Two members: a fully-locked custom-quote card (£500 agreed) and an
  // open-spec card on the shared steel catalogue. £20 manual shipping keeps
  // the combined total client-computable: 500 + 609 + 20 = £1,129 once the
  // open member is fully picked (500 × 500µm Mirror).
  'grp-1': {
    group: baseGroup({ id: 'grp-1' }),
    orders: [
      member({
        id: 'pay-grp-locked',
        proof_id: 'pay-proof-us',
        quantity: 1000,
        custom_quote_total: 500,
        order_spec_snapshot: { material: { display_name: 'Walnut Wood' }, quantity: 1000 },
      }),
      member({
        id: 'pay-grp-open',
        proof_id: 'pay-proof-open',
        material_id: MAT_ID,
        thickness_open: true,
        finish_open: true,
        quantity_open: true,
        order_spec_snapshot: { material: { display_name: 'Stainless Steel' } },
      }),
    ],
    company_name: 'Vandelay Industries',
  },
  // Paid group: stamped member breakdowns (439 + 250), one member discount
  // (£20), £25 combined shipping → Total paid £694.
  'grp-paid': {
    group: baseGroup({
      id: 'grp-paid',
      status: 'paid',
      shipping_charged: 25,
      amount_shipping: 25,
      amount_us_tariff: 0,
      paid_at: daysAgo(1),
      ship_to_name: 'Nolan Bushnell',
      ship_to_address: { line1: '12 Fixture Street', line2: null, city: 'Stoke-on-Trent', region: null, postal_code: 'FX1 2AB', country: 'GB' },
    }),
    orders: [
      member({
        id: 'pay-grp-paid-a',
        proof_id: 'pay-proof-fixed',
        status: 'paid',
        quantity: 500,
        amount_cards: 400,
        amount_tooling: 39,
        amount_personalisation: 0,
        amount_card_discount: 20,
        order_spec_snapshot: { material: { display_name: 'Stainless Steel' }, variant: { display_name: '500 micron' }, quantity: 500 },
      }),
      member({
        id: 'pay-grp-paid-b',
        proof_id: 'pay-proof-us',
        status: 'paid',
        custom_quote_total: 250,
        order_spec_snapshot: { material: { display_name: 'Walnut Wood' } },
      }),
    ],
    company_name: 'Vandelay Industries',
  },
}

// ── Hooks ───────────────────────────────────────────────────────────────────

// The pay pages never query tables via .from() — everything flows through
// RPCs and edge-function invokes — so the query hook has nothing to claim.
export function payPagesQuery(_state: HookQueryState): { data: any; error: null; count?: number } | null {
  return null
}

// Claim public_get_order / public_get_order_group for pay-* / grp-* ids.
export function payPagesRpc(name: string, args?: any): { data: any; error: any } | null {
  switch (name) {
    case 'public_get_order': {
      const id = args?.p_order_id
      if (!isPayId(id)) return null
      // Token-gated like the real RPC: a wrong token reads as not-found.
      if (args?.p_token !== TOKEN) return { data: null, error: null }
      return { data: clone(ORDERS[id] ?? null), error: null }
    }
    case 'public_get_order_group': {
      const id = args?.p_group_id
      if (!isGrpId(id)) return null
      if (args?.p_token !== TOKEN) return { data: null, error: null }
      return { data: clone(GROUPS[id] ?? null), error: null }
    }
    case 'public_get_customer_proof': {
      const id = args?.p_proof_id
      if (!isPayId(id)) return null
      return { data: clone(GRAPHS[id] ?? null), error: null }
    }
    // Write-shaped RPCs: accept and drop (the mock backend is stateless).
    case 'record_order_pay_link_opened':
    case 'record_order_customs_tax_id':
      return isPayId(args?.p_order_id) ? { data: null, error: null } : null
    case 'record_order_group_pay_link_opened':
    case 'record_order_group_customs_tax_id':
      return isGrpId(args?.p_group_id) ? { data: null, error: null } : null
  }
  return null
}

// Claim create-checkout-session etc. for pay-* / grp-* ids.
export function payPagesInvoke(name: string, body?: any): { data: any; error: any } | null {
  if (name === 'customer-proof-images') {
    const proofId = body?.proofId
    if (!isPayId(proofId)) return null
    return { data: { images: clone(imagesFor(proofId)) }, error: null }
  }
  if (name === 'create-checkout-session') {
    if (!isPayId(body?.order_id) && !isGrpId(body?.group_id)) return null
    // Deliberate failure — see the header. The page surfaces body.message in
    // its inline error and stays on the inputs panel.
    return { data: { error: 'harness_blocked', message: 'Checkout is not available in the harness.' }, error: null }
  }
  if (name === 'order-vat-invoice') {
    if (!isPayId(body?.order_id) && !isGrpId(body?.group_id)) return null
    return { data: { ready: false }, error: null }
  }
  if (name === 'order-question') {
    if (!isPayId(body?.order_id)) return null
    return { data: { status: 'ok' }, error: null }
  }
  return null
}
