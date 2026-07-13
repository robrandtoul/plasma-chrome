import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { attentionReason, attentionShortLabel } from '../lib/needsAttention'
import type { NeedsAttentionMeta } from '../lib/dashboardGrouping'
import { relativeTime } from '../lib/relativeTime'

// "Follow-up pipeline" — the stage view of every project the automated
// reminder system is working, for Admin → Follow-ups. The dashboard's
// "In auto follow-up" tile answers HOW MANY; this answers WHERE EACH ONE IS:
// queued / after reminder N / all reminders sent (holding) / handed to the
// team — with, per project, when the last reminder went, roughly when the
// next is due, and whether the customer has shown signs of life since.
//
// Read-only and derived: one select on public_dashboard_projects (the
// follow_up_* columns from 000246/000307 plus the customer-signal
// timestamps) and the automation dials from site_settings. No new tracking,
// no writes, and nothing here feeds back into the sender.
//
// Due dates are ESTIMATES: the real sender also honours snoozes, the reply
// grace window, bank holidays, sibling grouping, and (for USD customers)
// the afternoon-run window — so the copy says "~". Good enough to see at a
// glance what tomorrow's runs will pick up.

export interface PipelineProjectRow {
  proof_id: string
  contact_name: string | null
  company_name: string | null
  material_display: string | null
  current_version_number: number | null
  rule_code: string | null
  rule_meta: NeedsAttentionMeta | null
  follow_up_rule_code: string | null
  follow_up_sent_count: number | null
  follow_up_max_nudges: number | null
  follow_up_last_sent_at: string | null
  current_version_viewed_at: string | null
  helpscout_last_customer_reply_at: string | null
  latest_non_view_event_at: string | null
  latest_non_view_event_type: string | null
}

type AutomationDials = Record<string, { repeat_days?: number; max_nudges?: number } | undefined>

// Twin of COOLDOWN_STRETCH_WD in supabase/functions/_shared/nudgeDecision.ts
// (edge functions have no import path into src/): the gap before reminder N
// is repeat_days + 2 × (N − 2) working days. Change one, change both.
const COOLDOWN_STRETCH_WD = 2

const PIPELINE_COLUMNS =
  'proof_id, contact_name, company_name, material_display, current_version_number, ' +
  'rule_code, rule_meta, follow_up_rule_code, follow_up_sent_count, follow_up_max_nudges, ' +
  'follow_up_last_sent_at, current_version_viewed_at, helpscout_last_customer_reply_at, ' +
  'latest_non_view_event_at, latest_non_view_event_type'

// Weekend-skipping day adder for the "~due" estimates. Deliberately ignores
// bank holidays — the sender is stricter, and the tilde carries the slack.
function addWorkingDays(fromIso: string, days: number): Date {
  const d = new Date(fromIso)
  let added = 0
  while (added < days) {
    d.setDate(d.getDate() + 1)
    const dow = d.getDay()
    if (dow !== 0 && dow !== 6) added++
  }
  return d
}

function shortDate(d: Date): string {
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
}

function afterLastSent(row: PipelineProjectRow, iso: string | null): boolean {
  if (!row.follow_up_last_sent_at || !iso) return false
  return Date.parse(iso) > Date.parse(row.follow_up_last_sent_at)
}

// The single strongest customer signal since the last reminder — one quiet
// badge per row, not a scoreboard.
function reEngagement(row: PipelineProjectRow): { label: string; strong: boolean } | null {
  if (
    afterLastSent(row, row.latest_non_view_event_at) &&
    ['approve', 'request_changes'].includes(row.latest_non_view_event_type ?? '')
  ) {
    return { label: 'Responded since', strong: true }
  }
  if (afterLastSent(row, row.helpscout_last_customer_reply_at)) {
    return { label: 'Replied since', strong: true }
  }
  if (afterLastSent(row, row.current_version_viewed_at)) {
    return { label: 'Viewed since', strong: false }
  }
  return null
}

interface Stage {
  key: string
  label: string
  colour: string
  rows: PipelineProjectRow[]
}

