import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Send } from 'lucide-react'
import { HelpTip } from '../design'
import CollapsibleSidebarPanel from './CollapsibleSidebarPanel'
import Modal from './Modal'
import MessageSendPanel from './MessageSendPanel'
import { supabase } from '../lib/supabase'
import { relativeTime, formatAbsoluteDateTime } from '../lib/relativeTime'
import { nudgeTemplateFor } from '../lib/needsAttention'
import { snoozeProof } from '../lib/snooze'
import { firstName } from '../lib/firstName'
import { customerProofPath } from '../lib/customerProofUrl'
import { isCurrentlySnoozed, type DashboardProject } from '../lib/dashboardGrouping'
import { tagHelp } from '../lib/tagHelp'
import type { TemplateContext } from '../lib/replyTemplates'

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
//      with its reason. Skips split by whether a human can act: "Needs
//      you" (link/auth problems, the cap escalations whose labels say
//      "needs a human", and sibling suppressions — those recur every run
//      until a human sends one combined email) gets a Review affordance;
//      "Holding off" (grace window, snooze, cooldown, opt-out, follow-up
//      tag) is self-resolving and rendered low-emphasis with no action.
//      recipient_mismatch gets its own amber count chip under Needs you:
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
  // One-line plain-English explanation the sender records for outcomes a human
  // must resolve (migration 000228). Null for self-resolving/old rows.
  detail: string | null
  rendered_body: string | null
  created_at: string
}

interface StuckNudge {
  id: string
  proof_id: string
  created_at: string
}

// The sender's cron runs weekday mornings only (`0 9 * * 1-5`, 09:00 UTC), so
// "no run since yesterday" is normal across a weekend and must NOT raise the
// scheduler-down alarm. Rather than a flat hours threshold (which lit up amber
// every Sunday and Monday morning), compute the most recent run that *should*
// already have completed — the latest weekday 09:00 UTC at least
// RUN_GRACE_HOURS in the past — and treat the scheduler as down only if the
// newest run predates it (a genuinely missed run). The grace window absorbs
// cron jitter + the gap between scheduled time and the run recording itself.
const RUN_HOUR_UTC = 9
const RUN_GRACE_HOURS = 3

function mostRecentExpectedRun(now: number): number | null {
  for (let back = 0; back < 7; back++) {
    const d = new Date(now)
    const candidate = Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate() - back,
      RUN_HOUR_UTC,
      0,
      0,
      0,
    )
    const dow = new Date(candidate).getUTCDay() // 0 = Sun … 6 = Sat
    const isWeekday = dow >= 1 && dow <= 5
    if (isWeekday && now - candidate >= RUN_GRACE_HOURS * 3_600_000) {
      return candidate
    }
  }
  return null
}

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
  would_send_new_conversation:  'would send — fresh conversation',
  sent:                         'sent',
  sent_new_conversation:        'sent — fresh conversation',
  sending:                      'sending…',
  recipient_mismatch:           'email mismatch — review',
  suppressed_sibling:           'sibling proofs — send one combined email',
  skipped_customer_replied:     'customer replied — needs a human',
  skipped_conversation_missing: 'Help Scout conversation missing',
  skipped_closed_conversation:  'conversation closed',
  skipped_no_send_evidence:     'no record this version was sent',
  skipped_snoozed:              'snoozed',
  skipped_opted_out:            'auto-chasing off for this proof',
  skipped_capped:               'all reminders sent — needs a human',
  skipped_capped_lifetime:      'lifetime reminder cap reached',
  skipped_cooldown:             'too soon since the last touch',
  skipped_grace_window:         'recent reply — grace window',
  skipped_followup_tag:         'tagged "follow up" — a human owns this chase',
  skipped_us_send_window:       'held for the afternoon run (US customer)',
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

// The chase rules a designer can one-click chase from the review queue.
const REVIEW_QUEUE_RULES = new Set([
  'sent_never_viewed',
  'viewed_not_actioned',
  'approaching_dormant',
  'stuck_in_progress',
])

