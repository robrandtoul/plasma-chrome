import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useNavigate } from 'react-router-dom'
import { DesignerHeader, ButtonCoral, ButtonGhost, ButtonInk, ProofStatusPill, type DesignerHeaderColour } from '../design'
import { Plus, Filter, X, Maximize2, Bell, MessageSquare, Eye, Check } from 'lucide-react'
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
  isCurrentlySnoozed,
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
type ChipKey   = 'all' | 'mine' | 'needs_me' | 'last_7_days' | 'steel' | 'letterpress'

// Reason chip text per rule. Templated against rule_meta.days where
// the rule has a threshold. Kept here rather than in a shared lib
// because the dashboard is the only renderer; the admin editor uses
// its own humanised labels (rule name + description) for the cards.
function reasonChipText(code: NeedsAttentionRule, days: number | undefined): string {
  switch (code) {
    case 'request_changes_no_version':
      return `Customer requested changes ${days ?? '—'} days ago, no new version`
    case 'helpscout_follow_up_tag':
      return 'Help Scout conversation tagged "follow up"'
    case 'sent_never_viewed':
      return `Sent ${days ?? '—'} days ago, never opened`
    case 'viewed_not_actioned':
      return `Last viewed ${days ?? '—'} days ago, no action since`
    case 'approaching_dormant':
      return `Approaching dormant — ${days ?? '—'} days since last activity`
    case 'stuck_in_progress':
      return `Stuck in progress — no activity for ${days ?? '—'} days`
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
const CHIP_KEY      = 'proofViewer.dashboard.chip'

// Filter chip strip — six fixed chips per the mockup. Ordered left
// to right as: clear → ownership → attention → recency → two top
// materials. Material chips are pinned to Steel + Letterpress
// because they cover the highest-traffic product families; a future
// "Saved views" feature can carry per-designer custom chip sets.
const CHIPS = [
  { value: 'all',          label: 'All' },
  { value: 'mine',         label: 'Mine' },
  { value: 'needs_me',     label: 'Needs me' },
  { value: 'last_7_days',  label: 'Last 7 days' },
  { value: 'steel',        label: 'Steel' },
  { value: 'letterpress',  label: 'Letterpress' },
] as const

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

function readChip(): ChipKey {
  try {
    const v = localStorage.getItem(CHIP_KEY)
    if (v === 'all' || v === 'mine' || v === 'needs_me' || v === 'last_7_days' || v === 'steel' || v === 'letterpress') return v
  } catch { /* */ }
  return 'all'
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
//
// Per-designer colour bg / text. Soft 14% tint background with a solid
// text colour matches the readability you want at 24px — solid bg +
// white text (the DesignerHeader UserPill pattern) reads too heavy
// when 20+ avatars stack in a dashboard list. Same four-colour palette
// as DesignerHeader's COLOUR_BG so the header pill and row avatars
// share the same designer-identity register.

const AVATAR_COLOUR: Record<DesignerColour, string> = {
  blue:   'var(--c-allocated)',
  teal:   'var(--c-in-stock)',
  coral:  'var(--c-brand)',
  purple: '#7b3ff2',
}

function DesignerAvatar({ p }: { p: DashboardProject }) {
  const initials = (p.designer_initials ?? '').slice(0, 2) || '—'
  const colour = (p.designer_colour ?? 'teal') as DesignerColour
  const tint = AVATAR_COLOUR[colour]
  const tooltip = p.designer_name && p.current_version_number != null && p.version_created_at
    ? `${p.designer_name} — v${p.current_version_number} created ${formatAbsoluteDateTime(p.version_created_at)}`
    : p.designer_name ?? ''
  const tintedStyle = p.designer_avatar_url
    ? undefined
    : {
        backgroundColor: `color-mix(in srgb, ${tint} 14%, transparent)`,
        color: tint,
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${tint} 30%, transparent)`,
      }
  return (
    <span
      title={tooltip}
      aria-label={tooltip}
      className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full text-[10px] font-semibold"
      style={tintedStyle}
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

// ── Hero strip helpers ───────────────────────────────────────────────────────

// Time-of-day greeting for the hero. Splits at the standard 12 / 17 hour
// boundaries so the greeting tracks the working day — Rob's mornings
// run long and the cutover at noon / 5pm is what most office tools use.
function greetingFor(d: Date): string {
  const h = d.getHours()
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  return 'Good evening'
}

// "Wednesday, 27 May" — uses Intl with the default en-GB locale so the
// day-then-month ordering matches Rob's expectations. No year; the
// hero is for today, not historical context.
function todayLabel(d: Date): string {
  return d.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  })
}

// ── Stat tile ────────────────────────────────────────────────────────────────

interface StatTileProps {
  label: string
  count: number
  active: boolean
  tone: 'rose' | 'amber' | 'sky' | 'neutral' | 'violet' | 'green' | 'turquoise'
  onClick: () => void
}

// Tone → CSS colour mapping. Design-system tokens where they map
// cleanly to the seven dashboard tones; explicit hues for the two
// (turquoise, violet) where the token palette doesn't reach. The
// neutral tone uses the ink-mute token rather than a saturated
// colour so Dormant reads as a backwater rather than an alert.
const TILE_COLOUR: Record<StatTileProps['tone'], string> = {
  rose:      'var(--c-out)',
  amber:     'var(--c-low)',
  sky:       'var(--c-allocated)',
  turquoise: '#0d9488',
  green:     'var(--c-in-stock)',
  violet:    '#7c3aed',
  neutral:   'var(--c-ink-mute)',
}

function StatTile({ label, count, active, tone, onClick }: StatTileProps) {
  const tint = TILE_COLOUR[tone]
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className="flex flex-col items-start gap-2 px-5 py-5 text-left transition-colors hover:bg-canvas focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--c-brand)] relative"
      style={{
        // Active state: a soft tint of the tile's tone fills the cell
        // background. Cleaner than an inset ring when each cell sits
        // inside a unified panel — the ring would compete with the
        // panel border and the dividing hairlines.
        backgroundColor: active ? `color-mix(in srgb, ${tint} 8%, transparent)` : undefined,
      }}
    >
      {/* Dot + label row. Dot picks up the tile's tone; label uses the
          eyebrow class (inline whitespace-normal so long labels wrap —
          see PR 17c for why the override has to be inline). */}
      <div className="flex items-baseline gap-2 min-h-[24px]">
        <span
          aria-hidden="true"
          className="inline-block w-2 h-2 rounded-full shrink-0 translate-y-[-1px]"
          style={{ backgroundColor: tint }}
        />
        <span
          className="eyebrow text-ink-mute"
          style={{ whiteSpace: 'normal', lineHeight: 1.2 }}
        >
          {label}
        </span>
      </div>
      <span
        className="text-[32px] leading-none font-medium tabular-nums font-mono text-ink"
        style={{ fontFeatureSettings: 'var(--num-features)' }}
      >
        {String(count).padStart(2, '0')}
      </span>
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
        className="flex h-8 w-8 items-center justify-center rounded-md text-ink-mute hover:bg-canvas hover:text-ink focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--c-brand)]"
      >
        <svg viewBox="0 0 16 16" className="h-4 w-4" fill="currentColor"><circle cx="3" cy="8" r="1.5" /><circle cx="8" cy="8" r="1.5" /><circle cx="13" cy="8" r="1.5" /></svg>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-9 z-10 w-56 rounded-[10px] bg-surface py-1 text-sm shadow-md border border-line"
          onClick={(e) => e.stopPropagation()}
        >
          {proof.current_version_id ? (
            <a
              role="menuitem"
              href={designerPreviewPath(proof.proof_id)}
              target="_blank"
              rel="noopener noreferrer"
              className="block px-3 py-2 text-ink-soft hover:bg-canvas"
              onClick={() => setOpen(false)}
            >Preview</a>
          ) : (
            <span role="menuitem" aria-disabled className="block cursor-not-allowed px-3 py-2 text-ink-dim">Preview</span>
          )}
          {canAddVersion ? (
            <Link
              role="menuitem"
              to={`/proofs/${proof.proof_id}/versions/new`}
              className="block px-3 py-2 text-ink-soft hover:bg-canvas"
              onClick={() => setOpen(false)}
            >Add version</Link>
          ) : (
            <span role="menuitem" aria-disabled className="block cursor-not-allowed px-3 py-2 text-ink-dim">Add version</span>
          )}
          {proof.helpscout_conversation_url && (
            <a
              role="menuitem"
              href={proof.helpscout_conversation_url}
              target="_blank"
              rel="noopener noreferrer"
              className="block px-3 py-2 text-ink-soft hover:bg-canvas"
              onClick={() => setOpen(false)}
            >Open in Help Scout</a>
          )}
          <button
            role="menuitem"
            type="button"
            onClick={() => { setOpen(false); onToggleMinePin(proof.proof_id) }}
            className="block w-full border-t border-line-soft px-3 py-2 text-left text-ink-soft hover:bg-canvas"
          >
            {minePinned ? 'Unpin from your list' : 'Pin to your list'}
          </button>
          <button
            role="menuitem"
            type="button"
            onClick={() => { setOpen(false); onToggleTeamPin(proof.proof_id) }}
            className="block w-full px-3 py-2 text-left text-ink-soft hover:bg-canvas"
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
              className="block w-full border-t border-line-soft px-3 py-2 text-left hover:bg-canvas"
              style={{ color: '#7b3ff2' }}
            >
              Unsnooze
            </button>
          )}
          {proof.rule_code && !proof.snoozed_until && (
            <div className="border-t border-line-soft">
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
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-ink-soft hover:bg-canvas"
        >
          <ClockIcon className="h-4 w-4 shrink-0 text-ink-mute" />
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
              ? 'flex h-7 w-7 items-center justify-center rounded-md text-ink-mute hover:bg-canvas hover:text-ink focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--c-brand)]'
              : 'flex h-5 w-5 items-center justify-center rounded-full text-low hover:bg-low-soft focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--c-low)]'
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
            'absolute z-30 w-56 overflow-hidden rounded-[10px] bg-surface py-2 shadow-md border border-line',
            menuStyle ? 'right-0 top-full mt-1' : stripStyle ? 'right-0 top-8' : 'left-0 top-6',
          ].join(' ')}
          onClick={(e) => e.stopPropagation()}
        >
          {customMode ? (
            /* ── Custom date picker ── */
            <div className="px-3 py-2">
              <p className="mb-2 eyebrow text-ink-mute">Snooze until</p>
              <input
                type="date"
                min={minDate()}
                value={customDate}
                onChange={(e) => setCustomDate(e.target.value)}
                className="w-full rounded border border-line px-2 py-1.5 text-sm text-ink-soft focus:border-[var(--c-brand)] focus:outline-none focus:outline-2 focus:outline-offset-[-1px] focus:outline-[var(--c-brand)]"
                onClick={(e) => e.stopPropagation()}
              />
              <button
                type="button"
                disabled={saving || !customDate}
                onClick={() => handleSnooze(hoursUntilEndOfDate(customDate))}
                className="mt-2 w-full rounded bg-ink px-3 py-1.5 text-sm font-medium text-on-ink hover:opacity-90 disabled:opacity-40"
              >{saving ? 'Saving…' : 'Snooze'}</button>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setCustomMode(false); setCustomDate('') }}
                className="mt-1 w-full py-1 text-xs text-ink-mute hover:text-ink-soft"
              >← Back</button>
            </div>
          ) : (
            /* ── Preset list ── */
            <>
              <p className="px-3 pb-1.5 eyebrow text-ink-mute">Snooze for</p>
              {PRESETS.map(({ label, hours }) => (
                <button
                  key={hours}
                  type="button"
                  disabled={saving}
                  onClick={() => handleSnooze(hours)}
                  className="w-full px-3 py-2 text-left text-sm text-ink-soft hover:bg-canvas disabled:opacity-50"
                >{label}</button>
              ))}
              <button
                type="button"
                disabled={saving}
                onClick={(e) => { e.stopPropagation(); setCustomMode(true) }}
                className="w-full px-3 py-2 text-left text-sm text-ink-soft hover:bg-canvas disabled:opacity-50"
              >Custom date…</button>
            </>
          )}
          {/* Note + cancel — shown in both modes */}
          <div className="mt-1 border-t border-line-soft px-3 pt-2">
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Add a note (optional)"
              rows={2}
              className="w-full resize-none rounded border border-line px-2 py-1.5 text-xs text-ink-soft placeholder:text-ink-dim focus:border-[var(--c-brand)] focus:outline-none focus:outline-2 focus:outline-offset-[-1px] focus:outline-[var(--c-brand)]"
              onClick={(e) => e.stopPropagation()}
            />
            <button
              type="button"
              onClick={handleClose}
              className="mt-1 w-full py-1 text-xs text-ink-mute hover:text-ink-soft"
            >Cancel</button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Thumbnail hover preview popover ──────────────────────────────────────────
//
// Floating preview anchored to the dashboard row's thumbnail. Renders
// at ~320px wide via createPortal so it escapes the row's
// overflow-hidden clipping and any parent stacking contexts. Positions
// itself to the right of the anchor when there's room, otherwise to
// the left; vertical alignment biases up so most rows have headroom.
// The popover is presentation-only: no click handlers, no focus
// management, no aria-modal. The lightbox covers the "I want to act
// on this" case.

interface ThumbnailPopoverProps {
  anchor: HTMLElement
  imageUrl: string
  projectName: string
}

function ThumbnailPopover({ anchor, imageUrl, projectName }: ThumbnailPopoverProps) {
  const rect = anchor.getBoundingClientRect()
  // 12px gap between the anchor and the popover; the popover's
  // shadow ensures it reads as a separate floating surface.
  const GAP = 12
  const POPOVER_W = 320
  const POPOVER_H_GUESS = 240 // assumed before paint; only used for edge tests
  const wouldOverflowRight = rect.right + GAP + POPOVER_W > window.innerWidth - 16
  const left = wouldOverflowRight
    ? Math.max(16, rect.left - GAP - POPOVER_W)
    : rect.right + GAP
  // Vertical: try to center on the anchor; clamp to viewport.
  const idealTop = rect.top + rect.height / 2 - POPOVER_H_GUESS / 2
  const top = Math.max(16, Math.min(idealTop, window.innerHeight - POPOVER_H_GUESS - 16))
  return createPortal(
    <div
      role="presentation"
      aria-hidden="true"
      className="fixed z-[60] rounded-[10px] bg-surface border border-line shadow-md p-2 pointer-events-none"
      style={{ left, top, width: POPOVER_W }}
    >
      <img
        src={imageUrl}
        alt=""
        className="block w-full h-auto max-h-[300px] object-contain rounded-[6px] bg-canvas"
      />
      <div className="mt-2 px-1 pb-0.5 text-[12px] text-ink-mute truncate">
        {projectName}
      </div>
    </div>,
    document.body,
  )
}

// ── Thumbnail click lightbox ──────────────────────────────────────────────────
//
// Fullscreen modal. ESC + backdrop click both close. The Open project
// CTA navigates through to the proof detail page where the
// customer-page-style full image set + actions live. Click on the image
// itself does nothing — separated from the close affordance so the
// designer can rest the cursor on the image without dismissing the
// modal accidentally.

interface ThumbnailLightboxProps {
  imageUrl: string
  projectName: string
  onClose: () => void
  onOpenProject: () => void
}

function ThumbnailLightbox({ imageUrl, projectName, onClose, onOpenProject }: ThumbnailLightboxProps) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    // Lock background scroll so the lightbox feels modal.
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [onClose])

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${projectName} preview`}
      className="fixed inset-0 z-[70] flex flex-col items-center justify-center bg-black/80 p-8"
      onClick={onClose}
    >
      <button
        type="button"
        aria-label="Close preview"
        onClick={(e) => { e.stopPropagation(); onClose() }}
        className="absolute top-4 right-4 inline-flex items-center justify-center w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 text-white"
      >
        <X size={16} />
      </button>
      <img
        src={imageUrl}
        alt={projectName}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[80vh] max-w-[90vw] object-contain rounded-[8px] shadow-lg"
      />
      <div className="mt-6 flex items-center gap-3" onClick={(e) => e.stopPropagation()}>
        <span className="text-[14px] text-white/70">{projectName}</span>
        <ButtonInk onClick={() => { onOpenProject(); onClose() }}>
          Open project
        </ButtonInk>
      </div>
    </div>,
    document.body,
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
  /** Signed URL for the project's first front image. Undefined while
   *  loadThumbnails is in flight or when the version has no images;
   *  the row falls through to the dark-plate initials placeholder. */
  thumbnailUrl?: string
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
  thumbnailUrl,
  onToggleMinePin,
  onToggleTeamPin,
  onSnooze,
  onUnsnooze,
}: ProjectRowProps) {
  // Hover popover + click lightbox state. Both gate on a real
  // thumbnailUrl — when no image is available (placeholder rendering)
  // the thumb is non-interactive and shows nothing on hover/click.
  const [previewOpen, setPreviewOpen] = useState(false)
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const hoverTimerRef = useRef<number | null>(null)
  const thumbRef = useRef<HTMLDivElement>(null)

  function handleThumbMouseEnter() {
    if (!thumbnailUrl) return
    // 400ms delay matches the standard tooltip pattern — long enough
    // to skip accidental flyovers, short enough to feel responsive
    // when a designer pauses to look.
    hoverTimerRef.current = window.setTimeout(() => setPreviewOpen(true), 400)
  }
  function handleThumbMouseLeave() {
    if (hoverTimerRef.current != null) {
      window.clearTimeout(hoverTimerRef.current)
      hoverTimerRef.current = null
    }
    setPreviewOpen(false)
  }
  function handleThumbClick(e: React.MouseEvent) {
    e.stopPropagation()
    if (!thumbnailUrl) return
    setLightboxOpen(true)
    // Close the hover popover when the click takes over.
    setPreviewOpen(false)
  }

  // Clean up the hover timer on unmount so a virtualised row leaving
  // the viewport doesn't fire a stale setPreviewOpen.
  useEffect(() => {
    return () => {
      if (hoverTimerRef.current != null) window.clearTimeout(hoverTimerRef.current)
    }
  }, [])
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
  // 2-3 character thumbnail placeholder derived from the project
  // name. First letter of each word, capped at 3, uppercased.
  // Real thumbnails are wired in PR 25 via a public_dashboard_projects
  // column + signed-URL fetch — until then every row shows this
  // dark-plate placeholder per the handoff brief.
  const thumbInitials = projectName
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .slice(0, 3)
    .join('')
    .toUpperCase() || '—'

  const updatedLabel = ts
    ? new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
    : '—'

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
        !project.rule_code && isCurrentlySnoozed(project) ? `Snoozed until ${formatSnoozeUntil(project.snoozed_until!)}` : null,
        ts ? `${verb} ${relativeTime(ts)}` : null,
      ].filter(Boolean).join(' · ')}
      className={[
        // Each row is now a standalone card: bg-surface + hairline
        // border + rounded corners + wide coloured left cap that the
        // overflow-hidden lets respect the rounding. group + relative
        // for the hover-only action overlay further down.
        'group relative cursor-pointer overflow-hidden rounded-[10px] bg-surface border border-line border-l-[10px] pl-4 pr-5 py-3 transition-colors hover:bg-canvas focus:outline-none focus-visible:bg-canvas focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--c-brand)]',
        project.status === 'dormant' ? 'opacity-60' : '',
      ].join(' ')}
      style={{
        // Left-border colour map. Each rule maps to a design-system
        // token so the row's status accent reads in the same palette
        // as the stat tile that filters to it. Snooze + dormant
        // overrides use the same hues their corresponding tiles use.
        borderLeftColor:
          isCurrentlySnoozed(project)                                       ? '#7c3aed' :  // matches violet tile
          project.rule_code                                                 ? 'var(--c-out)' :  // matches rose Needs attention tile
          project.status === 'approved'                                     ? 'var(--c-in-stock)' :  // matches green Approved tile
          project.status === 'dormant'                                      ? 'var(--c-ink-dim)' :   // matches neutral Dormant tile
          project.status === 'abandoned'                                    ? 'var(--c-ink-mute)' :  // quieter still
          project.current_version_id && project.current_version_viewed_at  ? 'var(--c-allocated)' : // matches sky Awaiting tile
                                                                              'var(--c-low)',        // matches amber Not viewed tile
      }}
    >
      {/* Columnar grid layout per the mockup. At md+ widths the row
          reads as a clean six-column table; at narrower widths some
          columns drop (Material, Versions, Updated) so Customer +
          Status stay legible. */}
      <div className="grid items-center gap-3 grid-cols-[56px_minmax(0,1fr)_auto_auto] sm:grid-cols-[56px_minmax(0,1fr)_140px_auto] md:grid-cols-[56px_minmax(0,1fr)_140px_60px_70px_24px_110px]">
        {/* Thumbnail — real signed-URL image when loadThumbnails has
            produced one for this version. Falls through to a dark
            plate with the project's initials when no URL is available
            (no version yet, no images uploaded, or fetch still in
            flight). loading="lazy" defers off-screen image fetches
            so opening the dashboard doesn't blast 100+ requests at
            once.
            Hover (400ms delay) opens the floating preview popover;
            click opens the lightbox. The group/peer-hover Maximize
            glyph hints clickability when an image is present. */}
        <div
          ref={thumbRef}
          onClick={handleThumbClick}
          onMouseEnter={handleThumbMouseEnter}
          onMouseLeave={handleThumbMouseLeave}
          className={[
            'relative flex items-center justify-center w-[56px] h-[36px] rounded-[4px] bg-ink text-on-ink font-mono font-medium text-[10px] tracking-wider overflow-hidden',
            thumbnailUrl ? 'cursor-zoom-in' : '',
          ].join(' ')}
        >
          {thumbnailUrl ? (
            <>
              <img
                src={thumbnailUrl}
                alt=""
                loading="lazy"
                className="w-full h-full object-cover"
              />
              {/* Hover affordance — a Maximize glyph in a dark scrim
                  appears on thumb hover so designers know the thumb
                  is interactive. The row's wider hover state isn't
                  enough — that's also true for the action overlay,
                  which lives elsewhere. */}
              <span
                aria-hidden="true"
                className="absolute inset-0 flex items-center justify-center bg-black/55 text-white opacity-0 hover:opacity-100 transition-opacity"
              >
                <Maximize2 size={14} />
              </span>
            </>
          ) : (
            thumbInitials
          )}
        </div>
        {/* Hover popover — portal-rendered so it can escape the row's
            overflow-hidden and the section's stacking context. Anchored
            to the thumb's bounding rect via the helper below. */}
        {previewOpen && thumbnailUrl && thumbRef.current && (
          <ThumbnailPopover
            anchor={thumbRef.current}
            imageUrl={thumbnailUrl}
            projectName={projectName}
          />
        )}
        {/* Click lightbox — fullscreen modal with the same image at
            max viewport size. Click backdrop or ESC to close; the
            Open project button navigates to the proof detail page. */}
        {lightboxOpen && thumbnailUrl && (
          <ThumbnailLightbox
            imageUrl={thumbnailUrl}
            projectName={projectName}
            onClose={() => setLightboxOpen(false)}
            onOpenProject={() => navigate(`/proofs/${project.proof_id}`)}
          />
        )}

        {/* Customer: name on row 1, company sub-line on row 2.
            The version label moves to its own column on md+. */}
        <div className="min-w-0">
          <div className="truncate text-[15px] font-medium text-ink">{projectName}</div>
          {subline && <div className="truncate text-xs text-ink-mute mt-0.5">{subline}</div>}
          {/* Reason chip — third row line, visible only when the Needs
              attention tile filter is active. */}
          {showReason && project.rule_code && (
            <div className="mt-1 flex items-center gap-1.5 text-xs text-out">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-out" aria-hidden="true" />
              <span className="truncate">{reasonChipText(project.rule_code, project.rule_meta?.days)}</span>
            </div>
          )}
        </div>

        {/* Material — hidden below sm. Variant sub-line will land in
            PR 25+ once the dashboard view exposes it. */}
        <div className="hidden sm:block min-w-0">
          <div className="truncate text-[13px] text-ink-soft">{project.material_display ?? '—'}</div>
        </div>

        {/* Versions — only at md+ so narrow widths don't fragment. */}
        {project.current_version_number != null ? (
          <div className="hidden md:block text-[12px] text-ink-mute font-mono tabular-nums" style={{ fontFeatureSettings: 'var(--num-features)' }}>
            {String(project.current_version_number).padStart(2, '0')} <span className="text-ink-dim">vers</span>
          </div>
        ) : (
          <div className="hidden md:block" />
        )}

        {/* Updated — md+ only. Always shows the activityVerb's
            timestamp formatted as "27 May". */}
        <div className="hidden md:block text-[12px] text-ink-mute font-mono tabular-nums" style={{ fontFeatureSettings: 'var(--num-features)' }}>
          {updatedLabel}
        </div>

        {/* Owner avatar — md+ only. No version yet → no designer to
            attribute → empty slot kept so the grid column stays. */}
        <div className="hidden md:flex items-center justify-center">
          {project.current_version_id && <DesignerAvatar p={project} />}
        </div>

        {/* Status pill — always visible on all widths. Fades out on
            row hover/focus-within so the action overlay can take over
            the right edge without layout jump. */}
        <div className="flex justify-end items-center transition-opacity group-hover:opacity-0 group-focus-within:opacity-0">
          <ProofStatusPill status={project.status} />
        </div>
      </div>

      {/* Hover-only action overlay. Absolutely positioned over the
          right edge so the status pill underneath gets covered cleanly
          on hover/focus-within. bg-canvas matches the row's hover bg
          so the transition reads as the same surface, no visible
          colour-band when the actions slide in.
          opacity-0 at rest; group-hover and group-focus-within both
          opaque so the popover from the overflow menu doesn't close
          when the cursor leaves the row. */}
      <div className="absolute right-3 top-0 bottom-0 flex items-center gap-0.5 pl-3 bg-canvas opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity pointer-events-none group-hover:pointer-events-auto group-focus-within:pointer-events-auto">
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
    'focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--c-brand)]',
    active
      ? 'text-ink hover:opacity-90'
      : 'text-ink-mute hover:bg-canvas hover:text-ink',
  ].join(' ')
  const activeStyle = active
    ? { backgroundColor: 'color-mix(in srgb, #7b3ff2 14%, transparent)', color: '#7b3ff2' }
    : undefined

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
        style={activeStyle}
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
        style={activeStyle}
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
      style={activeStyle}
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

      {/* Snooze / Unsnooze — show Unsnooze whenever the proof carries a
          snooze row (snoozed_until + snooze_rule_code). Post-000186 that
          also covers the 24-hour post-expiry grace window, so a designer
          can still clear a freshly-expired snooze. Otherwise show Snooze
          when there's a live attention rule_code to snooze. */}
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
      className="flex h-7 w-7 items-center justify-center rounded-md hover:opacity-100 focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-1 disabled:opacity-50"
      style={{
        color: '#7b3ff2',
        // Hover/focus tint sits at a higher source order than the
        // pseudo-classes, so apply via class would lose. Inline-style
        // ring + bg via :hover would need a sibling stylesheet. Keep
        // it as a flat coloured icon button — when the row hover state
        // changes the surface bg, the violet stays vivid against it.
        outlineColor: '#7b3ff2',
      }}
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

