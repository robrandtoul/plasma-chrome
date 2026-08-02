// The Order log (/orders/log) — a comprehensive, searchable record of every
// order ever placed, designer-facing and in the top nav. Where the Orders page
// is a work queue ("what needs doing next?"), this page is the archive and the
// window: pick any order and see everything on file — the approved artwork,
// the customer and delivery details, the checkout breakdown, links out to the
// proof / Help Scout / Dropbox / Xero, and the full lifecycle timeline with
// the key moments in plain sight.
//
// Data notes (why this page needs no migration):
// - proofs.orders is fully readable by any authenticated designer (RLS
//   orders_rw), so the list is a direct paged select — no RPC. The admin
//   Order log's admin_search_orders RPC hard-raises Forbidden for designers,
//   which is why it isn't reused here.
// - Search and filters are client-side over the loaded set: instant at the
//   current scale, and the fetch pages up to LIST_CAP rows before politely
//   capping.
// - Shipped/delivered state comes from admin_order_shipping_state, which is
//   admin-gated server-side — admins get the extra column and timeline
//   entries, designers see everything else identically.
// - The timeline is assembled from column stamps + the order_nudges ledger
//   (src/lib/orderTimeline.ts) because Stripe writes no audit rows and
//   audit_log is admin-only — the stamps ARE the record.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  ArrowLeft,
  BellRing,
  Check,
  ClipboardList,
  Copy,
  CreditCard,
  ExternalLink,
  Eye,
  Factory,
  FilePlus2,
  FileSearch,
  Flag,
  Hourglass,
  LifeBuoy,
  Mail,
  MessageSquare,
  PackageCheck,
  RefreshCw,
  Send,
  StickyNote,
  Truck,
  Undo2,
} from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { DesignerChrome, PanelShell, Pill, tokens } from '../design'
import type { PillColour } from '../design'
import { formatPrice } from '../lib/currency'
import type { Currency } from '../lib/types'
import { relativeTime, formatAbsoluteDateTime } from '../lib/relativeTime'
import { orderTotal, specLabel, customerLabel, usTariffDutyBilling } from '../lib/orderDisplay'
import {
  matchesOrderSearch,
  orderLogStatus,
  orderLogDisplayStatus,
  computeOrderLogStats,
  type OrderLogBucket,
  type OrderLogStats,
  type WeeklyPaidPoint,
} from '../lib/orderLog'
import { isGbpOrderVatFree } from '../lib/ukVatArea'
import {
  buildOrderTimeline,
  type OrderTimelineEntry,
  type OrderTimelineEntryType,
  type TimelineShipping,
} from '../lib/orderTimeline'
import { getExchangeRates, type ExchangeRates } from '../lib/exchangeRates'
import { signThumbnails, type ThumbInfo } from '../lib/thumbnails'
import { customerOrderUrl, customerOrderGroupUrl } from '../lib/customerOrderUrl'
import { openDesignerPreview } from '../lib/customerProofUrl'
import { scopeToOrderedFinish, finishScopeIsUncertain } from '../lib/approvedArtworkFinish'
import Modal from '../components/Modal'
import FlagProjectModal from '../components/FlagProjectModal'
import { WATCH_CATEGORIES, type WatchCategory } from '../lib/watchList'
import type { GridImage } from '../components/ImageGrid'

// ── Row shapes ───────────────────────────────────────────────────────────────

interface LogOrder {
  id: string
  status: string
  token: string
  expires_at: string | null
  created_at: string
  sent_at: string | null
  paid_at: string | null
  fulfilled_at: string | null
  revised_at: string | null
  pay_link_opened_at: string | null
  help_requested_at: string | null
  pay_link_resend_requested_at: string | null
  invoice_emailed_at: string | null
  confirmation_sent_at: string | null
  payment_method: string
  order_kind: string
  payment_reference: string | null
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
  us_tariff_opted_out: boolean | null
  card_discount_type: string
  card_discount_value: number | null
  card_discount_reason: string | null
  amount_card_discount: number | null
  shipping_treatment: string
  xero_invoice_id: string | null
  xero_invoice_error: string | null
  order_group_id: string | null
  proof_id: string
  material_id: string | null
  material_variant_id: string | null
  material_option_id: string | null
  thickness_open: boolean
  finish_open: boolean
  quantity_open: boolean
  date_required: string | null
  dropbox_folder_url: string | null
  stock_order_number: string | null
  project_name: string | null
  stock_colour: string | null
  supplier_name: string | null
  supplier_overs: number | null
  handoff_at: string | null
  supplier_email_sent_at: string | null
  production_note_posted_at: string | null
  artwork_check_verdict: string | null
  artwork_checked_at: string | null
  created_by: string | null
  fulfilled_by: string | null
  ship_to_name: string | null
  ship_to_email: string | null
  ship_to_phone: string | null
  ship_dest_country: string | null
  ship_dest_postcode: string | null
  customs_tax_id: string | null
  vat_treatment: string
  material_variants: {
    display_name: string | null
    materials: { display_name: string | null; code: string | null; production_route: string | null } | null
  } | null
  material_options: { display_name: string | null } | null
  proofs: {
    status: string | null
    helpscout_conversation_id: string | null
    helpscout_conversation_url: string | null
    contacts: { full_name: string | null; email: string | null; companies: { name: string | null } | null } | null
  } | null
}

// The lib's status helper consulted with the owning proof's status, so a
// cancelled order on an abandoned project reads "Abandoned" like the proof
// page does. Every status read on this page goes through here.
function logStatus(o: LogOrder, now: Date, group: LogGroup | null) {
  return orderLogStatus({ ...o, proof_status: o.proofs?.status ?? null }, now, group)
}

function watchCategoryLabel(category: WatchCategory): string {
  return WATCH_CATEGORIES.find((c) => c.value === category)?.label ?? category
}

interface LogGroup {
  id: string
  status: string
  currency: Currency
  token: string
  payment_reference: string | null
  expires_at: string | null
  pay_link_opened_at: string | null
  paid_at: string | null
  invoice_emailed_at: string | null
  confirmation_sent_at: string | null
  xero_invoice_id: string | null
  xero_invoice_error: string | null
  amount_shipping: number | null
  amount_us_tariff: number | null
  us_tariff_opted_out: boolean | null
}

interface DetailExtras {
  forId: string
  ship_to_address: {
    line1?: string | null
    line2?: string | null
    city?: string | null
    region?: string | null
    postal_code?: string | null
    country?: string | null
  } | null
  person_quantities: { name?: string | null; quantity?: number | null }[] | null
  order_spec_snapshot: {
    ink_names?: string[] | null
    letterpress?: { front?: string | null; core?: string | null; back?: string | null } | null
  } | null
  handoff_error: string | null
}

interface Reminder {
  reminder_no: number | null
  source: string | null
  state: string
  outcome: string | null
  created_at: string
}

interface ArtworkImage {
  id: string
  url: string
  label: string
}

// Everything the list select needs and nothing heavy — ship_to_address,
// person_quantities, order_spec_snapshot and the artwork_check report are
// fetched per-order when the detail opens.
const LIST_SELECT = `
  id, status, token, expires_at, created_at, sent_at, paid_at, fulfilled_at, revised_at,
  pay_link_opened_at, help_requested_at, pay_link_resend_requested_at, invoice_emailed_at, confirmation_sent_at,
  payment_method, order_kind, payment_reference, currency, quantity, names_count, has_personalisation,
  custom_quote_total, amount_cards, amount_tooling, amount_personalisation, amount_shipping, amount_us_tariff,
  us_tariff_opted_out, card_discount_type, card_discount_value, card_discount_reason, amount_card_discount,
  shipping_treatment, xero_invoice_id, xero_invoice_error, order_group_id, proof_id, material_id,
  material_variant_id, material_option_id, thickness_open, finish_open, quantity_open,
  date_required, dropbox_folder_url, stock_order_number, project_name, stock_colour,
  supplier_name, supplier_overs, handoff_at, supplier_email_sent_at, production_note_posted_at,
  artwork_check_verdict, artwork_checked_at, created_by, fulfilled_by,
  ship_to_name, ship_to_email, ship_to_phone, ship_dest_country, ship_dest_postcode, customs_tax_id, vat_treatment,
  material_variants(display_name, materials(display_name, code, production_route)),
  material_options(display_name),
  proofs(status, helpscout_conversation_id, helpscout_conversation_url, contacts(full_name, email, companies(name)))
`

const PAGE_SIZE = 1000
// Well above live volume (~200 orders after one year); the cap line only ever
// shows once the archive genuinely outgrows a five-figure fetch.
const LIST_CAP = 5000
const INITIAL_SHOWN = 100
const SHOW_MORE_STEP = 200

