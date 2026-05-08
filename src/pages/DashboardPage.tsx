import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import type { ProofStatus } from '../lib/types'
import { relativeTime, formatAbsoluteDateTime } from '../lib/relativeTime'
import {
  viewedStateDotClass,
  viewedStateTitle,
  type ViewedState,
} from '../lib/viewedState'
import { designerPreviewPath } from '../lib/customerProofUrl'
import { QuoteLink } from '../components/QuoteLink'

// ── Types ─────────────────────────────────────────────────────────────────────

type SortMode  = 'activity' | 'date' | 'name'
type GroupMode = 'time' | 'company'
type TileKey   = 'needs_attention' | 'awaiting_customer' | 'dormant' | 'approved_this_week'

type DesignerColour = 'blue' | 'teal' | 'coral' | 'purple'

interface DashboardProject {
  proof_id: string
  created_at: string
  last_activity_at: string
  status: ProofStatus
  approved_at: string | null
  abandoned_at: string | null
  disclaimer_acknowledged_at: string | null
  helpscout_conversation_url: string | null
  helpscout_conversation_id: string | null
  contact_id: string | null
  contact_name: string | null
  contact_email: string | null
  company_id: string | null
  company_name: string | null
  current_version_id: string | null
  current_version_number: number | null
  material_display: string | null
  version_created_at: string | null
  designer_user_id: string | null
  designer_name: string | null
  designer_initials: string | null
  designer_colour: DesignerColour | null
  latest_event_at: string | null
  latest_event_type:
    | 'approve'
    | 'request_changes'
    | 'view'
    | 'designer_override_approve'
    | null
  latest_event_actor: string | null
  current_version_viewed_at: string | null
  // Needs-attention rule annotation (migration 000154). Null when
  // the proof isn't currently flagged. rule_code identifies which
  // rule fired (request_changes_no_version / helpscout_follow_up_tag /
  // sent_never_viewed / viewed_not_actioned / approaching_dormant /
  // stuck_in_progress); rule_meta carries `{ days: N }` for any rule
  // with a threshold so the chip can render "Sent N working days
  // ago" without re-deriving.
  rule_code: NeedsAttentionRule | null
  rule_meta: { days?: number } | null
}

type NeedsAttentionRule =
  | 'request_changes_no_version'
  | 'helpscout_follow_up_tag'
  | 'sent_never_viewed'
  | 'viewed_not_actioned'
  | 'approaching_dormant'
  | 'stuck_in_progress'

// Reason chip text per rule. Templated against rule_meta.days where
// the rule has a threshold. Kept here rather than in a shared lib
// because the dashboard is the only renderer; the admin editor uses
// its own humanised labels (rule name + description) for the cards.
function reasonChipText(code: NeedsAttentionRule, days: number | undefined): string {
  switch (code) {
    case 'request_changes_no_version':
      return `Customer requested changes ${days ?? '—'} working days ago, no new version`
    case 'helpscout_follow_up_tag':
      return 'Help Scout conversation tagged "follow up"'
    case 'sent_never_viewed':
      return `Sent ${days ?? '—'} working days ago, never opened`
    case 'viewed_not_actioned':
      return `Last viewed ${days ?? '—'} working days ago, no action since`
    case 'approaching_dormant':
      return `Approaching dormant — ${days ?? '—'} days since last activity`
    case 'stuck_in_progress':
      return `Stuck in progress — no activity for ${days ?? '—'} working days`
  }
}

interface TileCounts {
  needs_attention: number
  awaiting_customer: number
  dormant: number
  approved_this_week: number
}

interface DashboardLatestEvent {
  id: string
  created_at: string
  event_type:
    | 'approve'
    | 'request_changes'
    | 'view'
    | 'designer_override_approve'
  actor_name: string
  recipient_name: string | null
  helpscout_thread_id: string | null
  proof_id: string
  version_number: number
  contact_name: string | null
  company_name: string | null
}

const SORT_KEY  = 'proofViewer.dashboard.sort'
const GROUP_KEY = 'proofViewer.dashboard.group'

function readSort(): SortMode {
  try {
    const v = localStorage.getItem(SORT_KEY)
    if (v === 'name' || v === 'date' || v === 'activity') return v
  } catch { /* */ }
  return 'activity'
}

