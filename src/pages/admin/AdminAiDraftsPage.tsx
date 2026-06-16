import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { logAudit } from '../../lib/audit'
import { Pill, type PillColour, ButtonInk, ButtonGhost, HelpTip } from '../../design'
import { tagHelp } from '../../lib/tagHelp'
import AdminAiDraftsBriefing from './AdminAiDraftsBriefing'
import AdminAiDraftsProposals from './AdminAiDraftsProposals'

type Tab = 'decisions' | 'briefing' | 'proposals'

// /admin/ai-drafts — the Drafts panel. The off/shadow/live mode control sits at
// the top; below it three tabs:
//   · Decisions — the ledger of recent AI-draft outcomes, cost, per-category
//     acceptance, and the self-refreshing recent-decisions list.
//   · Briefing  — edit the house rules + example replies (DB-backed since
//     migration 000225); takes effect on the next email, no redeploy.
//   · Proposals — the human-in-the-loop approval queue for suggested briefing
//     changes (migration 000226).
// The whole /admin area is RequireAdmin-gated, so this is admin-only.

type Mode = 'off' | 'shadow' | 'live'
type Outcome = 'drafted' | 'abstained' | 'blocked' | 'skipped'
type EditClass = 'sent_as_is' | 'lightly_edited' | 'rewritten' | 'discarded'

interface DraftRow {
  id: string
  created_at: string
  category: string | null
  confidence: string | null
  state: string
  draft_body: string | null
  note_body: string | null
  abstain_or_block_reason: string | null
  summary: string | null
  usage_input: number | null
  usage_output: number | null
  usage_cache_read: number | null
  usage_cache_write: number | null
  usage_triage_input: number | null
  usage_triage_output: number | null
  usage_triage_cache_read: number | null
  usage_triage_cache_write: number | null
  model: string | null
  triage_model: string | null
  edit_class: EditClass | null
  edit_similarity: number | null
  sent_body: string | null
  skip_kind: SkipKind | null
}

// Why a non-customer email was skipped. 'spam' is strictly unsolicited junk;
// 'genuine' never appears on a skipped row but is allowed for safety. null on
// older rows predating this field (and on anything that wasn't skipped).
type SkipKind = 'genuine' | 'spam' | 'supplier' | 'automated_notification' | 'other'

// How a skipped row is shown: proper spam stands out (red); everything else is
// quiet. null/'other'/'genuine' fall back to the plain "skipped" chip.
const SKIP_KIND_META: Record<SkipKind, { label: string; colour: PillColour }> = {
  spam: { label: 'spam', colour: 'out' },
  supplier: { label: 'supplier', colour: 'neutral' },
  automated_notification: { label: 'notification', colour: 'neutral' },
  other: { label: 'skipped', colour: 'neutral' },
  genuine: { label: 'skipped', colour: 'neutral' },
}
function skipKindMeta(k: SkipKind | null): { label: string; colour: PillColour } {
  return k ? SKIP_KIND_META[k] : { label: 'skipped', colour: 'neutral' }
}

// How often the open panel re-fetches itself (silent background refresh).
// At a few drafts a day this is plenty live, and only runs while the tab is
// visible — see the polling effect below.
const POLL_MS = 25_000

// Per-model USD rates per million tokens (from the Claude API pricing
// reference). Cache read is 0.1x input, cache write 1.25x input (5-minute TTL —
// the worker's default). Unknown / older model strings fall back to Opus.
const MODEL_RATES: Record<string, { in: number; out: number }> = {
  'claude-opus-4-8': { in: 5, out: 25 },
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-haiku-4-5-20251001': { in: 1, out: 5 },
  'claude-haiku-4-5': { in: 1, out: 5 },
}
const DEFAULT_RATE = MODEL_RATES['claude-opus-4-8']
const rateFor = (model: string | null | undefined) => (model && MODEL_RATES[model]) || DEFAULT_RATE

function callCostUsd(input: number, output: number, cacheRead: number, cacheWrite: number, rate: { in: number; out: number }): number {
  return (
    (input / 1e6) * rate.in +
    (output / 1e6) * rate.out +
    (cacheRead / 1e6) * rate.in * 0.1 +
    (cacheWrite / 1e6) * rate.in * 1.25
  )
}

