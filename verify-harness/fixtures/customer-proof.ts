// Fixtures for the CUSTOMER proof page (/p/:id) in the verify harness.
//
// Owned by the customer-page e2e work — mock-supabase.ts delegates to these
// hooks FIRST and falls through to its own fixtures when they return null.
// The contract that keeps parallel work safe: only claim requests that belong
// to THIS page's fixture ids (prefix `cp-`), return null for everything else,
// and never edit mock-supabase.ts / entry.tsx from the same change that edits
// this file.
//
// The page's complete data surface, derived from CustomerProofPage.tsx:
//
//   on load   supabase.rpc('public_get_customer_proof', { p_proof_id })
//             supabase.rpc('public_settings')                — via getPublicSettings()
//             supabase.rpc('public_get_proof_order_state', { p_proof_id })
//             supabase.functions.invoke('customer-proof-images', { proofId })
//             supabase.rpc('public_get_proof_annotations', { p_version_id })
//             supabase.rpc('record_proof_view', …)           — skipped in the
//               harness (mock auth always returns a session, and the page
//               deliberately never records designer views)
//   on submit supabase.functions.invoke('proof-action', { proof_version_id, … })
//             supabase.functions.invoke('proof-contact-submit', { proofId, … })
//               (abandoned-screen contact form)
//
// `public_settings` carries no fixture id, so it is claimed only while the
// harness URL is actually mounting /p/cp-… — other pages (pay pages, login)
// keep whatever their own fixture modules or the generic fallback provide.
//
// Fixture states:
//   cp-basic     one recipient (front + back), GBP tiers with a curated
//                display list, a global disclaimer, one QR row on the
//                recipient — every approve gate reachable.
//   cp-multi     two recipients, one already approved — the one-of-two shape.
//   cp-earlier   two versions; the older one selectable (earlier-version ack).
//   cp-abandoned abandoned proof (quiet closed screen + contact form).
//   any other cp-… id resolves to a null graph = the page's not-found state.
//
// proof-action submissions are recorded on window.__cpProofActions so specs
// can assert exactly what left the page (and that gated submits sent nothing).

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface HookQueryState {
  schema: string
  table: string
  select: string
  single: boolean
  head: boolean
  filters: Record<string, any>
}

const now = Date.now()
const daysAgo = (n: number) => new Date(now - n * 864e5).toISOString()

