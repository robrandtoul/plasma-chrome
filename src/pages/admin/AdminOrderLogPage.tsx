import { useEffect, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { downloadBlob } from '../../lib/downloadFile'
import { formatPrice } from '../../lib/currency'
import { orderTotal, specLabel, customerLabel } from '../../lib/orderDisplay'
import { Pill, type PillColour } from '../../design'
import type { Currency } from '../../lib/types'

// Admin → Order log. The full-lifecycle order record: proof-viewer's commercial
// half (proofs.orders) joined to Stock Control's production half (in-house
// public.orders / outsourced public.outsourced_orders) on the 6-digit job
// number. Read through the SECURITY DEFINER RPC admin_search_orders (migration
// 000263) — the single source of truth for the cross-schema join + filters.
//
// Unlike the Orders work queue (which only shows live, uncancelled orders),
// this log defaults to ALL statuses incl. cancelled / expired so nothing is
// hidden. Searchable, date-filterable, exportable (export-orders edge fn).

const PAGE_SIZE = 50

interface OrderLogRow {
  id: string
  payment_reference: string | null
  stock_order_number: string | null
  order_status: string
  payment_method: string | null
  currency: string | null
  custom_quote_total: number | null
  amount_cards: number | null
  amount_tooling: number | null
  amount_personalisation: number | null
  amount_shipping: number | null
  amount_us_tariff: number | null
  amount_card_discount: number | null
  card_discount_type: string | null
  card_discount_value: number | null
  xero_invoice_id: string | null
  xero_invoice_error: string | null
  quantity: number | null
  names_count: number | null
  has_personalisation: boolean | null
  person_quantities: { name: string; quantity: number }[] | null
  created_at: string | null
  sent_at: string | null
  paid_at: string | null
  fulfilled_at: string | null
  revised_at: string | null
  expires_at: string | null
  pay_link_opened_at: string | null
  date_required: string | null
  dropbox_folder_url: string | null
  project_name: string | null
  proof_id: string | null
  ship_to_name: string | null
  ship_to_email: string | null
  ship_to_address: {
    line1?: string | null
    line2?: string | null
    city?: string | null
    region?: string | null
    postal_code?: string | null
    country?: string | null
  } | null
  chosen_supplier: string | null
  company_name: string | null
  contact_name: string | null
  contact_email: string | null
  material_code: string | null
  material: string | null
  variant: string | null
  finish: string | null
  production_route: 'in_house' | 'outsourced' | null
  job_number: string | null
  inhouse_status: string | null
  produced_at: string | null
  completed_at: string | null
  outsourced_status: string | null
  supplier_id: string | null
  production_supplier: string | null
  in_production_at: string | null
  shipped_from_supplier_at: string | null
  shipped_to_customer_at: string | null
  arrived_at: string | null
  outsourced_cancelled_at: string | null
  expected_ship_date: string | null
  expected_arrival_date: string | null
  tracking_status: string | null
  tracking_eta: string | null
  customer_tracking_number: string | null
  tracking_last_event_at: string | null
  tracking_last_event_description: string | null
  // The frozen spec (Phase 2). Present on orders created/placed after the
  // snapshot shipped; null for older orders (the table fields already fall back
  // to the live join in the RPC). Used here only for the artwork-spec detail.
  order_spec_snapshot: {
    ink_names?: string[] | null
    letterpress?: { front: string | null; core: string | null; back: string | null } | null
    captured_at?: string | null
    stage?: string | null
  } | null
}

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: 'all', label: 'All statuses' },
  { value: 'sent', label: 'Awaiting payment' },
  { value: 'paid', label: 'Paid · to order' },
  { value: 'fulfilled', label: 'Ordered' },
  { value: 'revision', label: 'Being revised' },
  { value: 'cancelled', label: 'Cancelled' },
]