function buildStages(rows: PipelineProjectRow[]): Stage[] {
  const team = rows.filter((r) => r.rule_code === 'nudges_exhausted')
  const chased = rows.filter(
    (r) => r.rule_code !== 'nudges_exhausted' && r.follow_up_rule_code != null,
  )
  const capOf = (r: PipelineProjectRow) => r.follow_up_max_nudges ?? 3
  const sentOf = (r: PipelineProjectRow) => r.follow_up_sent_count ?? 0

  const queued = chased.filter((r) => sentOf(r) === 0)
  const finalSent = chased.filter((r) => sentOf(r) >= capOf(r) && sentOf(r) > 0)
  const mid = chased.filter((r) => sentOf(r) > 0 && sentOf(r) < capOf(r))

  // One column per mid-sequence position actually configured (cap 3 → after
  // reminder 1 and 2), so the picture adapts if the dials change. Indigo is
  // the dashboard's follow-up identity; it deepens as the sequence advances.
  const maxCap = Math.max(3, ...chased.map(capOf))
  const midStages: Stage[] = []
  for (let n = 1; n < maxCap; n++) {
    midStages.push({
      key: `r${n}`,
      label: `After reminder ${n}`,
      colour: ['#818cf8', '#6366f1', '#4f46e5'][Math.min(n - 1, 2)],
      rows: mid.filter((r) => sentOf(r) === n),
    })
  }

  const byDueSoonest = (a: PipelineProjectRow, b: PipelineProjectRow) =>
    (a.follow_up_last_sent_at ?? '').localeCompare(b.follow_up_last_sent_at ?? '')
  for (const s of midStages) s.rows.sort(byDueSoonest)
  finalSent.sort(byDueSoonest)

  return [
    { key: 'queued', label: 'Queued', colour: '#a5b4fc', rows: queued },
    ...midStages,
    { key: 'final', label: 'All reminders sent', colour: '#4338ca', rows: finalSent },
    { key: 'team', label: 'With the team', colour: '#e11d48', rows: team },
  ]
}

function dueCopy(row: PipelineProjectRow, stageKey: string, dials: AutomationDials): string {
  if (stageKey === 'team') {
    return attentionReason('nudges_exhausted', row.rule_meta)
  }
  if (stageKey === 'queued' || !row.follow_up_last_sent_at) return 'next sender run'
  const repeat = dials[row.follow_up_rule_code ?? '']?.repeat_days ?? 3
  const sent = row.follow_up_sent_count ?? 0
  if (stageKey === 'final') {
    const holdEnd = addWorkingDays(row.follow_up_last_sent_at, repeat)
    return holdEnd.getTime() <= Date.now()
      ? 'handing to the team'
      : `to the team ~${shortDate(holdEnd)} if quiet`
  }
  // Gap before reminder N+1 = repeat_days + 2 per reminder already sent
  // beyond the first (the sender's progressive stretch).
  const due = addWorkingDays(
    row.follow_up_last_sent_at,
    repeat + COOLDOWN_STRETCH_WD * Math.max(0, sent - 1),
  )
  return due.getTime() <= Date.now() ? 'next reminder due now' : `next ~${shortDate(due)}`
}