// Self-contained SVG artwork (external hosts are blocked in the harness).
// encodeURIComponent rather than btoa so a stray non-ASCII label can never
// produce an unparseable data URI.
function art(colour: string, label: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400">` +
    `<rect width="640" height="400" rx="14" fill="${colour}"/>` +
    `<text x="320" y="210" font-family="sans-serif" font-size="28" fill="#ffffff" text-anchor="middle">${label}</text>` +
    `</svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

// One image row exactly as the customer-proof-images edge function returns it
// (select * on public_proof_version_images + signed_url), including the
// proof_version_id the page buckets on.
function img(partial: any): any {
  return {
    id: partial.id,
    signed_url: partial.signed_url ?? art('#1f2733', partial.id),
    material_option: null,
    original_filename: `${partial.id}.jpg`,
    associated_name: null,
    side: null,
    round_variant_id: null,
    layout_id: null,
    sort_order: 0,
    is_qr_code: false,
    qr_decoded_data: null,
    qr_kind: null,
    qr_vcard_slug: null,
    ...partial,
  }
}

// ── The catalogue slice every cp- proof shares ───────────────────────────────
// One steel material, one 500-micron variant, five GBP tiers. The versions
// curate display_quantities to the first three, so the table shows a subset
// and the QuantityLookup has hidden tiers (1000 / 2000) to answer for.
const MATERIAL_ID = 'cp-mat-steel'
const VARIANT_ID = 'cp-var-500'

const MATERIAL_VARIANTS = [
  { id: VARIANT_ID, material_id: MATERIAL_ID, display_name: '500 micron', variant_type: 'thickness', sort_order: 1 },
]

const PRICE_TIERS = (
  [
    [100, 179],
    [250, 249],
    [500, 329],
    [1000, 449],
    [2000, 649],
  ] as Array<[number, number]>
).map(([quantity, total], i) => ({
  id: `cp-tier-${i}`,
  material_variant_id: VARIANT_ID,
  currency: 'GBP',
  quantity,
  total_price: total,
  unit_price: total / quantity,
}))

// ── Version factory — the full PublicProofVersion shape the RPC emits ────────
function version(partial: any): any {
  return {
    id: partial.id,
    proof_id: partial.proof_id,
    version_number: 1,
    material_id: MATERIAL_ID,
    material_display: 'Stainless Steel',
    ink_names: [],
    currency: 'GBP',
    pricing_snapshot: { variants: [] },
    shipping_note: '',
    change_notes: null,
    is_current: true,
    created_at: daysAgo(3),
    material_options: [],
    display_quantities: [100, 250, 500],
    quote_min_quantity: null,
    quote_max_quantity: null,
    key_features: null,
    material_disclaimer: null,
    material_description: null,
    material_icon_url: null,
    option_label: null,
    custom_quote: false,
    superseded_at: null,
    names: [],
    split_name_surcharge_snapshot: null,
    approvals: [],
    card_type: 'business',
    displayed_variant_ids: null,
    latest_events_by_name: [],
    approvals_enabled: true,
    core_colour_name: null,
    core_colour_hex: null,
    front_colour_name: null,
    front_colour_hex: null,
    back_colour_name: null,
    back_colour_hex: null,
    is_variant_round: false,
    round_variants: [],
    is_per_direction_pricing: false,
    has_personalisation: false,
    team_sharing_enabled: false,
    material_code: 'metal_steel',
    shape: 'recipients',
    layouts: [],
    ...partial,
  }
}

function graph(proof: any, versions: any[]): any {
  return {
    proof,
    versions,
    material_options: [],
    material_option_surcharges: [],
    material_variants: MATERIAL_VARIANTS,
    price_tiers: PRICE_TIERS,
    personalisation_pricing: {},
  }
}

// ── The four fixture proofs ──────────────────────────────────────────────────

const GRAPHS: Record<string, any> = {
  'cp-basic': graph(
    {
      customer_name: 'Priya Sharma',
      company: 'Kite & Co',
      status: 'in_progress',
      approved_at: null,
      abandoned_at: null,
      disclaimer_acknowledged_at: null,
    },
    [
      version({
        id: 'cp-basic-v1',
        proof_id: 'cp-basic',
        names: ['Priya Sharma'],
        change_notes: 'First full draft.',
      }),
    ],
  ),
  'cp-multi': graph(
    {
      customer_name: 'Amara Okafor',
      company: 'Osei Partners',
      status: 'in_progress',
      approved_at: null,
      abandoned_at: null,
      disclaimer_acknowledged_at: null,
    },
    [
      version({
        id: 'cp-multi-v1',
        proof_id: 'cp-multi',
        names: ['Amara Okafor', 'Ben Osei'],
        // Amara has already approved; Ben is still pending. The approval row
        // and its matching latest_events_by_name entry are the two sources
        // getBandState reads for the locked band.
        approvals: [
          {
            name: 'Amara Okafor',
            state: 'approved',
            carried_from_version_id: null,
            material_option_code: null,
          },
        ],
        latest_events_by_name: [
          {
            name: 'Amara Okafor',
            event_type: 'approve',
            actor_name: 'Amara Okafor',
            comment: null,
            created_at: daysAgo(1),
            helpscout_thread_id: null,
            material_option_code: null,
            round_variant_id: null,
          },
        ],
      }),
    ],
  ),
  'cp-earlier': graph(
    {
      customer_name: 'Noor Haddad',
      company: null,
      status: 'in_progress',
      approved_at: null,
      abandoned_at: null,
      disclaimer_acknowledged_at: null,
    },
    [
      version({
        id: 'cp-earlier-v1',
        proof_id: 'cp-earlier',
        version_number: 1,
        is_current: false,
        superseded_at: daysAgo(2),
        created_at: daysAgo(6),
        names: ['Noor Haddad'],
      }),
      version({
        id: 'cp-earlier-v2',
        proof_id: 'cp-earlier',
        version_number: 2,
        is_current: true,
        created_at: daysAgo(2),
        names: ['Noor Haddad'],
        change_notes: 'Crest redrawn at a heavier weight.',
      }),
    ],
  ),
  'cp-abandoned': graph(
    {
      customer_name: 'Wes Adler',
      company: 'Aster & Co',
      status: 'abandoned',
      approved_at: null,
      abandoned_at: daysAgo(10),
      disclaimer_acknowledged_at: null,
    },
    // No versions: the AbandonedScreen renders from the proof header alone,
    // and the page skips the images fetch entirely for a version-less graph.
    [],
  ),
}

const IMAGES: Record<string, any[]> = {
  'cp-basic': [
    img({ id: 'cp-basic-front', proof_version_id: 'cp-basic-v1', associated_name: 'Priya Sharma', side: 'front', signed_url: art('#1f2733', 'Priya front') }),
    img({ id: 'cp-basic-back', proof_version_id: 'cp-basic-v1', associated_name: 'Priya Sharma', side: 'back', signed_url: art('#243b53', 'Priya back') }),
    // One QR on the recipient's own card — what makes the approve panel's
    // QR-confirmation tick render for the Priya slot (qrRowsForSlot matches
    // associated_name === slot or null).
    img({
      id: 'cp-basic-qr1',
      proof_version_id: 'cp-basic-v1',
      associated_name: 'Priya Sharma',
      is_qr_code: true,
      qr_kind: 'url',
      qr_decoded_data: 'https://plasma.example/priya',
      signed_url: art('#111111', 'QR'),
      original_filename: 'priya-qr.jpg',
    }),
  ],
  'cp-multi': [
    img({ id: 'cp-multi-amara', proof_version_id: 'cp-multi-v1', associated_name: 'Amara Okafor', side: 'front', signed_url: art('#7c2d12', 'Amara') }),
    img({ id: 'cp-multi-ben', proof_version_id: 'cp-multi-v1', associated_name: 'Ben Osei', side: 'front', signed_url: art('#3f6212', 'Ben') }),
  ],
  'cp-earlier': [
    img({ id: 'cp-earlier-v1-front', proof_version_id: 'cp-earlier-v1', associated_name: 'Noor Haddad', side: 'front', signed_url: art('#6d28d9', 'v1 front') }),
    img({ id: 'cp-earlier-v2-front', proof_version_id: 'cp-earlier-v2', associated_name: 'Noor Haddad', side: 'front', signed_url: art('#0e7490', 'v2 front') }),
    img({ id: 'cp-earlier-v2-back', proof_version_id: 'cp-earlier-v2', associated_name: 'Noor Haddad', side: 'back', signed_url: art('#0f3d3e', 'v2 back') }),
  ],
  'cp-abandoned': [],
}

// public_settings payload for cp- page loads. disclaimer_text non-empty is
// what arms the approve panel's disclaimer tick; the request-changes
// confirmation copy feeds the post-submit view. proof_pins_enabled stays off
// so the pin placer (its own feature, its own specs) never mounts here.
const SETTINGS = {
  disclaimer_text:
    'Please check every detail carefully before approving — colours on screen are indicative only.',
  company_name: 'PlasmaDesign Ltd',
  reply_email: 'studio@plasma.example',
  approve_confirmation_copy: null,
  request_changes_confirmation_copy:
    'Thanks — the team will review your notes and reply shortly.',
  metal_thickness_notes: null,
  about_proof_copy: null,
  qr_panel_intro_copy: null,
  qr_panel_vcard_copy: null,
  proof_pins_enabled: false,
}

// `public_settings` has no fixture id in its arguments, so scope the claim by
// what the harness is mounting: only /p/cp-… page loads see these settings.
// Mirrors entry.tsx's ?path= / #hash resolution.
function onCustomerProofPage(): boolean {
  if (typeof window === 'undefined') return false
  const path =
    new URLSearchParams(window.location.search).get('path') ??
    (window.location.hash ? window.location.hash.replace(/^#/, '') : '')
  return path.startsWith('/p/cp-')
}

// Submitted proof-action bodies, exposed for the specs: gated submits must
// send NOTHING, successful ones exactly one payload.
function recordProofAction(body: any): void {
  const w = window as any
  if (!Array.isArray(w.__cpProofActions)) w.__cpProofActions = []
  w.__cpProofActions.push(body)
}

// .from() queries. Return { data, error: null } to claim, null to fall through.
// The customer page reads everything through RPCs and edge functions — it
// never touches the query builder — so there is deliberately nothing to claim.
export function customerProofQuery(_state: HookQueryState): { data: any; error: null; count?: number } | null {
  return null
}

// supabase.rpc(name, args). Claim public_get_customer_proof etc. for cp-* ids.
export function customerProofRpc(name: string, args?: any): { data: any; error: any } | null {
  if (name === 'public_get_customer_proof') {
    const id = args?.p_proof_id
    if (typeof id !== 'string' || !id.startsWith('cp-')) return null
    // Unknown cp- id → SQL NULL, exactly what the live RPC returns for a
    // missing proof; the page's `data == null` branch renders NotFound.
    return { data: GRAPHS[id] ?? null, error: null }
  }
  if (name === 'public_settings') {
    return onCustomerProofPage() ? { data: SETTINGS, error: null } : null
  }
  if (name === 'public_get_proof_order_state' || name === 'public_get_cheaper_alternatives') {
    const id = args?.p_proof_id
    if (typeof id !== 'string' || !id.startsWith('cp-')) return null
    // No order exists on any cp- fixture: the parse-guarded consumers treat
    // null as "no card at all", which keeps the order surfaces out of shot.
    return { data: null, error: null }
  }
  if (name === 'public_get_proof_annotations') {
    const vid = args?.p_version_id
    if (typeof vid !== 'string' || !vid.startsWith('cp-')) return null
    return { data: [], error: null }
  }
  if (name === 'record_proof_view') {
    // Defensive only — the harness auth mock always has a session, so the
    // page's designer-as-viewer bypass means this should never fire.
    const vid = args?.p_version_id
    if (typeof vid !== 'string' || !vid.startsWith('cp-')) return null
    return { data: null, error: null }
  }
  return null
}

// supabase.functions.invoke(name, body). Claim customer-proof-images /
// proof-action etc. for cp-* ids.
export function customerProofInvoke(name: string, body?: any): { data: any; error: any } | null {
  if (name === 'customer-proof-images') {
    const id = body?.proofId
    if (typeof id !== 'string' || !id.startsWith('cp-')) return null
    return { data: { images: IMAGES[id] ?? [] }, error: null }
  }
  if (name === 'proof-action') {
    const vid = body?.proof_version_id
    if (typeof vid !== 'string' || !vid.startsWith('cp-')) return null
    recordProofAction(body)
    return { data: { status: 'ok', event_id: 'cp-evt-1' }, error: null }
  }
  if (name === 'proof-contact-submit') {
    const id = body?.proofId
    if (typeof id !== 'string' || !id.startsWith('cp-')) return null
    return { data: { ok: true }, error: null }
  }
  return null
}
