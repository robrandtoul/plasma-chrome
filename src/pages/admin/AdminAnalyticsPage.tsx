import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { Link } from 'react-router-dom'
import {
  TrendingUp,
  Flame,
  Users,
  Boxes,
  ExternalLink,
  MessageSquare,
  ShieldCheck,
  Coins,
  MapPin,
  CheckCircle2,
  RotateCcw,
} from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { designerColourCss } from '../../lib/designerColours'
import {
  PRICING_CHECKED_ON,
  estimateRunCost,
  fmtGbp,
  fmtUsd,
  totalSpend,
} from '../../lib/aiModelPricing'
import { currencyToGbp, getExchangeRates, type ExchangeRates } from '../../lib/exchangeRates'
import { PanelShell, Pill, type PillColour } from '../../design'

// Admin → Analytics. Conversion insight for the enquiry→sale funnel, built on
// the read-only RPCs from migration 000276. Four sections:
//   1. Funnel & trend   — where enquiries leak, and the weekly approval-rate line
//   2. Hot leads        — the live "viewed, no decision" worklist to chase today
//   3. Team             — per-designer conversion, maturity-controlled
//   4. Products         — conversion by material / currency / shape / recipients
//
// "Won" is a paid order (per the brief), but proof Approved is the leading signal
// and is shown alongside, because the order/checkout layer is only days old.

// ── Types (PostgREST returns numerics as strings; we coerce with num()) ──────
interface Funnel {
  total_proofs: number
  viewed: number
  decided: number
  approved: number
  abandoned: number
  in_progress: number
  dormant: number
  order_sent: number
  order_paid: number
  viewed_no_decision: number
  median_days_to_approve: number | null
  returning_n: number
  returning_approved: number
  new_n: number
  new_approved: number
  cr_proofs: number
  cr_recovered: number
  payment_mode: string | null
}
interface WeekRow {
  week_start: string
  enquiries: number
  viewed: number
  approved: number
  abandoned: number
  in_progress: number
  paid: number
  approve_pct: number | string
  mature: boolean
}
interface DesignerRow {
  designer_user_id: string | null
  designer_name: string | null
  designer_initials: string | null
  designer_colour: string | null
  proofs_all: number
  approved_all: number
  abandoned_all: number
  open_now: number
  returning_share_pct: number | string | null
  new_mature_n: number
  new_mature_approved: number
  new_mature_pct: number | string | null
  cr_n: number
  cr_recovered: number
  cr_recovery_pct: number | string | null
  avg_days_to_approve: number | string | null
}
interface SegmentRow {
  label: string
  n: number
  approved: number
  abandoned: number
  approve_pct: number | string
}
interface HotLead {
  proof_id: string
  company_name: string | null
  contact_name: string | null
  contact_email: string | null
  designer_user_id: string | null
  designer_name: string | null
  designer_initials: string | null
  designer_colour: string | null
  current_version_number: number | null
  view_count: number
  last_viewed_at: string | null
  created_at: string
  age_days: number | string
  days_since_view: number | string | null
  nudges_sent: number
  reengaged: boolean
  is_returning: boolean
  helpscout_conversation_url: string | null
  tier: 'hot' | 'reengaged' | 'stale' | 'warm'
}

interface LossReason {
  reason_code: string
  n: number
  latest_at: string | null
}

// ── Artwork checks (migrations 000357/000358) ────────────────────────────────
// Usage reporting for the pre-print / pre-send artwork sanity check. One RPC,
// one json object; every count comes from the run ledger, so a re-run is a run
// and an errored run still counts as usage.
type CheckSource = 'designer' | 'auto_page' | 'auto_folder_link' | 'service' | 'unknown'

interface CheckVerdictCounts {
  clear: number
  flagged: number
  defect: number
  error: number
}
interface CheckTotals extends CheckVerdictCounts {
  runs: number
  reruns: number
  manual_runs: number
  auto_runs: number
  people: number
  orders_checked: number
  versions_checked: number
  flags_found: number
  defects_found: number
  runs_with_findings: number
}
interface CheckKindRow extends CheckVerdictCounts {
  kind: 'order' | 'proof'
  runs: number
  manual_runs: number
  flags_found: number
  defects_found: number
}
interface CheckSourceRow extends CheckVerdictCounts {
  source: CheckSource
  runs: number
}
interface CheckPersonRow extends CheckVerdictCounts {
  ran_by: string | null
  name: string | null
  initials: string | null
  colour: string | null
  manual_runs: number
  auto_page_runs: number
  order_runs: number
  proof_runs: number
  last_run_at: string | null
}
interface CheckWeekRow extends CheckVerdictCounts {
  week_start: string
  runs: number
  manual_runs: number
}
// Per-day runs (migration 000363). Unlike `weekly`, this series is zero-filled
// server-side: every calendar day in the window is present, so a quiet day is a
// visible gap rather than a day the chart silently skips over. Optional on the
// type so the tab still renders against a database without 000363 applied.
interface CheckDayRow extends CheckVerdictCounts {
  day: string
  runs: number
  manual_runs: number
}
// Did a flagged check change what the designer did next? (migration 000359)
// Bands come back null when no stamped decision falls in them.
interface CheckBand {
  decisions: number
  edited: number
}
interface CheckResponseStats {
  days: number
  flagged: CheckBand | null
  clear: CheckBand | null
  no_check: CheckBand | null
  order_exits: { total: number; after_findings: number }
  stamped_decisions: number
}

// One priceable bucket per (gate, model) — split by model because rates
// differ per model, and by gate so the two checks can be costed separately.
interface SpendBucket {
  kind: 'order' | 'proof'
  model: string
  runs: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
}

// Advisory tick-off feedback (migration 000385 + PR #637). Windowed by each
// tick's own timestamp, not the run's — ticking an old report today is
// today's feedback. "incorrect" ("the check misread it") is the load-bearing
// category: it's the over-flagging signal that tunes the check's rules.
interface CheckAckReasonCounts {
  fixed: number
  intentional: number
  incorrect: number
}
interface CheckAckStats {
  ticked_total: number
  reports_with_ticks: number
  by_reason: CheckAckReasonCounts
  misread_by_field: { field: string; count: number }[]
  recent_misread: { at: string; kind: 'order' | 'proof'; field: string; printed: string; supplied: string; card: string }[]
}

interface ArtworkCheckStats {
  days: number
  since: string
  spend?: SpendBucket[]
  totals: CheckTotals
  by_kind: CheckKindRow[]
  by_source: CheckSourceRow[]
  by_person: CheckPersonRow[]
  weekly: CheckWeekRow[]
  daily?: CheckDayRow[]
  // Absent until 000385 is applied — the panel hides itself.
  acks?: CheckAckStats
  // `from` is the effective start: the later of the window edge and the first
  // pre-send check ever run, so versions that predate the feature don't sit in
  // the denominator making uptake look worse than it is.
  proof_adoption: { from: string | null; versions_created: number; versions_checked: number }
  cost: {
    input_tokens: number
    output_tokens: number
    cache_read_tokens: number
    cache_write_tokens: number
    models: { model: string; runs: number }[]
  }
}

// ── Proof annotations (migrations 000347/000362) ─────────────────────────────
// Usage reporting for coordinate-anchored notes on a proof image. The two
// halves — designer callouts written for the customer, and customer pins placed
// alongside a change request — are separate acts by separate people and are
// never averaged into one "annotations used" figure.
interface AnnotationSideTotals {
  notes: number
  versions: number
  proofs: number
  last_at: string | null
}
interface CalloutTotals extends AnnotationSideTotals {
  designers: number
}
interface PinTotals extends AnnotationSideTotals {
  change_requests: number
}
interface AnnotationPersonRow {
  created_by: string | null
  name: string | null
  initials: string | null
  colour: string | null
  notes: number
  versions: number
  proofs: number
  last_at: string | null
}
interface AnnotationWeekRow {
  week_start: string
  callouts: number
  pins: number
  proofs: number
}
interface AnnotationStats {
  days: number
  since: string
  gates: { callouts_enabled: boolean; pins_enabled: boolean }
  callouts: CalloutTotals
  pins: PinTotals
  // `from` on both adoption blocks is the effective start: the later of the
  // window edge and the first time that half was used. Work predating the
  // feature could never have used it, so counting it would permanently
  // understate uptake (the 4%-vs-29% trap from the artwork-check tab).
  callout_adoption: { from: string | null; versions_created: number; versions_with_callout: number }
  pin_adoption: {
    from: string | null
    change_requests: number
    change_requests_with_pins: number
    pins_on_those: number
  }
  follow_through: { pins: number; resolved: number; median_hours_to_resolve: number | string | null }
  by_person: AnnotationPersonRow[]
  weekly: AnnotationWeekRow[]
}

// ── Re-engagement (migration 000389) ─────────────────────────────────────────
// Usage reporting for the Reorder desk — outreach to past customers built from
// Xero history. The register counts every customer on the desk's books by
// pipeline state; the outreach block measures what the window's contacts did
// next. Number-ish fields typed number | string per the file's num() convention.
interface ReengRegister {
  total: number
  pending: number
  in_build: number
  contacted: number
  converted: number
  declined: number
  closed_no_response: number
  suppressed: number
}
interface ReengPaidValue {
  currency: string
  orders: number
  total: number | string
}
interface ReengOutreach {
  contacted_in_window: number
  opened: number
  approved: number
  paid: number
  paid_value: ReengPaidValue[]
}
interface ReengWeekRow {
  week_start: string
  contacted: number
  opened: number
  approved: number
  paid: number
}
interface ReengagementStats {
  window_days: number
  register: ReengRegister
  outreach: ReengOutreach
  weekly: ReengWeekRow[]
}

const LOSS_LABELS: Record<string, string> = {
  price_too_high: 'Price too high',
  different_direction: 'Wanted a different direction',
  timing: 'Timing not right',
  going_elsewhere: 'Went elsewhere / not needed',
  still_thinking: 'Still thinking',
}

type Tab = 'funnel' | 'hot' | 'team' | 'products' | 'checks' | 'annotations' | 'reengagement'

const num = (v: number | string | null | undefined): number => {
  if (v == null) return 0
  const n = typeof v === 'string' ? parseFloat(v) : v
  return Number.isFinite(n) ? n : 0
}
const pct = (part: number, whole: number): number => (whole > 0 ? (100 * part) / whole : 0)
const fmtPct = (v: number): string => `${v.toFixed(v < 10 ? 1 : 0)}%`

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
}
// Weekday included: on a chart of days, "Sat" is half the explanation for why
// a bar is empty, and the axis only has room for "26 Jul".
function fmtLongDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
}
function daysAgoLabel(days: number): string {
  if (days < 1) return 'today'
  if (days < 2) return '1 day ago'
  return `${Math.round(days)} days ago`
}

// ── Pay-link conversion ──────────────────────────────────────────────────────
// Moved here from the Orders page header. Same arithmetic it used there, so the
// figure doesn't change meaning in the move: paid ÷ links sent, plus the median
// gap between sending a link and being paid.

const DAY_MS = 24 * 60 * 60 * 1000

interface PayLinkRow {
  sent_at: string | null
  paid_at: string | null
}

interface PayLinkStat {
  sent: number
  paid: number
  medianDays: number | null
}

