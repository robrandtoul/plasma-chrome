// Fixture-backed stand-in for src/lib/supabase.ts, aliased in by
// vite.verify.config.ts. Lets the designer pages render against realistic
// local data with no Supabase project, no auth and no network — for visual
// verification (Playwright screenshots) of UI changes.
//
// Implementation: a generic thenable query builder. Any chained method call
// records itself and returns the builder; awaiting it resolves fixtures keyed
// on (schema, table, select string, filters). Unknown tables resolve to empty
// lists so unrelated chrome (badges etc.) never breaks the page under test.

/* eslint-disable @typescript-eslint/no-explicit-any */

const now = Date.now()
const daysAgo = (n: number) => new Date(now - n * 864e5).toISOString()
const daysAhead = (n: number) => new Date(now + n * 864e5).toISOString()

// ——— tiny inline artwork so cards render a thumbnail ———
function swatch(colour: string, label: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" rx="18" fill="${colour}"/><text x="80" y="88" font-family="sans-serif" font-size="20" fill="#ffffff" text-anchor="middle">${label}</text></svg>`
  return `data:image/svg+xml;base64,${btoa(svg)}`
}

// ——— shared shapes ———
const steel = { code: 'metal_steel', display_name: 'Stainless Steel', production_route: 'in_house', lead_time_max_days: 5, outsourced_supplier_ids: [] as string[] }
const letterpress = { code: 'paper_letterpress', display_name: 'Letterpress', production_route: 'supplier', lead_time_max_days: 7, outsourced_supplier_ids: ['s1'] }
const satin = { code: 'plastic_satin', display_name: 'Satin Plastic', production_route: 'in_house', lead_time_max_days: 4, outsourced_supplier_ids: [] as string[] }

function contact(company: string | null, name: string) {
  return { full_name: name, companies: company ? { name: company } : null }
}

interface FixtureOrder {
  [key: string]: any
}

function order(partial: FixtureOrder): FixtureOrder {
  return {
    id: partial.id,
    status: 'sent',
    token: 'tok',
    expires_at: daysAhead(10),
    sent_at: daysAgo(2),
    pay_link_opened_at: null,
    help_requested_at: null,
    thickness_open: false,
    finish_open: false,
    quantity_open: false,
    order_group_id: null,
    material_id: 'm-steel',
    material_variant_id: 'v-steel',
    material_option_id: null,
    currency: 'GBP',
    quantity: 500,
    names_count: 1,
    has_personalisation: false,
    custom_quote_total: null,
    amount_cards: 449,
    amount_tooling: 0,
    amount_personalisation: 0,
    amount_shipping: 12.9,
    amount_us_tariff: 0,
    card_discount_type: 'none',
    card_discount_value: null,
    amount_card_discount: null,
    payment_method: 'online',
    order_kind: 'production',
    payment_reference: `ORD-${String(partial.id).toUpperCase()}`,
    xero_invoice_id: null,
    xero_invoice_error: null,
    paid_at: null,
    fulfilled_at: null,
    revised_at: null,
    date_required: null,
    dropbox_folder_url: null,
    stock_order_number: null,
    project_name: null,
    stock_colour: null,
    person_quantities: null,
    artwork_check_verdict: null,
    artwork_checked_at: null,
    artwork_check: null,
    ship_dest_country: 'GB',
    ship_to_name: null,
    ship_to_email: null,
    ship_to_phone: null,
    customs_tax_id: null,
    ship_to_address: null,
    created_at: daysAgo(12),
    material_variants: { display_name: '500 micron', materials: steel },
    material_options: null,
    proofs: {
      helpscout_last_reply_at: daysAgo(3),
      helpscout_last_customer_reply_at: null,
      helpscout_conversation_id: 'hs-1',
      contacts: contact('Acme Ltd', 'Ada Lovelace'),
    },
    ...partial,
  }
}

// The artwork sanity-check report fixture (000336) — shared by the
// artwork-check invoke branch (OrderReviewPage's live card) and the
// orders rows below (the OrdersPage chip + report modal).
const ARTWORK_REPORT_FLAGGED = {
  verdict: 'defect',
  summary: '1 flag: the printed email drops a letter vs the request form; plus a later correction not picked up.',
  cards: [
    {
      label: 'Derrick Smith — front/back',
      findings: [
        { field: 'name', supplied: 'Derrick Smith (request form)', printed: 'Derrick Smith', status: 'match', severity: 'review', note: '' },
        { field: 'email', supplied: 'derrick@plak8.com (request form)', printed: 'derick@plak8.com', status: 'flag', severity: 'defect', note: 'printed email drops an “r” vs what the customer supplied — the address won’t work' },
        { field: 'job_title', supplied: '', printed: 'Operations Director', status: 'not_supplied', severity: 'review', note: '' },
      ],
    },
  ],
  corrections: [
    { quote: 'Sorry — mobile should be 07700 900456, not 900123 (12 Jul)', resolved: false, severity: 'defect', note: 'card still shows 07700 900123' },
  ],
  notes: ['metal cut-through back — logo mirrored as expected'],
  reference_gaps: ['details for Jo Bloggs supplied as attachment details.xlsx (not read)'],
  checked_at: '2026-07-21T10:30:00Z',
}
const ARTWORK_REPORT_CLEAR = {
  ...ARTWORK_REPORT_FLAGGED,
  verdict: 'clear',
  summary: 'All clear — every printed detail matches what the customer supplied.',
  cards: [
    {
      label: 'Richard Hendricks — front',
      findings: [
        { field: 'name', supplied: 'Richard Hendricks (request form)', printed: 'Richard Hendricks', status: 'match', severity: 'review', note: '' },
        { field: 'email', supplied: 'richard@piedpiper.com (request form)', printed: 'richard@piedpiper.com', status: 'match', severity: 'review', note: '' },
      ],
    },
  ],
  corrections: [],
  notes: [],
  reference_gaps: [],
}

