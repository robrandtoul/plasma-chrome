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
  // The three fields below come from migrations this page may be deployed
  // ahead of, so they are OPTIONAL: a column the database doesn't have yet
  // comes back absent rather than null. See "Reading a database that may be
  // older than this page" below.
  feedback_match_quality?: MatchQuality | null
  // Why the match was judged unrelated. Same migration (000348) as the quality
  // above — the two are added in one statement, so they are never apart.
  feedback_match_reason?: MatchReason | null
  // Which briefing wrote this draft (migration 000351). null on anything
  // written before the stamp existed; 0 means the drafter fell back to the
  // compiled rules because it couldn't read the DB briefing.
  briefing_version?: number | null
}

// Was the staff reply we scored this draft against an edit of the draft at
// ALL? (migration 000348.) Often it isn't: the next thing the team sends is
// the proof delivery, the order link, an automated chase. null = never
// assessed, which is every row written before 26 July 2026.
type MatchQuality = 'edit' | 'unrelated'

// And WHY it wasn't an edit, in the classifier's own words (migration 000348).
// Only ever set alongside an 'unrelated' verdict.
type MatchReason = 'proof_delivery' | 'order_message' | 'stale_draft' | 'different_message'

// The same four reasons written as something a reviewer can read. The stored
// value is machine-readable so the miner can filter on it; nobody should have
// to meet the word "proof_delivery" on screen to find out that the reply we
// scored this draft against was a proof going out.
const MATCH_REASON_TEXT: Record<MatchReason, string> = {
  proof_delivery: 'the next thing we sent was a proof, not an answer to this email',
  order_message: 'the next thing we sent was the order or payment link',
  stale_draft: 'the reply went out days later, by which point it was answering something else',
  different_message: 'the reply was a short message with none of the draft left in it',
}
// Falls back rather than printing an unknown enum value, in case a fifth
// reason is added to the classifier before this page hears about it.
function matchReasonText(reason: MatchReason | null | undefined): string {
  return (reason && MATCH_REASON_TEXT[reason]) || 'this reply wasn’t an edit of the draft'
}

