import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'

// "Reminder performance" card for Admin → Needs-attention — the measurement
// layer from the follow-up automation spec's Analytics section. Everything
// here is DERIVED from the nudge_outcomes view (migration 000214): per
// ledger row, the first non-bot view and first customer action AFTER the
// nudge. No new tracking.
//
// Three cohorts, same two metrics each:
//   * Sent — automatic   (source auto,   state sent)
//   * Sent — manual      (source manual, state sent)
//   * Dry-run baseline   (state dry_run, outcome would_send*): proofs the
//     bot WOULD have chased while chasing nobody. Their natural view/action
//     rate over the same windows is the bar real sends are judged against —
//     like-for-like (stalled proofs vs stalled proofs), which is why dry
//     rows are retained rather than purged.
//
// Metrics (spec): open rate = first non-bot view within 3 days (indicative —
// bot-filter noise makes views untrustworthy as a primary signal); response
// rate = customer action within 7 days, OR a Help Scout reply after the
// nudge (customer_replied_after is a latest-reply approximation). Plus the
// operational-health read: skip-reason mix and how many proofs have hit the
// reminder cap.
//
// Honesty notes baked into the copy: percentages are noisy below ~30
// reminders (judge trends, not single weeks), and recent sends may not have
// had the full response window yet.

interface OutcomeRow {
  nudge_id: string
  proof_id: string
  rule_code: string
  source: 'auto' | 'manual'
  state: string
  outcome: string | null
  created_at: string
  first_view_after: string | null
  first_action_after: string | null
  customer_replied_after: boolean | null
}

const WINDOW_DAYS = 90
const OPEN_WINDOW_MS = 3 * 86_400_000
const RESPONSE_WINDOW_MS = 7 * 86_400_000
const NOISE_FLOOR = 30

interface CohortStats {
  label: string
  count: number
  opened: number
  responded: number
}

function cohortStats(label: string, rows: OutcomeRow[]): CohortStats {
  let opened = 0
  let responded = 0
  for (const r of rows) {
    const sentMs = new Date(r.created_at).getTime()
    if (r.first_view_after && new Date(r.first_view_after).getTime() - sentMs <= OPEN_WINDOW_MS) {
      opened++
    }
    const actioned = r.first_action_after != null &&
      new Date(r.first_action_after).getTime() - sentMs <= RESPONSE_WINDOW_MS
    if (actioned || r.customer_replied_after === true) responded++
  }
  return { label, count: rows.length, opened, responded }
}

function pct(part: number, whole: number): string {
  if (whole === 0) return '—'
  return `${Math.round((part / whole) * 100)}%`
}

// Humanised skip labels for the operational-health list — only the outcomes
// the sender actually writes as skips.
const SKIP_LABELS: Record<string, string> = {
  skipped_grace_window:         'Recent reply (grace window)',
  skipped_snoozed:              'Snoozed',
  skipped_cooldown:             'Cooldown between reminders',
  skipped_opted_out:            'Auto-chasing off for the proof',
  suppressed_sibling:           'Grouped with a sibling proof',
  skipped_followup_tag:         'Human "follow up" tag',
  skipped_customer_replied:     'Customer replied — human owes the next message',
  skipped_no_send_evidence:     'No record the version was sent',
  skipped_conversation_missing: 'Help Scout conversation missing',
  skipped_closed_conversation:  'Conversation closed',
  recipient_mismatch:           'Email mismatch',
  skipped_capped:               'Reminder cap reached',
  skipped_capped_lifetime:      'Lifetime ceiling reached',
}