// Per-event-type visual mapping. Each entry picks the Lucide icon
// and the colour token used for the icon-square tint + the icon
// itself. The icon-square sits inside a 32x32 rounded-md block with
// the colour at 14% opacity — same register as the per-recipient
// approval pill on the customer page (PR 12c) so the dashboard's
// "what happened" cues match the customer's "what state am I in"
// cues.
type ActivityVisual = {
  icon: typeof Bell
  // CSS colour (token var or hex). Used for both the icon and the
  // square's tinted background via color-mix.
  tint: string
  verbCopy: (versionNumber: number) => string
}

const ACTIVITY_VISUAL: Record<DashboardLatestEvent['event_type'], ActivityVisual> = {
  view: {
    icon: Eye,
    tint: 'var(--c-allocated)',
    verbCopy: (v) => `opened v${v}`,
  },
  approve: {
    icon: Check,
    tint: 'var(--c-in-stock)',
    verbCopy: (v) => `signed off v${v}`,
  },
  designer_override_approve: {
    icon: Check,
    tint: 'var(--c-ink-mute)',
    verbCopy: (v) => `marked v${v} approved`,
  },
  request_changes: {
    icon: MessageSquare,
    tint: 'var(--c-low)',
    verbCopy: (v) => `requested changes on v${v}`,
  },
}

