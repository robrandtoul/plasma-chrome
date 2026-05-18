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
  viewedStateTitle,
  type ViewedState,
} from '../lib/viewedState'
import { designerPreviewPath } from '../lib/customerProofUrl'
import { logAudit } from '../lib/audit'
import { QuoteLink } from '../components/QuoteLink'
import EditProfileModal, { type EditProfileSavedPayload } from '../components/EditProfileModal'
import {
  groupByTime,
  groupByCompany,
  buildSnoozedSection,
  type DashboardProject,
  type DesignerColour,
  type NeedsAttentionRule,
  type ProjectSection,
} from '../lib/dashboardGrouping'

// ── Types ─────────────────────────────────────────────────────────────────────
// DashboardProject, NeedsAttentionRule, DesignerColour, and ProjectSection are
// imported from ../lib/dashboardGrouping so they can be unit-tested
// independently of this React component tree.

type SortMode  = 'activity' | 'date' | 'name'
type GroupMode = 'time' | 'company'
type TileKey   = 'needs_attention' | 'awaiting_customer' | 'dormant' | 'approved_this_week' | 'not_viewed' | 'changes_requested'

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

const SORT_KEY      = 'proofViewer.dashboard.sort'
const GROUP_KEY     = 'proofViewer.dashboard.group'
const ABANDONED_KEY = 'proofViewer.dashboard.showAbandoned'
const SNOOZED_KEY   = 'proofViewer.dashboard.showSnoozed'

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

function readShowAbandoned(): boolean {
  try { return localStorage.getItem(ABANDONED_KEY) === 'true' } catch { /* */ }
  return false
}

function readShowSnoozed(): boolean {
  try { return localStorage.getItem(SNOOZED_KEY) === 'true' } catch { /* */ }
  return false
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
  coral:  'bg-orange-100 text-orange-800 ring-orange-200',
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
        'flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full text-[10px] font-semibold ring-1',
        p.designer_avatar_url ? 'bg-transparent ring-gray-200' : COLOUR_CLASSES[colour],
      ].join(' ')}
    >
      {p.designer_avatar_url
        ? <img src={p.designer_avatar_url} alt="" className="h-full w-full object-cover" />
        : initials
      }
    </span>
  )
}

// ── Status pill (existing — kept identical to pre-redesign) ──────────────────

function statusLabel(status: ProofStatus): string {
  if (status === 'approved')  return 'Approved'
  if (status === 'dormant')   return 'Dormant'
  if (status === 'abandoned') return 'Abandoned'
  return 'In progress'
}

// ── Stat tile ────────────────────────────────────────────────────────────────

interface StatTileProps {
  label: string
  count: number
  active: boolean
  tone: 'rose' | 'amber' | 'sky' | 'neutral' | 'violet' | 'green' | 'turquoise'
  description?: string
  onClick: () => void
}

function StatTile({ label, count, active, tone, description, onClick }: StatTileProps) {
  // Top accent border colour — saturated, no fill on the card body.
  // 'turquoise' maps to Tailwind teal-500 (#14b8a6) — Tailwind doesn't ship a
  // literal turquoise utility, and teal-500 reads as visibly distinct from
  // sky-500 (the Awaiting customer neighbour) thanks to its green tint, where
  // cyan-500 would sit too close to sky.
  const accentBorder =
    tone === 'rose'      ? 'border-t-rose-500'
    : tone === 'amber'   ? 'border-t-amber-500'
    : tone === 'sky'     ? 'border-t-sky-500'
    : tone === 'turquoise' ? 'border-t-teal-500'
    : tone === 'green'   ? 'border-t-emerald-500'
    : tone === 'violet'  ? 'border-t-violet-500'
    :                      'border-t-gray-400'
  // Count colour matches the accent
  const countColour =
    tone === 'rose'      ? 'text-rose-600'
    : tone === 'amber'   ? 'text-amber-500'
    : tone === 'sky'     ? 'text-sky-500'
    : tone === 'turquoise' ? 'text-teal-500'
    : tone === 'green'   ? 'text-emerald-600'
    : tone === 'violet'  ? 'text-violet-600'
    :                      'text-gray-500'
  // Active state: thicker ring in the matching tone; inactive: quiet border
  const activeRing = active
    ? tone === 'rose'      ? 'ring-2 ring-rose-400'
      : tone === 'amber'   ? 'ring-2 ring-amber-400'
      : tone === 'sky'     ? 'ring-2 ring-sky-400'
      : tone === 'turquoise' ? 'ring-2 ring-teal-400'
      : tone === 'green'   ? 'ring-2 ring-emerald-500'
      : tone === 'violet'  ? 'ring-2 ring-violet-400'
      :                      'ring-2 ring-gray-400'
    : 'ring-1 ring-gray-200'
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={[
        'flex flex-col items-start gap-1 rounded-xl border-t-4 bg-white px-5 py-4 text-left transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900',
        accentBorder,
        activeRing,
      ].join(' ')}
    >
      <span className="min-h-8 text-xs font-semibold uppercase tracking-wider text-gray-500">{label}</span>
      <span className={['text-2xl font-bold tabular-nums', countColour].join(' ')}>{count}</span>
      {description && (
        <span className="text-xs text-gray-400">{description}</span>
      )}
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
  onSnooze: (proofId: string, ruleCode: NeedsAttentionRule, hours: number, note: string) => Promise<void>
  onUnsnooze: (proofId: string, ruleCode: NeedsAttentionRule) => Promise<void>
}

