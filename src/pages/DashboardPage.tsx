import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
// react-virtuoso for the Older drawer's row virtualisation. Picked
// over react-window because its useWindowScroll mode preserves the
// existing UX where Older grows inline as part of the page rather
// than becoming a fixed-height inner-scrolling pane. ~30KB gzipped
// vs react-window's ~6KB; the bundle hit is worth not having to add
// react-virtualized-auto-sizer + a fixed pixel height on top.
import { Virtuoso } from 'react-virtuoso'
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
import { logAudit } from '../lib/audit'
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
  minePinned: boolean
  teamPinned: boolean
  onToggleMinePin: (proofId: string) => void
  onToggleTeamPin: (proofId: string) => void
}

function OverflowMenu({
  proof,
  canAddVersion,
  minePinned,
  teamPinned,
  onToggleMinePin,
  onToggleTeamPin,
}: OverflowMenuProps) {
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
          className="absolute right-0 top-9 z-10 w-56 overflow-hidden rounded-lg bg-white py-1 text-sm shadow-lg ring-1 ring-gray-200"
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
          <button
            role="menuitem"
            type="button"
            onClick={() => { setOpen(false); onToggleMinePin(proof.proof_id) }}
            className="block w-full border-t border-gray-100 px-3 py-2 text-left text-gray-700 hover:bg-gray-100"
          >
            {minePinned ? 'Unpin from your list' : 'Pin to your list'}
          </button>
          <button
            role="menuitem"
            type="button"
            onClick={() => { setOpen(false); onToggleTeamPin(proof.proof_id) }}
            className="block w-full px-3 py-2 text-left text-gray-700 hover:bg-gray-100"
          >
            {teamPinned ? 'Unpin from the team list' : 'Pin for the team'}
          </button>
        </div>
      )}
    </div>
  )
}

// ── Project row ──────────────────────────────────────────────────────────────

interface ProjectRowProps {
  project: DashboardProject
  minePinned: boolean
  teamPinned: boolean
  onToggleMinePin: (proofId: string) => void
  onToggleTeamPin: (proofId: string) => void
}

function ProjectRow({
  project,
  minePinned,
  teamPinned,
  onToggleMinePin,
  onToggleTeamPin,
}: ProjectRowProps) {
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
      <OverflowMenu
        proof={project}
        canAddVersion={canAddVersion}
        minePinned={minePinned}
        teamPinned={teamPinned}
        onToggleMinePin={onToggleMinePin}
        onToggleTeamPin={onToggleTeamPin}
      />
    </div>
  )
}

// ── Pin icons ────────────────────────────────────────────────────────────────
//
// The brief originally called for Tabler Icons (`ti ti-pin`,
// `ti ti-users`) but Tabler isn't loaded in this project — every
// other icon on the dashboard is an inline SVG. Matching the existing
// pattern keeps the bundle lean and the visual idiom consistent.

function PinIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.5 1.5l5 5-2 2-1-.5-3 3 .5 1.5-2 2-2.5-2.5L1 13l3.5-3.5-2.5-2.5 2-2 1.5.5 3-3-.5-1z" />
    </svg>
  )
}

function UsersIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="5.5" r="2.25" />
      <path d="M2 13.5c0-2 1.8-3.5 4-3.5s4 1.5 4 3.5" />
      <circle cx="11" cy="6" r="1.75" />
      <path d="M9.5 10.2c.4-.13.97-.2 1.5-.2 2 0 3.5 1.3 3.5 3" />
    </svg>
  )
}

// ── Section grouping ─────────────────────────────────────────────────────────

type SectionKind = 'pinned' | 'team' | 'time' | 'company'

interface ProjectSection {
  key: string
  title: string
  kind: SectionKind
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
  if (today.length) out.push({ key: 'today',  title: 'Today',     kind: 'time', projects: today })
  if (week.length)  out.push({ key: 'week',   title: 'This week', kind: 'time', projects: week })
  if (older.length) out.push({ key: 'older',  title: 'Older',     kind: 'time', projects: older })
  return out
}

function groupByCompany(projects: DashboardProject[]): ProjectSection[] {
  const map = new Map<string, ProjectSection>()
  for (const p of projects) {
    const key   = p.company_id ?? '__individual__'
    const title = p.company_name ?? 'No company'
    if (!map.has(key)) map.set(key, { key, title, kind: 'company', projects: [] })
    map.get(key)!.projects.push(p)
  }
  const sections = [...map.values()]
  const individual = sections.find((s) => s.key === '__individual__')
  const named = sections.filter((s) => s.key !== '__individual__')
  named.sort((a, b) => a.title.localeCompare(b.title, 'en', { sensitivity: 'base' }))
  return individual ? [...named, individual] : named
}