function commercialPill(status: string): { colour: PillColour; label: string } {
  switch (status) {
    case 'sent': return { colour: 'low', label: 'Awaiting payment' }
    case 'paid': return { colour: 'in-stock', label: 'Paid' }
    case 'fulfilled': return { colour: 'allocated', label: 'Ordered' }
    case 'revision': return { colour: 'out', label: 'Revision' }
    case 'cancelled': return { colour: 'mute', label: 'Cancelled' }
    case 'expired': return { colour: 'neutral', label: 'Expired' }
    default: return { colour: 'neutral', label: status }
  }
}

// The production half's one-line summary + a colour. Null route = not yet placed
// into Stock Control (every order before placement, plus any whose job number
// didn't match a Stock Control job).
function productionSummary(o: OrderLogRow): { colour: PillColour; label: string } | null {
  if (o.production_route === 'in_house') {
    const s = o.inhouse_status ?? 'pending'
    return { colour: s === 'completed' ? 'in-stock' : 'allocated', label: `In-house · ${s}` }
  }
  if (o.production_route === 'outsourced') {
    const s = o.outsourced_status ?? 'in_production'
    const done = !!o.arrived_at || !!o.shipped_to_customer_at
    return { colour: done ? 'in-stock' : 'allocated', label: `Outsourced · ${s.replace(/_/g, ' ')}` }
  }
  // Placed-worthy statuses with no production match read as "not placed";
  // pre-payment / cancelled orders have nothing to show.
  if (o.order_status === 'paid' || o.order_status === 'fulfilled') {
    return { colour: 'mute', label: 'Not placed' }
  }
  return null
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function cur(o: OrderLogRow): Currency {
  return (o.currency ?? 'GBP') as Currency
}

export default function AdminOrderLogPage() {
  const [rows, setRows] = useState<OrderLogRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [page, setPage] = useState(1)

  // Filters.
  const [searchDraft, setSearchDraft] = useState('')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('all')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  // Export.
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)

  const [openOrder, setOpenOrder] = useState<OrderLogRow | null>(null)
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => { if (searchTimer.current) clearTimeout(searchTimer.current) }, [])

  // Reset to page 1 whenever a filter changes.
  useEffect(() => { setPage(1) }, [search, status, from, to])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoading(true)
      setLoadError(null)
      const { data, error } = await supabase.rpc('admin_search_orders', {
        p_search: search,
        p_status: status === 'all' ? null : status,
        p_from: from || null,
        p_to: to || null,
        p_sort: 'date_desc',
        p_limit: PAGE_SIZE,
        p_offset: (page - 1) * PAGE_SIZE,
      })
      if (cancelled) return
      if (error) {
        setLoadError(error.message)
        setRows([])
        setTotal(0)
        setLoading(false)
        return
      }
      const payload = (data ?? { total: 0, orders: [] }) as { total: number; orders: OrderLogRow[] }
      setRows(payload.orders ?? [])
      setTotal(payload.total ?? 0)
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [search, status, from, to, page])

  function onSearchChange(v: string) {
    setSearchDraft(v)
    if (searchTimer.current) clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(() => setSearch(v), 400)
  }

  function clearFilters() {
    setSearchDraft('')
    setSearch('')
    setStatus('all')
    setFrom('')
    setTo('')
  }

  async function handleExport() {
    setExportError(null)
    setExporting(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) throw new Error('Not signed in')
      const supabaseUrl = (supabase as unknown as { supabaseUrl: string }).supabaseUrl
      const qs = new URLSearchParams()
      if (search) qs.set('q', search)
      if (status !== 'all') qs.set('status', status)
      if (from) qs.set('from', from)
      if (to) qs.set('to', to)
      const resp = await fetch(`${supabaseUrl}/functions/v1/export-orders?${qs}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      if (!resp.ok) throw new Error(`Export failed (${resp.status})`)
      const blob = await resp.blob()
      const header = resp.headers.get('Content-Disposition') ?? ''
      const filename = header.match(/filename="([^"]+)"/)?.[1] ?? 'order_log.csv'
      downloadBlob(blob, filename)
    } catch (e) {
      setExportError((e as Error).message)
    } finally {
      setExporting(false)
    }
  }

  const anyFilter = !!search || status !== 'all' || !!from || !!to
  const firstIndex = rows.length === 0 ? 0 : (page - 1) * PAGE_SIZE + 1
  const lastIndex = (page - 1) * PAGE_SIZE + rows.length
  const hasMore = lastIndex < total

  return (
    <div>
      <div className="mb-4">
        <h2 className="text-xl font-bold text-ink">Order log</h2>
        <p className="mt-1 text-sm text-ink-mute">
          Every order, paid or not, with its production status from Stock Control. Click a row for the full record.
        </p>
      </div>

      {/* ── Filter bar ──────────────────────────────────────────────── */}
      <section className="mb-4 rounded-2xl bg-surface p-4 shadow-sm ring-1 ring-line">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-0 flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-dim">Search</span>
            <input
              type="text"
              placeholder="Company, contact, ref, job no…"
              value={searchDraft}
              onChange={(e) => onSearchChange(e.target.value)}
              className={inputClass}
            />
          </label>

          <label className="flex min-w-0 flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-dim">Status</span>
            <select value={status} onChange={(e) => setStatus(e.target.value)} className={selectClass}>
              {STATUS_OPTIONS.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
          </label>

          <label className="flex min-w-0 flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-dim">From</span>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={inputClass} />
          </label>

          <label className="flex min-w-0 flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-dim">To</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={inputClass} />
          </label>

          <div className="ml-auto flex gap-2">
            <button
              onClick={handleExport}
              disabled={exporting}
              className="rounded px-3 py-2 text-sm font-medium text-ink-soft ring-1 ring-line hover:bg-canvas disabled:opacity-50"
            >
              {exporting ? 'Exporting…' : 'Export CSV'}
            </button>
            {anyFilter && (
              <button
                onClick={clearFilters}
                className="text-sm text-ink-mute underline-offset-2 hover:text-ink hover:underline"
              >
                Clear filters
              </button>
            )}
          </div>
        </div>
        {from && to && from > to && (
          <p className="mt-3 rounded-lg bg-low-soft px-3 py-2 text-xs text-low ring-1 ring-low">
            "From" date is after "To" — the table will be empty until the dates are fixed.
          </p>
        )}
        {exportError && (
          <p className="mt-3 rounded-lg bg-out-soft px-3 py-2 text-xs text-out">{exportError}</p>
        )}
      </section>

      {/* ── List ──────────────────────────────────────────────────── */}
      {loading ? (
        <div className="flex justify-center py-20">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-line border-t-gray-900" />
        </div>
      ) : loadError ? (
        <div className="rounded-2xl bg-out-soft p-6 text-sm text-out ring-1 ring-out">
          Failed to load orders: {loadError}
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-2xl bg-surface py-16 text-center shadow-sm ring-1 ring-line">
          {anyFilter ? (
            <>
              <p className="text-ink-dim">No orders match these filters.</p>
              <button onClick={clearFilters} className="mt-2 text-sm text-ink-mute underline underline-offset-2 hover:text-ink">
                Clear filters
              </button>
            </>
          ) : (
            <p className="text-ink-dim">No orders yet.</p>
          )}
        </div>
      ) : (
        <>
          <div className="table-scroll overflow-y-hidden rounded-2xl bg-surface shadow-sm ring-1 ring-line">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line-soft">
                  <th className={thClass}>Date</th>
                  <th className={thClass}>Customer</th>
                  <th className={thClass}>Spec</th>
                  <th className={`${thClass} text-right`}>Qty</th>
                  <th className={`${thClass} text-right`}>Total</th>
                  <th className={thClass}>Status</th>
                  <th className={thClass}>Production</th>
                  <th className={thClass}>Ref · Job</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((o) => {
                  const pill = commercialPill(o.order_status)
                  const prod = productionSummary(o)
                  const total = orderTotal(o)
                  return (
                    <tr
                      key={o.id}
                      role="button"
                      tabIndex={0}
                      aria-label={`Open order ${o.payment_reference ?? o.id}`}
                      onClick={() => setOpenOrder(o)}
                      onKeyDown={(ev) => {
                        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); setOpenOrder(o) }
                      }}
                      className="cursor-pointer border-b border-line-soft last:border-0 hover:bg-canvas focus:outline-none focus-visible:bg-canvas focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink"
                    >
                      <td className="px-4 py-3 whitespace-nowrap text-ink-mute" title={fmtDateTime(o.paid_at ?? o.created_at)}>
                        {fmtDate(o.paid_at ?? o.created_at)}
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-medium text-ink">{customerLabel(o.company_name, o.contact_name)}</div>
                        {o.company_name && o.contact_name && (
                          <div className="text-xs text-ink-dim">{o.contact_name}</div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-ink-soft">{specLabel(o.material, o.variant, o.custom_quote_total, o.finish)}</td>
                      <td className="px-4 py-3 text-right whitespace-nowrap text-ink-soft">
                        {o.quantity != null ? o.quantity.toLocaleString() : '—'}
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap text-ink">
                        {total != null ? formatPrice(total, cur(o)) : '—'}
                      </td>
                      <td className="px-4 py-3"><Pill colour={pill.colour}>{pill.label}</Pill></td>
                      <td className="px-4 py-3">
                        {prod ? <Pill colour={prod.colour}>{prod.label}</Pill> : <span className="text-ink-dim">—</span>}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <div className="font-mono text-[12px] text-ink-soft">{o.payment_reference ?? '—'}</div>
                        {o.job_number && <div className="font-mono text-[11px] text-ink-dim">Job {o.job_number}</div>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <div className="mt-4 flex items-center justify-between text-sm text-ink-mute">
            <div>Showing {firstIndex} to {lastIndex} of {total.toLocaleString()} orders</div>
            <div className="flex gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="rounded px-3 py-1.5 text-sm font-medium text-ink-soft ring-1 ring-line hover:bg-canvas disabled:opacity-40"
              >
                Previous
              </button>
              <button
                onClick={() => setPage((p) => p + 1)}
                disabled={!hasMore}
                className="rounded px-3 py-1.5 text-sm font-medium text-ink-soft ring-1 ring-line hover:bg-canvas disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </div>
        </>
      )}

      {openOrder && <OrderDetailModal order={openOrder} onClose={() => setOpenOrder(null)} />}
    </div>
  )
}

// ── Detail modal ─────────────────────────────────────────────────────────────

function OrderDetailModal({ order: o, onClose }: { order: OrderLogRow; onClose: () => void }) {
  const total = orderTotal(o)
  const c = cur(o)
  const pill = commercialPill(o.order_status)
  const prod = productionSummary(o)
  const addr = o.ship_to_address
  const addrLines = addr
    ? [o.ship_to_name, addr.line1, addr.line2, [addr.city, addr.postal_code].filter(Boolean).join(' '), addr.region, addr.country]
        .map((s) => (s ?? '').trim())
        .filter(Boolean)
    : []

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const amountRows: { label: string; value: number | null }[] = [
    { label: 'Cards', value: o.amount_cards },
    { label: 'Tooling', value: o.amount_tooling },
    { label: 'Personalisation', value: o.amount_personalisation },
    { label: 'Shipping', value: o.amount_shipping },
    { label: 'US tariff', value: o.amount_us_tariff },
    { label: 'Cards discount', value: o.amount_card_discount != null && o.amount_card_discount > 0 ? -o.amount_card_discount : null },
  ]

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-8"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-2xl bg-surface p-6 shadow-xl ring-1 ring-line"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 className="text-lg font-bold text-ink">{customerLabel(o.company_name, o.contact_name)}</h3>
            <p className="mt-0.5 text-sm text-ink-soft">{specLabel(o.material, o.variant, o.custom_quote_total, o.finish)}</p>
            <p className="mt-1 font-mono text-[12px] text-ink-mute">{o.payment_reference ?? '—'}</p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <Pill colour={pill.colour}>{pill.label}</Pill>
            {prod && <Pill colour={prod.colour}>{prod.label}</Pill>}
          </div>
        </div>

        <div className="mt-5 grid gap-5 sm:grid-cols-2">
          {/* Cost breakdown */}
          <Section title="Cost">
            {o.custom_quote_total != null ? (
              <Row label="Custom quote" value={formatPrice(Number(o.custom_quote_total), c)} />
            ) : (
              amountRows.filter((r) => r.value != null).map((r) => (
                <Row key={r.label} label={r.label} value={formatPrice(Number(r.value), c)} />
              ))
            )}
            <div className="mt-1 border-t border-line-soft pt-1">
              <Row label="Total" value={total != null ? formatPrice(total, c) : '—'} strong />
            </div>
            <Row label="Currency" value={o.currency ?? '—'} />
            <Row label="Payment" value={o.payment_method ?? '—'} />
            {o.xero_invoice_id ? (
              <Row
                label="Xero invoice"
                value={
                  <a
                    href={`https://go.xero.com/app/invoicing/view/${o.xero_invoice_id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-brand hover:underline"
                  >
                    Open in Xero ↗
                  </a>
                }
              />
            ) : o.xero_invoice_error ? (
              <Row label="Xero invoice" value="Failed" />
            ) : null}
          </Section>

          {/* Order details */}
          <Section title="Order">
            <Row label="Quantity" value={o.quantity != null ? `${o.quantity.toLocaleString()} cards` : '—'} />
            {(o.names_count ?? 0) > 1 && <Row label="People" value={String(o.names_count)} />}
            {o.has_personalisation && <Row label="Personalisation" value="Yes" />}
            {o.finish && <Row label="Finish" value={o.finish} />}
            <Row label="Date required" value={fmtDate(o.date_required)} />
            {o.dropbox_folder_url && (
              <Row
                label="Artwork"
                value={
                  <a href={o.dropbox_folder_url} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">
                    Dropbox folder ↗
                  </a>
                }
              />
            )}
            {o.proof_id && (
              <Row
                label="Proof"
                value={<a href={`/proofs/${o.proof_id}`} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">Open proof ↗</a>}
              />
            )}
          </Section>

          {/* Artwork spec — the frozen inks + letterpress colours the customer
              approved (from the Phase 2 snapshot). Only shown when captured. */}
          {(() => {
            const snap = o.order_spec_snapshot
            const inks = (snap?.ink_names ?? []).filter(Boolean)
            const lp = snap?.letterpress ?? null
            if (inks.length === 0 && !lp) return null
            return (
              <Section title="Artwork spec">
                {inks.length > 0 && <Row label="Inks" value={inks.join(', ')} />}
                {lp?.front && <Row label="Front colour" value={lp.front} />}
                {lp?.core && <Row label="Core colour" value={lp.core} />}
                {lp?.back && <Row label="Back colour" value={lp.back} />}
              </Section>
            )
          })()}

          {/* Person split */}
          {o.person_quantities && o.person_quantities.length > 0 && (
            <Section title="Per person">
              {o.person_quantities.map((p, i) => (
                <Row key={i} label={p.name} value={p.quantity.toLocaleString()} />
              ))}
            </Section>
          )}

          {/* Deliver to */}
          {addrLines.length > 0 && (
            <Section title="Deliver to">
              {addrLines.map((line, i) => <p key={i} className="text-sm text-ink-soft">{line}</p>)}
              {o.ship_to_email && <p className="mt-1 text-xs text-ink-dim">{o.ship_to_email}</p>}
            </Section>
          )}

          {/* Commercial timeline */}
          <Section title="Timeline">
            <Row label="Created" value={fmtDateTime(o.created_at)} />
            <Row label="Link sent" value={fmtDateTime(o.sent_at)} />
            {o.pay_link_opened_at && <Row label="Link opened" value={fmtDateTime(o.pay_link_opened_at)} />}
            <Row label="Paid" value={fmtDateTime(o.paid_at)} />
            {o.fulfilled_at && <Row label="Ordered" value={fmtDateTime(o.fulfilled_at)} />}
            {o.revised_at && <Row label="Revised" value={fmtDateTime(o.revised_at)} />}
          </Section>

          {/* Production (Stock Control) */}
          {o.production_route ? (
            <Section title="Production">
              <Row label="Route" value={o.production_route === 'in_house' ? 'In-house' : 'Outsourced'} />
              {o.job_number && <Row label="Job number" value={o.job_number} />}
              {o.production_route === 'in_house' ? (
                <>
                  {o.inhouse_status && <Row label="Status" value={o.inhouse_status} />}
                  {o.produced_at && <Row label="Produced" value={fmtDateTime(o.produced_at)} />}
                  {o.completed_at && <Row label="Completed" value={fmtDateTime(o.completed_at)} />}
                </>
              ) : (
                <>
                  {(o.production_supplier ?? o.chosen_supplier) && (
                    <Row label="Supplier" value={o.production_supplier ?? o.chosen_supplier ?? '—'} />
                  )}
                  {o.outsourced_status && <Row label="Status" value={o.outsourced_status.replace(/_/g, ' ')} />}
                  {o.in_production_at && <Row label="In production" value={fmtDateTime(o.in_production_at)} />}
                  {o.shipped_from_supplier_at && <Row label="Shipped from supplier" value={fmtDateTime(o.shipped_from_supplier_at)} />}
                  {o.shipped_to_customer_at && <Row label="Shipped to customer" value={fmtDateTime(o.shipped_to_customer_at)} />}
                  {o.arrived_at && <Row label="Arrived" value={fmtDateTime(o.arrived_at)} />}
                  {o.tracking_status && <Row label="Tracking" value={o.tracking_status} />}
                  {o.tracking_eta && <Row label="ETA" value={fmtDate(o.tracking_eta)} />}
                  {o.customer_tracking_number && <Row label="Tracking no." value={o.customer_tracking_number} />}
                </>
              )}
            </Section>
          ) : (o.order_status === 'paid' || o.order_status === 'fulfilled') ? (
            <Section title="Production">
              <p className="text-sm text-ink-dim">Not yet matched to a Stock Control job.</p>
              {o.chosen_supplier && <Row label="Chosen supplier" value={o.chosen_supplier} />}
            </Section>
          ) : null}
        </div>

        <div className="mt-6 flex justify-end">
          <button onClick={onClose} className="rounded px-4 py-2 text-sm font-medium text-ink-soft ring-1 ring-line hover:bg-canvas">
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-line bg-canvas p-3">
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-dim">{title}</div>
      <div className="space-y-0.5">{children}</div>
    </div>
  )
}

function Row({ label, value, strong }: { label: string; value: React.ReactNode; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="text-ink-mute">{label}</span>
      <span className={strong ? 'font-semibold text-ink' : 'text-ink-soft'}>{value}</span>
    </div>
  )
}

const selectClass = 'select-styled min-w-[10rem] rounded border border-line bg-surface px-3 py-2 text-[17px] sm:text-sm focus:border-[var(--c-brand)] focus:bg-[var(--c-brand-50)] focus:outline-none'
const inputClass = 'rounded border border-line px-3 py-2 text-[17px] sm:text-sm focus:border-[var(--c-brand)] focus:bg-[var(--c-brand-50)] focus:outline-none'
const thClass = 'px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-ink-dim'
