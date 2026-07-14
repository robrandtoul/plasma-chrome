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
    ship_dest_country: 'GB',
    ship_to_name: null,
    ship_to_email: null,
    ship_to_phone: null,
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
    ship_to_address: { line1: 'Globex Campus', city: 'Cypress Creek', postal_code: 'CC1 2GX', country: 'GB' },
    proofs: { helpscout_last_reply_at: null, helpscout_last_customer_reply_at: null, helpscout_conversation_id: 'hs-3', contacts: contact('Globex', 'Hank Scorpio') },
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
  order({ id: 'o9', status: 'fulfilled', paid_at: daysAgo(8), fulfilled_at: daysAgo(5), proofs: { helpscout_last_reply_at: null, helpscout_last_customer_reply_at: null, helpscout_conversation_id: null, contacts: contact('Pied Piper', 'Richard Hendricks') } }),
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

function resolveQuery(state: QueryState): { data: any; error: null; count?: number } {
  const { table, select, single, filters } = state
  let rows: any[] = []

  if (state.schema === 'public') {
    if (table === 'outsourced_suppliers') rows = [{ id: 's1', name: 'QX Metals' }]
    else if (table === 'materials') rows = [
      { name: 'Satin Black', swatch_hex: '#1f2937', quantity_on_shelf: 240, measured_in: 'sheets' },
      { name: 'Satin White', swatch_hex: '#f9fafb', quantity_on_shelf: 80, measured_in: 'sheets' },
    ]
  } else if (table === 'orders') {
    rows = ORDERS
    if (Array.isArray(filters['in:status'])) rows = rows.filter((r) => filters['in:status'].includes(r.status))
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
      rows = pid ? [{ id: `ver-${pid}`, material_id: ORDERS.find((o) => o.proof_id === pid)?.material_id ?? 'm-steel', is_current: true }] : []
    }
  } else if (table === 'settings') {
    rows = [{ ordering_enabled: true, order_reminders_max: 3, order_reminder_interval_days: 3, auto_order_reminders_enabled: true }]
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
    rows = [{ id: 'g1', status: 'sent', currency: 'GBP', token: 'gtok', payment_reference: 'GRP-TEST01', expires_at: daysAhead(12), xero_invoice_id: null, xero_invoice_error: null }]
    if (Array.isArray(filters['in:id'])) rows = rows.filter((r) => filters['in:id'].includes(r.id))
  } else if (table === 'profiles') {
    rows = [{ designer_initials: 'RR', designer_colour: 'blue', full_name: 'Rob Randtoul', avatar_url: null, feedback_seen_at: null }]
  } else if (table === 'watch_items') {
    return { data: null, error: null, count: 2 }
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
  functions: {
    invoke: async (name: string, opts?: { body?: any }) => {
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
  supabaseUrl: 'https://example.supabase.co',
}
