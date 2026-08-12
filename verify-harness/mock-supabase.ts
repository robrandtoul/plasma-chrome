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

// Per-area fixture modules (e2e work). Each hook claims only its own fixture
// ids and returns null otherwise; mock-supabase tries them FIRST and falls
// through to the fixtures in this file. Keeps parallel e2e work out of this
// shared file — add fixtures in verify-harness/fixtures/, not here.
import { customerProofQuery, customerProofRpc, customerProofInvoke } from './fixtures/customer-proof'
import { payPagesQuery, payPagesRpc, payPagesInvoke } from './fixtures/pay-pages'
import { versionFormQuery, versionFormRpc, versionFormInvoke } from './fixtures/version-form'
import { reorderDeskQuery, reorderDeskRpc, reorderDeskInvoke } from './fixtures/reorder-desk'
import { orderEditQuery } from './fixtures/order-edit'
import { dropboxImportInvoke } from './fixtures/dropbox-import'

const now = Date.now()
const daysAgo = (n: number) => new Date(now - n * 864e5).toISOString()
const hoursAgo = (n: number) => new Date(now - n * 36e5).toISOString()
const daysAhead = (n: number) => new Date(now + n * 864e5).toISOString()

// ——— tiny inline artwork so cards render a thumbnail ———
function swatch(colour: string, label: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" rx="18" fill="${colour}"/><text x="80" y="88" font-family="sans-serif" font-size="20" fill="#ffffff" text-anchor="middle">${label}</text></svg>`
  return `data:image/svg+xml;base64,${btoa(svg)}`
}