// Build the Pinned and Team sections from a sorted projects list and
// the two pin maps. Returns whichever sections have entries; either or
// both may be empty. Projects pinned to both lists only show in
// Pinned — the Team section explicitly excludes those.
function buildPinSections(
  projects: DashboardProject[],
  minePinAt: Map<string, string>,
  teamPinAt: Map<string, string>,
): ProjectSection[] {
  const out: ProjectSection[] = []
  const minePinned = projects
    .filter((p) => minePinAt.has(p.proof_id))
    .sort((a, b) => (minePinAt.get(b.proof_id) ?? '').localeCompare(minePinAt.get(a.proof_id) ?? ''))
  if (minePinned.length) {
    out.push({ key: '__pinned__', title: 'Pinned', kind: 'pinned', projects: minePinned })
  }
  const teamPinned = projects
    .filter((p) => teamPinAt.has(p.proof_id) && !minePinAt.has(p.proof_id))
    .sort((a, b) => (teamPinAt.get(b.proof_id) ?? '').localeCompare(teamPinAt.get(a.proof_id) ?? ''))
  if (teamPinned.length) {
    out.push({ key: '__team__', title: 'Team', kind: 'team', projects: teamPinned })
  }
  return out
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
  const { session, role } = useAuth()
  const userId = session?.user.id ?? null
  const [projects, setProjects]           = useState<DashboardProject[]>([])
  const [tileCounts, setTileCounts]       = useState<TileCounts | null>(null)
  const [latestEvents, setLatestEvents]   = useState<DashboardLatestEvent[]>([])
  // Pin state — proof_id → pinned_at ISO. Two maps because the
  // dashboard cares about each scope independently (mine drives the
  // Pinned section, team drives the Team section, and both feed the
  // overflow menu's toggle labels). pinned_at is preserved so the
  // sections can sort by recency.
  const [minePinAt, setMinePinAt]         = useState<Map<string, string>>(new Map())
  const [teamPinAt, setTeamPinAt]         = useState<Map<string, string>>(new Map())
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
    // designer presentation columns on profiles), migration 000154
    // (rule_code / rule_meta on the view), and migration 000155
    // (proof_pins table). The page will throw / render the empty
    // state until all three migrations have been pushed to the
    // linked Supabase project.
    const projectsPromise = supabase
      .from('public_dashboard_projects')
      .select('*')
      .order('last_activity_at', { ascending: false, nullsFirst: false })
      .limit(2000)

    const tilesPromise = supabase.rpc('dashboard_tile_counts')
    const eventsPromise = supabase
      .from('dashboard_latest_events')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(20)
    const pinsPromise = supabase
      .from('proof_pins')
      .select('proof_id, scope, user_id, pinned_at')

    const [
      { data: projectRows },
      { data: tileRows },
      { data: events },
      { data: pinRows },
    ] = await Promise.all([projectsPromise, tilesPromise, eventsPromise, pinsPromise])

    setProjects((projectRows ?? []) as DashboardProject[])

    // dashboard_tile_counts() returns SETOF — supabase-js delivers it
    // as an array even though the function emits exactly one row.
    const tile = Array.isArray(tileRows) ? tileRows[0] : tileRows
    setTileCounts((tile ?? null) as TileCounts | null)

    setLatestEvents((events ?? []) as DashboardLatestEvent[])

    // Split pins into the two scope-specific maps. Mine pins are
    // filtered to the current user (RLS lets every authenticated user
    // read every pin row, including other designers' mine pins, but
    // the Pinned section is per-user).
    const mine = new Map<string, string>()
    const team = new Map<string, string>()
    for (const r of (pinRows ?? []) as Array<{ proof_id: string; scope: 'mine' | 'team'; user_id: string | null; pinned_at: string }>) {
      if (r.scope === 'team') {
        team.set(r.proof_id, r.pinned_at)
      } else if (r.scope === 'mine' && r.user_id && r.user_id === userId) {
        mine.set(r.proof_id, r.pinned_at)
      }
    }
    setMinePinAt(mine)
    setTeamPinAt(team)

    setLoading(false)
  }

  // ── Pin / unpin handlers ──────────────────────────────────────────────────
  //
  // Both refresh the dashboard after the write so the sections re-bucket
  // immediately. No optimistic UI — the data is small and refetches are
  // fast enough that the trip is invisible. Audit logging on team
  // pin/unpin is wired in the same place; mine pins are personal
  // organisation and deliberately don't write to audit_log.
  async function toggleMinePin(proofId: string) {
    if (!userId) return
    if (minePinAt.has(proofId)) {
      await supabase
        .from('proof_pins')
        .delete()
        .eq('proof_id', proofId)
        .eq('scope', 'mine')
        .eq('user_id', userId)
    } else {
      await supabase
        .from('proof_pins')
        .insert({
          proof_id: proofId,
          scope: 'mine',
          user_id: userId,
          pinned_by: userId,
        })
    }
    await loadDashboard()
  }

  async function toggleTeamPin(proofId: string) {
    if (!userId) return
    const wasPinned = teamPinAt.has(proofId)
    if (wasPinned) {
      await supabase
        .from('proof_pins')
        .delete()
        .eq('proof_id', proofId)
        .eq('scope', 'team')
    } else {
      await supabase
        .from('proof_pins')
        .insert({
          proof_id: proofId,
          scope: 'team',
          user_id: null,
          pinned_by: userId,
        })
    }
    void logAudit({
      action: wasPinned ? 'setting.team_pin_removed' : 'setting.team_pin_added',
      targetType: 'proof',
      targetId: proofId,
      metadata: { proof_id: proofId },
    })
    await loadDashboard()
  }

  function handleSortChange(s: SortMode) {
    setSort(s)
    try { localStorage.setItem(SORT_KEY, s) } catch { /* */ }
  }

  function handleGroupChange(g: GroupMode) {
    setGroup(g)
    try { localStorage.setItem(GROUP_KEY, g) } catch { /* */ }
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
      if (tileFilter === 'needs_attention'    && !p.rule_code) return false
      if (tileFilter === 'awaiting_customer'  && !(p.status === 'in_progress' && p.current_version_viewed_at == null)) return false
      if (tileFilter === 'dormant'            && p.status !== 'dormant') return false
      if (tileFilter === 'approved_this_week') {
        const cutoff = Date.now() - 7 * 86_400_000
        if (p.status !== 'approved' || !p.approved_at || new Date(p.approved_at).getTime() < cutoff) return false
      }
      if (statusFilter.size > 0 && !statusFilter.has(p.status)) return false
      return true
    })
  }, [projects, search, tileFilter, statusFilter])

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
    // Pinned + Team sections sit above the time/company list. Any
    // project surfaced in either is removed from the bucket below
    // so it never appears twice on the page. minePinAt and teamPinAt
    // hold the pinned_at timestamps used by buildPinSections() to
    // sort by recency.
    const pinSections = buildPinSections(sortedProjects, minePinAt, teamPinAt)
    const pinnedIds = new Set<string>()
    for (const s of pinSections) for (const p of s.projects) pinnedIds.add(p.proof_id)
    const remaining = sortedProjects.filter((p) => !pinnedIds.has(p.proof_id))
    const tailSections = group === 'company'
      ? groupByCompany(remaining)
      : groupByTime(remaining)
    return [...pinSections, ...tailSections]
  }, [sortedProjects, group, minePinAt, teamPinAt])

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

                {/* List card. Search, status chips and sort/group toggles
                    sit inside the same card as the project list so they
                    visibly belong to the list rather than floating in the
                    page margin. The truly-empty state (no projects yet)
                    keeps its own standalone card since the controls would
                    have nothing to act on. */}
                {projects.length === 0 ? (
                  <div className="rounded-2xl bg-white py-20 text-center shadow-sm ring-1 ring-gray-200">
                    <p className="text-gray-400">No projects yet.</p>
                    <Link to="/proofs/new" className="mt-3 inline-block text-sm font-medium text-gray-900 underline">Create the first one</Link>
                  </div>
                ) : (
                  <div className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-gray-200">
                    {/* Controls block — divider below separates it from
                        the list. Search on row 1, three matching
                        dropdowns (Status, Sort, Group) on row 2. The
                        Status dropdown replaced a row of five chips —
                        identical visual treatment to Sort/Group means
                        the row reads as a single unit rather than two
                        competing styles. Per-status counts live in the
                        dropdown options so they appear when the menu
                        opens without crowding the closed control. */}
                    <div className="border-b border-gray-100 px-5 py-4">
                      <div className="mb-3">
                        <input
                          type="search"
                          placeholder="Search project, contact, company, email, or Help Scout id"
                          value={search}
                          onChange={(e) => setSearch(e.target.value)}
                          className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900"
                        />
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <SelectField
                          value={statusFilter.size === 0 ? 'all' : Array.from(statusFilter)[0] as ProofStatus}
                          onChange={(v) => {
                            if (v === 'all') setStatusFilter(new Set())
                            else setStatusFilter(new Set([v]))
                          }}
                          options={[
                            { value: 'all',         label: `Status: All (${projects.length})` },
                            { value: 'in_progress', label: `Status: In progress (${statusCounts.in_progress})` },
                            { value: 'approved',    label: `Status: Approved (${statusCounts.approved})` },
                            { value: 'dormant',     label: `Status: Dormant (${statusCounts.dormant})` },
                            { value: 'abandoned',   label: `Status: Abandoned (${statusCounts.abandoned})` },
                          ]}
                        />
                        <SelectField
                          value={sort}
                          onChange={(v) => handleSortChange(v as SortMode)}
                          options={[
                            { value: 'activity', label: 'Sort: Activity' },
                            { value: 'date',     label: 'Sort: Date' },
                            { value: 'name',     label: 'Sort: Name' },
                          ]}
                        />
                        <SelectField
                          value={group}
                          onChange={(v) => handleGroupChange(v as GroupMode)}
                          options={[
                            { value: 'time',    label: 'Group: Time' },
                            { value: 'company', label: 'Group: Company' },
                          ]}
                        />
                      </div>
                    </div>

                    {noResults ? (
                      <div className="py-16 text-center">
                        <p className="text-gray-400">No projects match the current filters.</p>
                        <button
                          onClick={() => { setSearch(''); setStatusFilter(new Set()); setTileFilter(null) }}
                          className="mt-2 text-sm text-gray-500 underline underline-offset-2 hover:text-gray-900"
                        >Clear filters</button>
                      </div>
                    ) : (
                      sections.map((section, si) => {
                        // Virtualise the Older drawer only — Today /
                        // This week / Pinned / Team / Company sections
                        // are bounded in size and don't need it. The
                        // virtualised renderer reuses the same
                        // ProjectRow component so chips, menus, and
                        // keyboard interaction behave identically.
                        const virtualise = section.kind === 'time' && section.key === 'older'
                        return (
                          <div key={section.key} className={si > 0 ? 'border-t border-gray-100' : ''}>
                            <div className="flex items-center gap-3 bg-gray-50/80 px-5 py-1.5">
                              {section.kind === 'pinned' && <PinIcon className="h-3.5 w-3.5 shrink-0 text-gray-500" />}
                              {section.kind === 'team'   && <UsersIcon className="h-3.5 w-3.5 shrink-0 text-gray-500" />}
                              <span className="text-xs font-semibold uppercase tracking-widest text-gray-500">{section.title}</span>
                              <span className="text-xs text-gray-400 tabular-nums">{section.projects.length}</span>
                            </div>
                            {virtualise ? (
                              <Virtuoso
                                useWindowScroll
                                data={section.projects}
                                overscan={400}
                                computeItemKey={(_, p) => p.proof_id}
                                itemContent={(ri, p) => (
                                  <div className={ri > 0 ? 'border-t border-gray-100' : ''}>
                                    <ProjectRow
                                      project={p}
                                      minePinned={minePinAt.has(p.proof_id)}
                                      teamPinned={teamPinAt.has(p.proof_id)}
                                      onToggleMinePin={toggleMinePin}
                                      onToggleTeamPin={toggleTeamPin}
                                    />
                                  </div>
                                )}
                              />
                            ) : (
                              section.projects.map((p, ri) => (
                                <div key={p.proof_id} className={ri > 0 ? 'border-t border-gray-100' : ''}>
                                  <ProjectRow
                                    project={p}
                                    minePinned={minePinAt.has(p.proof_id)}
                                    teamPinned={teamPinAt.has(p.proof_id)}
                                    onToggleMinePin={toggleMinePin}
                                    onToggleTeamPin={toggleTeamPin}
                                  />
                                </div>
                              ))
                            )}
                          </div>
                        )
                      })
                    )}
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

// Compact native-select dropdown with a chevron. Used by the Sort and
// Group controls. Native <select> gets keyboard accessibility, the OS
// picker on mobile, and screen-reader semantics for free; the wrapper
// just adds the chevron and the muted-pill styling.
function SelectField<T extends string>({
  options,
  value,
  onChange,
}: {
  options: Array<{ value: T; label: string }>
  value: T
  onChange: (v: T) => void
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="cursor-pointer appearance-none rounded-md border border-gray-200 bg-white py-1 pl-2.5 pr-7 text-xs font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-gray-900"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      <svg
        aria-hidden
        viewBox="0 0 16 16"
        className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 text-gray-400"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polyline points="4 6 8 10 12 6" />
      </svg>
    </div>
  )
}