function OverflowMenu({
  proof,
  canAddVersion,
  minePinned,
  teamPinned,
  onToggleMinePin,
  onToggleTeamPin,
  onSnooze,
  onUnsnooze,
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
          className="absolute right-0 top-9 z-10 w-56 rounded-lg bg-white py-1 text-sm shadow-lg ring-1 ring-gray-200"
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
          {proof.snoozed_until && proof.snooze_rule_code && (
            <button
              role="menuitem"
              type="button"
              onClick={() => {
                setOpen(false)
                if (proof.snooze_rule_code) {
                  void onUnsnooze(proof.proof_id, proof.snooze_rule_code)
                }
              }}
              className="block w-full border-t border-gray-100 px-3 py-2 text-left text-violet-700 hover:bg-violet-50"
            >
              Unsnooze
            </button>
          )}
          {proof.rule_code && !proof.snoozed_until && (
            <div className="border-t border-gray-100">
              <SnoozeButton proof={proof} onSnooze={onSnooze} menuStyle />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Snooze button + popover ──────────────────────────────────────────────────
//
// Rendered inline next to the reason chip when a proof has an active
// needs-attention rule_code. Clicking the clock icon opens a small
// popover with three preset durations and an optional note field.
// Pattern mirrors OverflowMenu: click-outside + Escape dismiss, and
// e.stopPropagation() throughout so the parent ProjectRow's navigate
// handler is not triggered.

interface SnoozeButtonProps {
  proof: DashboardProject
  onSnooze: (proofId: string, ruleCode: NeedsAttentionRule, hours: number, note: string) => Promise<void>
  // stripStyle: renders a larger, grey-toned button sized to match the
  // action strip. Default (false) renders the smaller amber button used
  // next to the attention chip on narrow screens.
  stripStyle?: boolean
  // menuStyle: renders the trigger as a full-width left-aligned menu item
  // (clock icon + "Snooze" text), styled to match the surrounding entries
  // in OverflowMenu. Used on narrow viewports where the action strip is
  // hidden and the snooze action has to be reachable from the ⋯ menu.
  menuStyle?: boolean
}

function SnoozeButton({ proof, onSnooze, stripStyle = false, menuStyle = false }: SnoozeButtonProps) {
  const [open, setOpen]       = useState(false)
  const [note, setNote]       = useState('')
  const [saving, setSaving]   = useState(false)
  const [customMode, setCustomMode] = useState(false)
  const [customDate, setCustomDate] = useState('')

  // Returns the minimum date string (tomorrow in YYYY-MM-DD) for the date input.
  function minDate() {
    const d = new Date()
    d.setDate(d.getDate() + 1)
    return d.toISOString().slice(0, 10)
  }

  // Convert a YYYY-MM-DD date string into hours from now until the end of
  // that day (i.e. midnight at the start of the following day), so "snooze
  // until Friday" means the proof reappears first thing on Saturday.
  function hoursUntilEndOfDate(dateStr: string): number {
    const target = new Date(dateStr)
    target.setDate(target.getDate() + 1)
    target.setHours(0, 0, 0, 0)
    return Math.max(1, Math.ceil((target.getTime() - Date.now()) / 3_600_000))
  }
  const ref = useRef<HTMLDivElement>(null)

  // Shared dismissal path. Every close — outside click, Escape,
  // explicit Close button — drops the popover back to a clean state
  // so reopening doesn't surface a stale half-typed note or a
  // custom-date row left mid-entry. handleSnooze hits the same
  // path after a successful save.
  function resetState() {
    setOpen(false)
    setNote('')
    setCustomMode(false)
    setCustomDate('')
  }

  useEffect(() => {
    if (!open) return
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) resetState()
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') resetState()
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  async function handleSnooze(hours: number) {
    if (!proof.rule_code || saving) return
    setSaving(true)
    try {
      await onSnooze(proof.proof_id, proof.rule_code, hours, note)
      resetState()
    } catch (err) {
      console.error('[SnoozeButton] onSnooze failed:', err)
    } finally {
      setSaving(false)
    }
  }

  const PRESETS = [
    { label: '24 hours', hours: 24 },
    { label: '48 hours', hours: 48 },
    { label: '1 week',   hours: 168 },
    { label: '2 weeks',  hours: 336 },
    { label: '1 month',  hours: 720 },
  ] as const

  function handleClose(e: React.MouseEvent) {
    e.stopPropagation()
    resetState()
  }

  return (
    <div className="relative" ref={ref}>
      {menuStyle ? (
        <button
          type="button"
          role="menuitem"
          aria-label="Snooze this alert"
          onClick={(e) => { e.stopPropagation(); setOpen((o) => !o) }}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-gray-700 hover:bg-gray-100"
        >
          <ClockIcon className="h-4 w-4 shrink-0 text-gray-400" />
          <span>Snooze</span>
        </button>
      ) : (
        <button
          type="button"
          aria-label="Snooze this alert"
          title="Snooze this alert"
          onClick={(e) => { e.stopPropagation(); setOpen((o) => !o) }}
          className={
            stripStyle
              ? 'flex h-7 w-7 items-center justify-center rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900'
              : 'flex h-5 w-5 items-center justify-center rounded-full text-amber-600 hover:bg-amber-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500'
          }
        >
          <ClockIcon className={stripStyle ? 'h-4 w-4' : 'h-3 w-3'} />
        </button>
      )}
      {open && (
        <div
          role="dialog"
          aria-label="Snooze options"
          className={[
            'absolute z-30 w-56 overflow-hidden rounded-lg bg-white py-2 shadow-lg ring-1 ring-gray-200',
            menuStyle ? 'right-0 top-full mt-1' : stripStyle ? 'right-0 top-8' : 'left-0 top-6',
          ].join(' ')}
          onClick={(e) => e.stopPropagation()}
        >
          {customMode ? (
            /* ── Custom date picker ── */
            <div className="px-3 py-2">
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-gray-400">Snooze until</p>
              <input
                type="date"
                min={minDate()}
                value={customDate}
                onChange={(e) => setCustomDate(e.target.value)}
                className="w-full rounded border border-gray-200 px-2 py-1.5 text-sm text-gray-700 focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900"
                onClick={(e) => e.stopPropagation()}
              />
              <button
                type="button"
                disabled={saving || !customDate}
                onClick={() => handleSnooze(hoursUntilEndOfDate(customDate))}
                className="mt-2 w-full rounded bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-40"
              >{saving ? 'Saving…' : 'Snooze'}</button>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setCustomMode(false); setCustomDate('') }}
                className="mt-1 w-full py-1 text-xs text-gray-400 hover:text-gray-700"
              >← Back</button>
            </div>
          ) : (
            /* ── Preset list ── */
            <>
              <p className="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-400">Snooze for</p>
              {PRESETS.map(({ label, hours }) => (
                <button
                  key={hours}
                  type="button"
                  disabled={saving}
                  onClick={() => handleSnooze(hours)}
                  className="w-full px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-50"
                >{label}</button>
              ))}
              <button
                type="button"
                disabled={saving}
                onClick={(e) => { e.stopPropagation(); setCustomMode(true) }}
                className="w-full px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-50"
              >Custom date…</button>
            </>
          )}
          {/* Note + cancel — shown in both modes */}
          <div className="mt-1 border-t border-gray-100 px-3 pt-2">
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Add a note (optional)"
              rows={2}
              className="w-full resize-none rounded border border-gray-200 px-2 py-1.5 text-xs text-gray-700 placeholder:text-gray-400 focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900"
              onClick={(e) => e.stopPropagation()}
            />
            <button
              type="button"
              onClick={handleClose}
              className="mt-1 w-full py-1 text-xs text-gray-400 hover:text-gray-700"
            >Cancel</button>
          </div>
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
  // Render the inline rule-reason chip as a third row line. Set true only
  // while the Needs attention tile filter is active — outside that view
  // the row stays at its two-line height, and the reason remains visible
  // on hover via the `title` attribute (kept for keyboard / screen-reader
  // parity).
  showReason: boolean
  onToggleMinePin: (proofId: string) => void
  onToggleTeamPin: (proofId: string) => void
  onSnooze: (proofId: string, ruleCode: NeedsAttentionRule, hours: number, note: string) => Promise<void>
  onUnsnooze: (proofId: string, ruleCode: NeedsAttentionRule) => Promise<void>
}

function ProjectRow({
  project,
  minePinned,
  teamPinned,
  showReason,
  onToggleMinePin,
  onToggleTeamPin,
  onSnooze,
  onUnsnooze,
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
      title={[
        statusLabel(project.status),
        project.current_version_viewed_at
          ? `Viewed ${relativeTime(project.current_version_viewed_at)}`
          : viewedStateTitle(viewedStateFor(project)),
        project.rule_code ? reasonChipText(project.rule_code, project.rule_meta?.days) : null,
        !project.rule_code && project.snoozed_until ? `Snoozed until ${formatSnoozeUntil(project.snoozed_until)}` : null,
      ].filter(Boolean).join(' · ')}
      className={[
        'flex cursor-pointer items-center gap-3 border-l-[6px] pl-4 pr-5 py-3 transition-colors hover:bg-gray-50 focus:outline-none focus-visible:bg-gray-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gray-900',
        project.snoozed_until                                                          ? 'border-l-violet-400'  :
        project.rule_code                                                              ? 'border-l-rose-500'    :
        project.status === 'approved'                                                  ? 'border-l-emerald-500' :
        project.status === 'dormant'                                                   ? 'border-l-gray-300'    :
        project.status === 'abandoned'                                                 ? 'border-l-slate-400'   :
        project.current_version_id && project.current_version_viewed_at               ? 'border-l-sky-500'     :
                                                                                         'border-l-amber-400',
        project.status === 'dormant' ? 'opacity-60' : '',
      ].join(' ')}
    >
      {/* No version yet → no designer to attribute → no avatar. */}
      {project.current_version_id && <DesignerAvatar p={project} />}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[15px] font-medium text-gray-900">{projectName}</span>
          {project.current_version_number != null && (
            <span className="shrink-0 text-xs text-gray-400">v{project.current_version_number}</span>
          )}
        </div>
        {subline && <div className="truncate text-xs text-gray-500">{subline}</div>}
        {/* Reason chip — third row line, visible only when the
            Needs attention tile filter is active. Rose dot ties the
            chip back to the rose left-border and the rose tile that
            triggered the filter. Truncates to keep the row to three
            lines on narrow widths; full text remains in the row's
            `title` attribute. */}
        {showReason && project.rule_code && (
          <div className="mt-1 flex items-center gap-1.5 text-xs text-rose-700">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-rose-500" aria-hidden="true" />
            <span className="truncate">{reasonChipText(project.rule_code, project.rule_meta?.days)}</span>
          </div>
        )}
      </div>
      <span className="hidden w-32 shrink-0 text-right text-xs text-gray-400 xl:block" title={ts ? formatAbsoluteDateTime(ts) : undefined}>
        {verb}{ts ? ` ${relativeTime(ts)}` : ''}
      </span>
      <ActionStrip
        proof={project}
        canAddVersion={canAddVersion}
        minePinned={minePinned}
        onToggleMinePin={onToggleMinePin}
        onSnooze={onSnooze}
        onUnsnooze={onUnsnooze}
      />
      <OverflowMenu
        proof={project}
        canAddVersion={canAddVersion}
        minePinned={minePinned}
        teamPinned={teamPinned}
        onToggleMinePin={onToggleMinePin}
        onToggleTeamPin={onToggleTeamPin}
        onSnooze={onSnooze}
        onUnsnooze={onUnsnooze}
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

function PinIcon({ className, filled }: { className?: string; filled?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
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

function ClockIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 4.5v3.75l2.5 1.5" />
    </svg>
  )
}

function PlusIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M8 3v10M3 8h10" />
    </svg>
  )
}

function EyeIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z" />
      <circle cx="8" cy="8" r="2" />
    </svg>
  )
}

// ── Row action button ─────────────────────────────────────────────────────────
//
// Shared button shell for the action strip. Renders as an <a>, <Link>,
// or <button> depending on what's passed. Always stops propagation so
// the parent row's navigate handler is not triggered.

interface RowActionButtonProps {
  label: string
  children: React.ReactNode
  href?: string
  to?: string
  onClick?: (e: React.MouseEvent) => void
  active?: boolean
}

function RowActionButton({ label, children, href, to, onClick, active }: RowActionButtonProps) {
  const cls = [
    'flex h-7 w-7 items-center justify-center rounded-md transition-colors',
    'focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900',
    active
      ? 'bg-violet-100 text-violet-600 hover:bg-violet-200'
      : 'text-gray-400 hover:bg-gray-100 hover:text-gray-700',
  ].join(' ')

  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={label}
        title={label}
        onClick={(e) => { e.stopPropagation(); onClick?.(e) }}
        className={cls}
      >{children}</a>
    )
  }
  if (to) {
    return (
      <Link
        to={to}
        aria-label={label}
        title={label}
        onClick={(e) => { e.stopPropagation(); onClick?.(e) }}
        className={cls}
      >{children}</Link>
    )
  }
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(e) => { e.stopPropagation(); onClick?.(e) }}
      className={cls}
    >{children}</button>
  )
}

