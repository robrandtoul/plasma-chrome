import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Flame, ExternalLink, ArrowRight, Info } from 'lucide-react'
import { supabase } from '../lib/supabase'

// Dashboard "Hot leads to chase" card. The daily prompt that turns the
// analytics Hot-leads worklist into action: in-progress proofs the customer
// has OPENED but not decided, ranked by repeat-view buying signal. Reads the
// same analytics_hot_leads() RPC the Analytics page uses (migration 000276/277).
//
// Shown to every designer (the dashboard is a shared team view); the
// "Open in Analytics" deep-link is admin-only because /admin/analytics is
// admin-gated. Fails quiet — if the RPC errors (e.g. migration not yet
// applied) the card renders nothing rather than disrupting the dashboard.

interface HotLead {
  proof_id: string
  company_name: string | null
  contact_name: string | null
  designer_user_id: string | null
  designer_name: string | null
  designer_initials: string | null
  designer_colour: string | null
  view_count: number
  days_since_view: number | string | null
  age_days: number | string | null
  nudges_sent: number
  reengaged: boolean
  is_returning: boolean
  helpscout_conversation_url: string | null
  tier: 'hot' | 'reengaged' | 'stale' | 'warm'
}

const TIER: Record<HotLead['tier'], { label: string; colour: string }> = {
  hot: { label: 'Hot · 3+ views', colour: 'var(--c-out)' },
  reengaged: { label: 'Re-engaged', colour: 'var(--c-allocated)' },
  stale: { label: 'Stale >7d', colour: 'var(--c-ink-mute)' },
  warm: { label: 'Warm', colour: 'var(--c-low)' },
}

// What counts as a genuine hot lead on this card. The analytics_hot_leads()
// RPC returns the whole opened-but-undecided pipeline (tiered for the Analytics
// worklist); the dashboard card is a daily call-list, so we tighten it to real,
// recent return interest: opened 3+ times OR reopened after a reminder, AND
// seen within the last 10 days. A lone open, or one gone quiet for a fortnight,
// isn't a hot lead. Tuned here rather than in the RPC so Analytics keeps the
// full picture.
const MIN_VIEWS = 3
const RECENT_DAYS = 10

function isHotLead(l: HotLead): boolean {
  const n = typeof l.days_since_view === 'string' ? parseFloat(l.days_since_view) : l.days_since_view
  const seenRecently = n != null && Number.isFinite(n) && n <= RECENT_DAYS
  return seenRecently && (l.view_count >= MIN_VIEWS || l.reengaged)
}

// Plain-English meaning of each badge for the in-card "Why are these hot leads?"
// explainer. Only 'hot' and 'reengaged' can appear once isHotLead() has run.
const TIER_LEGEND: { tier: HotLead['tier']; meaning: string }[] = [
  { tier: 'hot', meaning: 'Opened three or more times — the strongest sign they’re close.' },
  { tier: 'reengaged', meaning: 'Reopened the proof after we sent a reminder.' },
]

const COLLAPSED = 6

// Collapsed-by-default disclosure, remembered per browser. Mirrors the
// localStorage idiom in CollapsibleSidebarPanel, but defaults to collapsed so
// the card loads as a quiet one-line bar — it's a worklist you open when you're
// in chasing mode, not ambient chrome that should always be expanded.
const STORAGE_KEY = 'dash.collapsible.hotleads'

function readCollapsed(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key)
    return v === null ? fallback : v === '1'
  } catch {
    // Private mode / disabled storage — fall back to the default.
    return fallback
  }
}

function writeCollapsed(key: string, collapsed: boolean) {
  try {
    localStorage.setItem(key, collapsed ? '1' : '0')
  } catch {
    // Best-effort; a failed write just means the choice isn't remembered.
  }
}

function daysAgo(v: number | string | null): string {
  if (v == null) return '—'
  const n = typeof v === 'string' ? parseFloat(v) : v
  if (!Number.isFinite(n)) return '—'
  if (n < 1) return 'today'
  if (n < 2) return '1d ago'
  return `${Math.round(n)}d ago`
}