function readGroup(): GroupMode {
  try {
    const v = localStorage.getItem(GROUP_KEY)
    if (v === 'company' || v === 'time') return v
  } catch { /* */ }
  return 'time'
}

// ── Date / time helpers ──────────────────────────────────────────────────────

function startOfToday(): Date {
  const n = new Date()
  return new Date(n.getFullYear(), n.getMonth(), n.getDate())
}

function isSameDay(iso: string): boolean {
  const t = new Date(iso)
  const s = startOfToday()
  return t.getFullYear() === s.getFullYear()
      && t.getMonth() === s.getMonth()
      && t.getDate() === s.getDate()
}

function isThisWeek(iso: string): boolean {
  const t = new Date(iso)
  const s = startOfToday()
  const diffDays = Math.floor((s.getTime() - new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime()) / 86_400_000)
  return diffDays > 0 && diffDays < 7
}

// Derive the relative verb shown on each row from the latest event +
// the current view state. "Sent today" / "Sent yesterday" / "Sent
// 3d ago" are the designer-side fallback when no customer event has
// landed yet.
function activityVerb(p: DashboardProject): { verb: string; ts: string | null } {
  if (p.status === 'approved' && p.approved_at) {
    return { verb: 'Approved', ts: p.approved_at }
  }
  if (p.status === 'abandoned' && p.abandoned_at) {
    return { verb: 'Abandoned', ts: p.abandoned_at }
  }
  if (p.latest_event_type && p.latest_event_at) {
    if (p.latest_event_type === 'view')              return { verb: 'Viewed', ts: p.latest_event_at }
    if (p.latest_event_type === 'approve')           return { verb: 'Approved', ts: p.latest_event_at }
    if (p.latest_event_type === 'request_changes')   return { verb: 'Changes requested', ts: p.latest_event_at }
    if (p.latest_event_type === 'designer_override_approve') return { verb: 'Marked approved', ts: p.latest_event_at }
  }
  if (p.version_created_at) {
    return { verb: 'Sent', ts: p.version_created_at }
  }
  return { verb: 'Created', ts: p.created_at }
}

function viewedStateFor(p: DashboardProject): ViewedState {
  if (p.current_version_id == null) return 'unviewed'
  if (p.current_version_viewed_at) return 'viewed_current'
  // Fallback: project had a customer view at some point that wasn't on
  // the current version. The view doesn't expose stale-view state
  // directly; use latest_event_type === 'view' on a version_number
  // mismatch as a proxy. In practice this is rare on an active flow
  // (designers add versions only after customer feedback or a quoted
  // amendment) so the inexact fallback is acceptable for Phase 1.
  if (p.latest_event_type === 'view') return 'viewed_stale'
  return 'unviewed'
}

// ── Designer avatar ──────────────────────────────────────────────────────────

const COLOUR_CLASSES: Record<DesignerColour, string> = {
  blue:   'bg-sky-100 text-sky-800 ring-sky-200',
  teal:   'bg-teal-100 text-teal-800 ring-teal-200',
  coral:  'bg-rose-100 text-rose-800 ring-rose-200',
  purple: 'bg-violet-100 text-violet-800 ring-violet-200',
}

function DesignerAvatar({ p }: { p: DashboardProject }) {
  const initials = (p.designer_initials ?? '').slice(0, 2) || '—'
  const colour = (p.designer_colour ?? 'teal') as DesignerColour
  const tooltip = p.designer_name && p.current_version_number != null && p.version_created_at
    ? `${p.designer_name} — v${p.current_version_number} created ${formatAbsoluteDateTime(p.version_created_at)}`
    : p.designer_name ?? ''
  return (
    <span
      title={tooltip}
      aria-label={tooltip}
      className={[
        'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ring-1',
        COLOUR_CLASSES[colour],
      ].join(' ')}
    >
      {initials}
    </span>
  )
}

// ── Status pill (existing — kept identical to pre-redesign) ──────────────────

function StatusPill({ status }: { status: ProofStatus }) {
  if (status === 'approved') {
    return <span className="w-fit shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700">Approved</span>
  }
  if (status === 'abandoned') {
    return <span className="w-fit shrink-0 rounded-full bg-slate-200 px-2 py-0.5 text-xs font-semibold text-slate-700">Abandoned</span>
  }
  if (status === 'dormant') {
    return <span className="w-fit shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-500">Dormant</span>
  }
  return <span className="w-fit shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">In progress</span>
}