// How long a review-queue send auto-snoozes the proof (matches
// ResolvePopover's SNOOZE_HOURS).
const REVIEW_SNOOZE_HOURS = 72

export function NudgeOutboxPanel({
  projects,
  onAfterSend,
}: {
  projects: DashboardProject[]
  /** Called after a review-queue reminder sends, so the dashboard refetches. */
  onAfterSend?: () => void
}) {
  const [loadState, setLoadState] = useState<'loading' | 'error' | 'ready'>('loading')
  const [run, setRun] = useState<NudgeRun | null>(null)
  const [openRuns, setOpenRuns] = useState<OpenRun[]>([])
  const [rows, setRows] = useState<NudgeRow[]>([])
  const [stuckRows, setStuckRows] = useState<StuckNudge[]>([])
  // Newest greatest(helpscout_last_reply_at, helpscout_last_customer_reply_at)
  // across all proofs — the webhook-freshness signal. Null when no proof
  // carries either stamp yet.
  const [newestStampAt, setNewestStampAt] = useState<string | null>(null)
  // The automation block from needs_attention_rules — which chase rules are
  // in 'review' mode and so feed the Review-and-send queue below. Null until
  // loaded (queue hidden rather than wrong).
  const [automationConfig, setAutomationConfig] = useState<Record<
    string, { mode?: string }
  > | null>(null)
  // settings.auto_nudges_enabled — the automation master switch (000214).
  // This is the CURRENT operating mode and drives the live/dry-run pill, so
  // the panel reads as live the moment the switch is flipped rather than
  // waiting for the next scheduled run to record a 'live' row. null = not yet
  // read (or read failed) → fall back to the latest run's own mode.
  const [autoEnabled, setAutoEnabled] = useState<boolean | null>(null)
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
      const [runRes, openRes, stuckRes, staffRes, customerRes, rulesRes, settingsRes] = await Promise.all([
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
        supabase
          .from('site_settings')
          .select('needs_attention_rules')
          .eq('id', 1)
          .single(),
        supabase
          .from('settings')
          .select('auto_nudges_enabled')
          .eq('id', 1)
          .single(),
      ])
      if (cancelled) return
      if (runRes.error || openRes.error || stuckRes.error || staffRes.error || customerRes.error) {
        setLoadState('error')
        return
      }
      // The automation dials are read best-effort: a failed read just hides
      // the review queue rather than failing the whole panel.
      const rulesDoc = (rulesRes.data?.needs_attention_rules ?? null) as
        | { automation?: Record<string, { mode?: string }> }
        | null
      setAutomationConfig(rulesDoc?.automation ?? null)

      // Master switch, also best-effort: a failed read leaves autoEnabled null
      // so the pill falls back to the latest run's mode rather than mislabelling.
      setAutoEnabled(
        settingsRes.error || !settingsRes.data
          ? null
          : settingsRes.data.auto_nudges_enabled === true,
      )

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
          .select('id, proof_id, rule_code, source, state, outcome, detail, rendered_body, created_at')
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

  // The review queue (followup-automation-spec §"Review queue"): proofs whose
  // live needs-attention rule is a chase rule the admin has set to "Review
  // first". Rendered from the rules engine's output on every dashboard load —
  // no persisted nightly snapshot — and each send re-validates at click time
  // inside ReviewQueueItem. Sendable rows only: a Help Scout link and a
  // current version are what MessageSendPanel needs.
  const reviewQueue = useMemo(() => {
    if (!automationConfig) return []
    return projects.filter((p) =>
      p.rule_code != null &&
      REVIEW_QUEUE_RULES.has(p.rule_code) &&
      automationConfig[p.rule_code]?.mode === 'review' &&
      !!p.helpscout_conversation_id &&
      !!p.current_version_id &&
      p.current_version_number != null &&
      !isCurrentlySnoozed(p),
    )
  }, [projects, automationConfig])

  // ── Derived status ──────────────────────────────────────────────────────
  const now = Date.now()
  const staleOpenRuns = openRuns.filter(
    (r) => now - new Date(r.started_at).getTime() > STALE_MS,
  )
  const freshOpenRun = openRuns.some(
    (r) => now - new Date(r.started_at).getTime() <= STALE_MS,
  )
  // Scheduler-down only if a genuinely-due weekday run was missed (see
  // mostRecentExpectedRun) — not merely because it's the weekend or early
  // Monday before the morning run window.
  const expectedRunAt = mostRecentExpectedRun(now)
  const runStale =
    run != null &&
    expectedRunAt != null &&
    new Date(run.started_at).getTime() < expectedRunAt

  // The pill reflects the CURRENT operating mode (the master switch), not the
  // historical mode of the last run: right after the switch is flipped the
  // newest run may still be a pre-flip dry run, and a designer reads the pill
  // as "is the automation live?". Fall back to the run's own mode when the
  // setting couldn't be read.
  const liveMode = autoEnabled ?? run?.mode === 'live'
  // The latest recorded run was a dry run, but automatic sending is now on —
  // explain why the rows below still say "Would send".
  const liveButLastRunWasDry = autoEnabled === true && run?.mode === 'dry_run'

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
      (r.outcome ?? '').startsWith('would_send') ||
      r.state === 'sent' ||
      (r.state === 'sending' && !isStaleSending(r)),
  )
  const failedRows = rows.filter((r) => r.state === 'failed')
  const skippedRows = rows.filter(
    (r) => !sendRows.includes(r) && r.state !== 'failed' && !isStaleSending(r),
  )
  const mismatchCount = rows.filter((r) => r.outcome === 'recipient_mismatch').length

  // Split the skips by whether a human can actually do anything. The
  // self-resolving outcomes (grace window, snooze, cooldown, per-proof
  // opt-out, sibling-suppression) clear on their own and only clutter a
  // to-do read; everything else — link/auth problems and the hit-the-cap
  // escalations whose labels literally say "needs a human" — is surfaced as
  // actionable. Unknown outcomes default to actionable so a new skip reason
  // never hides silently.
  // suppressed_sibling deliberately NOT here (adversarial review 2026-06-12,
  // finding 6): siblings never self-clear — the automation refuses to email
  // any of them every single run until a human sends one combined message,
  // so they belong under "Needs you", not in the ignore pile.
  const HOLDING_OFF_OUTCOMES = new Set([
    'skipped_grace_window',
    'skipped_snoozed',
    'skipped_cooldown',
    'skipped_opted_out',
    // A human tagged the conversation "follow up" in Help Scout — the bot
    // stands down until the tag is cleared. Self-resolving by definition.
    'skipped_followup_tag',
    // USD proofs only send on the afternoon run (~11:00 New York) —
    // self-resolves the same day.
    'skipped_us_send_window',
  ])
  const holdingRows = skippedRows.filter(
    (r) => r.outcome != null && HOLDING_OFF_OUTCOMES.has(r.outcome),
  )
  const needsYouRows = skippedRows.filter((r) => !holdingRows.includes(r))

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
    <CollapsibleSidebarPanel
      icon={Send}
      iconTint="var(--c-allocated)"
      eyebrow="Outbox"
      title="Automated reminders"
      storageKey="pv.sidebar.collapsed.outbox"
    >
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
                <HelpTip
                  body={tagHelp('system', liveMode ? 'live' : 'dry_run')}
                  affordance="ring"
                >
                  <span
                    className={[
                      'inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-semibold',
                      liveMode
                        ? 'bg-in-stock-soft text-in-stock'
                        : 'bg-allocated-soft text-allocated',
                    ].join(' ')}
                  >
                    {liveMode ? 'live' : 'dry run'}
                  </span>
                </HelpTip>
              </div>
              {liveButLastRunWasDry && (
                <p className="text-[12px] text-ink-soft">
                  Automatic sending is on. The run below was a dry run from
                  before it was switched on, so the next scheduled run will send
                  for real.
                </p>
              )}
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
                  A scheduled run hasn’t arrived — the scheduler may be down.
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
                  Webhook:{' '}
                  <HelpTip body={tagHelp('system', 'webhook_fresh')}>
                    <span className="font-medium text-in-stock">fresh ✓</span>
                  </HelpTip>
                </p>
              ) : (
                <p className="text-[12px] font-medium text-low">
                  Webhook:{' '}
                  <HelpTip body={tagHelp('system', 'webhook_quiet')}>
                    <span>
                      {newestStampAt
                        ? `quiet — newest stamp ${webhookQuietDays}d ago`
                        : 'no reply stamps recorded yet'}
                    </span>
                  </HelpTip>
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

          {/* Review and send — the live queue of chase rules in "Review
              first" mode. One click re-validates, then opens the same
              pre-filled send panel the resolve popover uses; the reminder
              lands in the manual ledger (send-helpscout-reply), so it
              consumes the same cap and cooldown the automation respects. */}
          {reviewQueue.length > 0 && (
            <div className="border-b border-line-soft px-5 py-3.5">
              <div className="flex items-center gap-2 pb-1">
                <span className="eyebrow text-allocated">Review and send</span>
                <span className="text-[11px] text-ink-mute tabular-nums">
                  {reviewQueue.length}
                </span>
              </div>
              <p className="text-[11px] text-ink-soft">
                These rules are set to “Review first” — check each and send the reminder with one click.
              </p>
              <ul className="mt-1 divide-y divide-line-soft">
                {reviewQueue.map((p) => (
                  <ReviewQueueItem
                    key={p.proof_id}
                    project={p}
                    onSent={() => {
                      setReloadKey((k) => k + 1)
                      onAfterSend?.()
                    }}
                  />
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
                              <HelpTip
                                body={tagHelp('needs', r.rule_code)}
                                className="shrink-0 text-[11px] text-ink-mute"
                              >
                                {ruleShort(r.rule_code)}
                              </HelpTip>
                              {r.state === 'sending' && (
                                <span className="shrink-0 text-[11px] font-medium text-allocated">
                                  sending…
                                </span>
                              )}
                              {/* Reminder #2+ goes out as a NEW Help Scout
                                  conversation (deliverability lever) — flag
                                  it so the dry-run week shows the path. */}
                              {(r.outcome ?? '').endsWith('new_conversation') && (
                                <HelpTip
                                  body={tagHelp('outbox', 'fresh_conversation')}
                                  affordance="ring"
                                  className="shrink-0"
                                >
                                  <span className="rounded-md bg-allocated-soft px-1.5 py-0.5 text-[10px] font-semibold text-allocated">
                                    fresh conversation
                                  </span>
                                </HelpTip>
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
                            className="flex flex-col gap-1 px-5 py-2.5 transition-colors hover:bg-canvas"
                          >
                            <span className="flex items-baseline gap-2">
                              <span className="min-w-0 truncate text-[13px] font-medium text-ink">
                                {labelFor(r.proof_id)}
                              </span>
                              <span className="shrink-0 text-[11px] font-medium text-low">
                                {humaniseOutcome(r.outcome, r.state)}
                              </span>
                            </span>
                            {/* Why it failed, in plain English (migration 000228). */}
                            {r.detail && (
                              <span className="text-[11px] leading-snug text-ink-soft">
                                {r.detail}
                              </span>
                            )}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Needs you — skips stuck on something only a human can fix
                    (broken proof↔conversation link, closed conversation, the
                    cap escalations). Full-row Link to the proof with an
                    explicit Review affordance so it reads as a to-do, not a
                    log line. */}
                {needsYouRows.length > 0 && (
                  <div className="border-b border-line-soft last:border-b-0">
                    <div className="flex items-center gap-2 px-5 pt-3.5 pb-1.5">
                      <span className="eyebrow text-low">Needs you</span>
                      <span className="text-[11px] text-low tabular-nums">
                        {needsYouRows.length}
                      </span>
                      {/* Phase 1 acceptance metric — every mismatch is a
                          proof↔conversation link worth fixing. */}
                      {mismatchCount > 0 && (
                        <span className="inline-flex items-center rounded-md bg-low-soft px-2 py-0.5 text-[10px] font-semibold text-low">
                          {mismatchCount} email mismatch{mismatchCount === 1 ? '' : 'es'}
                        </span>
                      )}
                    </div>
                    <p className="px-5 pb-1.5 text-[11px] text-ink-soft">
                      Stuck on something only you can fix — open the proof to sort it out.
                    </p>
                    <ul className="divide-y divide-line-soft">
                      {needsYouRows.map((r) => (
                        <li key={r.id}>
                          <Link
                            to={`/proofs/${r.proof_id}`}
                            className="flex flex-col gap-1 px-5 py-2.5 transition-colors hover:bg-canvas"
                          >
                            <span className="flex items-baseline gap-2">
                              <span className="min-w-0 truncate text-[13px] font-medium text-ink">
                                {labelFor(r.proof_id)}
                              </span>
                              <HelpTip
                                body={tagHelp('outbox', r.outcome)}
                                className={[
                                  'shrink-0 text-[11px]',
                                  r.outcome === 'recipient_mismatch'
                                    ? 'font-medium text-low'
                                    : 'text-ink-mute',
                                ].join(' ')}
                              >
                                {humaniseOutcome(r.outcome, r.state)}
                              </HelpTip>
                              <span className="ml-auto shrink-0 text-[11px] font-medium text-ink-soft">
                                Review →
                              </span>
                            </span>
                            {/* The specific, actionable explanation the sender
                                recorded at decision time (migration 000228). */}
                            {r.detail && (
                              <span className="text-[11px] leading-snug text-ink-soft">
                                {r.detail}
                              </span>
                            )}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Holding off — self-resolving skips. Low-emphasis, no action:
                    the correct response is to do nothing, so the section says
                    so rather than dangling an actionless to-do. */}
                {holdingRows.length > 0 && (
                  <div>
                    <div className="flex items-center gap-2 px-5 pt-3.5 pb-1.5">
                      <span className="eyebrow text-ink-mute">Holding off</span>
                      <span className="text-[11px] text-ink-mute tabular-nums">
                        {holdingRows.length}
                      </span>
                    </div>
                    <p className="px-5 pb-1.5 text-[11px] text-ink-soft">
                      No action needed — these clear themselves once the wait passes or the customer replies.
                    </p>
                    <ul className="divide-y divide-line-soft">
                      {holdingRows.map((r) => (
                        <li key={r.id}>
                          <Link
                            to={`/proofs/${r.proof_id}`}
                            className="flex items-baseline gap-2 px-5 py-2 transition-colors hover:bg-canvas"
                          >
                            <span className="min-w-0 truncate text-[13px] text-ink-soft">
                              {labelFor(r.proof_id)}
                            </span>
                            <HelpTip
                              body={tagHelp('outbox', r.outcome)}
                              className="shrink-0 text-[11px] text-ink-mute"
                            >
                              {humaniseOutcome(r.outcome, r.state)}
                            </HelpTip>
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
    </CollapsibleSidebarPanel>
  )
}

// One review-queue row: proof label + rule + "Send" button. The click
// re-validates the rule against the live engine (architecture rule #1's
// manual half — this list renders from dashboard data that may be minutes
// old), then opens the same MessageSendPanel flow the resolve popover uses.
// A successful send optionally snoozes the proof for 72 hours, exactly like
// the popover's reminder path.
function ReviewQueueItem({
  project,
  onSent,
}: {
  project: DashboardProject
  onSent: () => void
}) {
  const [checking, setChecking] = useState(false)
  const [staleNote, setStaleNote] = useState<string | null>(null)
  const [showSend, setShowSend] = useState(false)
  const [snoozeAfterSend, setSnoozeAfterSend] = useState(true)

  const templateId = project.rule_code ? nudgeTemplateFor(project.rule_code) : null

  const context: TemplateContext = {
    first_name: firstName(project.contact_name ?? ''),
    full_name: project.contact_name ?? '',
    company: project.company_name,
    version_number: project.current_version_number ?? '',
    url: `${window.location.origin}${customerProofPath(project.proof_id)}`,
    designer_first_name: '',
  }

  async function openSend() {
    if (checking) return
    setChecking(true)
    setStaleNote(null)
    // Single-row re-check against the live rules engine; a cleared rule
    // shows "no longer needed" instead of sending. A fetch error falls
    // through and opens the panel — a human reads the body before sending.
    const { data, error } = await supabase
      .from('public_dashboard_projects')
      .select('rule_code')
      .eq('proof_id', project.proof_id)
      .maybeSingle()
    setChecking(false)
    if (!error && data?.rule_code !== project.rule_code) {
      setStaleNote('No longer needed — this resolved itself.')
      return
    }
    setShowSend(true)
  }

  async function handleSent() {
    if (snoozeAfterSend && project.rule_code) {
      try {
        await snoozeProof(project.proof_id, project.rule_code, REVIEW_SNOOZE_HOURS, 'Reminder sent')
      } catch (err) {
        console.error('[NudgeOutboxPanel] auto-snooze failed:', err)
      }
    }
    setShowSend(false)
    onSent()
  }

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2">
      <Link
        to={`/proofs/${project.proof_id}`}
        className="min-w-0 truncate text-[13px] font-semibold text-ink hover:underline"
      >
        {project.company_name || project.contact_name || `Proof ${project.proof_id.slice(0, 8)}…`}
      </Link>
      <HelpTip
        body={tagHelp('needs', project.rule_code)}
        className="shrink-0 text-[11px] text-ink-mute"
      >
        {project.rule_code ? ruleShort(project.rule_code) : ''}
      </HelpTip>
      {staleNote ? (
        <span className="ml-auto shrink-0 text-[11px] text-ink-mute">{staleNote}</span>
      ) : (
        <button
          type="button"
          disabled={checking || !templateId}
          onClick={() => void openSend()}
          className="ml-auto inline-flex shrink-0 items-center justify-center rounded-[6px] bg-ink px-2.5 py-1 text-[11px] font-semibold text-on-ink hover:opacity-90 disabled:opacity-50"
        >
          {checking ? 'Checking…' : 'Send reminder'}
        </button>
      )}

      {showSend && templateId && project.current_version_id && project.current_version_number != null && (
        <Modal
          open
          onClose={() => setShowSend(false)}
          ariaLabel="Send a reminder"
          panelClassName="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-y-auto rounded-2xl bg-surface p-6 shadow-xl"
        >
          <label className="mb-4 flex items-center gap-2 text-sm text-ink-soft">
            <input
              type="checkbox"
              checked={snoozeAfterSend}
              onChange={(e) => setSnoozeAfterSend(e.target.checked)}
              className="h-4 w-4 rounded border-line"
            />
            Snooze this proof for 3 days after sending
          </label>
          <MessageSendPanel
            proofId={project.proof_id}
            versionId={project.current_version_id}
            versionNumber={project.current_version_number}
            templateId={templateId}
            context={context}
            hasHelpScoutConversation={!!project.helpscout_conversation_id}
            onSent={handleSent}
            onSkip={() => setShowSend(false)}
            skipLabel="Cancel"
          />
        </Modal>
      )}
    </li>
  )
}

export default NudgeOutboxPanel
