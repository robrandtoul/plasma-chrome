import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Send } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { relativeTime, formatAbsoluteDateTime } from '../lib/relativeTime'
import type { DashboardProject } from '../lib/dashboardGrouping'

// Dashboard Outbox panel for the follow-up automation feature (Phase 1,
// docs/followup-automation-spec.md). Sits in the dashboard aside under
// Latest activity and surfaces the four things a designer needs to trust
// the automation before (and after) it goes live:
//
//   1. Heartbeat — the newest nudge_runs row (migration 000214). A dead
//      nightly job must be distinguishable from "nobody needed chasing",
//      so a stale run renders an amber warning rather than silence. The
//      sender gates live sends on ANY unfinished run row (not just the
//      newest), so open rows are queried separately: a stale one shows the
//      amber pause warning with a Mark-as-cleared button (the
//      resolve_nudge_run RPC); a fresh one is just a run in flight.
//   2. Webhook freshness — the newest Help Scout reply stamp across all
//      proofs (000208). Multi-day quiet at Plasma's volume signals a dead
//      webhook, which would blind the customer-reply hard-skip.
//   3. The latest run's ledger rows (auto-sourced only — manual designer
//      nudges share the table and would otherwise render as bot output) —
//      what the run would have sent (dry run) or sent (live), with the
//      rendered body inspectable verbatim, plus failures and every skip
//      with its reason. recipient_mismatch gets its own amber count chip:
//      it is the Phase 1 acceptance metric, and each hit marks a
//      proof↔conversation link worth fixing in /admin/customers.
//   4. Needs verification — a standing section, independent of the
//      latest-run window: stale 'sending' claims mean the sender died
//      between claiming and confirming, so a human checks the Help Scout
//      thread and resolves via the resolve_stuck_nudge RPC.
//
// nudge_runs / proof_nudges are SELECT-only for authenticated; the only
// writes from here are the two narrow SECURITY DEFINER human-action RPCs
// above (000214), so the ledger stays trustworthy. Contact and company
// names come from a client-side join against the dashboard's
// already-loaded projects array rather than another query.

interface NudgeRun {
  id: string
  started_at: string
  finished_at: string | null
  mode: 'dry_run' | 'live'
  candidates_computed: number | null
  sent: number | null
  skipped: number | null
  errors: Array<Record<string, unknown>> | null
}

interface OpenRun {
  id: string
  started_at: string
}

interface NudgeRow {
  id: string
  proof_id: string
  rule_code: string
  source: 'auto' | 'manual'
  state: 'sending' | 'sent' | 'failed' | 'skipped' | 'dry_run'
  outcome: string | null
  rendered_body: string | null
  created_at: string
}

interface StuckNudge {
  id: string
  proof_id: string
  created_at: string
}

// The job runs each weekday morning, so >25 hours without a run means the
// scheduler is dead or stuck. Weekends will show amber by Sunday — accepted
// Phase 1 noise; better than missing a dead cron for days.
const RUN_STALE_HOURS = 25

// Open run rows / 'sending' claims older than this are treated as crashed.
// Matches resolve_stuck_nudge's own guard (the RPC refuses rows younger
// than 15 minutes), so the buttons only render where the RPC would act;
// younger means genuinely in flight, which is no alarm.
const STALE_MS = 15 * 60_000

// Webhook stamps older than this render the amber "quiet" state.
const WEBHOOK_FRESH_HOURS = 72

// Humanised labels for the ledger outcome codes the sender actually writes
// (send-nudges/index.ts + _shared/nudgeDecision.ts — the column is free
// text, no CHECK). Prefixed values ('render_failed: …', 'failed: …') are
// handled in humaniseOutcome; anything else unknown falls through to an
// underscores-to-spaces rendering.
const OUTCOME_LABELS: Record<string, string> = {
  would_send:                   'would send',
  sent:                         'sent',
  sending:                      'sending…',
  recipient_mismatch:           'email mismatch — review',
  suppressed_sibling:           'grouped with sibling proof',
  skipped_customer_replied:     'customer replied — needs a human',
  skipped_conversation_missing: 'Help Scout conversation missing',
  skipped_closed_conversation:  'conversation closed',
  skipped_no_send_evidence:     'no record this version was sent',
  skipped_snoozed:              'snoozed',
  skipped_opted_out:            'auto-chasing off for this proof',
  skipped_capped:               '2 reminders sent — needs a human',
  skipped_capped_lifetime:      'lifetime reminder cap reached',
  skipped_cooldown:             'too soon since the last touch',
  skipped_grace_window:         'recent reply — grace window',
}

