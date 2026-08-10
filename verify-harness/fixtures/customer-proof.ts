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
//   cp-letterpress / cp-gilded  a matched pair differing ONLY in material
//                code, both carrying the same layer-colour trio — the
//                layered-construction gate (un-gilded shows it, gilded
//                doesn't). See src/lib/letterpress.ts.
//   cp-reengage  a Reorder-desk OUTREACH proof (000392): identical in every
//                respect to cp-basic except that its order-state RPC carries
//                a `reengagement` snapshot, which is the only thing that
//                turns the page's opening into the welcome band. Paired with
//                cp-basic in the spec so "the band appears" and "the band
//                stays off an ordinary proof" are tested against fixtures
//                that differ in exactly that one field.
//   cp-reengage-thick  the same outreach proof on a material with a real
//                thickness CHOICE (two priced variants), which is what puts
//                the price grid on its multi-column path. Separate from
//                cp-reengage precisely so that one stays shape-identical to
//                cp-basic; between them the two marker surfaces are covered —
//                the quantity row that single-column proofs (paper, wood,
//                acrylic, carbon fibre) get, and the thickness column that
//                only a multi-variant grid can show.
//   cp-reengage-asked  outreach where the customer has already sent a request,
//                so the band owes them an acknowledgement rather than the ask.
//   cp-reengage-inks  outreach on a material priced by INK COUNT (translucent
//                plastic), whose grid columns read "2 Inks" / "3 Inks". The
//                page must say nothing about those columns while still marking
//                the quantity row.
//   cp-reengage-curated  outreach on a grid the designer curated down, so the
//                thickness they last bought isn't priced here: the grid
//                explains the absence and the thickness guide beside it must
//                agree by badging nothing.
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

// A second thickness, used only by cp-reengage-thick. Kept out of the shared
// MATERIAL_VARIANTS so every other cp- proof keeps its single-column grid.
const VARIANT_ID_300 = 'cp-var-300'
const THICK_VARIANTS = [
  { id: VARIANT_ID_300, material_id: MATERIAL_ID, display_name: '300 micron', variant_type: 'thickness', sort_order: 0 },
  ...MATERIAL_VARIANTS,
]