// ── Action strip ──────────────────────────────────────────────────────────────
//
// Visible on sm+ screens only. On narrow screens the existing ⋯ overflow
// menu covers the same actions.
//
// All five slots are always rendered so every row occupies the same
// horizontal width — buttons that don't apply to a given proof become
// invisible spacers. This keeps the columns aligned when scanning down
// the list.

interface ActionStripProps {
  proof: DashboardProject
  canAddVersion: boolean
  minePinned: boolean
  onToggleMinePin: (proofId: string) => void
  onSnooze: (proofId: string, ruleCode: NeedsAttentionRule, hours: number, note: string) => Promise<void>
  onUnsnooze: (proofId: string, ruleCode: NeedsAttentionRule) => Promise<void>
}

// Invisible fixed-width spacer — holds the slot open without showing anything.
function StripSpacer() {
  return <span className="h-7 w-7 shrink-0" aria-hidden />
}

function ActionStrip({ proof, canAddVersion, minePinned, onToggleMinePin, onSnooze, onUnsnooze }: ActionStripProps) {
  return (
    <div className="hidden sm:flex shrink-0 items-center gap-0.5">
      {/* Add version */}
      {canAddVersion ? (
        <RowActionButton label="Add version" to={`/proofs/${proof.proof_id}/versions/new`}>
          <PlusIcon className="h-4 w-4" />
        </RowActionButton>
      ) : <StripSpacer />}

      {/* Preview */}
      {proof.current_version_id ? (
        <RowActionButton label="Preview" href={designerPreviewPath(proof.proof_id)}>
          <EyeIcon className="h-4 w-4" />
        </RowActionButton>
      ) : <StripSpacer />}

      {/* Help Scout */}
      {proof.helpscout_conversation_url ? (
        <RowActionButton label="Open in Help Scout" href={proof.helpscout_conversation_url}>
          <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M7 2H3a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V9" />
            <path d="M9.5 1.5h5v5" /><path d="M7.5 8.5l6-6" />
          </svg>
        </RowActionButton>
      ) : <StripSpacer />}

      {/* Pin — always visible; filled when active */}
      <RowActionButton
        label={minePinned ? 'Unpin from your list' : 'Pin to your list'}
        onClick={() => onToggleMinePin(proof.proof_id)}
        active={minePinned}
      >
        <PinIcon className="h-4 w-4" filled={minePinned} />
      </RowActionButton>

      {/* Snooze / Unsnooze — show Unsnooze when the proof is currently
          snoozed (rule_code is cleared by the rules engine while a snooze
          is active), otherwise show Snooze when there's a live attention
          rule_code to snooze. */}
      {proof.snoozed_until && proof.snooze_rule_code ? (
        <UnsnoozeButton proof={proof} onUnsnooze={onUnsnooze} />
      ) : proof.rule_code ? (
        <SnoozeButton proof={proof} onSnooze={onSnooze} stripStyle />
      ) : <StripSpacer />}
    </div>
  )
}