export default function HotLeadsCard({
  isAdmin,
  currentUserId,
}: {
  isAdmin: boolean
  currentUserId: string | null
}) {
  const [leads, setLeads] = useState<HotLead[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [mineOnly, setMineOnly] = useState(false)
  const [collapsed, setCollapsed] = useState(() => readCollapsed(STORAGE_KEY, true))

  function toggleCollapsed() {
    setCollapsed((c) => {
      const next = !c
      writeCollapsed(STORAGE_KEY, next)
      return next
    })
  }

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const { data, error } = await supabase.rpc('analytics_hot_leads')
      if (cancelled) return
      if (error) {
        setFailed(true)
        return
      }
      setLeads((data ?? []) as HotLead[])
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // The genuinely-hot subset the card actually shows (see isHotLead).
  const qualified = useMemo(() => (leads ? leads.filter(isHotLead) : []), [leads])

  const filtered = useMemo(
    () =>
      mineOnly && currentUserId
        ? qualified.filter((l) => l.designer_user_id === currentUserId)
        : qualified,
    [qualified, mineOnly, currentUserId],
  )

  const mineCount = useMemo(
    () => (currentUserId ? qualified.filter((l) => l.designer_user_id === currentUserId).length : 0),
    [qualified, currentUserId],
  )

  // Quietly render nothing if the RPC failed or nothing clears the hot-lead bar —
  // an empty "nothing to chase" card would be noise on the dashboard.
  if (failed || qualified.length === 0) return null

  const shown = expanded ? filtered : filtered.slice(0, COLLAPSED)
  const regionId = 'hot-leads-region'

  return (
    <section className="mb-6 overflow-hidden rounded-[14px] border border-line bg-surface">
      <header
        className={[
          'flex flex-wrap items-center gap-3 px-5 py-4',
          collapsed ? '' : 'border-b border-line-soft',
        ].join(' ')}
      >
        <h2 className="m-0 min-w-0 flex-1">
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-expanded={!collapsed}
            aria-controls={regionId}
            className="flex w-full items-center gap-3 rounded-[6px] text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--c-brand)]"
          >
            <span
              aria-hidden="true"
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px]"
              style={{ backgroundColor: 'color-mix(in srgb, var(--c-out) 14%, transparent)', color: 'var(--c-out)' }}
            >
              <Flame size={15} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="font-display text-[18px] font-medium leading-tight tracking-[-0.01em] text-ink">
                  Hot leads to chase
                </span>
                <span className="shrink-0 rounded-full bg-canvas px-2 py-0.5 text-[11px] font-semibold text-ink-mute ring-1 ring-line">
                  {qualified.length}
                </span>
              </span>
              {!collapsed && (
                <span className="mt-0.5 block text-[13px] text-ink-mute">
                  Came back to the proof but haven’t decided — most-viewed first. A call or personal reply within a day or two converts best.
                </span>
              )}
            </span>
            <svg
              aria-hidden="true"
              viewBox="0 0 16 16"
              className={[
                'h-4 w-4 shrink-0 self-center text-ink-mute transition-transform',
                collapsed ? '' : 'rotate-90',
              ].join(' ')}
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="6 4 10 8 6 12" />
            </svg>
          </button>
        </h2>

        {!collapsed && (
          <span className="flex items-center gap-2">
            {currentUserId && mineCount > 0 && (
              <button
                type="button"
                onClick={() => setMineOnly((v) => !v)}
                aria-pressed={mineOnly}
                className={[
                  'rounded-full px-3 py-1 text-xs ring-1 transition-colors',
                  mineOnly
                    ? 'bg-ink text-on-ink ring-ink'
                    : 'text-ink-mute ring-line hover:bg-canvas hover:text-ink',
                ].join(' ')}
              >
                Mine ({mineCount})
              </button>
            )}
            {isAdmin && (
              <Link
                to="/admin/analytics"
                className="inline-flex items-center gap-1 whitespace-nowrap text-[13px] font-medium text-brand hover:underline"
              >
                Open in Analytics <ArrowRight size={13} aria-hidden="true" />
              </Link>
            )}
          </span>
        )}
      </header>

      <div id={regionId} hidden={collapsed}>
        {!collapsed && (
          <details className="border-b border-line-soft px-5 py-3">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[12.5px] font-medium text-ink-soft hover:text-ink">
              <Info size={13} aria-hidden="true" />
              Why are these hot leads?
            </summary>
            <div className="mt-2.5 space-y-2.5 text-[13px] leading-relaxed text-ink-mute">
              <p>
                These are proofs the customer has opened but not yet approved or replied to — and
                crucially, they’ve{' '}
                <span className="font-medium text-ink">come back to look again</span>. Returning to a proof
                is a buying signal: they’re re-reading the spec, checking the price, often showing it to
                whoever signs off. They haven’t said no; they’re deciding.
              </p>
              <p>
                We only list a lead here once it shows real, recent interest —{' '}
                <span className="font-medium text-ink">
                  opened three or more times, or reopened after a reminder, and viewed in the last few days
                </span>
                . A single open, or one that’s gone quiet for a fortnight, drops off so this stays a
                genuine call-list. A quick personal call or reply while they’re still considering is what
                tips these into orders — automated reminders reach them but rarely close them.
              </p>
              <ul className="space-y-1.5 pt-0.5">
                {TIER_LEGEND.map(({ tier, meaning }) => {
                  const t = TIER[tier]
                  return (
                    <li key={tier} className="flex items-start gap-2">
                      <span
                        className="mt-px shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium"
                        style={{ backgroundColor: `color-mix(in srgb, ${t.colour} 14%, transparent)`, color: t.colour }}
                      >
                        {t.label}
                      </span>
                      <span>{meaning}</span>
                    </li>
                  )
                })}
              </ul>
            </div>
          </details>
        )}

        {!collapsed &&
          (shown.length === 0 ? (
            <p className="px-5 py-6 text-sm text-ink-mute">No hot leads in this view.</p>
          ) : (
            <ul className="divide-y divide-line-soft">
          {shown.map((l) => {
            const t = TIER[l.tier]
            const initials = (l.designer_initials ?? '').slice(0, 2) || '—'
            const colour = l.designer_colour || 'var(--c-allocated)'
            return (
              <li key={l.proof_id} className="flex items-center gap-3 px-5 py-2.5 hover:bg-canvas">
                <span
                  title={l.designer_name ?? ''}
                  aria-label={l.designer_name ?? ''}
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold"
                  style={{
                    backgroundColor: `color-mix(in srgb, ${colour} 14%, transparent)`,
                    color: colour,
                    boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${colour} 30%, transparent)`,
                  }}
                >
                  {initials}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-ink">
                      {l.company_name || l.contact_name || 'Unknown'}
                    </span>
                    {l.is_returning && (
                      <span
                        className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
                        style={{ backgroundColor: 'color-mix(in srgb, var(--c-in-stock) 16%, transparent)', color: 'var(--c-in-stock)' }}
                      >
                        Repeat
                      </span>
                    )}
                  </div>
                  <div className="truncate text-xs text-ink-mute">
                    {l.view_count} views · last {daysAgo(l.days_since_view)}
                    {l.nudges_sent > 0 ? ` · ${l.nudges_sent} reminder${l.nudges_sent === 1 ? '' : 's'} sent` : ''}
                  </div>
                </div>
                <span
                  className="hidden shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium sm:inline"
                  style={{ backgroundColor: `color-mix(in srgb, ${t.colour} 14%, transparent)`, color: t.colour }}
                >
                  {t.label}
                </span>
                <Link
                  to={`/proofs/${l.proof_id}`}
                  className="shrink-0 text-[13px] font-medium text-brand hover:underline"
                  onClick={(e) => e.stopPropagation()}
                >
                  Open
                </Link>
                {l.helpscout_conversation_url && (
                  <a
                    href={l.helpscout_conversation_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0 text-ink-mute hover:text-ink"
                    title="Open Help Scout thread"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <ExternalLink size={13} aria-hidden="true" />
                  </a>
                )}
              </li>
            )
          })}
            </ul>
          ))}

        {!collapsed && filtered.length > COLLAPSED && (
          <div className="border-t border-line-soft px-5 py-2.5 text-center">
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="text-[13px] font-medium text-ink-soft hover:text-ink"
            >
              {expanded ? 'Show fewer' : `Show all ${filtered.length}`}
            </button>
          </div>
        )}
      </div>
    </section>
  )
}