function humaniseOutcome(outcome: string | null, state: NudgeRow['state']): string {
  if (!outcome) return state === 'failed' ? 'failed' : 'skipped'
  if (outcome.startsWith('render_failed:')) {
    return `template problem — ${outcome.slice('render_failed:'.length).trim()}`
  }
  if (outcome.startsWith('failed:')) {
    return `failed — ${outcome.slice('failed:'.length).trim()}`
  }
  return OUTCOME_LABELS[outcome] ?? outcome.replace(/_/g, ' ')
}

// Short per-rule descriptor shown beside the proof name on would-send rows.
const RULE_SHORT: Record<string, string> = {
  sent_never_viewed:   'never opened',
  viewed_not_actioned: 'viewed, no action',
  approaching_dormant: 'approaching dormant',
  stuck_in_progress:   'stuck in progress',
}

function ruleShort(code: string): string {
  return RULE_SHORT[code] ?? code.replace(/_/g, ' ')
}

export function NudgeOutboxPanel({ projects }: { projects: DashboardProject[] }) {
  const [loadState, setLoadState] = useState<'loading' | 'error' | 'ready'>('loading')
  const [run, setRun] = useState<NudgeRun | null>(null)
  const [openRuns, setOpenRuns] = useState<OpenRun[]>([])
  const [rows, setRows] = useState<NudgeRow[]>([])
  const [stuckRows, setStuckRows] = useState<StuckNudge[]>([])
  // Newest greatest(helpscout_last_reply_at, helpscout_last_customer_reply_at)
  // across all proofs — the webhook-freshness signal. Null when no proof
  // carries either stamp yet.
  const [newestStampAt, setNewestStampAt] = useState<string | null>(null)
  // Bumped after a successful human action so the panel refetches; the
  // existing content stays on screen during the refetch (no loading flash).
  const [reloadKey, setReloadKey] = useState(0)
  const [resolving, setResolving] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function load() {
      // Five small queries up front: the latest heartbeat row, every open
      // run row (the sender pauses live sends while ANY unfinished run
      // exists, so the warning must mirror that exactly — not limit 1),
      // the standing stale-'sending' check (any date: an interrupted send
      // must not vanish when a newer run opens a fresh window), plus the
      // two per-column freshness maxes (an .order().limit(1) each — the
      // view layer exposes no server-side aggregate, and two single-row
      // reads are cheap). The greater of the two stamps is the webhook
      // signal.
      const [runRes, openRes, stuckRes, staffRes, customerRes] = await Promise.all([
        supabase
          .from('nudge_runs')
          .select('id, started_at, finished_at, mode, candidates_computed, sent, skipped, errors')
          .order('started_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from('nudge_runs')
          .select('id, started_at')
          .is('finished_at', null)
          .order('started_at', { ascending: true }),
        supabase
          .from('proof_nudges')
          .select('id, proof_id, created_at')
          .eq('state', 'sending')
          .lt('created_at', new Date(Date.now() - STALE_MS).toISOString())
          .order('created_at', { ascending: true }),
        supabase
          .from('proofs')
          .select('helpscout_last_reply_at')
          .not('helpscout_last_reply_at', 'is', null)
          .order('helpscout_last_reply_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from('proofs')
          .select('helpscout_last_customer_reply_at')
          .not('helpscout_last_customer_reply_at', 'is', null)
          .order('helpscout_last_customer_reply_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ])
      if (cancelled) return
      if (runRes.error || openRes.error || stuckRes.error || staffRes.error || customerRes.error) {
        setLoadState('error')
        return
      }

      const staffAt = (staffRes.data?.helpscout_last_reply_at ?? null) as string | null
      const customerAt = (customerRes.data?.helpscout_last_customer_reply_at ?? null) as string | null
      const stamps = [staffAt, customerAt].filter((t): t is string => t != null)
      setNewestStampAt(
        stamps.length === 0
          ? null
          : stamps.reduce((a, b) => (new Date(a).getTime() >= new Date(b).getTime() ? a : b)),
      )

      setOpenRuns((openRes.data ?? []) as OpenRun[])
      setStuckRows((stuckRes.data ?? []) as StuckNudge[])

      const latestRun = (runRes.data ?? null) as NudgeRun | null
      setRun(latestRun)

      if (latestRun) {
        // The latest run's ledger rows: everything written since it started,
        // newest first. The run is the only writer in that window (one job,
        // one pass), so created_at >= started_at is the cheap, index-friendly
        // way to scope to it without a run_id column. Auto rows only — a
        // manual designer nudge landing mid-window would otherwise render as
        // bot output.
        const rowsRes = await supabase
          .from('proof_nudges')
          .select('id, proof_id, rule_code, source, state, outcome, rendered_body, created_at')
          .eq('source', 'auto')
          .gte('created_at', latestRun.started_at)
          .order('created_at', { ascending: false })
        if (cancelled) return
        if (rowsRes.error) {
          setLoadState('error')
          return
        }
        setRows((rowsRes.data ?? []) as NudgeRow[])
      } else {
        setRows([])
      }

      setLoadState('ready')
    }
    void load()
    return () => { cancelled = true }
  }, [reloadKey])

  // proof_id → "Company" (or contact name) for the row labels, joined
  // client-side against the dashboard's already-loaded projects. Proofs
  // outside the working set fall back to a shortened proof id.
  const labelByProof = useMemo(() => {
    const m = new Map<string, string>()
    for (const p of projects) {
      const label = p.company_name || p.contact_name
      if (label) m.set(p.proof_id, label)
    }
    return m
  }, [projects])

  function labelFor(proofId: string): string {
    return labelByProof.get(proofId) ?? `Proof ${proofId.slice(0, 8)}…`
  }

  // ── Derived status ──────────────────────────────────────────────────────
  const now = Date.now()
  const staleOpenRuns = openRuns.filter(
    (r) => now - new Date(r.started_at).getTime() > STALE_MS,
  )
  const freshOpenRun = openRuns.some(
    (r) => now - new Date(r.started_at).getTime() <= STALE_MS,
  )
  const runStale =
    run != null &&
    now - new Date(run.started_at).getTime() > RUN_STALE_HOURS * 3_600_000

  const webhookFresh =
    newestStampAt != null &&
    now - new Date(newestStampAt).getTime() <= WEBHOOK_FRESH_HOURS * 3_600_000
  const webhookQuietDays = newestStampAt
    ? Math.floor((now - new Date(newestStampAt).getTime()) / 86_400_000)
    : null

  // A stale 'sending' row in the window lives in Needs verification, not in
  // the run groups; a fresh one is genuinely in flight and shows under
  // Sent/Would-send as "sending…".
  const isStaleSending = (r: NudgeRow) =>
    r.state === 'sending' && now - new Date(r.created_at).getTime() > STALE_MS
  const sendRows = rows.filter(
    (r) =>
      r.outcome === 'would_send' ||
      r.state === 'sent' ||
      (r.state === 'sending' && !isStaleSending(r)),
  )
  const failedRows = rows.filter((r) => r.state === 'failed')
  const skippedRows = rows.filter(
    (r) => !sendRows.includes(r) && r.state !== 'failed' && !isStaleSending(r),
  )
  const mismatchCount = rows.filter((r) => r.outcome === 'recipient_mismatch').length

  // ── Human actions (the two 000214 SECURITY DEFINER RPCs) ────────────────
  async function clearStaleRuns() {
    setResolving(true)
    try {
      // Sequential on purpose — at most a handful of rows, and stopping on
      // the first error leaves the rest visible for a retry.
      for (const r of staleOpenRuns) {
        const { error } = await supabase.rpc('resolve_nudge_run', {
          p_run_id: r.id,
          p_note: 'cleared from Outbox',
        })
        if (error) break
      }
    } finally {
      setResolving(false)
      setReloadKey((k) => k + 1)
    }
  }

  async function resolveStuck(nudgeId: string, delivered: boolean) {
    setResolving(true)
    try {
      await supabase.rpc('resolve_stuck_nudge', {
        p_nudge_id: nudgeId,
        p_delivered: delivered,
      })
    } finally {
      setResolving(false)
      setReloadKey((k) => k + 1)
    }
  }

  return (
    <div className="rounded-[14px] bg-surface border border-line overflow-hidden">
      {/* Header — same chrome as LatestActivityPanel: 32px tinted icon
          square + eyebrow + display heading over a soft hairline. */}
      <div className="flex items-center gap-3 px-5 pt-5 pb-4 border-b border-line-soft">
        <span
          aria-hidden="true"
          className="inline-flex items-center justify-center w-8 h-8 rounded-md shrink-0"
          style={{
            backgroundColor: 'color-mix(in srgb, var(--c-allocated) 14%, transparent)',
            color: 'var(--c-allocated)',
          }}
        >
          <Send size={16} />
        </span>
        <div className="min-w-0">
          <div className="eyebrow text-ink-mute">Outbox</div>
          <h2 className="font-display font-medium tracking-[-0.02em] text-ink leading-tight m-0 text-[20px]">
            Automated reminders
          </h2>
        </div>
      </div>

      {loadState === 'loading' ? (
        <p className="px-5 py-8 text-center text-sm text-ink-mute">Loading…</p>
      ) : loadState === 'error' ? (
        <p className="px-5 py-8 text-center text-sm text-ink-mute">
          Couldn’t load the outbox just now.
        </p>
      ) : (
        <>
          {run ? (
            // Heartbeat + open runs + run errors + webhook freshness.
            <div className="space-y-2 px-5 py-3.5 border-b border-line-soft">
              <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-soft">
                <span>
                  Last run:{' '}
                  <span
                    className="font-medium text-ink"
                    title={formatAbsoluteDateTime(run.started_at)}
                  >
                    {relativeTime(run.started_at)}
                  </span>
                </span>
                <span
                  className={[
                    'inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-semibold',
                    run.mode === 'live'
                      ? 'bg-in-stock-soft text-in-stock'
                      : 'bg-allocated-soft text-allocated',
                  ].join(' ')}
                >
                  {run.mode === 'live' ? 'live' : 'dry run'}
                </span>
              </div>
              {freshOpenRun && (
                <p className="text-[12px] text-ink-soft">A run is in progress…</p>
              )}
              {staleOpenRuns.length > 0 && (
                <div className="space-y-1.5 rounded-md bg-low-soft px-2.5 py-2">
                  <p className="text-[11px] font-medium text-low">
                    {staleOpenRuns.length === 1
                      ? 'A run never finished — live sending is paused until it’s cleared.'
                      : `${staleOpenRuns.length} runs never finished — live sending is paused until they’re cleared.`}
                  </p>
                  <button
                    type="button"
                    disabled={resolving}
                    onClick={() => void clearStaleRuns()}
                    className="inline-flex items-center justify-center rounded-[6px] border border-line bg-surface px-2.5 py-1 text-[11px] font-medium text-ink-soft hover:bg-canvas disabled:opacity-50"
                  >
                    {staleOpenRuns.length === 1 ? 'Mark as cleared' : 'Mark all as cleared'}
                  </button>
                </div>
              )}
              {runStale && (
                <p className="rounded-md bg-low-soft px-2.5 py-1.5 text-[11px] font-medium text-low">
                  No run for over 25 hours — the scheduler may be down.
                </p>
              )}
              {Array.isArray(run.errors) && run.errors.length > 0 && (
                // The run row's errors jsonb — raw entries behind a
                // disclosure so a partial failure is visible without
                // opening the function logs.
                <details className="rounded-md bg-low-soft px-2.5 py-1.5">
                  <summary className="cursor-pointer text-[11px] font-medium text-low">
                    {run.errors.length} error{run.errors.length === 1 ? '' : 's'} in this run
                  </summary>
                  <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap text-[10px] leading-relaxed text-low">
                    {JSON.stringify(run.errors, null, 2)}
                  </pre>
                </details>
              )}
              {webhookFresh ? (
                <p className="text-[12px] text-ink-soft">
                  Webhook: <span className="font-medium text-in-stock">fresh ✓</span>
                </p>
              ) : (
                <p className="text-[12px] font-medium text-low">
                  {newestStampAt
                    ? `Webhook: quiet — newest stamp ${webhookQuietDays}d ago`
                    : 'Webhook: no reply stamps recorded yet'}
                </p>
              )}
            </div>
          ) : (
            // Pre-first-run state — the panel ships before the scheduler does.
            <p className="px-5 py-8 text-center text-sm text-ink-mute">
              No runs yet — the nightly job hasn’t had its first run.
            </p>
          )}

          {/* Needs verification — standing, window-independent: these rows
              must never disappear when a new run starts. */}
          {stuckRows.length > 0 && (
            <div className="border-b border-line-soft px-5 py-3.5">
              <div className="flex items-center gap-2 pb-1">
                <span className="eyebrow text-low">Needs verification</span>
                <span className="text-[11px] text-ink-mute tabular-nums">
                  {stuckRows.length}
                </span>
              </div>
              <p className="text-[11px] text-ink-soft">
                A send was interrupted — check whether the reminder reached Help Scout
                before resolving.
              </p>
              <ul className="mt-1 divide-y divide-line-soft">
                {stuckRows.map((r) => (
                  <li
                    key={r.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2"
                  >
                    <Link
                      to={`/proofs/${r.proof_id}`}
                      className="min-w-0 truncate text-[13px] font-semibold text-ink hover:underline"
                    >
                      {labelFor(r.proof_id)}
                    </Link>
                    <span
                      className="text-[11px] text-ink-mute"
                      title={formatAbsoluteDateTime(r.created_at)}
                    >
                      {relativeTime(r.created_at)}
                    </span>
                    <div className="ml-auto flex shrink-0 items-center gap-1.5">
                      <button
                        type="button"
                        disabled={resolving}
                        onClick={() => void resolveStuck(r.id, true)}
                        className="inline-flex items-center justify-center rounded-[6px] border border-line px-2.5 py-1 text-[11px] font-medium text-ink-soft hover:bg-canvas disabled:opacity-50"
                      >
                        It sent
                      </button>
                      <button
                        type="button"
                        disabled={resolving}
                        onClick={() => void resolveStuck(r.id, false)}
                        className="inline-flex items-center justify-center rounded-[6px] border border-line px-2.5 py-1 text-[11px] font-medium text-ink-soft hover:bg-canvas disabled:opacity-50"
                      >
                        It didn’t send
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {run && (
            rows.length === 0 ? (
              <p className="px-5 py-6 text-center text-sm text-ink-mute">
                No candidates in the latest run.
              </p>
            ) : (
              <div className="max-h-[420px] overflow-y-auto">
                {sendRows.length > 0 && (
                  <div className="border-b border-line-soft last:border-b-0">
                    <div className="flex items-center gap-2 px-5 pt-3.5 pb-1.5">
                      <span className="eyebrow text-ink-mute">
                        {run.mode === 'live' ? 'Sent' : 'Would send'}
                      </span>
                      <span className="text-[11px] text-ink-mute tabular-nums">
                        {sendRows.length}
                      </span>
                    </div>
                    <ul className="divide-y divide-line-soft">
                      {sendRows.map((r) => (
                        <li key={r.id}>
                          {/* <details> so the fully-rendered body is one click
                              away — the dry-run week is when a blank {url} or
                              greeting must be spotted, so the body shows
                              verbatim, not the template id. */}
                          <details className="group">
                            <summary className="flex cursor-pointer items-baseline gap-2 px-5 py-2.5 transition-colors hover:bg-canvas list-none [&::-webkit-details-marker]:hidden">
                              <span className="min-w-0 truncate text-[13px] font-semibold text-ink">
                                {labelFor(r.proof_id)}
                              </span>
                              <span className="shrink-0 text-[11px] text-ink-mute">
                                {ruleShort(r.rule_code)}
                              </span>
                              {r.state === 'sending' && (
                                <span className="shrink-0 text-[11px] font-medium text-allocated">
                                  sending…
                                </span>
                              )}
                              {/* Disclosure chevron — the flex summary hides the
                                  native marker, so restate the affordance. */}
                              <svg
                                aria-hidden
                                viewBox="0 0 16 16"
                                className="ml-auto h-3 w-3 shrink-0 self-center text-ink-dim transition-transform group-open:rotate-90"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              >
                                <polyline points="6 4 10 8 6 12" />
                              </svg>
                            </summary>
                            <div className="space-y-2 px-5 pb-3">
                              {r.rendered_body ? (
                                <div className="whitespace-pre-wrap rounded-md border border-line-soft bg-canvas px-3 py-2 text-[12px] leading-relaxed text-ink-soft">
                                  {r.rendered_body}
                                </div>
                              ) : (
                                <p className="text-[11px] text-ink-mute">
                                  No rendered body recorded on this row.
                                </p>
                              )}
                              <Link
                                to={`/proofs/${r.proof_id}`}
                                className="inline-flex text-[11px] font-medium text-ink-soft underline underline-offset-2 hover:text-ink"
                              >
                                Open proof
                              </Link>
                            </div>
                          </details>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {failedRows.length > 0 && (
                  <div className="border-b border-line-soft last:border-b-0">
                    <div className="flex items-center gap-2 px-5 pt-3.5 pb-1.5">
                      <span className="eyebrow text-low">Failed</span>
                      <span className="text-[11px] text-low tabular-nums">
                        {failedRows.length}
                      </span>
                    </div>
                    <ul className="divide-y divide-line-soft">
                      {failedRows.map((r) => (
                        <li key={r.id}>
                          <Link
                            to={`/proofs/${r.proof_id}`}
                            className="flex items-baseline gap-2 px-5 py-2.5 transition-colors hover:bg-canvas"
                          >
                            <span className="min-w-0 truncate text-[13px] font-medium text-ink">
                              {labelFor(r.proof_id)}
                            </span>
                            <span className="shrink-0 text-[11px] font-medium text-low">
                              {humaniseOutcome(r.outcome, r.state)}
                            </span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {skippedRows.length > 0 && (
                  <div>
                    <div className="flex items-center gap-2 px-5 pt-3.5 pb-1.5">
                      <span className="eyebrow text-ink-mute">Skipped</span>
                      <span className="text-[11px] text-ink-mute tabular-nums">
                        {skippedRows.length}
                      </span>
                      {/* Phase 1 acceptance metric — every mismatch is a
                          proof↔conversation link worth fixing. */}
                      {mismatchCount > 0 && (
                        <span className="inline-flex items-center rounded-md bg-low-soft px-2 py-0.5 text-[10px] font-semibold text-low">
                          {mismatchCount} email mismatch{mismatchCount === 1 ? '' : 'es'}
                        </span>
                      )}
                    </div>
                    <ul className="divide-y divide-line-soft">
                      {skippedRows.map((r) => (
                        <li key={r.id}>
                          <Link
                            to={`/proofs/${r.proof_id}`}
                            className="flex items-baseline gap-2 px-5 py-2.5 transition-colors hover:bg-canvas"
                          >
                            <span className="min-w-0 truncate text-[13px] font-medium text-ink">
                              {labelFor(r.proof_id)}
                            </span>
                            <span
                              className={[
                                'shrink-0 text-[11px]',
                                r.outcome === 'recipient_mismatch'
                                  ? 'font-medium text-low'
                                  : 'text-ink-mute',
                              ].join(' ')}
                            >
                              {humaniseOutcome(r.outcome, r.state)}
                            </span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )
          )}
        </>
      )}
    </div>
  )
}

export default NudgeOutboxPanel