// ── Unsnooze button ───────────────────────────────────────────────────────────
//
// Rendered in the action strip's snooze slot when a proof has an active
// snooze (snoozed_until in the future). Clicking it deletes the
// proof_attention_snoozes row for the (proof_id, rule_code) pair, which
// causes the underlying rule to fire again on the next dashboard refresh.
// Same shell as RowActionButton but renders the strike-through clock icon
// in violet to match the snoozed left-border accent.

interface UnsnoozeButtonProps {
  proof: DashboardProject
  onUnsnooze: (proofId: string, ruleCode: NeedsAttentionRule) => Promise<void>
}

function UnsnoozeButton({ proof, onUnsnooze }: UnsnoozeButtonProps) {
  const [saving, setSaving] = useState(false)
  async function handleClick(e: React.MouseEvent) {
    e.stopPropagation()
    if (!proof.snooze_rule_code || saving) return
    setSaving(true)
    try {
      await onUnsnooze(proof.proof_id, proof.snooze_rule_code)
    } catch (err) {
      console.error('[UnsnoozeButton] onUnsnooze failed:', err)
    } finally {
      setSaving(false)
    }
  }
  return (
    <button
      type="button"
      aria-label="Unsnooze"
      title="Unsnooze"
      disabled={saving}
      onClick={handleClick}
      className="flex h-7 w-7 items-center justify-center rounded-md text-violet-500 hover:bg-violet-100 hover:text-violet-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 disabled:opacity-50"
    >
      <UnsnoozeIcon className="h-4 w-4" />
    </button>
  )
}

// Clock with a diagonal strike-through — signals "remove snooze".
function UnsnoozeIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 4.5v3.75l2.5 1.5" />
      <path d="M2.5 13.5L13.5 2.5" />
    </svg>
  )
}

