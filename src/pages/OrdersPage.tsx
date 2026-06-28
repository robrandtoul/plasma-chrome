import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { DesignerChrome, PanelShell, Pill, ButtonInk, ButtonGhost } from '../design'
import { formatPrice } from '../lib/currency'
import { getExchangeRates, currencyToGbp, type ExchangeRates } from '../lib/exchangeRates'
import { customerOrderUrl } from '../lib/customerOrderUrl'
import { orderTotal, specLabel as specLabelShared, customerLabel as customerLabelShared } from '../lib/orderDisplay'
import { logAudit } from '../lib/audit'
import type { GridImage } from '../components/ImageGrid'
import type { Currency } from '../lib/types'
import { relativeTime, formatAbsoluteDateTime } from '../lib/relativeTime'

// Orders / "to order" surface (Ordering & checkout, Step 6 — overhauled).
//
// The hand-off queue between "customer paid" and Stock Control. Fulfilment
// (production + shipping) is Stock Control's job, not this app's; here a paid
// order is compiled and PLACED — into production (in-house) or with a supplier
// — and then drops off. Phase 1 wires the in-house route: posting the
// structured production note onto the Help Scout thread (the
// helpscout-inhouse-order webhook ingests it) lands once Dropbox is connected;
// for now the page captures the two things that gate placing an order — the
// date required and the Dropbox order folder (the prepped source artwork +
// the order number/project) — and marks the order placed.
//
// Reads orders directly (authenticated designers have RLS select on
// proofs.orders, 000229) joined to the proof's contact/company, the chosen
// variant, and the material's production route + lead time.

// Reactivating an expired link extends it by the same window create-order uses.
const ORDER_EXPIRY_DAYS = 14

interface OrderRow {
  id: string
  status: string
  token: string
  expires_at: string | null
  sent_at: string | null
  pay_link_opened_at: string | null
  currency: Currency
  quantity: number | null
  names_count: number
  has_personalisation: boolean
  custom_quote_total: number | null
  amount_cards: number | null
  amount_tooling: number | null
  amount_personalisation: number | null
  amount_shipping: number | null
  amount_us_tariff: number | null
  // Designer-set cards discount: the config + the amount stamped at checkout.
  card_discount_type: 'none' | 'percent' | 'fixed' | null
  card_discount_value: number | null
  amount_card_discount: number | null
  payment_method: string | null
  payment_reference: string | null
  xero_invoice_id: string | null
  xero_invoice_error: string | null
  paid_at: string | null
  fulfilled_at: string | null
  revised_at: string | null
  // Order-placement fields (000252).
  date_required: string | null
  dropbox_folder_url: string | null
  stock_order_number: string | null
  project_name: string | null
  person_quantities: { name: string; quantity: number }[] | null
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
  proof_id: string
  material_variants: {
    display_name: string | null
    materials: { code: string | null; display_name: string | null; production_route: string | null; lead_time_max_days: number | null; outsourced_supplier_ids: string[] | null } | null
  } | null
  proofs: { contacts: { full_name: string | null; companies: { name: string | null } | null } | null } | null
}

const SELECT = `
  id, status, token, expires_at, sent_at, pay_link_opened_at, currency, quantity, names_count, has_personalisation,
  custom_quote_total, amount_cards, amount_tooling, amount_personalisation, amount_shipping, amount_us_tariff,
  card_discount_type, card_discount_value, amount_card_discount, payment_method,
  payment_reference, xero_invoice_id, xero_invoice_error, paid_at, fulfilled_at, revised_at,
  date_required, dropbox_folder_url, stock_order_number, project_name, person_quantities,
  ship_to_name, ship_to_email, ship_to_address, proof_id,
  material_variants(display_name, materials(code, display_name, production_route, lead_time_max_days, outsourced_supplier_ids)),
  proofs(contacts(full_name, companies(name)))
`

// The dropbox-folder edge function response (uniform { ok } shape).
interface DropboxFolderResult {
  ok: boolean
  error?: string
  name?: string
  order_number?: string | null
  project_name?: string | null
  file_count?: number
}

// Per-card state for the order-folder lookup against Dropbox.
type FolderLookup =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; orderNumber: string | null; projectName: string | null; fileCount: number | null }
  | { status: 'error'; error: string }

// A 'sent' order whose window has passed. Status stays 'sent' in the DB (the
// pay-page + this list derive expiry from the timestamp); reactivation just
// pushes expires_at forward.
function isExpired(o: OrderRow): boolean {
  return o.status === 'sent' && o.expires_at != null && new Date(o.expires_at).getTime() < Date.now()
}

// Production route from the order's material. 'supplier' is the outsourced
// route (phase 2 — the supplier-email hand-off); 'in_house' posts the
// production note. Null when the material is unknown (custom quote).
function routeOf(o: OrderRow): 'in_house' | 'supplier' | null {
  const r = o.material_variants?.materials?.production_route
  return r === 'supplier' ? 'supplier' : r === 'in_house' ? 'in_house' : null
}

// The suppliers a supplier-route order may go to, from the material's
// admin-editable config (materials.outsourced_supplier_ids → live Stock Control
// names). Drives the button: one names it ("…from QX Metals"), several offer a
// choice ("…choose supplier"). The actual supplier is picked + confirmed on the
// review page. Empty = none configured / names not loaded yet.
function allowedSupplierLabels(o: OrderRow, supplierNames: Record<string, string>): string[] {
  const ids = o.material_variants?.materials?.outsourced_supplier_ids ?? []
  return ids.map((id) => supplierNames[id]).filter((n): n is string => !!n)
}

// Thin adapters from this page's nested OrderRow onto the shared display
// helpers (src/lib/orderDisplay.ts), so the work queue and the admin Order log
// can't drift on a displayed total / label. orderTotal is used directly — an
// OrderRow already satisfies the helper's OrderAmounts shape.
function customerLabel(o: OrderRow): string {
  return customerLabelShared(o.proofs?.contacts?.companies?.name, o.proofs?.contacts?.full_name)
}

function specLabel(o: OrderRow): string {
  return specLabelShared(
    o.material_variants?.materials?.display_name,
    o.material_variants?.display_name,
    o.custom_quote_total,
  )
}

