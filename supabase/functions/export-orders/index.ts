// Admin-only edge function: export the unified order log as CSV, honouring the
// same filter params as the Admin → Order log page (search, status, date range).
//
// The log joins two schemas (proofs.orders + Stock Control's public.orders /
// outsourced_orders), so it's read through the SECURITY DEFINER RPC
// proofs.admin_search_orders — the single source of truth for the join + filters
// (migration 000263). That RPC gates on auth.uid() being an admin, so we call it
// with the caller's JWT-scoped client (requireAdmin already proved they're admin),
// NOT the service-role client (which has no user context). The RPC caps a page at
// 200 rows, so we page through with offset until a short page to lift the cap for
// the export.

import { CORS_HEADERS, json, requireAdmin } from '../_shared/admin.ts'
import { toCsv } from '../_shared/csv.ts'

const PAGE = 200

const HEADER = [
  'date',
  'payment_reference',
  'commercial_status',
  'company',
  'contact',
  'contact_email',
  'material',
  'variant',
  'finish',
  'quantity',
  'currency',
  'total',
  'amount_cards',
  'amount_tooling',
  'amount_personalisation',
  'amount_shipping',
  'amount_us_tariff',
  'amount_card_discount',
  'payment_method',
  'xero_invoice_id',
  'production_route',
  'job_number',
  'production_status',
  'supplier',
  'tracking_status',
  'tracking_number',
  'created_at',
  'paid_at',
  'fulfilled_at',
  'date_required',
  'dropbox_folder_url',
]

interface OrderRow {
  payment_reference: string | null
  order_status: string | null
  company_name: string | null
  contact_name: string | null
  contact_email: string | null
  material: string | null
  variant: string | null
  finish: string | null
  quantity: number | null
  currency: string | null
  custom_quote_total: number | null
  amount_cards: number | null
  amount_tooling: number | null
  amount_personalisation: number | null
  amount_shipping: number | null
  amount_us_tariff: number | null
  amount_card_discount: number | null
  payment_method: string | null
  xero_invoice_id: string | null
  production_route: string | null
  job_number: string | null
  inhouse_status: string | null
  outsourced_status: string | null
  production_supplier: string | null
  chosen_supplier: string | null
  tracking_status: string | null
  customer_tracking_number: string | null
  created_at: string | null
  paid_at: string | null
  fulfilled_at: string | null
  date_required: string | null
  dropbox_folder_url: string | null
}

const round2 = (n: number) => Math.round(n * 100) / 100

// Charged total — mirrors src/lib/orderDisplay.ts orderTotal so the CSV agrees
// with what the page shows.
function orderTotal(o: OrderRow): number | null {
  const discount = Number(o.amount_card_discount ?? 0)
  const tariff = Number(o.amount_us_tariff ?? 0)
  if (o.custom_quote_total != null) return round2(Number(o.custom_quote_total) - discount + tariff)
  const parts = [o.amount_cards, o.amount_tooling, o.amount_personalisation, o.amount_shipping]
  if (parts.every((p) => p == null) && tariff === 0) return null
  return round2(parts.reduce((acc: number, p) => acc + Number(p ?? 0), 0) - discount + tariff)
}

function todayStamp(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'GET' && req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const check = await requireAdmin(req)
  if (check instanceof Response) return check
  const { user } = check

  const url = new URL(req.url)
  const q      = url.searchParams.get('q') ?? ''
  const status = url.searchParams.get('status') ?? ''   // '' / 'all' → every status
  const from   = url.searchParams.get('from') ?? ''
  const to     = url.searchParams.get('to') ?? ''

  try {
    const all: OrderRow[] = []
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await user.rpc('admin_search_orders', {
        p_search: q,
        p_status: status && status !== 'all' ? status : null,
        p_from: from || null,
        p_to: to || null,
        p_sort: 'date_desc',
        p_limit: PAGE,
        p_offset: offset,
      })
      if (error) throw error
      const orders = ((data as { orders?: OrderRow[] } | null)?.orders ?? [])
      all.push(...orders)
      if (orders.length < PAGE) break
      // Safety stop so a logic error can't loop forever.
      if (offset > 100_000) break
    }

    const rows: (string | number | null)[][] = [HEADER]
    for (const o of all) {
      const total = orderTotal(o)
      rows.push([
        o.paid_at ?? o.created_at ?? '',
        o.payment_reference,
        o.order_status,
        o.company_name,
        o.contact_name,
        o.contact_email,
        o.material,
        o.variant,
        o.finish,
        o.quantity,
        o.currency,
        total == null ? '' : total.toFixed(2),
        o.amount_cards,
        o.amount_tooling,
        o.amount_personalisation,
        o.amount_shipping,
        o.amount_us_tariff,
        o.amount_card_discount,
        o.payment_method,
        o.xero_invoice_id,
        o.production_route,
        o.job_number,
        o.production_route === 'in_house' ? o.inhouse_status : o.outsourced_status,
        o.production_supplier ?? o.chosen_supplier,
        o.tracking_status,
        o.customer_tracking_number,
        o.created_at,
        o.paid_at,
        o.fulfilled_at,
        o.date_required,
        o.dropbox_folder_url,
      ])
    }

    return new Response(toCsv(rows), {
      headers: {
        ...CORS_HEADERS,
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="order_log_${todayStamp()}.csv"`,
      },
    })
  } catch (err) {
    console.error('export-orders error:', err)
    return json({ error: (err as Error).message ?? 'Export failed' }, 500)
  }
})