// ── A material priced by INK COUNT, not by thickness ─────────────────────────
// Translucent Plastic, Satin Plastic and Letterpress are priced per ink, so
// their grid columns read "2 Inks" / "3 Inks". This is the shape that made the
// page tell 822 live customers their remembered "760 micron" was a thickness
// "not available on this order" — under a grid that has never shown a
// thickness. Its own material id so the dimension is unambiguous.
const INK_MATERIAL_ID = 'cp-mat-plastic'
const INK_VARIANTS = [
  { id: 'cp-var-ink2', material_id: INK_MATERIAL_ID, display_name: '2 Inks', variant_type: 'ink_count', sort_order: 0 },
  { id: 'cp-var-ink3', material_id: INK_MATERIAL_ID, display_name: '3 Inks', variant_type: 'ink_count', sort_order: 1 },
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

// The 300µm column prices below the 500µm one, so the two columns are
// distinguishable by value as well as by header.
const THIN_TIERS = PRICE_TIERS.map((t) => ({
  ...t,
  id: `${t.id}-300`,
  material_variant_id: VARIANT_ID_300,
  total_price: t.total_price - 30,
  unit_price: (t.total_price - 30) / t.quantity,
}))

// One priced column per ink count, so the ink fixture lands on the grid's
// multi-column path exactly as a real translucent-plastic proof does.
const INK_TIERS = INK_VARIANTS.flatMap((v, i) =>
  PRICE_TIERS.map((t) => ({
    ...t,
    id: `${t.id}-${v.id}`,
    material_variant_id: v.id,
    total_price: t.total_price + i * 40,
    unit_price: (t.total_price + i * 40) / t.quantity,
  })),
)

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
  // The two letterpress states exist as a PAIR, for the layered-construction
  // gate (src/lib/letterpress.ts). Both carry the identical colour trio —
  // the only difference is the material code — because that is precisely the
  // distinction the page has to make. Un-gilded shows the cross-section;
  // gilded captures the same colours for production (the trio is the paper
  // stock the Stock Control job allocates against) but must NOT show the
  // panel, since the gilding covers the edge being illustrated.
  'cp-letterpress': graph(
    {
      customer_name: 'Iris Bell',
      company: 'Bell Press',
      status: 'in_progress',
      approved_at: null,
      abandoned_at: null,
      disclaimer_acknowledged_at: null,
    },
    [
      version({
        id: 'cp-letterpress-v1',
        proof_id: 'cp-letterpress',
        names: ['Iris Bell'],
        material_code: 'paper_letterpress',
        material_display: 'Letterpress',
        front_colour_name: 'Natural',
        front_colour_hex: '#f4efe4',
        core_colour_name: 'Ebony',
        core_colour_hex: '#1b1b1b',
        back_colour_name: 'Natural',
        back_colour_hex: '#f4efe4',
      }),
    ],
  ),
  'cp-gilded': graph(
    {
      customer_name: 'Otto Vance',
      company: 'Vance & Hall',
      status: 'in_progress',
      approved_at: null,
      abandoned_at: null,
      disclaimer_acknowledged_at: null,
    },
    [
      version({
        id: 'cp-gilded-v1',
        proof_id: 'cp-gilded',
        names: ['Otto Vance'],
        material_code: 'paper_letterpress_gilded',
        material_display: 'Letterpress with gilding',
        front_colour_name: 'Natural',
        front_colour_hex: '#f4efe4',
        core_colour_name: 'Ebony',
        core_colour_hex: '#1b1b1b',
        back_colour_name: 'Natural',
        back_colour_hex: '#f4efe4',
      }),
    ],
  ),
  // The Reorder desk's outreach shape (000392). Deliberately carries NO QR
  // artwork, so the details checklist renders its four base items and the
  // spec can pin the count; the QR item's own gate is unit-tested in
  // src/lib/reengagement.test.ts, where it costs no page load.
  'cp-reengage': graph(
    {
      customer_name: 'Marcus Feld',
      company: 'Feld & Rowe',
      status: 'in_progress',
      approved_at: null,
      abandoned_at: null,
      disclaimer_acknowledged_at: null,
    },
    [
      version({
        id: 'cp-reengage-v1',
        proof_id: 'cp-reengage',
        names: ['Marcus Feld'],
      }),
    ],
  ),
  // Outreach again, but on a grid with a real thickness choice — the shape
  // that lets the page mark the COLUMN they last bought. Two variants keeps
  // it on the left-rail pricing panel (the page splits at >2), so the marked
  // column and the marked quantity row are visible together.
  'cp-reengage-thick': {
    ...graph(
      {
        customer_name: 'Dana Rowe',
        company: 'Rowe Metalworks',
        status: 'in_progress',
        approved_at: null,
        abandoned_at: null,
        disclaimer_acknowledged_at: null,
      },
      [
        version({
          id: 'cp-reengage-thick-v1',
          proof_id: 'cp-reengage-thick',
          names: ['Dana Rowe'],
        }),
      ],
    ),
    material_variants: THICK_VARIANTS,
    price_tiers: [...THIN_TIERS, ...PRICE_TIERS],
  },
  // Outreach where the customer has ALREADY asked. Same shape as cp-reengage
  // in every other respect; the only difference is a reorder_requested_at on
  // the order-state payload, which the band must read back as "we've got it"
  // instead of showing the openings again.
  'cp-reengage-asked': graph(
    {
      customer_name: 'Priya Raval',
      company: 'Raval & Co',
      status: 'in_progress',
      approved_at: null,
      abandoned_at: null,
      disclaimer_acknowledged_at: null,
    },
    [
      version({
        id: 'cp-reengage-asked-v1',
        proof_id: 'cp-reengage-asked',
        names: ['Priya Raval'],
      }),
    ],
  ),
  // Outreach on a material priced by INK COUNT — the shape (Translucent and
  // Satin Plastic, Letterpress) that has no thickness anywhere on the page.
  // The remembered variant is a retired 760µm plastic card, so it resolves to
  // no column here: the page must therefore say NOTHING about the columns,
  // rather than narrate ink counts as though they were thicknesses.
  'cp-reengage-inks': {
    ...graph(
      {
        customer_name: 'Iris Vance',
        company: 'Vance Optics',
        status: 'in_progress',
        approved_at: null,
        abandoned_at: null,
        disclaimer_acknowledged_at: null,
      },
      [
        version({
          id: 'cp-reengage-inks-v1',
          proof_id: 'cp-reengage-inks',
          names: ['Iris Vance'],
          material_id: INK_MATERIAL_ID,
          material_code: 'plastic_translucent',
          material_display: 'Translucent Plastic',
          ink_names: ['Pantone 285 C', 'Pantone 032 C'],
        }),
      ],
    ),
    material_variants: INK_VARIANTS,
    price_tiers: INK_TIERS,
  },
  // Outreach on a grid the designer CURATED down (displayed_variant_ids), so
  // the thickness they last bought isn't priced here. The grid says so; the
  // thickness guide sits directly beside it on the same screen and must not
  // badge the very thickness the grid has just called unavailable.
  'cp-reengage-curated': {
    ...graph(
      {
        customer_name: 'Owen Blake',
        company: 'Blake Instruments',
        status: 'in_progress',
        approved_at: null,
        abandoned_at: null,
        disclaimer_acknowledged_at: null,
      },
      [
        version({
          id: 'cp-reengage-curated-v1',
          proof_id: 'cp-reengage-curated',
          names: ['Owen Blake'],
          // Only the thinner column is offered on this proof — the customer's
          // own 500 micron is priced in the catalogue but not sold here.
          displayed_variant_ids: [VARIANT_ID_300],
        }),
      ],
    ),
    material_variants: THICK_VARIANTS,
    price_tiers: [...THIN_TIERS, ...PRICE_TIERS],
  },
  // EUR sibling of cp-basic (no QR). Exists for the VAT-claim spec: GBP
  // prices are VAT-inclusive, EUR/USD are VAT-free (business rule), so a
  // non-GBP proof must render NO VAT claim anywhere.
  'cp-eur': {
    ...graph(
      {
        customer_name: 'Lena Vogel',
        company: 'Vogel Studio',
        status: 'in_progress',
        approved_at: null,
        abandoned_at: null,
        disclaimer_acknowledged_at: null,
      },
      [
        version({
          id: 'cp-eur-v1',
          proof_id: 'cp-eur',
          currency: 'EUR',
          names: ['Lena Vogel'],
        }),
      ],
    ),
    price_tiers: PRICE_TIERS.map((t) => ({ ...t, id: `${t.id}-eur`, currency: 'EUR' })),
  },
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
  'cp-reengage': [
    img({ id: 'cp-reengage-front', proof_version_id: 'cp-reengage-v1', associated_name: 'Marcus Feld', side: 'front', signed_url: art('#334155', 'Marcus front') }),
    img({ id: 'cp-reengage-back', proof_version_id: 'cp-reengage-v1', associated_name: 'Marcus Feld', side: 'back', signed_url: art('#1e293b', 'Marcus back') }),
  ],
  'cp-reengage-thick': [
    img({ id: 'cp-reengage-thick-front', proof_version_id: 'cp-reengage-thick-v1', associated_name: 'Dana Rowe', side: 'front', signed_url: art('#334155', 'Dana front') }),
    img({ id: 'cp-reengage-thick-back', proof_version_id: 'cp-reengage-thick-v1', associated_name: 'Dana Rowe', side: 'back', signed_url: art('#1e293b', 'Dana back') }),
  ],
  'cp-reengage-inks': [
    img({ id: 'cp-reengage-inks-front', proof_version_id: 'cp-reengage-inks-v1', associated_name: 'Iris Vance', side: 'front', signed_url: art('#0f766e', 'Iris front') }),
  ],
  'cp-reengage-curated': [
    img({ id: 'cp-reengage-curated-front', proof_version_id: 'cp-reengage-curated-v1', associated_name: 'Owen Blake', side: 'front', signed_url: art('#334155', 'Owen front') }),
  ],
  'cp-eur': [
    img({ id: 'cp-eur-front', proof_version_id: 'cp-eur-v1', associated_name: 'Lena Vogel', side: 'front', signed_url: art('#4a1d6e', 'Lena front') }),
  ],
}