const ORDERS: FixtureOrder[] = [
  // Awaiting payment — fresh link, one reminder sent, opened yesterday.
  order({
    id: 'o1',
    sent_at: daysAgo(3),
    pay_link_opened_at: daysAgo(1),
    proofs: { helpscout_last_reply_at: daysAgo(4), helpscout_last_customer_reply_at: null, helpscout_conversation_id: 'hs-1', contacts: contact('Acme Ltd', 'Ada Lovelace') },
  }),
  // Awaiting payment — EXPIRED link (goes cold + reactivate path).
  order({
    id: 'o2',
    sent_at: daysAgo(20),
    expires_at: daysAgo(3),
    material_id: 'm-lp',
    material_variant_id: 'v-lp',
    material_variants: { display_name: '2 colours', materials: letterpress },
    proofs: { helpscout_last_reply_at: null, helpscout_last_customer_reply_at: null, helpscout_conversation_id: 'hs-2', contacts: contact(null, 'Ken Ng') },
  }),
  // Awaiting payment — open-spec (customer picks quantity + thickness),
  // member of the combined-payment group g1.
  order({
    id: 'o3',
    quantity: null,
    quantity_open: true,
    thickness_open: true,
    material_variant_id: null,
    material_variants: null,
    amount_cards: null,
    order_group_id: 'g1',
    proofs: { helpscout_last_reply_at: daysAgo(1), helpscout_last_customer_reply_at: null, helpscout_conversation_id: 'hs-3', contacts: contact('Globex', 'Hank Scorpio') },
    help_requested_at: daysAgo(0.2),
  }),
  // Awaiting payment — second member of group g1.
  order({
    id: 'o4',
    quantity: 250,
    order_group_id: 'g1',
    proofs: { helpscout_last_reply_at: daysAgo(1), helpscout_last_customer_reply_at: null, helpscout_conversation_id: 'hs-3', contacts: contact('Globex', 'Hank Scorpio') },
  }),
  // Awaiting payment — two more standalone orders so the Combine control
  // still has 2+ eligible candidates with g1's members locked away.
  order({
    id: 'o11',
    quantity: 350,
    sent_at: daysAgo(1),
    proofs: { helpscout_last_reply_at: daysAgo(1), helpscout_last_customer_reply_at: null, helpscout_conversation_id: 'hs-7', contacts: contact('Initech', 'Bill Lumbergh') },
  }),
  // To order — paid but the Xero invoice FAILED (auto-expands, retry in view).
  order({
    id: 'o5',
    status: 'paid',
    paid_at: daysAgo(1),
    xero_invoice_error: 'Validation Exception {"Elements":[{"ValidationErrors":[{"Message":"Account code 0148 is not valid"}]}]}',
    ship_to_name: 'Ada Lovelace',
    ship_to_address: { line1: '1 Analytical Way', city: 'London', postal_code: 'EC1A 1AA', country: 'GB' },
    ship_to_phone: '+44 20 7946 0000',
  }),
  // To order — paid, satin (stock-colour gate), nothing prepped yet.
  order({
    id: 'o6',
    status: 'paid',
    paid_at: daysAgo(0.5),
    material_id: 'm-satin',
    material_variant_id: 'v-satin',
    material_variants: { display_name: '420 micron', materials: satin },
    xero_invoice_id: 'xi-1',
    person_quantities: [
      { name: 'Hank Scorpio', quantity: 300 },
      { name: 'Frank Grimes', quantity: 200 },
    ],
    card_discount_type: 'percent',
    card_discount_value: 10,
    amount_card_discount: 44.9,
    ship_to_name: 'Hank Scorpio',
    ship_to_email: 'hank.scorpio@globex.example',
    ship_to_phone: '+44 161 496 0000',
    ship_to_address: { line1: 'Globex Campus', city: 'Cypress Creek', region: 'Cypress County', postal_code: 'CC1 2GX', country: 'GB' },
    proofs: { helpscout_last_reply_at: null, helpscout_last_customer_reply_at: null, helpscout_conversation_id: 'hs-3', contacts: contact('Globex', 'Hank Scorpio') },
  }),
  // Shipping readiness — offline paid, international, nothing captured at
  // checkout: exercises the worklist (no address/phone/name, unknown
  // destination 'ZZ', card weight unrecorded on a weight-rated lane).
  order({
    id: 'o12',
    status: 'paid',
    payment_method: 'offline',
    paid_at: daysAgo(1),
    ship_dest_country: 'ZZ',
    amount_shipping: 0,
    xero_invoice_id: 'xi-3',
    proofs: { helpscout_last_reply_at: null, helpscout_last_customer_reply_at: null, helpscout_conversation_id: null, contacts: contact('Umbrella Corp', 'Alice Wesker') },
  }),
  // To order — paid, supplier route, folder + date already saved (ready).
  order({
    id: 'o7',
    status: 'paid',
    paid_at: daysAgo(2),
    material_id: 'm-lp',
    material_variant_id: 'v-lp',
    material_variants: { display_name: '2 colours', materials: letterpress },
    xero_invoice_id: 'xi-2',
    date_required: daysAhead(7).slice(0, 10),
    dropbox_folder_url: 'https://www.dropbox.com/scl/fo/abc/order-1234',
    stock_order_number: '1234',
    project_name: 'Letterpress relaunch',
    artwork_check_verdict: 'defect',
    artwork_checked_at: daysAgo(0.2),
    artwork_check: ARTWORK_REPORT_FLAGGED,
    proofs: { helpscout_last_reply_at: null, helpscout_last_customer_reply_at: null, helpscout_conversation_id: 'hs-4', contacts: contact('Initech', 'Bill Lumbergh') },
  }),
  // Being revised — paid + placed, artwork being redone.
  order({
    id: 'o8',
    status: 'revision',
    paid_at: daysAgo(9),
    fulfilled_at: daysAgo(6),
    revised_at: daysAgo(1),
    xero_invoice_id: 'xi-3',
    proofs: { helpscout_last_reply_at: null, helpscout_last_customer_reply_at: null, helpscout_conversation_id: 'hs-5', contacts: contact('Hooli', 'Gavin Belson') },
  }),
  // Recently ordered.
  order({ id: 'o9', status: 'fulfilled', paid_at: daysAgo(8), fulfilled_at: daysAgo(5), artwork_check_verdict: 'clear', artwork_checked_at: daysAgo(5), artwork_check: ARTWORK_REPORT_CLEAR, proofs: { helpscout_last_reply_at: null, helpscout_last_customer_reply_at: null, helpscout_conversation_id: null, contacts: contact('Pied Piper', 'Richard Hendricks') } }),
  order({ id: 'o10', status: 'fulfilled', paid_at: daysAgo(15), fulfilled_at: daysAgo(12), proofs: { helpscout_last_reply_at: null, helpscout_last_customer_reply_at: null, helpscout_conversation_id: null, contacts: contact(null, 'Jian Yang') } }),
].map((o, i) => ({ ...o, proof_id: `p-${o.id}` }))