function ViewedDot({ state }: { state: ViewedState }) {
  return (
    <span
      aria-label={viewedStateTitle(state)}
      title={viewedStateTitle(state)}
      className={['inline-block h-2.5 w-2.5 shrink-0 rounded-full', viewedStateDotClass(state)].join(' ')}
    />
  )
}

// ── Stat tile ────────────────────────────────────────────────────────────────

interface StatTileProps {
  label: string
  count: number
  active: boolean
  tone: 'amber' | 'neutral'
  onClick: () => void
}

function StatTile({ label, count, active, tone, onClick }: StatTileProps) {
  // Amber tone: FAEEDA / 854F0B / 412402 ramp from the In-progress
  // pill family — matched approximately to amber-100 / amber-700 /
  // amber-900 so the tile reads as a sibling of the existing pill.
  const base = tone === 'amber'
    ? 'bg-amber-50 ring-amber-200 text-amber-900 hover:bg-amber-100'
    : 'bg-white ring-gray-200 text-gray-900 hover:bg-gray-50'
  const activeRing = active
    ? tone === 'amber'
      ? 'ring-2 ring-amber-500 shadow-sm'
      : 'ring-2 ring-gray-900 shadow-sm'
    : 'ring-1'
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={[
        'flex flex-col items-start gap-1 rounded-2xl px-5 py-4 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900',
        base,
        activeRing,
      ].join(' ')}
    >
      <span className={[
        'text-xs font-semibold uppercase tracking-wider',
        tone === 'amber' ? 'text-amber-700' : 'text-gray-500',
      ].join(' ')}>{label}</span>
      <span className="text-2xl font-bold tabular-nums">{count}</span>
    </button>
  )
}

// ── Overflow menu ────────────────────────────────────────────────────────────

interface OverflowMenuProps {
  proof: DashboardProject
  canAddVersion: boolean
}

function OverflowMenu({ proof, canAddVersion }: OverflowMenuProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Project actions"
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o) }}
        className="flex h-8 w-8 items-center justify-center rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900"
      >
        <svg viewBox="0 0 16 16" className="h-4 w-4" fill="currentColor"><circle cx="3" cy="8" r="1.5" /><circle cx="8" cy="8" r="1.5" /><circle cx="13" cy="8" r="1.5" /></svg>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-9 z-10 w-52 overflow-hidden rounded-lg bg-white py-1 text-sm shadow-lg ring-1 ring-gray-200"
          onClick={(e) => e.stopPropagation()}
        >
          {proof.current_version_id ? (
            <a
              role="menuitem"
              href={designerPreviewPath(proof.proof_id)}
              target="_blank"
              rel="noopener noreferrer"
              className="block px-3 py-2 text-gray-700 hover:bg-gray-100"
              onClick={() => setOpen(false)}
            >Preview</a>
          ) : (
            <span role="menuitem" aria-disabled className="block cursor-not-allowed px-3 py-2 text-gray-300">Preview</span>
          )}
          {canAddVersion ? (
            <Link
              role="menuitem"
              to={`/proofs/${proof.proof_id}/versions/new`}
              className="block px-3 py-2 text-gray-700 hover:bg-gray-100"
              onClick={() => setOpen(false)}
            >Add version</Link>
          ) : (
            <span role="menuitem" aria-disabled className="block cursor-not-allowed px-3 py-2 text-gray-300">Add version</span>
          )}
          {proof.helpscout_conversation_url && (
            <a
              role="menuitem"
              href={proof.helpscout_conversation_url}
              target="_blank"
              rel="noopener noreferrer"
              className="block px-3 py-2 text-gray-700 hover:bg-gray-100"
              onClick={() => setOpen(false)}
            >Open in Help Scout</a>
          )}
          <span
            role="menuitem"
            aria-disabled
            title="Pinning lands in Phase 2"
            className="block cursor-not-allowed border-t border-gray-100 px-3 py-2 text-gray-300"
          >Pin</span>
        </div>
      )}
    </div>
  )
}