// Median of a numeric list (even length → mean of the two middles). Null when empty.
function median(xs: number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

export function summarisePayLinks(rows: PayLinkRow[]): PayLinkStat {
  const sent = rows.filter((r) => r.sent_at).length
  const paid = rows.filter((r) => r.paid_at).length
  const durations = rows
    .filter((r) => r.sent_at && r.paid_at)
    .map((r) => new Date(r.paid_at!).getTime() - new Date(r.sent_at!).getTime())
    // Guard against clock skew / bad data producing a negative or NaN gap,
    // which would drag the median somewhere impossible.
    .filter((ms) => Number.isFinite(ms) && ms >= 0)
  const med = median(durations)
  return { sent, paid, medianDays: med != null ? med / DAY_MS : null }
}

// Human label for a time-to-pay measured in days.
function payDurationLabel(days: number): string {
  if (days < 1) return 'a day'
  const n = Math.round(days)
  return `${n} day${n === 1 ? '' : 's'}`
}

export default function AdminAnalyticsPage() {
  const [tab, setTab] = useState<Tab>('funnel')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [funnel, setFunnel] = useState<Funnel | null>(null)
  const [weekly, setWeekly] = useState<WeekRow[]>([])
  const [designers, setDesigners] = useState<DesignerRow[]>([])
  const [segments, setSegments] = useState<Record<string, SegmentRow[]>>({})
  const [hotLeads, setHotLeads] = useState<HotLead[]>([])
  const [lossReasons, setLossReasons] = useState<LossReason[]>([])
  // Pay-link conversion, moved here from the top of the Orders page — a work
  // queue is the wrong home for a since-launch trend, and this is where the
  // rest of the funnel figures live. Deliberately NOT the same figure as the
  // "Paid rate" tile: that one is paid ÷ every proof, this one is paid ÷ links
  // actually sent, which is what tells you whether the pay page converts.
  // Read straight from `orders` rather than analytics_funnel() because the
  // median time-to-pay isn't in that RPC and adding it would need a migration.
  const [payLinks, setPayLinks] = useState<PayLinkStat | null>(null)

  // Artwork-check usage. Its own fetch, not part of the Promise.all below, for
  // two reasons: the window is user-adjustable (so it refetches on its own),
  // and a missing 000358 must degrade to one explanatory panel rather than
  // taking the whole Analytics page down with it.
  const [checkDays, setCheckDays] = useState(30)
  const [checkStats, setCheckStats] = useState<ArtworkCheckStats | null>(null)
  const [checkError, setCheckError] = useState<string | null>(null)
  const [checkLoading, setCheckLoading] = useState(true)

  const [checkResponse, setCheckResponse] = useState<CheckResponseStats | null>(null)

  // Annotation usage. Same shape of isolation as the artwork-check fetch above,
  // and for the same reasons: its own adjustable window, and a missing 000362
  // must degrade to one explanatory panel rather than taking the page down.
  const [annDays, setAnnDays] = useState(30)
  const [annStats, setAnnStats] = useState<AnnotationStats | null>(null)
  const [annError, setAnnError] = useState<string | null>(null)
  const [annLoading, setAnnLoading] = useState(true)

  // Re-engagement (the Reorder desk, migration 000389). Same isolation again:
  // its own adjustable window, and a missing 000389 must degrade to one
  // explanatory panel rather than taking the page down.
  const [reengDays, setReengDays] = useState(90)
  const [reengStats, setReengStats] = useState<ReengagementStats | null>(null)
  const [reengError, setReengError] = useState<string | null>(null)
  const [reengLoading, setReengLoading] = useState(true)

  // Anthropic bills in USD; this converts for a familiar second figure only.
  // Null simply hides the pound line — the dollar figure is the real one.
  const [fxRates, setFxRates] = useState<ExchangeRates | null>(null)
  useEffect(() => {
    let cancelled = false
    void getExchangeRates()
      .then((r) => { if (!cancelled) setFxRates(r) })
      .catch(() => { /* pounds line stays hidden */ })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let cancelled = false
    setCheckLoading(true)
    void (async () => {
      const [usage, response] = await Promise.all([
        supabase.rpc('analytics_artwork_check', { p_days: checkDays }),
        supabase.rpc('analytics_check_response', { p_days: checkDays }),
      ])
      if (cancelled) return
      if (usage.error) {
        setCheckError(usage.error.message)
        setCheckStats(null)
      } else {
        setCheckError(null)
        setCheckStats(usage.data as ArtworkCheckStats)
      }
      // The response panel is additive — a missing 000359 hides that one panel
      // rather than failing the whole tab.
      setCheckResponse(response.error ? null : (response.data as CheckResponseStats))
      setCheckLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [checkDays])

  useEffect(() => {
    let cancelled = false
    setAnnLoading(true)
    void (async () => {
      const { data, error: rpcErr } = await supabase.rpc('analytics_annotations', { p_days: annDays })
      if (cancelled) return
      if (rpcErr) {
        setAnnError(rpcErr.message)
        setAnnStats(null)
      } else {
        setAnnError(null)
        setAnnStats(data as AnnotationStats)
      }
      setAnnLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [annDays])

  useEffect(() => {
    let cancelled = false
    setReengLoading(true)
    void (async () => {
      const { data, error: rpcErr } = await supabase.rpc('analytics_reengagement', { p_days: reengDays })
      if (cancelled) return
      if (rpcErr) {
        setReengError(rpcErr.message)
        setReengStats(null)
      } else {
        setReengError(null)
        setReengStats(data as ReengagementStats)
      }
      setReengLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [reengDays])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoading(true)
      setError(null)
      try {
        const [f, w, d, sMat, sCur, sShape, sRec, sRet, h, lr] = await Promise.all([
          supabase.rpc('analytics_funnel'),
          supabase.rpc('analytics_weekly'),
          supabase.rpc('analytics_by_designer'),
          supabase.rpc('analytics_by_segment', { p_dimension: 'material' }),
          supabase.rpc('analytics_by_segment', { p_dimension: 'currency' }),
          supabase.rpc('analytics_by_segment', { p_dimension: 'shape' }),
          supabase.rpc('analytics_by_segment', { p_dimension: 'recipients' }),
          supabase.rpc('analytics_by_segment', { p_dimension: 'returning' }),
          supabase.rpc('analytics_hot_leads'),
          supabase.rpc('analytics_loss_reasons'),
        ])
        const firstErr = [f, w, d, sMat, sCur, sShape, sRec, sRet, h, lr].find((r) => r.error)?.error
        if (firstErr) throw firstErr
        if (cancelled) return
        // Separate read, and deliberately not inside the Promise.all above: a
        // failure here must leave the rest of the page working, so it sets null
        // (the line simply doesn't render) instead of throwing to the catch.
        const { data: linkRows, error: linkErr } = await supabase
          .from('orders')
          .select('sent_at, paid_at')
          .not('sent_at', 'is', null)
        if (!cancelled) setPayLinks(linkErr ? null : summarisePayLinks((linkRows ?? []) as PayLinkRow[]))
        setFunnel(f.data as Funnel)
        setWeekly((w.data ?? []) as WeekRow[])
        setDesigners((d.data ?? []) as DesignerRow[])
        setSegments({
          returning: (sRet.data ?? []) as SegmentRow[],
          material: (sMat.data ?? []) as SegmentRow[],
          currency: (sCur.data ?? []) as SegmentRow[],
          shape: (sShape.data ?? []) as SegmentRow[],
          recipients: (sRec.data ?? []) as SegmentRow[],
        })
        setHotLeads((h.data ?? []) as HotLead[])
        setLossReasons((lr.data ?? []) as LossReason[])
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const TABS: { id: Tab; label: string; icon: typeof TrendingUp }[] = [
    { id: 'funnel', label: 'Funnel & trend', icon: TrendingUp },
    { id: 'hot', label: 'Hot leads', icon: Flame },
    { id: 'team', label: 'Team', icon: Users },
    { id: 'products', label: 'Products', icon: Boxes },
    { id: 'checks', label: 'Artwork checks', icon: ShieldCheck },
    { id: 'annotations', label: 'Annotations', icon: MapPin },
    { id: 'reengagement', label: 'Re-engagement', icon: RotateCcw },
  ]

  return (
    <div>
      <div className="mb-4">
        <h2 className="text-xl font-bold text-ink">Analytics</h2>
        <p className="mt-1 text-sm text-ink-mute">
          How qualified enquiries become sales — where they leak, who converts, and what sells.
        </p>
      </div>

      {/* Tab strip */}
      <div className="mb-5 flex gap-1 overflow-x-auto border-b border-line">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={[
              'inline-flex items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors',
              tab === id
                ? 'border-[var(--c-brand)] text-ink font-medium'
                : 'border-transparent text-ink-mute hover:text-ink',
            ].join(' ')}
          >
            <Icon size={15} aria-hidden="true" />
            {label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex justify-center py-20">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-line border-t-gray-900" />
        </div>
      ) : error ? (
        <div className="rounded-2xl bg-out-soft p-6 text-sm text-out ring-1 ring-out">
          Failed to load analytics: {error}
          <p className="mt-2 text-ink-mute">
            If this says a function does not exist, migrations <code>000276</code>/<code>000277</code> haven’t been applied yet.
          </p>
        </div>
      ) : (
        <>
          {tab === 'funnel' && funnel && (
            <FunnelSection funnel={funnel} weekly={weekly} lossReasons={lossReasons} payLinks={payLinks} />
          )}
          {tab === 'hot' && <HotLeadsSection leads={hotLeads} />}
          {tab === 'team' && <TeamSection rows={designers} />}
          {tab === 'products' && <ProductsSection segments={segments} />}
          {tab === 'checks' && (
            <ArtworkChecksSection
              stats={checkStats}
              response={checkResponse}
              fxRates={fxRates}
              loading={checkLoading}
              error={checkError}
              days={checkDays}
              onDaysChange={setCheckDays}
            />
          )}
          {tab === 'annotations' && (
            <AnnotationsSection
              stats={annStats}
              loading={annLoading}
              error={annError}
              days={annDays}
              onDaysChange={setAnnDays}
            />
          )}
          {tab === 'reengagement' && (
            <ReengagementSection
              stats={reengStats}
              loading={reengLoading}
              error={reengError}
              days={reengDays}
              onDaysChange={setReengDays}
            />
          )}
        </>
      )}
    </div>
  )
}

// ── 1. Funnel & trend ────────────────────────────────────────────────────────
function FunnelSection({
  funnel,
  weekly,
  lossReasons,
  payLinks,
}: {
  funnel: Funnel
  weekly: WeekRow[]
  lossReasons: LossReason[]
  payLinks: PayLinkStat | null
}) {
  const total = funnel.total_proofs || 1
  const stages: { key: string; label: string; value: number; colour: string; note?: string }[] = [
    { key: 'enq', label: 'Qualified enquiries (proofs)', value: funnel.total_proofs, colour: 'var(--c-ink-mute)' },
    { key: 'view', label: 'Opened by customer', value: funnel.viewed, colour: 'var(--c-allocated)' },
    { key: 'appr', label: 'Approved', value: funnel.approved, colour: 'var(--c-in-stock)' },
    { key: 'sent', label: 'Order sent', value: funnel.order_sent, colour: 'var(--c-in-stock)' },
    { key: 'paid', label: 'Paid (won)', value: funnel.order_paid, colour: 'var(--c-in-stock)' },
  ]
  const approvalRate = pct(funnel.approved, total)
  const paidRate = pct(funnel.order_paid, total)
  const leakRate = pct(funnel.viewed_no_decision, total)
  const isLive = (funnel.payment_mode ?? '').toLowerCase() === 'live'
  const returningRate = pct(funnel.returning_approved, funnel.returning_n)
  const newRate = pct(funnel.new_approved, funnel.new_n)
  const recoveryRate = pct(funnel.cr_recovered, funnel.cr_proofs)

  return (
    <div className="space-y-5">
      {/* Headline tiles */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Enquiries" value={String(funnel.total_proofs)} sub="qualified → proof" />
        <StatTile label="Approval rate" value={fmtPct(approvalRate)} sub={`${funnel.approved} approved`} accent="var(--c-in-stock)" />
        <StatTile
          label="Paid rate"
          value={fmtPct(paidRate)}
          sub={isLive ? `${funnel.order_paid} paid` : `${funnel.order_paid} paid · test mode`}
          accent="var(--c-in-stock)"
        />
        <StatTile
          label="Median time to approve"
          value={funnel.median_days_to_approve != null ? `${num(funnel.median_days_to_approve)}d` : '—'}
          sub="when it converts"
        />
      </div>

      {/* Pay-link conversion. Its old home was the top of the Orders page,
          where a since-launch trend competed with the day's work; the Orders
          page now spends that line on what needs doing instead. Distinct from
          the "Paid rate" tile above — that divides by every proof, this divides
          by links actually sent, so it isolates how well the pay page itself
          converts. Renders nothing if the read failed or no link has gone out. */}
      {payLinks && payLinks.sent > 0 && (
        <p className="text-[13px] text-ink-soft">
          <span className="font-semibold text-ink">Pay links:</span>{' '}
          {fmtPct(pct(payLinks.paid, payLinks.sent))} paid
          {payLinks.medianDays != null ? `, usually within ${payDurationLabel(payLinks.medianDays)}` : ''} · from{' '}
          {payLinks.sent} link{payLinks.sent === 1 ? '' : 's'} sent since launch
          {payLinks.sent < 10 ? ' · still early days' : ''}
        </p>
      )}

      {/* The leak callout */}
      <div className="rounded-xl bg-out-soft px-4 py-3 text-sm ring-1 ring-out">
        <span className="font-semibold text-out">
          {funnel.viewed_no_decision} enquiries ({fmtPct(leakRate)}) were opened but never decided.
        </span>{' '}
        <span className="text-ink-soft">
          This is the biggest leak — customers see the proof and go quiet. The Hot leads tab lists the ones worth chasing.
        </span>
      </div>

      {/* Returning vs new + change-request recovery — the two cuts the
          designer-disparity analysis surfaced. Returning uses only the durable
          `repeat customer` tag; recovery isolates handling from lead quality. */}
      <div className="grid gap-3 sm:grid-cols-2">
        <PanelShell title="Returning vs new" eyebrow="Conversion by customer type" icon={Users} accent="var(--c-in-stock)">
          <TwoBar
            a={{ label: 'Returning', pct: returningRate, n: funnel.returning_n, approved: funnel.returning_approved, colour: 'var(--c-in-stock)' }}
            b={{ label: 'New', pct: newRate, n: funnel.new_n, approved: funnel.new_approved, colour: 'var(--c-allocated)' }}
          />
          <p className="mt-2 text-xs text-ink-mute">
            Returning = the durable <code>repeat customer</code> tag (the only tag safe for conversion analysis).
          </p>
        </PanelShell>
        <PanelShell title="Change-request recovery" eyebrow="Handling, not lead quality" icon={TrendingUp} accent="var(--c-brand)">
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-bold text-ink">{fmtPct(recoveryRate)}</span>
            <span className="text-sm text-ink-mute">{funnel.cr_recovered} of {funnel.cr_proofs} won back</span>
          </div>
          <p className="mt-2 text-xs text-ink-mute">
            Of customers who requested changes, the share later approved — the clearest read on how well revisions land.
          </p>
        </PanelShell>
      </div>

      {/* Funnel bars */}
      <PanelShell title="Conversion funnel" eyebrow="Whole period" icon={TrendingUp} accent="var(--c-brand)">
        <div className="space-y-2.5">
          {stages.map((s) => {
            const widthPct = Math.max(2, (s.value / total) * 100)
            const ofTotal = pct(s.value, total)
            return (
              <div key={s.key} className="flex items-center gap-3">
                <div className="w-48 shrink-0 text-sm text-ink-soft">{s.label}</div>
                <div className="relative h-7 flex-1 overflow-hidden rounded-md bg-canvas ring-1 ring-line-soft">
                  <div
                    className="flex h-full items-center rounded-md px-2"
                    style={{ width: `${widthPct}%`, backgroundColor: s.colour, minWidth: 36 }}
                  >
                    <span className="text-xs font-semibold" style={{ color: 'var(--c-on-ink)' }}>
                      {s.value}
                    </span>
                  </div>
                </div>
                <div className="w-12 shrink-0 text-right text-xs text-ink-mute">{fmtPct(ofTotal)}</div>
              </div>
            )
          })}
        </div>
        {!isLive && (
          <p className="mt-3 text-xs text-ink-mute">
            Payment mode is not <code>live</code> yet, so the “Paid” stage reflects test orders.
          </p>
        )}
        <p className="mt-3 border-t border-line-soft pt-3 text-xs text-ink-mute">
          Note: only <em>qualified</em> Help Scout enquiries become proofs, so the true top of the funnel
          (all enquiries received) sits upstream and isn’t measured here yet.
        </p>
      </PanelShell>

      {/* Weekly trend */}
      <PanelShell title="Approval rate by week" eyebrow="Cohort by enquiry date" icon={TrendingUp} accent="var(--c-allocated)">
        <WeeklyChart rows={weekly} />
        <p className="mt-3 text-xs text-ink-mute">
          Bars = enquiries that week · line = % approved so far. Greyed bars are recent weeks still
          maturing (approvals land at a ~1-day median, so the latest week always reads low at first).
        </p>
      </PanelShell>

      {/* Why we lose — customer-stated decline reasons (the learning loop). */}
      <PanelShell title="Why we lose" eyebrow="Customer-stated decline reasons" icon={MessageSquare} accent="var(--c-out)">
        <LossReasons rows={lossReasons} />
      </PanelShell>
    </div>
  )
}

function WeeklyChart({ rows }: { rows: WeekRow[] }) {
  if (rows.length === 0) return <p className="text-sm text-ink-mute">No data yet.</p>
  const W = Math.max(rows.length * 90, 320)
  const H = 220
  const padL = 8
  const padR = 8
  const padTop = 16
  const padBot = 28
  const chartH = H - padTop - padBot
  const colW = (W - padL - padR) / rows.length
  const maxEnq = Math.max(...rows.map((r) => r.enquiries), 1)
  const barW = Math.min(colW * 0.5, 46)

  const points = rows.map((r, i) => {
    const x = padL + colW * i + colW / 2
    const y = padTop + chartH * (1 - num(r.approve_pct) / 100)
    return { x, y, r }
  })
  const linePath = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(' ')

  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="Approval rate by week" style={{ maxWidth: W }}>
        {/* gridlines at 0/25/50/75/100% */}
        {[0, 25, 50, 75, 100].map((g) => {
          const y = padTop + chartH * (1 - g / 100)
          return (
            <g key={g}>
              <line x1={padL} y1={y} x2={W - padR} y2={y} stroke="var(--c-line-soft)" strokeWidth={1} />
              <text x={W - padR} y={y - 2} fontSize={9} textAnchor="end" fill="var(--c-ink-dim)">
                {g}%
              </text>
            </g>
          )
        })}
        {/* volume bars */}
        {rows.map((r, i) => {
          const x = padL + colW * i + (colW - barW) / 2
          const h = (r.enquiries / maxEnq) * chartH
          const y = padTop + chartH - h
          return (
            <g key={r.week_start}>
              <rect
                x={x}
                y={y}
                width={barW}
                height={h}
                rx={3}
                fill="var(--c-allocated)"
                opacity={r.mature ? 0.22 : 0.1}
                stroke={r.mature ? 'none' : 'var(--c-line)'}
                strokeDasharray={r.mature ? undefined : '3 2'}
              />
              <text x={x + barW / 2} y={padTop + chartH + 12} fontSize={9} textAnchor="middle" fill="var(--c-ink-mute)">
                {fmtDate(r.week_start)}
              </text>
              <text x={x + barW / 2} y={padTop + chartH + 22} fontSize={8} textAnchor="middle" fill="var(--c-ink-dim)">
                {r.enquiries}
              </text>
            </g>
          )
        })}
        {/* approval-rate line */}
        <path d={linePath} fill="none" stroke="var(--c-in-stock)" strokeWidth={2} />
        {points.map((p) => (
          <g key={p.r.week_start}>
            <circle cx={p.x} cy={p.y} r={3.5} fill="var(--c-in-stock)" opacity={p.r.mature ? 1 : 0.4} />
            <text x={p.x} y={p.y - 7} fontSize={9} textAnchor="middle" fill="var(--c-ink-soft)" fontWeight={600}>
              {fmtPct(num(p.r.approve_pct))}
            </text>
          </g>
        ))}
      </svg>
    </div>
  )
}

// ── 2. Hot leads ─────────────────────────────────────────────────────────────
const TIER_PILL: Record<HotLead['tier'], { colour: PillColour; label: string }> = {
  hot: { colour: 'out', label: 'Hot · 3+ views' },
  reengaged: { colour: 'allocated', label: 'Re-engaged' },
  stale: { colour: 'mute', label: 'Stale >7d' },
  warm: { colour: 'low', label: 'Warm' },
}

function HotLeadsSection({ leads }: { leads: HotLead[] }) {
  const [filter, setFilter] = useState<'all' | HotLead['tier']>('all')
  const counts = useMemo(() => {
    const c = { all: leads.length, hot: 0, reengaged: 0, stale: 0, warm: 0 }
    for (const l of leads) c[l.tier]++
    return c
  }, [leads])
  const shown = filter === 'all' ? leads : leads.filter((l) => l.tier === filter)

  const chips: { id: 'all' | HotLead['tier']; label: string }[] = [
    { id: 'all', label: `All (${counts.all})` },
    { id: 'hot', label: `Hot 3+ views (${counts.hot})` },
    { id: 'reengaged', label: `Re-engaged (${counts.reengaged})` },
    { id: 'stale', label: `Stale (${counts.stale})` },
    { id: 'warm', label: `Warm (${counts.warm})` },
  ]

  return (
    <PanelShell
      title="Hot leads to chase"
      eyebrow="Opened, no decision, not snoozed"
      icon={Flame}
      accent="var(--c-out)"
      count={leads.length}
    >
      <p className="mb-3 text-sm text-ink-mute">
        In-progress proofs the customer has opened but not approved or requested changes. Repeat views are a
        buying signal — start at the top. A personal reply or call within a day or two converts best.
      </p>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {chips.map((c) => (
          <button
            key={c.id}
            onClick={() => setFilter(c.id)}
            className={[
              'rounded-full px-3 py-1 text-xs ring-1 transition-colors',
              filter === c.id
                ? 'bg-ink text-[var(--c-on-ink)] ring-ink'
                : 'text-ink-mute ring-line hover:bg-canvas hover:text-ink',
            ].join(' ')}
          >
            {c.label}
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <p className="py-8 text-center text-sm text-ink-dim">Nothing here — nice.</p>
      ) : (
        <div className="table-scroll overflow-y-hidden rounded-xl ring-1 ring-line">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line-soft bg-canvas">
                <th className={thCls}>Customer</th>
                <th className={thCls}>Designer</th>
                <th className={`${thCls} text-right`}>Views</th>
                <th className={thCls}>Last viewed</th>
                <th className={thCls}>Age</th>
                <th className={`${thCls} text-right`}>Reminders</th>
                <th className={thCls}>Tier</th>
                <th className={thCls}></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((l) => {
                const tp = TIER_PILL[l.tier]
                return (
                  <tr key={l.proof_id} className="border-b border-line-soft last:border-0 hover:bg-canvas">
                    <td className="px-3 py-2.5">
                      <div className="font-medium text-ink">
                        {l.company_name || l.contact_name || 'Unknown'}
                      </div>
                      {l.company_name && l.contact_name && (
                        <div className="text-xs text-ink-dim">{l.contact_name}</div>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-ink-soft">{l.designer_name ?? '—'}</td>
                    <td className="px-3 py-2.5 text-right font-semibold text-ink">{l.view_count}</td>
                    <td className="px-3 py-2.5 text-ink-mute">
                      {l.days_since_view != null ? daysAgoLabel(num(l.days_since_view)) : '—'}
                    </td>
                    <td className="px-3 py-2.5 text-ink-mute">{Math.round(num(l.age_days))}d</td>
                    <td className="px-3 py-2.5 text-right text-ink-mute">{l.nudges_sent}</td>
                    <td className="px-3 py-2.5">
                      <Pill colour={tp.colour}>{tp.label}</Pill>
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      <Link
                        to={`/proofs/${l.proof_id}`}
                        className="text-brand hover:underline"
                        title="Open proof"
                      >
                        Open
                      </Link>
                      {l.helpscout_conversation_url && (
                        <a
                          href={l.helpscout_conversation_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="ml-2 inline-flex items-center gap-0.5 text-ink-mute hover:text-ink"
                          title="Open Help Scout thread"
                        >
                          HS <ExternalLink size={11} />
                        </a>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </PanelShell>
  )
}

// ── 3. Team ──────────────────────────────────────────────────────────────────
function TeamSection({ rows }: { rows: DesignerRow[] }) {
  return (
    <PanelShell title="Conversion by designer" eyebrow="Controlled — not a league table" icon={Users} accent="var(--c-allocated)">
      <p className="mb-3 text-sm text-ink-mute">
        Raw approval rate misleads — designers carry different currency, product and returning-customer mixes.
        These columns control for that: <strong>new-customer conversion</strong> counts only new customers on
        proofs older than 7 days, and <strong>change-request recovery</strong> (the share of change requests
        later won back) isolates handling from lead quality. Small samples wobble — read the direction, not the decimal.
      </p>
      <div className="table-scroll overflow-y-hidden rounded-xl ring-1 ring-line">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line-soft bg-canvas">
              <th className={thCls}>Designer</th>
              <th className={`${thCls} text-right`}>Proofs</th>
              <th className={`${thCls} text-right`}>Open queue</th>
              <th className={`${thCls} text-right`}>Returning</th>
              <th className={thCls}>New-customer conv. (mature)</th>
              <th className={thCls}>Change-request recovery</th>
              <th className={`${thCls} text-right`}>Avg days</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.designer_user_id ?? r.designer_name ?? Math.random()} className="border-b border-line-soft last:border-0">
                <td className="px-3 py-2.5 font-medium text-ink">{r.designer_name ?? 'Unknown'}</td>
                <td className="px-3 py-2.5 text-right text-ink-soft">{r.proofs_all}</td>
                <td className="px-3 py-2.5 text-right text-ink-soft">{r.open_now}</td>
                <td className="px-3 py-2.5 text-right text-ink-mute">
                  {r.returning_share_pct != null ? `${num(r.returning_share_pct)}%` : '—'}
                </td>
                <td className="px-3 py-2.5">
                  <RateBar pct={r.new_mature_pct != null ? num(r.new_mature_pct) : null} sample={`${r.new_mature_approved}/${r.new_mature_n}`} colour="var(--c-in-stock)" />
                </td>
                <td className="px-3 py-2.5">
                  <RateBar pct={r.cr_recovery_pct != null ? num(r.cr_recovery_pct) : null} sample={`${r.cr_recovered}/${r.cr_n}`} colour="var(--c-brand)" />
                </td>
                <td className="px-3 py-2.5 text-right text-ink-mute">
                  {r.avg_days_to_approve != null ? `${num(r.avg_days_to_approve)}d` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </PanelShell>
  )
}

// ── 4. Products ──────────────────────────────────────────────────────────────
const SEGMENT_PANELS: { key: string; title: string }[] = [
  { key: 'returning', title: 'By returning vs new' },
  { key: 'material', title: 'By material' },
  { key: 'recipients', title: 'By recipients' },
  { key: 'shape', title: 'By proof type' },
  { key: 'currency', title: 'By currency' },
]

function ProductsSection({ segments }: { segments: Record<string, SegmentRow[]> }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {SEGMENT_PANELS.map((panel) => (
        <PanelShell key={panel.key} title={panel.title} icon={Boxes} accent="var(--c-brand)">
          <SegmentTable rows={segments[panel.key] ?? []} />
        </PanelShell>
      ))}
      <p className="text-xs text-ink-mute lg:col-span-2">
        Rows with fewer than 8 proofs are greyed — the sample is too small to read much into. Segments come from
        structured fields (material, currency, proof type, recipients) plus the durable <code>repeat customer</code>
        tag; lifecycle tags (priority, ready-to-order) are deliberately excluded — they track funnel stage, not value.
      </p>
    </div>
  )
}

// ── 5. Artwork checks ────────────────────────────────────────────────────────
// How much the artwork sanity check is used, by whom, and how often it finds
// something. Two framing decisions carried through from the SQL:
//   * "Used by" counts only runs a human asked for. The order review page
//     auto-runs on open and the Dropbox-link trigger fires on its own; folding
//     those into a person's total would report footfall, not use.
//   * A flagged run is the tool WORKING. The copy says so, because a "success
//     rate" on a checking tool otherwise reads backwards.
const CHECK_VERDICTS: { key: keyof CheckVerdictCounts; label: string; colour: string }[] = [
  { key: 'clear', label: 'All clear', colour: 'var(--c-in-stock)' },
  { key: 'flagged', label: 'Worth a look', colour: 'var(--c-low)' },
  { key: 'defect', label: 'Likely defect', colour: 'var(--c-out)' },
  { key: 'error', label: "Couldn't run", colour: 'var(--c-ink-dim)' },
]

const CHECK_SOURCE_LABELS: Record<CheckSource, string> = {
  designer: 'Someone clicked Run',
  auto_page: 'Order review page opened',
  auto_folder_link: 'Dropbox folder linked',
  service: 'Scripts / service role',
  unknown: 'Before usage tracking',
}

const CHECK_KIND_LABELS: Record<CheckKindRow['kind'], { title: string; sub: string }> = {
  order: { title: 'Before print', sub: 'Print files vs the customer’s details, at order prep' },
  proof: { title: 'Before sending', sub: 'Proof images vs the thread, before the customer sees it' },
}

function ArtworkChecksSection({
  stats,
  response,
  fxRates,
  loading,
  error,
  days,
  onDaysChange,
}: {
  stats: ArtworkCheckStats | null
  response: CheckResponseStats | null
  fxRates: ExchangeRates | null
  loading: boolean
  error: string | null
  days: number
  onDaysChange: (d: number) => void
}) {
  const ranges = [7, 30, 90]
  // Day vs week for the run-frequency chart. Declared before the early returns
  // below — hooks can't sit after a conditional return.
  const [grain, setGrain] = useState<'day' | 'week'>('day')

  const rangeStrip = (
    <div className="mb-4 flex items-center gap-2">
      <span className="text-xs font-semibold uppercase tracking-wider text-ink-dim">Last</span>
      {ranges.map((r) => (
        <button
          key={r}
          onClick={() => onDaysChange(r)}
          className={[
            'rounded-full px-3 py-1 text-xs transition-colors',
            days === r
              ? 'bg-ink text-surface font-semibold'
              : 'bg-surface text-ink-mute ring-1 ring-line hover:text-ink',
          ].join(' ')}
        >
          {r} days
        </button>
      ))}
    </div>
  )

  if (error) {
    return (
      <div className="rounded-2xl bg-out-soft p-6 text-sm text-out ring-1 ring-out">
        Couldn’t load artwork-check usage: {error}
        <p className="mt-2 text-ink-mute">
          If this says the function does not exist, migrations <code>000357</code>/<code>000358</code> haven’t been
          applied yet.
        </p>
      </div>
    )
  }
  // `!stats.totals` is the belt-and-braces arm: a shape the page doesn't
  // recognise (an older function signature, a stubbed client) must degrade to
  // the spinner-then-empty path rather than throwing on stats.totals.runs and
  // white-screening the whole Analytics page.
  if (loading || !stats || !stats.totals) {
    return (
      <>
        {rangeStrip}
        {loading ? (
          <div className="flex justify-center py-16">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-line border-t-gray-900" />
          </div>
        ) : (
          <PanelShell title="Artwork checks" eyebrow="Usage" icon={ShieldCheck} accent="var(--c-brand)">
            <p className="text-sm text-ink-mute">No artwork-check usage data available yet.</p>
          </PanelShell>
        )}
      </>
    )
  }

  const t = stats.totals
  // Every collection defaulted: the panel must survive a partial payload the
  // same way it survives a missing one.
  const byKind = stats.by_kind ?? []
  const bySource = stats.by_source ?? []
  const byPerson = stats.by_person ?? []
  const weeklyRuns = stats.weekly ?? []
  const dailyRuns = stats.daily ?? []
  // Absent only when 000363 hasn't been applied — the server zero-fills every
  // day in the window, so a genuinely quiet period still returns rows.
  const hasDaily = dailyRuns.length > 0
  const adoption = stats.proof_adoption ?? { from: null, versions_created: 0, versions_checked: 0 }
  const spend = stats.spend ?? []

  const completed = t.runs - t.error
  const foundRate = pct(t.runs_with_findings, completed)
  const clearRate = pct(t.clear, completed)
  const adoptionRate = pct(adoption.versions_checked, adoption.versions_created)

  if (t.runs === 0) {
    return (
      <>
        {rangeStrip}
        <PanelShell title="Artwork checks" eyebrow="Usage" icon={ShieldCheck} accent="var(--c-brand)">
          <p className="text-sm text-ink-mute">
            No checks have run in the last {stats.days} days. Try a longer window, or confirm the check is switched on
            under <Link className="underline" to="/admin/artwork-check">Admin → Artwork check</Link>.
          </p>
        </PanelShell>
      </>
    )
  }

  return (
    <div className="space-y-4">
      {rangeStrip}

      <div className="grid gap-3 grid-cols-2 lg:grid-cols-5">
        <StatTile label="Checks run" value={String(t.runs)} sub={`${t.reruns} were re-runs`} />
        <StatTile
          label="Found something"
          value={fmtPct(foundRate)}
          sub={`${t.runs_with_findings} of ${completed} completed`}
          accent="var(--c-low)"
        />
        <StatTile label="All clear" value={fmtPct(clearRate)} sub={`${t.clear} runs`} accent="var(--c-in-stock)" />
        <StatTile
          label="People using it"
          value={String(t.people)}
          sub={`${t.manual_runs} run by hand`}
          accent="var(--c-brand)"
        />
        <StatTile
          label="Couldn’t run"
          value={String(t.error)}
          sub={t.error > 0 ? 'errors — see below' : 'no failures'}
          accent={t.error > 0 ? 'var(--c-out)' : undefined}
        />
      </div>

      {/* The framing note. Without it "found something" reads as a failure
          rate rather than as the tool earning its keep. */}
      <div className="rounded-xl bg-canvas px-4 py-3 text-sm ring-1 ring-line-soft">
        <span className="font-semibold text-ink">
          {t.flags_found} thing{t.flags_found === 1 ? '' : 's'} raised for a human to check
          {t.defects_found > 0 ? `, ${t.defects_found} of them graded likely defects` : ''}.
        </span>{' '}
        <span className="text-ink-soft">
          A flagged check is the tool doing its job — it’s a catch before print, not a failure. Every verdict stays
          advisory; a person still decides.
        </span>
      </div>

      {/* The two gates, never averaged together — different inputs, different
          base rates, and one is effectively mandatory while the other is a
          button someone chooses to press. */}
      <div className="grid gap-3 sm:grid-cols-2">
        {(['order', 'proof'] as const).map((kind) => {
          const row = byKind.find((k) => k.kind === kind)
          const meta = CHECK_KIND_LABELS[kind]
          return (
            <PanelShell key={kind} title={meta.title} eyebrow={meta.sub} icon={ShieldCheck} accent="var(--c-brand)">
              {row ? (
                <>
                  <div className="flex items-baseline gap-2">
                    <span className="text-3xl font-bold text-ink">{row.runs}</span>
                    <span className="text-sm text-ink-mute">
                      check{row.runs === 1 ? '' : 's'} · {row.manual_runs} run by hand
                    </span>
                  </div>
                  <div className="mt-3">
                    <VerdictBar counts={row} />
                  </div>
                </>
              ) : (
                <p className="text-sm text-ink-mute">None in this window.</p>
              )}
            </PanelShell>
          )
        })}
      </div>

      {response && <CheckResponsePanel response={response} />}

      <PanelShell title="Who runs the checks" eyebrow="Deliberate runs only" icon={Users} accent="var(--c-allocated)">
        <CheckPeopleTable rows={byPerson} />
        <p className="mt-3 text-xs text-ink-mute">
          Counts only checks somebody asked for. The order review page runs one automatically when it’s opened, and the
          Dropbox-link trigger runs one with no one present — those are in “How checks get started” below, never
          credited to a person.
        </p>
      </PanelShell>

      {/* Run frequency gets the full width. It used to share a row, which was
          fine for four weekly bars and hopeless for 30-90 daily ones: the
          chart outgrew the half-width panel and started scrolling, pushing the
          most recent days — the ones you actually came to look at — off the
          right-hand edge by default.

          Defaults to days: weeks answer "is this used at all", days answer
          "what does a normal day look like", which is the question when
          judging whether a spike was one busy afternoon or a fortnight of
          steady work. Falls back to weeks (toggle hidden) when the daily
          series is absent, i.e. 000363 isn't applied yet. */}
        <PanelShell
          title={hasDaily && grain === 'day' ? 'Checks per day' : 'Checks per week'}
          eyebrow="Every run, however triggered"
          icon={TrendingUp}
          accent="var(--c-brand)"
          action={
            hasDaily ? (
              <div className="flex gap-1">
                {(['day', 'week'] as const).map((g) => (
                  <button
                    key={g}
                    onClick={() => setGrain(g)}
                    className={[
                      'rounded-full px-2.5 py-1 text-[11px] transition-colors',
                      grain === g
                        ? 'bg-ink text-surface font-semibold'
                        : 'bg-surface text-ink-mute ring-1 ring-line hover:text-ink',
                    ].join(' ')}
                  >
                    {g === 'day' ? 'Day' : 'Week'}
                  </button>
                ))}
              </div>
            ) : undefined
          }
        >
          {hasDaily && grain === 'day' ? (
            <CheckDailyChart rows={dailyRuns} />
          ) : (
            <CheckWeeklyChart rows={weeklyRuns} />
          )}
        </PanelShell>

        <div className="grid gap-3 lg:grid-cols-2">
          <PanelShell title="How checks get started" eyebrow="Trigger" icon={ShieldCheck} accent="var(--c-ink-mute)">
            <CheckSourceTable rows={bySource} total={t.runs} />
          </PanelShell>

          <PanelShell title="Pre-send check uptake" eyebrow="The optional gate" icon={TrendingUp} accent="var(--c-brand)">
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-bold text-ink">{fmtPct(adoptionRate)}</span>
              <span className="text-sm text-ink-mute">
                {adoption.versions_checked} of {adoption.versions_created} new versions
              </span>
            </div>
            <p className="mt-2 text-xs text-ink-mute">
              The before-print check is effectively compulsory (it auto-runs, and an order can’t be placed without one),
              so its coverage says little. This one is a button a designer chooses to press — which makes it the honest
              measure of whether the team reaches for the feature. Counted from{' '}
              {adoption.from ? fmtDate(adoption.from) : 'the start of the window'}, when the pre-send check was first
              used: versions created before it existed could never have been checked.
            </p>
          </PanelShell>
        </div>

      <CheckSpendPanel spend={spend} fxRates={fxRates} />

      <AdvisoryFeedbackPanel acks={stats.acks} />

      <p className="text-xs text-ink-mute">
        {t.orders_checked} order{t.orders_checked === 1 ? '' : 's'} and {t.versions_checked} proof version
        {t.versions_checked === 1 ? '' : 's'} were checked in this window.
        Runs recorded before usage tracking shipped appear as “Before usage tracking” with no person attached — the
        earlier reports survive, but who ran them was never stored.
      </p>
    </div>
  )
}

// The advisory tick-off feedback (migration 000385 + PR #637) — what happens
// to the advisories the check raises. Each "Mark as addressed" tick records a
// reason, and the reason mix is the check's tuning loop: "the check misread
// it" clustering on a field is an over-flagging pattern for the don't-over-
// flag rules; "fixed in the artwork" is the check earning its keep. Renders
// nothing until 000385 is applied (the RPC payload simply lacks the key).
const ACK_REASON_META: { key: keyof CheckAckReasonCounts; label: string; colour: string }[] = [
  { key: 'fixed', label: 'Fixed in the artwork', colour: 'var(--c-in-stock)' },
  { key: 'intentional', label: 'Intentional — confirmed', colour: 'var(--c-brand)' },
  { key: 'incorrect', label: 'The check misread it', colour: 'var(--c-low)' },
]

function AdvisoryFeedbackPanel({ acks }: { acks: CheckAckStats | undefined }) {
  if (!acks) return null
  const total = acks.ticked_total ?? 0
  const byReason = acks.by_reason ?? { fixed: 0, intentional: 0, incorrect: 0 }
  const misreadFields = acks.misread_by_field ?? []
  const recent = acks.recent_misread ?? []

  return (
    <PanelShell title="Advisory feedback" eyebrow="The tuning loop" icon={ShieldCheck} accent="var(--c-low)">
      {total === 0 ? (
        <p className="text-sm text-ink-mute">
          No advisories have been ticked off in this window. When designers mark advisories as addressed on a report,
          the reasons they pick land here — and “the check misread it” is the signal that tunes the check.
        </p>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-ink-soft">
            <span className="font-semibold text-ink">
              {total} advisor{total === 1 ? 'y' : 'ies'} ticked off
            </span>{' '}
            across {acks.reports_with_ticks} report{acks.reports_with_ticks === 1 ? '' : 's'}. “The check misread it”
            is the tuning signal — a class of advisory that keeps landing there is a candidate for the check’s
            don’t-over-flag rules.
          </p>

          <div>
            <div className="flex h-2.5 overflow-hidden rounded-full ring-1 ring-line-soft" aria-hidden="true">
              {ACK_REASON_META.map((m) =>
                byReason[m.key] > 0 ? (
                  <div key={m.key} style={{ width: `${(byReason[m.key] / total) * 100}%`, backgroundColor: m.colour }} />
                ) : null,
              )}
            </div>
            <div className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-3">
              {ACK_REASON_META.map((m) => (
                <div key={m.key} className="flex items-baseline gap-2 text-sm">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: m.colour }} aria-hidden="true" />
                  <span className="font-semibold tabular-nums text-ink">{byReason[m.key]}</span>
                  <span className="text-ink-mute">{m.label}</span>
                </div>
              ))}
            </div>
          </div>

          {misreadFields.length > 0 && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-ink-dim">Misread most often</p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {misreadFields.map((f) => (
                  <span key={f.field} className="rounded-full bg-canvas px-2.5 py-1 text-xs text-ink ring-1 ring-line-soft">
                    {f.field.replace(/_/g, ' ')} <span className="font-semibold tabular-nums">{f.count}</span>
                  </span>
                ))}
              </div>
              {recent.length > 0 && (
                <ul className="mt-2.5 space-y-1 text-xs text-ink-soft">
                  {recent.slice(0, 6).map((r, i) => (
                    <li key={i} className="break-words">
                      <span className="text-ink-mute">{fmtDate(r.at)}</span>{' '}
                      <span className="font-medium text-ink">{r.field.replace(/_/g, ' ')}</span> — flagged{' '}
                      <span className="font-mono">“{r.printed}”</span>
                      {r.supplied && (
                        <>
                          {' '}vs <span className="font-mono">“{r.supplied}”</span>
                        </>
                      )}
                      , ticked as misread
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </PanelShell>
  )
}

// What the check costs to run.
//
// Priced client-side from src/lib/aiModelPricing.ts rather than in SQL: the
// rates are Anthropic's published price list, they change when Anthropic
// changes them, and a figure that needs a database migration to correct is a
// figure that will sit wrong. Each (gate, model) bucket is priced at its own
// model's rate — a blended token total can't be costed, because output bills
// at 5x input and a cache read at a tenth of it.
const KIND_SPEND_LABELS: Record<SpendBucket['kind'], string> = {
  order: 'Before print',
  proof: 'Before sending',
}

function CheckSpendPanel({
  spend,
  fxRates,
}: {
  spend: SpendBucket[]
  fxRates: ExchangeRates | null
}) {
  // Price against today: promotional rates (Sonnet 5 has one) are date-bound,
  // so a window spanning a rate change is priced at the current rate. Close
  // enough for a spend panel, and stated below rather than left implied.
  const today = new Date().toISOString().slice(0, 10)
  const total = totalSpend(spend, today)
  // Average over the runs that are actually IN the total. Dividing by every
  // run would fold the unpriced ones into the denominator but not the
  // numerator, quietly reporting a cheaper average than the real one.
  const pricedRuns = spend.reduce((sum, b) => sum + (estimateRunCost(b.model, b, today) == null ? 0 : b.runs), 0)
  const perRun = pricedRuns > 0 ? total.usd / pricedRuns : 0
  const gbp = fxRates ? currencyToGbp(total.usd, 'USD', fxRates) : null

  // Roll the (gate, model) buckets up both ways for the two breakdowns.
  const byModel = new Map<string, { runs: number; usd: number | null }>()
  const byKind = new Map<string, { runs: number; usd: number }>()
  for (const b of spend) {
    const cost = estimateRunCost(b.model, b, today)
    const m = byModel.get(b.model) ?? { runs: 0, usd: 0 }
    byModel.set(b.model, {
      runs: m.runs + b.runs,
      usd: cost == null || m.usd == null ? null : m.usd + cost,
    })
    const k = byKind.get(b.kind) ?? { runs: 0, usd: 0 }
    byKind.set(b.kind, { runs: k.runs + b.runs, usd: k.usd + (cost ?? 0) })
  }

  if (spend.length === 0) {
    return (
      <PanelShell title="What it costs" eyebrow="Estimated spend" icon={Coins} accent="var(--c-brand)">
        <p className="text-sm text-ink-mute">No runs to cost in this window.</p>
      </PanelShell>
    )
  }

  return (
    <PanelShell title="What it costs" eyebrow="Estimated spend" icon={Coins} accent="var(--c-brand)">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
        <div>
          <span className="text-3xl font-bold text-ink">{fmtUsd(total.usd)}</span>
          {gbp != null && <span className="ml-2 text-sm text-ink-mute">≈ {fmtGbp(gbp)}</span>}
        </div>
        <div className="text-sm text-ink-mute">
          <span className="font-medium text-ink">{fmtUsd(perRun)}</span> per check on average
        </div>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-dim">By gate</div>
          {(['order', 'proof'] as const).map((kind) => {
            const row = byKind.get(kind)
            if (!row) return null
            return (
              <div key={kind} className="flex items-baseline justify-between gap-3 py-1 text-sm">
                <span className="text-ink-soft">{KIND_SPEND_LABELS[kind]}</span>
                <span className="text-ink">
                  {fmtUsd(row.usd)}{' '}
                  <span className="text-xs text-ink-dim">
                    ({row.runs} run{row.runs === 1 ? '' : 's'})
                  </span>
                </span>
              </div>
            )
          })}
        </div>
        <div>
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-dim">By model</div>
          {[...byModel.entries()]
            .sort((a, b) => b[1].runs - a[1].runs)
            .map(([model, row]) => (
              <div key={model} className="flex items-baseline justify-between gap-3 py-1 text-sm">
                <span className="truncate text-ink-soft" title={model}>{model}</span>
                <span className="text-ink">
                  {row.usd == null ? <span className="text-ink-dim">not priced</span> : fmtUsd(row.usd)}{' '}
                  <span className="text-xs text-ink-dim">
                    ({row.runs} run{row.runs === 1 ? '' : 's'})
                  </span>
                </span>
              </div>
            ))}
        </div>
      </div>

      {total.unpricedModels.length > 0 && (
        <p className="mt-3 rounded-lg bg-canvas px-3 py-2 text-xs text-ink-mute ring-1 ring-line-soft">
          <span className="font-medium text-ink">
            {total.unpricedRuns} run{total.unpricedRuns === 1 ? '' : 's'} could not be costed
          </span>{' '}
          ({total.unpricedModels.join(', ')}) and are excluded from the total rather than counted as free — either the
          model predates the price list here, or the run was recorded before the model was stored.
        </p>
      )}

      <p className="mt-3 text-xs text-ink-mute">
        An estimate, not an invoice. Priced from Anthropic’s published rates as at {fmtDate(PRICING_CHECKED_ON)}, at
        today’s rate for each model — cached input bills at a fraction of fresh input, which is why the cost per check
        is well below what the raw token count suggests. Billing is in US dollars; the pound figure is a live
        conversion. If it disagrees with the invoice, the invoice is right and the rates in{' '}
        <code>aiModelPricing.ts</code> need updating.
      </p>
    </PanelShell>
  )
}

// Does a flag actually change what happens next? The raw count of edits after
// a flag means little on its own — what matters is that rate against the same
// gate when the check was clear, and when no check was consulted at all.
function CheckResponsePanel({ response }: { response: CheckResponseStats }) {
  const rows: { key: string; label: string; band: CheckBand | null; colour: string }[] = [
    { key: 'flagged', label: 'Check flagged something', band: response.flagged, colour: 'var(--c-low)' },
    { key: 'clear', label: 'Check came back clear', band: response.clear, colour: 'var(--c-in-stock)' },
    { key: 'no_check', label: 'No check run', band: response.no_check, colour: 'var(--c-ink-mute)' },
  ]
  const exits = response.order_exits ?? { total: 0, after_findings: 0 }

  return (
    <PanelShell
      title="Did a flag change what happened next?"
      eyebrow="Share of preview-gate decisions that went back to edit"
      icon={ShieldCheck}
      accent="var(--c-low)"
    >
      {response.stamped_decisions === 0 ? (
        <p className="text-sm text-ink-mute">
          Nothing recorded yet. Decisions started carrying the check’s verdict from the moment this shipped, so this
          fills as designers use the preview gate — it deliberately doesn’t count the earlier clicks, whose verdict was
          never stored.
        </p>
      ) : (
        <>
          <div className="space-y-2">
            {rows.map((r) => {
              const decisions = r.band?.decisions ?? 0
              const edited = r.band?.edited ?? 0
              const rate = pct(edited, decisions)
              return (
                <div key={r.key} className="flex items-center gap-3 text-sm">
                  <div className="w-48 shrink-0 text-ink-soft">{r.label}</div>
                  {decisions === 0 ? (
                    <div className="flex-1 text-xs text-ink-dim">none yet</div>
                  ) : (
                    <div className="relative h-6 flex-1 overflow-hidden rounded bg-canvas ring-1 ring-line-soft">
                      <div
                        className="h-full rounded"
                        style={{ width: `${Math.max(2, rate)}%`, backgroundColor: `color-mix(in srgb, ${r.colour} 40%, transparent)` }}
                      />
                      <div className="absolute inset-0 flex items-center justify-between px-2">
                        <span className="text-xs text-ink-mute">
                          {edited}/{decisions} went back
                        </span>
                        <span className="text-xs font-semibold text-ink">{fmtPct(rate)}</span>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          <p className="mt-3 text-xs text-ink-mute">
            “No check run” is the baseline — the same gate and the same designers, with nothing consulted. If the
            flagged rate isn’t clearly higher, the reports are being read and waved through.
          </p>
        </>
      )}

      <div className="mt-3 border-t border-line-soft pt-3 text-xs text-ink-mute">
        {exits.total === 0 ? (
          <>Order side: nobody has left an order review without placing in this window.</>
        ) : (
          <>
            Order side: <span className="font-medium text-ink">{exits.after_findings}</span> of {exits.total} reviewers
            who left without placing did so with a flagged check on screen.
          </>
        )}{' '}
        Counts, not a rate — placements are recorded by the ordering system without the check’s verdict, and someone
        who leaves via the browser’s back button isn’t counted at all.
      </div>
    </PanelShell>
  )
}

// Verdict mix as one stacked bar — four segments that always sum to the run
// count, so the eye compares shape rather than reading four numbers.
function VerdictBar({ counts }: { counts: CheckVerdictCounts }) {
  const total = CHECK_VERDICTS.reduce((sum, v) => sum + counts[v.key], 0)
  if (total === 0) return <p className="text-sm text-ink-mute">No runs.</p>
  return (
    <div>
      <div className="flex h-6 overflow-hidden rounded ring-1 ring-line-soft">
        {CHECK_VERDICTS.map((v) => {
          const n = counts[v.key]
          if (n === 0) return null
          return (
            <div
              key={v.key}
              title={`${v.label}: ${n}`}
              style={{ width: `${(100 * n) / total}%`, backgroundColor: `color-mix(in srgb, ${v.colour} 45%, transparent)` }}
              className="flex items-center justify-center"
            >
              <span className="px-1 text-[11px] font-semibold text-ink">{n}</span>
            </div>
          )
        })}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
        {CHECK_VERDICTS.map((v) => (
          <span key={v.key} className="inline-flex items-center gap-1.5 text-[11px] text-ink-mute">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: v.colour }} />
            {v.label}
          </span>
        ))}
      </div>
    </div>
  )
}

function CheckPeopleTable({ rows }: { rows: CheckPersonRow[] }) {
  const withManual = rows.filter((r) => r.manual_runs > 0)
  if (withManual.length === 0) {
    return (
      <p className="text-sm text-ink-mute">
        Nobody has run a check by hand in this window — every run so far was automatic.
      </p>
    )
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-ink-dim">
            <th className="pb-2 pr-3 font-semibold">Designer</th>
            <th className="pb-2 pr-3 font-semibold">Runs</th>
            <th className="pb-2 pr-3 font-semibold">Before print</th>
            <th className="pb-2 pr-3 font-semibold">Before sending</th>
            <th className="pb-2 pr-3 font-semibold">What they found</th>
            <th className="pb-2 font-semibold">Last run</th>
          </tr>
        </thead>
        <tbody>
          {withManual.map((r) => {
            const found = r.flagged + r.defect
            return (
              <tr key={r.ran_by ?? r.name ?? 'unknown'} className="border-b border-line-soft last:border-0">
                <td className="py-2 pr-3">
                  <span className="inline-flex items-center gap-2">
                    <span
                      className="inline-flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-bold text-white"
                      style={{ backgroundColor: designerColourCss(r.colour) }}
                    >
                      {r.initials ?? '??'}
                    </span>
                    <span className="text-ink">{r.name ?? 'Unknown'}</span>
                  </span>
                </td>
                <td className="py-2 pr-3 font-semibold text-ink">{r.manual_runs}</td>
                <td className="py-2 pr-3 text-ink-soft">{r.order_runs}</td>
                <td className="py-2 pr-3 text-ink-soft">{r.proof_runs}</td>
                <td className="py-2 pr-3 text-ink-soft">
                  {found > 0 ? (
                    // "N found (M likely defects)" — the parenthetical makes it
                    // read as a subset. An earlier "N flagged · M likely
                    // defect" scanned as N+M separate things.
                    <span>
                      {found} found
                      {r.defect > 0 && (
                        <span className="text-out">
                          {' '}
                          ({r.defect} likely defect{r.defect === 1 ? '' : 's'})
                        </span>
                      )}
                    </span>
                  ) : (
                    <span className="text-ink-dim">all clear</span>
                  )}
                </td>
                <td className="py-2 text-ink-mute">{fmtDate(r.last_run_at)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function CheckSourceTable({ rows, total }: { rows: CheckSourceRow[]; total: number }) {
  if (rows.length === 0) return <p className="text-sm text-ink-mute">No runs.</p>
  return (
    <div className="space-y-1.5">
      {rows.map((r) => {
        const share = pct(r.runs, total)
        return (
          <div key={r.source} className="flex items-center gap-3 text-sm">
            <div className="w-44 shrink-0 truncate text-ink-soft" title={CHECK_SOURCE_LABELS[r.source] ?? r.source}>
              {CHECK_SOURCE_LABELS[r.source] ?? r.source}
            </div>
            <div className="relative h-5 flex-1 overflow-hidden rounded bg-canvas ring-1 ring-line-soft">
              <div
                className="h-full rounded"
                style={{
                  width: `${Math.max(2, share)}%`,
                  backgroundColor:
                    r.source === 'designer'
                      ? 'color-mix(in srgb, var(--c-brand) 35%, transparent)'
                      : 'color-mix(in srgb, var(--c-ink-mute) 22%, transparent)',
                }}
              />
              <div className="absolute inset-0 flex items-center justify-between px-2">
                <span className="text-xs text-ink-mute">{r.runs}</span>
                <span className="text-xs font-semibold text-ink">{fmtPct(share)}</span>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// Run volume over time, split clear vs found-something. One component serves
// both grains — the Day/Week toggle swaps the data, not the chart — because
// they were near-identical copies and the axis-collision bug below existed in
// both. Callers map their row shape onto CheckBar.
//
// Geometry notes, all of them things 30-90 bars need and 4 bars don't:
//   * The y-axis labels sit in a LEFT gutter. They used to be right-aligned
//     into the plot area, where they collided with the last bar's own count —
//     on the 30-day view "22" printed straight over the axis "22".
//   * Only every Nth date is labelled on the daily view; at one label per bar
//     they overlap into an unreadable smear.
//   * Per-bar counts are drawn only when bars are wide enough to hold them,
//     and never on zero days — a row of "0"s across a quiet fortnight buries
//     the days that did something.
//   * The chart keeps its natural width and the panel scrolls, rather than
//     squeezing 90 bars into the panel width until they're slivers.
//
// The daily series is zero-filled by the server, so quiet days are real gaps.
interface CheckBar extends CheckVerdictCounts {
  key: string
  label: string
  sublabel?: string
  tooltipTitle: string
  runs: number
  manual_runs: number
}

function CheckRunsChart({ rows, grain }: { rows: CheckBar[]; grain: 'day' | 'week' }) {
  // Before the early return — hooks can't sit after a conditional.
  const [hover, setHover] = useState<number | null>(null)
  if (rows.length === 0) return <p className="text-sm text-ink-mute">No runs yet.</p>

  const week = grain === 'week'
  const H = 190
  const padTop = 14
  const padBot = week ? 34 : 26
  const padL = 30
  const padR = 10
  const chartH = H - padTop - padBot
  // Weekly columns spread to fill the (now full-width) panel rather than
  // sitting at a fixed 70px, which left four bars huddled on the left of a
  // ~950px card. Bounded both ways: never tighter than 70, never so wide that
  // a 4-bar chart becomes four lonely posts.
  const colW = week
    ? Math.max(70, Math.min(160, 900 / rows.length))
    : rows.length > 45
      ? 14
      : rows.length > 20
        ? 30
        : 46
  const W = Math.max(padL + rows.length * colW + padR, 320)
  const maxRuns = Math.max(...rows.map((r) => r.runs), 1)
  const barW = Math.min(colW * (week ? 0.55 : 0.62), week ? 56 : 26)
  const labelEvery = week ? 1 : Math.max(1, Math.ceil(rows.length / 10))
  const showCounts = week || colW >= 22
  const radius = week ? 3 : 2

  const hovered = hover != null ? rows[hover] : null
  const hoverCentre = hover != null ? padL + colW * hover + colW / 2 : 0
  // Percentage of the viewBox, so it tracks the column at any rendered scale.
  const hoverPct = (hoverCentre / W) * 100
  // Anchor flips near the edges. Centre-anchoring the whole way along reads
  // fine until the last few columns, where the tooltip runs past the panel and
  // is clipped by the scroll container — losing the end of the line, which on
  // the right-hand edge is the most recent day, the one most worth reading.
  const tipStyle: CSSProperties =
    hoverPct > 82
      ? { left: '100%', transform: 'translateX(-100%)', top: 2 }
      : hoverPct < 18
        ? { left: 0, top: 2 }
        : { left: `${hoverPct}%`, transform: 'translateX(-50%)', top: 2 }

  return (
    <div className="overflow-x-auto">
      <div className="relative" style={{ minWidth: W }}>
        {/* maxWidth pairs with the wrapper's minWidth deliberately: together
            they pin the rendered width to exactly W, so the viewBox maps 1:1.
            With only one of them an SVG that has a viewBox, a percentage width
            and a fixed height letterboxes — preserveAspectRatio scales the
            content to fit and CENTRES it, leaving dead space at both edges
            where the bars aren't where their coordinates say they are, so
            edge columns stop being hoverable. */}
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          height={H}
          role="img"
          aria-label={`Artwork checks per ${grain}`}
          style={{ maxWidth: W }}
          onMouseLeave={() => setHover(null)}
        >
          {[0, 0.5, 1].map((g) => {
            const y = padTop + chartH * (1 - g)
            return (
              <g key={g}>
                <line x1={padL} y1={y} x2={W - padR} y2={y} stroke="var(--c-line-soft)" strokeWidth={1} />
                <text x={padL - 6} y={y + 3} fontSize={9} textAnchor="end" fill="var(--c-ink-dim)">
                  {Math.round(maxRuns * g)}
                </text>
              </g>
            )
          })}
          {rows.map((r, i) => {
            const colX = padL + colW * i
            const x = colX + (colW - barW) / 2
            const found = r.flagged + r.defect
            const hAll = (r.runs / maxRuns) * chartH
            const hFound = (found / maxRuns) * chartH
            const yAll = padTop + chartH - hAll
            return (
              <g key={r.key}>
                {hover === i && (
                  <rect x={colX} y={padTop} width={colW} height={chartH} fill="var(--c-line-soft)" opacity={0.5} />
                )}
                {/* full run count, with the found-something portion sitting on top */}
                <rect x={x} y={yAll} width={barW} height={hAll} rx={radius} fill="color-mix(in srgb, var(--c-in-stock) 30%, transparent)" />
                <rect
                  x={x}
                  y={padTop + chartH - hFound}
                  width={barW}
                  height={hFound}
                  rx={radius}
                  fill="color-mix(in srgb, var(--c-low) 65%, transparent)"
                />
                {showCounts && (r.runs > 0 || week) && (
                  <text x={x + barW / 2} y={yAll - 4} fontSize={9} textAnchor="middle" fill="var(--c-ink-soft)" fontWeight={600}>
                    {r.runs}
                  </text>
                )}
                {i % labelEvery === 0 && (
                  <text x={x + barW / 2} y={padTop + chartH + 12} fontSize={9} textAnchor="middle" fill="var(--c-ink-mute)">
                    {r.label}
                  </text>
                )}
                {r.sublabel && (
                  <text x={x + barW / 2} y={padTop + chartH + 22} fontSize={8} textAnchor="middle" fill="var(--c-ink-dim)">
                    {r.sublabel}
                  </text>
                )}
                {/* Hit area last so it sits above the bars, and full-column
                    height so a zero day is still hoverable — the quiet days
                    are exactly the ones worth being able to interrogate. */}
                <rect
                  x={colX}
                  y={padTop}
                  width={colW}
                  height={chartH}
                  fill="transparent"
                  onMouseEnter={() => setHover(i)}
                />
              </g>
            )
          })}
        </svg>

        {hovered && (
          <div
            className="pointer-events-none absolute z-10 w-max rounded-lg bg-ink px-2.5 py-1.5 text-[11px] leading-snug text-surface shadow-lg"
            style={tipStyle}
          >
            <div className="font-semibold">{hovered.tooltipTitle}</div>
            <div className="mt-0.5 opacity-90">
              {hovered.runs === 0 ? 'No checks run' : `${hovered.runs} check${hovered.runs === 1 ? '' : 's'}`}
            </div>
            {hovered.runs > 0 && (
              <div className="mt-1 space-y-0.5 opacity-90">
                {hovered.clear > 0 && <div>{hovered.clear} all clear</div>}
                {hovered.flagged > 0 && <div>{hovered.flagged} flagged</div>}
                {hovered.defect > 0 && <div>{hovered.defect} likely {hovered.defect === 1 ? 'defect' : 'defects'}</div>}
                {hovered.error > 0 && <div>{hovered.error} couldn’t run</div>}
                <div className="border-t border-white/20 pt-0.5">
                  {hovered.manual_runs} run by hand
                  {hovered.runs - hovered.manual_runs > 0
                    ? `, ${hovered.runs - hovered.manual_runs} automatic`
                    : ''}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
        <span className="inline-flex items-center gap-1.5 text-[11px] text-ink-mute">
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: 'var(--c-in-stock)' }} />
          Checks run
        </span>
        <span className="inline-flex items-center gap-1.5 text-[11px] text-ink-mute">
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: 'var(--c-low)' }} />
          Found something
        </span>
        <span className="text-[11px] text-ink-dim">
          {grain === 'day'
            ? 'Days with no checks are shown as gaps. Hover a day for the breakdown.'
            : 'Hover a week for the breakdown.'}
        </span>
      </div>
    </div>
  )
}

function CheckDailyChart({ rows }: { rows: CheckDayRow[] }) {
  return (
    <CheckRunsChart
      grain="day"
      rows={rows.map((r) => ({
        ...r,
        key: r.day,
        label: fmtDate(r.day),
        tooltipTitle: fmtLongDate(r.day),
      }))}
    />
  )
}

function CheckWeeklyChart({ rows }: { rows: CheckWeekRow[] }) {
  return (
    <CheckRunsChart
      grain="week"
      rows={rows.map((r) => ({
        ...r,
        key: r.week_start,
        label: fmtDate(r.week_start),
        sublabel: `${r.manual_runs} by hand`,
        tooltipTitle: `Week of ${fmtLongDate(r.week_start)}`,
      }))}
    />
  )
}


// ── 6. Annotations ───────────────────────────────────────────────────────────
// Is anyone using the coordinate-anchored notes? Two independent halves, never
// averaged: designers writing callouts for customers to read, and customers
// pinning a spot instead of describing it in prose. Either can legitimately be
// dark while the other is busy — they are separate gates (000347).
function AnnotationsSection({
  stats,
  loading,
  error,
  days,
  onDaysChange,
}: {
  stats: AnnotationStats | null
  loading: boolean
  error: string | null
  days: number
  onDaysChange: (d: number) => void
}) {
  const ranges = [7, 30, 90]

  const rangeStrip = (
    <div className="mb-4 flex items-center gap-2">
      <span className="text-xs font-semibold uppercase tracking-wider text-ink-dim">Last</span>
      {ranges.map((r) => (
        <button
          key={r}
          onClick={() => onDaysChange(r)}
          className={[
            'rounded-full px-3 py-1 text-xs transition-colors',
            days === r
              ? 'bg-ink text-surface font-semibold'
              : 'bg-surface text-ink-mute ring-1 ring-line hover:text-ink',
          ].join(' ')}
        >
          {r} days
        </button>
      ))}
    </div>
  )

  if (error) {
    return (
      <div className="rounded-2xl bg-out-soft p-6 text-sm text-out ring-1 ring-out">
        Couldn’t load annotation usage: {error}
        <p className="mt-2 text-ink-mute">
          If this says the function does not exist, migration <code>000362</code> hasn’t been applied yet.
        </p>
      </div>
    )
  }
  // Same belt-and-braces arm as the checks tab: an unrecognised shape (older
  // function signature, stubbed client) degrades to the empty path rather than
  // throwing on stats.callouts.notes and white-screening the page.
  if (loading || !stats || !stats.callouts || !stats.pins) {
    return (
      <>
        {rangeStrip}
        {loading ? (
          <div className="flex justify-center py-16">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-line border-t-gray-900" />
          </div>
        ) : (
          <PanelShell title="Annotations" eyebrow="Usage" icon={MapPin} accent="var(--c-brand)">
            <p className="text-sm text-ink-mute">No annotation usage data available yet.</p>
          </PanelShell>
        )}
      </>
    )
  }

  const gates = stats.gates ?? { callouts_enabled: false, pins_enabled: false }
  const c = stats.callouts
  const p = stats.pins
  const byPerson = stats.by_person ?? []
  const weeklyRows = stats.weekly ?? []
  const ca = stats.callout_adoption ?? { from: null, versions_created: 0, versions_with_callout: 0 }
  const pa = stats.pin_adoption ?? { from: null, change_requests: 0, change_requests_with_pins: 0, pins_on_those: 0 }
  const ft = stats.follow_through ?? { pins: 0, resolved: 0, median_hours_to_resolve: null }

  const calloutRate = pct(ca.versions_with_callout, ca.versions_created)
  const pinRate = pct(pa.change_requests_with_pins, pa.change_requests)
  const resolveRate = pct(ft.resolved, ft.pins)
  const pinsPerRequest = pa.change_requests_with_pins > 0 ? pa.pins_on_those / pa.change_requests_with_pins : 0

  // Both switched off is a completely different story from "nobody uses it",
  // and the raw numbers below can't tell them apart.
  if (!gates.callouts_enabled && !gates.pins_enabled) {
    return (
      <>
        {rangeStrip}
        <PanelShell title="Annotations are switched off" eyebrow="Usage" icon={MapPin} accent="var(--c-out)">
          <p className="text-sm text-ink-mute">
            Neither designer callouts nor customer pins are enabled, so there is nothing to measure. Both are
            independent switches under <Link className="underline" to="/admin/settings">Admin → Settings</Link>.
          </p>
        </PanelShell>
      </>
    )
  }

  if (c.notes === 0 && p.notes === 0) {
    return (
      <>
        {rangeStrip}
        <PanelShell title="Annotations" eyebrow="Usage" icon={MapPin} accent="var(--c-brand)">
          <p className="text-sm text-ink-mute">
            No notes have been written in the last {stats.days} days. Try a longer window — and note that callouts are{' '}
            {gates.callouts_enabled ? 'on' : 'off'} and customer pins are {gates.pins_enabled ? 'on' : 'off'} under{' '}
            <Link className="underline" to="/admin/settings">Admin → Settings</Link>.
          </p>
        </PanelShell>
      </>
    )
  }

  return (
    <div className="space-y-4">
      {rangeStrip}

      {/* The two halves, side by side and never combined. Each shows volume,
          the spread it is drawn from, and its own uptake rate. */}
      <div className="grid gap-3 sm:grid-cols-2">
        <PanelShell
          title="Designer callouts"
          eyebrow={gates.callouts_enabled ? 'Notes written for the customer' : 'Switched off'}
          icon={MessageSquare}
          accent="var(--c-brand)"
        >
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-bold text-ink">{c.notes}</span>
            <span className="text-sm text-ink-mute">
              note{c.notes === 1 ? '' : 's'} · {c.designers} designer{c.designers === 1 ? '' : 's'}
            </span>
          </div>
          <p className="mt-1 text-xs text-ink-mute">
            Across {c.versions} version{c.versions === 1 ? '' : 's'} on {c.proofs} project
            {c.proofs === 1 ? '' : 's'}
            {c.last_at ? ` · last on ${fmtDate(c.last_at)}` : ''}
          </p>
          <div className="mt-3 border-t border-line-soft pt-3">
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-bold text-ink">{fmtPct(calloutRate)}</span>
              <span className="text-sm text-ink-mute">of new versions get one</span>
            </div>
            <p className="mt-1 text-xs text-ink-mute">
              {ca.versions_with_callout} of {ca.versions_created} version
              {ca.versions_created === 1 ? '' : 's'} created since{' '}
              {ca.from ? fmtDate(ca.from) : 'the start of the window'}.
            </p>
          </div>
        </PanelShell>

        <PanelShell
          title="Customer pins"
          eyebrow={gates.pins_enabled ? 'Pointing instead of describing' : 'Switched off'}
          icon={MapPin}
          accent="var(--c-allocated)"
        >
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-bold text-ink">{p.notes}</span>
            <span className="text-sm text-ink-mute">
              pin{p.notes === 1 ? '' : 's'} · {p.change_requests} change request
              {p.change_requests === 1 ? '' : 's'}
            </span>
          </div>
          <p className="mt-1 text-xs text-ink-mute">
            Across {p.versions} version{p.versions === 1 ? '' : 's'} on {p.proofs} project
            {p.proofs === 1 ? '' : 's'}
            {p.last_at ? ` · last on ${fmtDate(p.last_at)}` : ''}
          </p>
          <div className="mt-3 border-t border-line-soft pt-3">
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-bold text-ink">{fmtPct(pinRate)}</span>
              <span className="text-sm text-ink-mute">of change requests come with pins</span>
            </div>
            <p className="mt-1 text-xs text-ink-mute">
              {pa.change_requests_with_pins} of {pa.change_requests} request
              {pa.change_requests === 1 ? '' : 's'} since{' '}
              {pa.from ? fmtDate(pa.from) : 'the start of the window'}
              {pa.change_requests_with_pins > 0
                ? ` · ${pinsPerRequest.toFixed(1)} pins each when they do`
                : ''}
              .
            </p>
          </div>
        </PanelShell>
      </div>

      {/* The framing note. Both rates are quoted against work that could
          actually have used the feature, which is not the same as all work —
          and a reader who assumes otherwise will read them as far worse than
          they are. */}
      <div className="rounded-xl bg-canvas px-4 py-3 text-sm ring-1 ring-line-soft">
        <span className="font-semibold text-ink">Both rates count only work that could have used the feature.</span>{' '}
        <span className="text-ink-soft">
          Versions made before callouts existed could never have carried one, and change requests submitted before pins
          existed could never have carried one either — counting them would understate uptake for months. Each rate
          therefore starts at the first time that half was used. The callout rate is a cohort figure about{' '}
          <em>new</em> versions, so it won’t match the raw version count above: a designer usually annotates a version
          that already exists, and those sit outside both sides of the fraction.
        </span>
      </div>

      {/* Concentration. Early on, a handful of notes from one person on one
          test project reads as broad adoption unless the spread is stated. */}
      {c.notes + p.notes > 0 && (c.proofs <= 2 || p.proofs <= 2) && (
        <div className="rounded-xl bg-canvas px-4 py-3 text-sm ring-1 ring-line-soft">
          <span className="font-semibold text-ink">Still concentrated.</span>{' '}
          <span className="text-ink-soft">
            {c.notes} callout{c.notes === 1 ? '' : 's'} on {c.proofs} project{c.proofs === 1 ? '' : 's'}, {p.notes} pin
            {p.notes === 1 ? '' : 's'} on {p.proofs} — few enough that one person trying it out on one job moves every
            figure on this tab. Test fixtures are counted like any other project; nothing is filtered out, because an
            exclusion list baked into a migration goes stale silently and starts hiding real customers.
          </span>
        </div>
      )}

      <div className="grid gap-3 lg:grid-cols-2">
        <PanelShell
          title="Pins ticked off"
          eyebrow="Follow-through"
          icon={CheckCircle2}
          accent={ft.pins > 0 && ft.resolved === 0 ? 'var(--c-low)' : 'var(--c-in-stock)'}
        >
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-bold text-ink">{fmtPct(resolveRate)}</span>
            <span className="text-sm text-ink-mute">
              {ft.resolved} of {ft.pins} pin{ft.pins === 1 ? '' : 's'}
            </span>
          </div>
          {num(ft.median_hours_to_resolve) > 0 && (
            <p className="mt-1 text-sm text-ink-soft">
              Typically ticked off after {resolveDelayLabel(num(ft.median_hours_to_resolve))}.
            </p>
          )}
          <p className="mt-2 text-xs text-ink-mute">
            {ft.pins > 0 && ft.resolved === 0
              ? 'Nobody has ticked a pin off yet. That isn’t necessarily a backlog — the change may well have been made without anyone touching the checkbox — but it does mean the tick-off can’t be trusted as a record of what’s done.'
              : 'Counts customer pins only. A designer’s own callout isn’t a task, so folding it in would invent a permanent backlog nobody was meant to clear.'}
          </p>
        </PanelShell>

        <PanelShell title="Callouts per week" eyebrow="Both halves" icon={TrendingUp} accent="var(--c-brand)">
          <AnnotationWeeklyChart rows={weeklyRows} />
        </PanelShell>
      </div>

      <PanelShell title="Who writes callouts" eyebrow="Designers only" icon={Users} accent="var(--c-allocated)">
        <AnnotationPeopleTable rows={byPerson} />
        <p className="mt-3 text-xs text-ink-mute">
          Customer pins carry the name the customer typed, not a profile, so they can’t be listed here — they’re in the
          Customer pins panel above.
        </p>
      </PanelShell>
    </div>
  )
}

// Hours are the stored unit; neither "0.4 hours" nor "73 hours" reads well.
function resolveDelayLabel(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} minutes`
  if (hours < 48) return `${Math.round(hours)} hour${Math.round(hours) === 1 ? '' : 's'}`
  const d = Math.round(hours / 24)
  return `${d} day${d === 1 ? '' : 's'}`
}

function AnnotationPeopleTable({ rows }: { rows: AnnotationPersonRow[] }) {
  if (rows.length === 0) {
    return <p className="text-sm text-ink-mute">No callouts written in this window.</p>
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line">
            <th className={thCls}>Designer</th>
            <th className={thCls}>Callouts</th>
            <th className={thCls}>Versions</th>
            <th className={thCls}>Projects</th>
            <th className={thCls}>Last one</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.created_by ?? r.name ?? 'unknown'} className="border-b border-line-soft last:border-0">
              <td className="px-3 py-2">
                <span className="inline-flex items-center gap-2">
                  <span
                    className="inline-flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-bold text-white"
                    style={{ backgroundColor: designerColourCss(r.colour) }}
                  >
                    {r.initials ?? '?'}
                  </span>
                  <span className="text-ink">{r.name ?? 'Unknown'}</span>
                </span>
              </td>
              <td className="px-3 py-2 font-semibold text-ink">{r.notes}</td>
              <td className="px-3 py-2 text-ink-soft">{r.versions}</td>
              <td className="px-3 py-2 text-ink-soft">{r.proofs}</td>
              <td className="px-3 py-2 text-ink-mute">{fmtDate(r.last_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function AnnotationWeeklyChart({ rows }: { rows: AnnotationWeekRow[] }) {
  if (rows.length === 0) return <p className="text-sm text-ink-mute">No notes yet.</p>
  // padL is a gutter for the y-axis labels. They used to be right-aligned into
  // the plot area, where the last bar's own count printed straight over them —
  // the same collision fixed on the artwork-check chart.
  const W = Math.max(rows.length * 70, 320)
  const H = 190
  const padL = 30
  const padR = 10
  const padTop = 14
  const padBot = 26
  const chartH = H - padTop - padBot
  const colW = (W - padL - padR) / rows.length
  const maxN = Math.max(...rows.map((r) => Math.max(r.callouts, r.pins)), 1)
  // Two bars per week rather than a stack: these are different people doing
  // different things, and a stack would invite reading the total as one number.
  const barW = Math.min(colW * 0.26, 18)

  return (
    <div className="overflow-x-auto">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        role="img"
        aria-label="Callouts and customer pins per week"
        style={{ maxWidth: W }}
      >
        {[0, 0.5, 1].map((g) => {
          const y = padTop + chartH * (1 - g)
          return (
            <g key={g}>
              <line x1={padL} y1={y} x2={W - padR} y2={y} stroke="var(--c-line-soft)" strokeWidth={1} />
              <text x={padL - 6} y={y + 3} fontSize={9} textAnchor="end" fill="var(--c-ink-dim)">
                {Math.round(maxN * g)}
              </text>
            </g>
          )
        })}
        {rows.map((r, i) => {
          const centre = padL + colW * i + colW / 2
          const hC = (r.callouts / maxN) * chartH
          const hP = (r.pins / maxN) * chartH
          const xC = centre - barW - 2
          const xP = centre + 2
          return (
            <g key={r.week_start}>
              <rect
                x={xC}
                y={padTop + chartH - hC}
                width={barW}
                height={hC}
                rx={3}
                fill="color-mix(in srgb, var(--c-brand) 55%, transparent)"
              />
              <rect
                x={xP}
                y={padTop + chartH - hP}
                width={barW}
                height={hP}
                rx={3}
                fill="color-mix(in srgb, var(--c-allocated) 55%, transparent)"
              />
              {r.callouts > 0 && (
                <text x={xC + barW / 2} y={padTop + chartH - hC - 4} fontSize={9} textAnchor="middle" fill="var(--c-ink-soft)" fontWeight={600}>
                  {r.callouts}
                </text>
              )}
              {r.pins > 0 && (
                <text x={xP + barW / 2} y={padTop + chartH - hP - 4} fontSize={9} textAnchor="middle" fill="var(--c-ink-soft)" fontWeight={600}>
                  {r.pins}
                </text>
              )}
              <text x={centre} y={padTop + chartH + 12} fontSize={9} textAnchor="middle" fill="var(--c-ink-mute)">
                {fmtDate(r.week_start)}
              </text>
              <text x={centre} y={padTop + chartH + 22} fontSize={8} textAnchor="middle" fill="var(--c-ink-dim)">
                {r.proofs} project{r.proofs === 1 ? '' : 's'}
              </text>
            </g>
          )
        })}
      </svg>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
        <span className="inline-flex items-center gap-1.5 text-[11px] text-ink-mute">
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: 'var(--c-brand)' }} />
          Designer callouts
        </span>
        <span className="inline-flex items-center gap-1.5 text-[11px] text-ink-mute">
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: 'var(--c-allocated)' }} />
          Customer pins
        </span>
      </div>
    </div>
  )
}

// ── Re-engagement (the Reorder desk, migration 000389) ───────────────────────
// Isolated like the checks and annotations tabs: its own window, its own
// loading/error state, and a missing migration degrades to one explanatory
// panel rather than taking the whole Analytics page down.

const CURRENCY_SYMBOLS: Record<string, string> = { GBP: '£', EUR: '€', USD: '$' }

function fmtPaidValue(v: ReengPaidValue): string {
  const symbol = CURRENCY_SYMBOLS[v.currency]
  const amount = num(v.total).toLocaleString('en-GB', { maximumFractionDigits: 0 })
  return `${symbol ?? `${v.currency} `}${amount} from ${v.orders} order${v.orders === 1 ? '' : 's'}${symbol ? ` (${v.currency})` : ''}`
}

function ReengagementSection({
  stats,
  loading,
  error,
  days,
  onDaysChange,
}: {
  stats: ReengagementStats | null
  loading: boolean
  error: string | null
  days: number
  onDaysChange: (d: number) => void
}) {
  const ranges = [30, 90, 180]

  const rangeStrip = (
    <div className="mb-4 flex items-center gap-2">
      <span className="text-xs font-semibold uppercase tracking-wider text-ink-dim">Last</span>
      {ranges.map((r) => (
        <button
          key={r}
          onClick={() => onDaysChange(r)}
          className={[
            'rounded-full px-3 py-1 text-xs transition-colors',
            days === r
              ? 'bg-ink text-surface font-semibold'
              : 'bg-surface text-ink-mute ring-1 ring-line hover:text-ink',
          ].join(' ')}
        >
          {r} days
        </button>
      ))}
    </div>
  )

  if (error) {
    return (
      <div className="rounded-2xl bg-out-soft p-6 text-sm text-out ring-1 ring-out">
        Couldn’t load re-engagement figures: {error}
        <p className="mt-2 text-ink-mute">
          If this says the function does not exist, migration <code>000389</code> hasn’t been applied yet.
        </p>
      </div>
    )
  }
  // Same belt-and-braces arm as the other isolated tabs: an unrecognised shape
  // (older function signature, stubbed client) degrades to the empty path
  // rather than throwing on stats.register.total and white-screening the page.
  if (loading || !stats || !stats.register) {
    return (
      <>
        {rangeStrip}
        {loading ? (
          <div className="flex justify-center py-16">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-line border-t-gray-900" />
          </div>
        ) : (
          <PanelShell title="Re-engagement" eyebrow="Reorder desk" icon={RotateCcw} accent="var(--c-brand)">
            <p className="text-sm text-ink-mute">No re-engagement data available yet.</p>
          </PanelShell>
        )}
      </>
    )
  }

  const reg = stats.register
  // Every collection defaulted: the tab must survive a partial payload the
  // same way it survives a missing one.
  const outreach = stats.outreach ?? { contacted_in_window: 0, opened: 0, approved: 0, paid: 0, paid_value: [] }
  const paidValue = stats.outreach?.paid_value ?? []
  const weeklyRows = stats.weekly ?? []
  const inProgress = reg.pending + reg.in_build

  if (reg.total === 0) {
    return (
      <>
        {rangeStrip}
        <PanelShell title="Re-engagement" eyebrow="Reorder desk" icon={RotateCcw} accent="var(--c-brand)">
          <p className="text-sm text-ink-mute">
            The register is empty — the desk hasn’t been seeded yet.
          </p>
        </PanelShell>
      </>
    )
  }

  return (
    <div className="space-y-4">
      {rangeStrip}

      {/* The register (all-time pipeline state) and this window's outreach. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Register size" value={String(reg.total)} sub="past customers on the books" />
        <StatTile label="In progress" value={String(inProgress)} sub={`${reg.pending} pending · ${reg.in_build} in build`} />
        <StatTile
          label="Contacted in window"
          value={String(outreach.contacted_in_window)}
          sub={`${outreach.opened} opened · ${outreach.approved} approved`}
        />
        <StatTile
          label="Converted"
          value={String(reg.converted)}
          sub={`${outreach.paid} paid in this window`}
          accent="var(--c-in-stock)"
        />
      </div>

      {/* Paid value per currency. Renders nothing until an outreach order is
          paid; currencies are never summed into one figure. */}
      {paidValue.length > 0 && (
        <p className="text-[13px] text-ink-soft">
          <span className="font-semibold text-ink">Paid value:</span>{' '}
          {paidValue.map(fmtPaidValue).join(' · ')}
        </p>
      )}

      <PanelShell title="Week by week" eyebrow="Outreach and what came back" icon={TrendingUp} accent="var(--c-brand)">
        {weeklyRows.length === 0 ? (
          <p className="text-sm text-ink-mute">No outreach sent in the last {days} days.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line">
                  <th className={thCls}>Week</th>
                  <th className={thCls}>Contacted</th>
                  <th className={thCls}>Opened</th>
                  <th className={thCls}>Approved</th>
                  <th className={thCls}>Paid</th>
                </tr>
              </thead>
              <tbody>
                {weeklyRows.map((r) => (
                  <tr key={r.week_start} className="border-b border-line-soft last:border-0">
                    <td className="px-3 py-2 text-ink">{fmtDate(r.week_start)}</td>
                    <td className="px-3 py-2 font-semibold text-ink">{r.contacted}</td>
                    <td className="px-3 py-2 text-ink-soft">{r.opened}</td>
                    <td className="px-3 py-2 text-ink-soft">{r.approved}</td>
                    <td className="px-3 py-2 text-ink-soft">{r.paid}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </PanelShell>

      {/* The register's quiet ends, so the tiles above can't be mistaken for
          the whole story. */}
      <p className="text-xs text-ink-mute">
        Also on the register: {reg.declined} declined, {reg.closed_no_response} closed with no response, and{' '}
        {reg.suppressed} suppressed (asked to be left alone, or otherwise off limits).
      </p>
    </div>
  )
}

function SegmentTable({ rows }: { rows: SegmentRow[] }) {
  if (rows.length === 0) return <p className="text-sm text-ink-mute">No data.</p>
  const maxN = Math.max(...rows.map((r) => r.n), 1)
  return (
    <div className="space-y-1.5">
      {rows.map((r) => {
        const small = r.n < 8
        const approvePct = num(r.approve_pct)
        return (
          <div
            key={r.label}
            className={['flex items-center gap-3 text-sm', small ? 'opacity-50' : ''].join(' ')}
          >
            <div className="w-40 shrink-0 truncate text-ink-soft" title={r.label}>
              {r.label}
            </div>
            <div className="relative h-6 flex-1 overflow-hidden rounded bg-canvas ring-1 ring-line-soft">
              <div
                className="h-full rounded"
                style={{
                  width: `${Math.max(2, (r.n / maxN) * 100)}%`,
                  backgroundColor: 'color-mix(in srgb, var(--c-allocated) 30%, transparent)',
                }}
              />
              <div className="absolute inset-0 flex items-center justify-between px-2">
                <span className="text-xs text-ink-mute">{r.n} proofs</span>
                <span className="text-xs font-semibold text-ink">{fmtPct(approvePct)}</span>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── shared bits ──────────────────────────────────────────────────────────────
function StatTile({
  label,
  value,
  sub,
  accent,
}: {
  label: string
  value: string
  sub?: string
  accent?: string
}) {
  return (
    <div className="rounded-xl bg-surface p-3 ring-1 ring-line">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-dim">{label}</div>
      <div className="mt-1 text-2xl font-bold text-ink" style={accent ? { color: accent } : undefined}>
        {value}
      </div>
      {sub && <div className="mt-0.5 text-xs text-ink-mute">{sub}</div>}
    </div>
  )
}

interface TwoBarDatum {
  label: string
  pct: number
  n: number
  approved: number
  colour: string
}

function TwoBar({ a, b }: { a: TwoBarDatum; b: TwoBarDatum }) {
  return (
    <div className="space-y-2">
      {[a, b].map((d) => (
        <div key={d.label} className="flex items-center gap-3 text-sm">
          <div className="w-20 shrink-0 text-ink-soft">{d.label}</div>
          <div className="relative h-6 flex-1 overflow-hidden rounded bg-canvas ring-1 ring-line-soft">
            <div
              className="h-full rounded"
              style={{ width: `${Math.max(2, Math.min(100, d.pct))}%`, backgroundColor: `color-mix(in srgb, ${d.colour} 35%, transparent)` }}
            />
            <div className="absolute inset-0 flex items-center justify-between px-2">
              <span className="text-xs text-ink-mute">{d.approved}/{d.n}</span>
              <span className="text-xs font-semibold text-ink">{fmtPct(d.pct)}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

function RateBar({ pct: ratePct, sample, colour }: { pct: number | null; sample: string; colour: string }) {
  if (ratePct == null) return <span className="text-ink-dim">—</span>
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 w-20 overflow-hidden rounded-full bg-canvas ring-1 ring-line-soft">
        <div className="h-full rounded-full" style={{ width: `${Math.min(100, ratePct)}%`, backgroundColor: colour }} />
      </div>
      <span className="text-xs font-semibold text-ink">{fmtPct(ratePct)}</span>
      <span className="text-[11px] text-ink-dim">{sample}</span>
    </div>
  )
}

function LossReasons({ rows }: { rows: LossReason[] }) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-ink-mute">
        No decline feedback captured yet — this fills in as customers use the “Not ready to approve?” option on proofs.
      </p>
    )
  }
  const total = rows.reduce((s, r) => s + r.n, 0) || 1
  const max = Math.max(...rows.map((r) => r.n), 1)
  return (
    <div className="space-y-1.5">
      {rows.map((r) => (
        <div key={r.reason_code} className="flex items-center gap-3 text-sm">
          <div className="w-44 shrink-0 truncate text-ink-soft">{LOSS_LABELS[r.reason_code] ?? r.reason_code}</div>
          <div className="relative h-6 flex-1 overflow-hidden rounded bg-canvas ring-1 ring-line-soft">
            <div
              className="h-full rounded"
              style={{ width: `${Math.max(2, (r.n / max) * 100)}%`, backgroundColor: 'color-mix(in srgb, var(--c-out) 30%, transparent)' }}
            />
            <div className="absolute inset-0 flex items-center justify-between px-2">
              <span className="text-xs text-ink-mute">{r.n}</span>
              <span className="text-xs font-semibold text-ink">{Math.round((r.n / total) * 100)}%</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

const thCls = 'px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-ink-dim'