// Approved proofs with no order yet — the Links-to-send worklist. approved_at
// must postdate the earliest order created_at (the go-live cutoff in
// keepApprovedNoOrder), which is daysAgo(12) above.
const DASHBOARD_PROJECTS = [
  {
    proof_id: 'p-a1',
    status: 'approved',
    current_version_id: 'ver-a1',
    current_version_number: 2,
    version_created_at: daysAgo(6),
    company_name: null,
    contact_name: 'Ken Ng',
    contact_email: 'kenngkchk@gmail.com',
    approved_at: daysAgo(5),
    material_display: 'Stainless Steel',
    designer_name: 'Rob Randtoul',
    designer_initials: 'RR',
    designer_colour: 'blue',
    designer_avatar_url: null,
    helpscout_conversation_url: 'https://secure.helpscout.net/conversation/1',
    helpscout_conversation_id: 'hs-2',
    helpscout_last_reply_at: daysAgo(6),
    helpscout_last_customer_reply_at: null,
  },
  {
    proof_id: 'p-a2',
    status: 'approved',
    current_version_id: 'ver-a2',
    current_version_number: 1,
    version_created_at: daysAgo(2),
    company_name: 'Vandelay Industries',
    contact_name: 'Art Vandelay',
    contact_email: 'art@vandelay.example',
    approved_at: daysAgo(0.2),
    material_display: 'Letterpress',
    designer_name: 'Chris Jackson',
    designer_initials: 'CJ',
    designer_colour: 'teal',
    designer_avatar_url: null,
    helpscout_conversation_url: 'https://secure.helpscout.net/conversation/2',
    helpscout_conversation_id: 'hs-6',
    helpscout_last_reply_at: daysAgo(1),
    helpscout_last_customer_reply_at: daysAgo(0.05),
  },
]