// A ledger row's token usage. The usage_* columns are the COMBINED triage+draft
// total; usage_triage_* is the triage call's slice. We price triage at its own
// model's rate and the remainder (combined - triage) at the draft model's, so a
// cheaper triage model shows the real saving. Old rows have null triage columns
// → zero triage tokens → everything priced at the draft model (the old, correct
// behaviour, since triage then ran on the draft model too).
interface TokenUsage {
  usage_input: number | null
  usage_output: number | null
  usage_cache_read: number | null
  usage_cache_write: number | null
  usage_triage_input: number | null
  usage_triage_output: number | null
  usage_triage_cache_read: number | null
  usage_triage_cache_write: number | null
  model: string | null // the draft model for this row
  triage_model: string | null // null = triage ran on the draft model
}
function costFromUsage(u: TokenUsage): number {
  const ti = u.usage_triage_input ?? 0
  const to = u.usage_triage_output ?? 0
  const tcr = u.usage_triage_cache_read ?? 0
  const tcw = u.usage_triage_cache_write ?? 0
  const draftModel = u.model
  const triageModel = u.triage_model ?? draftModel
  // Draft = combined minus triage; clamp at 0 against any data oddity.
  const di = Math.max((u.usage_input ?? 0) - ti, 0)
  const dout = Math.max((u.usage_output ?? 0) - to, 0)
  const dcr = Math.max((u.usage_cache_read ?? 0) - tcr, 0)
  const dcw = Math.max((u.usage_cache_write ?? 0) - tcw, 0)
  return (
    callCostUsd(ti, to, tcr, tcw, rateFor(triageModel)) +
    callCostUsd(di, dout, dcr, dcw, rateFor(draftModel))
  )
}
function rowCostUsd(r: DraftRow): number {
  return costFromUsage(r)
}

// One day of the trend charts. Spend sums EVERY processed email that day
// (classify costs tokens even when the draft is skipped/abstained); matched /
// accepted only count drafts whose reply has since been sent.
interface DayPoint {
  day: string // YYYY-MM-DD, local
  date: Date
  count: number // total emails processed that day (for the hover summary)
  spend: number
  matched: number
  accepted: number
}

// Charts look back further than the 7-day decision list so a trend is visible.
const SERIES_DAYS = 30

// YYYY-MM-DD in the viewer's local time, so day buckets line up with how Rob
// reads the clock (not UTC).
function localDayKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// Bucket raw rows into a contiguous run of the last SERIES_DAYS days (empty
// days included, so the x-axis has no gaps).
type DayAgg = { count: number; spend: number; matched: number; accepted: number }
const emptyAgg = (): DayAgg => ({ count: 0, spend: 0, matched: 0, accepted: 0 })

function buildDailySeries(rows: (TokenUsage & { created_at: string; edit_class: EditClass | null })[]): DayPoint[] {
  const byDay = new Map<string, DayAgg>()
  for (const r of rows) {
    const k = localDayKey(new Date(r.created_at))
    const b = byDay.get(k) ?? emptyAgg()
    b.count++
    b.spend += costFromUsage(r)
    if (r.edit_class) {
      b.matched++
      if (r.edit_class === 'sent_as_is' || r.edit_class === 'lightly_edited') b.accepted++
    }
    byDay.set(k, b)
  }
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const out: DayPoint[] = []
  for (let i = SERIES_DAYS - 1; i >= 0; i--) {
    const d = new Date(today)
    d.setDate(today.getDate() - i)
    const k = localDayKey(d)
    const b = byDay.get(k) ?? emptyAgg()
    out.push({ day: k, date: d, ...b })
  }
  return out
}

// Least-squares fit over (x, y) points → slope + intercept, or null when there
// aren't at least two points (no trend to draw). x is the day index.
function linearFit(pts: { x: number; y: number }[]): { slope: number; intercept: number } | null {
  const n = pts.length
  if (n < 2) return null
  let sx = 0, sy = 0, sxx = 0, sxy = 0
  for (const p of pts) {
    sx += p.x; sy += p.y; sxx += p.x * p.x; sxy += p.x * p.y
  }
  const denom = n * sxx - sx * sx
  if (denom === 0) return null
  const slope = (n * sxy - sx * sy) / denom
  return { slope, intercept: (sy - slope * sx) / n }
}

function outcomeOf(r: DraftRow): Outcome {
  // Live rows carry the real outcome in `state`; shadow rows store 'shadow'
  // for every row, so derive from the draft + reason.
  if (r.state === 'drafted' || r.state === 'abstained' || r.state === 'blocked' || r.state === 'skipped') {
    return r.state
  }
  if (r.draft_body) return r.abstain_or_block_reason ? 'blocked' : 'drafted'
  const reason = (r.abstain_or_block_reason ?? '').toLowerCase()
  if (reason.includes('not a genuine') || reason.includes('automated notification')) return 'skipped'
  return 'abstained'
}

const OUTCOME_PILL: Record<Outcome, PillColour> = {
  drafted: 'in-stock',
  abstained: 'mute',
  blocked: 'out',
  skipped: 'neutral',
}

const EDIT_PILL: Record<EditClass, PillColour> = {
  sent_as_is: 'in-stock',
  lightly_edited: 'allocated',
  rewritten: 'low',
  discarded: 'out',
}

const EDIT_LABEL: Record<EditClass, string> = {
  sent_as_is: 'sent as-is',
  lightly_edited: 'lightly edited',
  rewritten: 'rewritten',
  discarded: 'discarded',
}

const MODE_HELP: Record<Mode, string> = {
  off: 'No drafting. The worker no-ops on every email.',
  shadow: 'Drafts are computed and logged here, but nothing appears in Help Scout.',
  live: 'Drafts, notes and the ai-draft tag appear in Help Scout for the team to review and send.',
}