// Human-readable "until" label for the snooze chip. Shows relative
// time for short snoozes (within 24 h) and a short date otherwise.
function formatSnoozeUntil(iso: string): string {
  const d = new Date(iso)
  const diffMs = d.getTime() - Date.now()
  const diffH = Math.round(diffMs / 3_600_000)
  if (diffH <= 1) return 'soon'
  if (diffH < 24) return `in ${diffH}h`
  const diffDays = Math.round(diffH / 24)
  if (diffDays === 1) return 'tomorrow'
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

// ── Section grouping ─────────────────────────────────────────────────────────
// groupByTime, groupByCompany, buildSnoozedSection, recentlyAwakened,
// SectionKind, and ProjectSection are imported from ../lib/dashboardGrouping.

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
            const rowBg = (isApprove || isOverride)
              ? 'bg-emerald-50 hover:bg-emerald-100 focus-visible:bg-emerald-100'
              : 'hover:bg-gray-50 focus-visible:bg-gray-50'
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
                  'flex cursor-pointer gap-3 py-3 pl-4 pr-5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gray-900',
                  rowBg,
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
                        className="inline-flex items-center rounded-md bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700"
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
  const [latestEvents, setLatestEvents]   = useState<DashboardLatestEvent[]>([])
  const [myProfile, setMyProfile]         = useState<{ initials: string; colour: DesignerColour; avatarUrl: string | null } | null>(null)
  const [avatarOpen, setAvatarOpen]       = useState(false)
  const [editProfileOpen, setEditProfileOpen] = useState(false)
  const avatarRef                         = useRef<HTMLDivElement>(null)
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
  const [showAbandoned, setShowAbandoned] = useState<boolean>(readShowAbandoned)
  const [showSnoozed,   setShowSnoozed]   = useState<boolean>(readShowSnoozed)
  // When the user picks "Snoozed" from the status dropdown we want to show
  // only the Snoozed section and hide the main list. This is distinct from
  // clicking the tile, which shows the Snoozed section alongside the rest.
  const [snoozedOnly,   setSnoozedOnly]   = useState(false)

  useEffect(() => { loadDashboard() }, [])

  // Fetch the signed-in designer's own profile for the header avatar
  useEffect(() => {
    if (!userId) return
    supabase
      .from('profiles')
      .select('designer_initials, designer_colour, full_name, avatar_url')
      .eq('id', userId)
      .single()
      .then(({ data }) => {
        if (!data) return
        setMyProfile({
          initials: (data.designer_initials ?? data.full_name?.split(' ').map((n: string) => n[0]).join('') ?? '?').slice(0, 2),
          colour: (data.designer_colour ?? 'blue') as DesignerColour,
          avatarUrl: data.avatar_url ?? null,
        })
      })
  }, [userId])

  // Close avatar popover on outside click
  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (avatarRef.current && !avatarRef.current.contains(e.target as Node)) {
        setAvatarOpen(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [])

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

    // Note: dashboard_tile_counts() RPC used to be fetched here, but
    // every tile now sources its count client-side from `projects`
    // so the round-trip is dead weight. The SQL function is still
    // emitted by migration 000152 and unchanged on the server; the
    // dropping of the read here is purely a frontend cleanup. See
    // PV-2026W19-015 (awaiting_customer) and PV-2026W20-014
    // (dormant / approved_this_week) for the alignment history.
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
      { data: events },
      { data: pinRows },
    ] = await Promise.all([projectsPromise, eventsPromise, pinsPromise])

    setProjects((projectRows ?? []) as DashboardProject[])

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

  // ── Snooze handlers ───────────────────────────────────────────────────────
  //
  // Upsert on (proof_id, rule_code) so re-snoozing replaces the
  // previous record (e.g. extending from 24 h to 1 week). The view
  // picks up the change on the next loadDashboard() call. No
  // optimistic UI — the list is small and refetches are fast enough
  // that the round-trip is imperceptible.
  async function handleSnooze(proofId: string, ruleCode: NeedsAttentionRule, hours: number, note: string) {
    if (!userId) return
    const snoozedUntil = new Date(Date.now() + hours * 3_600_000).toISOString()
    const { error } = await supabase
      .from('proof_attention_snoozes')
      .upsert(
        {
          proof_id:      proofId,
          rule_code:     ruleCode,
          snoozed_by:    userId,
          snoozed_until: snoozedUntil,
          note:          note.trim() || null,
        },
        { onConflict: 'proof_id,rule_code' },
      )
    if (error) {
      console.error('[handleSnooze] upsert error:', error)
      throw error
    }
    void logAudit({
      action: 'proof.snoozed',
      targetType: 'proof',
      targetId: proofId,
      metadata: { rule_code: ruleCode, hours, note: note.trim() || null },
    })
    await loadDashboard()
  }

  async function handleUnsnooze(proofId: string, ruleCode: NeedsAttentionRule) {
    await supabase
      .from('proof_attention_snoozes')
      .delete()
      .eq('proof_id', proofId)
      .eq('rule_code', ruleCode)
    void logAudit({
      action: 'proof.unsnoozed',
      targetType: 'proof',
      targetId: proofId,
      metadata: { rule_code: ruleCode },
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
    setSnoozedOnly(false)
    setShowSnoozed(false)
    try { localStorage.setItem(SNOOZED_KEY, 'false') } catch { /* */ }
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

  // Tile counts — all computed client-side so counts and filters use exactly
  // the same predicates. Snoozed projects are always excluded: they live in
  // the dedicated Snoozed section regardless of their other state.
  // Needs-attention projects are excluded from every other tile so each
  // project belongs to exactly one tile.
  const needsAttentionCount = useMemo(() =>
    projects.filter((p) =>
      p.rule_code != null &&
      p.snoozed_until == null &&
      (showAbandoned || p.status !== 'abandoned')
    ).length,
  [projects, showAbandoned])

  const notViewedCount = useMemo(() =>
    projects.filter((p) => {
      const isActive = p.status === 'in_progress' || p.status === 'dormant'
      return (
        p.rule_code == null &&
        p.snoozed_until == null &&
        isActive &&
        p.current_version_id !== null &&
        p.current_version_viewed_at === null
      )
    }).length,
  [projects])

  const awaitingCustomerCount = useMemo(() =>
    projects.filter((p) =>
      p.rule_code == null &&
      p.snoozed_until == null &&
      p.status === 'in_progress' &&
      p.current_version_id !== null &&
      p.current_version_viewed_at !== null
    ).length,
  [projects])

  // Changes requested — proofs where the customer's most recent action on the
  // current version was a change request and no newer version has been shipped
  // since. Detection: latest_event_type='request_changes' AND latest_event_at
  // is after version_created_at (which would be later if the designer had
  // uploaded a revision in response). Needs-attention proofs (the overdue
  // subset, captured by the request_changes_no_version rule) are excluded so
  // each proof belongs to exactly one tile — overdue change requests escalate
  // to the Needs attention tile.
  const changesRequestedCount = useMemo(() =>
    projects.filter((p) => {
      if (p.rule_code != null) return false
      if (p.snoozed_until != null) return false
      if (p.status !== 'in_progress') return false
      if (p.latest_event_type !== 'request_changes') return false
      if (!p.latest_event_at || !p.version_created_at) return false
      return new Date(p.latest_event_at).getTime() > new Date(p.version_created_at).getTime()
    }).length,
  [projects])

  // Dormant / Approved-this-week counts. Migration 000152's
  // dashboard_tile_counts() returns server-side counts that do not
  // filter snoozed proofs (the snooze filter is applied in 000164's
  // proofs_needing_attention() only). Computing these client-side
  // with the same p.snoozed_until == null guard ensures the tile
  // count matches the number of rows shown when the tile is clicked
  // (the click-through filter on line 1289 drops snoozed proofs
  // when any tile filter is active). Mirrors the alignment fix from
  // PV-2026W19-015 (awaiting_customer) for the remaining two tiles.
  const dormantCount = useMemo(() =>
    projects.filter((p) =>
      p.snoozed_until == null &&
      p.status === 'dormant'
    ).length,
  [projects])

  const approvedThisWeekCount = useMemo(() => {
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
    return projects.filter((p) => {
      if (p.snoozed_until != null) return false
      if (p.status !== 'approved') return false
      if (!p.approved_at) return false
      return new Date(p.approved_at).getTime() >= sevenDaysAgo
    }).length
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
      // Snoozed projects always belong to the Snoozed section — exclude from
      // every tile filter so they don't appear in the main list when a tile is active.
      if (tileFilter && p.snoozed_until != null) return false
      if (tileFilter === 'needs_attention'    && p.rule_code == null) return false
      if (tileFilter === 'awaiting_customer'  && !(p.rule_code == null && p.status === 'in_progress' && p.current_version_id !== null && p.current_version_viewed_at !== null)) return false
      if (tileFilter === 'dormant'            && p.status !== 'dormant') return false
      if (tileFilter === 'approved_this_week') {
        const cutoff = Date.now() - 7 * 86_400_000
        if (p.status !== 'approved' || !p.approved_at || new Date(p.approved_at).getTime() < cutoff) return false
      }
      if (tileFilter === 'not_viewed') {
        // Active proofs with a current version the customer hasn't opened yet.
        // Needs-attention projects are excluded — they belong to the rose tile only.
        const isActive = p.status === 'in_progress' || p.status === 'dormant'
        if (p.rule_code != null || !isActive || !p.current_version_id || p.current_version_viewed_at !== null) return false
      }
      if (tileFilter === 'changes_requested') {
        // Mirror of changesRequestedCount: latest customer event on the proof is
        // a change request, with no newer version uploaded since. The overdue
        // subset is captured by the request_changes_no_version needs-attention
        // rule and shown there instead — rule_code != null excludes them here.
        if (p.rule_code != null) return false
        if (p.status !== 'in_progress') return false
        if (p.latest_event_type !== 'request_changes') return false
        if (!p.latest_event_at || !p.version_created_at) return false
        if (new Date(p.latest_event_at).getTime() <= new Date(p.version_created_at).getTime()) return false
      }
      // Hide abandoned proofs unless the designer has toggled them on,
      // or has explicitly selected "Abandoned" from the status filter.
      if (!showAbandoned && p.status === 'abandoned' && statusFilter.size === 0) return false
      if (statusFilter.size > 0 && !statusFilter.has(p.status)) return false
      return true
    })
  }, [projects, search, tileFilter, statusFilter, showAbandoned])

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

  // Snoozed projects are always excluded from the tail sections so
  // they don't appear twice. Whether the dedicated Snoozed section
  // itself is rendered is controlled by showSnoozed.
  //
  // Derived from the raw projects list (not filteredProjects / sortedProjects)
  // so that tile and status filters don't affect the snoozed count or section
  // content — a snoozed project stays in the Snoozed section regardless of
  // which tile filter is currently active.
  const snoozedSections = useMemo(
    () => buildSnoozedSection(projects),
    [projects],
  )

  const sections: ProjectSection[] = useMemo(() => {
    // Pinned → (Snoozed if toggled on) → time/company.
    const pinSections = buildPinSections(sortedProjects, minePinAt, teamPinAt)
    const reservedIds = new Set<string>()
    for (const s of pinSections)     for (const p of s.projects) reservedIds.add(p.proof_id)
    // Always exclude snoozed from the tail regardless of showSnoozed —
    // we don't want snoozed proofs appearing in the normal time/company
    // buckets even when the Snoozed section is hidden.
    for (const s of snoozedSections) for (const p of s.projects) reservedIds.add(p.proof_id)
    const remaining = sortedProjects.filter((p) => !reservedIds.has(p.proof_id))
    const tailSections = group === 'company'
      ? groupByCompany(remaining)
      : groupByTime(remaining)
    const visibleSnoozed = showSnoozed ? snoozedSections : []
    // "Snoozed" selected in the status dropdown — suppress pins + tail so only
    // the Snoozed section is visible (same as a status filter for other statuses).
    if (snoozedOnly) return visibleSnoozed
    return [...pinSections, ...visibleSnoozed, ...tailSections]
  }, [sortedProjects, group, minePinAt, teamPinAt, snoozedSections, showSnoozed, snoozedOnly])

  const noResults = !loading && sections.every((s) => s.projects.length === 0)

  return (
    <div className="min-h-dvh bg-gray-50">
      <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">

        {/* Header */}
        <div className="mb-8 flex items-center justify-between gap-4">

          {/* Identity */}
          <div>
            <p className="text-xs font-medium uppercase tracking-widest text-gray-400">Proof viewer</p>
            <h1 className="text-xl font-semibold text-gray-900">Projects</h1>
          </div>

          {/* Nav actions */}
          <div className="flex items-center gap-1">

            {/* Utility tools */}
            <QuoteLink />
            {role === 'admin' && (
              <Link
                to="/admin/users"
                className="rounded-lg px-3 py-2 text-sm font-medium text-gray-900 ring-1 ring-gray-300 hover:bg-white"
              >
                Admin
              </Link>
            )}

            {/* Divider */}
            <span className="mx-2 h-5 w-px bg-gray-200" aria-hidden="true" />

            {/* Primary action */}
            <Link
              to="/proofs/new"
              className="inline-flex items-center gap-1.5 rounded-lg bg-gray-700 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-600"
            >
              <svg className="h-3.5 w-3.5" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M7 1v12M1 7h12"/></svg>
              New project
            </Link>

            {/* Divider */}
            <span className="mx-2 h-5 w-px bg-gray-200" aria-hidden="true" />

            {/* Avatar — sign-out popover */}
            <div ref={avatarRef} className="relative">
              <button
                onClick={() => setAvatarOpen((v) => !v)}
                aria-label="Account menu"
                aria-expanded={avatarOpen}
                className={[
                  'flex h-8 w-8 items-center justify-center overflow-hidden rounded-full text-xs font-semibold ring-1 transition-shadow focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900',
                  myProfile && !myProfile.avatarUrl ? COLOUR_CLASSES[myProfile.colour] : 'bg-gray-100 text-gray-500 ring-gray-200',
                ].join(' ')}
              >
                {myProfile?.avatarUrl
                  ? <img src={myProfile.avatarUrl} alt="Profile" className="h-full w-full object-cover" />
                  : (myProfile?.initials ?? '…')
                }
              </button>
              {avatarOpen && (
                <div className="absolute right-0 top-10 z-20 min-w-[10rem] rounded-xl bg-white py-1 shadow-md ring-1 ring-gray-200">
                  <button
                    onClick={() => { setAvatarOpen(false); setEditProfileOpen(true) }}
                    className="w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
                  >
                    Edit profile
                  </button>
                  <div className="mx-3 my-1 border-t border-gray-100" />
                  <button
                    onClick={handleSignOut}
                    className="w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
                  >
                    Sign out
                  </button>
                </div>
              )}
            </div>

          </div>
        </div>

        {/* Edit profile modal */}
        {editProfileOpen && userId && (
          <EditProfileModal
            userId={userId}
            onClose={() => setEditProfileOpen(false)}
            onSaved={(payload: EditProfileSavedPayload) =>
              setMyProfile({ initials: payload.initials, colour: payload.colour, avatarUrl: payload.avatarUrl })
            }
          />
        )}

        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="min-w-0">

            {loading ? (
              <div className="flex justify-center py-20">
                <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-200 border-t-gray-900" />
              </div>
            ) : (
              <>
                {/* Stat tile row */}
                {/* Three groups, left to right:
                    • Alert    — Needs attention (col 1)
                    • Workflow — the happy path the proof travels through:
                                 Not viewed → Awaiting customer →
                                 Changes requested → Approved this week (cols 2–5)
                    • On hold  — proofs not currently moving through the
                                 workflow: Snoozed, Dormant (cols 6–7)
                    Palette: rose → amber → sky → turquoise → green → violet → gray */}

                {/* Section labels — xl only, one label per group aligned to
                    the matching tile column(s) via the same 7-col grid */}
                <div className="mb-1.5 hidden xl:grid xl:grid-cols-7 xl:gap-3">
                  {/* Alert group — spans column 1 */}
                  <div className="flex items-center gap-2 px-0.5">
                    <span className="text-xs font-semibold uppercase tracking-wider text-rose-500">Alert</span>
                    <span className="h-px flex-1 bg-rose-300" aria-hidden="true" />
                  </div>
                  {/* Workflow group — spans columns 2–5 */}
                  <div className="col-span-4 flex items-center gap-2 px-0.5">
                    <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">Workflow</span>
                    <span className="h-px flex-1 bg-gray-300" aria-hidden="true" />
                  </div>
                  {/* On hold group — spans columns 6–7 */}
                  <div className="col-span-2 flex items-center gap-2 px-0.5">
                    <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">On hold</span>
                    <span className="h-px flex-1 bg-gray-300" aria-hidden="true" />
                  </div>
                </div>

                <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-7">
                  <StatTile
                    label="Needs attention"
                    count={needsAttentionCount}
                    active={tileFilter === 'needs_attention'}
                    tone="rose"
                    description="action required from you"
                    onClick={() => toggleTile('needs_attention')}
                  />
                  <StatTile
                    label="Not viewed"
                    count={notViewedCount}
                    active={tileFilter === 'not_viewed'}
                    tone="amber"
                    description="current version unopened"
                    onClick={() => toggleTile('not_viewed')}
                  />
                  <StatTile
                    label="Awaiting customer"
                    count={awaitingCustomerCount}
                    active={tileFilter === 'awaiting_customer'}
                    tone="sky"
                    description="viewed, no response yet"
                    onClick={() => toggleTile('awaiting_customer')}
                  />
                  <StatTile
                    label="Changes requested"
                    count={changesRequestedCount}
                    active={tileFilter === 'changes_requested'}
                    tone="turquoise"
                    description="awaiting new version from you"
                    onClick={() => toggleTile('changes_requested')}
                  />
                  <StatTile
                    label="Approved"
                    count={approvedThisWeekCount}
                    active={tileFilter === 'approved_this_week'}
                    tone="green"
                    description="approved in last 7 days"
                    onClick={() => toggleTile('approved_this_week')}
                  />
                  <StatTile
                    label="Snoozed"
                    count={snoozedSections[0]?.projects.length ?? 0}
                    active={showSnoozed}
                    tone="violet"
                    description="temporarily hidden"
                    onClick={() => {
                      setShowSnoozed((v) => {
                        const next = !v
                        setSnoozedOnly(next)
                        if (next) setTileFilter(null)
                        try { localStorage.setItem(SNOOZED_KEY, String(next)) } catch { /* */ }
                        return next
                      })
                    }}
                  />
                  <StatTile
                    label="Dormant"
                    count={dormantCount}
                    active={tileFilter === 'dormant'}
                    tone="neutral"
                    description="no activity for 30+ days"
                    onClick={() => toggleTile('dormant')}
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
                          className="w-full rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-900"
                        />
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {/* Status filter */}
                        <SelectField
                          label="Status"
                          value={
                            statusFilter.size === 0 && showSnoozed
                              ? 'snoozed'
                              : statusFilter.size === 0
                                ? 'all'
                                : Array.from(statusFilter)[0] as ProofStatus
                          }
                          onChange={(v) => {
                            if (v === 'snoozed') {
                              setSnoozedOnly(true)
                              setStatusFilter(new Set())
                              setShowSnoozed((prev) => {
                                if (prev) return prev
                                try { localStorage.setItem(SNOOZED_KEY, 'true') } catch { /* */ }
                                return true
                              })
                            } else {
                              setSnoozedOnly(false)
                              if (v === 'all') setStatusFilter(new Set())
                              else setStatusFilter(new Set([v as ProofStatus]))
                            }
                          }}
                          options={[
                            { value: 'all',         label: `All (${projects.length})` },
                            { value: 'in_progress', label: `In progress (${statusCounts.in_progress})` },
                            { value: 'approved',    label: `Approved (${statusCounts.approved})` },
                            { value: 'dormant',     label: `Dormant (${statusCounts.dormant})` },
                            { value: 'abandoned',   label: `Abandoned (${statusCounts.abandoned})` },
                            { value: 'snoozed',     label: `Snoozed (${snoozedSections[0]?.projects.length ?? 0})` },
                          ]}
                        />

                        {/* Divider — separates filter from view controls */}
                        <span className="h-4 w-px bg-gray-200" aria-hidden="true" />

                        {/* Sort + Group */}
                        <SelectField
                          label="Sort"
                          value={sort}
                          onChange={(v) => handleSortChange(v as SortMode)}
                          options={[
                            { value: 'activity', label: 'Activity' },
                            { value: 'date',     label: 'Date' },
                            { value: 'name',     label: 'Name' },
                          ]}
                        />
                        <SelectField
                          label="Group"
                          value={group}
                          onChange={(v) => handleGroupChange(v as GroupMode)}
                          options={[
                            { value: 'time',    label: 'Time' },
                            { value: 'company', label: 'Company' },
                          ]}
                        />

                        {/* Abandoned checkbox toggle — pushed to far right */}
                        <span className="flex-1" aria-hidden="true" />
                        <button
                          onClick={() => {
                            setShowAbandoned((v) => {
                              const next = !v
                              try { localStorage.setItem(ABANDONED_KEY, String(next)) } catch { /* */ }
                              return next
                            })
                          }}
                          className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors ${
                            showAbandoned
                              ? 'border-gray-400 bg-gray-100 text-gray-800'
                              : 'border-gray-300 bg-white text-gray-500 shadow-sm hover:bg-gray-50 hover:text-gray-700'
                          }`}
                        >
                          {/* Checkbox indicator */}
                          <span className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border ${showAbandoned ? 'border-gray-600 bg-gray-700' : 'border-gray-300'}`}>
                            {showAbandoned && (
                              <svg viewBox="0 0 10 10" className="h-2.5 w-2.5 text-white" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="1.5 5 4 7.5 8.5 2.5" />
                              </svg>
                            )}
                          </span>
                          Abandoned
                        </button>
                      </div>
                    </div>

                    {noResults ? (
                      <div className="py-16 text-center">
                        <p className="text-gray-400">No projects match the current filters.</p>
                        <button
                          onClick={() => {
                            setSearch('')
                            setStatusFilter(new Set())
                            setTileFilter(null)
                            setShowAbandoned(false)
                            setShowSnoozed(false)
                            setSnoozedOnly(false)
                            try { localStorage.setItem(ABANDONED_KEY, 'false') } catch { /* */ }
                            try { localStorage.setItem(SNOOZED_KEY, 'false') } catch { /* */ }
                          }}
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
                        const virtualise = section.kind === 'time' && section.key === 'older' && section.projects.length > 30
                        return (
                          <div key={section.key} className={si > 0 ? 'border-t border-gray-100' : ''}>
                            <div className="flex items-center gap-3 bg-gray-50/80 px-5 py-2 pt-12">
                              {section.kind === 'pinned'  && <PinIcon className="h-3.5 w-3.5 shrink-0 text-gray-600" />}
                              {section.kind === 'team'    && <UsersIcon className="h-3.5 w-3.5 shrink-0 text-gray-600" />}
                              {section.kind === 'snoozed' && <ClockIcon className="h-3.5 w-3.5 shrink-0 text-gray-600" />}
                              <span className="text-sm font-bold uppercase tracking-wider text-gray-700">{section.title}</span>
                              <span className="text-xs font-medium text-gray-500 tabular-nums">{section.projects.length}</span>
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
                                      onSnooze={handleSnooze}
                                      onUnsnooze={handleUnsnooze}
                                      showReason={tileFilter === 'needs_attention'}
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
                                    onSnooze={handleSnooze}
                                    onUnsnooze={handleUnsnooze}
                                    showReason={tileFilter === 'needs_attention'}
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
            <aside className="hidden lg:sticky lg:top-10 lg:block lg:self-start xl:pt-4">
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
  label,
}: {
  options: Array<{ value: T; label: string }>
  value: T
  onChange: (v: T) => void
  label?: string
}) {
  return (
    <div className="relative inline-flex items-center rounded-md border border-gray-300 bg-white shadow-sm hover:bg-gray-50 focus-within:ring-2 focus-within:ring-gray-900">
      {label && (
        <span className="pointer-events-none select-none pl-2.5 text-xs font-medium text-gray-400">
          {label}
        </span>
      )}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="cursor-pointer appearance-none bg-transparent py-1.5 pl-1 pr-7 text-xs font-medium text-gray-800 focus:outline-none"
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