// ——— Flagged board fixtures (watch_items / watch_updates) ———
// Shaped to exercise the card's widest content on mobile: a full pill row
// (category + status + overdue date + customer-replied) and, when expanded,
// the Links row with all four buttons (Project / Start reprint / Help Scout /
// Remove — the last two need a conversation url + own-authored row).
const WATCH_ITEMS = [
  {
    id: 'w1',
    proof_id: 'p-a1',
    category: 'quality_complaint',
    status: 'open',
    ordered_on: daysAgo(20),
    due_on: daysAgo(2).slice(0, 10),
    company_name: 'Acme Corporation International',
    contact_name: 'Ada Lovelace',
    designer_name: 'Rob Randtoul',
    stock_order_number: '10234',
    helpscout_conversation_url: 'https://secure.helpscout.net/conversation/1',
    created_by: 'user-rob',
    created_by_name: 'Rob Randtoul',
    created_by_initials: 'RR',
    created_by_colour: 'blue',
    status_changed_at: null,
    status_changed_by: null,
    status_changed_by_name: null,
    created_at: daysAgo(5),
    updated_at: daysAgo(1),
  },
  {
    id: 'w2',
    proof_id: 'p-a2',
    category: 'lost_in_transit',
    status: 'monitoring',
    ordered_on: daysAgo(30),
    due_on: null,
    company_name: 'Vandelay Industries',
    contact_name: 'Art Vandelay',
    designer_name: 'Chris Jackson',
    stock_order_number: '10235',
    helpscout_conversation_url: 'https://secure.helpscout.net/conversation/2',
    created_by: 'user-rob',
    created_by_name: 'Rob Randtoul',
    created_by_initials: 'RR',
    created_by_colour: 'blue',
    status_changed_at: daysAgo(1),
    status_changed_by: 'user-rob',
    status_changed_by_name: 'Rob Randtoul',
    created_at: daysAgo(8),
    updated_at: daysAgo(1),
  },
]

const WATCH_UPDATES = [
  { id: 'u1', watch_item_id: 'w1', kind: 'note', body: 'Customer reported the foiling has lifted on a run of cards — asked them to send a photo.', created_by: 'user-rob', created_by_name: 'Rob Randtoul', created_by_initials: 'RR', created_by_colour: 'blue', helpscout_thread_id: null, created_at: daysAgo(4) },
  { id: 'u2', watch_item_id: 'w1', kind: 'phone_call', body: 'Called Ada — she is happy for us to reprint the affected 200.', created_by: 'user-rob', created_by_name: 'Rob Randtoul', created_by_initials: 'RR', created_by_colour: 'blue', helpscout_thread_id: null, created_at: daysAgo(2) },
  { id: 'u3', watch_item_id: 'w1', kind: 'helpscout_customer', body: 'Any update on the reprint? Thanks.', created_by: null, created_by_name: 'Ada Lovelace', created_by_initials: null, created_by_colour: null, helpscout_thread_id: 'ht1', created_at: daysAgo(1) },
  { id: 'u4', watch_item_id: 'w2', kind: 'note', body: 'Tracking shows the parcel stuck at the depot — opened a claim with the courier.', created_by: 'user-rob', created_by_name: 'Rob Randtoul', created_by_initials: 'RR', created_by_colour: 'blue', helpscout_thread_id: null, created_at: daysAgo(3) },
]

const PROOF_MATERIAL: Record<string, string> = {
  'p-o1': 'metal_steel', 'p-o2': 'paper_letterpress', 'p-o3': 'metal_steel', 'p-o4': 'metal_steel',
  'p-o5': 'metal_steel', 'p-o6': 'plastic_satin', 'p-o7': 'paper_letterpress', 'p-o8': 'metal_steel',
  'p-o9': 'metal_steel', 'p-o10': 'metal_steel', 'p-a1': 'metal_steel', 'p-a2': 'paper_letterpress',
}

const THUMB_COLOUR: Record<string, string> = {
  'p-o1': '#4b5563', 'p-o2': '#7c2d12', 'p-o3': '#1e3a5f', 'p-o4': '#3f6212',
  'p-o5': '#6d28d9', 'p-o6': '#0e7490', 'p-o7': '#9d174d', 'p-o8': '#b45309',
  'p-a1': '#374151', 'p-a2': '#701a75',
}

// ——— generic thenable builder ———

interface QueryState {
  schema: string
  table: string
  select: string
  single: boolean
  head: boolean
  filters: Record<string, any>
}

// Multiple team members (not just Rob) so the chat thread-pill row and presence
// strip get realistic width to stress-test for overflow, and so the Edit-profile
// colour picker has colours genuinely taken by someone else.
const PROFILES = [
  { id: 'user-rob', designer_initials: 'RR', designer_colour: 'blue', full_name: 'Rob Randtoul', avatar_url: null, feedback_seen_at: null, team_chat_seen_at: null, deactivated_at: null },
  { id: 'user-chris', designer_initials: 'CJ', designer_colour: 'teal', full_name: 'Christopher Jackson-Whitmore', avatar_url: null, feedback_seen_at: null, team_chat_seen_at: null, deactivated_at: null },
  { id: 'user-donna', designer_initials: 'DL', designer_colour: 'coral', full_name: 'Donna Lambe', avatar_url: null, feedback_seen_at: null, team_chat_seen_at: null, deactivated_at: null },
  { id: 'user-jack', designer_initials: 'JJ', designer_colour: 'purple', full_name: 'Jack Johnson', avatar_url: null, feedback_seen_at: null, team_chat_seen_at: null, deactivated_at: null },
]