export default function AdminReminderPerformanceCard() {
  const [rows, setRows] = useState<OutcomeRow[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString()
      // Paged read — PostgREST truncates at 1000 rows silently, and a few
      // months of nightly skip rows can pass that.
      const PAGE = 1000
      const all: OutcomeRow[] = []
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from('nudge_outcomes')
          .select('nudge_id, proof_id, rule_code, source, state, outcome, created_at, first_view_after, first_action_after, customer_replied_after')
          .gte('created_at', since)
          .order('created_at', { ascending: true })
          .range(from, from + PAGE - 1)
        if (cancelled) return
        if (error) {
          setLoadError(error.message)
          return
        }
        const page = (data ?? []) as OutcomeRow[]
        all.push(...page)
        if (page.length < PAGE) break
      }
      setRows(all)
    }
    void load()
    return () => { cancelled = true }
  }, [])

  const derived = useMemo(() => {
    if (!rows) return null
    const sentAuto = rows.filter((r) => r.state === 'sent' && r.source === 'auto')
    const sentManual = rows.filter((r) => r.state === 'sent' && r.source === 'manual')
    const baseline = rows.filter(
      (r) => r.state === 'dry_run' && (r.outcome ?? '').startsWith('would_send'),
    )
    const skips = rows.filter(
      (r) =>
        (r.state === 'skipped' || r.state === 'dry_run') &&
        r.outcome != null &&
        !(r.outcome).startsWith('would_send'),
    )
    const skipMix = new Map<string, number>()
    for (const s of skips) skipMix.set(s.outcome!, (skipMix.get(s.outcome!) ?? 0) + 1)
    const cappedProofs = new Set(
      rows
        .filter((r) => r.outcome === 'skipped_capped' || r.outcome === 'skipped_capped_lifetime')
        .map((r) => r.proof_id),
    )
    return {
      cohorts: [
        cohortStats('Sent — automatic', sentAuto),
        cohortStats('Sent — manual', sentManual),
        cohortStats('Dry-run baseline (no email sent)', baseline),
      ],
      skipMix: [...skipMix.entries()].sort((a, b) => b[1] - a[1]),
      cappedProofCount: cappedProofs.size,
      totalSent: sentAuto.length + sentManual.length,
    }
  }, [rows])

  return (
    <div className="rounded-2xl bg-surface p-5 shadow-sm ring-1 ring-line">
      <h3 className="text-sm font-semibold text-ink">Reminder performance</h3>
      <p className="mt-1 text-xs text-ink-mute">
        Last {WINDOW_DAYS} days, from the reminder ledger. Opened = first view within 3 days of the
        reminder; responded = approval, change request or Help Scout reply within 7 days. The dry-run
        baseline shows how the same kind of stalled proof behaves with no reminder at all — that&rsquo;s
        the bar real sends have to beat.
      </p>

      {loadError ? (
        <p className="mt-3 text-xs text-out">Couldn&rsquo;t load reminder outcomes: {loadError}</p>
      ) : !derived ? (
        <p className="mt-3 text-xs text-ink-mute">Loading…</p>
      ) : (
        <>
          <table className="mt-3 w-full text-sm">
            <thead>
              <tr className="text-left text-xs font-medium uppercase tracking-wider text-ink-mute">
                <th className="py-1.5 pr-2 font-medium">Cohort</th>
                <th className="py-1.5 pr-2 text-right font-medium">Reminders</th>
                <th className="py-1.5 pr-2 text-right font-medium">Opened ≤3d</th>
                <th className="py-1.5 text-right font-medium">Responded ≤7d</th>
              </tr>
            </thead>
            <tbody>
              {derived.cohorts.map((c) => (
                <tr key={c.label} className="border-t border-line-soft">
                  <td className="py-1.5 pr-2 text-ink">{c.label}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums text-ink">{c.count}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums text-ink">
                    {pct(c.opened, c.count)}
                    {c.count > 0 && <span className="text-ink-mute"> ({c.opened})</span>}
                  </td>
                  <td className="py-1.5 text-right tabular-nums text-ink">
                    {pct(c.responded, c.count)}
                    {c.count > 0 && <span className="text-ink-mute"> ({c.responded})</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {derived.totalSent < NOISE_FLOOR && (
            <p className="mt-2 text-xs text-ink-mute">
              Fewer than {NOISE_FLOOR} reminders sent so far — percentages are noisy at this volume;
              judge trends, not single weeks. Recent sends may not have had the full response window yet.
            </p>
          )}

          {(derived.skipMix.length > 0 || derived.cappedProofCount > 0) && (
            <div className="mt-4 border-t border-line pt-3">
              <div className="text-xs font-medium uppercase tracking-wider text-ink-mute">
                Why reminders held off
              </div>
              <ul className="mt-1.5 space-y-0.5">
                {derived.skipMix.map(([outcome, n]) => (
                  <li key={outcome} className="flex items-baseline justify-between gap-3 text-xs">
                    <span className="text-ink-soft">{SKIP_LABELS[outcome] ?? outcome.replace(/_/g, ' ')}</span>
                    <span className="tabular-nums text-ink">{n}</span>
                  </li>
                ))}
              </ul>
              {derived.cappedProofCount > 0 && (
                <p className="mt-2 text-xs text-ink-soft">
                  <span className="font-semibold text-ink">{derived.cappedProofCount}</span> proof
                  {derived.cappedProofCount === 1 ? ' has' : 's have'} hit the reminder cap — these
                  carry the “needs a call” chip on the dashboard.
                </p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