// Triage-model options. '' = use the default (draft) model. Triage runs on
// EVERY inbound (incl. spam), so a cheaper model here is the main cost lever;
// effort + adaptive thinking auto-drop for models that don't support them. The
// draft step always stays on the default model.
const TRIAGE_MODELS: { value: string; label: string }[] = [
  { value: '', label: 'Default (same as draft model)' },
  { value: 'claude-opus-4-8', label: 'Opus 4.8 — most capable' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6 — mid' },
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 — cheapest' },
]
const TRIAGE_LABEL = (v: string) => TRIAGE_MODELS.find((m) => m.value === v)?.label ?? v

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

export default function AdminAiDraftsPage() {
  const [mode, setMode] = useState<Mode | null>(null)
  const [rows, setRows] = useState<DraftRow[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [pendingMode, setPendingMode] = useState<Mode | null>(null)
  const [modeWorking, setModeWorking] = useState(false)
  const [modeError, setModeError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [tab, setTab] = useState<Tab>('decisions')
  // Admin triage-model override ('' = default). Saved on select.
  const [triageModel, setTriageModel] = useState<string>('')
  const [triageSaving, setTriageSaving] = useState(false)
  const [triageError, setTriageError] = useState<string | null>(null)
  // 30-day daily aggregates for the spend + acceptance trend charts. Fetched
  // separately (minimal columns, wider window) so the heavy 7-day decision
  // list query stays small. null until first load.
  const [series, setSeries] = useState<DayPoint[] | null>(null)

  // A poll must not overwrite the mode pill while the user is mid mode-change,
  // or the confirm panel's "current → pending" framing would jump under them.
  // A ref so the (mount-only) poll loop reads the latest value without the
  // interval being torn down and recreated on every keystroke of state.
  const busyRef = useRef(false)
  useEffect(() => { busyRef.current = pendingMode !== null || modeWorking || triageSaving }, [pendingMode, modeWorking, triageSaving])

  // One fetch of mode + the last 7 days of decisions. Returns the data, or an
  // error string so callers can decide: the initial load replaces the page
  // with an error card; a background poll swallows it and keeps the last good
  // data, so a momentary network blip never blanks the table.
  async function fetchData(): Promise<{ mode: Mode; triageModel: string; rows: DraftRow[] } | { error: string }> {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const [settingsRes, rowsRes] = await Promise.all([
      supabase.from('settings').select('ai_drafts_mode, ai_drafts_triage_model').eq('id', 1).single(),
      supabase
        .from('ai_drafts')
        .select(
          'id, created_at, category, confidence, state, draft_body, note_body, abstain_or_block_reason, summary, usage_input, usage_output, usage_cache_read, usage_cache_write, usage_triage_input, usage_triage_output, usage_triage_cache_read, usage_triage_cache_write, model, triage_model, edit_class, edit_similarity, sent_body, skip_kind',
        )
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(400),
    ])
    if (settingsRes.error) return { error: settingsRes.error.message }
    if (rowsRes.error) return { error: rowsRes.error.message }
    return {
      mode: (settingsRes.data?.ai_drafts_mode ?? 'off') as Mode,
      triageModel: (settingsRes.data?.ai_drafts_triage_model ?? '') as string,
      rows: (rowsRes.data ?? []) as DraftRow[],
    }
  }

  // The trend-chart data: SERIES_DAYS of just the columns the two charts need.
  // Best-effort — on error we leave the last good series in place rather than
  // blanking the charts. At a few dozen rows/day this stays well under the
  // 1000-row cap; if volume ever outgrows that the oldest days truncate first
  // (order desc), which only shortens the chart, never corrupts recent days.
  async function fetchSeries() {
    const since = new Date(Date.now() - SERIES_DAYS * 24 * 60 * 60 * 1000).toISOString()
    const { data, error } = await supabase
      .from('ai_drafts')
      .select('created_at, usage_input, usage_output, usage_cache_read, usage_cache_write, usage_triage_input, usage_triage_output, usage_triage_cache_read, usage_triage_cache_write, model, triage_model, edit_class')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(1000)
    if (error || !data) return
    setSeries(buildDailySeries(data as (TokenUsage & { created_at: string; edit_class: EditClass | null })[]))
  }

  // First open: show the spinner, surface a hard error if it fails. The chart
  // series loads alongside but never blocks the page or counts as a hard error.
  async function initialLoad() {
    setLoading(true)
    void fetchSeries()
    const res = await fetchData()
    if ('error' in res) { setLoadError(res.error); setLoading(false); return }
    setMode(res.mode)
    setTriageModel(res.triageModel)
    setRows(res.rows)
    setLastUpdated(new Date())
    setLoading(false)
  }

  // Background refresh: swap rows in place, never toggle the page spinner, never
  // blank on a transient error, and leave the mode display alone while the user
  // is changing it. The open/expanded row survives because it is keyed by id.
  async function refresh() {
    void fetchSeries()
    const res = await fetchData()
    if ('error' in res) return
    setRows(res.rows)
    if (!busyRef.current) { setMode(res.mode); setTriageModel(res.triageModel) }
    setLastUpdated(new Date())
  }

  // Keep the open panel current: poll every POLL_MS, but only while the tab is
  // visible (a backgrounded tab fetches nothing), and refresh straight away
  // whenever the tab regains focus.
  useEffect(() => {
    void initialLoad()
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, POLL_MS)
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { window.clearInterval(id); document.removeEventListener('visibilitychange', onVisible) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function applyMode(next: Mode) {
    if (next === mode) { setPendingMode(null); return }
    setModeWorking(true)
    setModeError(null)
    const prev = mode
    const { error } = await supabase
      .from('settings')
      .update({ ai_drafts_mode: next, updated_at: new Date().toISOString() })
      .eq('id', 1)
    setModeWorking(false)
    if (error) { setModeError(error.message); return }
    setMode(next)
    setPendingMode(null)
    void logAudit({
      action: 'setting.ai_drafts_mode_updated',
      targetType: 'setting',
      targetId: '1',
      beforeValue: { ai_drafts_mode: prev },
      afterValue: { ai_drafts_mode: next },
    })
  }

  async function applyTriageModel(next: string) {
    if (next === triageModel) return
    const prev = triageModel
    // Optimistic: the <select> is controlled by triageModel, so set it now or it
    // would visually snap back to the old option for the whole save round-trip.
    // busyRef guards the poll while saving; roll back on error.
    setTriageModel(next)
    setTriageSaving(true)
    setTriageError(null)
    // Store '' as null so the edge function's coalesce falls back to the default.
    const { error } = await supabase
      .from('settings')
      .update({ ai_drafts_triage_model: next || null, updated_at: new Date().toISOString() })
      .eq('id', 1)
    setTriageSaving(false)
    if (error) { setTriageError(error.message); setTriageModel(prev); return }
    void logAudit({
      action: 'setting.ai_drafts_triage_model_updated',
      targetType: 'setting',
      targetId: '1',
      beforeValue: { ai_drafts_triage_model: prev || null },
      afterValue: { ai_drafts_triage_model: next || null },
    })
  }

  const stats = useMemo(() => {
    const byOutcome: Record<Outcome, number> = { drafted: 0, abstained: 0, blocked: 0, skipped: 0 }
    const byEdit: Record<EditClass, number> = { sent_as_is: 0, lightly_edited: 0, rewritten: 0, discarded: 0 }
    const byCat: Record<string, { drafted: number; accepted: number; matched: number }> = {}
    let cost = 0
    let matched = 0
    // Split the skipped bucket: proper spam (unsolicited junk) vs everything
    // else non-customer that needs no reply (suppliers, notifications, other,
    // and older rows that predate skip_kind).
    let spam = 0
    let noReply = 0
    for (const r of rows) {
      const o = outcomeOf(r)
      byOutcome[o]++
      if (o === 'skipped') {
        if (r.skip_kind === 'spam') spam++
        else noReply++
      }
      cost += rowCostUsd(r)
      const cat = r.category ?? 'other'
      byCat[cat] ??= { drafted: 0, accepted: 0, matched: 0 }
      if (o === 'drafted') byCat[cat].drafted++
      if (r.edit_class) {
        byEdit[r.edit_class]++
        matched++
        byCat[cat].matched++
        if (r.edit_class === 'sent_as_is' || r.edit_class === 'lightly_edited') byCat[cat].accepted++
      }
    }
    return { byOutcome, byEdit, byCat, cost, matched, spam, noReply, total: rows.length }
  }, [rows])

  // Bars for the two trend charts, derived from the daily series.
  const charts = useMemo(() => {
    const s = series ?? []
    // Null on a zero-activity day so it renders as a faint "no data" slot, not
    // a solid $0 bar — keeping a real number (incl. a genuine 0) visible while
    // an idle day reads as absence. Mirrors the acceptance null/0 distinction.
    const spendBars = s.map((p) => ({ date: p.date, value: p.spend > 0 ? p.spend : null }))
    // Acceptance is null on days with no sent replies (a blank slot, not 0%) so
    // a quiet day never reads as a quality dip.
    const acceptBars = s.map((p) => ({ date: p.date, value: p.matched > 0 ? (p.accepted / p.matched) * 100 : null }))

    const totalSpend = s.reduce((a, p) => a + p.spend, 0)
    const totalMatched = s.reduce((a, p) => a + p.matched, 0)
    const totalAccepted = s.reduce((a, p) => a + p.accepted, 0)
    const spendMax = Math.max(0, ...s.map((p) => p.spend))
    const avgPerDay = s.length ? totalSpend / s.length : 0

    // Trends (least-squares over the day index). Spend treats an idle day as a
    // real 0 (cost genuinely was 0); acceptance fits only days that had sent
    // replies (a no-reply day is missing data, not a 0% score).
    const spendTrend = linearFit(s.map((p, i) => ({ x: i, y: p.spend })))
    const acceptTrend = linearFit(
      s.flatMap((p, i) => (p.matched > 0 ? [{ x: i, y: (p.accepted / p.matched) * 100 }] : [])),
    )
    // Direction with a small dead-zone so noise near zero reads as "flat".
    const spendDir = !spendTrend ? null : spendTrend.slope > spendMax * 0.005 ? 'up' : spendTrend.slope < -spendMax * 0.005 ? 'down' : 'flat'
    const acceptDir = !acceptTrend ? null : acceptTrend.slope > 0.2 ? 'up' : acceptTrend.slope < -0.2 ? 'down' : 'flat'
    const spendTrendLabel = spendDir == null ? null : spendDir === 'up' ? 'trend ↗ rising' : spendDir === 'down' ? 'trend ↘ easing' : 'trend → flat'
    const acceptTrendLabel = acceptDir == null ? null : acceptDir === 'up' ? 'trend ↗ improving' : acceptDir === 'down' ? 'trend ↘ slipping' : 'trend → flat'

    // One shared per-day summary for the hover panel (identical on both charts).
    const summaries = s.map((p) => ({
      date: p.date,
      rows: [
        { label: 'Decisions', value: String(p.count) },
        { label: 'Spend', value: `$${p.spend.toFixed(2)}` },
        { label: 'Replies sent', value: String(p.matched) },
        { label: 'Accepted', value: p.matched > 0 ? `${p.accepted}/${p.matched} · ${Math.round((p.accepted / p.matched) * 100)}%` : '—' },
      ],
    }))

    return {
      spendBars,
      acceptBars,
      summaries,
      totalSpend,
      totalMatched,
      totalAccepted,
      spendMax,
      avgPerDay,
      spendTrend,
      acceptTrend,
      spendTrendLabel,
      acceptTrendLabel,
      hasSpend: totalSpend > 0,
      hasAccept: totalMatched > 0,
    }
  }, [series])

  if (loading) {
    return <p className="text-ink-mute text-sm">Loading…</p>
  }
  // Note: a decisions/settings load error is shown INLINE on the Decisions tab
  // (below), not as a page-level block — so the Briefing and Proposals tabs,
  // which load their own data, stay reachable even if this query fails.

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-medium text-ink">AI drafts</h1>
        <p className="text-sm text-ink-mute mt-1">
          Drafts the pipeline produced for Customer Support, with cost and (once replies are sent) how much each was edited. Last 7 days.
        </p>
      </header>

      {/* Mode control */}
      <section className="rounded-lg border border-line bg-surface p-5">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <div className="eyebrow text-ink-mute mb-1">Mode</div>
            <div className="flex items-center gap-2">
              <Pill colour={mode === 'live' ? 'in-stock' : mode === 'shadow' ? 'allocated' : 'mute'}>
                {mode}
              </Pill>
              <span className="text-sm text-ink-mute">{mode && MODE_HELP[mode]}</span>
            </div>
          </div>
          <div className="flex gap-1.5">
            {(['off', 'shadow', 'live'] as Mode[]).map((m) => (
              <button
                key={m}
                onClick={() => setPendingMode(m)}
                disabled={m === mode}
                className={[
                  'rounded-[8px] px-3 py-1.5 text-[13px] border transition-colors',
                  m === mode
                    ? 'border-line bg-line-soft text-ink-dim cursor-default'
                    : 'border-line text-ink-soft hover:bg-canvas hover:text-ink',
                ].join(' ')}
              >
                {m}
              </button>
            ))}
          </div>
        </div>

        {pendingMode && pendingMode !== mode && (
          <div className="mt-4 rounded-[8px] border border-line bg-canvas p-3">
            <p className="text-sm text-ink">
              Switch mode to <strong>{pendingMode}</strong>? {MODE_HELP[pendingMode]}
              {pendingMode === 'live' && ' Drafts still never auto-send — a person reviews and sends each one.'}
            </p>
            {modeError && <p className="text-sm text-[var(--c-out)] mt-2">{modeError}</p>}
            <div className="flex gap-2 mt-3">
              <ButtonInk onClick={() => void applyMode(pendingMode)} disabled={modeWorking}>
                {modeWorking ? 'Switching…' : `Switch to ${pendingMode}`}
              </ButtonInk>
              <ButtonGhost onClick={() => { setPendingMode(null); setModeError(null) }} disabled={modeWorking}>
                Cancel
              </ButtonGhost>
            </div>
          </div>
        )}

        {/* Triage model — the cost lever (runs on every inbound; drafting always
            uses the default model). Saved on select. */}
        <div className="mt-4 pt-4 border-t border-line-soft flex items-start justify-between gap-3 flex-wrap">
          <div>
            <div className="eyebrow text-ink-mute mb-1">Triage model</div>
            <p className="text-sm text-ink-mute max-w-md">
              Classifies every inbound email. Drafting always uses the default model; a cheaper triage model is the main cost lever, since triage runs on spam too.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <select
              value={triageModel}
              onChange={(e) => void applyTriageModel(e.target.value)}
              disabled={triageSaving}
              aria-label="Triage model"
              className="rounded-[8px] border border-line bg-surface px-3 py-1.5 text-[13px] text-ink disabled:opacity-60"
            >
              {TRIAGE_MODELS.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
            {triageSaving && <span className="text-[11px] text-ink-dim">Saving…</span>}
          </div>
        </div>
        {triageError && <p className="text-sm text-[var(--c-out)] mt-2">{triageError}</p>}
        {!triageError && triageModel !== '' && (
          <p className="text-[11px] text-ink-dim mt-2">Triage on {TRIAGE_LABEL(triageModel)}; drafting stays on the default model.</p>
        )}
      </section>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-line">
        {(['decisions', 'briefing', 'proposals'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={[
              'px-3 py-2 text-sm border-b-2 -mb-px transition-colors capitalize',
              tab === t ? 'border-[var(--c-brand)] text-ink font-medium' : 'border-transparent text-ink-mute hover:text-ink',
            ].join(' ')}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'decisions' && (
        <>
      {loadError && (
        <div className="rounded-lg border border-line bg-surface p-4 text-sm text-ink">
          <span className="text-[var(--c-out)]">Couldn’t load decisions:</span> {loadError}
        </div>
      )}
      {/* Stats */}
      <section className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <Stat label="Drafted" value={stats.byOutcome.drafted} />
        <Stat label="Abstained" value={stats.byOutcome.abstained} />
        <Stat label="Blocked" value={stats.byOutcome.blocked} tone={stats.byOutcome.blocked > 0 ? 'warn' : undefined} />
        <Stat label="Spam" value={stats.spam} hint="unsolicited junk only" />
        <Stat label="No reply needed" value={stats.noReply} hint="suppliers, notifications, etc." />
      </section>
      <section className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label={`Cost (7d, USD)`} value={`$${stats.cost.toFixed(2)}`} />
        <Stat label="Decisions" value={stats.total} />
        <Stat
          label="Acceptance"
          value={stats.matched === 0 ? '—' : `${Math.round(((stats.byEdit.sent_as_is + stats.byEdit.lightly_edited) / stats.matched) * 100)}%`}
          hint={stats.matched === 0 ? 'awaiting sent replies' : `${stats.matched} sent`}
        />
        <Stat label="Sent as-is" value={stats.matched === 0 ? '—' : stats.byEdit.sent_as_is} />
      </section>

      {/* Trends (last 30 days) */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <TrendChart
          title="Daily spend"
          hint={`$${charts.totalSpend.toFixed(2)} over 30 days · $${charts.avgPerDay.toFixed(2)}/day avg`}
          bars={charts.spendBars}
          max={charts.spendMax}
          topLabel={`$${charts.spendMax.toFixed(2)}`}
          colour="var(--c-brand)"
          loading={series === null}
          hasData={charts.hasSpend}
          emptyMsg="No spend in the last 30 days."
          avgLine={{ value: charts.avgPerDay, label: `avg $${charts.avgPerDay.toFixed(2)}/day` }}
          trend={charts.spendTrend}
          trendLabel={charts.spendTrendLabel}
          summaries={charts.summaries}
        />
        <TrendChart
          title="Acceptance rate"
          hint={
            charts.totalMatched === 0
              ? 'awaiting sent replies'
              : `${Math.round((charts.totalAccepted / charts.totalMatched) * 100)}% over ${charts.totalMatched} sent · 30 days`
          }
          bars={charts.acceptBars}
          max={100}
          topLabel="100%"
          colour="var(--c-in-stock)"
          loading={series === null}
          hasData={charts.hasAccept}
          emptyMsg="No replies sent in the last 30 days yet."
          trend={charts.acceptTrend}
          trendLabel={charts.acceptTrendLabel}
          summaries={charts.summaries}
        />
      </section>

      {/* By category */}
      {Object.keys(stats.byCat).length > 0 && (
        <section className="rounded-lg border border-line bg-surface overflow-hidden">
          <div className="px-5 py-3 border-b border-line"><h2 className="text-sm font-medium text-ink">By category (last 7 days)</h2></div>
          <div className="divide-y divide-line-soft">
            {Object.entries(stats.byCat).sort((a, b) => b[1].drafted - a[1].drafted).map(([cat, c]) => (
              <div key={cat} className="px-5 py-2.5 flex items-center gap-3 text-sm">
                <span className="text-ink w-44 shrink-0 truncate">{cat}</span>
                <span className="text-ink-mute text-xs w-24 shrink-0 tabular-nums">{c.drafted} drafted</span>
                <span className="text-ink-mute text-xs shrink-0 tabular-nums">
                  {c.matched === 0 ? 'no sends yet' : `${Math.round((c.accepted / c.matched) * 100)}% accepted (${c.matched})`}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Recent decisions */}
      <section className="rounded-lg border border-line bg-surface overflow-hidden">
        <div className="px-5 py-3 border-b border-line flex items-center justify-between gap-2">
          <h2 className="text-sm font-medium text-ink">Recent decisions</h2>
          {lastUpdated && (
            <span
              className="flex items-center gap-1.5 text-[11px] text-ink-dim shrink-0"
              title={`Refreshes itself every ${POLL_MS / 1000}s while this tab is open`}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-in-stock animate-pulse" />
              Live · updated {lastUpdated.toLocaleTimeString('en-GB')}
            </span>
          )}
        </div>
        {rows.length === 0 ? (
          <p className="px-5 py-8 text-sm text-ink-mute">No decisions in the last 7 days.</p>
        ) : (
          <ul>
            {rows.slice(0, 60).map((r) => {
              const outcome = outcomeOf(r)
              // A skipped row shows WHICH kind it was (spam stands out in red);
              // every other outcome shows the outcome word as before.
              const mainPill =
                outcome === 'skipped'
                  ? skipKindMeta(r.skip_kind)
                  : { label: outcome as string, colour: OUTCOME_PILL[outcome] }
              const isOpen = expanded === r.id
              return (
                <li key={r.id} className="border-b border-line-soft last:border-b-0">
                  <button
                    onClick={() => setExpanded(isOpen ? null : r.id)}
                    className="w-full text-left px-5 py-3 hover:bg-canvas transition-colors"
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs text-ink-mute tabular-nums w-[84px] shrink-0">{fmtTime(r.created_at)}</span>
                      <HelpTip
                        body={tagHelp('aidraft', outcome === 'skipped' ? (r.skip_kind ?? 'skipped') : outcome)}
                        affordance="none"
                        focusable={false}
                      >
                        <Pill colour={mainPill.colour}>{mainPill.label}</Pill>
                      </HelpTip>
                      {r.category && <Pill colour="neutral">{r.category}</Pill>}
                      {r.edit_class && (
                        <HelpTip body={tagHelp('aidraft', r.edit_class)} affordance="none" focusable={false}>
                          <Pill colour={EDIT_PILL[r.edit_class]}>{EDIT_LABEL[r.edit_class]}</Pill>
                        </HelpTip>
                      )}
                      <span className="text-sm text-ink-soft truncate min-w-0 flex-1" title={r.summary ?? undefined}>{r.summary}</span>
                      <span className="text-xs text-ink-dim tabular-nums shrink-0">${rowCostUsd(r).toFixed(3)}</span>
                    </div>
                  </button>
                  {isOpen && (
                    <div className="px-5 pb-4 space-y-3">
                      {r.summary && <Block title="Summary">{r.summary}</Block>}
                      {r.draft_body && (
                        <Block title="Draft">{r.draft_body}</Block>
                      )}
                      {!r.draft_body && r.abstain_or_block_reason && (
                        <Block title="Reason">{r.abstain_or_block_reason}</Block>
                      )}
                      {r.note_body && <Block title="Internal note">{r.note_body}</Block>}
                      {r.sent_body && (
                        <Block title={`Actually sent${r.edit_similarity != null ? ` · ${Math.round(r.edit_similarity * 100)}% match` : ''}`}>
                          {r.sent_body}
                        </Block>
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </section>
        </>
      )}

      {tab === 'briefing' && <AdminAiDraftsBriefing />}
      {tab === 'proposals' && <AdminAiDraftsProposals />}
    </div>
  )
}

function Stat({ label, value, hint, tone }: { label: string; value: number | string; hint?: string; tone?: 'warn' }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3">
      <div className="text-xs text-ink-mute">{label}</div>
      <div className={['text-2xl font-medium tabular-nums', tone === 'warn' ? 'text-[var(--c-out)]' : 'text-ink'].join(' ')}>{value}</div>
      {hint && <div className="text-[11px] text-ink-dim mt-0.5">{hint}</div>}
    </div>
  )
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="eyebrow text-ink-mute mb-1">{title}</div>
      <pre className="whitespace-pre-wrap font-sans text-sm text-ink bg-canvas border border-line-soft rounded-[8px] p-3 leading-relaxed">{children}</pre>
    </div>
  )
}

// A compact hand-rolled SVG bar chart for the two daily trends — no chart
// library, matching the repo's other inline SVGs. One bar per day scaled to
// `max`. A null value (e.g. a day with no sent replies) renders as a faint slot
// so a quiet day reads as "no data", never as 0%. Adds an optional average
// reference line, a least-squares trend line, and a hover-a-day summary panel.
function TrendChart({
  title,
  hint,
  bars,
  max,
  topLabel,
  colour,
  loading,
  hasData,
  emptyMsg,
  avgLine,
  trend,
  trendLabel,
  summaries,
}: {
  title: string
  hint?: string
  bars: { date: Date; value: number | null }[]
  max: number
  topLabel: string
  colour: string
  loading: boolean
  hasData: boolean
  emptyMsg: string
  avgLine?: { value: number; label: string }
  trend?: { slope: number; intercept: number } | null
  trendLabel?: string | null
  summaries?: { date: Date; rows: { label: string; value: string }[] }[]
}) {
  const [hover, setHover] = useState<number | null>(null)
  const W = 720
  const H = 150
  const plotTop = 12
  const plotBottom = 120
  const plotH = plotBottom - plotTop
  const n = Math.max(bars.length, 1)
  const slot = W / n
  const barW = Math.min(slot * 0.62, 22)
  const safeMax = max > 0 ? max : 1
  const fmtDay = (d: Date) => d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
  const fmtFullDay = (d: Date) => d.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' })
  const labelIdx = [0, Math.floor((bars.length - 1) / 2), bars.length - 1]
  // value → y, clamped into the plot so an out-of-range trend endpoint rests on
  // the boundary rather than drawing off-chart.
  const yAt = (v: number) => plotBottom - (Math.max(0, Math.min(v, safeMax)) / safeMax) * plotH

  const hoverSummary = hover != null ? summaries?.[hover] : undefined

  return (
    <div className="rounded-lg border border-line bg-surface p-5">
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <h2 className="text-sm font-medium text-ink">{title}</h2>
        <div className="flex items-baseline gap-2 text-right">
          {trendLabel && <span className="text-[11px] text-ink-soft tabular-nums">{trendLabel}</span>}
          {hint && <span className="text-[11px] text-ink-mute tabular-nums">{hint}</span>}
        </div>
      </div>
      {loading ? (
        <p className="text-sm text-ink-mute py-10 text-center">Loading…</p>
      ) : !hasData ? (
        <p className="text-sm text-ink-mute py-10 text-center">{emptyMsg}</p>
      ) : (
        <div className="relative" onMouseLeave={() => setHover(null)}>
          <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`${title} — last ${bars.length} days`}>
            <line x1={0} y1={plotTop} x2={W} y2={plotTop} stroke="var(--c-line-soft)" strokeWidth={1} strokeDasharray="3 3" />
            <line x1={0} y1={plotBottom} x2={W} y2={plotBottom} stroke="var(--c-line)" strokeWidth={1} />
            <text x={2} y={plotTop - 3} fontSize={11} fill="var(--c-ink-dim)">{topLabel}</text>

            {/* hovered-day vertical guide (under the bars) */}
            {hover != null && (
              <line x1={hover * slot + slot / 2} y1={plotTop} x2={hover * slot + slot / 2} y2={plotBottom} stroke="var(--c-ink-dim)" strokeWidth={1} opacity={0.35} />
            )}

            {bars.map((b, i) => {
              const cx = i * slot + slot / 2
              if (b.value == null) {
                return <rect key={i} x={cx - barW / 2} y={plotBottom - 2} width={barW} height={2} fill="var(--c-line)" opacity={0.5} />
              }
              // Any real value (incl. a genuine 0, e.g. a 0%-acceptance day) gets
              // a visible baseline mark; only nulls (above) are the faint slot.
              const drawH = Math.max((b.value / safeMax) * plotH, 1.5)
              return <rect key={i} x={cx - barW / 2} y={plotBottom - drawH} width={barW} height={drawH} rx={1} fill={colour} opacity={hover == null || hover === i ? 1 : 0.55} />
            })}

            {/* average reference line (dashed) */}
            {avgLine && avgLine.value > 0 && (
              <>
                <line x1={0} y1={yAt(avgLine.value)} x2={W} y2={yAt(avgLine.value)} stroke="var(--c-ink-mute)" strokeWidth={1} strokeDasharray="4 3" />
                <text x={W - 2} y={Math.max(plotTop + 9, yAt(avgLine.value) - 3)} fontSize={10} fill="var(--c-ink-dim)" textAnchor="end">{avgLine.label}</text>
              </>
            )}

            {/* trend line (solid) */}
            {trend && (
              <line
                x1={slot / 2}
                y1={yAt(trend.intercept)}
                x2={(n - 1) * slot + slot / 2}
                y2={yAt(trend.intercept + trend.slope * (n - 1))}
                stroke="var(--c-ink-soft)"
                strokeWidth={2}
                strokeLinecap="round"
              />
            )}

            {labelIdx.map((idx, k) => {
              if (idx < 0 || idx >= bars.length) return null
              const anchor = k === 0 ? 'start' : k === labelIdx.length - 1 ? 'end' : 'middle'
              const x = k === 0 ? 2 : k === labelIdx.length - 1 ? W - 2 : idx * slot + slot / 2
              return (
                <text key={k} x={x} y={H - 4} fontSize={11} fill="var(--c-ink-dim)" textAnchor={anchor}>
                  {fmtDay(bars[idx].date)}
                </text>
              )
            })}

            {/* full-height transparent hover targets (on top, catch the mouse) */}
            {bars.map((_, i) => (
              <rect key={`h${i}`} x={i * slot} y={plotTop} width={slot} height={plotH} fill="transparent" onMouseEnter={() => setHover(i)} />
            ))}
          </svg>

          {/* Day readout sits BELOW the plot so it never obscures the bars; the
              vertical guide + highlighted bar show which column it refers to. */}
          <div className="mt-2 min-h-[20px] flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px]">
            {hoverSummary ? (
              <>
                <span className="font-medium text-ink">{fmtFullDay(hoverSummary.date)}</span>
                {hoverSummary.rows.map((r) => (
                  <span key={r.label} className="text-ink-mute">
                    {r.label} <span className="tabular-nums text-ink">{r.value}</span>
                  </span>
                ))}
              </>
            ) : (
              <span className="text-ink-dim">Hover a day for its breakdown</span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