// Feedback-board fixtures, mirroring the live board's shape (long titles,
// area labels, mixed priorities/types/statuses) so the mobile-width overflow
// on /feedback can be reproduced and verified headlessly.
const FEEDBACK_ITEMS = [
  { id: 'fb-1', created_by: 'user-chris', created_by_name: 'Chris Jackson', created_by_initials: 'CJ', created_by_colour: 'teal', type: 'improvement', priority: 'low', title: 'Stock order email threads linking in internal side panel', body: 'Would be handy to jump straight to the thread.', area: 'Open in house orders', status: 'under_review', admin_note: null, resolution_note: null, attachment_paths: ['feedback/shot-1.png'], status_changed_at: daysAgo(4), status_changed_by: null, status_changed_by_name: null, created_at: daysAgo(21), updated_at: daysAgo(4) },
  { id: 'fb-2', created_by: 'user-rob', created_by_name: 'Rob Randtoul', created_by_initials: 'RR', created_by_colour: 'blue', type: 'improvement', priority: 'high', title: 'Collect VAT number at checkout', body: null, area: 'Checkout, Stock Control', status: 'new', admin_note: null, resolution_note: null, attachment_paths: [], status_changed_at: null, status_changed_by: null, status_changed_by_name: null, created_at: daysAgo(0.13), updated_at: daysAgo(0.13) },
  { id: 'fb-3', created_by: 'user-rob', created_by_name: 'Rob Randtoul', created_by_initials: 'RR', created_by_colour: 'blue', type: 'improvement', priority: 'high', title: 'Currency enforcement', body: null, area: 'New version page', status: 'new', admin_note: null, resolution_note: null, attachment_paths: [], status_changed_at: null, status_changed_by: null, status_changed_by_name: null, created_at: daysAgo(0.7), updated_at: daysAgo(0.7) },
  { id: 'fb-4', created_by: 'user-rob', created_by_name: 'Rob Randtoul', created_by_initials: 'RR', created_by_colour: 'blue', type: 'improvement', priority: 'high', title: 'Edit shipping address', body: null, area: 'Stock Control', status: 'new', admin_note: null, resolution_note: null, attachment_paths: [], status_changed_at: null, status_changed_by: null, status_changed_by_name: null, created_at: daysAgo(0.75), updated_at: daysAgo(0.75) },
  { id: 'fb-5', created_by: 'user-rob', created_by_name: 'Rob Randtoul', created_by_initials: 'RR', created_by_colour: 'blue', type: 'idea', priority: 'high', title: 'Integrate artwork sanity check', body: null, area: 'Orders', status: 'new', admin_note: null, resolution_note: null, attachment_paths: [], status_changed_at: null, status_changed_by: null, status_changed_by_name: null, created_at: daysAgo(0.76), updated_at: daysAgo(0.76) },
  { id: 'fb-6', created_by: 'user-rob', created_by_name: 'Rob Randtoul', created_by_initials: 'RR', created_by_colour: 'blue', type: 'idea', priority: 'medium', title: 'Verify specs of Dermids proofs', body: null, area: 'Order page', status: 'new', admin_note: null, resolution_note: null, attachment_paths: [], status_changed_at: null, status_changed_by: null, status_changed_by_name: null, created_at: daysAgo(0.03), updated_at: daysAgo(0.03) },
  { id: 'fb-7', created_by: 'user-rob', created_by_name: 'Rob Randtoul', created_by_initials: 'RR', created_by_colour: 'blue', type: 'bug', priority: 'medium', title: 'Fix feedback page on mobile', body: 'It all spills over the right edge.', area: 'Feedback page', status: 'new', admin_note: null, resolution_note: null, attachment_paths: [], status_changed_at: null, status_changed_by: null, status_changed_by_name: null, created_at: daysAgo(0.13), updated_at: daysAgo(0.13) },
]