const BUCKET_FILTERS: { key: 'all' | OrderLogBucket; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'awaiting', label: 'Awaiting payment' },
  { key: 'paid', label: 'Paid' },
  { key: 'ordered', label: 'Ordered' },
  { key: 'revision', label: 'Revision' },
  { key: 'cancelled', label: 'Cancelled' },
]

function companyOf(o: LogOrder): string | null {
  return o.proofs?.contacts?.companies?.name ?? null
}
function contactOf(o: LogOrder): string | null {
  return o.proofs?.contacts?.full_name ?? null
}
function specOf(o: LogOrder): string {
  return specLabel(
    o.material_variants?.materials?.display_name,
    o.material_variants?.display_name,
    o.custom_quote_total,
    o.material_options?.display_name,
  )
}
function kindSuffix(o: LogOrder): string {
  if (o.order_kind === 'prototype') return ' · Prototype sample'
  if (o.order_kind === 'reprint') return ' · Free reprint'
  return ''
}

export default function OrderLogPage() {
  const { role } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()
  const selectedId = searchParams.get('order')

  const [orders, setOrders] = useState<LogOrder[] | null>(null)
  const [groups, setGroups] = useState<Record<string, LogGroup>>({})
  const [groupsFailed, setGroupsFailed] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [capped, setCapped] = useState(false)
  const [rates, setRates] = useState<ExchangeRates | null>(null)
  const [shipping, setShipping] = useState<Map<string, TimelineShipping> | null>(null)
  const [designerNames, setDesignerNames] = useState<Map<string, string>>(new Map())
  // Open (unresolved) Flagged-board cards keyed by proof id — the board allows
  // one open card per project, so a plain map is the whole shape.
  const [flags, setFlags] = useState<Record<string, WatchCategory>>({})
  const [flagFor, setFlagFor] = useState<LogOrder | null>(null)
  const [search, setSearch] = useState('')
  const [bucket, setBucket] = useState<'all' | OrderLogBucket>('all')
  const [shown, setShown] = useState(INITIAL_SHOWN)
  const [thumbs, setThumbs] = useState<Record<string, ThumbInfo | null>>({})
  const [materialThumbs, setMaterialThumbs] = useState<Record<string, ThumbInfo>>({})

  // "Now" is pinned per data load so derived expiry / stats don't flicker
  // between renders.
  const now = useMemo(() => new Date(), [orders])

  useEffect(() => {
    const previous = document.title
    document.title = 'Order log — Proof Viewer'
    return () => { document.title = previous }
  }, [])

  // ── The list ──────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    async function load() {
      const all: LogOrder[] = []
      // De-dupe across pages: a row inserted between two range requests
      // shifts the offsets, and equal created_at values sort
      // non-deterministically without the id tiebreaker below.
      const seen = new Set<string>()
      let from = 0
      while (from < LIST_CAP) {
        const { data, error } = await supabase
          .from('orders')
          .select(LIST_SELECT)
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .range(from, from + PAGE_SIZE - 1)
        if (error) {
          if (!cancelled) setLoadError(error.message)
          return
        }
        const rows = (data ?? []) as unknown as LogOrder[]
        for (const r of rows) {
          if (!seen.has(r.id)) {
            seen.add(r.id)
            all.push(r)
          }
        }
        if (rows.length < PAGE_SIZE) break
        from += PAGE_SIZE
      }
      if (cancelled) return
      setCapped(all.length >= LIST_CAP)
      setOrders(all)

      const groupIds = [...new Set(all.map((o) => o.order_group_id).filter(Boolean))] as string[]
      if (groupIds.length > 0) {
        const { data: gRows, error: gErr } = await supabase
          .from('order_groups')
          .select('id, status, currency, token, payment_reference, expires_at, pay_link_opened_at, paid_at, invoice_emailed_at, confirmation_sent_at, xero_invoice_id, xero_invoice_error, amount_shipping, amount_us_tariff, us_tariff_opted_out')
          .in('id', groupIds)
        if (gErr) console.error('[order-log] order_groups fetch failed', gErr)
        if (!cancelled) {
          setGroupsFailed(!!gErr)
          if (gRows) {
            const map: Record<string, LogGroup> = {}
            for (const g of gRows as unknown as LogGroup[]) map[g.id] = g
            setGroups(map)
          }
        }
      }

      // Open Flagged-board cards, so gone-wrong orders wear their flag here
      // and the detail can offer "Flag a problem" vs "Open Flagged board".
      const { data: wRows, error: wErr } = await supabase
        .from('watch_items')
        .select('proof_id, category, status')
        .neq('status', 'resolved')
      if (wErr) console.error('[order-log] watch_items fetch failed', wErr)
      if (!cancelled && wRows) {
        const map: Record<string, WatchCategory> = {}
        for (const w of wRows as { proof_id: string; category: WatchCategory; status: string }[]) {
          if (w.status !== 'resolved') map[w.proof_id] = w.category
        }
        setFlags(map)
      }

      // Who created / placed each order — a handful of designers across the
      // whole log, resolved once. profiles SELECT is self-or-admin by RLS, so
      // a direct read silently returns only the caller's own row for a
      // non-admin designer (the exact bug class 000329 fixed for team chat) —
      // the SECURITY DEFINER team_roster() RPC is the designer-visible
      // roster. The direct read is kept and merged on top because it's the
      // only source that names since-deactivated staff (admins only).
      const designerIds = [
        ...new Set(all.flatMap((o) => [o.created_by, o.fulfilled_by]).filter(Boolean)),
      ] as string[]
      if (designerIds.length > 0) {
        const map = new Map<string, string>()
        const [{ data: roster, error: rosterErr }, { data: pRows }] = await Promise.all([
          supabase.rpc('team_roster'),
          supabase.from('profiles').select('id, full_name').in('id', designerIds),
        ])
        if (rosterErr) console.error('[order-log] team_roster failed', rosterErr)
        for (const p of (roster ?? []) as { id: string; full_name: string | null }[]) {
          if (p.full_name) map.set(p.id, p.full_name)
        }
        for (const p of (pRows ?? []) as { id: string; full_name: string | null }[]) {
          if (p.full_name) map.set(p.id, p.full_name)
        }
        if (!cancelled) setDesignerNames(map)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let cancelled = false
    void getExchangeRates().then((r) => { if (!cancelled) setRates(r) })
    return () => { cancelled = true }
  }, [])

  // Shipped/delivered enrichment — the RPC is admin-gated server-side, so only
  // ask as an admin. Designers simply don't get the dispatch column; nothing
  // else on the page depends on it.
  useEffect(() => {
    if (role !== 'admin') return
    let cancelled = false
    supabase.rpc('admin_order_shipping_state').then(({ data, error }) => {
      if (cancelled || error || !data) return
      const map = new Map<string, TimelineShipping>()
      for (const r of data as { order_id: string; shipped_at: string | null; delivered_at: string | null }[]) {
        map.set(r.order_id, { shipped_at: r.shipped_at, delivered_at: r.delivered_at })
      }
      setShipping(map)
    })
    return () => { cancelled = true }
  }, [role])

  // ── Search + filter ───────────────────────────────────────────────────────
  const searchables = useMemo(() => {
    const map = new Map<string, ReturnType<typeof toSearchable>>()
    for (const o of orders ?? []) map.set(o.id, toSearchable(o))
    return map
  }, [orders])

  const groupOf = useCallback(
    (o: LogOrder): LogGroup | null => (o.order_group_id ? groups[o.order_group_id] ?? null : null),
    [groups],
  )

  const filtered = useMemo(() => {
    if (!orders) return []
    return orders.filter((o) => {
      if (bucket !== 'all' && logStatus(o, now, groupOf(o)).bucket !== bucket) return false
      const s = searchables.get(o.id)
      return s ? matchesOrderSearch(s, search) : true
    })
  }, [orders, bucket, search, searchables, now, groupOf])

  const bucketCounts = useMemo(() => {
    const counts: Record<string, number> = { all: orders?.length ?? 0 }
    for (const o of orders ?? []) {
      const b = logStatus(o, now, groupOf(o)).bucket
      counts[b] = (counts[b] ?? 0) + 1
    }
    return counts
  }, [orders, now, groupOf])

  // Reset the render window when the question changes.
  useEffect(() => { setShown(INITIAL_SHOWN) }, [search, bucket])
  const visible = filtered.slice(0, shown)

  const stats: OrderLogStats | null = useMemo(
    () => (orders ? computeOrderLogStats(orders, rates, now, groups) : null),
    [orders, rates, now, groups],
  )

  // ── Thumbnails for the visible rows ───────────────────────────────────────
  // Same shape as the Orders work queue: newest version in the ORDER's
  // material wins, so a steel order never wears letterpress artwork; falls
  // back to the current version. signThumbnails caches, so revealing more
  // rows only fetches the delta.
  const visibleProofKey = useMemo(
    () => [...new Set(visible.map((o) => o.proof_id))].sort().join(','),
    [visible],
  )
  useEffect(() => {
    const proofIds = visibleProofKey ? visibleProofKey.split(',') : []
    if (proofIds.length === 0) return
    let cancelled = false
    async function loadThumbs() {
      type VRow = { id: string; proof_id: string; material_id: string | null; is_current: boolean }
      const rows: VRow[] = []
      // Chunk the .in() to keep request URLs sane on big archives.
      for (let i = 0; i < proofIds.length; i += 150) {
        const { data } = await supabase
          .from('proof_versions')
          .select('id, proof_id, material_id, is_current')
          .in('proof_id', proofIds.slice(i, i + 150))
          .order('created_at', { ascending: false })
        if (cancelled) return
        rows.push(...((data ?? []) as VRow[]))
      }
      const currentByProof: Record<string, string> = {}
      const newestByProof: Record<string, string> = {}
      const materialVersion: Record<string, string> = {}
      for (const v of rows) {
        if (v.is_current && !currentByProof[v.proof_id]) currentByProof[v.proof_id] = v.id
        if (!newestByProof[v.proof_id]) newestByProof[v.proof_id] = v.id
        if (v.material_id && !materialVersion[`${v.proof_id}:${v.material_id}`]) {
          materialVersion[`${v.proof_id}:${v.material_id}`] = v.id
        }
      }
      const wanted = [...new Set([...Object.values(currentByProof), ...Object.values(newestByProof), ...Object.values(materialVersion)])]
      if (wanted.length === 0) return
      const signed = await signThumbnails(wanted)
      if (cancelled) return
      setThumbs((prev) => {
        const next = { ...prev }
        for (const [proofId, vid] of Object.entries(currentByProof)) next[proofId] = signed.get(vid) ?? next[proofId] ?? null
        for (const [proofId, vid] of Object.entries(newestByProof)) {
          if (next[proofId] == null) next[proofId] = signed.get(vid) ?? null
        }
        return next
      })
      setMaterialThumbs((prev) => {
        const next = { ...prev }
        for (const [key, vid] of Object.entries(materialVersion)) {
          const t = signed.get(vid)
          if (t) next[key] = t
        }
        return next
      })
    }
    void loadThumbs()
    return () => { cancelled = true }
  }, [visibleProofKey])

  const thumbForOrder = useCallback(
    (o: LogOrder): ThumbInfo | null =>
      (o.material_id ? materialThumbs[`${o.proof_id}:${o.material_id}`] : null) ?? thumbs[o.proof_id] ?? null,
    [thumbs, materialThumbs],
  )

  // ── Selection ─────────────────────────────────────────────────────────────
  const selected = useMemo(
    () => (selectedId && orders ? orders.find((o) => o.id === selectedId) ?? null : null),
    [selectedId, orders],
  )
  const select = useCallback(
    (id: string | null) => {
      setSearchParams(id ? { order: id } : {}, { replace: false })
    },
    [setSearchParams],
  )

  // "The detail pane has something to show" — a real selection OR a stale
  // ?order= id once the log has loaded (the not-found panel). All three
  // responsive wrappers key on this so a stale deep link flips mobile into
  // detail mode the same way a real selection does, instead of silently
  // showing the list.
  const detailOpen = selectedId != null && orders != null

  // Below lg the panel replaces the list inside the page scroller — reset
  // that scroller so the detail opens at the top. useLayoutEffect so the
  // reset lands before paint. Never touch the window at lg+ — the panel is
  // sticky beside the list there, and its internal scroller restarts at the
  // top automatically because OrderDetailPanel remounts per selection (key).
  useLayoutEffect(() => {
    if (selectedId && !window.matchMedia('(min-width: 1024px)').matches) {
      window.scrollTo(0, 0)
      const frame = document.getElementById('app-scroll')
      if (frame) frame.scrollTop = 0
    }
  }, [selectedId])

  const listPane = (
    <div className={detailOpen ? 'hidden lg:block' : ''}>
      {/* Stats strip */}
      {stats && orders && orders.length > 0 && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-[repeat(4,minmax(0,1fr))]">
          <StatCard
            label="Paid · 30 days"
            value={String(stats.paid30Count)}
            sub={stats.paid30Count > 0 ? `≈ ${formatPrice(stats.paid30Gbp, 'GBP')} · rough guide` : 'No payments yet'}
            accent={tokens.inStock}
          />
          <StatCard
            label="Awaiting payment"
            value={String(stats.awaitingCount)}
            sub={stats.awaitingExpiredCount > 0 ? `${stats.awaitingExpiredCount} expired` : 'All links live'}
            accent={tokens.low}
          />
          <StatCard
            label="Median time to pay"
            value={stats.medianDaysToPay == null ? '—' : stats.medianDaysToPay < 1 ? '<1d' : `${Math.round(stats.medianDaysToPay)}d`}
            sub="Link sent → paid"
            accent={tokens.allocated}
          />
          <StatCard
            label="Placed · 30 days"
            value={String(stats.placed30Count)}
            sub="Into production"
            accent={tokens.brand}
          />
          <div className="col-span-2 md:col-span-4">
            <WeeklyPaidChart points={stats.weeklyPaid} />
          </div>
        </div>
      )}

      {/* Toolbar */}
      <div className="mt-5">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search customer, reference, invoice, stock number, material…"
          className="h-10 w-full rounded-lg border border-line bg-surface px-3 text-sm text-ink focus:border-[var(--c-brand)] focus:outline-2 focus:outline-offset-1 focus:outline-[var(--c-brand)]"
        />
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {BUCKET_FILTERS.map((f) => {
            const active = bucket === f.key
            const count = bucketCounts[f.key] ?? 0
            if (f.key !== 'all' && count === 0) return null
            return (
              <button
                key={f.key}
                type="button"
                onClick={() => setBucket(f.key)}
                aria-pressed={active}
                className={[
                  'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium ring-1 transition-colors',
                  active
                    ? 'bg-ink text-on-ink ring-ink'
                    : 'bg-surface text-ink-soft ring-line hover:bg-canvas',
                ].join(' ')}
              >
                {f.label}
                <span className={['font-mono text-[10px]', active ? 'text-white/70' : 'text-ink-dim'].join(' ')}>
                  {count}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      {/* The list */}
      <div className="mt-4">
        {orders == null && !loadError && <p className="text-sm text-ink-mute">Loading the order log…</p>}
        {loadError && (
          <p className="rounded-lg border border-line bg-out-soft px-3 py-2 text-sm text-ink">
            The order log couldn’t load: {loadError}
          </p>
        )}
        {orders != null && filtered.length === 0 && (
          <p className="text-sm text-ink-mute">
            {orders.length === 0 ? 'No orders yet — the log fills up as pay links go out.' : 'Nothing matches that search.'}
          </p>
        )}
        {visible.length > 0 && (
          <div className="overflow-hidden rounded-[14px] border border-line bg-surface">
            {visible.map((o) => (
              <OrderRowButton
                key={o.id}
                order={o}
                group={groupOf(o)}
                selected={o.id === selectedId}
                thumb={thumbForOrder(o)}
                shipping={shipping?.get(o.id) ?? null}
                shipped={shipping?.has(o.id) ?? false}
                flag={flags[o.proof_id] ?? null}
                now={now}
                onSelect={() => select(o.id)}
              />
            ))}
          </div>
        )}
        {filtered.length > shown && (
          <button
            type="button"
            onClick={() => setShown((n) => n + SHOW_MORE_STEP)}
            className="mt-3 w-full rounded-lg border border-line bg-surface py-2 text-sm font-medium text-ink-soft hover:bg-canvas"
          >
            Show more ({filtered.length - shown} of {filtered.length} hidden)
          </button>
        )}
        {capped && (
          <p className="mt-2 text-[12px] text-ink-mute">
            Showing the most recent {LIST_CAP.toLocaleString()} orders.
          </p>
        )}
      </div>
    </div>
  )

  return (
    <DesignerChrome active="orderlog">
      <div className="mx-auto max-w-[1320px] px-4 py-8 sm:px-7">
        <div className={detailOpen ? 'hidden lg:block' : ''}>
          <h1 className="text-xl font-semibold text-ink">Order log</h1>
          <p className="mt-1 text-sm text-ink-soft">
            Every order on file — search it, open one, and see everything we hold: artwork, contact
            details, checkout, links and the full history.
          </p>
        </div>

        {/* No items-start here: the detail column must stretch to the full
            row height or its sticky inner panel has no room to travel and
            stays anchored at the top of the document — exactly the "details
            are out of view when I click a row far down the list" bug. */}
        <div className="mt-6 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(390px,460px)] lg:gap-6">
          {listPane}

          <div className={detailOpen ? '' : 'hidden lg:block'}>
            {/* Sticky only — the height cap and scrolling live INSIDE the
                panel (pinned header, scrolling body) so it reads as a card
                with its own neat scroll, not a clipped iframe. */}
            <div className="lg:sticky lg:top-[76px]">
              {selected ? (
                <>
                  <button
                    type="button"
                    onClick={() => select(null)}
                    className="mb-3 inline-flex items-center gap-1.5 text-sm font-medium text-ink-soft hover:text-ink lg:hidden"
                  >
                    <ArrowLeft size={16} aria-hidden="true" /> Back to the log
                  </button>
                  <OrderDetailPanel
                    key={selected.id}
                    order={selected}
                    group={groupOf(selected)}
                    groupsFailed={groupsFailed}
                    groupFor={groupOf}
                    shipping={shipping}
                    designerNames={designerNames}
                    isAdmin={role === 'admin'}
                    now={now}
                    siblings={orders ?? []}
                    flag={flags[selected.proof_id] ?? null}
                    onFlag={() => setFlagFor(selected)}
                    onSelect={select}
                  />
                </>
              ) : selectedId && orders != null ? (
                <PanelShell title="Order not found" eyebrow="Order log" padded>
                  <p className="text-sm text-ink-soft">
                    That order isn’t in the loaded log — the link may be stale.
                  </p>
                  <button
                    type="button"
                    onClick={() => select(null)}
                    className="mt-3 text-sm font-medium text-brand hover:underline"
                  >
                    Clear selection
                  </button>
                </PanelShell>
              ) : (
                <div className="hidden rounded-[14px] border border-dashed border-line bg-surface/60 p-8 text-center lg:block">
                  <ClipboardList size={28} aria-hidden="true" className="mx-auto text-ink-dim" />
                  <p className="mt-3 text-sm font-medium text-ink-soft">Select an order</p>
                  <p className="mx-auto mt-1 max-w-[36ch] text-[13px] leading-relaxed text-ink-mute">
                    Everything on file appears here — the approved artwork, contact and delivery
                    details, the checkout breakdown, and the full order history.
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Flag a gone-wrong order onto the shared Flagged board — the same
          modal the proof page and the board use, in fixed-project mode. */}
      {flagFor && (
        <FlagProjectModal
          proof={{ id: flagFor.proof_id, companyName: companyOf(flagFor), contactName: contactOf(flagFor) }}
          onClose={() => setFlagFor(null)}
          onCreated={(item) => {
            setFlags((prev) => ({ ...prev, [item.proof_id]: item.category }))
            setFlagFor(null)
          }}
        />
      )}
    </DesignerChrome>
  )
}

function toSearchable(o: LogOrder) {
  return {
    id: o.id,
    payment_reference: o.payment_reference,
    stock_order_number: o.stock_order_number,
    xero_invoice_id: o.xero_invoice_id,
    project_name: o.project_name,
    ship_to_name: o.ship_to_name,
    companyName: companyOf(o),
    contactName: contactOf(o),
    contactEmail: o.proofs?.contacts?.email ?? null,
    specText: `${specOf(o)}${kindSuffix(o)}`,
  }
}

// ── Stat tiles + weekly chart ────────────────────────────────────────────────

function StatCard({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-3.5">
      <div className="flex items-center gap-1.5">
        <span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ backgroundColor: accent }} />
        <span className="eyebrow">{label}</span>
      </div>
      <div className="mt-2 font-mono text-[26px] font-semibold leading-none tracking-tight text-ink tabular-nums">
        {value}
      </div>
      {sub && <div className="mt-1.5 text-[11px] leading-snug text-ink-mute">{sub}</div>}
    </div>
  )
}

// A 12-week chart of payments received — hand-rolled SVG in the house style
// (no chart library). TWO aligned bands sharing the week axis: order counts
// on top, ≈£ value beneath. Deliberately not one dual-scale chart — counts
// (tens) and value (thousands) can't share an axis honestly, so each band
// scales itself and is directly labelled. Zero weeks render as visible stubs
// so a quiet fortnight reads as quiet rather than vanishing (the 000363
// lesson). Native <title> tooltips carry both figures per week.
function WeeklyPaidChart({ points }: { points: WeeklyPaidPoint[] }) {
  const W = 720
  const PAD_X = 6
  const BAND_H = 52
  const BAND_GAP = 22
  const TOP = 12
  const base1 = TOP + BAND_H // count band baseline
  const top2 = base1 + BAND_GAP
  const base2 = top2 + BAND_H // value band baseline
  const H = base2 + 18
  // On narrow screens the pinned-width drawing scrolls horizontally — start
  // scrolled to the END so the most recent weeks (the ones that matter) are
  // in view and older ones are reachable by scrolling left.
  const scrollRef = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollLeft = el.scrollWidth
  }, [])
  const maxCount = Math.max(1, ...points.map((p) => p.count))
  const maxGbp = Math.max(1, ...points.map((p) => p.gbp))
  const slot = (W - PAD_X * 2) / points.length
  const barW = Math.min(26, slot - 8)
  const fmtWeek = (iso: string) => {
    const d = new Date(`${iso}T00:00:00`)
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  }
  const fmtCompactGbp = (n: number) => (n >= 1000 ? `£${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `£${n}`)
  const first = points[0]
  const last = points[points.length - 1]
  // Top corners rounded, base flat — the data end carries the rounding, the
  // baseline anchors.
  const bar = (x: number, base: number, h: number, fill: string) => {
    const y = base - h
    const r = Math.min(3, barW / 2, h)
    return (
      <path
        d={`M ${x} ${base} V ${y + r} Q ${x} ${y} ${x + r} ${y} H ${x + barW - r} Q ${x + barW} ${y} ${x + barW} ${y + r} V ${base} Z`}
        fill={fill}
        opacity="0.85"
      />
    )
  }
  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-3.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="eyebrow">Paid by week</span>
        <span className="text-[11px] text-ink-mute">last 12 weeks · £ is a rough guide</span>
      </div>
      {/* Width pinned 1:1 to the viewBox inside an overflow-x-auto wrapper
          (the AdminAnalyticsPage idiom): a bare w-full SVG scales the whole
          drawing down on phones, shrinking the 10px labels to unreadable.
          Both pins are required or preserveAspectRatio letterboxes. */}
      <div ref={scrollRef} className="mt-1 overflow-x-auto">
        <div style={{ minWidth: W }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        style={{ maxWidth: W }}
        role="img"
        aria-label={`Orders paid per week and their approximate value in pounds, over the last 12 weeks from ${fmtWeek(first.weekStart)} to ${fmtWeek(last.weekStart)}`}
      >
        {/* Band labels — direct labelling, so identity is never colour-alone. */}
        <text x={PAD_X} y={TOP - 3} style={{ font: '600 9px ui-monospace, monospace', letterSpacing: '0.08em' }} className="fill-[var(--c-ink-dim)]">
          ORDERS
        </text>
        <text x={PAD_X} y={top2 - 3} style={{ font: '600 9px ui-monospace, monospace', letterSpacing: '0.08em' }} className="fill-[var(--c-ink-dim)]">
          ≈ VALUE
        </text>
        <line x1={PAD_X} y1={base1} x2={W - PAD_X} y2={base1} stroke="var(--c-line)" strokeWidth="1" />
        <line x1={PAD_X} y1={base2} x2={W - PAD_X} y2={base2} stroke="var(--c-line)" strokeWidth="1" />
        {points.map((p, i) => {
          const x = PAD_X + i * slot + (slot - barW) / 2
          const hCount = p.count === 0 ? 0 : Math.max(4, ((BAND_H - 14) * p.count) / maxCount)
          const hGbp = p.gbp === 0 ? 0 : Math.max(4, ((BAND_H - 14) * p.gbp) / maxGbp)
          const label = `w/c ${fmtWeek(p.weekStart)} — ${p.count} paid${p.gbp > 0 ? ` · ≈ ${formatPrice(p.gbp, 'GBP')}` : ''}`
          return (
            <g key={p.weekStart}>
              {p.count === 0 ? (
                <rect x={x} y={base1 - 2} width={barW} height={2} fill="var(--c-line)" />
              ) : (
                bar(x, base1, hCount, 'var(--c-brand)')
              )}
              {p.gbp === 0 ? (
                <rect x={x} y={base2 - 2} width={barW} height={2} fill="var(--c-line)" />
              ) : (
                // Money wears the house paid-green, matching the Paid pills.
                bar(x, base2, hGbp, 'var(--c-in-stock)')
              )}
              {/* One oversized invisible hit target per week spanning both
                  bands, so the tooltip is reachable on zero and short bars
                  alike and carries both figures. */}
              <rect x={PAD_X + i * slot} y={0} width={slot} height={H} fill="transparent">
                <title>{label}</title>
              </rect>
              {p.count === maxCount && p.count > 0 && (
                <text
                  x={x + barW / 2}
                  y={base1 - hCount - 4}
                  textAnchor="middle"
                  className="fill-[var(--c-ink-mute)]"
                  style={{ font: '600 10px ui-monospace, monospace' }}
                >
                  {p.count}
                </text>
              )}
              {p.gbp === maxGbp && p.gbp > 0 && (
                <text
                  x={x + barW / 2}
                  y={base2 - hGbp - 4}
                  textAnchor="middle"
                  className="fill-[var(--c-ink-mute)]"
                  style={{ font: '600 10px ui-monospace, monospace' }}
                >
                  {fmtCompactGbp(p.gbp)}
                </text>
              )}
            </g>
          )
        })}
        <text x={PAD_X} y={H - 4} style={{ font: '10px ui-monospace, monospace' }} className="fill-[var(--c-ink-dim)]">
          {fmtWeek(first.weekStart)}
        </text>
        <text x={W - PAD_X} y={H - 4} textAnchor="end" style={{ font: '10px ui-monospace, monospace' }} className="fill-[var(--c-ink-dim)]">
          {fmtWeek(last.weekStart)}
        </text>
      </svg>
        </div>
      </div>
    </div>
  )
}

// ── List rows ────────────────────────────────────────────────────────────────

function OrderRowButton({
  order: o,
  group,
  selected,
  thumb,
  shipped,
  shipping,
  flag,
  now,
  onSelect,
}: {
  order: LogOrder
  group: LogGroup | null
  selected: boolean
  thumb: ThumbInfo | null
  shipped: boolean
  shipping: TimelineShipping | null
  flag: WatchCategory | null
  now: Date
  onSelect: () => void
}) {
  const status = logStatus(o, now, group)
  const displayStatus = orderLogDisplayStatus(status, shipped, shipped && shipping?.delivered_at != null)
  const total = orderTotal(o)
  const dateAt = o.paid_at ?? o.created_at
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      className={[
        'flex w-full items-center gap-3 border-b border-line-soft px-3 py-2.5 text-left transition-colors last:border-b-0 sm:px-4',
        'border-l-2',
        selected
          ? 'border-l-[var(--c-brand)] bg-[color-mix(in_srgb,var(--c-brand)_6%,transparent)]'
          : 'border-l-transparent hover:bg-canvas',
      ].join(' ')}
    >
      {thumb ? (
        <img
          src={thumb.thumb_url}
          alt=""
          loading="lazy"
          className="h-12 w-12 shrink-0 rounded-lg object-cover ring-1 ring-line"
        />
      ) : (
        <span aria-hidden="true" className="h-12 w-12 shrink-0 rounded-lg bg-canvas ring-1 ring-line" />
      )}
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-[14px] font-medium text-ink">
            {customerLabel(companyOf(o), contactOf(o))}
          </span>
          {flag && (
            <Flag
              size={13}
              aria-label={`Flagged — ${watchCategoryLabel(flag)}`}
              className="shrink-0 fill-[var(--c-out)] text-out"
            />
          )}
          {o.order_kind === 'prototype' && <Pill colour="brand">Prototype</Pill>}
          {o.order_kind === 'reprint' && <Pill colour="allocated">Reprint</Pill>}
          {o.payment_method === 'offline' && <Pill colour="low">Offline</Pill>}
          {o.order_group_id && <Pill colour="brand">Combined</Pill>}
        </span>
        <span className="mt-0.5 block truncate text-[12.5px] text-ink-soft">
          {specOf(o)}
          {o.quantity != null ? ` · ${o.quantity.toLocaleString()} cards` : ''}
        </span>
        <span className="mt-0.5 block truncate font-mono text-[11px] text-ink-mute">
          {o.payment_reference ?? o.id.slice(0, 8)}
          {o.stock_order_number ? ` · #${o.stock_order_number}` : ''}
        </span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-1">
        <span className="font-mono text-[13px] font-semibold tabular-nums text-ink">
          {total != null ? formatPrice(total, o.currency) : '—'}
        </span>
        <span className="flex items-center gap-1.5">
          <Pill colour={displayStatus.pill as PillColour}>{displayStatus.label}</Pill>
        </span>
        <span className="text-[11px] text-ink-mute" title={formatAbsoluteDateTime(dateAt)}>
          {o.paid_at ? 'paid ' : ''}{relativeTime(dateAt)}
        </span>
      </span>
    </button>
  )
}

