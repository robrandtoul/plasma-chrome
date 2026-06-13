import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { logAudit } from '../../lib/audit'
import { Pill, type PillColour, ButtonInk, ButtonGhost } from '../../design'
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
  edit_class: EditClass | null
  edit_similarity: number | null
  sent_body: string | null
}

// How often the open panel re-fetches itself (silent background refresh).
// At a few drafts a day this is plenty live, and only runs while the tab is
// visible — see the polling effect below.
const POLL_MS = 25_000

// Opus 4.8 USD per-million rates; cache read 0.1x, cache write 1.25x.
const RATE_IN = 5
const RATE_OUT = 25
function rowCostUsd(r: DraftRow): number {
  return (
    ((r.usage_input ?? 0) / 1e6) * RATE_IN +
    ((r.usage_output ?? 0) / 1e6) * RATE_OUT +
    ((r.usage_cache_read ?? 0) / 1e6) * RATE_IN * 0.1 +
    ((r.usage_cache_write ?? 0) / 1e6) * RATE_IN * 1.25
  )
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

  // A poll must not overwrite the mode pill while the user is mid mode-change,
  // or the confirm panel's "current → pending" framing would jump under them.
  // A ref so the (mount-only) poll loop reads the latest value without the
  // interval being torn down and recreated on every keystroke of state.
  const busyRef = useRef(false)
  useEffect(() => { busyRef.current = pendingMode !== null || modeWorking }, [pendingMode, modeWorking])

  // One fetch of mode + the last 7 days of decisions. Returns the data, or an
  // error string so callers can decide: the initial load replaces the page
  // with an error card; a background poll swallows it and keeps the last good
  // data, so a momentary network blip never blanks the table.
  async function fetchData(): Promise<{ mode: Mode; rows: DraftRow[] } | { error: string }> {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const [settingsRes, rowsRes] = await Promise.all([
      supabase.from('settings').select('ai_drafts_mode').eq('id', 1).single(),
      supabase
        .from('ai_drafts')
        .select(
          'id, created_at, category, confidence, state, draft_body, note_body, abstain_or_block_reason, summary, usage_input, usage_output, usage_cache_read, usage_cache_write, edit_class, edit_similarity, sent_body',
        )
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(400),
    ])
    if (settingsRes.error) return { error: settingsRes.error.message }
    if (rowsRes.error) return { error: rowsRes.error.message }
    return { mode: (settingsRes.data?.ai_drafts_mode ?? 'off') as Mode, rows: (rowsRes.data ?? []) as DraftRow[] }
  }

  // First open: show the spinner, surface a hard error if it fails.
  async function initialLoad() {
    setLoading(true)
    const res = await fetchData()
    if ('error' in res) { setLoadError(res.error); setLoading(false); return }
    setMode(res.mode)
    setRows(res.rows)
    setLastUpdated(new Date())
    setLoading(false)
  }

  // Background refresh: swap rows in place, never toggle the page spinner, never
  // blank on a transient error, and leave the mode display alone while the user
  // is changing it. The open/expanded row survives because it is keyed by id.
  async function refresh() {
    const res = await fetchData()
    if ('error' in res) return
    setRows(res.rows)
    if (!busyRef.current) setMode(res.mode)
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

  const stats = useMemo(() => {
    const byOutcome: Record<Outcome, number> = { drafted: 0, abstained: 0, blocked: 0, skipped: 0 }
    const byEdit: Record<EditClass, number> = { sent_as_is: 0, lightly_edited: 0, rewritten: 0, discarded: 0 }
    const byCat: Record<string, { drafted: number; accepted: number; matched: number }> = {}
    let cost = 0
    let matched = 0
    for (const r of rows) {
      const o = outcomeOf(r)
      byOutcome[o]++
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
    return { byOutcome, byEdit, byCat, cost, matched, total: rows.length }
  }, [rows])

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
      <section className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Drafted" value={stats.byOutcome.drafted} />
        <Stat label="Abstained" value={stats.byOutcome.abstained} />
        <Stat label="Blocked" value={stats.byOutcome.blocked} tone={stats.byOutcome.blocked > 0 ? 'warn' : undefined} />
        <Stat label="Spam skipped" value={stats.byOutcome.skipped} />
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
              const isOpen = expanded === r.id
              return (
                <li key={r.id} className="border-b border-line-soft last:border-b-0">
                  <button
                    onClick={() => setExpanded(isOpen ? null : r.id)}
                    className="w-full text-left px-5 py-3 hover:bg-canvas transition-colors"
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs text-ink-mute tabular-nums w-[84px] shrink-0">{fmtTime(r.created_at)}</span>
                      <Pill colour={OUTCOME_PILL[outcome]}>{outcome}</Pill>
                      {r.category && <Pill colour="neutral">{r.category}</Pill>}
                      {r.edit_class && <Pill colour={EDIT_PILL[r.edit_class]}>{EDIT_LABEL[r.edit_class]}</Pill>}
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