// ── Project row ──────────────────────────────────────────────────────────────

interface ProjectRowProps {
  project: DashboardProject
}

function ProjectRow({ project }: ProjectRowProps) {
  const navigate = useNavigate()
  const canAddVersion = project.status === 'in_progress' || project.status === 'dormant'
  const { verb, ts } = activityVerb(project)
  // Project name: prefer company name (matches the existing Recent
  // projects card), fall back to contact name. There's no separate
  // proof_name column in Phase 1; surfacing one is Phase 2+.
  const projectName = project.company_name || project.contact_name || '(no contact)'
  // Sub-line: contact + company joined by " · ", but suppress
  // whichever half duplicates the project name. Sole-trader rows
  // (company_name === contact_name, e.g. "Jali Mumcu / Jali Mumcu")
  // collapse to no sub-line at all.
  const sublineParts: string[] = []
  if (project.contact_name && project.contact_name !== projectName) sublineParts.push(project.contact_name)
  if (project.company_name && project.company_name !== projectName) sublineParts.push(project.company_name)
  const subline = sublineParts.join(' · ')
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => navigate(`/proofs/${project.proof_id}`)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          navigate(`/proofs/${project.proof_id}`)
        }
      }}
      className={[
        'flex cursor-pointer items-center gap-3 px-5 py-3 transition-colors hover:bg-gray-50 focus:outline-none focus-visible:bg-gray-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gray-900',
        project.status === 'dormant' ? 'opacity-60' : '',
      ].join(' ')}
    >
      <ViewedDot state={viewedStateFor(project)} />
      {/* No version yet → no designer to attribute → no avatar.
          Rendering an empty initials circle on shell rows reads as
          a missing-data bug. Status dot still renders so the row
          isn't visually shorter than its siblings. */}
      {project.current_version_id && <DesignerAvatar p={project} />}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[15px] font-medium text-gray-900">{projectName}</span>
          {project.current_version_number != null && (
            <span className="shrink-0 text-xs text-gray-400">v{project.current_version_number}</span>
          )}
        </div>
        {subline && <div className="truncate text-xs text-gray-500">{subline}</div>}
        {project.rule_code && (
          // Reason chip — same FAEEDA / 854F0B amber ramp as the
          // Needs-attention tile and the In-progress status pill,
          // so the visual cue carries through from tile to row.
          <div className="mt-1">
            <span className="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800 ring-1 ring-amber-200">
              {reasonChipText(project.rule_code, project.rule_meta?.days)}
            </span>
          </div>
        )}
      </div>
      <span className="hidden truncate text-sm text-gray-500 lg:block lg:w-32">{project.material_display ?? '—'}</span>
      <StatusPill status={project.status} />
      <span className="hidden w-32 shrink-0 text-right text-xs text-gray-400 xl:block" title={ts ? formatAbsoluteDateTime(ts) : undefined}>
        {verb}{ts ? ` ${relativeTime(ts)}` : ''}
      </span>
      <OverflowMenu proof={project} canAddVersion={canAddVersion} />
    </div>
  )
}

// ── Section grouping ─────────────────────────────────────────────────────────

interface ProjectSection {
  key: string
  title: string
  projects: DashboardProject[]
}

function groupByTime(projects: DashboardProject[]): ProjectSection[] {
  const today: DashboardProject[] = []
  const week:  DashboardProject[] = []
  const older: DashboardProject[] = []
  for (const p of projects) {
    const ts = p.last_activity_at
    if (isSameDay(ts))      today.push(p)
    else if (isThisWeek(ts)) week.push(p)
    else                     older.push(p)
  }
  const out: ProjectSection[] = []
  if (today.length) out.push({ key: 'today',  title: 'Today',     projects: today })
  if (week.length)  out.push({ key: 'week',   title: 'This week', projects: week })
  if (older.length) out.push({ key: 'older',  title: 'Older',     projects: older })
  return out
}