// Add N working days to a date (skips Sat/Sun). Used to suggest the date
// required from the material's lead time (a business-day figure); the designer
// confirms or overrides it on the card.
function addBusinessDays(from: Date, n: number): Date {
  const d = new Date(from)
  let added = 0
  while (added < n) {
    d.setDate(d.getDate() + 1)
    const day = d.getDay()
    if (day !== 0 && day !== 6) added++
  }
  return d
}

// Build the ISO date from LOCAL components. toISOString() converts to UTC, so
// for a UK user in BST a date computed near local midnight could roll back a
// day — and addBusinessDays counts on local getDay(), so the two would disagree
// at the boundary. This keeps the date the designer sees == the date we store.
function toISODate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// Suggested date required: today + the material's max lead time (working days).
// Null when there's no lead time to base it on.
function suggestedDate(o: OrderRow): string | null {
  const lead = o.material_variants?.materials?.lead_time_max_days
  if (typeof lead !== 'number' || lead <= 0) return null
  return toISODate(addBusinessDays(new Date(), lead))
}

// Whole days since an ISO timestamp (for the "paid N days ago" ageing cue).
function daysSince(iso: string | null): number | null {
  if (!iso) return null
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms)) return null
  return Math.floor(ms / (24 * 60 * 60 * 1000))
}

// Turn the stored Xero rejection into one human-readable line. The raw value
// is usually "<status> <JSON body>" from Xero's API; the useful part is the
// validation message(s) buried in Elements[].ValidationErrors[].Message.
function friendlyInvoiceError(raw: string | null): string | null {
  if (!raw) return null
  const braceIdx = raw.indexOf('{')
  if (braceIdx !== -1) {
    try {
      const parsed = JSON.parse(raw.slice(braceIdx))
      const msgs: string[] = []
      const elements = Array.isArray(parsed?.Elements) ? parsed.Elements : []
      for (const el of elements) {
        for (const v of (Array.isArray(el?.ValidationErrors) ? el.ValidationErrors : [])) {
          if (v?.Message) msgs.push(String(v.Message))
        }
        for (const li of (Array.isArray(el?.LineItems) ? el.LineItems : [])) {
          for (const v of (Array.isArray(li?.ValidationErrors) ? li.ValidationErrors : [])) {
            if (v?.Message) msgs.push(String(v.Message))
          }
        }
      }
      if (msgs.length > 0) return Array.from(new Set(msgs)).join('; ')
      if (parsed?.Message) return String(parsed.Message)
    } catch {
      // not JSON — fall through to the trimmed raw string
    }
  }
  return raw.length > 200 ? `${raw.slice(0, 200)}…` : raw
}

function formatDate(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

// The order's charged total expressed in GBP, so mixed-currency buckets can be
// summed into one headline figure. EUR/USD convert at the live ECB rate; GBP
// passes through. Null totals (custom quote with no priced parts) drop out of
// the sum. NB GBP order totals are VAT-inclusive while EUR/USD are VAT-free —
// the converted figure mixes the two, so the summary labels it a rough guide.
function gbpValueOf(o: OrderRow, rates: ExchangeRates | null): number {
  const total = orderTotal(o)
  if (total == null) return 0
  return currencyToGbp(total, o.currency, rates)
}

function sumGbp(orders: OrderRow[], rates: ExchangeRates | null): number {
  return orders.reduce((acc, o) => acc + gbpValueOf(o, rates), 0)
}

// Free-text match across the fields a designer would search by: customer /
// company, payment + stock order references, project name, and the spec label.
function matchesSearch(o: OrderRow, q: string): boolean {
  if (!q) return true
  const haystack = [
    customerLabel(o),
    o.payment_reference,
    o.stock_order_number,
    o.project_name,
    specLabel(o),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return haystack.includes(q)
}

// Which work-queue section is shown. 'all' shows every section; the others
// narrow to one so a busy queue can be focused.
type ViewKey = 'all' | 'awaiting' | 'to_order' | 'revised' | 'recent'

const VIEW_TABS: { key: ViewKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'awaiting', label: 'Awaiting payment' },
  { key: 'to_order', label: 'To order' },
  { key: 'revised', label: 'Being revised' },
  { key: 'recent', label: 'Recently ordered' },
]

// A single figure in the summary bar: GBP total + order count, with optional
// sub-detail (e.g. the expired slice of awaiting payment).
function SummaryStat({
  label,
  totalGbp,
  count,
  detail,
  tone = 'ink',
}: {
  label: string
  totalGbp: number
  count: number
  detail?: string | null
  tone?: 'ink' | 'out'
}) {
  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-3">
      <span className="block text-[11px] font-medium uppercase tracking-wide text-ink-mute">{label}</span>
      <span className={`mt-0.5 block text-lg font-semibold ${tone === 'out' ? 'text-out' : 'text-ink'}`}>
        {formatPrice(Math.round(totalGbp), 'GBP')}
      </span>
      <span className="block text-[12px] text-ink-mute">
        {count} {count === 1 ? 'order' : 'orders'}
        {detail ? ` · ${detail}` : ''}
      </span>
    </div>
  )
}

