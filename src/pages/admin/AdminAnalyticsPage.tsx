import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  TrendingUp,
  Flame,
  Users,
  Boxes,
  ExternalLink,
} from 'lucide-react'
import { supabase } from '../../lib/supabase'
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

type Tab = 'funnel' | 'hot' | 'team' | 'products'

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
function daysAgoLabel(days: number): string {
  if (days < 1) return 'today'
  if (days < 2) return '1 day ago'
  return `${Math.round(days)} days ago`
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

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoading(true)
      setError(null)
      try {
        const [f, w, d, sMat, sCur, sShape, sRec, sRet, h] = await Promise.all([
          supabase.rpc('analytics_funnel'),
          supabase.rpc('analytics_weekly'),
          supabase.rpc('analytics_by_designer'),
          supabase.rpc('analytics_by_segment', { p_dimension: 'material' }),
          supabase.rpc('analytics_by_segment', { p_dimension: 'currency' }),
          supabase.rpc('analytics_by_segment', { p_dimension: 'shape' }),
          supabase.rpc('analytics_by_segment', { p_dimension: 'recipients' }),
          supabase.rpc('analytics_by_segment', { p_dimension: 'returning' }),
          supabase.rpc('analytics_hot_leads'),
        ])
        const firstErr = [f, w, d, sMat, sCur, sShape, sRec, sRet, h].find((r) => r.error)?.error
        if (firstErr) throw firstErr
        if (cancelled) return
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
          {tab === 'funnel' && funnel && <FunnelSection funnel={funnel} weekly={weekly} />}
          {tab === 'hot' && <HotLeadsSection leads={hotLeads} />}
          {tab === 'team' && <TeamSection rows={designers} />}
          {tab === 'products' && <ProductsSection segments={segments} />}
        </>
      )}
    </div>
  )
}

// ── 1. Funnel & trend ────────────────────────────────────────────────────────
function FunnelSection({ funnel, weekly }: { funnel: Funnel; weekly: WeekRow[] }) {
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

const thCls = 'px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-ink-dim'