// ── Detail panel ─────────────────────────────────────────────────────────────

function OrderDetailPanel({
  order: o,
  group,
  groupsFailed,
  groupFor,
  shipping,
  designerNames,
  isAdmin,
  now,
  siblings,
  flag,
  onFlag,
  onSelect,
}: {
  order: LogOrder
  group: LogGroup | null
  groupsFailed: boolean
  groupFor: (o: LogOrder) => LogGroup | null
  shipping: Map<string, TimelineShipping> | null
  designerNames: Map<string, string>
  isAdmin: boolean
  now: Date
  siblings: LogOrder[]
  flag: WatchCategory | null
  onFlag: () => void
  onSelect: (id: string) => void
}) {
  const [extras, setExtras] = useState<DetailExtras | null>(null)
  const [reminders, setReminders] = useState<Reminder[]>([])
  const [detailError, setDetailError] = useState(false)
  const [artwork, setArtwork] = useState<ArtworkImage[] | null>(null)
  const [artworkError, setArtworkError] = useState(false)
  const [artworkNote, setArtworkNote] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)
  const [lightbox, setLightbox] = useState<ArtworkImage | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const status = logStatus(o, now, group)
  const shippingState = shipping?.get(o.id) ?? null
  const isShipped = shipping?.has(o.id) ?? false
  const displayStatus = orderLogDisplayStatus(status, isShipped, shippingState?.delivered_at != null)
  const total = orderTotal(o)
  // GBP is VAT-inclusive unless the order books VAT-free — an explicit
  // 'export' treatment OR an 'auto' treatment with a VAT-free destination
  // (Channel Islands). Same helper the invoice path uses.
  const isVatInclusive = o.currency === 'GBP' && !isGbpOrderVatFree(o.vat_treatment, o.ship_dest_country)

  // Heavy per-order fields + the reminder ledger, fetched when the panel
  // opens. A failed read must not masquerade as empty data — extras stays
  // null and the sections show a retry line instead of "nothing on file".
  useEffect(() => {
    let cancelled = false
    async function load() {
      const [heavyRes, nudgesRes] = await Promise.all([
        supabase
          .from('orders')
          .select('ship_to_address, person_quantities, order_spec_snapshot, handoff_error')
          .eq('id', o.id)
          .maybeSingle(),
        supabase
          .from('order_nudges')
          .select('reminder_no, source, state, outcome, created_at')
          .in('order_id', [o.id])
          .order('created_at', { ascending: true }),
      ])
      if (cancelled) return
      if (heavyRes.error || nudgesRes.error) {
        console.error('[order-log] detail fetch failed', heavyRes.error ?? nudgesRes.error)
        setDetailError(true)
        return
      }
      setDetailError(false)
      const h = heavyRes.data as Omit<DetailExtras, 'forId'> | null
      setExtras({
        forId: o.id,
        ship_to_address: h?.ship_to_address ?? null,
        person_quantities: h?.person_quantities ?? null,
        order_spec_snapshot: h?.order_spec_snapshot ?? null,
        handoff_error: h?.handoff_error ?? null,
      })
      setReminders(((nudgesRes.data ?? []) as Reminder[]).filter((r) => r.state === 'sent'))
    }
    void load()
    return () => { cancelled = true }
  }, [o.id, retryKey])

  // The order's artwork — the same version-resolution rule as the place-order
  // review screen: prefer the version in the ORDER's material (a proof can
  // carry orders in two materials), then narrow to the ordered finish.
  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const { data: vRows, error: vErr } = await supabase
          .from('proof_versions')
          .select('id, material_id, is_current, version_number, material_options')
          .eq('proof_id', o.proof_id)
          .order('version_number', { ascending: false })
        if (cancelled) return
        if (vErr) throw vErr
        const vers = (vRows ?? []) as { id: string; material_id: string | null; is_current: boolean; material_options: string[] | null }[]
        const matches = o.material_id ? vers.filter((v) => v.material_id === o.material_id) : []
        const scopedVersion = matches.find((v) => v.is_current) ?? matches[0] ?? vers.find((v) => v.is_current) ?? null
        const invoked = await supabase.functions.invoke<{ images: GridImage[] }>('customer-proof-images', {
          body: { proofId: o.proof_id },
        })
        if (cancelled) return
        if (invoked.error) throw invoked.error
        const nonQr = (invoked.data?.images ?? []).filter((img) => img.is_qr_code !== true)
        const scoped = scopedVersion
          ? nonQr.filter((img) => (img as unknown as { proof_version_id?: string }).proof_version_id === scopedVersion.id)
          : []
        const versionImages = scoped.length > 0 ? scoped : nonQr
        const versionOptionCodes = Array.isArray(scopedVersion?.material_options) ? scopedVersion.material_options : []
        let finishCode: string | null = null
        let finishLabel: string | null = null
        if (versionOptionCodes.length > 0 && o.material_option_id) {
          const { data: optRow } = await supabase
            .from('material_options')
            .select('code, display_name')
            .eq('id', o.material_option_id)
            .maybeSingle()
          if (cancelled) return
          const opt = optRow as { code: string | null; display_name: string | null } | null
          finishCode = opt?.code ?? null
          finishLabel = opt?.display_name ?? opt?.code ?? null
        }
        const finishScope = scopeToOrderedFinish(versionImages, versionOptionCodes, finishCode)
        const gallery = finishScope.images.filter((g) => g.signed_url)
        const hasNames = gallery.some((g) => g.associated_name)
        const hasBack = gallery.some((g) => g.side === 'back')
        const labelled = gallery.map((g) => ({
          id: g.id,
          url: g.signed_url,
          label: [
            hasNames ? (g.associated_name ?? 'Shared') : '',
            hasBack ? (g.side === 'back' ? 'Back' : 'Front') : '',
          ].filter(Boolean).join(' · '),
        }))
        if (!cancelled) {
          setArtworkError(false)
          setArtwork(labelled)
          setArtworkNote(
            finishScope.outcome === 'scoped' && finishLabel
              ? `${finishLabel} finish`
              : finishScopeIsUncertain(finishScope.outcome) && versionOptionCodes.length > 1
                ? `Showing all ${versionOptionCodes.length} proofed finishes — the ordered finish couldn’t be pinned down.`
                : null,
          )
        }
      } catch (err) {
        // A failed load is not "no artwork on file" — leave artwork null so
        // the section offers a retry rather than an untrue empty state.
        console.error('[order-log] artwork load failed', err)
        if (!cancelled) setArtworkError(true)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [o.id, o.proof_id, o.material_id, o.material_option_id, retryKey])

  const timeline = useMemo(
    () =>
      buildOrderTimeline(
        o,
        group
          ? {
              status: group.status,
              expires_at: group.expires_at,
              payment_reference: group.payment_reference,
              pay_link_opened_at: group.pay_link_opened_at,
              invoice_emailed_at: group.invoice_emailed_at,
              confirmation_sent_at: group.confirmation_sent_at,
            }
          : null,
        reminders.map((r) => ({ reminder_no: r.reminder_no, source: r.source, created_at: r.created_at })),
        shippingState,
        now,
      ),
    [o, group, reminders, shippingState, now],
  )

  const copy = useCallback((key: string, text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(key)
      if (copyTimer.current) clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopied(null), 2000)
    })
  }, [])

  const addr = extras?.forId === o.id ? extras.ship_to_address : null
  const addrLines = addr
    ? [addr.line1, addr.line2, [addr.city, addr.postal_code].filter(Boolean).join(' '), addr.region, addr.country]
        .map((s) => (s ?? '').trim())
        .filter(Boolean)
    : []
  const personQuantities = extras?.forId === o.id ? extras.person_quantities ?? [] : []
  const snapshot = extras?.forId === o.id ? extras.order_spec_snapshot : null
  const inkNames = (snapshot?.ink_names ?? []).filter(Boolean)
  const letterpress = snapshot?.letterpress ?? null
  const duty = usTariffDutyBilling(o.order_group_id && group ? group : o)

  const openSpecNotes: string[] = []
  if (o.thickness_open) openSpecNotes.push('thickness')
  if (o.finish_open) openSpecNotes.push('finish')
  if (o.quantity_open) openSpecNotes.push('quantity')

  // Custom quotes swap the goods lines for a single figure but still carry
  // their own discount / shipping / tariff lines — orderTotal() adds those in
  // both branches, so the itemisation must list them in both branches too or
  // the lines wouldn't sum to the total shown.
  const amountRows: { label: string; value: number | null }[] = [
    ...(o.custom_quote_total != null
      ? [{ label: 'Custom quote', value: o.custom_quote_total as number | null }]
      : [
          { label: 'Cards', value: o.amount_cards },
          { label: 'Tooling', value: o.amount_tooling },
          { label: 'Personalisation', value: o.amount_personalisation },
        ]),
    {
      label: 'Discount',
      value: o.amount_card_discount != null && Number(o.amount_card_discount) > 0 ? -Number(o.amount_card_discount) : null,
    },
    { label: 'Shipping', value: o.amount_shipping },
    { label: 'US tariff & customs', value: o.amount_us_tariff != null && Number(o.amount_us_tariff) > 0 ? o.amount_us_tariff : null },
  ]

  const otherOrders = siblings
    .filter((s) => s.id !== o.id && (s.proof_id === o.proof_id || (companyOf(s) != null && companyOf(s) === companyOf(o))))
    .slice(0, 6)

  const createdByName = o.created_by ? designerNames.get(o.created_by) ?? null : null
  const placedByName = o.fulfilled_by ? designerNames.get(o.fulfilled_by) ?? null : null

  return (
    // At lg+ the card caps at the viewport (it sits sticky beside the list):
    // the header stays pinned and the sections scroll inside the card, so a
    // long order reads as a card with its own scroll — never a clipped frame.
    <div className="overflow-hidden rounded-[14px] border border-line bg-surface lg:flex lg:max-h-[calc(100vh-92px)] lg:flex-col">
      {/* Header — pinned at lg+ */}
      <div className="border-b border-line-soft px-4 py-4 sm:px-5 lg:shrink-0">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-[17px] font-semibold text-ink">
              {customerLabel(companyOf(o), contactOf(o))}
            </h2>
            <p className="mt-0.5 truncate text-[13px] text-ink-soft">
              {specOf(o)}
              {kindSuffix(o)}
              {o.quantity != null ? ` · ${o.quantity.toLocaleString()} cards` : ''}
            </p>
            {(contactOf(o) || o.proofs?.contacts?.email) && (
              <p className="mt-0.5 truncate text-[12px] text-ink-mute">
                {contactOf(o)}
                {o.proofs?.contacts?.email && (
                  <>
                    {contactOf(o) ? ' · ' : ''}
                    <a href={`mailto:${o.proofs.contacts.email}`} className="hover:text-ink hover:underline">
                      {o.proofs.contacts.email}
                    </a>
                  </>
                )}
              </p>
            )}
            <button
              type="button"
              onClick={() => copy('ref', o.payment_reference ?? o.id)}
              title="Copy reference"
              className="mt-1 inline-flex items-center gap-1 font-mono text-[11.5px] text-ink-mute hover:text-ink"
            >
              {o.payment_reference ?? o.id}
              {copied === 'ref' ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
            </button>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1.5">
            <Pill colour={displayStatus.pill as PillColour}>{displayStatus.label}</Pill>
            {flag && <Pill colour="out">Flagged · {watchCategoryLabel(flag)}</Pill>}
            {o.order_group_id && <Pill colour="brand">Combined payment</Pill>}
            {o.payment_method === 'offline' && <Pill colour="low">Paid offline</Pill>}
          </div>
        </div>
        <div className="mt-3 flex items-baseline gap-2">
          <span className="font-mono text-[24px] font-semibold tabular-nums leading-none text-ink">
            {total != null ? formatPrice(total, o.currency, 2) : '—'}
          </span>
          <span className="text-[11px] text-ink-mute">
            {total == null
              ? 'No priced parts yet'
              : isVatInclusive
                ? 'Includes VAT'
                : o.currency === 'GBP'
                  ? 'VAT-free (export)'
                  : 'VAT-free'}
          </span>
        </div>
      </div>

      {/* Scrolling body — everything below the pinned header */}
      <div className="lg:min-h-0 lg:flex-1 lg:overflow-y-auto">

      {/* Artwork */}
      <Section title="Artwork">
        {artworkError ? (
          <p className="text-[12.5px] text-ink-mute">
            The artwork couldn’t be loaded.{' '}
            <button type="button" onClick={() => setRetryKey((n) => n + 1)} className="font-medium text-brand hover:underline">
              Try again
            </button>
          </p>
        ) : artwork == null ? (
          <p className="text-[12.5px] text-ink-mute">Loading artwork…</p>
        ) : artwork.length === 0 ? (
          <p className="text-[12.5px] text-ink-mute">No artwork on file for this order’s version.</p>
        ) : (
          <>
            {artworkNote && <p className="mb-2 text-[11.5px] text-ink-mute">{artworkNote}</p>}
            <div className="flex gap-2 overflow-x-auto pb-1">
              {artwork.map((img) => (
                <button
                  key={img.id}
                  type="button"
                  onClick={() => setLightbox(img)}
                  className="shrink-0 rounded-lg border border-line bg-canvas p-1.5 hover:border-[var(--c-brand)]"
                  title={img.label || 'View artwork'}
                >
                  <img src={img.url} alt={img.label || 'Artwork'} className="h-24 w-auto max-w-[160px] rounded object-contain" />
                  {img.label && (
                    <span className="mt-1 block max-w-[160px] truncate text-center text-[10.5px] text-ink-mute">
                      {img.label}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </>
        )}
      </Section>

      {/* Links out */}
      <Section title="Links">
        <div className="flex flex-wrap gap-1.5">
          <LinkChip to={`/proofs/${o.proof_id}`} label="Open project" />
          {/* The customer-facing /p/ page, opened with the designer-preview
              flag so the visit never records as a customer view. */}
          <button type="button" onClick={() => openDesignerPreview(o.proof_id)} className={CHIP_CLASS}>
            Customer view
            <ExternalLink size={12} aria-hidden="true" className="text-ink-dim" />
          </button>
          {o.status === 'paid' && <LinkChip to={`/orders/${o.id}/place`} label="Review & place" />}
          {o.proofs?.helpscout_conversation_url && (
            <LinkChip href={o.proofs.helpscout_conversation_url} label="Help Scout thread" external />
          )}
          {o.dropbox_folder_url && <LinkChip href={o.dropbox_folder_url} label="Dropbox folder" external />}
          {o.xero_invoice_id && (
            <LinkChip href={`https://go.xero.com/app/invoicing/view/${o.xero_invoice_id}`} label="Xero invoice" external />
          )}
          {/* Gone-wrong orders go on the shared Flagged board (lost shipment,
              misprint, quality complaint…) so the resolution is tracked in one
              place. One open card per project — once flagged, link to it. */}
          {flag ? (
            <LinkChip to="/flagged" label="Open Flagged board" />
          ) : (
            <button type="button" onClick={onFlag} className={CHIP_CLASS}>
              <Flag size={13} aria-hidden="true" />
              Flag a problem
            </button>
          )}
          {/* A grouped member's OWN link refuses payment while its group is
              active — never offer it under a combined label. When the group
              row didn't load, disable rather than silently mislabel. */}
          {o.order_group_id ? (
            <button
              type="button"
              disabled={!group}
              onClick={() => group && copy('paylink', customerOrderGroupUrl(group.id, group.token))}
              title={
                group
                  ? undefined
                  : groupsFailed
                    ? 'The combined-payment details didn’t load — reload the page.'
                    : 'Combined-payment details are still loading.'
              }
              className={`${CHIP_CLASS} disabled:cursor-not-allowed disabled:opacity-50`}
            >
              {copied === 'paylink' ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
              {group ? 'Copy combined pay link' : 'Combined pay link unavailable'}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => copy('paylink', customerOrderUrl(o.id, o.token))}
              className={CHIP_CLASS}
            >
              {copied === 'paylink' ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
              Copy pay link
            </button>
          )}
        </div>
        {!o.proofs?.helpscout_conversation_url && (
          <p className="mt-2 text-[11.5px] text-ink-mute">No Help Scout conversation linked.</p>
        )}
        {!o.dropbox_folder_url && (
          <p className="mt-1 text-[11.5px] text-ink-mute">No Dropbox folder linked yet.</p>
        )}
      </Section>

      {/* Checkout */}
      <Section title="Checkout">
        {amountRows
          .filter((r) => r.value != null)
          .map((r) => <Row key={r.label} label={r.label} value={formatPrice(Number(r.value), o.currency, 2)} />)}
        <div className="mt-1 border-t border-line-soft pt-1">
          <Row label="Total" value={total != null ? formatPrice(total, o.currency, 2) : '—'} strong />
        </div>
        {o.card_discount_reason && <Row label="Discount reason" value={o.card_discount_reason} />}
        <Row label="Payment" value={o.payment_method === 'offline' ? 'Offline (recorded by hand)' : 'Online — Stripe'} />
        {o.order_group_id && (
          <Row
            label="Combined payment"
            value={group?.payment_reference ?? 'Grouped'}
            hint="One payment covered this and the customer’s other orders; shipping and any US tariff were charged once at group level."
          />
        )}
        {/* The *_open flags are true from creation — before payment they mean
            the choice is still the customer's to make, not that they made it. */}
        {openSpecNotes.length > 0 &&
          (o.paid_at ? (
            <Row label="Customer chose" value={`${openSpecNotes.join(', ')} at checkout`} />
          ) : (
            <Row label="Left open" value={`${openSpecNotes.join(', ')} — the customer chooses at checkout`} />
          ))}
        {(o.names_count ?? 0) > 1 && <Row label="People" value={String(o.names_count)} />}
        {personQuantities.length > 0 && (
          <Row
            label="Per-person split"
            value={personQuantities
              .map((p) => `${p.name ?? '—'} × ${p.quantity != null ? Number(p.quantity).toLocaleString() : '—'}`)
              .join(' · ')}
          />
        )}
        {o.has_personalisation && <Row label="Personalisation" value="Yes" />}
        {inkNames.length > 0 && <Row label="Inks" value={inkNames.join(', ')} />}
        {letterpress && (letterpress.front || letterpress.core || letterpress.back) && (
          <Row
            label="Letterpress"
            value={[
              letterpress.front ? `Front ${letterpress.front}` : null,
              letterpress.core ? `Core ${letterpress.core}` : null,
              letterpress.back ? `Back ${letterpress.back}` : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          />
        )}
        {o.xero_invoice_error && !o.xero_invoice_id && (
          <Row label="Xero invoice" value="Failed — see the Orders page to retry" alert />
        )}
        {createdByName && <Row label="Created by" value={createdByName} />}
      </Section>

      {/* Delivery */}
      <Section title="Delivery">
        {o.ship_to_name || addrLines.length > 0 || o.ship_to_email || o.ship_to_phone ? (
          <>
            {o.ship_to_name && <Row label="Recipient" value={o.ship_to_name} />}
            {addrLines.length > 0 && (
              <Row label="Address" value={<span className="whitespace-pre-line">{addrLines.join('\n')}</span>} />
            )}
            {o.ship_to_phone && <Row label="Phone" value={o.ship_to_phone} />}
            {o.ship_to_email && <Row label="Email" value={o.ship_to_email} />}
          </>
        ) : detailError ? (
          <p className="text-[12.5px] text-ink-mute">
            The full order details couldn’t be loaded.{' '}
            <button type="button" onClick={() => setRetryKey((n) => n + 1)} className="font-medium text-brand hover:underline">
              Try again
            </button>
          </p>
        ) : extras?.forId !== o.id ? (
          <p className="text-[12.5px] text-ink-mute">Loading…</p>
        ) : (
          <p className="text-[12.5px] text-ink-mute">
            {o.paid_at
              ? 'No delivery details on file.'
              : 'Delivery details arrive with payment — the customer fills them in at checkout.'}
          </p>
        )}
        {o.ship_dest_country && (
          <Row
            label="Destination"
            value={`${o.ship_dest_country === 'ZZ' ? 'International (country TBC)' : o.ship_dest_country}${o.ship_dest_postcode ? ` · ${o.ship_dest_postcode}` : ''}`}
          />
        )}
        {o.customs_tax_id && <Row label="VAT / EORI" value={o.customs_tax_id} />}
        {duty && <Row label="US duties" value={duty.action} hint={duty.choice} />}
        {o.date_required && <Row label="Date required" value={fmtDate(o.date_required)} />}
      </Section>

      {/* Production */}
      {(o.stock_order_number || o.supplier_name || o.project_name || o.stock_colour || o.artwork_check_verdict || isShipped || placedByName) && (
        <Section title="Production">
          {o.stock_order_number && (
            <Row
              label="Stock order"
              value={
                <button
                  type="button"
                  onClick={() => copy('stock', o.stock_order_number!)}
                  className="inline-flex items-center gap-1 font-mono hover:text-ink"
                  title="Copy stock order number"
                >
                  #{o.stock_order_number}
                  {copied === 'stock' ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
                </button>
              }
            />
          )}
          {o.project_name && <Row label="Project" value={o.project_name} />}
          {o.material_variants?.materials?.production_route && (
            <Row
              label="Route"
              value={o.material_variants.materials.production_route === 'in_house' ? 'In-house' : 'Supplier'}
            />
          )}
          {o.supplier_name && (
            <Row
              label="Supplier"
              value={`${o.supplier_name}${o.supplier_overs && o.supplier_overs > 0 ? ` · +${o.supplier_overs} spoilage overs` : ''}`}
            />
          )}
          {o.stock_colour && <Row label="Stock colour" value={o.stock_colour} />}
          {o.artwork_check_verdict && (
            <Row
              label="Artwork check"
              value={`${ARTWORK_VERDICT_LABEL[o.artwork_check_verdict] ?? o.artwork_check_verdict}${o.artwork_checked_at ? ` · ${fmtDate(o.artwork_checked_at)}` : ''}`}
              alert={o.artwork_check_verdict === 'defect'}
            />
          )}
          {placedByName && <Row label="Placed by" value={placedByName} />}
          {isShipped && (
            <Row
              label="Dispatch"
              value={
                shippingState?.delivered_at
                  ? `Delivered ${fmtDate(shippingState.delivered_at)}`
                  : shippingState?.shipped_at
                    ? `Shipped ${fmtDate(shippingState.shipped_at)}`
                    : 'Shipped'
              }
            />
          )}
          {!isShipped && isAdmin && shipping != null && (o.status === 'fulfilled') && (
            <Row label="Dispatch" value="Not shipped yet" />
          )}
        </Section>
      )}

      {/* Timeline */}
      <Section title="History" count={timeline.length}>
        {timeline.length === 0 ? (
          <p className="text-[12.5px] text-ink-mute">Nothing recorded yet.</p>
        ) : (
          <ol className="space-y-0">
            {timeline.map((entry, i) => (
              <TimelineRow key={entry.id} entry={entry} isLast={i === timeline.length - 1} />
            ))}
          </ol>
        )}
        {o.status === 'cancelled' && (
          <p className="mt-2 text-[11.5px] text-ink-mute">
            {o.proofs?.status === 'abandoned'
              ? 'This order was closed when the project was abandoned — cancellations aren’t timestamped, so the moment doesn’t appear above.'
              : 'This order was cancelled — cancellations aren’t timestamped, so the moment doesn’t appear above.'}
          </p>
        )}
      </Section>

      {/* Related orders */}
      {otherOrders.length > 0 && (
        <Section title="More from this customer">
          <div className="space-y-1">
            {otherOrders.map((s) => {
              const st = logStatus(s, now, groupFor(s))
              const sTotal = orderTotal(s)
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => onSelect(s.id)}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-canvas"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] text-ink-soft">{specOf(s)}</span>
                    <span className="block font-mono text-[10.5px] text-ink-mute">
                      {s.payment_reference ?? s.id.slice(0, 8)}
                      {s.proof_id === o.proof_id ? ' · same project' : ''}
                    </span>
                  </span>
                  <span className="shrink-0 text-[11px] text-ink-mute">{st.label}</span>
                  <span className="shrink-0 font-mono text-[11.5px] tabular-nums text-ink-soft">
                    {sTotal != null ? formatPrice(sTotal, s.currency) : '—'}
                  </span>
                </button>
              )
            })}
          </div>
        </Section>
      )}

      </div>

      {/* Full-size artwork viewer — portal-based Modal with its own Esc +
          backdrop close, same treatment as OrderReviewPage's lightbox. */}
      <Modal
        open={!!lightbox}
        onClose={() => setLightbox(null)}
        ariaLabel={lightbox?.label || 'Artwork preview'}
        backdropClassName="bg-black/80"
        panelClassName="bg-transparent"
        mobileSheet={false}
      >
        {lightbox && (
          // Explicit viewport-driven sizing: a custom panelClassName REPLACES
          // Modal's default width, so the transparent panel shrink-wraps and
          // a bare max-w-full image would render at its natural pixel size —
          // thumbnail-small on a large screen. Sizing the box and letting
          // object-contain letterbox inside it (invisible on the transparent
          // panel) shows the artwork big regardless of the file's dimensions.
          <img
            src={lightbox.url}
            alt={lightbox.label || 'Artwork'}
            className="rounded-lg object-contain"
            style={{ width: 'min(92vw, 1200px)', maxHeight: 'calc(100dvh - 3rem)' }}
          />
        )}
      </Modal>
    </div>
  )
}

const ARTWORK_VERDICT_LABEL: Record<string, string> = {
  clear: 'All clear',
  flagged: 'Flagged for review',
  defect: 'Defect found',
  error: 'Did not finish',
}

const CHIP_CLASS =
  'inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1 text-[12px] font-medium text-ink-soft hover:bg-canvas hover:text-ink'

function LinkChip({
  to,
  href,
  label,
  external = false,
}: {
  to?: string
  href?: string
  label: string
  external?: boolean
}) {
  if (to) {
    return (
      <Link to={to} className={CHIP_CLASS}>
        {label}
        <ExternalLink size={12} aria-hidden="true" className="text-ink-dim" />
      </Link>
    )
  }
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={CHIP_CLASS}>
      {label}
      {external && <ExternalLink size={12} aria-hidden="true" className="text-ink-dim" />}
    </a>
  )
}

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <div className="border-b border-line-soft px-4 py-3.5 last:border-b-0 sm:px-5">
      <h3 className="eyebrow">
        {title}
        {count != null && count > 0 && <span className="ml-1.5 font-mono text-ink-dim">({String(count).padStart(2, '0')})</span>}
      </h3>
      <div className="mt-2.5">{children}</div>
    </div>
  )
}

function Row({
  label,
  value,
  hint,
  strong = false,
  alert = false,
}: {
  label: string
  value: ReactNode
  hint?: string
  strong?: boolean
  alert?: boolean
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-[3px]">
      <span className="shrink-0 text-[12px] text-ink-mute">{label}</span>
      <span className="min-w-0 text-right">
        <span
          className={[
            'block break-words text-[12.5px]',
            strong ? 'font-semibold text-ink' : alert ? 'font-medium text-out' : 'text-ink-soft',
          ].join(' ')}
        >
          {value}
        </span>
        {hint && <span className="block text-[10.5px] text-ink-dim">{hint}</span>}
      </span>
    </div>
  )
}

// ── Timeline rendering ───────────────────────────────────────────────────────

const TIMELINE_VISUAL: Record<OrderTimelineEntryType, { icon: typeof FilePlus2; tint: string }> = {
  created: { icon: FilePlus2, tint: tokens.brand },
  link_opened: { icon: Eye, tint: tokens.allocated },
  reminder_sent: { icon: BellRing, tint: tokens.low },
  help_requested: { icon: LifeBuoy, tint: tokens.low },
  resend_requested: { icon: RefreshCw, tint: tokens.low },
  link_expired: { icon: Hourglass, tint: tokens.out },
  paid: { icon: CreditCard, tint: tokens.inStock },
  invoice_emailed: { icon: Mail, tint: tokens.inkMute },
  confirmation_sent: { icon: MessageSquare, tint: tokens.inkMute },
  revision_started: { icon: Undo2, tint: tokens.out },
  artwork_checked: { icon: FileSearch, tint: tokens.allocated },
  placed: { icon: Factory, tint: tokens.allocated },
  handoff: { icon: Send, tint: tokens.allocated },
  supplier_emailed: { icon: Send, tint: tokens.allocated },
  production_note: { icon: StickyNote, tint: tokens.inkMute },
  shipped: { icon: Truck, tint: tokens.inStock },
  delivered: { icon: PackageCheck, tint: tokens.inStock },
}

function TimelineRow({ entry, isLast }: { entry: OrderTimelineEntry; isLast: boolean }) {
  const visual = TIMELINE_VISUAL[entry.type]
  const Icon = visual.icon
  return (
    <li className="relative flex gap-3 pb-3 last:pb-0">
      {!isLast && (
        <span aria-hidden="true" className="absolute left-[15px] top-8 bottom-0 w-px bg-line-soft" />
      )}
      <span
        aria-hidden="true"
        className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md"
        style={{ backgroundColor: `color-mix(in srgb, ${visual.tint} 14%, transparent)`, color: visual.tint }}
      >
        <Icon size={15} />
      </span>
      <div className="min-w-0 flex-1 pt-1">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[12.5px] font-medium text-ink">{entry.label}</span>
          {/* The real timestamp is the visible stamp (Rob's ask); the
              relative read stays underneath for at-a-glance scanning. */}
          <span className="shrink-0 text-right">
            <span className="block font-mono text-[10.5px] tabular-nums text-ink-mute">
              {formatAbsoluteDateTime(entry.at)}
            </span>
            <span className="block text-[10px] text-ink-dim">{relativeTime(entry.at)}</span>
          </span>
        </div>
        {entry.detail && <p className="mt-0.5 text-[11.5px] leading-snug text-ink-mute">{entry.detail}</p>}
      </div>
    </li>
  )
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}