function resolveQuery(state: QueryState): { data: any; error: null; count?: number } {
  const { table, select, single, filters } = state
  let rows: any[] = []

  if (state.schema === 'public') {
    if (table === 'outsourced_suppliers') rows = [{ id: 's1', name: 'QX Metals' }]
    else if (table === 'materials') {
      // Two callers read Stock Control's catalogue: the stock-colour picker
      // (selects swatch_hex etc.) and the Stock materials mapping tab
      // (selects id, name). Key on the select string so each gets its shape.
      rows = select.includes('swatch_hex')
        ? [
            { name: 'Satin Black', swatch_hex: '#1f2937', quantity_on_shelf: 240, measured_in: 'sheets' },
            { name: 'Satin White', swatch_hex: '#f9fafb', quantity_on_shelf: 80, measured_in: 'sheets' },
          ]
        : [
            { id: 'sc-carbon', name: 'Carbon Fibre 0.5mm' },
            { id: 'sc-fcp', name: 'Full Colour Plastic' },
            { id: 'sc-paper', name: 'Premium Smooth White 600gsm' },
            { id: 'sc-steel', name: 'Stainless Steel 0.5mm' },
          ]
    }
  } else if (table === 'materials') {
    // The proof-viewer catalogue, as the Catalogue data grids read it
    // (Stock materials mapping tab; also gives Lead times a few rows).
    // Mix of mapped / unmapped / auto-resolved codes, plus one saved id
    // that no longer exists in the Stock Control list ('sc-gone') to
    // exercise the "Unknown material" option.
    rows = [
      { id: 'm-cf', code: 'carbon_fibre', display_name: 'Carbon Fibre', category: 'Carbon fibre', production_route: 'supplier', stock_material_id: null },
      { id: 'm-steel', code: 'metal_steel', display_name: 'Stainless Steel', category: 'Metal', production_route: 'in_house', stock_material_id: 'sc-steel' },
      { id: 'm-gold', code: 'metal_gold', display_name: 'Gold Metal', category: 'Metal', production_route: 'in_house', stock_material_id: null },
      { id: 'm-lp', code: 'paper_letterpress', display_name: 'Letterpress', category: 'Paper', production_route: 'supplier', stock_material_id: null },
      { id: 'm-paper', code: 'paper_standard', display_name: 'Standard Paper', category: 'Paper', production_route: 'supplier', stock_material_id: 'sc-paper' },
      { id: 'm-fcp', code: 'plastic_full_colour', display_name: 'Full Colour Plastic', category: 'Plastic', production_route: 'in_house', stock_material_id: 'sc-gone' },
      { id: 'm-satin', code: 'plastic_satin', display_name: 'Satin Plastic', category: 'Plastic', production_route: 'in_house', stock_material_id: null },
      { id: 'm-wood', code: 'wood', display_name: 'Wood', category: 'Wood', production_route: 'in_house', stock_material_id: null },
    ]
  } else if (table === 'orders') {
    rows = ORDERS
    if (Array.isArray(filters['in:status'])) rows = rows.filter((r) => filters['in:status'].includes(r.status))
    if (filters['eq:id']) rows = rows.filter((r) => r.id === filters['eq:id'])
  } else if (table === 'public_dashboard_projects') {
    rows = DASHBOARD_PROJECTS
    if (filters['eq:status']) rows = rows.filter((r) => r.status === filters['eq:status'])
  } else if (table === 'order_link_notes') {
    rows = [{ proof_id: 'p-a1', note: 'Waiting on metal thickness — chased today.', created_by_name: 'Chris Jackson', created_by_initials: 'CJ', created_by_colour: 'teal', updated_at: daysAgo(0.1) }]
  } else if (table === 'proof_versions') {
    if (select.includes('materials(code)')) {
      const ids: string[] = filters['in:proof_id'] ?? []
      rows = ids.map((pid) => ({ proof_id: pid, materials: { code: PROOF_MATERIAL[pid] ?? 'metal_steel' } }))
    } else {
      const pid = filters['eq:proof_id']
      rows = pid ? [{ id: `ver-${pid}`, material_id: ORDERS.find((o) => o.proof_id === pid)?.material_id ?? 'm-steel', is_current: true, version_number: 3, shape: null }] : []
    }
  } else if (table === 'proofs') {
    rows = [{ approved_at: daysAgo(1) }]
  } else if (table === 'proof_version_images') {
    // Two approved files (front + back, shared artwork) so the To-order card's
    // Approved artwork panel renders a populated list.
    rows = [
      { id: 'img-front', image_path: 'proofs/approved-front.pdf', original_filename: 'Approved_Front.pdf', associated_name: null, side: 'front', layout_id: null },
      { id: 'img-back', image_path: 'proofs/approved-back.pdf', original_filename: 'Approved_Back.pdf', associated_name: null, side: 'back', layout_id: null },
    ]
  } else if (table === 'settings') {
    rows = [{ ordering_enabled: true, order_reminders_max: 3, order_reminder_interval_days: 3, auto_order_reminders_enabled: true, artwork_check_mode: 'live', artwork_check_required: false, artwork_check_model: null, proof_check_enabled: true }]
  } else if (table === 'site_settings') {
    rows = [{ needs_attention_rules: { helpscout_reply_grace_days: 3 } }]
  } else if (table === 'order_nudges') {
    rows = [
      { order_id: 'o1', reminder_no: 1, state: 'sent', outcome: 'sent', created_at: daysAgo(1) },
      { order_id: 'o2', reminder_no: 1, state: 'sent', outcome: 'sent', created_at: daysAgo(14) },
      { order_id: 'o2', reminder_no: 2, state: 'sent', outcome: 'sent', created_at: daysAgo(10) },
      { order_id: 'o2', reminder_no: 3, state: 'sent', outcome: 'sent', created_at: daysAgo(7) },
    ]
    if (Array.isArray(filters['in:order_id'])) rows = rows.filter((r) => filters['in:order_id'].includes(r.order_id))
  } else if (table === 'order_groups') {
    rows = [{ id: 'g1', status: 'sent', currency: 'GBP', token: 'gtok', payment_reference: 'GRP-TEST01', expires_at: daysAhead(12), pay_link_opened_at: null, xero_invoice_id: null, xero_invoice_error: null }]
    if (Array.isArray(filters['in:id'])) rows = rows.filter((r) => filters['in:id'].includes(r.id))
  } else if (table === 'profiles') {
    rows = [...PROFILES]
    if (single) rows = rows.filter((r) => r.id === (filters['eq:id'] ?? 'user-rob'))
  } else if (table === 'team_messages') {
    // Edge-case content on purpose: a long unbroken URL (the classic
    // flex/overflow trigger) and a long, space-free attachment filename.
    rows = [
      {
        id: 'msg-1', author_id: 'user-jack', author_name: 'Jack Johnson', author_initials: 'JJ', author_colour: 'purple',
        body: 'How’s the holiday', mentioned_user_ids: null, recipient_id: null,
        attachment_paths: null, attachment_files: null, created_at: daysAgo(0.02),
      },
      {
        id: 'msg-2', author_id: 'user-rob', author_name: 'Rob Randtoul', author_initials: 'RR', author_colour: 'blue',
        body: 'Check this out https://www.dropbox.com/scl/fo/verylongfoldertoken1234567890abcdefghijklmnopqrstuvwxyz/order-artwork-final-approved-v3?dl=0&rlkey=abcdefghijklmnopqrstuvwxyz1234567890',
        mentioned_user_ids: null, recipient_id: null, attachment_paths: null, attachment_files: null, created_at: daysAgo(0.015),
      },
      {
        id: 'msg-3', author_id: 'user-chris', author_name: 'Christopher Jackson-Whitmore', author_initials: 'CJ', author_colour: 'teal',
        body: 'Attaching the print-ready file', mentioned_user_ids: null, recipient_id: null,
        attachment_paths: ['chat/fixture-1.pdf'],
        attachment_files: [{ path: 'chat/fixture-1.pdf', name: 'AcmeCorporationBusinessCards_FrontAndBack_FINAL_APPROVED_FOR_PRINT_2026.pdf', type: 'application/pdf', size: 4_200_000 }],
        created_at: daysAgo(0.01),
      },
    ]
  } else if (table === 'feedback_items') {
    rows = FEEDBACK_ITEMS
    if (filters['eq:created_by']) rows = rows.filter((r) => r.created_by === filters['eq:created_by'])
    if (Array.isArray(filters['in:status'])) rows = rows.filter((r) => filters['in:status'].includes(r.status))
  } else if (table === 'watch_items') {
    rows = WATCH_ITEMS
  } else if (table === 'watch_updates') {
    rows = WATCH_UPDATES
    if (Array.isArray(filters['in:watch_item_id'])) rows = rows.filter((r) => filters['in:watch_item_id'].includes(r.watch_item_id))
  }

  if (single) return { data: rows[0] ?? null, error: null }
  return { data: rows, error: null, count: rows.length }
}