export default function OrdersPage() {
  const [loading, setLoading] = useState(true)
  const [orders, setOrders] = useState<OrderRow[]>([])
  // True when the 300-row fetch ceiling was hit, so the page can say so rather
  // than silently dropping older orders (the full history lives in the log).
  const [capped, setCapped] = useState(false)
  const [thumbs, setThumbs] = useState<Record<string, GridImage | null>>({})
  const [busyId, setBusyId] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const navigate = useNavigate()
  // Sent reminders per order (the automated unpaid-order nudges, 000238).
  const [reminders, setReminders] = useState<Record<string, { count: number; lastAt: string }>>({})
  // Stock Control supplier id → name, for the supplier-route button labels
  // (the routing stores ids; names live in Stock Control). Best-effort.
  const [supplierNames, setSupplierNames] = useState<Record<string, string>>({})
  // Live GBP→EUR/USD rates so mixed-currency totals collapse to one GBP figure
  // in the summary bar + section subtotals (null until the first fetch lands).
  const [rates, setRates] = useState<ExchangeRates | null>(null)
  // Work-queue search + which section is shown.
  const [search, setSearch] = useState('')
  const [view, setView] = useState<ViewKey>('all')

  useEffect(() => {
    let cancelled = false
    void (async () => {
      void getExchangeRates().then((r) => { if (!cancelled) setRates(r) })
      void supabase.schema('public').from('outsourced_suppliers').select('id, name').then(({ data }) => {
        if (cancelled || !data) return
        setSupplierNames(Object.fromEntries((data as { id: string; name: string }[]).map((s) => [s.id, s.name])))
      })
      const { data } = await supabase
        .from('orders')
        .select(SELECT)
        .in('status', ['sent', 'paid', 'fulfilled', 'revision'])
        .order('sent_at', { ascending: false })
        .limit(300)
      if (cancelled) return
      const rows = (data ?? []) as unknown as OrderRow[]
      setOrders(rows)
      setCapped(rows.length >= 300)
      setLoading(false)

      const sentIds = rows.filter((r) => r.status === 'sent').map((r) => r.id)
      if (sentIds.length > 0) {
        const { data: nudgeData } = await supabase
          .from('order_nudges')
          .select('order_id, created_at')
          .in('order_id', sentIds)
          .eq('state', 'sent')
        if (!cancelled && nudgeData) {
          const map: Record<string, { count: number; lastAt: string }> = {}
          for (const n of nudgeData as { order_id: string; created_at: string }[]) {
            const cur = map[n.order_id]
            if (!cur) map[n.order_id] = { count: 1, lastAt: n.created_at }
            else {
              cur.count += 1
              if (n.created_at > cur.lastAt) cur.lastAt = n.created_at
            }
          }
          setReminders(map)
        }
      }

      // Representative thumbnail per proof — a recognition aid; the card links
      // to the proof for the authoritative approved artwork.
      const proofIds = Array.from(new Set(rows.filter((r) => r.status === 'paid' || r.status === 'revision').map((r) => r.proof_id)))
      await Promise.all(
        proofIds.map(async (proofId) => {
          try {
            // customer-proof-images returns EVERY version's images (the customer
            // page has a version switcher), so scope the thumbnail to the CURRENT
            // version — otherwise an earlier version's artwork shows (e.g. a v1
            // plastic card for a proof now approved in wood). Mirrors the
            // OrderReviewPage gallery; falls back to the first non-QR image only
            // when the current version can't be resolved.
            const [{ data: curV }, { data: imgData }] = await Promise.all([
              supabase.from('proof_versions').select('id').eq('proof_id', proofId).eq('is_current', true).maybeSingle(),
              supabase.functions.invoke<{ images: GridImage[] }>('customer-proof-images', { body: { proofId } }),
            ])
            const currentVersionId = (curV as { id?: string } | null)?.id ?? null
            const nonQr = (imgData?.images ?? []).filter((img) => img.is_qr_code !== true)
            const scoped = currentVersionId
              ? nonQr.filter((img) => (img as unknown as { proof_version_id?: string }).proof_version_id === currentVersionId)
              : []
            const first = (scoped.length > 0 ? scoped : nonQr)[0] ?? null
            if (!cancelled) setThumbs((prev) => ({ ...prev, [proofId]: first }))
          } catch {
            // ignore — card renders without a thumbnail
          }
        }),
      )
    })()
    return () => { cancelled = true }
  }, [])

  // Persist a single order field (the date / Dropbox folder edits), merging into
  // local state so the gate + UI reflect it immediately. Returns whether the
  // write actually landed — these two fields gate placing the order, so a silent
  // failure must NOT leave the card showing a saved value the DB never got. On
  // failure we revert to the DB's truth (re-fetch the row) and report false so
  // the caller can show an inline error and keep the gate closed.
  async function saveOrderField(orderId: string, patch: Partial<OrderRow>): Promise<boolean> {
    setOrders((prev) => prev.map((o) => (o.id === orderId ? { ...o, ...patch } : o)))
    const { error } = await supabase
      .from('orders')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', orderId)
    if (error) {
      // Revert the optimistic patch to whatever is actually persisted.
      const { data: fresh } = await supabase.from('orders').select(SELECT).eq('id', orderId).maybeSingle()
      if (fresh) {
        const row = fresh as unknown as OrderRow
        setOrders((prev) => prev.map((o) => (o.id === orderId ? { ...o, ...row } : o)))
      }
      return false
    }
    return true
  }

  async function retryInvoice(o: OrderRow) {
    setBusyId(o.id)
    try {
      const { data, error } = await supabase.functions.invoke<{ ok: boolean; invoiceId?: string; error?: string }>(
        'retry-order-invoice',
        { body: { order_id: o.id } },
      )
      if (error || !data?.ok) {
        const msg = data?.error ?? error?.message ?? 'Could not create the invoice. Please try again.'
        setOrders((prev) => prev.map((r) => (r.id === o.id ? { ...r, xero_invoice_error: msg } : r)))
        return
      }
      const invoiceId = data.invoiceId ?? null
      setOrders((prev) =>
        prev.map((r) => (r.id === o.id ? { ...r, xero_invoice_id: invoiceId, xero_invoice_error: null } : r)),
      )
      void logAudit({
        action: 'order.invoice_retried',
        targetType: 'order',
        targetId: o.id,
        targetLabel: `Order ${o.payment_reference ?? o.id}`,
        afterValue: { xero_invoice_id: invoiceId },
      })
    } finally {
      setBusyId(null)
    }
  }

  async function copyLink(o: OrderRow) {
    try {
      await navigator.clipboard.writeText(customerOrderUrl(o.id, o.token))
      setCopiedId(o.id)
      window.setTimeout(() => setCopiedId((c) => (c === o.id ? null : c)), 2000)
    } catch {
      // Clipboard blocked (rare on https) — designer can retry; no hard failure.
    }
  }

  async function reactivate(o: OrderRow) {
    setBusyId(o.id)
    try {
      const nextExpiry = new Date(Date.now() + ORDER_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString()
      const { error } = await supabase
        .from('orders')
        .update({ expires_at: nextExpiry, updated_at: new Date().toISOString() })
        .eq('id', o.id)
        .eq('status', 'sent')
      if (!error) {
        setOrders((prev) => prev.map((r) => (r.id === o.id ? { ...r, expires_at: nextExpiry } : r)))
        void logAudit({
          action: 'order.link_reactivated',
          targetType: 'order',
          targetId: o.id,
          targetLabel: `Order ${o.payment_reference ?? o.id}`,
          beforeValue: { expires_at: o.expires_at },
          afterValue: { expires_at: nextExpiry },
        })
      }
    } finally {
      setBusyId(null)
    }
  }

  // Cancel an unpaid order link (abort). order-lifecycle flips sent→cancelled,
  // posts the customer a Help Scout note, and writes the audit row server-side —
  // so no client logAudit here (that would double-log). The page never refetches,
  // so drop the row locally to remove the card.
  async function cancelOrder(o: OrderRow) {
    if (!window.confirm('Cancel this unpaid order link? The customer will be told it has been cancelled.')) return
    setBusyId(o.id)
    try {
      const { data, error } = await supabase.functions.invoke<{ ok: boolean; status?: string; error?: string }>(
        'order-lifecycle',
        { body: { order_id: o.id, action: 'cancel', reason: 'abort', notify: true } },
      )
      if (error || !data?.ok) {
        window.alert(`Could not cancel the order: ${error?.message ?? data?.error ?? 'unknown error'}`)
        return
      }
      setOrders((prev) => prev.filter((r) => r.id !== o.id))
    } finally {
      setBusyId(null)
    }
  }

  // The search box narrows every section at once; the view tabs pick which
  // section(s) render. Buckets recompute only when the orders or query change.
  const hasInvoiceProblem = (o: OrderRow) => !o.xero_invoice_id && !!o.xero_invoice_error
  const { awaitingPayment, toOrder, recentlyOrdered, beingRevised } = useMemo(() => {
    const q = search.trim().toLowerCase()
    const filtered = orders.filter((o) => matchesSearch(o, q))
    return {
      // Awaiting payment: expired links (need reactivating) float up, then the
      // longest-outstanding first so the oldest chases surface at the top.
      awaitingPayment: filtered
        .filter((o) => o.status === 'sent')
        .sort((a, b) => {
          const ae = isExpired(a) ? 0 : 1
          const be = isExpired(b) ? 0 : 1
          if (ae !== be) return ae - be
          return new Date(a.sent_at ?? 0).getTime() - new Date(b.sent_at ?? 0).getTime()
        }),
      // To order: paid, not yet placed. A blocking problem (failed invoice)
      // floats to the top; otherwise oldest-paid-first so nothing sits.
      toOrder: filtered
        .filter((o) => o.status === 'paid')
        .sort((a, b) => {
          const ap = hasInvoiceProblem(a) ? 0 : 1
          const bp = hasInvoiceProblem(b) ? 0 : 1
          if (ap !== bp) return ap - bp
          return new Date(a.paid_at ?? a.sent_at ?? 0).getTime() - new Date(b.paid_at ?? b.sent_at ?? 0).getTime()
        }),
      recentlyOrdered: filtered.filter((o) => o.status === 'fulfilled').slice(0, 30),
      // Paid/placed orders held while the proof is being redesigned (revision).
      beingRevised: filtered.filter((o) => o.status === 'revision'),
    }
  }, [orders, search])

  // GBP-converted slice of awaiting payment that has expired (the at-risk part).
  const expiredAwaiting = awaitingPayment.filter(isExpired)
  const showSection = (key: ViewKey) => view === 'all' || view === key

  return (
    <DesignerChrome active="orders">
      <main className="mx-auto max-w-[1100px] px-4 py-8 sm:px-7">
        <h1 className="text-xl font-semibold text-ink">Orders</h1>
        <p className="mt-1 text-sm text-ink-soft">
          From payment link to production. Paid orders waiting to be compiled and placed — into production or with a supplier — then handed to Stock Control.
        </p>

        {loading ? (
          <p className="mt-8 text-sm text-ink-mute">Loading orders…</p>
        ) : (
          <>
            {orders.length > 0 && (
              <>
                {/* Value summary — every total converted to GBP so the
                    mixed-currency queue reads as one figure at a glance. */}
                <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3">
                  <SummaryStat
                    label="Awaiting payment"
                    totalGbp={sumGbp(awaitingPayment, rates)}
                    count={awaitingPayment.length}
                    detail={
                      expiredAwaiting.length > 0
                        ? `${formatPrice(Math.round(sumGbp(expiredAwaiting, rates)), 'GBP')} expired`
                        : null
                    }
                    tone={expiredAwaiting.length > 0 ? 'out' : 'ink'}
                  />
                  <SummaryStat
                    label="To order"
                    totalGbp={sumGbp(toOrder, rates)}
                    count={toOrder.length}
                  />
                  <SummaryStat
                    label="Being revised"
                    totalGbp={sumGbp(beingRevised, rates)}
                    count={beingRevised.length}
                  />
                </div>
                <p className="mt-1.5 text-[11px] text-ink-mute">
                  Totals converted to GBP{rates?.rateDate ? ` at the ${rates.rateDate} ECB rate` : ''} — a rough
                  guide only (GBP figures include VAT; EUR/USD don’t).
                </p>

                {/* Search + which section to show. */}
                <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <input
                    type="search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search customer, reference or project…"
                    className="h-10 w-full rounded-lg border border-line bg-surface px-3 text-sm text-ink focus:border-[var(--c-brand)] focus:outline-2 focus:outline-offset-1 focus:outline-[var(--c-brand)] sm:max-w-xs"
                  />
                  <div className="flex flex-wrap gap-1.5">
                    {VIEW_TABS.map((t) => (
                      <button
                        key={t.key}
                        type="button"
                        onClick={() => setView(t.key)}
                        className={`rounded-full px-3 py-1.5 text-[12px] font-medium ring-1 transition-colors ${
                          view === t.key
                            ? 'bg-ink text-surface ring-ink'
                            : 'text-ink-soft ring-line hover:bg-canvas'
                        }`}
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>
                </div>

                {capped && (
                  <p className="mt-3 text-[12px] text-ink-mute">
                    Showing the 300 most recent orders. Older orders are in Admin → Order log.
                  </p>
                )}
              </>
            )}

            {search.trim() &&
              awaitingPayment.length + toOrder.length + beingRevised.length + recentlyOrdered.length === 0 && (
                <PanelShell className="mt-6 text-center">
                  <p className="text-sm text-ink-soft">No orders match “{search.trim()}”.</p>
                </PanelShell>
              )}

            {showSection('awaiting') && awaitingPayment.length > 0 && (
              <section className="mt-6">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-mute">
                  Awaiting payment · {awaitingPayment.length} · {formatPrice(Math.round(sumGbp(awaitingPayment, rates)), 'GBP')}
                </h2>
                <p className="mt-1 text-[13px] text-ink-mute">
                  Payment links that have been sent but not paid yet. Copy a link to re-send it, or reactivate an expired one (extends it {ORDER_EXPIRY_DAYS} days).
                </p>
                <div className="mt-3 space-y-3">
                  {awaitingPayment.map((o) => (
                    <AwaitingPaymentCard
                      key={o.id}
                      order={o}
                      expired={isExpired(o)}
                      busy={busyId === o.id}
                      copied={copiedId === o.id}
                      reminder={reminders[o.id] ?? null}
                      onCopy={() => void copyLink(o)}
                      onReactivate={() => void reactivate(o)}
                      onCancel={() => void cancelOrder(o)}
                    />
                  ))}
                </div>
              </section>
            )}

            {showSection('to_order') && (
              <section className="mt-10">
                <div className="flex items-baseline justify-between gap-3">
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-mute">
                    To order · {toOrder.length}
                    {toOrder.length > 0 ? ` · ${formatPrice(Math.round(sumGbp(toOrder, rates)), 'GBP')}` : ''}
                  </h2>
                  {toOrder.length > 0 && <span className="text-[12px] text-ink-mute">Oldest paid first</span>}
                </div>
                <div className="mt-3">
                  {toOrder.length === 0 ? (
                    !search.trim() && (
                      <PanelShell className="text-center">
                        <p className="text-sm text-ink-soft">Nothing waiting to be ordered right now.</p>
                      </PanelShell>
                    )
                  ) : (
                    <div className="space-y-4">
                      {toOrder.map((o) => (
                        <OrderCard
                          key={o.id}
                          order={o}
                          thumb={thumbs[o.proof_id] ?? null}
                          route={routeOf(o)}
                          supplierLabels={allowedSupplierLabels(o, supplierNames)}
                          supplierCount={o.material_variants?.materials?.outsourced_supplier_ids?.length ?? 0}
                          suggested={suggestedDate(o)}
                          busy={busyId === o.id}
                          copied={copiedId === o.id}
                          onReview={() => navigate(`/orders/${o.id}/place`)}
                          onCopy={() => void copyLink(o)}
                          onSaveField={(patch) => saveOrderField(o.id, patch)}
                          onRetryInvoice={() => void retryInvoice(o)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              </section>
            )}

            {showSection('revised') && beingRevised.length > 0 && (
              <section className="mt-10">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-mute">
                  Being revised · {beingRevised.length} · {formatPrice(Math.round(sumGbp(beingRevised, rates)), 'GBP')}
                </h2>
                <p className="mt-1 text-[13px] text-ink-mute">
                  Paid orders held while the artwork is being changed. Re-approve the new proof and replace the files in the Dropbox order folder, then review &amp; place again.
                </p>
                <div className="mt-3 space-y-4">
                  {beingRevised.map((o) => (
                    <RevisionCard
                      key={o.id}
                      order={o}
                      thumb={thumbs[o.proof_id] ?? null}
                      copied={copiedId === o.id}
                      onReview={() => navigate(`/orders/${o.id}/place`)}
                      onCopy={() => void copyLink(o)}
                    />
                  ))}
                </div>
              </section>
            )}

            {showSection('recent') && recentlyOrdered.length > 0 && (
              <section className="mt-10">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-mute">Recently ordered</h2>
                <div className="mt-3 divide-y divide-line-soft rounded-xl border border-line bg-surface">
                  {recentlyOrdered.map((o) => (
                    <div key={o.id} className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
                      <div className="min-w-0">
                        <Link to={`/proofs/${o.proof_id}`} className="font-medium text-ink hover:underline">
                          {customerLabel(o)}
                        </Link>
                        <span className="ml-2 text-ink-mute">{o.payment_reference}</span>
                      </div>
                      <div className="flex items-center gap-3 text-ink-soft">
                        <span>{o.quantity != null ? `${o.quantity.toLocaleString()} cards` : 'Custom'}</span>
                        <span className="text-ink-mute">Ordered {formatDate(o.fulfilled_at)}</span>
                        <button
                          type="button"
                          onClick={() => void copyLink(o)}
                          title="Copy the customer's order link (doubles as their tracking page)"
                          className="shrink-0 rounded px-2 py-1 text-[12px] text-ink-soft ring-1 ring-line hover:bg-canvas"
                        >
                          {copiedId === o.id ? 'Copied' : 'Copy link'}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </main>
    </DesignerChrome>
  )
}

// A paid/placed order held while the proof is being redesigned (revision). The
// card is informational + navigational: the authoritative gates (folder verify,
// re-approval, and — for a previously-placed order — the "old Stock Control job
// cancelled" confirmation) live on the review & place page, which is where
// place-order is actually invoked.
function RevisionCard({
  order,
  thumb,
  copied,
  onReview,
  onCopy,
}: {
  order: OrderRow
  thumb: GridImage | null
  copied: boolean
  onReview: () => void
  onCopy: () => void
}) {
  const wasPlaced = !!order.fulfilled_at
  return (
    <PanelShell>
      <div className="mb-3 rounded-lg bg-out-soft px-3 py-2 text-[13px] font-semibold text-out ring-1 ring-out">
        Paid · revision in progress — do not produce the previous artwork.
      </div>
      <div className="flex flex-col gap-4 md:flex-row md:items-start">
        {thumb && (
          <img
            src={thumb.signed_url}
            alt="Proof artwork"
            className="h-20 w-20 shrink-0 rounded-lg object-cover ring-1 ring-line"
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link to={`/proofs/${order.proof_id}`} className="text-base font-semibold text-ink hover:underline">
              {customerLabel(order)}
            </Link>
            <Pill colour="out">Revision</Pill>
          </div>
          <p className="mt-0.5 text-sm text-ink-soft">{specLabel(order)}</p>
          <p className="mt-0.5 text-[13px] text-ink-mute">
            {order.payment_reference}
            {order.revised_at ? ` · being revised since ${formatDate(order.revised_at)}` : ''}
          </p>
          <p className="mt-2 text-[13px] text-ink-soft">
            {wasPlaced
              ? 'Already placed: cancel the old Stock Control job, re-approve the new proof, and replace the Dropbox files before re-placing.'
              : 'Re-approve the new proof and replace the Dropbox files, then re-place.'}
          </p>
        </div>
        <div className="flex shrink-0 flex-col gap-2 md:items-end">
          <ButtonInk onClick={onReview} className="max-md:w-full max-md:h-[50px] max-md:text-[15px]">Review &amp; place</ButtonInk>
          <div className="flex gap-2 md:contents">
            <Link to={`/proofs/${order.proof_id}`} className="max-md:flex-1">
              <ButtonGhost size="sm" className="max-md:w-full max-md:h-11">View proof &amp; artwork</ButtonGhost>
            </Link>
            <ButtonGhost size="sm" onClick={onCopy} className="max-md:flex-1 max-md:h-11">{copied ? 'Copied' : 'Copy order link'}</ButtonGhost>
          </div>
        </div>
      </div>
    </PanelShell>
  )
}

function OrderCard({
  order,
  thumb,
  route,
  supplierLabels,
  supplierCount,
  suggested,
  busy,
  copied,
  onReview,
  onCopy,
  onSaveField,
  onRetryInvoice,
}: {
  order: OrderRow
  thumb: GridImage | null
  route: 'in_house' | 'supplier' | null
  supplierLabels: string[]
  supplierCount: number
  suggested: string | null
  busy: boolean
  copied: boolean
  onReview: () => void
  onCopy: () => void
  onSaveField: (patch: Partial<OrderRow>) => Promise<boolean>
  onRetryInvoice: () => void
}) {
  const total = orderTotal(order)
  const invoiceError = !order.xero_invoice_id ? friendlyInvoiceError(order.xero_invoice_error) : null
  const addr = order.ship_to_address
  const addrLines = addr
    ? [order.ship_to_name, addr.line1, addr.line2, [addr.city, addr.postal_code].filter(Boolean).join(' '), addr.country]
        .map((s) => (s ?? '').trim())
        .filter(Boolean)
    : []
  const paidDays = daysSince(order.paid_at)

  // Local drafts for the two placement fields. Date seeds from the saved value,
  // else the lead-time suggestion (the designer still has to engage with it to
  // place — the gate checks the value is set).
  const [dateValue, setDateValue] = useState<string>(order.date_required ?? suggested ?? '')
  const [folderDraft, setFolderDraft] = useState<string>(order.dropbox_folder_url ?? '')

  // Whether the date is actually persisted — gates placing. A pre-filled
  // lead-time suggestion is NOT saved until the designer confirms it, and a
  // failed save must not leave the gate open. Plus transient save feedback.
  const [datePersisted, setDatePersisted] = useState<boolean>(!!order.date_required)
  const [dateSaving, setDateSaving] = useState(false)
  const [dateError, setDateError] = useState(false)
  const [dateSaved, setDateSaved] = useState(false)

  async function handleDateChange(v: string) {
    setDateValue(v)
    setDateError(false)
    setDateSaved(false)
    setDateSaving(true)
    const ok = await onSaveField({ date_required: v || null })
    setDateSaving(false)
    if (ok) {
      setDatePersisted(!!v)
      if (v) { setDateSaved(true); window.setTimeout(() => setDateSaved(false), 2000) }
    } else {
      setDatePersisted(false)
      setDateError(true)
    }
  }

  // Folder lookup: pasting the order-folder link verifies it against Dropbox and
  // pulls the order number + project from its name (the values the Stock Control
  // hand-off needs). Seeds from saved values so a revisit shows the confirmation
  // without re-fetching (the live file count is only known on a fresh check).
  const [lookup, setLookup] = useState<FolderLookup>(() =>
    order.stock_order_number || order.project_name
      ? { status: 'ok', orderNumber: order.stock_order_number, projectName: order.project_name, fileCount: null }
      : { status: 'idle' },
  )

  async function runLookup(rawLink: string) {
    const link = rawLink.trim()
    if (!link) {
      setLookup({ status: 'idle' })
      await onSaveField({ dropbox_folder_url: null, stock_order_number: null, project_name: null })
      return
    }
    setLookup({ status: 'loading' })
    const { data, error } = await supabase.functions.invoke<DropboxFolderResult>('dropbox-folder', { body: { link } })
    if (error || !data?.ok) {
      // Keep the URL so it isn't lost, but clear the parsed fields it couldn't fill.
      await onSaveField({ dropbox_folder_url: link, stock_order_number: null, project_name: null })
      setLookup({ status: 'error', error: data?.error ?? error?.message ?? 'Could not read that Dropbox link.' })
      return
    }
    const orderNumber = data.order_number ?? null
    const projectName = data.project_name ?? null
    // Only treat the folder as verified once the DB write lands — otherwise the
    // gate could open off a folder the order row never actually got.
    const saved = await onSaveField({ dropbox_folder_url: link, stock_order_number: orderNumber, project_name: projectName })
    if (!saved) {
      setLookup({ status: 'error', error: 'Verified the folder, but couldn’t save it — please Check again.' })
      return
    }
    setLookup({ status: 'ok', orderNumber, projectName, fileCount: data.file_count ?? null })
  }

  // The folder is usable for the hand-off only once it's verified AND its name
  // yields an order number (which becomes the Help Scout subject Stock Control
  // matches on). Artwork presence is informational, not a gate.
  const folderVerified = lookup.status === 'ok' && !!lookup.orderNumber
  // Both routes need a verified folder (its name = the order number) + a SAVED
  // date before the order can be reviewed & placed; the review page picks the
  // route (in-house note vs supplier email) and confirms. The date must be
  // persisted (not just a pre-filled suggestion) so the place-order edge fn,
  // which reads the DB, doesn't reject an order whose gate looked green.
  const canOrder = folderVerified && datePersisted

  return (
    <PanelShell>
      <div className="flex flex-col gap-4 md:flex-row md:items-start">
        {thumb && (
          <img
            src={thumb.signed_url}
            alt="Proof artwork"
            className="h-20 w-20 shrink-0 rounded-lg object-cover ring-1 ring-line"
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link to={`/proofs/${order.proof_id}`} className="text-base font-semibold text-ink hover:underline">
              {customerLabel(order)}
            </Link>
            <Pill colour="in-stock">Paid</Pill>
            {order.payment_method === 'offline' && (
              <Pill colour="low" title="Recorded as paid offline (bank transfer etc.) — no Stripe/Xero record; raise the invoice manually.">Offline</Pill>
            )}
            {order.xero_invoice_id && (
              <a
                href={`https://go.xero.com/app/invoicing/view/${order.xero_invoice_id}`}
                target="_blank"
                rel="noopener noreferrer"
                title="Open this invoice in Xero to check product codes and tax rates"
                className="rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1"
              >
                <Pill colour="allocated">Invoiced ↗</Pill>
              </a>
            )}
            {!order.xero_invoice_id && order.xero_invoice_error && (
              <Pill colour="critical" title={invoiceError ?? undefined}>Invoice failed</Pill>
            )}
            {route && (
              <span className="rounded-full border border-line px-2 py-0.5 text-[11px] text-ink-soft">
                {route === 'in_house' ? 'In-house' : 'Supplier'}
              </span>
            )}
          </div>
          <p className="mt-0.5 text-sm text-ink-soft">
            {specLabel(order)}
            {' · '}
            {order.quantity != null ? `${order.quantity.toLocaleString()} cards` : 'Quantity TBC'}
            {order.names_count > 1 ? ` · ${order.names_count} people` : ''}
            {order.has_personalisation ? ' · personalisation' : ''}
          </p>

          {order.person_quantities && order.person_quantities.length > 0 && (
            <div className="mt-2 rounded-lg border border-line bg-canvas px-3 py-2 text-[13px] text-ink-soft">
              <span className="block text-[11px] font-medium uppercase tracking-wide text-ink-mute">Make</span>
              {order.person_quantities.map((p, i) => (
                <span key={i} className="mr-3 inline-block">
                  <span className="text-ink">{p.quantity.toLocaleString()}</span> {p.name}
                </span>
              ))}
            </div>
          )}
          <p className="mt-0.5 text-[13px] text-ink-mute">
            Ref {order.payment_reference}
            {order.paid_at ? ` · paid ${paidDays === 0 ? 'today' : paidDays === 1 ? 'yesterday' : `${paidDays} days ago`}` : ''}
            {total != null ? ` · ${formatPrice(total, order.currency)}` : ''}
          </p>

          {order.card_discount_type && order.card_discount_type !== 'none' && (
            <p className="mt-0.5 text-[13px] text-in-stock">
              Cards discount: {order.card_discount_type === 'percent'
                ? `${order.card_discount_value ?? 0}% off`
                : `${formatPrice(Number(order.card_discount_value ?? 0), order.currency)} off`}
              {order.amount_card_discount != null && order.amount_card_discount > 0
                ? ` (−${formatPrice(order.amount_card_discount, order.currency)})`
                : ''}
            </p>
          )}

          {invoiceError && (
            <>
              {/* Desktop: full message inline. */}
              <p className="mt-1.5 hidden rounded-lg bg-out-soft px-3 py-2 text-[13px] text-out ring-1 ring-out md:block">
                <span className="font-medium">Invoice not created.</span> {invoiceError}
              </p>
              {/* Mobile: a single 46px row that expands to the full message on tap. */}
              <details className="mt-1.5 rounded-lg bg-out-soft px-3 text-out ring-1 ring-out md:hidden">
                <summary className="flex min-h-[46px] cursor-pointer list-none items-center gap-2 text-[13px] font-medium">
                  <span aria-hidden="true">⚠</span>
                  Xero invoice failed
                </summary>
                <p className="pb-2 text-[13px]">{invoiceError}</p>
              </details>
            </>
          )}

          {/* Placement fields: date required + the Dropbox order folder (the gate). */}
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <label className="block">
              <span className="block text-[11px] font-medium uppercase tracking-wide text-ink-mute">Date required</span>
              <input
                type="date"
                value={dateValue}
                onChange={(e) => void handleDateChange(e.target.value)}
                className="mt-1 h-[38px] max-md:h-12 w-full rounded-lg border border-line bg-surface px-3 text-sm text-ink focus:border-[var(--c-brand)] focus:outline-2 focus:outline-offset-1 focus:outline-[var(--c-brand)]"
              />
              <div className="mt-1 space-y-0.5 text-[11px]">
                {dateSaving && <span className="block text-ink-mute">Saving…</span>}
                {dateError && <span className="block text-out">Couldn’t save — try again</span>}
                {dateSaved && !dateError && <span className="block text-in-stock">✓ Saved</span>}
                {!dateSaving && !dateError && !dateSaved && !datePersisted && dateValue && (
                  <span className="block text-low">Suggested from lead time — pick the date to confirm</span>
                )}
              </div>
            </label>
            <label className="block">
              <span className="block text-[11px] font-medium uppercase tracking-wide text-ink-mute">Order folder (Dropbox)</span>
              <div className="mt-1 flex gap-2">
                <input
                  type="url"
                  value={folderDraft}
                  onChange={(e) => setFolderDraft(e.target.value)}
                  onBlur={() => { if (folderDraft.trim() !== (order.dropbox_folder_url ?? '')) void runLookup(folderDraft) }}
                  placeholder="Paste the order folder link…"
                  className="h-[38px] max-md:h-12 min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 text-sm text-ink focus:border-[var(--c-brand)] focus:outline-2 focus:outline-offset-1 focus:outline-[var(--c-brand)]"
                />
                <button
                  type="button"
                  onClick={() => void runLookup(folderDraft)}
                  disabled={lookup.status === 'loading' || folderDraft.trim().length === 0}
                  className="h-[38px] max-md:h-12 shrink-0 rounded-lg border border-line px-3 text-[13px] text-ink-soft hover:bg-canvas disabled:opacity-50"
                >
                  {lookup.status === 'loading' ? 'Checking…' : 'Check'}
                </button>
              </div>
              <div className="mt-1 space-y-0.5 text-[11px]">
                {lookup.status === 'idle' && (
                  <span className="block text-low">Prep the artwork, then paste the folder link</span>
                )}
                {lookup.status === 'loading' && <span className="block text-ink-mute">Checking folder…</span>}
                {lookup.status === 'error' && <span className="block text-out">{lookup.error}</span>}
                {lookup.status === 'ok' && lookup.orderNumber && (
                  <span className="block text-in-stock">✓ Order {lookup.orderNumber} · {lookup.projectName}</span>
                )}
                {lookup.status === 'ok' && !lookup.orderNumber && (
                  <span className="block text-low">
                    Folder linked, but its name isn’t “Order &lt;number&gt; – &lt;project&gt;” — rename it so Stock Control can match it.
                  </span>
                )}
                {lookup.status === 'ok' && lookup.fileCount != null && (
                  <span className={`block ${lookup.fileCount > 0 ? 'text-ink-mute' : 'text-low'}`}>
                    {lookup.fileCount > 0
                      ? `${lookup.fileCount} artwork file${lookup.fileCount === 1 ? '' : 's'} in the folder`
                      : 'No artwork files in the folder yet'}
                  </span>
                )}
              </div>
            </label>
          </div>

          {addrLines.length > 0 ? (
            <>
              {/* Desktop: full address block. */}
              <div className="mt-3 hidden rounded-lg border border-line bg-canvas px-3 py-2 text-[13px] text-ink-soft md:block">
                <span className="block text-[11px] font-medium uppercase tracking-wide text-ink-mute">Deliver to</span>
                {addrLines.map((line, i) => (
                  <span key={i} className="block">{line}</span>
                ))}
              </div>
              {/* Mobile: a 48px disclosure with the postcode line as a peek so
                  the full address doesn't stretch the card. */}
              <details className="mt-3 rounded-lg border border-line bg-canvas px-3 text-[13px] text-ink-soft md:hidden">
                <summary className="flex min-h-[48px] cursor-pointer list-none items-center justify-between gap-2">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-ink-mute">Delivery details</span>
                  <span className="truncate text-ink-mute">{addrLines[addrLines.length - 1]}</span>
                </summary>
                <div className="pb-2">
                  {addrLines.map((line, i) => (
                    <span key={i} className="block">{line}</span>
                  ))}
                </div>
              </details>
            </>
          ) : (
            <p className="mt-3 text-[13px] text-ink-mute">Delivery address on the Stripe payment / Xero invoice.</p>
          )}
        </div>

        <div className="flex shrink-0 flex-col gap-2 md:items-end">
          <ButtonInk onClick={onReview} disabled={!canOrder} className="max-md:w-full max-md:h-[50px] max-md:text-[15px]">
            {route !== 'supplier'
              ? 'Review and push to production'
              : supplierCount > 1
                ? 'Review and choose supplier'
                : supplierCount === 1
                  ? `Review and order from ${supplierLabels[0] ?? 'supplier'}`
                  : 'Review and order from supplier'}
          </ButtonInk>
          {!canOrder && (
            <span className="text-right text-[11px] text-ink-mute max-md:text-center">
              {!folderVerified
                ? 'Link & check the order folder to enable'
                : dateValue
                  ? 'Confirm the date required to enable'
                  : 'Set a date required to enable'}
            </span>
          )}
          {/* Secondary actions: a side column on desktop (md:contents lets each
              button flow as a column child) but a single 44px row on mobile. */}
          <div className="flex gap-2 md:contents">
            <Link to={`/proofs/${order.proof_id}`} className="max-md:flex-1">
              <ButtonGhost size="sm" className="max-md:w-full max-md:h-11">View proof &amp; artwork</ButtonGhost>
            </Link>
            <ButtonGhost size="sm" onClick={onCopy} className="max-md:flex-1 max-md:h-11">{copied ? 'Copied' : 'Copy order link'}</ButtonGhost>
            {/* Retry invoice is for orders whose AUTO Xero invoice failed. Offline
                orders deliberately have no auto-invoice (raised manually in Xero),
                so retrying would create a DUPLICATE — never offer it for offline. */}
            {!order.xero_invoice_id && order.payment_method !== 'offline' && (
              <ButtonGhost size="sm" onClick={onRetryInvoice} disabled={busy} className="max-md:flex-1 max-md:h-11">
                {busy ? 'Retrying…' : 'Retry invoice'}
              </ButtonGhost>
            )}
          </div>
        </div>
      </div>
    </PanelShell>
  )
}

function AwaitingPaymentCard({
  order,
  expired,
  busy,
  copied,
  reminder,
  onCopy,
  onReactivate,
  onCancel,
}: {
  order: OrderRow
  expired: boolean
  busy: boolean
  copied: boolean
  reminder: { count: number; lastAt: string } | null
  onCopy: () => void
  onReactivate: () => void
  onCancel: () => void
}) {
  const total = orderTotal(order)
  return (
    <PanelShell>
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link to={`/proofs/${order.proof_id}`} className="text-base font-semibold text-ink hover:underline">
              {customerLabel(order)}
            </Link>
            {expired ? <Pill colour="out">Expired</Pill> : <Pill colour="low">Awaiting payment</Pill>}
          </div>
          <p className="mt-0.5 text-sm text-ink-soft">
            {specLabel(order)}
            {' · '}
            {order.quantity != null ? `${order.quantity.toLocaleString()} cards` : 'Customer picks quantity'}
            {total != null ? ` · ${formatPrice(total, order.currency)}` : ''}
          </p>
          <p className="mt-0.5 text-[13px] text-ink-mute">
            Ref {order.payment_reference}
            {order.sent_at ? ` · sent ${formatDate(order.sent_at)}` : ''}
            {order.expires_at ? ` · ${expired ? 'expired' : 'expires'} ${formatDate(order.expires_at)}` : ''}
          </p>
          <p className="mt-0.5 text-[13px] text-ink-mute">
            {order.pay_link_opened_at
              ? <span title={formatAbsoluteDateTime(order.pay_link_opened_at)}>Pay link opened {relativeTime(order.pay_link_opened_at)}</span>
              : 'Pay link not opened yet'}
          </p>
          {reminder && (
            <p className="mt-1 text-[13px] text-ink-soft">
              {reminder.count === 1
                ? `Reminder sent ${formatDate(reminder.lastAt)}`
                : `${reminder.count} reminders sent · last ${formatDate(reminder.lastAt)}`}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-col gap-2 md:items-end">
          <ButtonGhost size="sm" onClick={onCopy} className="max-md:w-full max-md:h-11">{copied ? 'Copied' : 'Copy link'}</ButtonGhost>
          {expired && (
            <ButtonInk onClick={onReactivate} disabled={busy} className="max-md:w-full max-md:h-[50px] max-md:text-[15px]">
              {busy ? 'Reactivating…' : 'Reactivate link'}
            </ButtonInk>
          )}
          <ButtonGhost size="sm" onClick={onCancel} disabled={busy} className="max-md:w-full max-md:h-11">Cancel order</ButtonGhost>
        </div>
      </div>
    </PanelShell>
  )
}