export default function FollowUpPipelinePanel({
  demo,
}: {
  // Fixture mode for the /__design showcase: rows + dials supplied directly,
  // no network. Real mounts omit it and the panel loads itself.
  demo?: { rows: PipelineProjectRow[]; automation: AutomationDials }
}) {
  const [rows, setRows] = useState<PipelineProjectRow[] | null>(demo?.rows ?? null)
  const [dials, setDials] = useState<AutomationDials>(demo?.automation ?? {})
  const [loadError, setLoadError] = useState<string | null>(null)
  const [openStage, setOpenStage] = useState<string | null>(null)

  useEffect(() => {
    if (demo) return
    let cancelled = false
    void (async () => {
      const [projRes, settingsRes] = await Promise.all([
        supabase
          .from('public_dashboard_projects')
          .select(PIPELINE_COLUMNS)
          .or('follow_up_rule_code.not.is.null,rule_code.eq.nudges_exhausted'),
        supabase.from('site_settings').select('needs_attention_rules').eq('id', 1).maybeSingle(),
      ])
      if (cancelled) return
      if (projRes.error) {
        setLoadError(projRes.error.message)
        return
      }
      setRows((projRes.data ?? []) as unknown as PipelineProjectRow[])
      const rules = (settingsRes.data?.needs_attention_rules ?? {}) as {
        automation?: AutomationDials
      }
      setDials(rules.automation ?? {})
    })()
    return () => {
      cancelled = true
    }
  }, [demo])

  const stages = useMemo(() => buildStages(rows ?? []), [rows])
  const total = stages.reduce((n, s) => n + s.rows.length, 0)
  const teamCount = stages.find((s) => s.key === 'team')?.rows.length ?? 0

  // Default the expanded stage to the first populated one, once loaded.
  useEffect(() => {
    if (openStage != null || rows == null) return
    const first = stages.find((s) => s.rows.length > 0)
    if (first) setOpenStage(first.key)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows])

  const selected = stages.find((s) => s.key === openStage)

  return (
    <div className="rounded-2xl bg-surface p-5 shadow-sm ring-1 ring-line">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-ink">Follow-up pipeline</h3>
          <p className="mt-1 text-xs text-ink-mute">
            Where every automatically-chased project sits right now. Dates with a ~ are
            estimates — the sender also respects snoozes, replies, and bank holidays.
          </p>
        </div>
        <span className="shrink-0 text-xs text-ink-mute">
          {total === 0
            ? 'nothing in follow-up'
            : `${total - teamCount} in automatic follow-up · ${teamCount} with the team`}
        </span>
      </div>

      {loadError && (
        <p className="mt-4 text-sm text-ink-mute">Couldn't load the pipeline: {loadError}</p>
      )}

      {!loadError && rows == null && (
        <div className="flex justify-center py-8">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-line border-t-gray-900" />
        </div>
      )}

      {!loadError && rows != null && total === 0 && (
        <p className="mt-4 text-sm text-ink-mute">
          Nothing is in automatic follow-up right now — every active project has either
          responded or is with a person.
        </p>
      )}

      {!loadError && rows != null && total > 0 && (
        <>
          {/* Proportional bar — the one-glance shape of the pipeline. */}
          <div className="mt-4 flex h-2.5 w-full overflow-hidden rounded-full bg-line/50">
            {stages
              .filter((s) => s.rows.length > 0)
              .map((s) => (
                <div
                  key={s.key}
                  title={`${s.label}: ${s.rows.length}`}
                  style={{ backgroundColor: s.colour, flexGrow: s.rows.length }}
                  className="min-w-[6px] first:rounded-l-full last:rounded-r-full"
                />
              ))}
          </div>

          {/* Stage tabs. */}
          <div className="mt-3 flex flex-wrap gap-2">
            {stages.map((s) => {
              const active = openStage === s.key
              return (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => setOpenStage(active ? null : s.key)}
                  className={[
                    'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ring-1 transition-colors',
                    active
                      ? 'bg-ink text-on-ink ring-ink'
                      : 'bg-canvas text-ink ring-line hover:ring-ink/40',
                    s.rows.length === 0 ? 'opacity-50' : '',
                  ].join(' ')}
                >
                  <span
                    aria-hidden="true"
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: s.colour }}
                  />
                  {s.label}
                  <span className={active ? 'text-on-ink/70' : 'text-ink-mute'}>
                    {s.rows.length}
                  </span>
                </button>
              )
            })}
          </div>

          {/* The selected stage's projects. */}
          {selected && selected.rows.length > 0 && (
            <ul className="mt-3 divide-y divide-line/60 rounded-xl ring-1 ring-line/70">
              {selected.rows.map((r) => {
                const badge = reEngagement(r)
                const chaseRule = r.follow_up_rule_code ?? r.rule_code
                return (
                  <li key={r.proof_id}>
                    <Link
                      to={`/proofs/${r.proof_id}`}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 hover:bg-canvas"
                    >
                      <span className="max-w-[16rem] truncate text-sm font-medium text-ink">
                        {r.contact_name ?? 'No contact'}
                      </span>
                      {r.company_name && (
                        <span className="max-w-[14rem] truncate text-xs text-ink-mute">
                          {r.company_name}
                        </span>
                      )}
                      <span className="text-xs text-ink-mute">
                        v{r.current_version_number ?? '—'}
                        {r.material_display ? ` · ${r.material_display}` : ''}
                      </span>
                      {chaseRule && selected.key !== 'team' && (
                        <span className="rounded-full bg-canvas px-2 py-0.5 text-[11px] text-ink-mute ring-1 ring-line">
                          {attentionShortLabel(chaseRule)}
                        </span>
                      )}
                      {badge && (
                        <span
                          className="rounded-full border px-2 py-0.5 text-[11px] font-medium"
                          style={
                            badge.strong
                              ? { color: '#15803d', backgroundColor: '#f0fdf4', borderColor: '#bbf7d0' }
                              : { color: '#4338ca', backgroundColor: '#eef2ff', borderColor: '#c7d2fe' }
                          }
                        >
                          {badge.label}
                        </span>
                      )}
                      <span className="ml-auto shrink-0 text-[11px] text-ink-mute">
                        {r.follow_up_last_sent_at && selected.key !== 'team' && (
                          <>
                            sent {relativeTime(r.follow_up_last_sent_at)}
                            {' · '}
                          </>
                        )}
                        {dueCopy(r, selected.key, dials)}
                      </span>
                    </Link>
                  </li>
                )
              })}
            </ul>
          )}
          {selected && selected.rows.length === 0 && (
            <p className="mt-3 text-xs text-ink-mute">Nothing in this stage right now.</p>
          )}
        </>
      )}
    </div>
  )
}