function LatestActivityPanel({
  events,
  navigate,
}: {
  events: DashboardLatestEvent[]
  navigate: (to: string) => void
}) {
  return (
    <div className="rounded-[14px] bg-surface border border-line overflow-hidden">
      {/* Header: bell icon in a coral-tinted square + LAST 24 HOURS
          eyebrow + Today's activity h-display. The bell ties the
          panel to the per-event icon-square idiom below — same
          14% tint + solid icon treatment, same 32px box. */}
      <div className="flex items-center gap-3 px-5 pt-5 pb-4 border-b border-line-soft">
        <span
          aria-hidden="true"
          className="inline-flex items-center justify-center w-8 h-8 rounded-md shrink-0"
          style={{
            backgroundColor: 'color-mix(in srgb, var(--c-brand) 14%, transparent)',
            color: 'var(--c-brand)',
          }}
        >
          <Bell size={16} />
        </span>
        <div className="min-w-0">
          <div className="eyebrow text-ink-mute">Last 24 hours</div>
          <h2 className="font-display font-medium tracking-[-0.02em] text-ink leading-tight m-0 text-[20px]">
            Today's activity
          </h2>
        </div>
      </div>
      {events.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-ink-mute">
          No customer activity yet.
        </p>
      ) : (
        <ul className="divide-y divide-line-soft">
          {events.map((e) => {
            const visual = ACTIVITY_VISUAL[e.event_type]
            const Icon = visual.icon
            const verb = visual.verbCopy(e.version_number)
            const failed =
              e.event_type !== 'view' &&
              e.event_type !== 'designer_override_approve' &&
              e.helpscout_thread_id == null
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
                className="flex cursor-pointer items-start gap-3 px-5 py-4 transition-colors hover:bg-canvas focus:outline-none focus-visible:bg-canvas focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--c-brand)]"
              >
                {/* Event-type icon in a tinted 32x32 square. */}
                <span
                  aria-hidden="true"
                  className="inline-flex items-center justify-center w-8 h-8 rounded-md shrink-0 mt-0.5"
                  style={{
                    backgroundColor: `color-mix(in srgb, ${visual.tint} 14%, transparent)`,
                    color: visual.tint,
                  }}
                >
                  <Icon size={16} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[14px] leading-snug text-ink">
                    <span className="font-semibold">{e.actor_name}</span>{' '}
                    <span className="text-ink-soft">{verb}</span>
                  </p>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <span
                      className="eyebrow text-ink-mute"
                      title={formatAbsoluteDateTime(e.created_at)}
                    >
                      {relativeTime(e.created_at)}
                    </span>
                    {failed && (
                      <span
                        className="inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-semibold"
                        style={{
                          backgroundColor: 'var(--c-low-soft)',
                          color: 'var(--c-low)',
                        }}
                        title="Help Scout notification failed — customer was asked to email."
                      >
                        notification failed
                      </span>
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
  // current_version_id → signed thumbnail URL. Populated in
  // loadDashboard after the projects fetch by batch-signing the
  // first front image of each version. Empty entries (no version
  // yet, or no images uploaded) fall through to the dark-plate
  // placeholder rendered inside ProjectRow.
  const [thumbnailUrls, setThumbnailUrls] = useState<Map<string, string>>(new Map())
  const [latestEvents, setLatestEvents]   = useState<DashboardLatestEvent[]>([])
  const [myProfile, setMyProfile]         = useState<{ initials: string; colour: DesignerColour; avatarUrl: string | null; firstName: string | null } | null>(null)
  // Avatar popover state moved into DesignerHeader's internal
  // UserPill in PR 16. Edit profile / Sign out actions are wired
  // through the onEditProfile / onSignOut props.
  const [editProfileOpen, setEditProfileOpen] = useState(false)
  // Pin state — proof_id → pinned_at ISO. Two maps because the
  // dashboard cares about each scope independently (mine drives the
  // Pinned section, team drives the Team section, and both feed the
  // overflow menu's toggle labels). pinned_at is preserved so the
  // sections can sort by recency.
  const [minePinAt, setMinePinAt]         = useState<Map<string, string>>(new Map())
  const [teamPinAt, setTeamPinAt]         = useState<Map<string, string>>(new Map())
  const [loading, setLoading]             = useState(true)
  const [search, setSearch]               = useState('')
  // statusFilter state was wired through the now-removed Status
  // dropdown (dropped in PR 21). Tile clicks + chip filter cover
  // the same use cases and the Abandoned checkbox handles the rare
  // dedicated abandoned filter.
  const [tileFilter, setTileFilter]       = useState<TileKey | null>(null)
  const [sort, setSort]                   = useState<SortMode>(readSort)
  const [group, setGroup]                 = useState<GroupMode>(readGroup)
  const [showAbandoned, setShowAbandoned] = useState<boolean>(readShowAbandoned)
  const [showSnoozed,   setShowSnoozed]   = useState<boolean>(readShowSnoozed)
  const [chipFilter,    setChipFilter]    = useState<ChipKey>(readChip)
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
          firstName: data.full_name?.split(' ')[0] ?? null,
        })
      })
  }, [userId])

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

  // Fetch + sign the row thumbnails for a list of dashboard projects.
  // Returns a current_version_id → signed-URL Map. Designed to never
  // throw — every failure path returns an empty Map so missing
  // thumbnails fall through to the placeholder. The proof-images
  // bucket is private, so signed URLs are required; createSignedUrls
  // does the batch in one round-trip with a 1-hour expiry (long
  // enough that a normally-engaged designer never sees stale URLs
  // since the next visibility tick refetches the dashboard).
  async function loadThumbnails(rows: DashboardProject[]): Promise<Map<string, string>> {
    const versionIds = rows
      .map((p) => p.current_version_id)
      .filter((id): id is string => id != null)
    if (versionIds.length === 0) return new Map()

    const { data: imageRows, error } = await supabase
      .from('proof_version_images')
      .select('proof_version_id, image_path, sort_order, side')
      .in('proof_version_id', versionIds)
      .eq('is_qr_code', false)
      .order('sort_order', { ascending: true })
    if (error || !imageRows) return new Map()

    // First image per version, preferring front / null side over back.
    const pathByVersion = new Map<string, string>()
    for (const r of imageRows as Array<{ proof_version_id: string; image_path: string; side: string | null }>) {
      if (pathByVersion.has(r.proof_version_id)) continue
      if (r.side === 'back') continue // skip backs; pick a front below
      pathByVersion.set(r.proof_version_id, r.image_path)
    }
    // Fill any versions with only back-side images so they get
    // something rather than nothing.
    for (const r of imageRows as Array<{ proof_version_id: string; image_path: string }>) {
      if (!pathByVersion.has(r.proof_version_id)) {
        pathByVersion.set(r.proof_version_id, r.image_path)
      }
    }
    if (pathByVersion.size === 0) return new Map()

    const paths = Array.from(pathByVersion.values())
    const { data: signedData } = await supabase.storage
      .from('proof-images')
      .createSignedUrls(paths, 3600)
    if (!signedData) return new Map()

    const urlByPath = new Map<string, string>()
    for (const r of signedData) {
      if (r.path && r.signedUrl) urlByPath.set(r.path, r.signedUrl)
    }
    const urlByVersion = new Map<string, string>()
    for (const [versionId, path] of pathByVersion) {
      const url = urlByPath.get(path)
      if (url) urlByVersion.set(versionId, url)
    }
    return urlByVersion
  }

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

    const typedProjects = (projectRows ?? []) as DashboardProject[]
    setProjects(typedProjects)

    setLatestEvents((events ?? []) as DashboardLatestEvent[])

    // ── Per-row thumbnails ──────────────────────────────────────
    // Fetch the first front (or side=null) image for each project's
    // current_version_id, then batch-sign their paths through
    // Supabase Storage in a single round-trip. QR-code rows are
    // excluded so a vCard row doesn't masquerade as the proof
    // thumbnail. Errors are tolerated silently — missing thumbnails
    // fall through to the dark-plate placeholder in ProjectRow.
    void loadThumbnails(typedProjects).then(setThumbnailUrls)

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

  function handleChipChange(c: ChipKey) {
    setChipFilter(c)
    try { localStorage.setItem(CHIP_KEY, c) } catch { /* */ }
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

  // Tile counts — all computed client-side so counts and filters use exactly
  // the same predicates. Currently-snoozed projects are always excluded:
  // they live in the dedicated Snoozed section regardless of their other
  // state. Note `isCurrentlySnoozed` rather than `snoozed_until == null`:
  // 000186 widened the view's lateral so recently-expired snoozes still
  // surface snoozed_until for the 24-hour grace window that powers
  // recentlyAwakened(). Needs-attention projects are excluded from every
  // other tile so each project belongs to exactly one tile.
  // No abandoned-status guard: every rule in proofs_needing_attention()
  // is gated on an active status, so rule_code is always null on an
  // abandoned proof. The count therefore depends only on `projects`,
  // matching the needs_attention click-through filter predicate.
  const needsAttentionCount = useMemo(() =>
    projects.filter((p) =>
      p.rule_code != null &&
      !isCurrentlySnoozed(p)
    ).length,
  [projects])

  const notViewedCount = useMemo(() =>
    projects.filter((p) => {
      const isActive = p.status === 'in_progress' || p.status === 'dormant'
      return (
        p.rule_code == null &&
        !isCurrentlySnoozed(p) &&
        isActive &&
        p.current_version_id !== null &&
        p.current_version_viewed_at === null
      )
    }).length,
  [projects])

  const awaitingCustomerCount = useMemo(() =>
    projects.filter((p) =>
      p.rule_code == null &&
      !isCurrentlySnoozed(p) &&
      p.status === 'in_progress' &&
      p.current_version_id !== null &&
      p.current_version_viewed_at !== null
    ).length,
  [projects])

  // Changes requested — proofs where the customer's most recent action on the
  // current version was a change request and no newer version has been shipped
  // since. Detection uses latest_non_view_event_* (migration 000198), not
  // latest_event_*: the latter includes synthetic 'view' rows, so a customer
  // simply re-opening the proof after requesting changes would otherwise mask
  // the outstanding request (PV-2026W22-087). The change request's own
  // timestamp is compared against version_created_at — a newer version uploaded
  // in response would be later. Needs-attention proofs (the overdue subset,
  // captured by the request_changes_no_version rule) are excluded so each proof
  // belongs to exactly one tile — overdue change requests escalate to the Needs
  // attention tile.
  const changesRequestedCount = useMemo(() =>
    projects.filter((p) => {
      if (p.rule_code != null) return false
      if (isCurrentlySnoozed(p)) return false
      if (p.status !== 'in_progress') return false
      if (p.latest_non_view_event_type !== 'request_changes') return false
      if (!p.latest_non_view_event_at || !p.version_created_at) return false
      return new Date(p.latest_non_view_event_at).getTime() > new Date(p.version_created_at).getTime()
    }).length,
  [projects])

  // Dormant / Approved-this-week counts. Migration 000152's
  // dashboard_tile_counts() returns server-side counts that do not
  // filter snoozed proofs (the snooze filter is applied in 000164's
  // proofs_needing_attention() only). Computing these client-side with
  // the same isCurrentlySnoozed guard ensures the tile count matches
  // the number of rows shown when the tile is clicked (the click-through
  // filter below drops currently-snoozed proofs when any tile filter is
  // active). Mirrors the alignment fix from PV-2026W19-015
  // (awaiting_customer) for the remaining two tiles.
  const dormantCount = useMemo(() =>
    projects.filter((p) =>
      !isCurrentlySnoozed(p) &&
      p.status === 'dormant'
    ).length,
  [projects])

  const approvedThisWeekCount = useMemo(() => {
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
    return projects.filter((p) => {
      if (isCurrentlySnoozed(p)) return false
      if (p.status !== 'approved') return false
      if (!p.approved_at) return false
      return new Date(p.approved_at).getTime() >= sevenDaysAgo
    }).length
  }, [projects])

  // Filter pipeline: search → chip → tile → status. All AND-combined.
  const filteredProjects = useMemo(() => {
    const q = search.trim().toLowerCase()
    const sevenDaysAgoMs = Date.now() - 7 * 86_400_000
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
      // Chip filter — orthogonal to tile / status. The 'all' chip is
      // the no-op default. Other chips refine the visible set by
      // ownership, attention rules, recency, or material family.
      if (chipFilter === 'mine') {
        // Mine: I'm the assigned designer on this proof's current
        // version. Proofs with no version yet (current_version_id is
        // null) have no designer attribution and are filtered out.
        if (p.designer_user_id == null || p.designer_user_id !== userId) return false
      }
      if (chipFilter === 'needs_me') {
        // Same predicate as the Needs attention tile.
        if (p.rule_code == null) return false
        if (isCurrentlySnoozed(p)) return false
      }
      if (chipFilter === 'last_7_days') {
        if (!p.last_activity_at) return false
        if (new Date(p.last_activity_at).getTime() < sevenDaysAgoMs) return false
      }
      if (chipFilter === 'steel') {
        if (!p.material_display?.toLowerCase().includes('steel')) return false
      }
      if (chipFilter === 'letterpress') {
        if (!p.material_display?.toLowerCase().includes('letterpress')) return false
      }
      // Currently-snoozed projects always belong to the Snoozed section —
      // exclude them from every tile filter so they don't appear in the main
      // list when a tile is active. Recently-awakened proofs (snoozed_until
      // in the 24-hour grace window from 000186) fall through and are
      // bucketed normally by the tile predicates below.
      if (tileFilter && isCurrentlySnoozed(p)) return false
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
        // Mirror of changesRequestedCount: latest non-view customer event on the
        // proof is a change request, with no newer version uploaded since. Uses
        // latest_non_view_event_* (migration 000198) so a later page-view doesn't
        // mask the request (PV-2026W22-087). The overdue subset is captured by
        // the request_changes_no_version needs-attention rule and shown there
        // instead — rule_code != null excludes them here.
        if (p.rule_code != null) return false
        if (p.status !== 'in_progress') return false
        if (p.latest_non_view_event_type !== 'request_changes') return false
        if (!p.latest_non_view_event_at || !p.version_created_at) return false
        if (new Date(p.latest_non_view_event_at).getTime() <= new Date(p.version_created_at).getTime()) return false
      }
      // Hide abandoned proofs unless the designer has toggled them
      // on via the Abandoned checkbox.
      if (!showAbandoned && p.status === 'abandoned') return false
      return true
    })
  }, [projects, search, tileFilter, showAbandoned, chipFilter, userId])

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
    <div className="min-h-dvh bg-canvas">
      {/* Shared designer chrome. Search lifted out of the list-card
          and into the header per the reskin handoff. The QuoteLink
          (new-tab "phone rings, jump to quote" link with ⌘K hint)
          rides in the actions slot so the new-tab behaviour stays;
          DesignerHeader's canonical nav uses in-tab Links. */}
      <DesignerHeader
        active="proofs"
        role={role}
        user={{
          initials: myProfile?.initials ?? '…',
          colour: (myProfile?.colour ?? 'teal') as DesignerHeaderColour,
          avatarUrl: myProfile?.avatarUrl ?? null,
          name: myProfile?.initials ? undefined : 'Account',
        }}
        search={{ value: search, onChange: setSearch }}
        actions={<QuoteLink />}
        onEditProfile={() => setEditProfileOpen(true)}
        onSignOut={handleSignOut}
      />

      <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">

        {/* Edit profile modal */}
        {editProfileOpen && userId && (
          <EditProfileModal
            userId={userId}
            onClose={() => setEditProfileOpen(false)}
            onSaved={(payload: EditProfileSavedPayload) => {
              setMyProfile((prev) => ({
                initials: payload.initials,
                colour: payload.colour,
                avatarUrl: payload.avatarUrl,
                // EditProfileModal's payload doesn't carry firstName,
                // so keep the previously-loaded value rather than
                // wiping the hero greeting after a profile save.
                firstName: prev?.firstName ?? null,
              }))
              // Refetch dashboard rows so the designer-avatar columns on
              // every project tile pick up the new avatar/initials/colour
              // immediately rather than waiting for the next
              // visibilitychange tick (PV-2026W21-071).
              void loadDashboard()
            }}
          />
        )}

        {loading ? (
          <div className="flex justify-center py-20">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-line motion-reduce:animate-none" style={{ borderTopColor: 'var(--c-ink)' }} />
          </div>
        ) : (
          <>
            {/* Unified hero + tile panel. One bordered card spanning
                the full page width: hero header (eyebrow + greeting +
                date+count line + Saved views + New proof) at the top,
                7-tile row below, divided by a hairline. The Latest
                activity sidebar (rendered further down inside the
                2-col grid) now starts below this unified area rather
                than aligning with the hero, matching the mockup. */}
            <section className="mb-6 rounded-[14px] bg-surface border border-line overflow-hidden">
              {/* Hero header */}
              <div className="px-6 py-5 flex flex-wrap items-end justify-between gap-4 border-b border-line-soft">
                <div>
                  <div className="eyebrow">Proofs at a glance</div>
                  <h1 className="mt-1 font-display font-medium tracking-[-0.02em] text-ink leading-tight m-0" style={{ fontSize: 'clamp(22px, 3vw, 28px)' }}>
                    {greetingFor(new Date())}, {myProfile?.firstName ?? 'there'}
                  </h1>
                  <p className="mt-1.5 text-[14px] text-ink-soft leading-snug">
                    {todayLabel(new Date())}
                    {needsAttentionCount > 0 && (
                      <>
                        {' · '}
                        <span className="font-medium" style={{ color: 'var(--c-brand)' }}>
                          {String(needsAttentionCount).padStart(2, '0')} {needsAttentionCount === 1 ? 'job' : 'jobs'}
                        </span>
                        {' need your attention this morning.'}
                      </>
                    )}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {/* Saved views — placeholder for the still-to-build
                      feature. No handler; renders as a disabled-looking
                      button so the visual matches the mockup but the
                      affordance reads as "coming soon". */}
                  <ButtonGhost icon={Filter} disabled>Saved views</ButtonGhost>
                  <ButtonCoral icon={Plus} onClick={() => navigate('/proofs/new')}>
                    New proof
                  </ButtonCoral>
                </div>
              </div>

              {/* Tile row. Seven tiles in priority order, separated by
                  vertical hairlines at xl widths via xl:divide-x. Below
                  xl the tiles wrap into 2 / 3 column grids so they
                  remain readable on narrow viewports; the hairlines
                  drop on the wrapped layout since tiles no longer share
                  a single row. The tile palette encodes the
                  Alert/Workflow/On-hold grouping via colour
                  (rose for Needs attention,
                  amber→sky→turquoise→green for workflow,
                  violet/neutral for on-hold). */}
              <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-7 xl:divide-x xl:divide-line">
                  <StatTile
                    label="Needs attention"
                    count={needsAttentionCount}
                    active={tileFilter === 'needs_attention'}
                    tone="rose"
                    onClick={() => toggleTile('needs_attention')}
                  />
                  <StatTile
                    label="Not viewed"
                    count={notViewedCount}
                    active={tileFilter === 'not_viewed'}
                    tone="amber"
                    onClick={() => toggleTile('not_viewed')}
                  />
                  <StatTile
                    label="Awaiting customer"
                    count={awaitingCustomerCount}
                    active={tileFilter === 'awaiting_customer'}
                    tone="sky"
                    onClick={() => toggleTile('awaiting_customer')}
                  />
                  <StatTile
                    label="Changes requested"
                    count={changesRequestedCount}
                    active={tileFilter === 'changes_requested'}
                    tone="turquoise"
                    onClick={() => toggleTile('changes_requested')}
                  />
                  <StatTile
                    label="Approved this week"
                    count={approvedThisWeekCount}
                    active={tileFilter === 'approved_this_week'}
                    tone="green"
                    onClick={() => toggleTile('approved_this_week')}
                  />
                  <StatTile
                    label="Snoozed"
                    count={snoozedSections[0]?.projects.length ?? 0}
                    active={showSnoozed}
                    tone="violet"
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
                    onClick={() => toggleTile('dormant')}
                  />
              </div>
            </section>

            {/* 2-column grid for the rest of the page: list card on the
                left, Latest activity sidebar on the right. Lives below
                the unified hero+tile panel so the sidebar starts under
                the tile row rather than aligning with the hero. */}
            <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
              <div className="min-w-0">

                {/* PR 25: the outer list-card wrapper retired here. Controls
                    sit in their own bordered card above; rows flow as
                    standalone cards below, each with a wide coloured left
                    cap. Section headers become loose eyebrows between
                    groups. Matches the mockup's loose-card-list pattern. */}
                {projects.length === 0 ? (
                  <div className="rounded-[14px] bg-surface py-20 text-center border border-line">
                    <p className="text-ink-mute">No projects yet.</p>
                    <Link to="/proofs/new" className="mt-3 inline-block text-[14px] font-medium text-ink underline">Create the first one</Link>
                  </div>
                ) : (
                  <>
                    {/* Controls card — filter chips on the left,
                        N showing + Sort + Group + Abandoned on the right. */}
                    <div className="rounded-[14px] bg-surface border border-line px-5 py-4 mb-4">
                      {/* Filter chip strip (left) + N showing · Sort · Group ·
                          Abandoned (right). Status dropdown removed in PR 21:
                          the tiles cover its main use cases (Approved this
                          week → Approved this week tile, Dormant → Dormant
                          tile, Snoozed → Snoozed tile) and the Abandoned
                          checkbox handles the rare abandoned filter. Chip
                          state is single-select; 'all' is the no-op default. */}
                      <div className="flex flex-wrap items-center gap-3">
                        <span className="eyebrow text-ink-mute pr-1">Filter</span>
                        {(CHIPS as readonly { value: ChipKey; label: string }[]).map(({ value, label }) => {
                          const isActive = chipFilter === value
                          return (
                            <button
                              key={value}
                              type="button"
                              onClick={() => handleChipChange(value)}
                              aria-pressed={isActive}
                              className={[
                                'inline-flex items-center h-[30px] px-3 rounded-full text-[12px] font-medium transition-colors',
                                isActive
                                  ? 'bg-ink text-on-ink border border-ink'
                                  : 'border border-line bg-surface text-ink-soft hover:bg-canvas',
                              ].join(' ')}
                            >
                              {label}
                            </button>
                          )
                        })}

                        {/* Right cluster */}
                        <span className="flex-1" aria-hidden="true" />
                        <span className="text-[12px] text-ink-mute tabular-nums font-mono">
                          {filteredProjects.length} showing
                        </span>
                        <span className="h-4 w-px bg-line" aria-hidden="true" />
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
                        <button
                          onClick={() => {
                            setShowAbandoned((v) => {
                              const next = !v
                              try { localStorage.setItem(ABANDONED_KEY, String(next)) } catch { /* */ }
                              return next
                            })
                          }}
                          className={`inline-flex items-center gap-1.5 rounded-[8px] border px-2.5 py-1.5 text-xs font-medium transition-colors ${
                            showAbandoned
                              ? 'border-line bg-canvas text-ink'
                              : 'border-line bg-surface text-ink-mute hover:bg-canvas hover:text-ink-soft'
                          }`}
                        >
                          {/* Checkbox indicator */}
                          <span className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border ${showAbandoned ? 'border-ink bg-ink' : 'border-line'}`}>
                            {showAbandoned && (
                              <svg viewBox="0 0 10 10" className="h-2.5 w-2.5 text-on-ink" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
                        <p className="text-ink-mute">No projects match the current filters.</p>
                        <button
                          onClick={() => {
                            setSearch('')
                            setTileFilter(null)
                            setShowAbandoned(false)
                            setShowSnoozed(false)
                            setSnoozedOnly(false)
                            handleChipChange('all')
                            try { localStorage.setItem(ABANDONED_KEY, 'false') } catch { /* */ }
                            try { localStorage.setItem(SNOOZED_KEY, 'false') } catch { /* */ }
                          }}
                          className="mt-2 text-sm text-ink-soft underline underline-offset-2 hover:text-ink"
                        >Clear filters</button>
                      </div>
                    ) : (
                      sections.map((section) => {
                        // Virtualise the Older drawer only — Today /
                        // This week / Pinned / Team / Company sections
                        // are bounded in size and don't need it. The
                        // virtualised renderer reuses the same
                        // ProjectRow component so chips, menus, and
                        // keyboard interaction behave identically.
                        const virtualise = section.kind === 'time' && section.key === 'older' && section.projects.length > 30
                        return (
                          <div key={section.key} className="mt-6 first:mt-0">
                            {/* Loose section header — eyebrow on the
                                cream bg above the stack of row cards.
                                No bg / no border, just the label and
                                a small icon when the section kind has
                                one. */}
                            <div className="flex items-center gap-2 px-1 pb-3">
                              {section.kind === 'pinned'  && <PinIcon className="h-3.5 w-3.5 shrink-0 text-ink-mute" />}
                              {section.kind === 'team'    && <UsersIcon className="h-3.5 w-3.5 shrink-0 text-ink-mute" />}
                              {section.kind === 'snoozed' && <ClockIcon className="h-3.5 w-3.5 shrink-0 text-ink-mute" />}
                              <span className="eyebrow text-ink-soft">{section.title}</span>
                              <span className="text-xs font-medium text-ink-mute tabular-nums">{section.projects.length}</span>
                            </div>
                            {/* Row cards. space-y-2 puts a small gap
                                between cards; each card now carries its
                                own border + rounded corners + bg-surface
                                + wide left status cap. The inter-row
                                hairline borders dropped here. */}
                            <div className="space-y-2">
                              {virtualise ? (
                                <Virtuoso
                                  useWindowScroll
                                  data={section.projects}
                                  overscan={400}
                                  computeItemKey={(_, p) => p.proof_id}
                                  itemContent={(_, p) => (
                                    <div className="mb-2 last:mb-0">
                                      <ProjectRow
                                        project={p}
                                        minePinned={minePinAt.has(p.proof_id)}
                                        teamPinned={teamPinAt.has(p.proof_id)}
                                        thumbnailUrl={p.current_version_id ? thumbnailUrls.get(p.current_version_id) : undefined}
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
                                section.projects.map((p) => (
                                  <ProjectRow
                                    key={p.proof_id}
                                    project={p}
                                    minePinned={minePinAt.has(p.proof_id)}
                                    teamPinned={teamPinAt.has(p.proof_id)}
                                    thumbnailUrl={p.current_version_id ? thumbnailUrls.get(p.current_version_id) : undefined}
                                    onToggleMinePin={toggleMinePin}
                                    onToggleTeamPin={toggleTeamPin}
                                    onSnooze={handleSnooze}
                                    onUnsnooze={handleUnsnooze}
                                    showReason={tileFilter === 'needs_attention'}
                                  />
                                ))
                              )}
                            </div>
                          </div>
                        )
                      })
                    )}
                  </>
                )}
              </div>

              <aside className="hidden lg:sticky lg:top-10 lg:block lg:self-start">
                {/* xl:pt-4 used to ride here from the older layout
                    where the sidebar ran alongside the hero. After
                    PR 23 unified hero + tiles into a full-width panel,
                    the sidebar starts in the same grid row as the
                    controls card — the pt-4 was tipping the activity
                    panel ~16px below the controls card's top edge. */}
                <LatestActivityPanel events={latestEvents} navigate={navigate} />
              </aside>
            </div>
          </>
        )}
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
    <div className="relative inline-flex items-center rounded-[8px] border border-line bg-surface hover:bg-canvas focus-within:border-[var(--c-brand)] focus-within:outline focus-within:outline-2 focus-within:outline-offset-[-1px] focus-within:outline-[var(--c-brand)] transition-colors">
      {label && (
        <span className="pointer-events-none select-none pl-2.5 text-xs font-medium text-ink-mute">
          {label}
        </span>
      )}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="cursor-pointer appearance-none bg-transparent py-1.5 pl-1 pr-7 text-xs font-medium text-ink focus:outline-none"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      <svg
        aria-hidden
        viewBox="0 0 16 16"
        className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 text-ink-mute"
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
