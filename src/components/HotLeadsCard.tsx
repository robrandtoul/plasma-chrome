import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Flame, ExternalLink, ArrowRight } from 'lucide-react'
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

const COLLAPSED = 6

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

  const filtered = useMemo(() => {
    if (!leads) return []
    return mineOnly && currentUserId
      ? leads.filter((l) => l.designer_user_id === currentUserId)
      : leads
  }, [leads, mineOnly, currentUserId])

  const mineCount = useMemo(
    () => (leads && currentUserId ? leads.filter((l) => l.designer_user_id === currentUserId).length : 0),
    [leads, currentUserId],
  )

  // Quietly render nothing if the RPC failed or there are simply no hot leads —
  // an empty "nothing to chase" card would be noise on the dashboard.
  if (failed || !leads || leads.length === 0) return null

  const shown = expanded ? filtered : filtered.slice(0, COLLAPSED)

  return (
    <section className="mb-6 overflow-hidden rounded-[14px] border border-line bg-surface">
      <header className="flex flex-wrap items-center gap-3 border-b border-line-soft px-5 py-4">
        <span
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px]"
          style={{ backgroundColor: 'color-mix(in srgb, var(--c-out) 14%, transparent)', color: 'var(--c-out)' }}
        >
          <Flame size={15} aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h2 className="m-0 font-display text-[18px] font-medium leading-tight tracking-[-0.01em] text-ink">
            Hot leads to chase
          </h2>
          <p className="mt-0.5 text-[13px] text-ink-mute">
            Opened the proof, no decision yet — most-viewed first. A call or personal reply within a day or two converts best.
          </p>
        </div>
        <span className="ml-auto flex items-center gap-2">
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
      </header>

      {shown.length === 0 ? (
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
      )}

      {filtered.length > COLLAPSED && (
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
    </section>
  )
}