function makeBuilder(schema: string, table: string): any {
  const state: QueryState = { schema, table, select: '', single: false, head: false, filters: {} }
  const target = () => {}
  const proxy: any = new Proxy(target, {
    get(_t, prop: string) {
      if (prop === 'then') {
        const result = Promise.resolve(resolveQuery(state))
        return result.then.bind(result)
      }
      return (...args: any[]) => {
        if (prop === 'select') state.select = String(args[0] ?? '')
        else if (prop === 'single' || prop === 'maybeSingle') state.single = true
        else if (prop === 'eq') state.filters[`eq:${args[0]}`] = args[1]
        else if (prop === 'in') state.filters[`in:${args[0]}`] = args[1]
        return proxy
      }
    },
  })
  return proxy
}

export const supabase: any = {
  from: (table: string) => makeBuilder('proofs', table),
  schema: (schema: string) => ({ from: (table: string) => makeBuilder(schema, table) }),
  // Generic RPC stand-in — DashboardPage (and others) call these directly on
  // `supabase`, not via `.from()`, so they need their own fixture path.
  // Unknown names resolve to an empty array, matching the file's existing
  // "unrelated chrome never breaks the page under test" philosophy.
  rpc: async (name: string) => {
    if (name === 'dashboard_list') return { data: DASHBOARD_PROJECTS, error: null }
    // The staff roster, as the real SECURITY DEFINER RPC returns it. Lets the
    // Edit-profile colour picker be checked with colours actually taken.
    if (name === 'team_roster') return { data: PROFILES, error: null }
    if (name === 'dashboard_tile_counts') {
      return {
        data: {
          needs_attention: 6,
          not_viewed: 7,
          awaiting_customer: 15,
          customer_responded: 3,
          in_follow_up: 4,
          approved_this_week: 2,
          dormant: 1,
        },
        error: null,
      }
    }
    return { data: [], error: null }
  },
  functions: {
    invoke: async (name: string, opts?: { body?: any }) => {
      // Full PaymentsStatus shape — AdminSettingsPage reads this on mount and
      // renders payStatus.stripe.* / .xero.* unguarded, so the generic
      // { ok: true } fallback below would crash the whole page.
      if (name === 'payments-status') {
        return {
          data: {
            stripe: {
              mode: 'live', selectedKeyKind: 'live', testKeyPresent: true, liveKeyPresent: true,
              webhookTestSecretPresent: true, webhookLiveSecretPresent: true, consistent: true,
            },
            xero: { connected: true, orgName: 'Plasma Design (fixture)', isDemoCompany: false, baseCurrency: 'GBP', error: null },
            verdict: 'ready',
            bankAccounts: [{ name: 'Stripe clearing (fixture)', code: '125' }],
            taxRates: [
              { name: '0% EU', taxType: 'TAX004', effectiveRate: 0 },
              { name: '0% ROW', taxType: 'TAX003', effectiveRate: 0 },
            ],
            stripeAccountCode: '125',
          },
          error: null,
        }
      }
      if (name === 'place-order') {
        // OrderReviewPage preview (?path=/orders/o1/place). In-house route
        // with the Stock Control hand-off checks populated (a problem + a
        // warning) so the non-blocking amber card can be verified visually.
        return {
          data: {
            ok: true,
            route: 'in_house',
            subject: 'Order 403999 - Acme Ltd',
            note_lines: [
              'Qty: 500',
              'Card: Stainless Steel 500um',
              'Date required: 30/07/2026',
              '',
              'Artwork: https://www.dropbox.com/example',
            ],
            critical_lines: ['Qty: 500', 'Card: Stainless Steel 500um', 'Date required: 30/07/2026'],
            summary: {
              customer: 'Acme Ltd',
              material: 'Stainless Steel',
              variant: '500 micron',
              finish: null,
              inkFront: 'White',
              inkBack: null,
              quantity: 500,
              split: [],
              packaging: 'Domestic',
              dateRequired: '30/07/2026',
              dropboxFolderUrl: 'https://www.dropbox.com/example',
              route: 'in_house',
            },
            helpscout_linked: true,
            artwork_plan: { attach: ['Approved_Front.pdf', 'Approved_Back.pdf'], skipped: [] },
            handoff_validation: {
              ok: false,
              problems: [
                { code: 'unmapped_material', message: 'Stainless Steel has no Stock Control mapping — set it on Admin → Catalogue data → Stock materials.' },
              ],
              warnings: [
                { code: 'split_qty_mismatch', message: 'Per-person quantities (450) don’t add up to the order quantity (500).' },
              ],
            },
          },
          error: null,
        }
      }
      if (name === 'artwork-check') {
        // Per-flag investigation (the designer-triggered history walk): a
        // canned timeline + fault lean so the button → spinner → timeline
        // flow can be verified in both surfaces.
        if (opts?.body?.investigate) {
          const inv = opts.body.investigate as { card: string; field: string }
          return {
            data: {
              ok: true,
              key: `${inv.card}::${inv.field}`,
              investigation: {
                timeline: [
                  { at: '2026-07-08', kind: 'instruction', label: 'Customer', detail: 'Request form supplies tel 0207 288 8008.' },
                  { at: '2026-07-09', kind: 'version', label: 'v1', detail: 'Back shows tel 0207 288 8008 — matches the instruction of the time.' },
                  { at: '2026-07-12', kind: 'instruction', label: 'Customer', detail: '“Sorry — mobile should be 07700 900456, not 900123.”' },
                  { at: '2026-07-14', kind: 'version', label: 'v2', detail: 'Back still shows 07700 900123 — cut after the revision but does not reflect it.' },
                ],
                conclusion: 'The number was correct against the original request; the customer revised it on 12 Jul and v2 (14 Jul) failed to pick the revision up. One of ours — a missed revision, not a transcription slip.',
                fault: 'ours_missed_revision',
                card: inv.card,
                field: inv.field,
                at: '2026-07-21T11:00:00Z',
              },
            },
            error: null,
          }
        }
        // OrderReviewPage artwork sanity check (?path=/orders/o1/place) — a
        // live-mode FLAGGED report so the advisory card renders with a flag,
        // an unresolved correction, notes, gaps and the full table. Same
        // fixture the orders rows carry for the OrdersPage chip + modal.
        // The real check takes ~30–50s; the mock returns instantly. To inspect
        // the "Checking…" spinner state, run sessionStorage.setItem('artworkHang','1')
        // then reload — the invoke then hangs so the loading card stays up.
        // Off by default (zero cost); harness-only, never ships.
        if (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('artworkHang') === '1') await new Promise(() => {})
        return {
          data: { ok: true, mode: 'live', required: true, cached: true, report: ARTWORK_REPORT_FLAGGED },
          error: null,
        }
      }
      if (name === 'customer-proof-images') {
        const proofId: string = opts?.body?.proofId ?? ''
        const colour = THUMB_COLOUR[proofId]
        return {
          data: {
            images: colour
              ? [{ id: `img-${proofId}`, signed_url: swatch(colour, proofId.replace('p-', '').toUpperCase()), is_qr_code: false, proof_version_id: `ver-${proofId}` }]
              : [],
          },
          error: null,
        }
      }
      return { data: { ok: true }, error: null }
    },
  },
  auth: {
    getSession: async () => ({ data: { session: { access_token: 'test-token', user: { id: 'user-rob' } } } }),
    signOut: async () => ({ error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
  },
  storage: {
    // Return a data-URL "signed URL" so the Approved artwork downloads work in
    // the harness (fetch(dataUrl) → blob) without a real storage backend.
    from: (_bucket: string) => ({
      createSignedUrl: async (path: string) => ({ data: { signedUrl: swatch('#334155', path.slice(-8)) }, error: null }),
    }),
  },
  supabaseUrl: 'https://example.supabase.co',
}