function groupByCompany(projects: DashboardProject[]): ProjectSection[] {
  const map = new Map<string, ProjectSection>()
  for (const p of projects) {
    const key   = p.company_id ?? '__individual__'
    const title = p.company_name ?? 'No company'
    if (!map.has(key)) map.set(key, { key, title, projects: [] })
    map.get(key)!.projects.push(p)
  }
  const sections = [...map.values()]
  const individual = sections.find((s) => s.key === '__individual__')
  const named = sections.filter((s) => s.key !== '__individual__')
  named.sort((a, b) => a.title.localeCompare(b.title, 'en', { sensitivity: 'base' }))
  return individual ? [...named, individual] : named
}

// ── Latest activity sidebar ──────────────────────────────────────────────────

function LatestActivityPanel({
  events,
  navigate,
}: {
  events: DashboardLatestEvent[]
  navigate: (to: string) => void
}) {
  return (
    <div className="rounded-2xl bg-white shadow-sm ring-1 ring-gray-200">
      <div className="border-b border-gray-100 px-5 py-4">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-500">Latest activity</h2>
        <p className="mt-0.5 text-xs text-gray-400">Last 20 events</p>
      </div>
      {events.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-gray-400">No customer activity yet.</p>
      ) : (
        <ul>
          {events.map((e, i) => {
            const isView = e.event_type === 'view'
            const isApprove = e.event_type === 'approve'
            const isOverride = e.event_type === 'designer_override_approve'
            const verb = isView
              ? `viewed v${e.version_number}`
              : isApprove
                ? 'approved'
                : isOverride
                  ? 'marked as approved (override)'
                  : 'requested changes on'
            const projectLabel = [e.contact_name, e.company_name].filter(Boolean).join(' · ') || '(no contact)'
            const recipient = e.recipient_name && e.recipient_name !== '__shared__' ? e.recipient_name : 'shared'
            const subline = isView
              ? projectLabel
              : `${projectLabel} · v${e.version_number} · ${recipient}`
            const failed = !isView && !isOverride && e.helpscout_thread_id == null
            const accent = isView
              ? 'border-l-4 border-sky-500'
              : isApprove
                ? 'border-l-4 border-emerald-500'
                : isOverride
                  ? 'border-l-4 border-slate-600'
                  : 'border-l-4 border-amber-500'
            const dotClass = isView
              ? 'bg-sky-500'
              : isApprove
                ? 'bg-emerald-500'
                : isOverride
                  ? 'bg-slate-600'
                  : 'bg-amber-500'
            return (
              <li
                key={e.id}
                role="button"
                tabIndex={0}
                onClick={() => navigate(`/proofs/${e.proof_id}`)}
                onKeyDown={(ev) => {
                  if (ev.key === 'Enter' || ev.key === ' ') {
                    ev.preventDefault()
                    navigate(`/proofs/${e.proof_id}`)
                  }
                }}
                className={[
                  'flex cursor-pointer gap-3 py-3 pl-4 pr-5 transition-colors hover:bg-gray-50 focus:outline-none focus-visible:bg-gray-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gray-900',
                  accent,
                  i > 0 ? 'border-t border-t-gray-100' : '',
                ].join(' ')}
              >
                <span aria-hidden className={['mt-1.5 h-2 w-2 shrink-0 rounded-full', dotClass].join(' ')} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm leading-snug text-gray-900">
                    <span className="font-semibold">{e.actor_name}</span>{' '}
                    <span className="text-gray-500">{verb}</span>
                  </p>
                  <p className="mt-0.5 truncate text-xs text-gray-500">{subline}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <span className="text-[11px] text-gray-400" title={formatAbsoluteDateTime(e.created_at)}>
                      {relativeTime(e.created_at)}
                    </span>
                    {failed && (
                      <span
                        className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700"
                        title="Help Scout notification failed — customer was asked to email."
                      >notification failed</span>
                    )}
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

// ── Component ────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const navigate = useNavigate()
  const { role } = useAuth()
  const [projects, setProjects]           = useState<DashboardProject[]>([])
  const [tileCounts, setTileCounts]       = useState<TileCounts | null>(null)
  const [needsAttention, setNeedsAttention] = useState<Set<string>>(new Set())
  const [latestEvents, setLatestEvents]   = useState<DashboardLatestEvent[]>([])
  const [loading, setLoading]             = useState(true)
  const [search, setSearch]               = useState('')
  const [statusFilter, setStatusFilter]   = useState<Set<ProofStatus>>(new Set())
  const [tileFilter, setTileFilter]       = useState<TileKey | null>(null)
  const [sort, setSort]                   = useState<SortMode>(readSort)
  const [group, setGroup]                 = useState<GroupMode>(readGroup)

  useEffect(() => { loadDashboard() }, [])

  // Refetch when the tab becomes visible — designers context-switching
  // (Help Scout, email) come back to a fresh page without a manual reload.
  const refetchInFlight = useRef(false)
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState !== 'visible') return
      if (refetchInFlight.current) return
      refetchInFlight.current = true
      loadDashboard().finally(() => { refetchInFlight.current = false })
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

  async function loadDashboard() {
    // Note: the four queries below depend on migration 000152
    // (public_dashboard_projects view + dashboard_tile_counts() +
    // proofs_needing_attention() RPC + designer presentation columns
    // on profiles). The page will throw / render the empty state until
    // that migration has been pushed to the linked Supabase project.
    // Until you run `pnpm db:push:confirm` for 000152 the dashboard
    // will fail to load — expected.
    const projectsPromise = supabase
      .from('public_dashboard_projects')
      .select('*')
      .order('last_activity_at', { ascending: false, nullsFirst: false })
      .limit(2000)

    const tilesPromise = supabase.rpc('dashboard_tile_counts')
    const naPromise    = supabase.rpc('proofs_needing_attention')
    const eventsPromise = supabase
      .from('dashboard_latest_events')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(20)

    const [
      { data: projectRows },
      { data: tileRows },
      { data: naIds },
      { data: events },
    ] = await Promise.all([projectsPromise, tilesPromise, naPromise, eventsPromise])

    setProjects((projectRows ?? []) as DashboardProject[])

    // dashboard_tile_counts() returns SETOF — supabase-js delivers it
    // as an array even though the function emits exactly one row.
    const tile = Array.isArray(tileRows) ? tileRows[0] : tileRows
    setTileCounts((tile ?? null) as TileCounts | null)

    // proofs_needing_attention() returns uuid[]. supabase-js returns
    // the array directly as `data`.
    setNeedsAttention(new Set<string>(((naIds ?? []) as string[]).filter(Boolean)))

    setLatestEvents((events ?? []) as DashboardLatestEvent[])
    setLoading(false)
  }

  function handleSortChange(s: SortMode) {
    setSort(s)
    try { localStorage.setItem(SORT_KEY, s) } catch { /* */ }
  }

  function handleGroupChange(g: GroupMode) {
    setGroup(g)
    try { localStorage.setItem(GROUP_KEY, g) } catch { /* */ }
  }

  function toggleStatus(s: ProofStatus) {
    setStatusFilter((prev) => {
      const next = new Set(prev)
      if (next.has(s)) next.delete(s)
      else next.add(s)
      return next
    })
  }

  function toggleTile(t: TileKey) {
    setTileFilter((prev) => (prev === t ? null : t))
  }

  async function handleSignOut() {
    await supabase.auth.signOut()
    navigate('/login')
  }

  // Status counts — derived from the full project list once.
  const statusCounts = useMemo(() => {
    const c: Record<ProofStatus, number> = { in_progress: 0, approved: 0, dormant: 0, abandoned: 0 }
    for (const p of projects) c[p.status] = (c[p.status] ?? 0) + 1
    return c
  }, [projects])

  // Filter pipeline: search → tile → status. All AND-combined.
  const filteredProjects = useMemo(() => {
    const q = search.trim().toLowerCase()
    return projects.filter((p) => {
      if (q) {
        const hay = [
          p.contact_name,
          p.contact_email,
          p.company_name,
          p.helpscout_conversation_id,
          p.proof_id,
        ].filter(Boolean).join(' ').toLowerCase()
        if (!hay.includes(q)) return false
      }
      if (tileFilter === 'needs_attention'    && !needsAttention.has(p.proof_id)) return false
      if (tileFilter === 'awaiting_customer'  && !(p.status === 'in_progress' && p.current_version_viewed_at == null)) return false
      if (tileFilter === 'dormant'            && p.status !== 'dormant') return false
      if (tileFilter === 'approved_this_week') {
        const cutoff = Date.now() - 7 * 86_400_000
        if (p.status !== 'approved' || !p.approved_at || new Date(p.approved_at).getTime() < cutoff) return false
      }
      if (statusFilter.size > 0 && !statusFilter.has(p.status)) return false
      return true
    })
  }, [projects, search, tileFilter, statusFilter, needsAttention])

  // Sort
  const sortedProjects = useMemo(() => {
    const arr = [...filteredProjects]
    if (sort === 'name') {
      arr.sort((a, b) => {
        const an = (a.company_name ?? a.contact_name ?? '').toLowerCase()
        const bn = (b.company_name ?? b.contact_name ?? '').toLowerCase()
        return an.localeCompare(bn, 'en', { sensitivity: 'base' })
      })
    } else if (sort === 'date') {
      arr.sort((a, b) => b.created_at.localeCompare(a.created_at))
    } else {
      // Activity sort — by latest_event_at if present, falling back to
      // last_activity_at. Ensures projects with recent customer events
      // sort above quiet ones even when their last_activity_at hasn't
      // moved.
      arr.sort((a, b) => {
        const at = a.latest_event_at ?? a.last_activity_at
        const bt = b.latest_event_at ?? b.last_activity_at
        return bt.localeCompare(at)
      })
    }
    return arr
  }, [filteredProjects, sort])

  const sections: ProjectSection[] = useMemo(() => {
    return group === 'company' ? groupByCompany(sortedProjects) : groupByTime(sortedProjects)
  }, [sortedProjects, group])

  const noResults = !loading && sections.every((s) => s.projects.length === 0)

  return (
    <div className="min-h-dvh bg-gray-50">
      <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">

        {/* Header */}
        <div className="mb-8 flex items-center justify-between">
          <div>
            <p className="text-sm font-medium uppercase tracking-widest text-gray-400">PlasmaDesign</p>
            <h1 className="mt-1 text-2xl font-bold text-gray-900">Projects</h1>
          </div>
          <div className="flex items-center gap-3">
            <QuoteLink />
            {role === 'admin' && (
              <Link to="/admin/users" className="rounded-lg px-4 py-2 text-sm font-medium text-gray-500 hover:bg-gray-100">Admin</Link>
            )}
            <Link to="/proofs/new" className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-700">New project</Link>
            <button onClick={handleSignOut} className="rounded-lg px-4 py-2 text-sm font-medium text-gray-500 hover:bg-gray-100">Sign out</button>
          </div>
        </div>

        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="min-w-0">

            {loading ? (
              <div className="flex justify-center py-20">
                <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-200 border-t-gray-900" />
              </div>
            ) : (
              <>
                {/* Stat tile row */}
                <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <StatTile
                    label="Needs attention"
                    count={tileCounts?.needs_attention ?? 0}
                    active={tileFilter === 'needs_attention'}
                    tone="amber"
                    onClick={() => toggleTile('needs_attention')}
                  />
                  <StatTile
                    label="Awaiting customer"
                    count={tileCounts?.awaiting_customer ?? 0}
                    active={tileFilter === 'awaiting_customer'}
                    tone="neutral"
                    onClick={() => toggleTile('awaiting_customer')}
                  />
                  <StatTile
                    label="Dormant"
                    count={tileCounts?.dormant ?? 0}
                    active={tileFilter === 'dormant'}
                    tone="neutral"
                    onClick={() => toggleTile('dormant')}
                  />
                  <StatTile
                    label="Approved this week"
                    count={tileCounts?.approved_this_week ?? 0}
                    active={tileFilter === 'approved_this_week'}
                    tone="neutral"
                    onClick={() => toggleTile('approved_this_week')}
                  />
                </div>

                {/* Search + Filters */}
                <div className="mb-4 flex items-center gap-3">
                  <input
                    type="search"
                    placeholder="Search project, contact, company, email, or Help Scout id"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="flex-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900"
                  />
                  <button
                    type="button"
                    disabled
                    title="Material and Date-range filters land in Phase 2"
                    className="shrink-0 cursor-not-allowed rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-300"
                  >Filters</button>
                </div>

                {/* Status filter chips */}
                <div className="mb-4 flex flex-wrap gap-2">
                  <Chip
                    label="All"
                    count={projects.length}
                    active={statusFilter.size === 0}
                    onClick={() => setStatusFilter(new Set())}
                  />
                  <Chip
                    label="In progress"
                    count={statusCounts.in_progress}
                    active={statusFilter.has('in_progress')}
                    onClick={() => toggleStatus('in_progress')}
                  />
                  <Chip
                    label="Approved"
                    count={statusCounts.approved}
                    active={statusFilter.has('approved')}
                    onClick={() => toggleStatus('approved')}
                  />
                  <Chip
                    label="Dormant"
                    count={statusCounts.dormant}
                    active={statusFilter.has('dormant')}
                    onClick={() => toggleStatus('dormant')}
                  />
                  <Chip
                    label="Abandoned"
                    count={statusCounts.abandoned}
                    active={statusFilter.has('abandoned')}
                    onClick={() => toggleStatus('abandoned')}
                  />
                </div>

                {/* Sort + Group-by */}
                <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold uppercase tracking-wider text-gray-400">Sort</span>
                    <Segmented
                      options={[
                        { value: 'activity', label: 'Activity' },
                        { value: 'date',     label: 'Date' },
                        { value: 'name',     label: 'Name' },
                      ]}
                      value={sort}
                      onChange={(v) => handleSortChange(v as SortMode)}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold uppercase tracking-wider text-gray-400">Group</span>
                    <Segmented
                      options={[
                        { value: 'time',    label: 'Time' },
                        { value: 'company', label: 'Company' },
                      ]}
                      value={group}
                      onChange={(v) => handleGroupChange(v as GroupMode)}
                    />
                  </div>
                </div>

                {/* List */}
                {projects.length === 0 ? (
                  <div className="rounded-2xl bg-white py-20 text-center shadow-sm ring-1 ring-gray-200">
                    <p className="text-gray-400">No projects yet.</p>
                    <Link to="/proofs/new" className="mt-3 inline-block text-sm font-medium text-gray-900 underline">Create the first one</Link>
                  </div>
                ) : noResults ? (
                  <div className="rounded-2xl bg-white py-16 text-center shadow-sm ring-1 ring-gray-200">
                    <p className="text-gray-400">No projects match the current filters.</p>
                    <button
                      onClick={() => { setSearch(''); setStatusFilter(new Set()); setTileFilter(null) }}
                      className="mt-2 text-sm text-gray-500 underline underline-offset-2 hover:text-gray-900"
                    >Clear filters</button>
                  </div>
                ) : (
                  <div className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-gray-200">
                    {sections.map((section, si) => (
                      <div key={section.key} className={si > 0 ? 'border-t border-gray-100' : ''}>
                        <div className="flex items-center gap-3 bg-gray-50/80 px-5 py-1.5">
                          <span className="text-xs font-semibold uppercase tracking-widest text-gray-500">{section.title}</span>
                          <span className="text-xs text-gray-400 tabular-nums">{section.projects.length}</span>
                        </div>
                        {section.projects.map((p, ri) => (
                          <div key={p.proof_id} className={ri > 0 ? 'border-t border-gray-100' : ''}>
                            <ProjectRow project={p} />
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          {!loading && (
            <aside className="hidden lg:sticky lg:top-10 lg:block lg:self-start">
              <LatestActivityPanel events={latestEvents} navigate={navigate} />
            </aside>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Small UI primitives ──────────────────────────────────────────────────────

function Chip({
  label,
  count,
  active,
  onClick,
}: {
  label: string
  count: number
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={[
        'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ring-1 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900',
        active
          ? 'bg-gray-900 text-white ring-gray-900'
          : 'bg-white text-gray-600 ring-gray-200 hover:bg-gray-50',
      ].join(' ')}
    >
      <span>{label}</span>
      <span className={['tabular-nums', active ? 'text-gray-300' : 'text-gray-400'].join(' ')}>· {count}</span>
    </button>
  )
}

function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: Array<{ value: T; label: string }>
  value: T
  onChange: (v: T) => void
}) {
  return (
    <div className="flex rounded-lg border border-gray-200 bg-white p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={[
            'rounded-md px-3 py-1 text-sm font-medium transition-colors',
            value === o.value
              ? 'bg-gray-100 text-gray-900'
              : 'text-gray-500 hover:text-gray-900',
          ].join(' ')}
        >{o.label}</button>
      ))}
    </div>
  )
}