// The two predicates every acceptance figure on this page is built from, in
// one place so the headline stat, the per-category table, the daily chart and
// the per-version panel can't drift apart.
//
// A reply only counts once it has been sent AND it was plausibly an edit of
// the draft. Excluding the rest matters more than it sounds: 39% of the
// 'discarded' rows on live were measured to be a different message entirely,
// so a heavy proof-delivery week used to drag the score down and could get a
// perfectly good rule reverted.
//
// ⚠ Test for === 'unrelated' to exclude. NULL means "not assessed", not
// "unrelated", so it must still count — a `!== 'edit'` test would throw away
// the whole back catalogue. (In SQL the same filter has to be written
// `is distinct from 'unrelated'`; see migration 000355.)
interface Scorable {
  edit_class: EditClass | null
  // Optional, not just nullable: absent when the database predates migration
  // 000348. Absent behaves exactly like NULL here — not assessed, so it still
  // counts — which is the pre-000348 behaviour, unchanged.
  feedback_match_quality?: MatchQuality | null
}
function isScorable(r: Scorable): boolean {
  return r.edit_class != null && r.feedback_match_quality !== 'unrelated'
}
function isAccepted(r: Scorable): boolean {
  return isScorable(r) && (r.edit_class === 'sent_as_is' || r.edit_class === 'lightly_edited')
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
  'claude-opus-5': { in: 5, out: 25 },
  'claude-opus-4-8': { in: 5, out: 25 },
  'claude-sonnet-5': { in: 3, out: 15 },
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

// The trimmed row shape behind the 30-day charts. Deliberately minimal — no
// bodies — because this is the query that has to cover the whole window.
// (The briefing-version breakdown no longer reads these rows: it is counted in
// SQL instead, see fetchVersionStats.)
type SeriesRow = TokenUsage & {
  created_at: string
  edit_class: EditClass | null
  feedback_match_quality?: MatchQuality | null
}

function buildDailySeries(rows: SeriesRow[]): DayPoint[] {
  const byDay = new Map<string, DayAgg>()
  for (const r of rows) {
    const k = localDayKey(new Date(r.created_at))
    const b = byDay.get(k) ?? emptyAgg()
    b.count++
    b.spend += costFromUsage(r)
    if (isScorable(r)) {
      b.matched++
      if (isAccepted(r)) b.accepted++
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

// ── Briefing versions ────────────────────────────────────────────────────────
// Every draft is stamped with the briefing that wrote it (migration 000351), so
// "did approving that rule change actually help?" becomes a comparison rather
// than a squint at a trend line that drifts for a dozen other reasons.

// One briefing's slice of the 30-day window, counted by the
// ai_draft_version_stats RPC (migration 000355).
//
// This used to be rolled up in the browser from the same rows the charts use.
// It cannot be: PostgREST caps a response at 1000 rows and says nothing about
// the rest, and on live that window holds 1753 — so the panel was scoring 197
// of 325 sent replies while drawing a confidence band beside them that said
// the only uncertainty was sampling noise. Worse, the cap eats the OLDEST rows
// first, so a version's date range could read as its lifetime when it was
// really the row-cap boundary, and "Clearly worse than v12" could come out of
// the cap alone. Counting is what databases are for.
interface VersionStat {
  version: number | null // >= 1 a real briefing · 0 the compiled fallback · null not recorded
  drafts: number
  matched: number // sent replies we can honestly score against the draft
  accepted: number // of those, sent as-is or lightly edited
  unrelated: number // sent, but not an edit of the draft at all — left out of the score
  firstAt: Date
  lastAt: Date
}

// The RPC's wire shape (snake_case, timestamps as ISO strings).
interface VersionStatRow {
  version: number | null
  drafts: number
  matched: number
  accepted: number
  unrelated: number
  first_at: string
  last_at: string
}

// Below this many sent replies we refuse to call a winner, however clean the
// numbers look. Ten is not a statistical threshold so much as a floor against
// the "3 out of 3, must be better!" reading — the interval maths below does the
// real work, this just stops it firing on a handful.
const MIN_VERDICT_N = 10

function toVersionStats(rows: VersionStatRow[]): VersionStat[] {
  return rows
    .map((r) => ({
      version: typeof r.version === 'number' ? r.version : null,
      drafts: r.drafts,
      matched: r.matched,
      accepted: r.accepted,
      unrelated: r.unrelated,
      firstAt: new Date(r.first_at),
      lastAt: new Date(r.last_at),
    }))
    // Newest first, so the briefing in force reads at the top.
    .sort((a, b) => b.firstAt.getTime() - a.firstAt.getTime())
}

// Wilson score interval for a proportion — the honest "how sure are we" band.
// Chosen over the textbook normal interval because it behaves at the sample
// sizes we actually have: 3 out of 3 comes back as roughly 44%–100% rather than
// a confident 100%.
function wilson(k: number, n: number, z = 1.96): { lo: number; hi: number } {
  if (n <= 0) return { lo: 0, hi: 1 }
  const p = k / n
  const d = 1 + (z * z) / n
  const centre = p + (z * z) / (2 * n)
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
  return { lo: Math.max(0, (centre - margin) / d), hi: Math.min(1, (centre + margin) / d) }
}

type Verdict =
  | { kind: 'thin' } // not enough sent replies on one side or the other
  | { kind: 'same'; prev: number }
  | { kind: 'better'; prev: number }
  | { kind: 'worse'; prev: number }

// Compare one briefing to the one before it. Only calls a difference when the
// two intervals don't overlap at all — anything less is noise, and saying so is
// the whole point of this panel.
//
// ⚠ What this can and cannot tell you. A 'better' here means the two rates
// really do differ; it does NOT mean the rule change caused it. The version
// counter only moves for house rules and example replies — the tone guide, the
// approved-link list, the safety guardrails, the prompt wording and the
// grounding data the drafter reads all live in code and change on deploy
// WITHOUT bumping it, and the model can be swapped from the control at the top
// of this page. So the wording below is deliberately correlational, and the
// caveat is repeated in the panel header where a reader will actually meet it.
function verdictFor(cur: VersionStat, prev: VersionStat | undefined): Verdict | null {
  if (!prev || prev.version == null || cur.version == null) return null
  if (cur.matched < MIN_VERDICT_N || prev.matched < MIN_VERDICT_N) return { kind: 'thin' }
  const a = wilson(cur.accepted, cur.matched)
  const b = wilson(prev.accepted, prev.matched)
  if (a.lo > b.hi) return { kind: 'better', prev: prev.version }
  if (a.hi < b.lo) return { kind: 'worse', prev: prev.version }
  return { kind: 'same', prev: prev.version }
}

// How a version is named on screen. 0 and null are real states, not gaps, and
// each says something different about why the number is missing.
// `v == null` rather than `=== null` on purpose: on a database without the
// briefing_version column the field is absent, i.e. undefined, and a strict
// null test would fall through both branches and cheerfully print
// "Briefing vundefined".
function versionLabel(v: number | null | undefined): string {
  if (v == null) return 'Not recorded'
  if (v === 0) return 'Code fallback'
  return `Briefing v${v}`
}
function versionHint(v: number | null | undefined): string | null {
  // null covers two different things and the honest label has to admit it:
  // most of these are simply old (written before stamping began on 26 Jul
  // 2026), but a draft also lands here when the drafter couldn't read the
  // version at all — a lost grant, an unapplied migration. That second case is
  // a fault, and if it were left to read as "old" it would hide indefinitely,
  // so it also writes an audit row (ai_draft.briefing_version_unreadable) and
  // this hint points at where to find it.
  if (v == null) return 'either written before stamping began, or the version couldn’t be read — check Admin → Activity'
  if (v === 0) return 'the drafter could not read the briefing and used the compiled rules'
  return null
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
  { value: 'claude-opus-5', label: 'Opus 5 — most capable (same price as Opus 4.8)' },
  { value: 'claude-opus-4-8', label: 'Opus 4.8 — most capable' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5 — mid (same price as Sonnet 4.6)' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6 — mid' },
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 — cheapest' },
]
const TRIAGE_LABEL = (v: string) => TRIAGE_MODELS.find((m) => m.value === v)?.label ?? v

// Draft-model options ('' = the compiled default / AI_DRAFT_MODEL secret).
// Drafting is the quality-critical call and runs only on genuine customer mail,
// so this is a quality dial rather than a cost lever — no Haiku here. Keep the
// ids in lockstep with the gates in _shared/aiDrafts/anthropic.ts: a model the
// ADAPTIVE_THINKING_MODELS / EFFORT_MODELS patterns don't match runs without
// adaptive thinking or effort, silently and with no error.
const DRAFT_MODELS: { value: string; label: string }[] = [
  { value: '', label: 'Default (Opus 4.8 unless the AI_DRAFT_MODEL secret is set)' },
  { value: 'claude-opus-5', label: 'Opus 5 — newer Opus, same price as 4.8' },
  { value: 'claude-opus-4-8', label: 'Opus 4.8 — the drafting rules were tuned on this' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5 — faster and cheaper (check draft quality first)' },
]
const DRAFT_LABEL = (v: string) => DRAFT_MODELS.find((m) => m.value === v)?.label ?? v

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

// ── Reading more rows than one request can carry ─────────────────────────────
// PostgREST answers any single request with at most PAGE_SIZE rows and says
// nothing at all about the ones it left behind. Every count on this page used
// to be worked out from one such response, so the counts were quietly a
// sample: 1000 of 1753 rows in the 30-day window, and 401 rows of the last
// seven days arriving under a `.limit(400)`. Because the reads are
// newest-first, what goes missing is always the OLDER end, which is the
// dangerous shape — the numbers look complete and the date ranges look real.
//
// So: page until the data runs out, stop at a hard ceiling so a runaway can
// never hammer the browser, and REPORT whether that ceiling was reached. A cap
// is fine. A cap nobody mentions is how you get a wrong number with a
// confidence band drawn next to it.
//
// It stops on an EMPTY page rather than on a short one, which costs one extra
// round trip at the end and buys correctness we'd otherwise be assuming: the
// server is free to return fewer rows than the range asked for (that is what
// PostgREST's own row cap does), so "shorter than I asked for" does not mean
// "that was the last of them". An empty page always does. Each page starts
// where the rows actually received ran out, so a server-side cap smaller than
// PAGE_SIZE just means more, smaller pages — never a skipped row.
const PAGE_SIZE = 1000

type PagedResult<T> = { rows: T[]; truncated: boolean } | { error: string }

async function fetchPaged<T>(
  page: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
  maxRows: number,
): Promise<PagedResult<T>> {
  const rows: T[] = []
  while (rows.length < maxRows) {
    const from = rows.length
    const to = Math.min(from + PAGE_SIZE, maxRows) - 1
    const { data, error } = await page(from, to)
    // Bail on the error rather than treating a failed read as an empty page —
    // supabase-js returns data: null alongside an error, and `data ?? []` there
    // would silently turn a broken read into "there were no drafts".
    if (error) return { error: error.message }
    const got = (data ?? []) as T[]
    if (got.length === 0) return { rows, truncated: false }
    rows.push(...got)
  }
  // Hit the ceiling. There may or may not be more beyond it and we deliberately
  // don't ask, so this says "possibly incomplete" rather than guessing.
  return { rows, truncated: true }
}

// Ceilings, both generous against today's volume (~57 decisions/day on live)
// and both surfaced in the UI if ever reached.
const DECISIONS_MAX = 2000 // 7-day list + stats; ~5x today's weekly volume
const SERIES_MAX = 6000 // 30-day chart rows; ~3x today's monthly volume

// ── Reading a database that may be older than this page ─────────────────────
// Netlify deploys on merge; Rob applies the migrations by hand afterwards. So
// there is a real window — the likely case, not the unlikely one — where this
// page is live and its newest columns are not on the database yet.
//
// PostgREST fails the WHOLE select with 42703 when ONE column is missing. Ask
// for feedback_match_quality (000348) or briefing_version (000351) too early
// and the cost is not those two fields: it is the entire Decisions tab, which
// renders "Couldn't load decisions: column ... does not exist" over a row of
// zeroes. fetchBriefingNow was already split out for exactly this reason; this
// is the same defence applied to the two big reads.
//
// So: work out what the database actually has, once, and say plainly which
// figures are missing because of it. Showing zeroes as though they were real
// data is the one outcome worse than saying nothing.
const UNDEFINED_COLUMN = '42703'

interface DraftColumns {
  // Covers feedback_match_quality AND feedback_match_reason — migration 000348
  // adds both in a single statement, so they are never apart.
  matchQuality: boolean
  briefingVersion: boolean
}
const ALL_DRAFT_COLUMNS: DraftColumns = { matchQuality: true, briefingVersion: true }

function draftOptionalColumns(c: DraftColumns): string[] {
  return [
    ...(c.matchQuality ? ['feedback_match_quality', 'feedback_match_reason'] : []),
    ...(c.briefingVersion ? ['briefing_version'] : []),
  ]
}

// Work out which optional columns exist, using the same best-first ladder the
// miner uses (supabase/functions/ai-draft-miner/index.ts): each rung drops
// exactly one optional column, so which rung succeeds says precisely which
// column is absent — rather than condemning both because one of them is.
//
// ONLY 42703 counts as evidence. A timeout or a dropped connection must never
// be mistaken for "this database is older than we thought", or a momentary
// blip would have the page announcing a missing migration that isn't missing.
// A non-42703 failure returns null: the caller then asks for everything and
// lets the real read report the real error.
//
// Probed with .limit(1) rather than by running the real query four times, so
// the worst case is four tiny requests, once, on page open.
async function resolveDraftColumns(): Promise<DraftColumns | null> {
  const attempts: DraftColumns[] = [
    { matchQuality: true, briefingVersion: true },
    { matchQuality: true, briefingVersion: false },
    { matchQuality: false, briefingVersion: true },
    { matchQuality: false, briefingVersion: false },
  ]
  for (const attempt of attempts) {
    const { error } = await supabase
      .from('ai_drafts')
      .select(['id', ...draftOptionalColumns(attempt)].join(', '))
      .limit(1)
    if (!error) return attempt
    if (error.code !== UNDEFINED_COLUMN) return null
  }
  // Unreachable: the last rung asks for `id` alone.
  return { matchQuality: false, briefingVersion: false }
}

// A column the database doesn't have arrives ABSENT, not null. Normalise once,
// on the way in, so nothing downstream has to know which columns this
// particular database happens to carry.
function normaliseDraftRow(r: DraftRow): DraftRow {
  return {
    ...r,
    feedback_match_quality: r.feedback_match_quality ?? null,
    feedback_match_reason: r.feedback_match_reason ?? null,
    briefing_version: r.briefing_version ?? null,
  }
}

// Everything on ai_drafts that has been there since well before this page.
const DRAFT_BASE_COLUMNS =
  'id, created_at, category, confidence, state, draft_body, note_body, abstain_or_block_reason, summary, usage_input, usage_output, usage_cache_read, usage_cache_write, usage_triage_input, usage_triage_output, usage_triage_cache_read, usage_triage_cache_write, model, triage_model, edit_class, edit_similarity, sent_body, skip_kind'
const SERIES_BASE_COLUMNS =
  'created_at, usage_input, usage_output, usage_cache_read, usage_cache_write, usage_triage_input, usage_triage_output, usage_triage_cache_read, usage_triage_cache_write, model, triage_model, edit_class'

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
  // Admin draft-model override ('' = AI_DRAFT_MODEL secret / compiled default).
  const [draftModel, setDraftModel] = useState<string>('')
  const [draftSaving, setDraftSaving] = useState(false)
  const [draftError, setDraftError] = useState<string | null>(null)
  // 30 days of trimmed rows behind the two trend charts (minimal columns, wider
  // window, paged so nothing is silently dropped). null until first load.
  const [seriesRows, setSeriesRows] = useState<SeriesRow[] | null>(null)
  const [seriesTruncated, setSeriesTruncated] = useState(false)
  // A failed chart/version read used to return silently, which left the panels
  // on "Loading…" for ever with no clue why. Both now carry their error.
  const [seriesError, setSeriesError] = useState<string | null>(null)
  // The last-7-days list hit its ceiling (see DECISIONS_MAX).
  const [rowsTruncated, setRowsTruncated] = useState(false)
  // Per-briefing acceptance, counted in the database (migration 000355) rather
  // than rolled up here from a page of rows. null until first load.
  const [versionStats, setVersionStats] = useState<VersionStat[] | null>(null)
  const [versionsError, setVersionsError] = useState<string | null>(null)
  // The briefing in force right now, read straight from settings so a version
  // that has not written a draft yet still shows. Best-effort — see fetchBriefingNow.
  const [briefingNow, setBriefingNow] = useState<{ version: number; at: string | null } | null>(null)
  // Which of the newer ai_drafts columns this database actually has. Optimistic
  // until proved otherwise, so a fully-migrated database never pays for the
  // ladder past its first rung. The ref is the cache the fetches read (they run
  // from a mount-only interval, so they'd never see fresh state); the state
  // copy is what the notice below renders from.
  const [draftCols, setDraftCols] = useState<DraftColumns>(ALL_DRAFT_COLUMNS)
  const draftColsRef = useRef<DraftColumns | null>(null)
  const draftColsPending = useRef<Promise<DraftColumns> | null>(null)

  // A poll must not overwrite the mode pill while the user is mid mode-change,
  // or the confirm panel's "current → pending" framing would jump under them.
  // A ref so the (mount-only) poll loop reads the latest value without the
  // interval being torn down and recreated on every keystroke of state.
  const busyRef = useRef(false)
  useEffect(() => {
    busyRef.current = pendingMode !== null || modeWorking || triageSaving || draftSaving
  }, [pendingMode, modeWorking, triageSaving, draftSaving])

  // Resolve the optional-column set once and reuse it. Both reads below call
  // this and they run concurrently, so the in-flight promise is shared rather
  // than probing twice; a non-42703 failure isn't cached, so the next poll
  // tries the full column list again.
  async function draftColumns(): Promise<DraftColumns> {
    if (draftColsRef.current) return draftColsRef.current
    if (!draftColsPending.current) {
      draftColsPending.current = resolveDraftColumns().then((resolved) => {
        draftColsPending.current = null
        if (!resolved) return ALL_DRAFT_COLUMNS
        draftColsRef.current = resolved
        setDraftCols(resolved)
        return resolved
      })
    }
    return draftColsPending.current
  }

  // One fetch of mode + the last 7 days of decisions. Returns the data, or an
  // error string so callers can decide: the initial load replaces the page
  // with an error card; a background poll swallows it and keeps the last good
  // data, so a momentary network blip never blanks the table.
  async function fetchData(): Promise<
    { mode: Mode; triageModel: string; draftModel: string; rows: DraftRow[]; truncated: boolean } | { error: string }
  > {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const select = [DRAFT_BASE_COLUMNS, ...draftOptionalColumns(await draftColumns())].join(', ')
    const [settingsRes, rowsRes] = await Promise.all([
      supabase.from('settings').select('ai_drafts_mode, ai_drafts_triage_model, ai_drafts_model').eq('id', 1).single(),
      // Paged: the old `.limit(400)` was already clipping the window on live
      // (401 rows in the last 7 days on 26 Jul, growing at ~57/day), so the
      // headline Acceptance / Decisions / Cost stats and the per-category
      // table were all quietly reading a sample.
      fetchPaged<DraftRow>(
        (from, to) =>
          supabase
            .from('ai_drafts')
            .select(select)
            .gte('created_at', since)
            // id breaks ties so a row can't slip between pages or appear twice.
            .order('created_at', { ascending: false })
            .order('id', { ascending: false })
            .range(from, to),
        DECISIONS_MAX,
      ),
    ])
    if (settingsRes.error) return { error: settingsRes.error.message }
    if ('error' in rowsRes) return { error: rowsRes.error }
    return {
      mode: (settingsRes.data?.ai_drafts_mode ?? 'off') as Mode,
      triageModel: (settingsRes.data?.ai_drafts_triage_model ?? '') as string,
      draftModel: (settingsRes.data?.ai_drafts_model ?? '') as string,
      rows: rowsRes.rows.map(normaliseDraftRow),
      truncated: rowsRes.truncated,
    }
  }

  // The trend-chart data: SERIES_DAYS of just the columns the two charts need,
  // paged to the whole window. It used to ask for one page of 1000 and treat
  // whatever came back as the month — which on live meant 14 of the 30 days
  // were wholly or partly missing, understating total spend and giving the
  // spend trend line a spurious upward slope (a truncated day looks like a
  // genuine £0 day). On error the last good series is left in place, but the
  // error is now SHOWN rather than swallowed.
  async function fetchSeries() {
    const since = new Date(Date.now() - SERIES_DAYS * 24 * 60 * 60 * 1000).toISOString()
    // Only feedback_match_quality matters here; briefing_version is counted in
    // SQL by fetchVersionStats, not rolled up from these rows.
    const cols = await draftColumns()
    const select = [SERIES_BASE_COLUMNS, ...(cols.matchQuality ? ['feedback_match_quality'] : [])].join(', ')
    const res = await fetchPaged<SeriesRow>(
      (from, to) =>
        supabase
          .from('ai_drafts')
          .select(select)
          .gte('created_at', since)
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .range(from, to),
      SERIES_MAX,
    )
    if ('error' in res) { setSeriesError(res.error); return }
    setSeriesError(null)
    setSeriesTruncated(res.truncated)
    setSeriesRows(res.rows)
  }

  // Acceptance per briefing version, counted in SQL (migration 000355) over
  // the same window as the charts. Its own call rather than a roll-up of the
  // rows above: this is the figure the panel draws verdicts from, and a
  // verdict must never be computed from however many rows happened to fit in
  // one response.
  async function fetchVersionStats() {
    const { data, error } = await supabase.rpc('ai_draft_version_stats', { p_days: SERIES_DAYS })
    if (error) { setVersionsError(error.message); return }
    setVersionsError(null)
    setVersionStats(toVersionStats((data ?? []) as VersionStatRow[]))
  }

  // The current briefing version + when it came into force. Its own tiny read
  // rather than part of fetchData, so an unapplied migration (or any hiccup on
  // these two columns) can never take the whole Decisions tab down with it.
  async function fetchBriefingNow() {
    const { data, error } = await supabase
      .from('settings')
      .select('ai_draft_briefing_version, ai_draft_briefing_version_at')
      .eq('id', 1)
      .maybeSingle()
    if (error || !data) return
    const v = (data as { ai_draft_briefing_version?: unknown }).ai_draft_briefing_version
    if (typeof v !== 'number') return
    setBriefingNow({ version: v, at: ((data as { ai_draft_briefing_version_at?: string | null }).ai_draft_briefing_version_at) ?? null })
  }

  // First open: show the spinner, surface a hard error if it fails. The chart
  // series loads alongside but never blocks the page or counts as a hard error.
  async function initialLoad() {
    setLoading(true)
    void fetchSeries()
    void fetchVersionStats()
    void fetchBriefingNow()
    const res = await fetchData()
    if ('error' in res) { setLoadError(res.error); setLoading(false); return }
    setLoadError(null)
    setMode(res.mode)
    setTriageModel(res.triageModel)
    setDraftModel(res.draftModel)
    setRows(res.rows)
    setRowsTruncated(res.truncated)
    setLastUpdated(new Date())
    setLoading(false)
  }

  // Background refresh: swap rows in place, never toggle the page spinner, never
  // blank on a transient error, and leave the mode display alone while the user
  // is changing it. The open/expanded row survives because it is keyed by id.
  async function refresh() {
    void fetchSeries()
    void fetchVersionStats()
    void fetchBriefingNow()
    const res = await fetchData()
    if ('error' in res) return
    setRows(res.rows)
    setRowsTruncated(res.truncated)
    if (!busyRef.current) { setMode(res.mode); setTriageModel(res.triageModel); setDraftModel(res.draftModel) }
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

  // Same optimistic-set / rollback-on-error shape as applyTriageModel above.
  async function applyDraftModel(next: string) {
    if (next === draftModel) return
    const prev = draftModel
    setDraftModel(next)
    setDraftSaving(true)
    setDraftError(null)
    // '' is stored as null so the function falls back to AI_DRAFT_MODEL / the
    // compiled default rather than sending an empty model id.
    const { error } = await supabase
      .from('settings')
      .update({ ai_drafts_model: next || null, updated_at: new Date().toISOString() })
      .eq('id', 1)
    setDraftSaving(false)
    if (error) { setDraftError(error.message); setDraftModel(prev); return }
    void logAudit({
      action: 'setting.ai_drafts_model_updated',
      targetType: 'setting',
      targetId: '1',
      beforeValue: { ai_drafts_model: prev || null },
      afterValue: { ai_drafts_model: next || null },
    })
  }

  const stats = useMemo(() => {
    const byOutcome: Record<Outcome, number> = { drafted: 0, abstained: 0, blocked: 0, skipped: 0 }
    const byEdit: Record<EditClass, number> = { sent_as_is: 0, lightly_edited: 0, rewritten: 0, discarded: 0 }
    const byCat: Record<string, { drafted: number; accepted: number; matched: number }> = {}
    let cost = 0
    let matched = 0
    let accepted = 0
    // Sent replies that turned out not to be an edit of the draft at all
    // (proof deliveries, order links). Counted so the panel can say how many
    // it set aside rather than quietly dropping them.
    let unrelated = 0
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
      if (r.edit_class && !isScorable(r)) unrelated++
      if (isScorable(r)) {
        // byEdit drives the "Sent as-is" tile, so it counts scorable rows only
        // — same population as the acceptance percentage beside it.
        byEdit[r.edit_class as EditClass]++
        matched++
        byCat[cat].matched++
        if (isAccepted(r)) { accepted++; byCat[cat].accepted++ }
      }
    }
    return { byOutcome, byEdit, byCat, cost, matched, accepted, unrelated, spam, noReply, total: rows.length }
  }, [rows])

  // Day buckets for the two trend charts, derived from the raw 30-day rows.
  const series = useMemo(() => (seriesRows ? buildDailySeries(seriesRows) : null), [seriesRows])

  // Per-briefing acceptance, newest first, plus the real (>= 1) versions in
  // number order — which is the order the comparison chain walks, and the whole
  // reason the version is a monotonic counter rather than a hash.
  const versions = useMemo(() => {
    const all = versionStats ?? []
    const real = all.filter((v) => v.version != null && v.version >= 1).sort((a, b) => (a.version as number) - (b.version as number))
    const prevOf = new Map<number, VersionStat>()
    for (let i = 1; i < real.length; i++) prevOf.set(real[i].version as number, real[i - 1])
    return { all, real, prevOf }
  }, [versionStats])

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

    // Where the briefing changed, so a step in the acceptance line can be read
    // against it. The earliest version in the window is deliberately skipped:
    // it was already in force when the window opened, so its first draft here
    // is not a change point.
    const dayIndex = new Map(s.map((p, i) => [p.day, i]))
    const markers = versions.real.slice(1).flatMap((v) => {
      const i = dayIndex.get(localDayKey(v.firstAt))
      return i == null ? [] : [{ index: i, label: `v${v.version}` }]
    })

    return {
      spendBars,
      acceptBars,
      markers,
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
  }, [series, versions])

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

        {/* Draft model — the quality dial. Saved on select. */}
        <div className="mt-4 pt-4 border-t border-line-soft flex items-start justify-between gap-3 flex-wrap">
          <div>
            <div className="eyebrow text-ink-mute mb-1">Draft model</div>
            <p className="text-sm text-ink-mute max-w-md">
              Writes the reply. Only runs on genuine customer email, so this is a quality choice rather than a cost one. Takes effect on the next draft — no redeploy.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <select
              value={draftModel}
              onChange={(e) => void applyDraftModel(e.target.value)}
              disabled={draftSaving}
              aria-label="Draft model"
              className="rounded-[8px] border border-line bg-surface px-3 py-1.5 text-[13px] text-ink disabled:opacity-60"
            >
              {DRAFT_MODELS.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
            {draftSaving && <span className="text-[11px] text-ink-dim">Saving…</span>}
          </div>
        </div>
        {draftError && <p className="text-sm text-[var(--c-out)] mt-2">{draftError}</p>}
        {!draftError && draftModel !== '' && (
          <p className="text-[11px] text-ink-dim mt-2">
            Drafting on {DRAFT_LABEL(draftModel)}. Compare the acceptance rate below before and after a change — a model swap only shows up in how much the team edits.
          </p>
        )}

        {/* Triage model — the cost lever (runs on every inbound, spam included).
            Saved on select. */}
        <div className="mt-4 pt-4 border-t border-line-soft flex items-start justify-between gap-3 flex-wrap">
          <div>
            <div className="eyebrow text-ink-mute mb-1">Triage model</div>
            <p className="text-sm text-ink-mute max-w-md">
              Classifies every inbound email. A cheaper triage model is the main cost lever, since triage runs on spam too. Left on Default it follows whatever the draft model is set to.
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
          <p className="text-[11px] text-ink-dim mt-2">
            Triage on {TRIAGE_LABEL(triageModel)}; drafting on {draftModel ? DRAFT_LABEL(draftModel) : 'the default model'}.
          </p>
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
      {rowsTruncated && (
        <p className="text-[11px] text-ink-dim">
          Showing the most recent {DECISIONS_MAX.toLocaleString('en-GB')} decisions of the last 7 days — there may be more,
          so the figures below are a floor rather than a total.
        </p>
      )}
      <section className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label={`Cost (7d, USD)`} value={`$${stats.cost.toFixed(2)}`} />
        <Stat label="Decisions" value={stats.total} />
        <Stat
          label="Acceptance"
          value={stats.matched === 0 ? '—' : `${Math.round((stats.accepted / stats.matched) * 100)}%`}
          hint={
            stats.matched === 0
              ? 'awaiting sent replies'
              : `${stats.matched} sent${stats.unrelated > 0 ? ` · ${stats.unrelated} not an edit, excluded` : ''}`
          }
        />
        <Stat label="Sent as-is" value={stats.matched === 0 ? '—' : stats.byEdit.sent_as_is} />
      </section>

      {/* What this database can't tell us yet. Named specifically, and only for
          the columns actually found to be absent — the rest of the tab is
          unaffected and shouldn't be tarred with it. */}
      {(!draftCols.matchQuality || !draftCols.briefingVersion) && (
        <section className="rounded-lg border border-line bg-surface p-4 space-y-1.5">
          <p className="text-xs font-medium text-ink">Not available until the database migration is applied</p>
          {!draftCols.matchQuality && (
            <p className="text-[11px] text-ink-mute">
              Whether each sent reply was really an edit of the draft. Until that column exists, every sent reply counts
              towards Acceptance — including proof deliveries and order links, which were never edits of anything — so the
              figure reads lower than the truth rather than being wrong in some unknown direction.
            </p>
          )}
          {!draftCols.briefingVersion && (
            <p className="text-[11px] text-ink-mute">
              Which briefing wrote each draft, so the per-version comparison below and the version stamp on each decision
              are blank.
            </p>
          )}
          <p className="text-[11px] text-ink-dim">
            Everything else on this tab is unaffected. Reload the page once the migration has been applied.
          </p>
        </section>
      )}

      {/* Trends (last 30 days) */}
      {seriesError && (
        <p className="text-[11px] text-[var(--c-out)]">
          Couldn’t load the 30-day figures: {seriesError}. The charts below are showing whatever loaded last, or nothing.
        </p>
      )}
      {seriesTruncated && !seriesError && (
        <p className="text-[11px] text-ink-dim">
          Showing the most recent {SERIES_MAX.toLocaleString('en-GB')} decisions of the last 30 days — the earliest days may be incomplete.
        </p>
      )}
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
          markers={charts.markers}
        />
      </section>

      {/* Acceptance per briefing version */}
      <BriefingVersions
        stats={versions.all}
        prevOf={versions.prevOf}
        current={briefingNow}
        matchQuality={draftCols.matchQuality}
        loading={versionStats === null && versionsError === null}
        error={versionsError}
      />

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
                      {/* The point of migration 000348: a "discarded" row that
                          was never rejected — the team simply sent something
                          else next — says so here, instead of the reviewer
                          opening Help Scout to find that out. Quiet on purpose;
                          the reason is spelled out when the row is expanded. */}
                      {r.feedback_match_quality === 'unrelated' && (
                        <Pill
                          colour="mute"
                          title={`Left out of the acceptance figures: ${matchReasonText(r.feedback_match_reason)}.`}
                        >
                          not an edit
                        </Pill>
                      )}
                      <span className="text-sm text-ink-soft truncate min-w-0 flex-1" title={r.summary ?? undefined}>{r.summary}</span>
                      <span className="text-xs text-ink-dim tabular-nums shrink-0">${rowCostUsd(r).toFixed(3)}</span>
                    </div>
                  </button>
                  {isOpen && (
                    <div className="px-5 pb-4 space-y-3">
                      {/* Which briefing (and model) produced this one — the
                          per-row half of the version comparison above. */}
                      <div className="text-[11px] text-ink-dim">
                        {draftCols.briefingVersion ? (
                          <>
                            {versionLabel(r.briefing_version)}
                            {versionHint(r.briefing_version) && ` — ${versionHint(r.briefing_version)}`}
                          </>
                        ) : (
                          // Without the column, "Not recorded" would send the
                          // reader off to Admin → Activity looking for a fault
                          // that isn't there. Say what's actually the matter.
                          'Briefing version not recorded — needs the database migration'
                        )}
                        {r.model && ` · ${r.model}`}
                      </div>
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
                      {/* Why the match percentage above should be ignored on
                          this row: the two messages were never the same
                          message, so the score is measuring nothing. */}
                      {r.feedback_match_quality === 'unrelated' && (
                        <p className="text-[11px] text-ink-dim">
                          Left out of the acceptance figures — {matchReasonText(r.feedback_match_reason)}.
                        </p>
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

// Acceptance broken down by the briefing that wrote the drafts — the return
// arc on an approved rule change. Deliberately cautious: it always shows the
// raw "k of n", draws the uncertainty rather than hiding it, and only says one
// briefing beat another when the two ranges don't overlap at all. A version
// that has been live a day with four drafts must read as "too early to say",
// because that is the truth.
function BriefingVersions({
  stats,
  prevOf,
  current,
  matchQuality,
  loading,
  error,
}: {
  stats: VersionStat[]
  prevOf: Map<number, VersionStat>
  current: { version: number; at: string | null } | null
  // False when the database has no feedback_match_quality column, in which case
  // nothing is being excluded and this panel must not claim otherwise.
  matchQuality: boolean
  loading: boolean
  error: string | null
}) {
  const fmtDay = (d: Date) => d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
  // The briefing in force may be newer than anything in the ledger — it has
  // simply not written a draft yet. Say so rather than leaving it off the list.
  const currentUnused = current != null && !stats.some((s) => s.version === current.version)

  return (
    <section className="rounded-lg border border-line bg-surface overflow-hidden">
      <div className="px-5 py-3 border-b border-line">
        <h2 className="text-sm font-medium text-ink">Acceptance by briefing version</h2>
        <p className="text-[11px] text-ink-mute mt-0.5">
          Every draft records which briefing wrote it, so an approved rule change can be judged on its own numbers.
          The pale band is the range the true rate could plausibly sit in — the fewer replies, the wider it gets.
          Last 30 days, counted across every draft in the window.
        </p>
        {/* The caveat has to live here, next to the verdicts, not in a comment
            in the code. A reader who only takes one thing from this panel must
            not take "the rule change caused it". */}
        <p className="text-[11px] text-ink-dim mt-1.5">
          The version number only moves when a house rule or example reply changes. The tone guide, the approved-link
          list, the safety rules, the prompt wording and the pricing and lead-time data the drafter reads all live in the
          code and change whenever the app is deployed — without changing this number. The draft model can be switched
          from the control above too. So a difference between two versions means the rates really do differ, not that the
          rule change caused it: check what else shipped around that date before reverting anything.
        </p>
        {matchQuality ? (
          <p className="text-[11px] text-ink-dim mt-1.5">
            Replies that turned out to be a different message altogether — a proof delivery, an order link, an automated
            chase — are left out of the score, since they were never edits of the draft. Replies scored before 26 July 2026
            were never checked for this, so they all still count.
          </p>
        ) : (
          <p className="text-[11px] text-ink-dim mt-1.5">
            Nothing is being left out yet: the check for “was this reply an edit of the draft at all?” needs a database
            migration that hasn’t been applied. Until it is, proof deliveries and order links count against the score.
          </p>
        )}
      </div>

      {error ? (
        <p className="px-5 py-8 text-sm text-ink">
          <span className="text-[var(--c-out)]">Couldn’t load the per-version figures:</span> {error}
          <span className="block text-[11px] text-ink-mute mt-1">
            Nothing is being shown rather than a partial count. If this persists, the ai_draft_version_stats function may
            not have been applied to the database yet.
          </span>
        </p>
      ) : loading ? (
        <p className="px-5 py-8 text-sm text-ink-mute">Loading…</p>
      ) : stats.length === 0 ? (
        <p className="px-5 py-8 text-sm text-ink-mute">No drafts in the last 30 days.</p>
      ) : (
        <div className="divide-y divide-line-soft">
          {currentUnused && current && (
            <div className="px-5 py-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
              <span className="text-ink font-medium">{versionLabel(current.version)}</span>
              <Pill colour="allocated">in force</Pill>
              <span className="text-[11px] text-ink-mute">
                {current.at ? `live since ${fmtDay(new Date(current.at))} · ` : ''}no drafts yet
              </span>
            </div>
          )}
          {stats.map((s) => {
            const isCurrent = current != null && s.version === current.version
            const hint = versionHint(s.version)
            const verdict = verdictFor(s, s.version == null ? undefined : prevOf.get(s.version))
            return (
              <div key={s.version === null ? 'unknown' : s.version} className="px-5 py-3">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="text-sm text-ink font-medium">{versionLabel(s.version)}</span>
                  {isCurrent && <Pill colour="allocated">in force</Pill>}
                  <span className="text-[11px] text-ink-mute tabular-nums">
                    {fmtDay(s.firstAt)} – {fmtDay(s.lastAt)} · {s.drafts} draft{s.drafts === 1 ? '' : 's'}
                  </span>
                  {hint && <span className="text-[11px] text-ink-dim">{hint}</span>}
                </div>

                <div className="mt-2 flex items-center gap-3 flex-wrap">
                  <RateBar k={s.accepted} n={s.matched} />
                  <span className="text-[11px] text-ink-mute tabular-nums">
                    {s.matched === 0
                      ? 'no replies sent yet — nothing to score'
                      : `${s.accepted} of ${s.matched} replies accepted · ${Math.round((s.accepted / s.matched) * 100)}%`}
                    {s.unrelated > 0 &&
                      ` · ${s.unrelated} left out (not an edit of the draft)`}
                  </span>
                </div>

                {/* Correlation, not causation — see the caveat in the header.
                    "Accepted more/less often" is a statement about the numbers;
                    "better/worse briefing" would be a claim about the cause,
                    and the version stamp cannot support one. */}
                {verdict && (
                  <p className="mt-1.5 text-[11px] text-ink-soft">
                    {verdict.kind === 'thin' &&
                      `Too few sent replies to compare yet — a fair read needs about ${MIN_VERDICT_N} on each side.`}
                    {verdict.kind === 'same' && `No clear difference from v${verdict.prev} — the two ranges overlap.`}
                    {verdict.kind === 'better' && (
                      <span className="text-[var(--c-in-stock)]">
                        Accepted more often than v{verdict.prev} — a real difference, not chance. Worth checking what else
                        changed before crediting the rules.
                      </span>
                    )}
                    {verdict.kind === 'worse' && (
                      <span className="text-[var(--c-out)]">
                        Accepted less often than v{verdict.prev} — a real difference, not chance. Worth looking at what
                        changed around then, in the rules and in what was deployed.
                      </span>
                    )}
                  </p>
                )}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

// A 0–100% strip: the pale band is the Wilson interval (how sure we are), the
// solid tick is the measured rate. Four drafts produce a band nearly the full
// width, which is the point — the picture refuses to look confident when the
// data isn't.
function RateBar({ k, n }: { k: number; n: number }) {
  const W = 180
  const H = 10
  if (n === 0) {
    return (
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="shrink-0" role="img" aria-label="no replies scored yet">
        <rect x={0} y={H / 2 - 1.5} width={W} height={3} rx={1.5} fill="var(--c-line)" opacity={0.6} />
      </svg>
    )
  }
  const { lo, hi } = wilson(k, n)
  const p = k / n
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width={W}
      height={H}
      className="shrink-0"
      role="img"
      aria-label={`${Math.round(p * 100)}% accepted, plausibly between ${Math.round(lo * 100)}% and ${Math.round(hi * 100)}% on ${n} replies`}
    >
      <rect x={0} y={H / 2 - 1.5} width={W} height={3} rx={1.5} fill="var(--c-line)" opacity={0.6} />
      <rect x={lo * W} y={H / 2 - 4} width={Math.max((hi - lo) * W, 1)} height={8} rx={3} fill="var(--c-in-stock)" opacity={0.22} />
      <rect x={Math.min(p * W, W - 2)} y={0} width={2} height={H} rx={1} fill="var(--c-in-stock)" />
    </svg>
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
  markers,
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
  // Vertical change points — the day a new briefing first wrote a draft — so a
  // step in the line can be read against the change that might explain it.
  markers?: { index: number; label: string }[]
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

            {/* briefing change points (dashed verticals, drawn over the bars
                but under the hover targets so hovering still works) */}
            {markers?.map((m) =>
              m.index < 0 || m.index >= bars.length ? null : (
                <g key={`m${m.index}-${m.label}`}>
                  <line
                    x1={m.index * slot + slot / 2}
                    y1={plotTop}
                    x2={m.index * slot + slot / 2}
                    y2={plotBottom}
                    stroke="var(--c-brand)"
                    strokeWidth={1}
                    strokeDasharray="2 3"
                    opacity={0.7}
                  />
                  <text
                    x={m.index * slot + slot / 2 + 3}
                    y={plotTop + 9}
                    fontSize={10}
                    fill="var(--c-ink-mute)"
                  >
                    {m.label}
                  </text>
                </g>
              ),
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