// The reorder register's display-safe snapshot, per outreach fixture — the
// ONE field that separates an outreach proof from an ordinary one, which is
// why it lives in its own map rather than inline in the RPC branch.
//
// The last four keys are what the page points AT (the quantity row, the
// thickness column, the matching row of the thickness guide). They carry real
// catalogue ids from the shared slice above, because the markers match on ID:
// pointing them at a plausible-looking string would render nothing and the
// specs would pass by agreeing that nothing should be marked.
const REENGAGEMENT_SNAPSHOTS: Record<string, any> = {
  'cp-reengage': {
    last_order_on: '2024-03-18',
    orders_count: 4,
    // Matches the fixture version's material, so the spec branch of
    // recognitionLine is the one under test (a mismatch would be
    // suppressed and silently fall back to the date-only sentence).
    last_spec: '250 stainless steel cards (500 micron)',
    // 250 is in the version's curated display_quantities, so the marker has
    // a row to land on; the single-variant grid has no column to mark.
    last_qty: 250,
    last_variant_id: VARIANT_ID,
    last_variant_label: '500 micron',
    last_material_id: MATERIAL_ID,
  },
  'cp-reengage-thick': {
    last_order_on: '2024-03-18',
    orders_count: 4,
    last_spec: '250 stainless steel cards (500 micron)',
    last_qty: 250,
    // The THICKER of the two columns, so a marker on the first column would
    // be a visible failure rather than an accident that happens to look right.
    last_variant_id: VARIANT_ID,
    last_variant_label: '500 micron',
    last_material_id: MATERIAL_ID,
  },
  'cp-reengage-asked': {
    last_order_on: '2024-03-18',
    orders_count: 4,
    last_spec: '250 stainless steel cards (500 micron)',
    last_qty: 250,
    last_variant_id: VARIANT_ID,
    last_variant_label: '500 micron',
    last_material_id: MATERIAL_ID,
  },
  // ⚠ The 822-row shape. A real past purchase of a 760µm translucent plastic
  // card, on a material the page prices by INK COUNT. The variant id is a real
  // uuid the catalogue no longer returns (retired), which is what used to make
  // the page read "label present, id not offered" as not-available and print
  // "…the thicknesses above are the current options" beneath "2 Inks / 3 Inks".
  // The quantity, by contrast, must still be marked: on a grid like this it is
  // the only marker there is.
  'cp-reengage-inks': {
    last_order_on: '2024-03-18',
    orders_count: 4,
    last_spec: '250 translucent plastic cards (760 micron)',
    last_qty: 250,
    last_variant_id: 'cp-var-760-retired',
    last_variant_label: '760 micron',
    last_material_id: INK_MATERIAL_ID,
  },
  // Their thickness is real and in the catalogue — it is simply not priced on
  // THIS proof, so the grid explains the absence. The guide beside it must
  // stay silent rather than badge the row the grid just ruled out.
  'cp-reengage-curated': {
    last_order_on: '2024-03-18',
    orders_count: 4,
    last_spec: '250 stainless steel cards (500 micron)',
    last_qty: 250,
    last_variant_id: VARIANT_ID,
    last_variant_label: '500 micron',
    last_material_id: MATERIAL_ID,
  },
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
  if (name === 'public_get_proof_order_state') {
    const id = args?.p_proof_id
    if (typeof id !== 'string' || !id.startsWith('cp-')) return null
    const reengagement = REENGAGEMENT_SNAPSHOTS[id]
    if (reengagement) {
      // The fixtures the Reorder desk created. `state: 'none'` is the honest
      // shape — an outreach proof has no order yet — so nothing here renders
      // an ordering surface; the `reengagement` snapshot is the whole
      // difference from every other cp- proof. Keys the live RPC would omit
      // (jsonb_strip_nulls) are omitted here too, so the parser's defaults
      // are exercised rather than bypassed.
      // ⚠ The stamp rides the SAME payload, outside the order-shaped part —
      // which is the whole point of 000401. Before that hoist it lived inside
      // a coalesce that collapses to {"state":"none"} on a proof with no
      // order, so the band could never learn that its own request had landed
      // and re-asked a customer who had already answered.
      return {
        data: {
          state: 'none',
          reengagement,
          ...(id === 'cp-reengage-asked'
            ? { reorder_requested_at: '2026-08-08T10:15:00Z' }
            : {}),
        },
        error: null,
      }
    }
    // No order exists on any other cp- fixture: the parse-guarded consumers
    // treat null as "no card at all", which keeps the order surfaces out of
    // shot — and, since the snapshot rides this same payload, keeps the
    // re-engagement band off every ordinary proof.
    return { data: null, error: null }
  }
  if (name === 'public_get_cheaper_alternatives') {
    const id = args?.p_proof_id
    if (typeof id !== 'string' || !id.startsWith('cp-')) return null
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