// Same idea, but at an arbitrary aspect ratio, with a bright inset rectangle
// standing in for the card so it's obvious how the artwork is framed inside a
// fixed-ratio thumbnail box. Real proof images are all sorts of shapes — a
// square mockup, a 3:2 photo, an occasional portrait — and the row thumbnail
// has one fixed box, so the fit behaviour is the thing worth eyeballing.
function aspectSwatch(colour: string, label: string, w: number, h: number): string {
  const inset = Math.round(Math.min(w, h) * 0.16)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="${colour}"/><rect x="${inset}" y="${inset}" width="${w - inset * 2}" height="${h - inset * 2}" rx="6" fill="#ffffff" opacity="0.22"/><text x="${w / 2}" y="${h / 2 + 7}" font-family="sans-serif" font-size="20" fill="#ffffff" text-anchor="middle">${label}</text></svg>`
  return `data:image/svg+xml;base64,${btoa(svg)}`
}

// Shapes the row thumbnails get cycled through, deterministically per version
// id, so one screenshot shows square / landscape / portrait / wide side by side.
const THUMB_SHAPES: Array<[number, number]> = [[200, 200], [200, 133], [160, 200], [200, 112]]
const THUMB_SHAPE_COLOURS = ['#1f2937', '#7c2d12', '#1e3a5f', '#3f6212']

// ——— shared shapes ———
const steel = { code: 'metal_steel', display_name: 'Stainless Steel', production_route: 'in_house', lead_time_max_days: 5, outsourced_supplier_ids: [] as string[] }
const letterpress = { code: 'paper_letterpress', display_name: 'Letterpress', production_route: 'supplier', lead_time_max_days: 7, outsourced_supplier_ids: ['s1'] }
const satin = { code: 'plastic_satin', display_name: 'Satin Plastic', production_route: 'in_house', lead_time_max_days: 4, outsourced_supplier_ids: [] as string[] }
const paper = { code: 'paper_standard', display_name: 'Standard Paper', production_route: 'supplier', lead_time_max_days: 4, outsourced_supplier_ids: ['s2'] }
// QX Metals make our metal cards, so a SUPPLIER-route metal — the real shape of
// the orders the supplier proof holding pen (000409) was built for. `steel`
// above stays in_house: several other rigs depend on it, and an order carrying
// both a supplier email and an in-house route is incoherent — handoffState reads
// it as "the workshop note was never sent" and files it in FIX.
const qxMetal = { code: 'metal_titanium', display_name: 'Titanium', production_route: 'supplier', lead_time_max_days: 12, outsourced_supplier_ids: ['s-qx'] }

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
    // Direct hand-off to Stock Control (000332) — nothing attempted by default.
    handoff_at: null,
    handoff_error: null,
    production_note_posted_at: null,
    supplier_email_sent_at: null,
    supplier_id: null,
    supplier_overs: 0,
    supplier_name: null,
    // Supplier proof holding pen (000409). All null by default, which is the
    // 'none' state — the in-house path every existing fixture is on.
    supplier_helpscout_conversation_id: null,
    supplier_reply_at: null,
    supplier_proof_approved_at: null,
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
// Ticks the mock's acknowledge branch has accepted this page load (see the
// artwork-check invoke handler below).
const artworkAckStore: Record<string, { reason: string; by: string; by_id: string; at: string }> = {}

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
  // Awaiting payment — second member of group g1. Its customer let the link
  // lapse and asked for another: the second of the two "stuck at the checkout"
  // stamps, and the reason each is fetched with its own ordering rather than
  // one `.or()` that would let the commoner truncate the rarer away.
  order({
    id: 'o4',
    quantity: 250,
    order_group_id: 'g1',
    proofs: { helpscout_last_reply_at: daysAgo(1), helpscout_last_customer_reply_at: null, helpscout_conversation_id: 'hs-3', contacts: contact('Globex', 'Hank Scorpio') },
    pay_link_resend_requested_at: daysAgo(0.3),
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
  // To order — ON HOLD, waiting on the customer (migration 000377). Fully
  // prepped, so the place button would otherwise be live: this is the case the
  // feature exists for. The artwork check flagged something and the answer
  // isn't back yet.
  order({
    id: 'o13',
    status: 'paid',
    paid_at: daysAgo(3),
    xero_invoice_id: 'xi-4',
    date_required: daysAhead(9).slice(0, 10),
    dropbox_folder_url: 'https://www.dropbox.com/scl/fo/abc/order-1240',
    stock_order_number: '1240',
    project_name: 'Kane Joinery',
    artwork_check_verdict: 'defect',
    artwork_checked_at: daysAgo(3),
    held_at: daysAgo(3),
    hold_reason: 'Artwork says 07700 900412 but the brief says 07700 900123 — asked Marcus which is right.',
    held_by_name: 'Rob Randtoul',
    proofs: { helpscout_last_reply_at: daysAgo(3), helpscout_last_customer_reply_at: null, helpscout_conversation_id: 'hs-13', helpscout_conversation_url: 'https://secure.helpscout.net/conversation/13', contacts: contact('Kane Joinery', 'Marcus Kane') },
  }),
  // To order — ON HOLD, and the customer has since replied. The card should
  // surface that as an errand ("worth a read") with a route to the thread —
  // never as "answered", because the Help Scout stamp is thread-wide and
  // cannot know what they actually said.
  order({
    id: 'o14',
    status: 'paid',
    paid_at: daysAgo(6),
    xero_invoice_id: 'xi-5',
    date_required: daysAhead(4).slice(0, 10),
    dropbox_folder_url: 'https://www.dropbox.com/scl/fo/abc/order-1241',
    stock_order_number: '1241',
    project_name: 'Vandelay Industries',
    held_at: daysAgo(5),
    hold_reason: 'Waiting on confirmation of the new office address before we print it.',
    held_by_name: 'Chris Jackson',
    proofs: { helpscout_last_reply_at: daysAgo(5), helpscout_last_customer_reply_at: daysAgo(1), helpscout_conversation_id: 'hs-14', helpscout_conversation_url: 'https://secure.helpscout.net/conversation/14', contacts: contact('Vandelay Industries', 'Art Vandelay') },
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
    // Stock Control refused the order last time it was placed — nothing was
    // written, nothing was sent (the amber chip + "Try again" block).
    handoff_error: 'material "Letterpress" is not mapped to a Stock Control material',
    proofs: { helpscout_last_reply_at: null, helpscout_last_customer_reply_at: null, helpscout_conversation_id: 'hs-4', contacts: contact('Initech', 'Bill Lumbergh') },
  }),
  // Being revised — paid + placed, artwork being redone. Proof is back to
  // in_progress, so this one STAYS under Being revised.
  order({
    id: 'o8',
    status: 'revision',
    paid_at: daysAgo(9),
    fulfilled_at: daysAgo(6),
    revised_at: daysAgo(1),
    xero_invoice_id: 'xi-3',
    proofs: { status: 'in_progress', helpscout_last_reply_at: null, helpscout_last_customer_reply_at: null, helpscout_conversation_id: 'hs-5', contacts: contact('Hooli', 'Gavin Belson') },
  }),
  // Revised AND re-approved — the case Rob asked for: the customer has signed
  // off the replacement artwork, so this belongs back in PLACE with the rest of
  // the work, no second link and no second payment. Never placed
  // (fulfilled_at null), so there is no old Stock Control job to cancel — it
  // just needs the Dropbox folder swapping to the new files.
  order({
    id: 'o15',
    status: 'revision',
    paid_at: daysAgo(11),
    revised_at: daysAgo(4),
    xero_invoice_id: 'xi-6',
    date_required: daysAhead(6).slice(0, 10),
    dropbox_folder_url: 'https://www.dropbox.com/scl/fo/abc/order-1242',
    stock_order_number: '1242',
    project_name: 'Hooli reprint',
    proofs: { status: 'approved', helpscout_last_reply_at: daysAgo(4), helpscout_last_customer_reply_at: daysAgo(2), helpscout_conversation_id: 'hs-15', helpscout_conversation_url: 'https://secure.helpscout.net/conversation/15', contacts: contact('Soylent Corp', 'Bill Rich') },
  }),
  // Revised, re-approved, AND already gone to production once — the Experience
  // Auto Group shape. Riskier than o15: there is a supplier job out there as
  // well as stale files in the Dropbox folder, so the card must say BOTH, and
  // the review page adds its "confirm the old Stock Control job is cancelled"
  // gate on top.
  order({
    id: 'o16',
    status: 'revision',
    paid_at: daysAgo(19),
    fulfilled_at: daysAgo(16),
    revised_at: daysAgo(14),
    xero_invoice_id: 'xi-7',
    date_required: daysAhead(5).slice(0, 10),
    dropbox_folder_url: 'https://www.dropbox.com/scl/fo/abc/order-1243',
    stock_order_number: '1243',
    project_name: 'Tyrell reissue',
    proofs: { status: 'approved', helpscout_last_reply_at: daysAgo(14), helpscout_last_customer_reply_at: daysAgo(13), helpscout_conversation_id: 'hs-16', helpscout_conversation_url: 'https://secure.helpscout.net/conversation/16', contacts: contact('Tyrell Corp', 'Eldon Tyrell') },
  }),
  // Recently ordered — placed cleanly: job in Stock Control, workshop note sent.
  order({ id: 'o9', status: 'fulfilled', paid_at: daysAgo(8), fulfilled_at: daysAgo(5), handoff_at: daysAgo(5), production_note_posted_at: daysAgo(5), stock_order_number: '403910', artwork_check_verdict: 'clear', artwork_checked_at: daysAgo(5), artwork_check: ARTWORK_REPORT_CLEAR, proofs: { helpscout_last_reply_at: null, helpscout_last_customer_reply_at: null, helpscout_conversation_id: null, contacts: contact('Pied Piper', 'Richard Hendricks') } }),
  // Recently ordered — the new half-way failure: the job IS in Stock Control
  // but the workshop note never went, so nobody knows to make it.
  order({ id: 'o10', status: 'fulfilled', paid_at: daysAgo(15), fulfilled_at: daysAgo(12), handoff_at: daysAgo(12), production_note_posted_at: null, stock_order_number: '403912', proofs: { helpscout_last_reply_at: null, helpscout_last_customer_reply_at: null, helpscout_conversation_id: null, contacts: contact(null, 'Jian Yang') } }),
  // Recently ordered — a long company name against a full-length reference and
  // a five-figure quantity: the widest a row gets in real data, which is what
  // used to break the layout on a phone.
  // Was a second 'o13' — a straight id collision with the on-hold order above,
  // not two views of one order. It gave the dashboard's activity feed two rows
  // keyed `paylink-sent-o13`, and React's reconciler answered that by leaving an
  // orphaned <li> in the DOM: the card rendered 21 rows from a 20-row state,
  // which reads exactly like a broken cap. Renumbered to a free id.
  order({ id: 'o17', status: 'fulfilled', quantity: 10000, payment_reference: 'ORD-A7A33935C2', paid_at: daysAgo(9), fulfilled_at: daysAgo(7), handoff_at: daysAgo(7), production_note_posted_at: daysAgo(7), stock_order_number: '403914', artwork_check_verdict: 'flagged', artwork_checked_at: daysAgo(7), artwork_check: ARTWORK_REPORT_FLAGGED, proofs: { helpscout_last_reply_at: null, helpscout_last_customer_reply_at: null, helpscout_conversation_id: null, contacts: contact('Elite Credentials International', 'Bertram Gilfoyle') } }),
  // Combined-supplier-batches pair (?path=/orders/o-blanks/place). o-blanks is
  // the Apex-style paid foiling order whose blanks ride o-thornton's batch;
  // o-thornton is the placed sibling carrying 1,000 + 1,200 overs from
  // Solopress (the blanks-source candidate + the active summary card).
  order({
    id: 'o-blanks',
    status: 'paid',
    paid_at: daysAgo(4),
    material_id: 'm-paper',
    material_variant_id: 'v-paper-foil',
    material_variants: { display_name: 'With Foiling', materials: paper },
    quantity: 1000,
    xero_invoice_id: 'xi-8',
    date_required: daysAhead(3).slice(0, 10),
    dropbox_folder_url: 'https://www.dropbox.com/scl/fo/abc/order-403958',
    stock_order_number: '403958',
    project_name: 'Apex Dental & Implant Centre',
    proofs: { helpscout_last_reply_at: daysAgo(4), helpscout_last_customer_reply_at: null, helpscout_conversation_id: 'hs-17', contacts: contact('Apex Dental & Implant Centre', 'Sarah Chen') },
  }),
  // A PLACED blanks-source order: job written, workshop note sent, supplier
  // email deliberately never sent. Must sit quietly in Recently ordered — the
  // regression this guards is handoffState reading it as "supplier email
  // wasn't sent" forever (live: Apex 403960, 4 Aug 2026).
  order({
    id: 'o-blanks-placed',
    status: 'fulfilled',
    paid_at: daysAgo(4),
    fulfilled_at: daysAgo(0.1),
    handoff_at: daysAgo(0.1),
    production_note_posted_at: daysAgo(0.1),
    supplier_email_sent_at: null,
    blanks_source_order_id: 'o-thornton',
    material_id: 'm-paper',
    material_variant_id: 'v-paper-foil',
    material_variants: { display_name: 'With Foiling', materials: paper },
    quantity: 1000,
    xero_invoice_id: 'xi-10',
    date_required: daysAhead(6).slice(0, 10),
    stock_order_number: '403960',
    project_name: 'Apex Dental & Implant Centre (placed)',
    proofs: { helpscout_last_reply_at: daysAgo(4), helpscout_last_customer_reply_at: null, helpscout_conversation_id: 'hs-19', contacts: contact('Apex Dental & Implant Centre', 'Sarah Chen') },
  }),
  order({
    id: 'o-thornton',
    status: 'fulfilled',
    paid_at: daysAgo(4),
    fulfilled_at: daysAgo(0.3),
    handoff_at: daysAgo(0.3),
    supplier_email_sent_at: daysAgo(0.3),
    material_id: 'm-paper',
    material_variant_id: 'v-paper-foil',
    material_variants: { display_name: 'With Foiling', materials: paper },
    quantity: 1000,
    supplier_overs: 1200,
    supplier_name: 'Solopress',
    xero_invoice_id: 'xi-9',
    date_required: daysAhead(3).slice(0, 10),
    stock_order_number: '403957',
    project_name: 'Thornton Dental & Implant Centre',
    proofs: { helpscout_last_reply_at: daysAgo(4), helpscout_last_customer_reply_at: null, helpscout_conversation_id: 'hs-18', contacts: contact('Thornton Dental & Implant Centre', 'Priya Patel') },
  }),
  // ── Supplier proof holding pen (000409) ───────────────────────────────────
  // One order per state of supplierProofState(), so the CHECK section, the
  // Waiting line, the Fix row and the Recently-ordered exclusion all have
  // something to render. All are status 'fulfilled' with BOTH the supplier email
  // stamp and a conversation id — that pair is what puts an order in the pen.
  //
  // Day counts are chosen to be weekday-independent: daysAgo(5) always spans at
  // least three working days (overdue at any threshold ≤3), and daysAgo(0) always
  // spans zero (never overdue), so the rig behaves the same run on a Tuesday or
  // a Sunday.
  order({
    id: 'sp-check',
    material_id: 'm-titanium',
    material_variant_id: 'v-titanium',
    material_variants: { display_name: '500 micron', materials: qxMetal },
    status: 'fulfilled',
    paid_at: daysAgo(3),
    fulfilled_at: daysAgo(1),
    handoff_at: daysAgo(1),
    supplier_email_sent_at: daysAgo(1),
    supplier_name: 'QX Metals',
    supplier_id: 'sup-qx',
    supplier_helpscout_conversation_id: 'hs-sup-1',
    supplier_reply_at: daysAgo(0.2),
    quantity: 500,
    xero_invoice_id: 'xi-sp1',
    stock_order_number: '403971',
    dropbox_folder_url: 'https://dropbox.com/order/403971',
    proofs: { helpscout_last_reply_at: daysAgo(3), helpscout_last_customer_reply_at: null, helpscout_conversation_id: 'hs-30', contacts: contact('Northwind Traders', 'Erin Shaw') },
  }),
  // A RE-proof: the supplier corrected something after we'd already approved,
  // so supplier_reply_at is newer than supplier_proof_approved_at and the card
  // comes back into CHECK with the "check what changed" warning.
  order({
    id: 'sp-revised',
    material_id: 'm-titanium',
    material_variant_id: 'v-titanium',
    material_variants: { display_name: '500 micron', materials: qxMetal },
    status: 'fulfilled',
    paid_at: daysAgo(4),
    fulfilled_at: daysAgo(2),
    handoff_at: daysAgo(2),
    supplier_email_sent_at: daysAgo(2),
    supplier_name: 'QX Metals',
    supplier_id: 'sup-qx',
    supplier_helpscout_conversation_id: 'hs-sup-2',
    supplier_proof_approved_at: daysAgo(1),
    supplier_reply_at: daysAgo(0.5),
    quantity: 250,
    xero_invoice_id: 'xi-sp2',
    stock_order_number: '403972',
    proofs: { helpscout_last_reply_at: daysAgo(4), helpscout_last_customer_reply_at: null, helpscout_conversation_id: 'hs-31', contacts: contact('Gable & Rowe', 'Tom Gable') },
  }),
  // Placed today, nothing back yet — normal, so it sits quietly in WAITING.
  order({
    id: 'sp-awaiting',
    material_id: 'm-titanium',
    material_variant_id: 'v-titanium',
    material_variants: { display_name: '500 micron', materials: qxMetal },
    status: 'fulfilled',
    paid_at: daysAgo(1),
    fulfilled_at: daysAgo(0),
    handoff_at: daysAgo(0),
    supplier_email_sent_at: daysAgo(0),
    supplier_name: 'QX Metals',
    supplier_id: 'sup-qx',
    supplier_helpscout_conversation_id: 'hs-sup-3',
    quantity: 100,
    xero_invoice_id: 'xi-sp3',
    stock_order_number: '403973',
    proofs: { helpscout_last_reply_at: daysAgo(1), helpscout_last_customer_reply_at: null, helpscout_conversation_id: 'hs-32', contacts: contact('Halcyon Legal', 'Marta Ruiz') },
  }),
  // Silent for days — the hole this feature closes. Lands in FIX.
  order({
    id: 'sp-overdue',
    material_id: 'm-titanium',
    material_variant_id: 'v-titanium',
    material_variants: { display_name: '500 micron', materials: qxMetal },
    status: 'fulfilled',
    paid_at: daysAgo(7),
    fulfilled_at: daysAgo(5),
    handoff_at: daysAgo(5),
    supplier_email_sent_at: daysAgo(5),
    supplier_name: 'QX Metals',
    supplier_id: 'sup-qx',
    supplier_helpscout_conversation_id: 'hs-sup-4',
    quantity: 750,
    xero_invoice_id: 'xi-sp4',
    stock_order_number: '403974',
    proofs: { helpscout_last_reply_at: daysAgo(7), helpscout_last_customer_reply_at: null, helpscout_conversation_id: 'hs-33', contacts: contact('Beacon Surveyors', 'Neil Okafor') },
  }),
  // Approved, nothing newer since — the terminal state, back in the archive.
  order({
    id: 'sp-approved',
    material_id: 'm-titanium',
    material_variant_id: 'v-titanium',
    material_variants: { display_name: '500 micron', materials: qxMetal },
    status: 'fulfilled',
    paid_at: daysAgo(9),
    fulfilled_at: daysAgo(6),
    handoff_at: daysAgo(6),
    supplier_email_sent_at: daysAgo(6),
    supplier_name: 'QX Metals',
    supplier_id: 'sup-qx',
    supplier_helpscout_conversation_id: 'hs-sup-5',
    supplier_reply_at: daysAgo(5.8),
    supplier_proof_approved_at: daysAgo(5.5),
    quantity: 300,
    xero_invoice_id: 'xi-sp5',
    stock_order_number: '403975',
    proofs: { helpscout_last_reply_at: daysAgo(9), helpscout_last_customer_reply_at: null, helpscout_conversation_id: 'hs-34', contacts: contact('Pemberton & Co', 'Alice Wu') },
  }),
].map((o, i) => ({ ...o, proof_id: `p-${o.id}` }))

// ?busy=1 — a busy month for the dashboard rig: ~105 extra paid production
// orders spread across the last four weeks, so the Paid tile renders a
// three-digit count with a five-figure money line. That is the shape that
// first overflowed the xl tile on live ("115 · £57,385" in a ~61px content
// box); keep this rig passing and the strip survives a good month. Gated
// behind the URL flag so the Orders rigs keep their curated ten.
const BUSY_MONTH_ORDERS: FixtureOrder[] = Array.from({ length: 105 }, (_, i) =>
  order({
    id: `busy-${i + 1}`,
    status: 'fulfilled',
    quantity: 250,
    amount_cards: 380 + (i % 7) * 40,
    amount_shipping: 13,
    sent_at: daysAgo((i % 28) + 2),
    paid_at: daysAgo((i % 28) + 0.3),
    fulfilled_at: daysAgo(i % 28),
    proofs: {
      helpscout_last_reply_at: null,
      helpscout_last_customer_reply_at: null,
      helpscout_conversation_id: null,
      contacts: contact('Busy Month Ltd', `Customer ${i + 1}`),
    },
  }),
).map((o) => ({ ...o, proof_id: `p-${o.id}` }))

function busyMonth(): boolean {
  return new URLSearchParams(window.location.search).get('busy') === '1'
}

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
    // 000373: raised from a customer reorder request, so the row carries the
    // brand-toned "Customer reorder" line ALONGSIDE its Approved pill — the
    // pill can't distinguish this from a fresh sign-off, which is the whole
    // reason the line exists.
    reorder_of_proof_id: 'p-a2',
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
    // The other half of 000373: the SOURCE project, between the customer
    // asking and a designer raising the reorder. Surfaces as a needs-attention
    // chip so the ask can't be missed.
    reorder_requested_at: daysAgo(2),
    rule_code: 'reorder_requested',
    rule_meta: { days: 2, quantity: 500 },
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
  // ——— Bundle fixtures (proof_sets, 000311) ———
  // Reproduces the case that prompted the feature: cards of one bundle
  // scattered through the list, so the dashboard gave no sign they were
  // connected. p-b1 + p-b2 land in Today; p-b3 is four days older — since the
  // 2026-07-28 hoist rule (hoistBundleSections) it no longer stays behind in
  // This week with a chip, but rides up so all three cards render as ONE block
  // in Today. The abandoned p-b4 stays out, so the header reads "3 cards".
  {
    proof_id: 'p-b1',
    status: 'in_progress',
    current_version_id: 'ver-b1',
    current_version_number: 1,
    version_created_at: daysAgo(0.05),
    company_name: 'Atlus Consulting Engineers',
    contact_name: 'Saba',
    contact_email: 'saba@atlus.example',
    approved_at: null,
    material_display: 'Carbon Fibre',
    designer_name: 'Jack Johnson',
    designer_initials: 'JJ',
    designer_colour: 'purple',
    designer_avatar_url: null,
    helpscout_conversation_url: 'https://secure.helpscout.net/conversation/3',
    helpscout_conversation_id: 'hs-7',
    // ⚠ All three bundle cards carry the SAME reply stamp, because they share
    // one Help Scout conversation and the webhook stamps every proof on it
    // together. That is the shape that used to put three identical "was sent a
    // reply" rows in the Latest activity feed for one reply; the feed now
    // collapses them into one row reading "covers 3 cards in the bundle".
    helpscout_last_reply_at: daysAgo(0.03),
    helpscout_last_customer_reply_at: null,
  },
  {
    proof_id: 'p-x1',
    status: 'in_progress',
    current_version_id: 'ver-x1',
    current_version_number: 2,
    version_created_at: daysAgo(0.04),
    company_name: 'Leccy.Tech',
    contact_name: 'Laurence Phillips',
    contact_email: 'laurence@leccy.example',
    approved_at: null,
    material_display: 'Gun Metal',
    // The customer came back to /p/ and asked for more of these (000372). Only
    // the Latest-activity feed reads this stamp — the row's own reorder line
    // keys off reorder_of_proof_id, which is the CHILD project's marker.
    reorder_requested_at: daysAgo(0.2),
    designer_name: 'Donna Lambe',
    designer_initials: 'DL',
    designer_colour: 'coral',
    designer_avatar_url: null,
    helpscout_conversation_url: 'https://secure.helpscout.net/conversation/4',
    helpscout_conversation_id: 'hs-8',
    helpscout_last_reply_at: daysAgo(0.04),
    helpscout_last_customer_reply_at: daysAgo(0.03),
  },
  {
    proof_id: 'p-b2',
    status: 'in_progress',
    current_version_id: 'ver-b2',
    current_version_number: 1,
    version_created_at: daysAgo(0.03),
    company_name: 'Atlus Consulting Engineers',
    contact_name: 'Saba',
    contact_email: 'saba@atlus.example',
    approved_at: null,
    material_display: 'Gun Metal',
    designer_name: 'Jack Johnson',
    designer_initials: 'JJ',
    designer_colour: 'purple',
    designer_avatar_url: null,
    helpscout_conversation_url: 'https://secure.helpscout.net/conversation/3',
    helpscout_conversation_id: 'hs-7',
    helpscout_last_reply_at: daysAgo(0.03),
    helpscout_last_customer_reply_at: null,
  },
  {
    proof_id: 'p-b3',
    status: 'in_progress',
    current_version_id: 'ver-b3',
    current_version_number: 1,
    version_created_at: daysAgo(4),
    company_name: 'Atlus Consulting Engineers',
    contact_name: 'Saba',
    contact_email: 'saba@atlus.example',
    approved_at: null,
    material_display: 'Stainless Steel',
    designer_name: 'Jack Johnson',
    designer_initials: 'JJ',
    designer_colour: 'purple',
    designer_avatar_url: null,
    helpscout_conversation_url: 'https://secure.helpscout.net/conversation/3',
    helpscout_conversation_id: 'hs-7',
    // Same conversation as its two siblings, so the same stamp — see the note
    // on p-b1. This card's own VERSION is four days older, which is what keeps
    // "Sent 4d ago" on the row; the reply is a property of the thread, not the
    // card, and there is only one thread.
    helpscout_last_reply_at: daysAgo(0.03),
    helpscout_last_customer_reply_at: null,
  },
  // ——— 000376 fixtures: the long wait, and the repeat customer ———
  // Two states nothing else in this list reaches.
  //
  // p-r1 has been sitting for 13 days, which is what puts the Waiting column
  // into its amber treatment (the threshold is 7). Every other fixture is
  // under a week, so without this the amber branch renders nowhere.
  //
  // It is also a repeat customer WITH a known ordinal — an earlier proof for
  // the same contact exists, so the row can count. p-r2 is the other half:
  // repeat by Help Scout's `repeat customer` tag alone, with no ordinal, which
  // on live is the more common of the two and must render as a bare "Repeat
  // customer" rather than inventing a number.
  {
    proof_id: 'p-r1',
    status: 'in_progress',
    current_version_id: 'ver-r1',
    current_version_number: 3,
    version_created_at: daysAgo(13),
    company_name: 'Sweet Beats',
    contact_name: 'Marisa Bell',
    contact_email: 'marisa@sweetbeats.example',
    approved_at: null,
    material_display: 'Matte Black Metal',
    material_category: 'metal',
    is_repeat: true,
    repeat_project_number: 3,
    designer_name: 'Rob Randtoul',
    designer_initials: 'RR',
    designer_colour: 'blue',
    designer_avatar_url: null,
    helpscout_conversation_url: 'https://secure.helpscout.net/conversation/9',
    helpscout_conversation_id: 'hs-9',
    helpscout_last_reply_at: daysAgo(13),
    helpscout_last_customer_reply_at: null,
  },
  {
    proof_id: 'p-r2',
    status: 'in_progress',
    current_version_id: 'ver-r2',
    current_version_number: 1,
    version_created_at: daysAgo(9),
    company_name: 'Harbour & Moss',
    contact_name: 'Nadia Okonjo',
    contact_email: 'nadia@harbourmoss.example',
    approved_at: null,
    material_display: 'Brushed Copper',
    material_category: 'metal',
    // Tagged in Help Scout, but no earlier proof here — so no ordinal.
    is_repeat: true,
    repeat_project_number: null,
    designer_name: 'Chris Jackson',
    designer_initials: 'CJ',
    designer_colour: 'teal',
    designer_avatar_url: null,
    helpscout_conversation_url: 'https://secure.helpscout.net/conversation/10',
    helpscout_conversation_id: 'hs-10',
    helpscout_last_reply_at: daysAgo(9),
    helpscout_last_customer_reply_at: null,
  },
]

// Bundle membership, as DashboardPage reads it: every member proof plus the
// set rows. One three-card bundle, sent but not yet opened — the live Atlus
// shape. The abandoned fourth card proves the exclusion: it must NOT push the
// headline count to four.
const BUNDLE_MEMBERS = [
  { id: 'p-b1', proof_set_id: 'set-1', set_discarded_at: null, status: 'in_progress' },
  { id: 'p-b2', proof_set_id: 'set-1', set_discarded_at: null, status: 'in_progress' },
  { id: 'p-b3', proof_set_id: 'set-1', set_discarded_at: null, status: 'in_progress' },
  { id: 'p-b4', proof_set_id: 'set-1', set_discarded_at: null, status: 'abandoned' },
]

const BUNDLE_SETS = [
  { id: 'set-1', token: 'set-token', sent_at: daysAgo(0.02), last_opened_at: null },
  // A bundle the customer has opened, behind the "opened their bundle" row in
  // Latest activity. Nothing else records that visit — the review hub lists the
  // cards without registering a view on any of them — and it is the only feed
  // row that links somewhere other than a proof.
  //
  // ⚠ Appended, never prepended. The proof_sets branch below ignores `eq:id`,
  // so a caller asking for ONE set takes rows[0]; keeping set-1 first is what
  // stops this fixture reaching the bundle workspace and checkpoint rigs.
  {
    id: 'set-a',
    token: 'set-token-a',
    sent_at: daysAgo(3),
    last_opened_at: hoursAgo(5),
    proofs: [{ id: 'p-b1' }, { id: 'p-b2' }, { id: 'p-b3' }],
    contacts: contact('Atlus Consulting Engineers', 'Saba'),
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
  const hooked =
    customerProofQuery(state) ?? payPagesQuery(state) ?? versionFormQuery(state) ?? reorderDeskQuery(state) ??
    orderEditQuery(state)
  if (hooked) return hooked

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
  } else if (table === 'material_variants') {
    // Thickness variants for the order builder's Option field. Steel carries
    // the three real metal thicknesses so the open-spec pills have something
    // to open; every material falls back to a single variant so the field
    // still renders. weight_grams is present so shipping estimates can run.
    rows = filters['eq:material_id'] === 'm-steel'
      ? [
          { id: 'mv-300', display_name: '300 micron', sort_order: 1, weight_grams: 7, variant_type: 'thickness', material_id: 'm-steel' },
          { id: 'mv-500', display_name: '500 micron', sort_order: 2, weight_grams: 11, variant_type: 'thickness', material_id: 'm-steel' },
          { id: 'mv-800', display_name: '800 micron', sort_order: 3, weight_grams: 18, variant_type: 'thickness', material_id: 'm-steel' },
        ]
      : [{ id: 'mv-only', display_name: 'Standard', sort_order: 1, weight_grams: 10, variant_type: 'thickness', material_id: filters['eq:material_id'] ?? 'm-other' }]
  } else if (table === 'price_tiers') {
    // Only ever read as a head/count per variant, to decide whether a variant
    // is priced in this currency. One row is enough to say "yes".
    rows = [{ id: 'pt-1' }]
  } else if (table === 'material_options') {
    // The metal finish dimension, so the Finish picker renders. Natural is the
    // base, matching the catalogue.
    rows = filters['eq:material_id'] === 'm-steel'
      ? [
          { id: 'mo-natural', code: 'natural', display_name: 'Natural', is_base: true, sort_order: 1 },
          { id: 'mo-brushed', code: 'brushed', display_name: 'Brushed', is_base: false, sort_order: 2 },
          { id: 'mo-mirror', code: 'mirror', display_name: 'Mirror', is_base: false, sort_order: 3 },
        ]
      : []
  } else if (table === 'prototype_prices') {
    rows = [{ amount: 95, is_active: true }]
  } else if (table === 'orders') {
    rows = busyMonth() ? ORDERS.concat(BUSY_MONTH_ORDERS) : ORDERS
    if (Array.isArray(filters['in:status'])) rows = rows.filter((r) => filters['in:status'].includes(r.status))
    if (filters['eq:id']) rows = rows.filter((r) => r.id === filters['eq:id'])
    // The dashboard's order-stage tiles each scope by status, and the Paid
    // tile additionally by paid_at / kind. Without these the tiles were all
    // handed the WHOLE order list, so Awaiting payment, Paid and To order
    // rendered the same number and the same money — which looks like a real
    // bug on screen, and would hide one.
    if (filters['eq:status']) rows = rows.filter((r) => r.status === filters['eq:status'])
    if (filters['neq:status']) rows = rows.filter((r) => r.status !== filters['neq:status'])
    if (filters['neq:order_kind']) rows = rows.filter((r) => (r.order_kind ?? 'production') !== filters['neq:order_kind'])
    if (filters['gte:paid_at']) rows = rows.filter((r) => r.paid_at != null && r.paid_at >= filters['gte:paid_at'])
    // ProofDetailPage scopes its order read to the proof (.eq('proof_id', …)),
    // and its header actions branch on what comes back. Without this filter
    // every proof id was handed the WHOLE order list, so the detail page
    // always looked like it had a live pay link — which silently hid any UI
    // that only appears on an order-free project.
    if (filters['eq:proof_id']) rows = rows.filter((r) => r.proof_id === filters['eq:proof_id'])
    // OrderReviewPage's blanks-source candidates query (same-material placed
    // siblings): material scope + self-exclusion + recency window.
    if (filters['eq:material_id']) rows = rows.filter((r) => r.material_id === filters['eq:material_id'])
    if (filters['neq:id']) rows = rows.filter((r) => r.id !== filters['neq:id'])
    if (filters['gte:fulfilled_at']) rows = rows.filter((r) => r.fulfilled_at != null && r.fulfilled_at >= filters['gte:fulfilled_at'])
  } else if (table === 'public_dashboard_projects') {
    // ProofDetailPage reads one row by proof_id for its status pill + the
    // change-request strip's visibility gate. An id containing 'changes'
    // buckets as changes_requested, which is what puts the strip (and so the
    // customer-pin list) on screen — see ?path=/proofs/p-open-changes.
    if (filters['eq:proof_id']) {
      const pid = String(filters['eq:proof_id'])
      rows = [{
        proof_id: pid,
        status: 'in_progress',
        current_version_id: `ver-${pid}`,
        current_version_viewed_at: daysAgo(1),
        latest_non_view_event_type: pid.includes('changes') ? 'request_changes' : null,
        latest_non_view_event_at: pid.includes('changes') ? daysAgo(0.2) : null,
        version_created_at: daysAgo(2),
        has_open_change_request: pid.includes('changes'),
        rule_code: null, rule_meta: null,
        snoozed_until: null, snooze_rule_code: null, snooze_note: null,
        helpscout_last_reply_at: null, helpscout_last_customer_reply_at: null,
        last_activity_at: daysAgo(0.2),
        follow_up_rule_code: null, order_status: null,
      }]
    } else {
      rows = DASHBOARD_PROJECTS
    }
    if (filters['eq:status']) rows = rows.filter((r) => r.status === filters['eq:status'])
  } else if (table === 'order_link_notes') {
    rows = [{ proof_id: 'p-a1', note: 'Waiting on metal thickness — chased today.', created_by_name: 'Chris Jackson', created_by_initials: 'CJ', created_by_colour: 'teal', updated_at: daysAgo(0.1) }]
  } else if (table === 'proof_versions') {
    // Matched on the EXACT select, not on includes(): several pages read
    // overlapping column sets from this table, and a loose match here
    // silently hands one of them the wrong fixture.
    if (select.replace(/\s/g, '') === 'names,shape,is_variant_round') {
      // The preview gate's set-consistency read (lib/setConsistency).
      // Three recipients, matching the images below.
      rows = [{
        names: ['William Delamore', 'Lyndon Short', 'James Gunns'],
        shape: 'recipients',
        is_variant_round: false,
      }]
    } else if (select.includes('materials(display_quantities)')) {
      // ProofDetailPage's versions list — one current v1 for the fixture
      // project above.
      const pid = filters['eq:proof_id'] ?? 'p-a1'
      rows = [{
        id: `ver-${pid}`, version_number: 1, material_id: 'm-steel', material_display: 'Stainless Steel',
        ink_names: [], currency: 'GBP', is_current: true, created_at: daysAgo(22), created_by: 'user-rob',
        change_notes: null, pricing_snapshot: null, shipping_note: '', custom_quote: false,
        names: ['Valentina Ring'], card_type: 'business', shape: 'recipients',
        last_reply_sent_at: daysAgo(21), last_reply_sent_by: null, displayed_variant_ids: [],
        is_variant_round: false, is_per_direction_pricing: false, material_options: [],
        has_personalisation: false, team_sharing_enabled: false,
        front_colour_id: null, core_colour_id: null, back_colour_id: null,
        artwork_check: null, artwork_checked_at: null, artwork_check_verdict: null,
        materials: { display_quantities: null },
      }]
    } else if (select.includes('materials(code)')) {
      const ids: string[] = filters['in:proof_id'] ?? []
      rows = ids.map((pid) => ({ proof_id: pid, materials: { code: PROOF_MATERIAL[pid] ?? 'metal_steel' } }))
    } else {
      const pid = filters['eq:proof_id']
      // Batched thumbnail loads (OrdersPage / OrderLogPage) come through
      // .in('proof_id', ids) — one current version per proof, in the order's
      // own material so thumbForOrder's material-first lookup resolves.
      const pids: string[] | null = Array.isArray(filters['in:proof_id']) ? filters['in:proof_id'] : null
      rows = pids
        ? pids.map((p) => ({ id: `ver-${p}`, proof_id: p, material_id: ORDERS.find((o) => o.proof_id === p)?.material_id ?? 'm-steel', is_current: true, version_number: 3, shape: null }))
        : pid ? [{ id: `ver-${pid}`, proof_id: pid, material_id: ORDERS.find((o) => o.proof_id === pid)?.material_id ?? 'm-steel', is_current: true, version_number: 3, shape: null, material_options: [] }] : []
    }
  } else if (table === 'proofs') {
    if (filters['eq:reorder_of_proof_id']) {
      // "Has a reorder already been raised from this project?" (000373).
      // An id containing 'raised' has one — which both hides the "Raise the
      // reorder" menu item and renders the forward link on the source, so the
      // pair links in both directions.
      rows = String(filters['eq:reorder_of_proof_id']).includes('raised')
        ? [{ id: 'p-a1-child' }]
        : []
    } else if (select.includes('proof_set_id') && !select.includes('contacts(')) {
      // DashboardPage's bundle-membership read (see lib/dashboardBundles.ts).
      rows = BUNDLE_MEMBERS
    } else if (select.includes('contacts(')) {
      // ProofDetailPage's header select — a full approved fixture project so
      // the detail page (overflow menu, dialogs, facts rail) can be verified.
      // An id containing 'open' renders the in_progress (unlocked) branch.
      const pid = filters['eq:id'] ?? 'p-a1'
      const isOpen = String(pid).includes('open')
      rows = [{
        id: pid,
        status: isOpen ? 'in_progress' : 'approved',
        approved_at: isOpen ? null : daysAgo(20),
        abandoned_at: null,
        helpscout_thread_url: null,
        helpscout_conversation_id: null,
        helpscout_conversation_url: null,
        helpscout_override_reason: 'Fixture project — no conversation',
        internal_notes: null,
        created_at: daysAgo(22),
        disclaimer_acknowledged_at: null,
        proof_set_id: null,
        set_discarded_at: null,
        // Reorder request fixture (000372) — an id containing 'reorder'
        // renders the "Raise the reorder" path: the menu item, the
        // ResolvePopover primary action and the confirm dialog's copy, which
        // quotes the customer's own words back.
        reorder_requested_at: /reorder|raised/.test(String(pid)) ? daysAgo(2) : null,
        reorder_request_note: String(pid).includes('reorder')
          ? 'Same as before please, but Kelly has left so drop her card.'
          : null,
        reorder_request_quantity: String(pid).includes('reorder') ? 500 : null,
        // An id containing 'child' renders the far side: a project that IS
        // somebody's reorder, so the facts rail links back.
        reorder_of_proof_id: String(pid).includes('child') ? 'p-a1' : null,
        contact_id: 'c-1',
        contacts: { full_name: 'Valentina Ring', email: 'valentina@realise.example', companies: { id: 'co-1', name: 'Realise' } },
      }]
    } else if (Array.isArray(filters['in:id'])) {
      // The approved-artwork batch (Orders page) asks for many proofs' approval
      // dates at once — one row per requested id, or the map it builds is keyed
      // on undefined and every card loses its "Approved <date>".
      rows = (filters['in:id'] as string[]).map((id) => ({ id, approved_at: daysAgo(1) }))
    } else {
      rows = [{ approved_at: daysAgo(1) }]
    }
  } else if (table === 'proof_version_images') {
    // Exact select, same reason as proof_versions above.
    if (select.replace(/\s/g, '') === 'associated_name,side,material_option,is_qr_code') {
      // The preview gate's set-consistency read. Reproduces the live
      // shape that prompted the check (The Sourdough Company, approved
      // and ordered): a shared front, a back each — except one
      // recipient's artwork carries no side at all.
      rows = [
        { associated_name: null, side: 'front', material_option: null, is_qr_code: false },
        { associated_name: 'Lyndon Short', side: 'back', material_option: null, is_qr_code: false },
        { associated_name: 'William Delamore', side: 'back', material_option: null, is_qr_code: false },
        { associated_name: 'James Gunns', side: null, material_option: null, is_qr_code: false },
      ]
    } else {
      // Two approved files (front + back, shared artwork) so the To-order card's
      // Approved artwork panel renders a populated list.
      //
      // The batched read (`.in('proof_version_id', …)`, used by the Orders page
      // for every card at once) groups the rows BY that column, so each
      // requested version needs its own pair — a flat two-row fixture with no
      // proof_version_id groups under `undefined` and every card comes back
      // empty.
      // Single-version reads keep the stable `img-front` / `img-back` ids the
      // annotation fixtures below are pinned to.
      const versionIds: string[] = Array.isArray(filters['in:proof_version_id'])
        ? filters['in:proof_version_id']
        : [filters['eq:proof_version_id'] ?? 'demo-version']
      rows = versionIds.flatMap((vid, i) => {
        // Globex (order o6) is the two-recipient fixture — a shared front plus
        // a card each — so the collapsed strip's "+N more" truncation and the
        // panel's per-recipient rows have something to render. Every other
        // order keeps the plain shared front/back pair.
        if (vid === 'ver-p-o6') {
          return [
            { id: 'img-o6-shared', proof_version_id: vid, image_path: 'proofs/o6-front.pdf', original_filename: 'Globex_Front_Shared.pdf', associated_name: null, side: 'front', layout_id: null },
            { id: 'img-o6-hs-b', proof_version_id: vid, image_path: 'proofs/o6-hs-back.pdf', original_filename: 'Globex_Back_HScorpio.pdf', associated_name: 'Hank Scorpio', side: 'back', layout_id: null },
            { id: 'img-o6-fg-b', proof_version_id: vid, image_path: 'proofs/o6-fg-back.pdf', original_filename: 'Globex_Back_FGrimes.pdf', associated_name: 'Frank Grimes', side: 'back', layout_id: null },
          ]
        }
        const suffix = i === 0 ? '' : `-${vid}`
        return [
          { id: `img-front${suffix}`, proof_version_id: vid, image_path: 'proofs/approved-front.pdf', original_filename: 'Approved_Front.pdf', associated_name: null, side: 'front', layout_id: null },
          { id: `img-back${suffix}`, proof_version_id: vid, image_path: 'proofs/approved-back.pdf', original_filename: 'Approved_Back.pdf', associated_name: null, side: 'back', layout_id: null },
        ]
      })
    }
  } else if (table === 'proof_events') {
    // The change request the pins below arrived with — same proof_event_id, so
    // the detail page's strip can group them under this comment the way
    // proof-action wrote them.
    const versionIds: string[] = filters['in:proof_version_id'] ?? []
    rows = versionIds.map((vid) => ({
      id: 'evt-1', proof_version_id: vid, name: null, event_type: 'request_changes',
      actor_name: 'Nolan Bushnell',
      comment: 'Just numbers on the back please under the barcode starting at 001 working upwards',
      from_ip: null, from_ua: null, helpscout_thread_id: null,
      created_at: daysAgo(0.2), round_variant_id: null, side: null,
      proof_round_variants: null,
    }))
  } else if (table === 'proof_annotations') {
    // Customer pins as proof-action writes them (migration 000347): one per
    // side, and — the detail that matters — a SHARED created_at, because both
    // rows land in a single insert. The designer editor sorts on that column,
    // so this fixture is what makes the tie-break testable at all.
    rows = [
      {
        id: 'pin-front', proof_version_id: 'demo-version', proof_version_image_id: 'img-front',
        side: 'front', associated_name: 'Nolan Bushnell', x: 0.30, y: 0.40,
        body: 'Logo sits too low here', author_kind: 'customer', created_by: null,
        author_name: 'Nolan Bushnell', proof_event_id: 'evt-1', resolved_at: null,
        resolved_by: null, created_at: '2026-07-26T16:32:41.989Z',
      },
      {
        id: 'pin-back', proof_version_id: 'demo-version', proof_version_image_id: 'img-back',
        side: 'back', associated_name: 'Nolan Bushnell', x: 0.70, y: 0.25,
        body: 'Tagline should be bolder', author_kind: 'customer', created_by: null,
        author_name: 'Nolan Bushnell', proof_event_id: 'evt-1', resolved_at: null,
        resolved_by: null, created_at: '2026-07-26T16:32:41.989Z',
      },
    ]
  } else if (table === 'proof_sets') {
    rows = BUNDLE_SETS
  } else if (table === 'nudge_runs') {
    // The Outbox's heartbeat (000214). Matched on the select, not on
    // includes(): the panel reads this table TWICE, and its second read —
    // unfinished runs — filters with `.is('finished_at', null)`, which this
    // mock chains as a no-op. Handing that read the finished row below would
    // raise the "a run never finished, sending is paused" alarm on a healthy
    // fixture.
    rows = select.includes('mode')
      ? [{ id: 'run-1', started_at: hoursAgo(3), finished_at: hoursAgo(3), mode: 'live', candidates_computed: 3, sent: 1, skipped: 2, errors: null }]
      : []
  } else if (table === 'proof_nudges') {
    // The latest run's ledger, one row per Outbox section so all three render:
    // a send, a skip only a human can clear, and a self-clearing hold. Every
    // proof_id here is a DASHBOARD_PROJECTS row, because the panel has no names
    // of its own — it turns proof_id into "Sweet Beats" by looking the proof up
    // in the array the dashboard hands it. Same select-string split as above:
    // the stale-'sending' read narrows with `.lt`, which this mock ignores.
    rows = select.includes('rendered_body')
      ? [
          { id: 'n-1', proof_id: 'p-x1', rule_code: 'sent_never_viewed', source: 'auto', state: 'sent', outcome: 'sent', detail: null, rendered_body: 'Just checking you saw the proof.', created_at: hoursAgo(2) },
          { id: 'n-2', proof_id: 'p-r1', rule_code: 'viewed_not_actioned', source: 'auto', state: 'skipped', outcome: 'skipped_conversation_missing', detail: 'No Help Scout conversation is linked to this project.', created_at: hoursAgo(2) },
          { id: 'n-3', proof_id: 'p-r2', rule_code: 'sent_never_viewed', source: 'auto', state: 'skipped', outcome: 'skipped_grace_window', detail: null, created_at: hoursAgo(2) },
        ]
      : []
    if (filters['eq:source']) rows = rows.filter((r) => r.source === filters['eq:source'])
  } else if (table === 'settings') {
    rows = [{ ordering_enabled: true, order_reminders_max: 3, order_reminder_interval_days: 3, auto_order_reminders_enabled: true, auto_nudges_enabled: true, artwork_check_mode: 'live', artwork_check_required: false, artwork_check_model: null, proof_check_enabled: true, proof_callouts_enabled: true, proof_pins_enabled: true, direct_handoff_mode: 'live' }]
  } else if (table === 'site_settings') {
    rows = [{ needs_attention_rules: { helpscout_reply_grace_days: 3 } }]
  } else if (table === 'order_nudges') {
    // order_group_id (000388) is what separates the two ledgers. A group-level
    // reminder is booked against its representative member's order_id as WELL
    // as the group's, so the g1 row below is deliberately shaped like the real
    // thing: it carries order_id 'o3' and must not be counted as o3's own.
    rows = [
      { order_id: 'o1', order_group_id: null, reminder_no: 1, state: 'sent', outcome: 'sent', created_at: daysAgo(1) },
      { order_id: 'o2', order_group_id: null, reminder_no: 1, state: 'sent', outcome: 'sent', created_at: daysAgo(14) },
      { order_id: 'o2', order_group_id: null, reminder_no: 2, state: 'sent', outcome: 'sent', created_at: daysAgo(10) },
      { order_id: 'o2', order_group_id: null, reminder_no: 3, state: 'sent', outcome: 'sent', created_at: daysAgo(7) },
      { order_id: 'o3', order_group_id: 'g1', reminder_no: 1, state: 'sent', outcome: 'sent', created_at: daysAgo(3) },
    ]
    // Both surfaces read both ledgers with ONE `in` on order_id and split them
    // client-side, precisely because a group's representative is always one of
    // its members and therefore always in this list.
    if (Array.isArray(filters['in:order_id'])) rows = rows.filter((r) => filters['in:order_id'].includes(r.order_id))
  } else if (table === 'order_groups') {
    // sent_at is read by the dashboard's Awaiting-payment panel, which reports a
    // combined payment from the GROUP's stamps rather than any member's.
    rows = [
      { id: 'g1', status: 'sent', currency: 'GBP', token: 'gtok', payment_reference: 'GRP-TEST01', sent_at: daysAgo(6), expires_at: daysAhead(12), pay_link_opened_at: null, xero_invoice_id: null, xero_invoice_error: null, orders: [] },
      // A combined payment whose link the customer has opened. The open is
      // stamped on the GROUP, never on a member — read the orders table alone
      // and a combined payment shows nothing at all — so the Latest-activity
      // feed reads it from here and names it from the embedded members.
      //
      // Deliberately NOT referenced by any row in ORDERS: the Awaiting-payment
      // panel fetches groups with an `in:id` of the member orders it loaded, so
      // an unreferenced group is invisible to it and this fixture can't move
      // that panel's numbers.
      {
        id: 'g2', status: 'sent', currency: 'GBP', token: 'gtok2', payment_reference: 'GRP-TEST02',
        sent_at: daysAgo(2), expires_at: daysAhead(12), pay_link_opened_at: hoursAgo(3),
        xero_invoice_id: null, xero_invoice_error: null,
        orders: [
          { proof_id: 'p-grp-1', proofs: { contacts: contact('Wonka Industries', 'Willy Wonka') } },
          { proof_id: 'p-grp-2', proofs: { contacts: contact('Wonka Industries', 'Willy Wonka') } },
        ],
      },
    ]
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
        else if (prop === 'neq') state.filters[`neq:${args[0]}`] = args[1]
        else if (prop === 'gte') state.filters[`gte:${args[0]}`] = args[1]
        return proxy
      }
    },
  })
  return proxy
}

// ── Realtime handler registry ───────────────────────────────────────────────
//
// Every postgres_changes handler the page registers, so window.__pvRealtime can
// deliver a row through the real client code. Handlers are removed again on
// removeChannel, so a remount (StrictMode's double-mount, HMR) can't leave a
// stale one behind and deliver the same row twice.
interface HarnessRealtimeHandler {
  table?: string
  event?: string
  cb: (payload: unknown) => void
}
const harnessRealtimeHandlers: HarnessRealtimeHandler[] = []

if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__pvRealtime = {
    /**
     * Deliver one row to every handler watching `table`, shaped like a real
     * supabase-js postgres_changes payload. Returns how many handlers took it,
     * so a spec can assert it was actually wired up rather than pass because
     * nothing was listening.
     */
    emit(table: string, row: Record<string, unknown>, event = 'INSERT'): number {
      let delivered = 0
      for (const h of [...harnessRealtimeHandlers]) {
        if (h.table !== table) continue
        if (h.event && h.event !== '*' && h.event !== event) continue
        h.cb({ eventType: event, schema: 'proofs', table, new: row, old: {} })
        delivered++
      }
      return delivered
    },
  }
}

export const supabase: any = {
  from: (table: string) => makeBuilder('proofs', table),
  schema: (schema: string) => ({ from: (table: string) => makeBuilder(schema, table) }),
  // Generic RPC stand-in — DashboardPage (and others) call these directly on
  // `supabase`, not via `.from()`, so they need their own fixture path.
  // Unknown names resolve to an empty array, matching the file's existing
  // "unrelated chrome never breaks the page under test" philosophy.
  rpc: async (name: string, args?: any) => {
    const hooked =
      customerProofRpc(name, args) ?? payPagesRpc(name, args) ?? versionFormRpc(name, args) ?? reorderDeskRpc(name, args)
    if (hooked) return hooked
    // The real function (000205) returns the working set for an empty search
    // and, for a non-empty one, ONLY the rows matching it across five fields —
    // it is NOT a superset of the working set. Modelled here because that
    // narrowing is load-bearing on the dashboard: everything the page joins
    // against this array by proof_id (Outbox labels, the activity feed) loses
    // its names if it reads the searched copy. Ignoring p_search made the page
    // untestable in exactly the place it broke.
    if (name === 'dashboard_list') {
      const term = String(args?.p_search ?? '').trim().toLowerCase()
      if (!term) return { data: DASHBOARD_PROJECTS, error: null }
      const hit = (v: unknown) => String(v ?? '').toLowerCase().includes(term)
      return {
        data: DASHBOARD_PROJECTS.filter((p: any) =>
          hit(p.company_name) || hit(p.contact_name) || hit(p.contact_email) ||
          hit(p.helpscout_conversation_id) || hit(p.proof_id),
        ),
        error: null,
      }
    }
    // Stock Control dispatch state (migration 000356) — Admin → Shipping uses
    // this to drop already-sent parcels off the readiness worklist. o9 is
    // delivered, o10 shipped-but-not-yet-delivered; both are `fulfilled` with
    // no ship_to_* captured, so without this they'd sit in the worklist for
    // ever. The other post-payment fixtures stay absent = not shipped.
    if (name === 'admin_order_shipping_state') {
      return {
        data: [
          { order_id: 'o9', shipped_at: daysAgo(4), delivered_at: daysAgo(2) },
          { order_id: 'o10', shipped_at: daysAgo(3), delivered_at: null },
        ],
        error: null,
      }
    }
    // The staff roster, as the real SECURITY DEFINER RPC returns it. Lets the
    // Edit-profile colour picker be checked with colours actually taken.
    if (name === 'team_roster') return { data: PROFILES, error: null }
    // Artwork-check usage (migration 000358). Shaped from the live figures on
    // 2026-07-27 so the Analytics → Artwork checks panel can be eyeballed:
    // both gates present, a mix of verdicts, one error, and deliberate runs
    // spread across four people so the "by whom" table has something to say.
    // Check-response comparison (000359). Shaped to show the panel doing its
    // job: flagged sends people back far more often than clear, against a
    // no-check baseline near the observed ~11%.
    if (name === 'analytics_check_response') {
      return {
        data: {
          days: 30,
          flagged: { decisions: 9, edited: 5 },
          clear: { decisions: 14, edited: 1 },
          no_check: { decisions: 46, edited: 5 },
          order_exits: { total: 4, after_findings: 3 },
          stamped_decisions: 69,
        },
        error: null,
      }
    }
    if (name === 'analytics_artwork_check') {
      return {
        data: {
          days: 30,
          since: daysAgo(30),
          totals: {
            runs: 57, clear: 36, flagged: 12, defect: 8, error: 1,
            reruns: 9, manual_runs: 19, auto_runs: 37, people: 4,
            orders_checked: 37, versions_checked: 19,
            flags_found: 31, defects_found: 13, runs_with_findings: 20,
          },
          by_kind: [
            { kind: 'order', runs: 38, clear: 25, flagged: 8, defect: 4, error: 1, manual_runs: 7, flags_found: 16, defects_found: 6 },
            { kind: 'proof', runs: 19, clear: 11, flagged: 4, defect: 4, error: 0, manual_runs: 12, flags_found: 15, defects_found: 7 },
          ],
          by_source: [
            { source: 'auto_folder_link', runs: 24, clear: 16, flagged: 5, defect: 2, error: 1 },
            { source: 'designer', runs: 19, clear: 10, flagged: 5, defect: 4, error: 0 },
            { source: 'auto_page', runs: 13, clear: 9, flagged: 2, defect: 2, error: 0 },
            { source: 'unknown', runs: 1, clear: 1, flagged: 0, defect: 0, error: 0 },
          ],
          by_person: [
            { ran_by: 'u2', name: 'Jack Johnson', initials: 'JJ', colour: 'purple', manual_runs: 12, auto_page_runs: 6, order_runs: 4, proof_runs: 8, clear: 7, flagged: 3, defect: 2, error: 0, last_run_at: daysAgo(1) },
            { ran_by: 'u1', name: 'Rob Randtoul', initials: 'RR', colour: 'blue', manual_runs: 5, auto_page_runs: 2, order_runs: 2, proof_runs: 3, clear: 2, flagged: 2, defect: 1, error: 0, last_run_at: daysAgo(0) },
            { ran_by: 'u3', name: 'Chris Jackson', initials: 'CJ', colour: 'teal', manual_runs: 1, auto_page_runs: 3, order_runs: 1, proof_runs: 0, clear: 1, flagged: 0, defect: 0, error: 0, last_run_at: daysAgo(6) },
            { ran_by: 'u4', name: 'Donna Lambe', initials: 'DL', colour: 'coral', manual_runs: 1, auto_page_runs: 2, order_runs: 0, proof_runs: 1, clear: 0, flagged: 0, defect: 1, error: 0, last_run_at: daysAgo(4) },
          ],
          weekly: [
            { week_start: daysAgo(21), runs: 0, clear: 0, flagged: 0, defect: 0, error: 0, manual_runs: 0 },
            { week_start: daysAgo(14), runs: 1, clear: 1, flagged: 0, defect: 0, error: 0, manual_runs: 0 },
            { week_start: daysAgo(7), runs: 51, clear: 33, flagged: 11, defect: 7, error: 0, manual_runs: 16 },
            { week_start: daysAgo(0), runs: 5, clear: 2, flagged: 1, defect: 1, error: 1, manual_runs: 3 },
          ],
          // Per-day runs (000363). Zero-filled server-side, so the fixture
          // includes empty days too — the whole point of the chart is that a
          // quiet day reads as a gap rather than being skipped over.
          daily: Array.from({ length: 30 }, (_, i) => {
            const back = 29 - i
            // A dead first week, then steady weekday use with quiet weekends —
            // the shape the zero-fill exists to make visible.
            const dow = (new Date(Date.parse(daysAgo(back))).getUTCDay() + 6) % 7
            const quiet = back > 22 || dow >= 5
            const runs = quiet ? 0 : [3, 7, 5, 9, 4, 6, 8][i % 7]
            const flagged = runs > 0 ? Math.floor(runs / 4) : 0
            const defect = runs > 6 ? 1 : 0
            return {
              day: daysAgo(back),
              runs,
              clear: Math.max(0, runs - flagged - defect),
              flagged,
              defect,
              error: 0,
              manual_runs: runs > 0 ? Math.min(runs, 2) : 0,
            }
          }),
          proof_adoption: { from: daysAgo(4), versions_created: 49, versions_checked: 14 },
          // Advisory tick-off feedback (000385) — enough shape to render the
          // reason-mix bar, the misread chips and the recent list.
          acks: {
            ticked_total: 11,
            reports_with_ticks: 6,
            by_reason: { fixed: 5, intentional: 3, incorrect: 3 },
            misread_by_field: [
              { field: 'qr', count: 2 },
              { field: 'website', count: 1 },
            ],
            recent_misread: [
              { at: daysAgo(1), kind: 'proof', field: 'qr', printed: 'https://qcrd.uk/7k2nq8x', supplied: '', card: 'Derrick Smith — front/back' },
              { at: daysAgo(2), kind: 'order', field: 'website', printed: 'plak8.co', supplied: 'plak8.com', card: 'Shared front' },
              { at: daysAgo(3), kind: 'order', field: 'qr', printed: 'https://qcrd.uk/9m1xy2a', supplied: '', card: 'Jo Bloggs — front' },
            ],
          },
          // Per-(gate, model) spend buckets, copied from the live figures on
          // 2026-07-27 so the cost panel shows realistic money. Includes an
          // unpriced '(unrecorded)' bucket to exercise the excluded-runs note.
          spend: [
            { kind: 'order', model: 'claude-opus-4-8', runs: 33, input_tokens: 350313, output_tokens: 74781, cache_read_tokens: 94737, cache_write_tokens: 75672 },
            { kind: 'proof', model: 'claude-opus-4-8', runs: 14, input_tokens: 87932, output_tokens: 31776, cache_read_tokens: 12223, cache_write_tokens: 73836 },
            { kind: 'proof', model: 'claude-opus-5', runs: 11, input_tokens: 77506, output_tokens: 38000, cache_read_tokens: 0, cache_write_tokens: 69256 },
            { kind: 'order', model: 'claude-opus-5', runs: 11, input_tokens: 135159, output_tokens: 25520, cache_read_tokens: 42601, cache_write_tokens: 34541 },
            { kind: 'order', model: '(unrecorded)', runs: 4, input_tokens: 12000, output_tokens: 3000, cache_read_tokens: 0, cache_write_tokens: 0 },
          ],
          cost: {
            input_tokens: 394789, output_tokens: 85464, cache_read_tokens: 0, cache_write_tokens: 0,
            models: [{ model: 'claude-opus-4-8', runs: 52 }, { model: 'claude-opus-5', runs: 5 }],
          },
        },
        error: null,
      }
    }
    // Annotation usage (migration 000362). Shaped to exercise every arm of the
    // Analytics → Annotations tab rather than to mirror live: both gates on,
    // both halves in use, several designers writing callouts, and a resolve
    // rate that is neither 0% nor 100%. The live figures on 2026-07-28 are far
    // smaller (6 callouts, 5 pins, nothing ticked off) — a fixture that copied
    // them would leave the table, the chart and the follow-through panel with
    // nothing to show.
    if (name === 'analytics_annotations') {
      return {
        data: {
          days: 30,
          since: daysAgo(30),
          gates: { callouts_enabled: true, pins_enabled: true },
          callouts: { notes: 34, versions: 21, proofs: 16, designers: 3, last_at: daysAgo(0) },
          pins: { notes: 27, versions: 12, proofs: 11, change_requests: 14, last_at: daysAgo(1) },
          callout_adoption: { from: daysAgo(26), versions_created: 74, versions_with_callout: 19 },
          pin_adoption: { from: daysAgo(26), change_requests: 41, change_requests_with_pins: 14, pins_on_those: 27 },
          follow_through: { pins: 27, resolved: 18, median_hours_to_resolve: 19.5 },
          by_person: [
            { created_by: 'u1', name: 'Rob Randtoul', initials: 'RR', colour: 'blue', notes: 18, versions: 11, proofs: 9, last_at: daysAgo(0) },
            { created_by: 'u2', name: 'Jack Johnson', initials: 'JJ', colour: 'purple', notes: 11, versions: 7, proofs: 5, last_at: daysAgo(2) },
            { created_by: 'u4', name: 'Donna Lambe', initials: 'DL', colour: 'coral', notes: 5, versions: 3, proofs: 2, last_at: daysAgo(9) },
          ],
          weekly: [
            { week_start: daysAgo(21), callouts: 2, pins: 0, proofs: 2 },
            { week_start: daysAgo(14), callouts: 7, pins: 4, proofs: 6 },
            { week_start: daysAgo(7), callouts: 16, pins: 13, proofs: 11 },
            { week_start: daysAgo(0), callouts: 9, pins: 10, proofs: 8 },
          ],
        },
        error: null,
      }
    }
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
      const hooked =
        customerProofInvoke(name, opts?.body) ??
        payPagesInvoke(name, opts?.body) ??
        versionFormInvoke(name, opts?.body) ??
        reorderDeskInvoke(name, opts?.body) ??
        dropboxImportInvoke(name, opts?.body)
      if (hooked) return hooked
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
      // Approving the proof a supplier sent back (000409). Preview returns the
      // rendered message so the compose box fills; the send returns ok. The mock
      // is stateless, so a spec asserts up to the send succeeding — the card
      // leaving CHECK depends on the refetch, which the mock can't model.
      if (name === 'approve-supplier-proof') {
        if (opts?.body?.mode === 'preview') {
          return {
            data: {
              ok: true,
              // QX's own per-supplier body (they are the fixtures' supplier).
              // The shared default is deliberately vaguer — see 000409.
              body: 'Hi,\n\nThanks — the proof is approved. Please go ahead and produce the order.\n\nMany thanks.',
              supplier_name: 'QX Metals',
              conversation_id: 'hs-sup-1',
            },
            error: null,
          }
        }
        return { data: { ok: true, replied: opts?.body?.skip_reply !== true, thread_id: 1, approved_at: new Date().toISOString() }, error: null }
      }
      if (name === 'place-order') {
        // ?path=/orders/o-blanks/place — the combined-supplier-batches rig.
        // An ABSENT blanks field plays back the stored choice (o-thornton), so
        // the page loads straight into the ACTIVE blanks state; the undo
        // button sends an explicit null and lands on the supplier route with
        // the picker disclosure (candidates come from the orders fixtures).
        {
          const body = (opts?.body ?? {}) as { order_id?: string; blanks_source_order_id?: string | null }
          if (body.order_id === 'o-blanks') {
            const chosen = 'blanks_source_order_id' in body ? body.blanks_source_order_id : 'o-thornton'
            // &blanksShort=1 — same rig, but the Thornton batch was ordered
            // with fewer overs (1,000 + 800 = 1,800), so it CANNOT cover both
            // orders' 1,000s: spare_after_both goes negative and the summary
            // card's amber "short" warning renders. URL-flag idiom like
            // ?busy=1 — extra params ride through the harness untouched.
            const blanksBatchQty = new URLSearchParams(window.location.search).get('blanksShort') === '1' ? 1800 : 2200
            const apexSummary = {
              customer: 'Apex Dental & Implant Centre',
              material: 'Standard Paper',
              variant: 'With Foiling',
              finish: null,
              inkFront: 'Gold foil, White foil',
              inkBack: null,
              quantity: 1000,
              supplierQuantity: 1000,
              supplierOvers: 0,
              split: [],
              packaging: 'Domestic',
              dateRequired: '07 Aug 2026',
              dropboxFolderUrl: 'https://www.dropbox.com/scl/fo/abc/order-403958',
            }
            if (chosen) {
              return {
                data: {
                  ok: true,
                  route: 'in_house',
                  subject: 'Order 403958 - Apex Dental & Implant Centre',
                  note_lines: [
                    'Qty: 1000',
                    'Card: Standard Paper',
                    'Date required: 07 Aug 2026',
                    'Ink on front: Gold foil, White foil',
                    'Packaging: Domestic',
                    'Artwork: https://www.dropbox.com/scl/fo/abc/order-403958',
                    '',
                    `Base cards: no separate supplier order — this job’s 1,000 blanks come from the ${blanksBatchQty.toLocaleString('en-GB')}-card batch ordered from Solopress under order 403957 (Thornton Dental & Implant Centre). Do not order more blanks.`,
                  ],
                  summary: { ...apexSummary, route: 'in_house' },
                  helpscout_linked: true,
                  artwork_plan: { attach: ['Apex_Front_FOIL.pdf', 'Apex_Back_FOIL.pdf'], skipped: [] },
                  blanks_source: {
                    order_id: 'o-thornton',
                    reference: 'ORD-O-THORNTON',
                    stock_order_number: '403957',
                    label: 'Thornton Dental & Implant Centre',
                    supplier_name: 'Solopress',
                    batch_quantity: blanksBatchQty,
                    source_quantity: 1000,
                    // Batch minus both orders' cards (1,000 + 1,000): +200
                    // healthy, −200 under the short flag.
                    spare_after_both: blanksBatchQty - 2000,
                  },
                  handoff_validation: {
                    ok: true,
                    problems: [],
                    warnings: [
                      { code: 'material_line_skipped', message: '"Standard Paper" isn’t a Stock Control material — the job will go in without a material line (fine for supplier-blank finishing; map it in Admin → Catalogue data → Stock materials to change that).' },
                    ],
                  },
                },
                error: null,
              }
            }
            const solopress = { id: 's2', name: 'Solopress', email: 'orders@solopress.example', is_international: false, default_shipping_days: null }
            return {
              data: {
                ok: true,
                route: 'supplier',
                subject: 'Order 403958 - Apex Dental & Implant Centre',
                // Deliberately DIFFERENT from the supplier subject above: the
                // customer's thread is renamed to the Dropbox folder name, and
                // on live those two disagree on half of all supplier orders.
                // Equal values would hide the review screen's new line.
                customer_thread_subject: 'Order 403958 - Apex Dental Reception Cards',
                email_lines: [
                  'Hi,',
                  '',
                  'Please produce the following order for Apex Dental & Implant Centre:',
                  '',
                  'Qty: 1000',
                  'Material: Standard cards',
                  'Type: Standard Paper',
                  'Finish: With Foiling',
                  'Must ship by: 05 Aug 2026',
                  '',
                  'Artwork: https://www.dropbox.com/scl/fo/abc/order-403958',
                  '',
                  'Many thanks.',
                ],
                supplier: solopress,
                suppliers: [solopress],
                ship_by: '05 Aug 2026',
                summary: { ...apexSummary, route: 'supplier' },
                helpscout_linked: true,
                artwork_plan: { attach: [], skipped: [] },
                blanks_source: null,
              },
              error: null,
            }
          }
        }
        // OrderReviewPage preview (?path=/orders/o1/place). In-house route
        // with the Stock Control hand-off checks populated (a problem + a
        // warning) so both cards can be verified visually: the rose "can't
        // accept this order yet" for the problem and the amber advisory note
        // for the warning.
        //
        // `blocking` mirrors settings.direct_handoff_mode = 'live' (what the
        // real DB carries today): confirm re-runs the same RPC for real and
        // fails with the problem's own message. To see the SHADOW rendering —
        // one amber card, "these checks don't block placing the order", Confirm
        // live — run sessionStorage.setItem('handoffShadow','1') then reload.
        // Off by default; harness-only, never ships.
        const handoffBlocking =
          typeof sessionStorage === 'undefined' || sessionStorage.getItem('handoffShadow') !== '1'
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
              blocking: handoffBlocking,
              problems: [
                { code: 'material_unmapped', message: 'Stainless Steel has no Stock Control mapping — set it on Admin → Catalogue data → Stock materials.' },
              ],
              warnings: [
                { code: 'number_in_use', message: 'Stock Control already has a live job numbered 403999 (Acme Ltd) — the hand-off will attach to it rather than create a duplicate.' },
              ],
            },
          },
          error: null,
        }
      }
      if (name === 'artwork-check') {
        // Advisory tick-off ("Mark as addressed"): ticks accumulate for this
        // page load — the module-level store below resets on reload like all
        // fixture state — so the whole worklist flow (tick, tick, all-
        // addressed headline, undo) can be exercised, not just one click.
        // Mirrors the real function's response shape incl. the
        // `acknowledged: true` deploy-skew sentinel the client requires.
        if (opts?.body?.acknowledge) {
          const a = opts.body.acknowledge as { kind?: string; card?: string; field?: string; printed?: string; quote?: string; reason?: string; undo?: boolean }
          const key = a.kind === 'correction' ? `c:${a.quote}` : `f:${a.card}::${a.field}::${a.printed}`
          if (a.undo) delete artworkAckStore[key]
          else artworkAckStore[key] = { reason: a.reason ?? 'fixed', by: 'Avery Fixture', by_id: 'designer-1', at: '2026-08-05T12:00:00Z' }
          return {
            data: {
              ok: true,
              acknowledged: true,
              report: { ...ARTWORK_REPORT_FLAGGED, acknowledgements: { ...artworkAckStore } },
            },
            error: null,
          }
        }
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
      // Row thumbnails on the dashboard / orders / flagged pages. Without this
      // every row falls through to its initials placeholder, so the thumbnail
      // treatment itself can't be verified here at all. Shape is picked from
      // the version id (not request order), so a row keeps the same artwork
      // across refetches and screenshots are stable.
      if (name === 'dashboard-thumbnails') {
        const ids: string[] = Array.isArray(opts?.body?.versionIds) ? opts.body.versionIds : []
        const thumbs: Record<string, { thumb_url: string; preview_url: string; full_url: string }> = {}
        for (const id of ids) {
          let hash = 0
          for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0
          const [w, h] = THUMB_SHAPES[hash % THUMB_SHAPES.length]
          const colour = THUMB_SHAPE_COLOURS[hash % THUMB_SHAPE_COLOURS.length]
          // ASCII only — btoa emits Latin-1 bytes, and a non-ASCII label (an
          // '×', say) decodes as invalid UTF-8, so the SVG never parses and the
          // thumbnail silently renders as a 0x0 broken image.
          const url = aspectSwatch(colour, `${w}x${h}`, w, h)
          thumbs[id] = { thumb_url: url, preview_url: url, full_url: url }
        }
        return { data: { thumbs }, error: null }
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
  // Realtime — the harness has no socket, so this stays inert by default:
  // subscribe() never reports a status, exactly as before, and nothing arrives
  // on its own.
  //
  // It does now REMEMBER each postgres_changes handler, so a spec can hand a
  // row to window.__pvRealtime.emit() and watch the page react through its real
  // code. Without that, the dashboard's live activity feed is the one part of
  // that page nothing offline can exercise — and "the socket delivered
  // something and the card did the right thing with it" is the whole point of
  // the feature.
  channel: (_name: string) => {
    const mine: HarnessRealtimeHandler[] = []
    const ch: any = {
      on: (type: string, cfg: any, cb: (payload: any) => void) => {
        if (type === 'postgres_changes' && typeof cb === 'function') {
          const handler: HarnessRealtimeHandler = { table: cfg?.table, event: cfg?.event, cb }
          mine.push(handler)
          harnessRealtimeHandlers.push(handler)
        }
        return ch
      },
      subscribe: () => ch,
      unsubscribe: async () => 'ok',
      send: async () => 'ok',
      track: async () => 'ok',
      untrack: async () => 'ok',
      presenceState: () => ({}),
      __harnessHandlers: mine,
    }
    return ch
  },
  removeChannel: async (ch?: any) => {
    for (const handler of (ch?.__harnessHandlers ?? []) as HarnessRealtimeHandler[]) {
      const i = harnessRealtimeHandlers.indexOf(handler)
      if (i !== -1) harnessRealtimeHandlers.splice(i, 1)
    }
    return 'ok'
  },
  storage: {
    // Return a data-URL "signed URL" so the Approved artwork downloads work in
    // the harness (fetch(dataUrl) → blob) without a real storage backend.
    from: (_bucket: string) => ({
      createSignedUrl: async (path: string) => ({ data: { signedUrl: swatch('#334155', path.slice(-8)) }, error: null }),
      // Batch variant (thumbnail loaders on ProofDetailPage / the dashboard).
      createSignedUrls: async (paths: string[]) => ({
        data: paths.map((p) => ({ error: null, path: p, signedUrl: swatch('#334155', p.slice(-8)) })),
        error: null,
      }),
      // Write-path no-ops so upload flows (version forms) don't crash the
      // page under test; nothing is persisted, which the specs know.
      upload: async (path: string) => ({ data: { path }, error: null }),
      copy: async (_from: string, to: string) => ({ data: { path: to }, error: null }),
      remove: async (_paths: string[]) => ({ data: [], error: null }),
      getPublicUrl: (path: string) => ({ data: { publicUrl: swatch('#334155', path.slice(-8)) } }),
    }),
  },
  supabaseUrl: 'https://example.supabase.co',
}
