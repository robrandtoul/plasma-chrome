import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { DesignerChrome, useDesignerProfile, useIsMobile, Sheet, ButtonCoral, ButtonGhost, ButtonInk, ProofStatusPill, HelpTip } from '../design'
import { Plus, X, Maximize2, Bell, MoreHorizontal, MessageSquare, Mail, Send, Eye, Check, Clock, CreditCard, Layers, Link as LinkIcon, ThumbsDown, PictureInPicture2 } from 'lucide-react'
// react-virtuoso for the Older drawer's row virtualisation. Picked
// over react-window because its useWindowScroll mode preserves the
// existing UX where Older grows inline as part of the page rather
// than becoming a fixed-height inner-scrolling pane. ~30KB gzipped
// vs react-window's ~6KB; the bundle hit is worth not having to add
// react-virtualized-auto-sizer + a fixed pixel height on top.
import { Virtuoso } from 'react-virtuoso'
import { supabase } from '../lib/supabase'
import { signThumbnails, type ThumbInfo } from '../lib/thumbnails'
import { setProofWorklist } from '../lib/proofWorklist'
import { useAuth } from '../lib/auth'
import { getOrderingEnabled } from '../lib/orderingEnabled'
import { getHotLeadsPanelEnabled } from '../lib/hotLeadsPanelEnabled'
import type { ProofStatus } from '../lib/types'
import { relativeTime, formatAbsoluteDateTime } from '../lib/relativeTime'
import {
  viewedStateTitle,
  type ViewedState,
} from '../lib/viewedState'
import { openDesignerPreview } from '../lib/customerProofUrl'
import { logAudit } from '../lib/audit'
import { attentionReason } from '../lib/needsAttention'
import { tagHelp } from '../lib/tagHelp'
import { ResolvePopover } from '../components/ResolvePopover'
import { NudgeOutboxPanel } from '../components/NudgeOutboxPanel'
import CollapsibleSidebarPanel from '../components/CollapsibleSidebarPanel'
import HotLeadsCard from '../components/HotLeadsCard'
import AnnouncementsBanner from '../components/AnnouncementsBanner'
import SharedDesignerAvatar from '../components/DesignerAvatar'
import TeamChatPanel from '../components/TeamChatPanel'
import { useTeamChat } from '../lib/teamChatStore'
// QuoteLink imported + rendered inside DesignerChrome (PR 31) so
// every designer page surfaces the same new-tab "phone rings"
// affordance without re-importing.
// EditProfileModal + sign-out wiring moved into DesignerChrome in
// PR 31 — that wrapper owns the profile fetch and the modal so
// individual designer pages don't each reimplement ~40 lines.
import {
  groupByTime,
  groupByCompany,
  activityTimestamp,
  buildSnoozedSection,
  isCurrentlySnoozed,
  isChangesRequested,
  isCustomerReplied,
  proofBucket,
  recentHelpscoutActivity,
  helpscoutReplyEvents,
  payLinkOpenEvents,
  payLinkSentEvents,
  orderReminderEvents,
  proofFeedbackEvents,
  type PayLinkOpenRow,
  type PayLinkSentRow,
  type OrderReminderRow,
  type ProofFeedbackFeedRow,
  type DashboardLatestEvent,
  type DashboardProject,
  type NeedsAttentionRule,
  type ProjectSection,
} from '../lib/dashboardGrouping'
// Bundle stitching (proof_sets, 000311) — see dashboardBundles.ts for why a
// bundle needs showing on the list at all, and which of the two treatments
// (block / chip) applies where.
import {
  buildBundleIndex,
  buildRowItems,
  bundleSentState,
  bundleShownHere,
  EMPTY_BUNDLE_INDEX,
  hoistBundleSections,
  type BundleIndex,
  type BundleInfo,
  type BundleMemberRow,
  type BundleSetRow,
} from '../lib/dashboardBundles'

// ── Types ─────────────────────────────────────────────────────────────────────
// DashboardProject, NeedsAttentionRule, and ProjectSection are
// imported from ../lib/dashboardGrouping so they can be unit-tested
// independently of this React component tree.

type SortMode  = 'activity' | 'date' | 'name'
type GroupMode = 'time' | 'company'
type TileKey   = 'needs_attention' | 'awaiting_customer' | 'dormant' | 'approved_this_week' | 'not_viewed' | 'customer_responded' | 'in_follow_up'
// The same keys as a runtime list, so the ?tile= URL parameter can be
// validated before it's trusted as a TileKey.
const TILE_KEYS = [
  'needs_attention', 'awaiting_customer', 'dormant', 'approved_this_week',
  'not_viewed', 'customer_responded', 'in_follow_up',
] as const satisfies readonly TileKey[]
// Server-side tile counts (migration 000213) — one number per TileKey.
type TileCounts = Record<TileKey, number>
type ChipKey   = 'all' | 'metal' | 'paper' | 'plastic' | 'carbon' | 'wood' | 'acrylic'

// Reason + resolution text per rule now live in ../lib/needsAttention so the
// reason chip, the pill tooltip, and the detail page all read one source.

// DashboardLatestEvent now lives in ../lib/dashboardGrouping (alongside the
// helpscoutReplyEvents helper that synthesises the email-reply rows) so the feed
// shape and its builder can be unit-tested together.

// One material's production lead time, read straight off the
// materials table (authenticated SELECT, same source the admin Lead
// times tab writes to). Only rows where both days are set are
// fetched, so the chart never has to reason about the null case.
interface LeadTime {
  display_name: string
  category: string
  lead_time_min_days: number
  lead_time_max_days: number
}

const SORT_KEY      = 'proofViewer.dashboard.sort'
const GROUP_KEY     = 'proofViewer.dashboard.group'
const ABANDONED_KEY = 'proofViewer.dashboard.showAbandoned'
const SNOOZED_KEY   = 'proofViewer.dashboard.showSnoozed'
const CHIP_KEY      = 'proofViewer.dashboard.chip'

// Filter chip strip — material-family lenses. The status tiles above
// own "status" and the search box owns "customer", so this row slices
// the one dimension neither covers: the product family. (Replaced the
// old ownership/attention/recency chips, which duplicated the tiles or
// added little — see the dashboard review.)
const CHIPS = [
  { value: 'all',     label: 'All' },
  { value: 'metal',   label: 'Metal' },
  { value: 'paper',   label: 'Paper' },
  { value: 'plastic', label: 'Plastic' },
  { value: 'carbon',  label: 'Carbon fibre' },
  { value: 'wood',    label: 'Wood' },
  { value: 'acrylic', label: 'Acrylic' },
] as const

// Each family matches against the proof's material display name (the
// dashboard row only carries the name, not the catalogue category).
// The material set is stable; revisit if a material is added whose
// name doesn't match one of these patterns.
const MATERIAL_CATEGORY_MATCH: Record<Exclude<ChipKey, 'all'>, RegExp> = {
  metal:   /steel|metal|titanium/i,
  paper:   /letterpress|paper/i,
  plastic: /plastic/i,
  carbon:  /carbon/i,
  wood:    /wood/i,
  acrylic: /acrylic/i,
}

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
    if (v === 'all' || v === 'metal' || v === 'paper' || v === 'plastic' || v === 'carbon' || v === 'wood' || v === 'acrylic') return v
  } catch { /* */ }
  return 'all'
}


// Derive the relative verb + timestamp shown on each row. This is the visible
// face of the same activity clock activityTimestamp() sorts and groups by, so
// the two must agree on which moment is "latest": when we've sent a version more
// recently than the customer's last event, show "Sent …" (not a stale "Viewed
// 3d ago"), matching the Today section the proof now files under. Once the
// customer acts on the new version, their event becomes the latest and wins.
function activityVerb(p: DashboardProject): { verb: string; ts: string | null } {
  if (p.status === 'approved' && p.approved_at) {
    return { verb: 'Approved', ts: p.approved_at }
  }
  if (p.status === 'abandoned' && p.abandoned_at) {
    return { verb: 'Abandoned', ts: p.abandoned_at }
  }
  // The send is the freshest activity when it postdates the last customer event
  // (or there's no customer event yet) — fall through to the "Sent" branch below
  // rather than reporting an older view/change.
  const sentIsNewest =
    p.version_created_at != null &&
    (p.latest_event_at == null || p.version_created_at.localeCompare(p.latest_event_at) > 0)
  if (!sentIsNewest && p.latest_event_type && p.latest_event_at) {
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
// Thin adapter from a DashboardProject onto the shared DesignerAvatar chip
// (src/components/DesignerAvatar.tsx) — so the dashboard rows and the Orders
// "Links to send" worklist render the identical designer-identity register from
// one source of truth. The tooltip stays here because it's dashboard-specific
// (the current version + when it was created).

function DesignerAvatar({ p }: { p: DashboardProject }) {
  const tooltip = p.designer_name && p.current_version_number != null && p.version_created_at
    ? `${p.designer_name} — v${p.current_version_number} created ${formatAbsoluteDateTime(p.version_created_at)}`
    : p.designer_name ?? ''
  return (
    <SharedDesignerAvatar
      initials={p.designer_initials}
      colour={p.designer_colour}
      avatarUrl={p.designer_avatar_url}
      tooltip={tooltip}
    />
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
  // Full phrase for screen readers when `label` is a shortened display form
  // (e.g. label "Follow-up" / srLabel "In auto follow-up"). Omit when the
  // visible label is already the full wording.
  srLabel?: string
  count: number
  active: boolean
  tone: 'rose' | 'amber' | 'sky' | 'neutral' | 'violet' | 'green' | 'turquoise' | 'gold' | 'blue' | 'indigo'
  onClick: () => void
  help?: string
  // Optional small red corner count (e.g. orders with a failed Xero invoice).
  badge?: number
  badgeTitle?: string
}

// Tone → CSS colour mapping. Design-system tokens where they map
// cleanly to the dashboard tones; an explicit hue for the one
// (violet) where the token palette doesn't reach. The neutral tone
// uses the ink-mute token rather than a saturated colour so Dormant
// reads as a backwater rather than an alert.
const TILE_COLOUR: Record<StatTileProps['tone'], string> = {
  rose:      'var(--c-out)',
  amber:     'var(--c-low)',
  sky:       'var(--c-allocated)',
  turquoise: 'var(--c-responded)',
  green:     'var(--c-in-stock)',
  violet:    '#7c3aed',
  neutral:   'var(--c-ink-mute)',
  gold:      '#ca8a04',
  blue:      '#2563eb',
  // In follow-up — indigo, matching the in_follow_up pill in dashboardGrouping
  // so the tile and the row pill share one hue.
  indigo:    '#6366f1',
}

function StatTile({ label, srLabel, count, active, tone, onClick, help, badge, badgeTitle }: StatTileProps) {
  const tint = TILE_COLOUR[tone]
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className="flex flex-col items-start gap-2 px-5 py-5 text-left transition-colors hover:bg-canvas focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--c-brand)] relative xl:flex-1 xl:min-w-0 max-md:w-[140px] max-md:shrink-0 max-md:snap-start max-md:rounded-[12px] max-md:border max-md:border-line"
      style={{
        // Active state: a soft tint of the tile's tone fills the cell
        // background. Cleaner than an inset ring when each cell sits
        // inside a unified panel — the ring would compete with the
        // panel border and the dividing hairlines.
        backgroundColor: active ? `color-mix(in srgb, ${tint} 8%, transparent)` : undefined,
      }}
    >
      {badge != null && badge > 0 && (
        <span
          className="absolute right-2 top-2 inline-flex min-w-[18px] items-center justify-center rounded-full px-1.5 py-0.5 text-[11px] font-semibold leading-none text-white"
          style={{ backgroundColor: 'var(--c-out)' }}
          title={badgeTitle}
        >
          {badge}
        </span>
      )}
      {/* Dot + label, stacked. The colour dot sits ABOVE the label, not
          beside it: at the xl breakpoint the eight Workflow tiles share a
          hard-capped ~96px each, and an inline dot + gap stole ~24px of the
          ~55px content box — too little for even a single word like
          "CUSTOMER", so labels either spilled into the divider or broke
          mid-letter. Stacking the dot hands the label the full content
          width, so it wraps cleanly at spaces to ≤2 lines. (The two
          three-word labels that still couldn't fit two lines — "In auto
          follow-up", "Approved this week" — are shortened at the call site
          to "Follow-up" / "Approved", with the full wording kept on the
          HelpTip and an srLabel for screen readers.) overflow-wrap:break-word
          is now a last-resort guard only; whiteSpace:'normal' + the tight
          tracking remain load-bearing inline overrides of the .eyebrow
          nowrap default. The number is pushed to the tile bottom with
          mt-auto; every tile stretches to a common height (xl:items-stretch
          on the strip, grid/flex stretch elsewhere), so bottom-anchoring the
          numbers keeps them on one baseline no matter how many lines the
          label takes. */}
      <div className="flex flex-col items-start gap-1.5">
        <span
          aria-hidden="true"
          className="inline-block w-3 h-3 rounded shrink-0"
          style={{ backgroundColor: tint }}
        />
        <HelpTip body={help} affordance="none" focusable={false}>
          <span
            className="eyebrow text-ink-mute"
            aria-label={srLabel}
            style={{ whiteSpace: 'normal', lineHeight: 1.2, letterSpacing: '0.02em', overflowWrap: 'break-word' }}
          >
            {label}
          </span>
        </HelpTip>
      </div>
      <span
        className="mt-auto text-[32px] leading-none font-medium tabular-nums font-mono text-ink"
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
  const isMobile = useIsMobile()
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // Desktop dropdown only — the mobile action sheet manages its own
    // backdrop / Escape dismissal, and these document listeners would
    // otherwise treat a tap on a sheet row as "outside" and close it.
    if (!open || isMobile) return
    function onDocClick(e: MouseEvent) {
      const t = e.target as Node
      // The menu is portalled to <body>, so the click-outside test must
      // exclude BOTH the trigger button and the portalled menu — else a
      // click on a menu item registers as "outside" and closes it before
      // the item's handler fires.
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return
      setOpen(false)
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
  }, [open, isMobile])

  // Display name + spec for the mobile action sheet header. Mirrors the
  // row's own name/spec derivation so the sheet reads as "this project".
  const sheetName = proof.company_name || proof.contact_name || '(no contact)'
  const sheetSpec = [
    proof.material_display,
    proof.current_version_number != null ? `v${proof.current_version_number}` : null,
  ].filter(Boolean).join(' · ')
  // 56px sheet rows; first:border-t-0 keeps the divider out of the top edge.
  const sheetRow =
    'flex w-full min-h-[56px] items-center gap-3 border-t border-line-soft px-4 text-left text-[15px] text-ink-soft hover:bg-canvas first:border-t-0'

  // Position the menu via a fixed-position portal so it escapes the row
  // card's overflow-hidden (which was clipping the dropdown). Right-
  // aligned under the trigger button; clamped to stay on-screen.
  const menuPos = open && btnRef.current
    ? (() => {
        const r = btnRef.current!.getBoundingClientRect()
        const W = 224
        const H_GUESS = 300
        return {
          left: Math.max(16, r.right - W),
          top: Math.max(16, Math.min(r.bottom + 4, window.innerHeight - H_GUESS - 16)),
          width: W,
        }
      })()
    : null

  // Mobile: a visible 44×44 kebab that opens a bottom action sheet,
  // replacing the desktop hover-only dropdown.
  if (isMobile) {
    return (
      <>
        <button
          ref={btnRef}
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Project actions"
          onClick={(e) => { e.stopPropagation(); setOpen((o) => !o) }}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-ink-mute hover:bg-canvas hover:text-ink"
        >
          <MoreHorizontal size={20} aria-hidden="true" />
        </button>
        <Sheet open={open} onClose={() => setOpen(false)} title={sheetName} subtitle={sheetSpec} ariaLabel="Project actions">
          <div className="px-4">
            <div className="overflow-hidden rounded-[14px] border border-line bg-surface">
              {canAddVersion ? (
                <Link
                  to={`/proofs/${proof.proof_id}/versions/new`}
                  onClick={() => setOpen(false)}
                  className={`${sheetRow} font-medium text-brand`}
                >
                  <Plus size={18} aria-hidden="true" /> Add a new version
                </Link>
              ) : (
                <span className={`${sheetRow} cursor-not-allowed text-ink-dim`}>
                  <Plus size={18} aria-hidden="true" /> Add a new version
                </span>
              )}
              {proof.current_version_id && (
                <button
                  type="button"
                  onClick={() => { setOpen(false); openDesignerPreview(proof.proof_id) }}
                  className={sheetRow}
                >
                  <Eye size={18} aria-hidden="true" className="text-ink-mute" /> Preview
                </button>
              )}
              {proof.helpscout_conversation_url && (
                <a
                  href={proof.helpscout_conversation_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setOpen(false)}
                  className={sheetRow}
                >
                  <LinkIcon size={18} aria-hidden="true" className="text-ink-mute" /> Open in Help Scout
                </a>
              )}
              <button
                type="button"
                onClick={() => { setOpen(false); onToggleMinePin(proof.proof_id) }}
                className={sheetRow}
              >
                <PinIcon className="h-[18px] w-[18px] text-ink-mute" filled={minePinned} />
                {minePinned ? 'Unpin from your list' : 'Pin to your list'}
              </button>
              <button
                type="button"
                onClick={() => { setOpen(false); onToggleTeamPin(proof.proof_id) }}
                className={sheetRow}
              >
                <UsersIcon className="h-[18px] w-[18px] text-ink-mute" />
                {teamPinned ? 'Unpin from the team list' : 'Pin for the team'}
              </button>
              {proof.snoozed_until && proof.snooze_rule_code && (
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false)
                    if (proof.snooze_rule_code) void onUnsnooze(proof.proof_id, proof.snooze_rule_code)
                  }}
                  className={sheetRow}
                  style={{ color: '#7b3ff2' }}
                >
                  <ClockIcon className="h-[18px] w-[18px]" /> Unsnooze
                </button>
              )}
              {proof.rule_code && !proof.snoozed_until && (
                <SnoozeButton proof={proof} onSnooze={onSnooze} sheetStyle />
              )}
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="mt-3 flex w-full min-h-[56px] items-center justify-center rounded-[14px] border border-line bg-surface text-[15px] font-medium text-ink-soft hover:bg-canvas"
            >
              Cancel
            </button>
          </div>
        </Sheet>
      </>
    )
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Project actions"
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o) }}
        className="flex h-8 w-8 items-center justify-center rounded text-ink-mute hover:bg-canvas hover:text-ink focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--c-brand)]"
      >
        <svg viewBox="0 0 16 16" className="h-4 w-4" fill="currentColor"><circle cx="3" cy="8" r="1.5" /><circle cx="8" cy="8" r="1.5" /><circle cx="13" cy="8" r="1.5" /></svg>
      </button>
      {open && menuPos && createPortal(
        <div
          role="menu"
          ref={menuRef}
          style={menuPos}
          className="fixed z-[60] w-56 rounded-[10px] bg-surface py-1 text-sm shadow-md border border-line"
          onClick={(e) => e.stopPropagation()}
        >
          {proof.current_version_id ? (
            <button
              type="button"
              role="menuitem"
              className="block w-full text-left px-3 py-2 text-ink-soft hover:bg-canvas"
              onClick={() => { setOpen(false); openDesignerPreview(proof.proof_id) }}
            >Preview</button>
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
        </div>,
        document.body,
      )}
    </>
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
  // sheetStyle: a taller (56px) full-width row matching the mobile action
  // sheet's other rows. Same options popover as the other variants.
  sheetStyle?: boolean
}

function SnoozeButton({ proof, onSnooze, stripStyle = false, menuStyle = false, sheetStyle = false }: SnoozeButtonProps) {
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
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)

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
      // The popover is portalled to <body>, so the click-outside test must
      // exclude BOTH the trigger button and the portalled popover — else a
      // click inside the popover registers as "outside" and dismisses it
      // before the item's handler fires (mirrors OverflowMenu's pattern).
      const t = e.target as Node
      if (btnRef.current?.contains(t) || popRef.current?.contains(t)) return
      resetState()
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

  // Position the popover via a fixed-position portal so it escapes the row
  // card's overflow-hidden (which was clipping it — same fix the ⋯
  // OverflowMenu and ThumbnailPopover already use). The strip + menu
  // variants right-align under the trigger; the small amber chip button
  // (default) left-aligns. Clamped to stay on-screen.
  const POPOVER_W = 224 // matches the old w-56
  const POPOVER_H_GUESS = 320
  const popPos = open && btnRef.current
    ? (() => {
        const r = btnRef.current!.getBoundingClientRect()
        const left = (stripStyle || menuStyle || sheetStyle)
          ? Math.max(16, r.right - POPOVER_W)
          : Math.max(16, Math.min(r.left, window.innerWidth - POPOVER_W - 16))
        const top = Math.max(16, Math.min(r.bottom + 4, window.innerHeight - POPOVER_H_GUESS - 16))
        return { left, top, width: POPOVER_W }
      })()
    : null

  return (
    <div className="relative">
      {sheetStyle ? (
        <button
          ref={btnRef}
          type="button"
          aria-label="Snooze this alert"
          onClick={(e) => { e.stopPropagation(); setOpen((o) => !o) }}
          className="flex w-full min-h-[56px] items-center gap-3 border-t border-line-soft px-4 text-left text-[15px] text-ink-soft hover:bg-canvas"
        >
          <ClockIcon className="h-[18px] w-[18px] shrink-0 text-ink-mute" />
          <span>Snooze…</span>
        </button>
      ) : menuStyle ? (
        <button
          ref={btnRef}
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
          ref={btnRef}
          type="button"
          aria-label="Snooze this alert"
          title="Snooze this alert"
          onClick={(e) => { e.stopPropagation(); setOpen((o) => !o) }}
          className={
            stripStyle
              ? 'flex h-7 w-7 items-center justify-center rounded text-ink-mute hover:bg-canvas hover:text-ink focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--c-brand)]'
              : 'flex h-5 w-5 items-center justify-center rounded-full text-low hover:bg-low-soft focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--c-low)]'
          }
        >
          <ClockIcon className={stripStyle ? 'h-4 w-4' : 'h-3 w-3'} />
        </button>
      )}
      {open && popPos && createPortal(
        <div
          role="dialog"
          ref={popRef}
          aria-label="Snooze options"
          style={popPos}
          className="fixed z-[90] overflow-hidden rounded-[10px] bg-surface py-2 shadow-md border border-line"
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
        </div>,
        document.body,
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

// ThumbInfo (thumb_url / preview_url / full_url) + the batched signer live in
// src/lib/thumbnails.ts, shared with the orders page so both read one contract.

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
      // createPortal renders to document.body, but React still bubbles
      // synthetic events up the *component* tree — so without stopping
      // propagation here the click would also hit ProjectRow's onClick
      // and navigate to the proof page. stopPropagation keeps a
      // backdrop click as a pure dismiss.
      onClick={(e) => { e.stopPropagation(); onClose() }}
    >
      <button
        type="button"
        aria-label="Close preview"
        onClick={(e) => { e.stopPropagation(); onClose() }}
        className="absolute top-4 right-4 inline-flex items-center justify-center w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 text-white"
      >
        <X size={16} />
      </button>
      {/* Drive the height (h-[80vh]) rather than only capping it so a
          low-resolution source image scales UP to fill the viewport
          instead of sitting tiny at its natural size — a cap-only
          (max-h/max-w) image never grows past its own pixels. Width is
          auto (keeps aspect) and capped at 90vw; object-contain letterboxes
          the rare ultra-wide image. Large proof photos are unaffected. */}
      <img
        src={imageUrl}
        alt={projectName}
        onClick={(e) => e.stopPropagation()}
        className="h-[80vh] w-auto max-w-[90vw] object-contain rounded-[8px] shadow-lg"
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
  /** Signed-URL renditions for the project's first front image (small /
   *  medium / full). Undefined while loadThumbnails is in flight or when the
   *  version has no images; the row falls through to the dark-plate initials
   *  placeholder. */
  thumb?: ThumbInfo
  onToggleMinePin: (proofId: string) => void
  onToggleTeamPin: (proofId: string) => void
  onSnooze: (proofId: string, ruleCode: NeedsAttentionRule, hours: number, note: string) => Promise<void>
  onUnsnooze: (proofId: string, ruleCode: NeedsAttentionRule) => Promise<void>
  // Refresh the dashboard after the resolve popover auto-snoozes a proof
  // (so the now-snoozed row drops off the Needs-attention list).
  onAfterResolve: () => void
  /** The bundle this card belongs to (proof_sets, 000311), when it's in one of
   *  2+ live cards. Null for the standalone majority. */
  bundle?: BundleInfo | null
  /** True when the row is rendered INSIDE a BundleBlock. The container already
   *  says the cards are one bundle, so the row drops its chip — belt and braces
   *  on a row that's already visibly contained reads as clutter. */
  bundleNested?: boolean
}

function ProjectRow({
  project,
  minePinned,
  teamPinned,
  thumb,
  onToggleMinePin,
  onToggleTeamPin,
  onSnooze,
  onUnsnooze,
  onAfterResolve,
  bundle = null,
  bundleNested = false,
}: ProjectRowProps) {
  // Hover popover + click lightbox state. Both gate on a real
  // thumb — when no image is available (placeholder rendering)
  // the thumb is non-interactive and shows nothing on hover/click.
  const [previewOpen, setPreviewOpen] = useState(false)
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const hoverTimerRef = useRef<number | null>(null)
  const thumbRef = useRef<HTMLDivElement>(null)

  function handleThumbMouseEnter() {
    if (!thumb) return
    // Hover preview is a mouse-only affordance: gate it behind a real
    // fine+hover pointer so it never half-fires on touch (where tap
    // already opens the lightbox). matchMedia is cheap to read here.
    if (typeof window !== 'undefined' && 'matchMedia' in window &&
        !window.matchMedia('(hover: hover) and (pointer: fine)').matches) return
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
    if (!thumb) return
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
  const isMobile = useIsMobile()
  const canAddVersion = project.status === 'in_progress' || project.status === 'dormant'

  // Single source of truth for this row's status pill label/colour and the
  // coloured left cap below — both now read from the same workflow bucket
  // the headline tiles use (proofBucket), so the pill can no longer say
  // "In review" while the tiles speak a different vocabulary.
  const bucket = proofBucket(project)
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
  // Shown when no thumbnail is available (no version yet, no images,
  // or the thumbnail fetch is still in flight / failed).
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

  // ── Mobile: single-column card ─────────────────────────────────────────
  // The desktop multi-column grid + hover-only action overlay can't work on
  // touch. Below md: render a card where everything (thumbnail, name, spec
  // sub-line, reason, status pill) is always visible and the actions live
  // behind a visible kebab → bottom action sheet (OverflowMenu, which is
  // itself mobile-aware). The whole card taps through to the proof; the
  // kebab / reason chip / thumbnail stopPropagation.
  if (isMobile) {
    const specLine = [
      project.material_display,
      project.current_version_number != null ? `v${project.current_version_number}` : null,
    ].filter(Boolean).join(' · ')
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
          'relative overflow-hidden rounded-[10px] bg-surface border border-line border-l-[10px] pl-3 pr-2 py-3 transition-colors active:bg-canvas focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--c-brand)]',
          project.status === 'dormant' ? 'opacity-60' : '',
        ].join(' ')}
        style={{ borderLeftColor: bucket.colour }}
      >
        <div className="flex items-start gap-3">
          <div
            ref={thumbRef}
            onClick={handleThumbClick}
            className={[
              'relative flex shrink-0 items-center justify-center w-14 h-11 rounded-[4px] bg-ink text-on-ink font-mono font-medium text-[10px] tracking-wider overflow-hidden',
              thumb ? 'cursor-zoom-in' : '',
            ].join(' ')}
          >
            {/* object-COVER, not contain — see the desktop row below. */}
            {thumb ? (
              <img src={thumb.thumb_url} alt="" loading="lazy" className="w-full h-full object-cover" />
            ) : (
              thumbInitials
            )}
          </div>
          {lightboxOpen && thumb && (
            <ThumbnailLightbox
              imageUrl={thumb.full_url}
              projectName={projectName}
              onClose={() => setLightboxOpen(false)}
              onOpenProject={() => navigate(`/proofs/${project.proof_id}`)}
            />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[15px] font-medium text-ink">{projectName}</div>
                {subline && <div className="truncate text-xs text-ink-mute mt-0.5">{subline}</div>}
                {specLine && <div className="truncate text-xs text-ink-mute mt-0.5">{specLine}</div>}
                {bundle && !bundleNested && <BundleLine bundle={bundle} shownHere={1} />}
              </div>
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
            {project.rule_code && (
              <ResolvePopover
                proofId={project.proof_id}
                ruleCode={project.rule_code}
                meta={project.rule_meta}
                helpscoutUrl={project.helpscout_conversation_url}
                hasHelpscoutConversation={!!project.helpscout_conversation_id}
                versionId={project.current_version_id}
                versionNumber={project.current_version_number}
                contactFullName={project.contact_name}
                companyName={project.company_name}
                onSnoozed={onAfterResolve}
                className="mt-1.5 max-w-full cursor-pointer"
              >
                <span className="flex min-w-0 items-center gap-1.5 text-[13px] text-out">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-out" aria-hidden="true" />
                  <span className="truncate">{attentionReason(project.rule_code, project.rule_meta)}</span>
                </span>
              </ResolvePopover>
            )}
            {ts && (
              <div className="mt-1 truncate text-xs text-ink-soft" title={formatAbsoluteDateTime(ts)}>
                {verb} {relativeTime(ts)}
              </div>
            )}
            {project.follow_up_rule_code != null && project.follow_up_sent_count != null && project.follow_up_max_nudges != null && (
              <div className="mt-0.5 truncate text-[11px]" style={{ color: '#6366f1' }}>
                {project.follow_up_sent_count === 0
                  ? 'Reminder queued'
                  : `Reminder ${project.follow_up_sent_count} of ${project.follow_up_max_nudges}`}
                {project.follow_up_last_sent_at ? ` · last ${relativeTime(project.follow_up_last_sent_at)}` : ''}
              </div>
            )}
            <div className="mt-2">
              <ProofStatusPill label={bucket.label} colour={bucket.colour} />
            </div>
          </div>
        </div>
      </div>
    )
  }

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
        project.rule_code ? attentionReason(project.rule_code, project.rule_meta) : null,
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
        // Left-border colour comes from the same workflow bucket as the
        // status pill (proofBucket), so the cap, the pill, and the headline
        // tile that counts this proof always share one hue + vocabulary.
        borderLeftColor: bucket.colour,
      }}
    >
      {/* Columnar grid layout per the mockup. At md+ widths the row
          reads as a clean six-column table; at narrower widths some
          columns drop (Material, Versions, Updated) so Customer +
          Status stay legible. */}
      <div className="grid items-center gap-3 grid-cols-[72px_minmax(0,1fr)_auto_auto] sm:grid-cols-[72px_minmax(0,1fr)_140px_auto] md:grid-cols-[72px_minmax(0,1fr)_140px_60px_70px_24px_160px]">
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
            'relative flex items-center justify-center w-[72px] h-[52px] rounded-[4px] bg-ink text-on-ink font-mono font-medium text-[10px] tracking-wider overflow-hidden',
            thumb ? 'cursor-zoom-in' : '',
          ].join(' ')}
        >
          {thumb ? (
            <>
              {/* object-COVER: fill the box and centre-crop the overflow.
                  The box is a fixed 72x52 but proof artwork is every shape
                  there is — a square mockup, a 3:2 photo, the odd portrait —
                  so object-contain left dark bars down the sides of anything
                  narrower than the box (a 4:5 mockup painted 42px wide in a
                  72px box: 15px of dead plate each side). At postage-stamp
                  size the bars cost more recognition than a centre crop does,
                  and the card is centred in practically every mockup. Nothing
                  is lost either way — the hover preview and the click-through
                  lightbox both stay object-contain and show the whole image. */}
              <img
                src={thumb.thumb_url}
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
        {previewOpen && thumb && thumbRef.current && (
          <ThumbnailPopover
            anchor={thumbRef.current}
            imageUrl={thumb.preview_url}
            projectName={projectName}
          />
        )}
        {/* Click lightbox — fullscreen modal with the same image at
            max viewport size. Click backdrop or ESC to close; the
            Open project button navigates to the proof detail page. */}
        {lightboxOpen && thumb && (
          <ThumbnailLightbox
            imageUrl={thumb.full_url}
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
          {/* Treatment B — identity, so it sits directly under the customer
              rather than down with the timing lines. Suppressed inside a block,
              where containment already says it. See BundleLine. */}
          {bundle && !bundleNested && <BundleLine bundle={bundle} shownHere={1} />}
          {/* Reason chip — third row line, shown on every Needs-attention
              row so the triggering rule is always visible (not just when
              the tile filter is active). Clicking it opens the resolve
              popover (reason + how to resolve + Open Help Scout / Send a
              reminder / Start new version). The chip sits in the name
              column, which the hover action strip doesn't cover, so it
              stays clickable on hover. */}
          {project.rule_code && (
            <ResolvePopover
              proofId={project.proof_id}
              ruleCode={project.rule_code}
              meta={project.rule_meta}
              helpscoutUrl={project.helpscout_conversation_url}
              hasHelpscoutConversation={!!project.helpscout_conversation_id}
              versionId={project.current_version_id}
              versionNumber={project.current_version_number}
              contactFullName={project.contact_name}
              companyName={project.company_name}
              onSnoozed={onAfterResolve}
              className="mt-1 max-w-full cursor-pointer"
            >
              <span className="flex min-w-0 items-center gap-1.5 text-xs text-out">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-out" aria-hidden="true" />
                <span className="truncate">{attentionReason(project.rule_code, project.rule_meta)}</span>
              </span>
            </ResolvePopover>
          )}
          {/* Activity time — the proof activity the Activity sort orders by
              (activityVerb's ts is latest_event_at for active proofs) and the
              "Latest activity" card mirrors: "Viewed / Sent / Approved X ago".
              Surfacing it on the row keeps the visible time, the list order,
              and the card in agreement. Previously this lived only in the row's
              hover tooltip, leaving the Help Scout "Last contact" line below as
              the only visible "X ago" — a different (email) clock, which made
              the activity sort look scrambled. */}
          {ts && (
            <div className="mt-1 truncate text-xs text-ink-soft" title={formatAbsoluteDateTime(ts)}>
              {verb} {relativeTime(ts)}
            </div>
          )}
          {/* Help Scout activity chip (000208) — recent Help Scout activity
              (our last contact, or a customer reply) that's keeping a proof off
              Needs attention, so the suppression isn't silent. Kept visually
              secondary to the activity line above because it's a separate clock
              (an email time, not proof activity). The staff timestamp is
              stamped on any outbound reply including the initial proof-send, so
              the label stays neutral ("Last contact"), never claiming a
              follow-up happened. */}
          {(() => {
            const hs = recentHelpscoutActivity(project)
            if (!hs) return null
            return (
              <div className="mt-0.5 truncate text-[11px] text-ink-dim" title={formatAbsoluteDateTime(hs.at)}>
                {hs.kind === 'customer' ? 'Customer replied' : 'Last contact'} {relativeTime(hs.at)}
              </div>
            )
          })()}
          {/* Follow-up progress (000246). When the automation is actively
              chasing this proof, show how far through the reminder cycle it
              is so the designer can see it's in hand without opening it. */}
          {project.follow_up_rule_code != null && project.follow_up_sent_count != null && project.follow_up_max_nudges != null && (
            <div className="mt-0.5 truncate text-[11px]" style={{ color: '#6366f1' }}>
              {project.follow_up_sent_count === 0
                ? 'Reminder queued'
                : `Reminder ${project.follow_up_sent_count} of ${project.follow_up_max_nudges}`}
              {project.follow_up_last_sent_at ? ` · last ${relativeTime(project.follow_up_last_sent_at)}` : ''}
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
            attribute → empty slot kept so the grid column stays. Fades
            out on row hover/focus-within (same as the status pill below)
            so the action overlay can take over the right edge without
            its bg-canvas left edge slicing through the avatar. */}
        <div className="hidden md:flex items-center justify-center transition-opacity group-hover:opacity-0 group-focus-within:opacity-0">
          {project.current_version_id && <DesignerAvatar p={project} />}
        </div>

        {/* Status pill — always visible on all widths. Fades out on
            row hover/focus-within so the action overlay can take over
            the right edge without layout jump. */}
        <div className="flex justify-end items-center transition-opacity group-hover:opacity-0 group-focus-within:opacity-0">
          <ProofStatusPill label={bucket.label} colour={bucket.colour} />
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

// ── Bundle presentation (proof_sets, 000311) ─────────────────────────────────
//
// The two treatments described in lib/dashboardBundles.ts. Both lead with the
// same fact — N cards, ONE review link — because that's what makes the rows
// related in the customer's eyes and what makes a single reminder correct.

/** The status line shared by the block header and the chip's tooltip. */
function bundleDetail(bundle: BundleInfo, shownHere: number): string {
  const parts: string[] = []
  switch (bundleSentState(bundle)) {
    case 'unsent':
      // Deliberately "the bundle link" and not "nothing has been sent" — cards
      // can each have gone out standalone before being gathered into a bundle.
      parts.push('bundle link not sent yet')
      break
    case 'sent_unopened':
      parts.push(`sent ${relativeTime(bundle.sentAt!)} · not opened yet`)
      break
    case 'opened':
      parts.push(`sent ${relativeTime(bundle.sentAt!)} · opened ${relativeTime(bundle.lastOpenedAt!)}`)
      break
  }
  if (bundle.approvedCount > 0) parts.push(`${bundle.approvedCount} of ${bundle.size} approved`)
  const elsewhere = bundle.size - shownHere
  // "not shown here" rather than "shown elsewhere": the missing card might be
  // in another section, or filtered out of the list entirely, and this phrasing
  // is true either way. It's what reconciles the headline count with what you
  // can actually see.
  if (shownHere > 0 && elsewhere > 0) {
    parts.push(`${elsewhere} card${elsewhere === 1 ? '' : 's'} not shown here`)
  }
  return parts.join(' · ')
}

/**
 * Treatment A — the container. Members are nested INSIDE it, so the grouping
 * reads as containment rather than a banner sitting next to rows that could be
 * anywhere in the list. Same call the Orders page made for combined payments.
 */
function BundleBlock({
  bundle,
  shownHere,
  children,
}: {
  bundle: BundleInfo
  shownHere: number
  children: ReactNode
}) {
  return (
    <div className="rounded-[12px] border border-[var(--c-brand)]/50 bg-[var(--c-brand)]/[0.05] p-2.5 max-md:p-2">
      <div className="flex flex-col gap-2 px-1 pb-2.5 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-[13px] font-medium text-ink">
            <Layers size={14} className="shrink-0 text-ink-soft" aria-hidden="true" />
            Bundle · {bundle.size} cards, one review link
          </p>
          <p className="mt-0.5 text-xs text-ink-mute first-letter:uppercase">
            {bundleDetail(bundle, shownHere)}
          </p>
        </div>
        <Link
          to={`/bundles/${bundle.setId}`}
          className="shrink-0 self-start rounded-[var(--radius)] border border-line px-2.5 py-1 text-xs font-medium text-ink-soft transition-colors hover:bg-surface hover:text-ink max-md:h-9 max-md:leading-7"
        >
          Open bundle
        </Link>
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  )
}

/**
 * Treatment B — for a card whose siblings aren't in the visible list at all
 * (filtered out by a tile or search, or outside the dashboard working set), or
 * a card sitting in the Pinned / Snoozed sections away from its siblings.
 * Everything else is gathered into one block by hoistBundleSections, so this
 * line is the fallback that keeps the relationship visible when gathering
 * isn't possible.
 *
 * Deliberately a quiet LINE in the row's secondary stack, not a chip beside the
 * company name. Two things went wrong when it sat on the name line: a tinted
 * pill next to the one piece of 15px type on the row read as an alert rather
 * than a note, and — worse — it competed with the name for the column, so a
 * company that had always fitted started truncating ("Plumus" → "Plu…"). On its
 * own line it can't take width from anything, and it matches the "Last contact"
 * / "Reminder N of M" lines it sits with.
 */
function BundleLine({ bundle, shownHere }: { bundle: BundleInfo; shownHere: number }) {
  return (
    <Link
      to={`/bundles/${bundle.setId}`}
      onClick={(e) => e.stopPropagation()}
      title={`Bundle of ${bundle.size} — ${bundleDetail(bundle, shownHere)}`}
      className="mt-1 flex w-fit max-w-full items-center gap-1.5 text-[11px] text-ink-dim transition-colors hover:text-ink-soft"
    >
      <Layers size={11} className="shrink-0" aria-hidden="true" />
      {/* Short enough to survive a narrow name column, and no "1 of 3" — the
          cards in a bundle have no order, so a position would be invented. */}
      <span className="truncate">Part of a bundle of {bundle.size}</span>
    </Link>
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
    'flex h-7 w-7 items-center justify-center rounded transition-colors',
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
        <RowActionButton label="Preview" onClick={() => openDesignerPreview(proof.proof_id)}>
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
      className="flex h-7 w-7 items-center justify-center rounded hover:opacity-100 focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-1 disabled:opacity-50"
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
    tint: 'var(--c-responded)',
    verbCopy: (v) => `requested changes on v${v}`,
  },
  declined: {
    icon: ThumbsDown,
    tint: 'var(--c-out)',
    verbCopy: () => 'isn’t ready to approve',
  },
  // Synthetic rows from the proof's Help Scout reply timestamps (000208).
  // A customer email reply shares the "responded" hue with request_changes
  // (both are the customer getting back to us); staff replies are muted.
  // Neither verb uses the version number.
  customer_reply: {
    icon: Mail,
    tint: 'var(--c-responded)',
    verbCopy: () => 'replied by email',
  },
  staff_reply: {
    icon: Send,
    tint: 'var(--c-ink-mute)',
    // Outbound: the company is the recipient, not the sender, so this must
    // read differently from customer_reply's "replied by email" — otherwise
    // a reply we send looks like the customer replying to us.
    verbCopy: () => 'was sent a reply',
  },
  // Synthetic row from the order's pay_link_opened_at (000262) — the customer
  // opened the payment link. Same "customer opened something" hue as a view.
  pay_link_opened: {
    icon: CreditCard,
    tint: 'var(--c-allocated)',
    verbCopy: () => 'opened the payment link',
  },
  // Synthetic row from the order's sent_at — we sent the customer the pay link.
  // Outbound action (muted hue, like staff_reply), with a distinct icon + verb.
  pay_link_sent: {
    icon: LinkIcon,
    tint: 'var(--c-ink-mute)',
    verbCopy: () => 'was sent a payment link',
  },
  // Synthetic row from a sent order_nudges reminder (000238) — the automated
  // unpaid-order chase went out. Outbound (muted hue, like pay_link_sent) with
  // a Bell to read as a reminder. The version number isn't relevant (order-level).
  order_reminder_sent: {
    icon: Bell,
    tint: 'var(--c-ink-mute)',
    verbCopy: () => 'was sent a payment reminder',
  },
}

function LatestActivityPanel({
  events,
  navigate,
  fill = false,
}: {
  events: DashboardLatestEvent[]
  navigate: (to: string) => void
  // When true, render as a self-filling card (no collapse toggle) that
  // grows to fill its flex parent's height and scrolls the list inside
  // it. Used by the dedicated mobile Activity page so the events use the
  // whole screen instead of a fixed ~420px card that half-fills an
  // iPhone. Omitted (false) in the desktop sidebar, which keeps the
  // collapsible fixed-height card.
  fill?: boolean
}) {
  const body =
    events.length === 0 ? (
      <p className="px-5 py-8 text-center text-sm text-ink-mute">
        No customer activity yet.
      </p>
    ) : (
      // In the sidebar, cap the list to roughly six rows (~70px each) and
      // let older entries scroll into view. In fill mode the list instead
      // grows to fill the frame (flex-1) below md and scrolls inside it,
      // capping at the same height from md up. The fetch already pulls up
      // to 20 events, newest first.
      <ul
        className={[
          'overflow-y-auto divide-y divide-line-soft',
          fill ? 'max-md:min-h-0 max-md:flex-1 md:max-h-[420px]' : 'max-h-[420px]',
        ].join(' ')}
      >
          {events.map((e) => {
            const visual = ACTIVITY_VISUAL[e.event_type]
            const Icon = visual.icon
            const verb = visual.verbCopy(e.version_number)
            // Lead with the company name (matches the Recent projects
            // card, which leads with company and relegates the person
            // to a subline). Fall back to the actor's name when the
            // proof has no company, and in that case skip the secondary
            // actor line so it doesn't read as "Clayton Furry / Clayton
            // Furry".
            //
            // Staff replies are the exception: their actor is "You" (us, the
            // sender), not the customer — so it must never become the bold
            // primary label, which produces "You was sent a reply" on a
            // proof with no company. Lead with the customer (company, then
            // contact) and keep "You" on the actor subline, matching the
            // with-company rendering.
            const isStaffReply = e.event_type === 'staff_reply'
            const primaryLabel = isStaffReply
              ? e.company_name || e.contact_name || 'Customer'
              : e.company_name || e.actor_name
            const showActor = isStaffReply
              ? e.actor_name !== primaryLabel
              : Boolean(e.company_name) && e.actor_name !== primaryLabel
            // "Notification failed" only makes sense for the customer-side
            // approve / request_changes events that fire a Help Scout post.
            // Views, overrides, and the synthetic *_reply rows carry no thread
            // id by design, so they must never show the badge.
            const failed =
              (e.event_type === 'approve' || e.event_type === 'request_changes') &&
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
                    <span className="font-semibold">{primaryLabel}</span>{' '}
                    <span className="text-ink-soft">{verb}</span>
                  </p>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    {showActor && (
                      <>
                        <span className="text-[12px] leading-none text-ink-soft">
                          {e.actor_name}
                        </span>
                        <span
                          aria-hidden="true"
                          className="text-[10px] leading-none text-ink-mute"
                        >
                          ·
                        </span>
                      </>
                    )}
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
      )

  if (fill) {
    return (
      <section className="rounded-[14px] bg-surface border border-line overflow-hidden max-md:flex max-md:min-h-0 max-md:flex-1 max-md:flex-col">
        {/* Static header — the same 32px tinted icon + eyebrow + display
            heading as the sidebar card, but no collapse toggle: on a
            dedicated page, collapsing the only content would leave a
            blank screen. */}
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
          <span className="min-w-0 flex-1">
            <span className="eyebrow text-ink-mute block">Recent</span>
            <span className="block font-display font-medium tracking-[-0.02em] text-ink leading-tight text-[20px]">
              Latest activity
            </span>
          </span>
        </div>
        {body}
      </section>
    )
  }

  return (
    <CollapsibleSidebarPanel
      icon={Bell}
      iconTint="var(--c-brand)"
      eyebrow="Recent"
      title="Latest activity"
      storageKey="pv.sidebar.collapsed.activity"
    >
      {body}
    </CollapsibleSidebarPanel>
  )
}

// ── Lead times chart ─────────────────────────────────────────────────────────

// Per-category bar colour. Mirrors the material-family filter chips'
// intent (one hue per family) but keys off the catalogue `category`
// column directly rather than a name regex. All values are design
// tokens so the chart stays on-system; carbon's variants share the
// near-black ink tint, fitting the material. Unknown categories fall
// back to the muted ink grey.
const LEAD_TIME_CATEGORY_TINT: Record<string, string> = {
  metal:            'var(--c-allocated)',
  paper:            'var(--c-low)',
  plastic:          'var(--c-brand)',
  wood:             'var(--c-in-stock)',
  acrylic:          'var(--c-critical)',
  carbon_fibre:     'var(--c-ink)',
  carbon_fibre_cnc: 'var(--c-ink)',
  carbon_cnc:       'var(--c-ink)',
}

function leadTimeTint(category: string): string {
  return LEAD_TIME_CATEGORY_TINT[category] ?? 'var(--c-ink-mute)'
}

// Human family name per `category`. The catalogue column is snake_case;
// these are the names staff use. Carbon fibre + its CNC variant share a
// label so both fall under one "Carbon fibre" heading.
const LEAD_TIME_CATEGORY_LABEL: Record<string, string> = {
  metal:            'Metal',
  carbon_fibre:     'Carbon fibre',
  carbon_fibre_cnc: 'Carbon fibre',
  carbon_cnc:       'Carbon fibre',
  paper:            'Paper',
  plastic:          'Plastic',
  acrylic:          'Acrylic',
  wood:             'Wood',
}

// Curated heading order — flagship metal first, then roughly by how
// often each family is quoted. Any label not listed sorts to the end
// alphabetically.
const LEAD_TIME_GROUP_ORDER = ['Metal', 'Carbon fibre', 'Paper', 'Plastic', 'Acrylic', 'Wood']

function leadTimeCategoryLabel(category: string): string {
  return (
    LEAD_TIME_CATEGORY_LABEL[category] ??
    category.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  )
}

// Horizontal range-bar chart of production lead times. Each row is one
// material; the bar runs left→right with a solid core up to the *min*
// business-day figure and a lighter tail extending to the *max*, so
// the bar reads as "at least X, up to Y". Bar widths are scaled to the
// single longest max across all materials, making rows comparable at a
// glance. Sits in the dashboard sidebar under Latest activity.
function LeadTimesChart({
  leadTimes,
  navigate,
  fill = false,
}: {
  leadTimes: LeadTime[]
  navigate: (to: string) => void
  // Same as LatestActivityPanel's `fill`: on the dedicated mobile Activity
  // page, render a self-filling card (no collapse toggle) whose grouped list
  // grows to fill the frame below md and scrolls inside it, with the header
  // and legend pinned. The desktop sidebar keeps the collapsible card.
  fill?: boolean
}) {
  // Longest max-days drives the scale. Guard against an all-zero /
  // empty set so the width maths never divides by zero.
  const scaleMax = leadTimes.reduce((m, lt) => Math.max(m, lt.lead_time_max_days), 0) || 1
  // Grouped by material family with a heading per family, A→Z within —
  // staff scan this to find a product, not to rank by wait time. Bar
  // widths stay scaled to the single longest max across all families,
  // so rows remain comparable across groups.
  const grouped = new Map<string, LeadTime[]>()
  for (const lt of leadTimes) {
    const label = leadTimeCategoryLabel(lt.category)
    const bucket = grouped.get(label)
    if (bucket) bucket.push(lt)
    else grouped.set(label, [lt])
  }
  const groups = [...grouped.entries()]
    .map(([label, items]) => ({
      label,
      items: [...items].sort((a, b) => a.display_name.localeCompare(b.display_name)),
    }))
    .sort((a, b) => {
      const ai = LEAD_TIME_GROUP_ORDER.indexOf(a.label)
      const bi = LEAD_TIME_GROUP_ORDER.indexOf(b.label)
      return (
        (ai === -1 ? Infinity : ai) - (bi === -1 ? Infinity : bi) ||
        a.label.localeCompare(b.label)
      )
    })

  const body =
    groups.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-ink-mute">
          No lead times set yet.{' '}
          <button
            type="button"
            onClick={() => navigate('/admin/catalogue/lead-times')}
            className="font-medium text-ink underline underline-offset-2 hover:text-brand"
          >
            Set them in Admin
          </button>
          .
        </p>
      ) : (
        <>
          {/* Grouped by family with a heading per family; the whole list
              scrolls so a long catalogue doesn't push the sidebar to an
              unwieldy height. */}
          <div
            className={[
              'overflow-y-auto px-5 py-4 space-y-4',
              fill ? 'max-md:min-h-0 max-md:flex-1 md:max-h-[360px]' : 'max-h-[360px]',
            ].join(' ')}
          >
            {groups.map((group) => (
              <div key={group.label}>
                <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-mute">
                  {group.label}
                </div>
                <ul className="space-y-3">
                  {group.items.map((lt) => {
                    const tint = leadTimeTint(lt.category)
                    const minPct = (lt.lead_time_min_days / scaleMax) * 100
                    const maxPct = (lt.lead_time_max_days / scaleMax) * 100
                    const rangeLabel =
                      lt.lead_time_min_days === lt.lead_time_max_days
                        ? `${lt.lead_time_min_days}d`
                        : `${lt.lead_time_min_days}–${lt.lead_time_max_days}d`
                    return (
                      <li key={lt.display_name}>
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="truncate text-[13px] font-medium text-ink">
                            {lt.display_name}
                          </span>
                          <span className="shrink-0 font-mono font-tnum text-[11px] text-ink-mute">
                            {rangeLabel}
                          </span>
                        </div>
                        {/* Track: full-width rounded rail. The lighter tail is
                            laid first (left-aligned, full length to max), then
                            the solid core paints over its first `min` portion.
                            Both rounded so the core reads as a pill resting on
                            the tail. title carries the long-form for hover. */}
                        <div
                          className="relative mt-1.5 h-2.5 w-full rounded-full bg-line-soft"
                          title={`${lt.display_name} — ${rangeLabel.replace('d', '')} business days`}
                        >
                          <div
                            className="absolute inset-y-0 left-0 rounded-full"
                            style={{
                              width: `${maxPct}%`,
                              backgroundColor: `color-mix(in srgb, ${tint} 28%, transparent)`,
                            }}
                          />
                          <div
                            className="absolute inset-y-0 left-0 rounded-full"
                            style={{ width: `${minPct}%`, backgroundColor: tint }}
                          />
                        </div>
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))}
          </div>
          {/* Legend: ties the solid/light split to its meaning. */}
          <div className="flex items-center gap-4 border-t border-line-soft px-5 py-3 text-[11px] text-ink-mute">
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 rounded-full bg-ink" aria-hidden="true" />
              min
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: 'color-mix(in srgb, var(--c-ink) 28%, transparent)' }}
                aria-hidden="true"
              />
              up to max
            </span>
            <span className="ml-auto">business days</span>
          </div>
        </>
      )

  if (fill) {
    return (
      <section className="rounded-[14px] bg-surface border border-line overflow-hidden max-md:flex max-md:min-h-0 max-md:flex-1 max-md:flex-col">
        {/* Static header — same chrome as the sidebar card, no collapse
            toggle. The list scrolls between this and the pinned legend. */}
        <div className="flex items-center gap-3 px-5 pt-5 pb-4 border-b border-line-soft">
          <span
            aria-hidden="true"
            className="inline-flex items-center justify-center w-8 h-8 rounded-md shrink-0"
            style={{
              backgroundColor: 'color-mix(in srgb, var(--c-brand) 14%, transparent)',
              color: 'var(--c-brand)',
            }}
          >
            <Clock size={16} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="eyebrow text-ink-mute block">Production</span>
            <span className="block font-display font-medium tracking-[-0.02em] text-ink leading-tight text-[20px]">
              Lead times
            </span>
          </span>
        </div>
        {body}
      </section>
    )
  }

  return (
    <CollapsibleSidebarPanel
      icon={Clock}
      iconTint="var(--c-brand)"
      eyebrow="Production"
      title="Lead times"
      storageKey="pv.sidebar.collapsed.lead-times"
    >
      {body}
    </CollapsibleSidebarPanel>
  )
}

// ── Hero greeting ────────────────────────────────────────────────────────────

// The hero's "Good afternoon, <name>" line. This MUST be its own
// component rather than inlined into DashboardPage. DashboardPage
// renders the DesignerProfileContext provider (via <DesignerChrome>)
// inside its own JSX, and a component cannot consume a context that it
// itself renders — so a useDesignerProfile() call in DashboardPage's
// body always reads null and the greeting fell back to "there". As a
// child of DesignerChrome, this component sits below the provider and
// reads the real signed-in designer's first name.
function HeroGreeting() {
  const profile = useDesignerProfile()
  return <>{greetingFor(new Date())}, {profile?.firstName ?? 'there'}</>
}

// ── Session snapshot ─────────────────────────────────────────────────────────
//
// Module-level (so it survives this page unmounting and remounting) cache of
// the last successful load, keyed by the server search term. Opening a proof
// and coming back used to mean a full cold load behind a spinner; now the last
// view paints immediately and the refetch corrects it underneath.
//
// Deliberately module-level rather than localStorage: it must not outlive the
// tab, and it holds signed URLs that expire. Bounded to one entry per search
// term with a hard age limit so it can't serve anything genuinely stale.
interface DashboardSnapshot {
  searchTerm: string
  savedAt: number
  projects: DashboardProject[]
  latestEvents: DashboardLatestEvent[]
  leadTimes: LeadTime[]
  tileCounts: TileCounts | null
  flaggedOpenCount: number
  minePinAt: Map<string, string>
  teamPinAt: Map<string, string>
  thumbnailUrls: Map<string, ThumbInfo>
  bundleIndex: BundleIndex
}

// Five minutes. Long enough to cover a designer working through a batch of
// proofs, short enough that a snapshot is never meaningfully out of date — and
// a refetch always runs on top of it anyway.
const SNAPSHOT_MAX_AGE_MS = 5 * 60 * 1000
let dashboardSnapshot: DashboardSnapshot | null = null

function readDashboardSnapshot(searchTerm: string): DashboardSnapshot | null {
  const snap = dashboardSnapshot
  if (!snap) return null
  if (snap.searchTerm !== searchTerm) return null
  if (Date.now() - snap.savedAt > SNAPSHOT_MAX_AGE_MS) return null
  return snap
}

// ── Component ────────────────────────────────────────────────────────────────

// activityView: render the dashboard's data in "Activity page" mode instead —
// the /activity route the mobile tab bar links to. Reuses this page's whole
// data pipeline (the feed is synthesised from five sources), so there's one
// loader and zero drift; it just renders the three activity panels as a
// normal page inside the app chrome rather than the dashboard body.
export default function DashboardPage({ activityView = false }: { activityView?: boolean }) {
  const navigate = useNavigate()
  const { session, role } = useAuth()
  const userId = session?.user.id ?? null
  const [projects, setProjects]           = useState<DashboardProject[]>([])
  // Server-computed tile counts (migration 000202). Counted across every
  // proof in the DB, not the loaded `projects` subset, so the headline
  // numbers stay correct no matter how many proofs exist. Null until the
  // RPC resolves.
  const [tileCounts, setTileCounts]       = useState<TileCounts | null>(null)
  // Order-stage tiles (Awaiting payment / To order), shown only when ordering
  // is enabled. Counted across all orders (not the loaded proof subset); they
  // navigate to the Orders page rather than filtering the proof list, since
  // orders aren't part of the dashboard list. "To order" mirrors the Orders
  // page's actionable bucket (paid, not yet placed) — fulfilled is finished work
  // and lives under "Recently ordered" there. invoiceProblem = paid orders whose
  // Xero invoice failed (a books gap that's otherwise only visible on /orders).
  const [orderingOn, setOrderingOn]       = useState(false)
  // Admin switch for the "Hot leads to chase" card (migration 000280). Starts
  // true — the panel ships shown — so the card doesn't flicker out on first
  // paint before the settings read resolves. An admin turning it off hides it.
  const [hotLeadsOn, setHotLeadsOn]       = useState(true)
  const [orderCounts, setOrderCounts]     = useState<{ awaitingPayment: number; toOrder: number; invoiceProblem: number } | null>(null)
  // current_version_id → thumbnail renditions (thumb / preview / full).
  // Populated in loadDashboard after the projects fetch via the
  // dashboard-thumbnails edge function (which signs each version's first
  // front image server-side). Empty entries (no version yet, or no images
  // uploaded) fall through to the dark-plate placeholder in ProjectRow.
  const [thumbnailUrls, setThumbnailUrls] = useState<Map<string, ThumbInfo>>(new Map())
  const [latestEvents, setLatestEvents]   = useState<DashboardLatestEvent[]>([])
  // Production lead times for the sidebar chart under Latest activity.
  // Sourced from materials (same table the admin Lead times tab edits);
  // empty until loadDashboard resolves.
  const [leadTimes, setLeadTimes]         = useState<LeadTime[]>([])
  // myProfile / editProfileOpen / handleSignOut state moved into
  // DesignerChrome in PR 31. The hero greeting reads the profile via
  // the <HeroGreeting /> child component — it can't be read here in
  // the body because this component renders the provider itself (see
  // HeroGreeting's note).
  // Pin state — proof_id → pinned_at ISO. Two maps because the
  // dashboard cares about each scope independently (mine drives the
  // Pinned section, team drives the Team section, and both feed the
  // overflow menu's toggle labels). pinned_at is preserved so the
  // sections can sort by recency.
  const [minePinAt, setMinePinAt]         = useState<Map<string, string>>(new Map())
  const [teamPinAt, setTeamPinAt]         = useState<Map<string, string>>(new Map())
  // Bundle membership (proof_sets, 000311). Fetched standalone and merged
  // client-side rather than joined into public_dashboard_projects — same
  // posture as the pin maps above, and for the same reason (no migration, and
  // bundle churn doesn't force a dashboard refetch).
  const [bundleIndex, setBundleIndex]     = useState<BundleIndex>(EMPTY_BUNDLE_INDEX)
  // Count of un-resolved cards on the Flagged board — drives the Flagged tile.
  const [flaggedOpenCount, setFlaggedOpenCount] = useState(0)
  const [loading, setLoading]             = useState(true)
  // Non-null when the last dashboard_list call failed. Rendered as a banner
  // above the list so a broken fetch can never masquerade as an empty account.
  const [loadError, setLoadError]         = useState<string | null>(null)
  // Transient failure message for the small writes (pin, snooze, unsnooze)
  // that previously failed to console only — the designer clicked, nothing
  // happened, and nothing said why.
  const [actionError, setActionError]     = useState<string | null>(null)
  // Search + tile filter live in the URL, not component state.
  //
  // WHY. Opening a proof unmounts this page; coming back remounts it. As plain
  // useState both were lost, so the designer returned from every single proof
  // to an empty search box and an unfiltered list — the most-repeated loop in
  // the app. In the query string the browser restores them for free on Back,
  // and a filtered view becomes a shareable/bookmarkable link.
  //
  // Written with replace:true so typing doesn't push a history entry per
  // keystroke; the entry is updated in place, which is exactly what Back
  // should return to. Everything else (sort, group, show-abandoned) stays in
  // localStorage — those are durable preferences, not "where I am right now".
  const [searchParams, setSearchParams] = useSearchParams()
  const search = searchParams.get('q') ?? ''
  // Validated against the known keys so a hand-edited ?tile=nonsense simply
  // falls back to "no filter" instead of silently filtering everything out.
  const tileParam = searchParams.get('tile')
  const tileFilter: TileKey | null =
    tileParam && (TILE_KEYS as readonly string[]).includes(tileParam) ? (tileParam as TileKey) : null

  const setSearch = useCallback((value: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      if (value) next.set('q', value)
      else next.delete('q')
      return next
    }, { replace: true })
  }, [setSearchParams])

  const setTileFilter = useCallback((
    value: TileKey | null | ((prev: TileKey | null) => TileKey | null),
  ) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      const current = prev.get('tile')
      const currentKey: TileKey | null =
        current && (TILE_KEYS as readonly string[]).includes(current) ? (current as TileKey) : null
      const resolved = typeof value === 'function' ? value(currentKey) : value
      if (resolved) next.set('tile', resolved)
      else next.delete('tile')
      return next
    }, { replace: true })
  }, [setSearchParams])
  const [sort, setSort]                   = useState<SortMode>(readSort)
  const [group, setGroup]                 = useState<GroupMode>(readGroup)
  const [showAbandoned, setShowAbandoned] = useState<boolean>(readShowAbandoned)
  const [showSnoozed,   setShowSnoozed]   = useState<boolean>(readShowSnoozed)
  const [chipFilter,    setChipFilter]    = useState<ChipKey>(readChip)
  // When the user picks "Snoozed" from the status dropdown we want to show
  // only the Snoozed section and hide the main list. This is distinct from
  // clicking the tile, which shows the Snoozed section alongside the rest.
  const [snoozedOnly,   setSnoozedOnly]   = useState(false)

  // The search term the server list is currently fetched for. Held in a
  // ref so loadDashboard() (called from many places — mount, visibility,
  // after pin/snooze writes) always re-fetches for the active search
  // without every call site threading it through. Empty = working set.
  const serverSearchRef = useRef('')

  // ── Mobile-only: the Activity tab's unseen dot + the stat-tiles scroll
  // strip. None of this has any effect at md:+ (the activity aside renders
  // as before, and the tiles are a grid not a scroll strip).
  const [activityTab, setActivityTab] = useState<'activity' | 'followups' | 'leadtimes'>('activity')
  const [activitySeenAt, setActivitySeenAt] = useState<string | null>(() => {
    try { return localStorage.getItem('dash.activity.seenAt') } catch { return null }
  })
  const tilesStripRef = useRef<HTMLDivElement>(null)
  const tilesSaveTimer = useRef<number | null>(null)

  const newestActivityAt = latestEvents[0]?.created_at ?? null
  const activityHasUnseen =
    newestActivityAt != null && (activitySeenAt == null || newestActivityAt > activitySeenAt)
  // Visiting /activity marks the feed seen (clears the tab dot), exactly as
  // opening the old sheet did.
  useEffect(() => {
    if (!activityView || !newestActivityAt) return
    setActivitySeenAt(newestActivityAt)
    try { localStorage.setItem('dash.activity.seenAt', newestActivityAt) } catch { /* */ }
  }, [activityView, newestActivityAt])
  // Legacy deep link: the tab used to land here as /?activity=1 and open a
  // sheet. Activity is a real page now — forward old links there.
  const location = useLocation()
  useEffect(() => {
    if (!activityView && new URLSearchParams(location.search).get('activity') === '1') {
      navigate('/activity', { replace: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search])
  function handleTilesScroll(e: React.UIEvent<HTMLDivElement>) {
    const x = e.currentTarget.scrollLeft
    if (tilesSaveTimer.current) window.clearTimeout(tilesSaveTimer.current)
    tilesSaveTimer.current = window.setTimeout(() => {
      try { localStorage.setItem('dash.tiles.x', String(x)) } catch { /* */ }
    }, 150)
  }
  // Restore the tiles scroll position once the list has rendered (it only
  // exists when !loading). iOS keeps localStorage across PWA relaunches, so
  // the strip lands where the designer left it.
  useLayoutEffect(() => {
    if (loading) return
    const el = tilesStripRef.current
    if (!el) return
    try {
      const saved = localStorage.getItem('dash.tiles.x')
      if (saved) el.scrollLeft = parseInt(saved, 10) || 0
    } catch { /* */ }
  }, [loading])

  // Mount. If we have a recent snapshot from earlier in this session, paint it
  // immediately and revalidate behind it; otherwise show the spinner.
  //
  // WHY. Opening a proof unmounts this page, so coming back was a cold start:
  // loading=true, ten queries, full-page spinner, every time — and it is the
  // most-repeated loop in the app. The snapshot makes Back feel instant while
  // the refetch (which still always runs) corrects anything stale. Same idea
  // as DesignerChrome's module-level badge cache, for the same reason.
  useEffect(() => {
    const snap = readDashboardSnapshot(serverSearchRef.current)
    if (snap) {
      setProjects(snap.projects)
      setLatestEvents(snap.latestEvents)
      setLeadTimes(snap.leadTimes)
      setTileCounts(snap.tileCounts)
      setFlaggedOpenCount(snap.flaggedOpenCount)
      setMinePinAt(snap.minePinAt)
      setTeamPinAt(snap.teamPinAt)
      setThumbnailUrls(snap.thumbnailUrls)
      setBundleIndex(snap.bundleIndex)
      setLoading(false)
    }
    loadDashboard()
  }, [])

  // Server-side search (scaling C). The `search` box filters the loaded
  // list client-side for instant feedback; this debounced effect also
  // re-fetches dashboard_list with the term so proofs OUTSIDE the working
  // set (archived: old approved / abandoned) surface. Only refetches when
  // the settled term actually changes — typing within the already-loaded
  // set stays instant, the archive backfills ~300ms later.
  useEffect(() => {
    const t = setTimeout(() => {
      const term = search.trim()
      if (term === serverSearchRef.current) return
      serverSearchRef.current = term
      void loadDashboard()
    }, 300)
    return () => clearTimeout(t)
  }, [search])

  // Profile fetch lives inside DesignerChrome — the wrapper owns
  // it so other designer pages don't each reimplement it.

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

  // Fetch + sign the row thumbnails for a list of dashboard projects. Returns a
  // current_version_id → renditions Map (the dashboard rows look up by
  // current_version_id). Delegates to the shared batched signer, which never
  // throws — every failure path yields an empty Map so missing thumbnails fall
  // through to the placeholder. See src/lib/thumbnails.ts.
  async function loadThumbnails(rows: DashboardProject[]): Promise<Map<string, ThumbInfo>> {
    return signThumbnails(
      rows.map((p) => p.current_version_id).filter((id): id is string => id != null),
    )
  }

  // Ordering tiles: read the ordering master switch + order counts once on
  // mount. Independent of the proof load so it never blocks the list. Counts
  // are head-only (no rows transferred). Hidden entirely when ordering is off.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const on = await getOrderingEnabled()
      if (cancelled) return
      setOrderingOn(on)
      if (!on) return
      const [a, o, p] = await Promise.all([
        supabase.from('orders').select('id', { count: 'exact', head: true }).eq('status', 'sent'),
        supabase.from('orders').select('id', { count: 'exact', head: true }).eq('status', 'paid'),
        // Paid, no Xero invoice, but a stored Xero error → a real books gap.
        // Offline orders carry neither id nor error, so they're excluded.
        supabase.from('orders').select('id', { count: 'exact', head: true })
          .eq('status', 'paid').is('xero_invoice_id', null).not('xero_invoice_error', 'is', null),
      ])
      if (cancelled) return
      setOrderCounts({ awaitingPayment: a.count ?? 0, toOrder: o.count ?? 0, invoiceProblem: p.count ?? 0 })
    })()
    return () => { cancelled = true }
  }, [])

  // Hot-leads panel switch: read the admin toggle once on mount. Independent of
  // the proof load so it never blocks the list. Defaults on; an admin hiding it
  // flips this off (HotLeadsCard still fails quiet on no leads / RPC error).
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const on = await getHotLeadsPanelEnabled()
      if (!cancelled) setHotLeadsOn(on)
    })()
    return () => { cancelled = true }
  }, [])

  async function loadDashboard() {
    // Note: the four queries below depend on migration 000152
    // (public_dashboard_projects view + dashboard_tile_counts() +
    // designer presentation columns on profiles), migration 000154
    // (rule_code / rule_meta on the view), and migration 000155
    // (proof_pins table). The page will throw / render the empty
    // state until all three migrations have been pushed to the
    // linked Supabase project.
    // Working-set list (migration 000203): active + recently-closed
    // proofs, plus anything pinned, instead of every proof capped at 2000.
    // The tile counts (dashboard_tile_counts, 000202) still span ALL
    // proofs, so scoping this list doesn't skew the headline numbers; and
    // every tile's click-through members are active/recent, so they're
    // present in this set. Long-closed history is reachable via search (C).
    // p_search empty → working set; non-empty → matches across all
    // proofs incl. the archive (migration 000205). The term is held in a
    // ref so every loadDashboard() caller re-fetches for the active search.
    const projectsPromise = supabase.rpc('dashboard_list', { p_search: serverSearchRef.current })

    // Note: the stat-tile counts come from the dashboard_tile_counts()
    // RPC, fetched below in the same Promise.all (see countsPromise).
    // Migration 000187 dropped the function during the brief client-side
    // era, then 000202 reintroduced it so the headline numbers span ALL
    // proofs rather than only the (capped) dashboard_list() working set.
    // The RPC predicates are kept in lockstep with the client-side
    // click-through filters below. See PV-2026W19-015 (awaiting_customer)
    // and PV-2026W20-014 (dormant / approved_this_week) for the history.
    const eventsPromise = supabase
      .from('dashboard_latest_events')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(20)
    // Pay-link opens (000262) — the customer opened a still-payable link.
    // Synthesised into the feed like the Help Scout reply rows below, bounded by
    // the same 20-row feed cap.
    const payLinkOpensPromise = supabase
      .from('orders')
      .select('id, proof_id, pay_link_opened_at')
      .eq('status', 'sent')
      .not('pay_link_opened_at', 'is', null)
      .order('pay_link_opened_at', { ascending: false })
      .limit(20)
    // Successful pay-link sends (orders.sent_at) — any status, online only
    // (offline orders send no link; filtered in payLinkSentEvents).
    const payLinkSentsPromise = supabase
      .from('orders')
      .select('id, proof_id, sent_at, payment_method')
      .not('sent_at', 'is', null)
      .order('sent_at', { ascending: false })
      .limit(20)
    // Sent unpaid-order reminders (order_nudges, 000238). Synthesised into the
    // feed like the pay-link rows; proof_id comes from the embedded parent
    // order. Only real sends (state = 'sent') — dry-run rows are skipped, so
    // nothing shows until auto_order_reminders_enabled is flipped on.
    const orderRemindersPromise = supabase
      .from('order_nudges')
      .select('id, created_at, orders(proof_id)')
      .eq('state', 'sent')
      .order('created_at', { ascending: false })
      .limit(20)
    const pinsPromise = supabase
      .from('proof_pins')
      .select('proof_id, scope, user_id, pinned_at')

    // Bundle membership (proof_sets, 000311) — two narrow, unfiltered reads so
    // the "of N" counts describe the WHOLE bundle even when a sibling is
    // filtered out of the list. Tiny today (16 sets over 35 member proofs);
    // if bundles ever became a mass-market feature these would need paging
    // past PostgREST's 1000-row default rather than silently truncating.
    const bundleMembersPromise = supabase
      .from('proofs')
      .select('id, proof_set_id, set_discarded_at, status')
      .not('proof_set_id', 'is', null)
    const bundleSetsPromise = supabase
      .from('proof_sets')
      .select('id, token, sent_at, last_opened_at')

    // Open flagged-board count for the Flagged tile. Standalone (watch_items
    // isn't in the projects view); head+count so no rows transfer.
    const flaggedCountPromise = supabase
      .from('watch_items')
      .select('id', { count: 'exact', head: true })
      .neq('status', 'resolved')

    // Lead times for the sidebar chart. Only active materials with a
    // complete min/max pair (the 000175 CHECK means min is non-null iff
    // max is) — `.not(..., 'is', null)` on the min column is enough to
    // exclude the unset rows. Designer-only data, never customer-facing.
    const leadTimesPromise = supabase
      .from('materials')
      .select('display_name, category, lead_time_min_days, lead_time_max_days')
      .eq('is_active', true)
      .not('lead_time_min_days', 'is', null)

    // Server-side stat-tile counts (migration 000202). Counted across
    // every proof, so the headline numbers don't depend on the (capped)
    // projects fetch above.
    const countsPromise = supabase.rpc('dashboard_tile_counts')

    // Decline feedback (proof_feedback, 000279) for the Latest-activity feed.
    const feedbackPromise = supabase
      .from('proof_feedback')
      .select('id, proof_id, reason_code, actor_name, created_at')
      .order('created_at', { ascending: false })
      .limit(50)

    const [
      { data: projectRows, error: projectsError },
      { data: events },
      { data: pinRows },
      { data: leadTimeRows },
      { data: counts },
      { data: payLinkOpenRows },
      { data: payLinkSentRows },
      { data: orderReminderRows },
      { data: feedbackRows },
      { count: flaggedCount },
      { data: bundleMemberRows, error: bundleMembersError },
      { data: bundleSetRows, error: bundleSetsError },
    ] = await Promise.all([projectsPromise, eventsPromise, pinsPromise, leadTimesPromise, countsPromise, payLinkOpensPromise, payLinkSentsPromise, orderRemindersPromise, feedbackPromise, flaggedCountPromise, bundleMembersPromise, bundleSetsPromise])

    // dashboard_list IS the page. If it failed, say so — the old code
    // destructured `data` only, so an expired JWT, an RLS change or a 500 all
    // arrived as `null`, became `[]`, and rendered the cheerful "No projects
    // yet. Create the first one." empty state. Keep whatever list was already
    // on screen rather than blanking it, and let the banner explain.
    if (projectsError) {
      console.error('[DashboardPage] dashboard_list failed', projectsError)
      setLoadError(projectsError.message || 'Could not load your projects.')
      setLoading(false)
      return
    }
    setLoadError(null)

    const typedProjects = (projectRows ?? []) as DashboardProject[]
    setProjects(typedProjects)

    if (counts) setTileCounts(counts as TileCounts)
    setFlaggedOpenCount(flaggedCount ?? 0)

    // Merge the real customer-activity events with synthetic rows built from the
    // proofs' Help Scout reply timestamps (email replies are timestamps on the
    // proof, not stored events), then sort newest-first and cap at 20 so the feed
    // stays "the latest 20 things that happened" across both sources.
    const realEvents = (events ?? []) as DashboardLatestEvent[]
    // Flatten the order_nudges → orders embed to a proof_id per reminder. The
    // PostgREST to-one embed can surface as an object or a single-element array
    // depending on type inference, so normalise both; rows whose parent order
    // is gone (null) are dropped.
    const orderReminders: OrderReminderRow[] = ((orderReminderRows ?? []) as Array<{ id: string; created_at: string | null; orders: { proof_id: string } | { proof_id: string }[] | null }>)
      .map((r) => {
        const ord = Array.isArray(r.orders) ? r.orders[0] : r.orders
        return ord?.proof_id ? { id: r.id, created_at: r.created_at, proof_id: ord.proof_id } : null
      })
      .filter((r): r is OrderReminderRow => r !== null)
    const mergedEvents = [...realEvents, ...helpscoutReplyEvents(typedProjects), ...payLinkOpenEvents((payLinkOpenRows ?? []) as PayLinkOpenRow[], typedProjects), ...payLinkSentEvents((payLinkSentRows ?? []) as PayLinkSentRow[], typedProjects), ...orderReminderEvents(orderReminders, typedProjects), ...proofFeedbackEvents((feedbackRows ?? []) as ProofFeedbackFeedRow[], typedProjects)]
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, 20)
    setLatestEvents(mergedEvents)
    setLeadTimes((leadTimeRows ?? []) as LeadTime[])

    // ── Per-row thumbnails ──────────────────────────────────────
    // Resolve each project's current-version thumbnail via the
    // dashboard-thumbnails edge function, which picks the first front
    // (or side=null) image and signs small/medium/full renditions
    // server-side. QR-code rows are excluded so a vCard row doesn't
    // masquerade as the proof thumbnail. Fire-and-forget: errors are
    // tolerated silently — missing thumbnails fall through to the
    // dark-plate placeholder in ProjectRow.
    void loadThumbnails(typedProjects).then((thumbs) => {
      setThumbnailUrls(thumbs)
      // Fold the resolved thumbnails into the snapshot so a return trip paints
      // with its images rather than a grid of placeholders.
      if (dashboardSnapshot) dashboardSnapshot.thumbnailUrls = thumbs
    })

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

    // Bundle membership. A failed read keeps whatever index is already on
    // screen: supabase-js returns data: null on error, so the idiomatic
    // `?? []` would quietly dissolve every bundle block into loose rows and
    // read as "these cards aren't related" — the exact wrong answer.
    const nextBundleIndex = bundleMembersError || bundleSetsError
      ? (console.error('[DashboardPage] bundle membership failed', bundleMembersError ?? bundleSetsError), bundleIndex)
      : buildBundleIndex(
          (bundleMemberRows ?? []) as BundleMemberRow[],
          (bundleSetRows ?? []) as BundleSetRow[],
        )
    setBundleIndex(nextBundleIndex)

    // Snapshot this successful load so remounting the page (returning from a
    // proof) can paint instantly instead of spinning through a cold fetch.
    // Thumbnails are folded in above once their signing resolves.
    dashboardSnapshot = {
      searchTerm: serverSearchRef.current,
      savedAt: Date.now(),
      projects: typedProjects,
      latestEvents: mergedEvents,
      leadTimes: (leadTimeRows ?? []) as LeadTime[],
      tileCounts: (counts as TileCounts | null) ?? null,
      flaggedOpenCount: flaggedCount ?? 0,
      minePinAt: mine,
      teamPinAt: team,
      thumbnailUrls: dashboardSnapshot?.thumbnailUrls ?? new Map(),
      bundleIndex: nextBundleIndex,
    }

    setLoading(false)
  }

  // ── Pin / unpin handlers ──────────────────────────────────────────────────
  //
  // These used to `await loadDashboard()` after the write, which is ten
  // queries plus an edge-function call that mints FRESH signed thumbnail URLs
  // — so every pin click re-downloaded every visible thumbnail and shifted the
  // list under the cursor. The Pinned sections are derived from `projects`
  // plus these two pin maps, so patching the map is sufficient and instant.
  // Errors now surface instead of failing to console (or to nothing at all).
  // Audit logging on team pin/unpin is wired in the same place; mine pins are
  // personal organisation and deliberately don't write to audit_log.
  async function toggleMinePin(proofId: string) {
    if (!userId) return
    const wasPinned = minePinAt.has(proofId)
    const { error } = wasPinned
      ? await supabase
          .from('proof_pins')
          .delete()
          .eq('proof_id', proofId)
          .eq('scope', 'mine')
          .eq('user_id', userId)
      : await supabase
          .from('proof_pins')
          .insert({
            proof_id: proofId,
            scope: 'mine',
            user_id: userId,
            pinned_by: userId,
          })
    if (error) {
      console.error('[DashboardPage] mine pin write failed', error)
      setActionError(`Couldn’t ${wasPinned ? 'unpin' : 'pin'} that project: ${error.message}`)
      return
    }
    setMinePinAt((prev) => {
      const next = new Map(prev)
      if (wasPinned) next.delete(proofId)
      else next.set(proofId, new Date().toISOString())
      if (dashboardSnapshot) dashboardSnapshot.minePinAt = next
      return next
    })
  }

  async function toggleTeamPin(proofId: string) {
    if (!userId) return
    const wasPinned = teamPinAt.has(proofId)
    const { error } = wasPinned
      ? await supabase
          .from('proof_pins')
          .delete()
          .eq('proof_id', proofId)
          .eq('scope', 'team')
      : await supabase
          .from('proof_pins')
          .insert({
            proof_id: proofId,
            scope: 'team',
            user_id: null,
            pinned_by: userId,
          })
    if (error) {
      console.error('[DashboardPage] team pin write failed', error)
      setActionError(`Couldn’t ${wasPinned ? 'remove the team pin' : 'add a team pin'}: ${error.message}`)
      return
    }
    void logAudit({
      action: wasPinned ? 'setting.team_pin_removed' : 'setting.team_pin_added',
      targetType: 'proof',
      targetId: proofId,
      metadata: { proof_id: proofId },
    })
    setTeamPinAt((prev) => {
      const next = new Map(prev)
      if (wasPinned) next.delete(proofId)
      else next.set(proofId, new Date().toISOString())
      if (dashboardSnapshot) dashboardSnapshot.teamPinAt = next
      return next
    })
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
      // Surface it as well as rethrowing: the popover closes on its own, so a
      // console-only failure read to the designer as "I snoozed it" when
      // nothing had been written.
      setActionError(`Couldn’t snooze that project: ${error.message}`)
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
    const { error } = await supabase
      .from('proof_attention_snoozes')
      .delete()
      .eq('proof_id', proofId)
      .eq('rule_code', ruleCode)
    if (error) {
      console.error('[handleUnsnooze] delete error:', error)
      setActionError(`Couldn’t wake that project: ${error.message}`)
      return
    }
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

  // Tile counts come from the server (dashboard_tile_counts RPC, migration
  // 000202) so they count across every proof in the database rather than
  // the capped `projects` fetch — the headline numbers stay correct no
  // matter how many proofs exist. The SQL predicates are kept in exact
  // lockstep with the click-through filters below (each tile excludes
  // currently-snoozed proofs, and needs-attention proofs are excluded from
  // the other tiles so each proof belongs to exactly one tile). Null until
  // the RPC resolves; falls back to 0 so the tiles render a number rather
  // than a blank during the first paint.
  const needsAttentionCount   = tileCounts?.needs_attention ?? 0
  const notViewedCount        = tileCounts?.not_viewed ?? 0
  const awaitingCustomerCount = tileCounts?.awaiting_customer ?? 0
  const inFollowUpCount       = tileCounts?.in_follow_up ?? 0
  const customerRespondedCount = tileCounts?.customer_responded ?? 0
  const dormantCount          = tileCounts?.dormant ?? 0
  const approvedThisWeekCount = tileCounts?.approved_this_week ?? 0

  // Filter pipeline: search → chip → tile → status. All AND-combined.
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
      // Material-family chip — orthogonal to the status tiles. 'all' is
      // the no-op default; every other chip keeps only proofs whose
      // material name matches that family's pattern.
      if (chipFilter !== 'all') {
        if (!MATERIAL_CATEGORY_MATCH[chipFilter].test(p.material_display ?? '')) return false
      }
      // Currently-snoozed projects always belong to the Snoozed section —
      // exclude them from every tile filter so they don't appear in the main
      // list when a tile is active. Recently-awakened proofs (snoozed_until
      // in the 24-hour grace window from 000186) fall through and are
      // bucketed normally by the tile predicates below.
      if (tileFilter && isCurrentlySnoozed(p)) return false
      if (tileFilter === 'needs_attention'    && p.rule_code == null) return false
      if (tileFilter === 'awaiting_customer') {
        // Viewed the current version but hasn't responded yet. Mirrors
        // awaiting_customer in dashboard_tile_counts (000245/000246): exclude
        // proofs the customer has already responded to (change request or
        // email reply) and proofs the automation is actively chasing
        // (follow_up_rule_code) — those belong to the Customer responded /
        // In follow-up tiles, and the row pill labels them accordingly.
        const viewed = p.rule_code == null && p.status === 'in_progress' && p.current_version_id !== null && p.current_version_viewed_at !== null
        if (!viewed || p.follow_up_rule_code != null || isChangesRequested(p) || isCustomerReplied(p)) return false
      }
      if (tileFilter === 'in_follow_up') {
        // Proofs the automation is actively chasing (a reminder sent, cap not
        // spent, rule in auto mode — follow_up_rule_code on the view, 000246).
        // Mirror of the in_follow_up tile count: in_progress, not responded
        // (a reply needs a human → Customer responded wins).
        if (p.follow_up_rule_code == null) return false
        if (p.status !== 'in_progress') return false
        if (isChangesRequested(p) || isCustomerReplied(p)) return false
      }
      if (tileFilter === 'dormant'            && p.status !== 'dormant') return false
      if (tileFilter === 'approved_this_week') {
        const cutoff = Date.now() - 7 * 86_400_000
        if (p.status !== 'approved' || !p.approved_at || new Date(p.approved_at).getTime() < cutoff) return false
      }
      if (tileFilter === 'not_viewed') {
        // Active proofs with a current version the customer hasn't opened yet.
        // Needs-attention projects are excluded — they belong to the rose tile only.
        const isActive = p.status === 'in_progress' || p.status === 'dormant'
        if (p.rule_code != null || p.follow_up_rule_code != null || !isActive || !p.current_version_id || p.current_version_viewed_at !== null) return false
      }
      if (tileFilter === 'customer_responded') {
        // Mirror of customerRespondedCount (dashboard_tile_counts, 000213): the
        // customer responded to the current proof, either via the in-app
        // sidebar (a change request newer than the current version) OR by
        // replying on the linked Help Scout conversation more recently than our
        // last reply. Reuses the exact predicates the row pill uses
        // (isChangesRequested / isCustomerReplied) so the tile and list agree.
        // The overdue change-request subset is captured by the
        // request_changes_no_version needs-attention rule and shown there
        // instead — rule_code != null excludes them here.
        if (p.rule_code != null) return false
        if (p.status !== 'in_progress') return false
        if (!isChangesRequested(p) && !isCustomerReplied(p)) return false
      }
      // Hide abandoned proofs unless the designer has toggled them on via
      // the Abandoned checkbox — but never hide them while a search is
      // active: searching is how you find archived (incl. abandoned)
      // proofs, so a match must always surface (scaling C).
      if (!showAbandoned && p.status === 'abandoned' && q === '') return false
      return true
    })
  }, [projects, search, tileFilter, showAbandoned, chipFilter])

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
      // Activity sort — by the shared activity clock (latest_event_at,
      // falling back to last_activity_at). Uses the same helper as
      // groupByTime so the sort order and the Today / This week / Older
      // section a row lands in always agree.
      arr.sort((a, b) => {
        const at = activityTimestamp(a) ?? ''
        const bt = activityTimestamp(b) ?? ''
        return bt.localeCompare(at)
      })
    }
    return arr
  }, [filteredProjects, sort])

  // Publish the visible, ordered list so the proof detail page can offer
  // ← / → navigation through it. This is the list as the designer sees it —
  // already searched, filtered and sorted — so "next" means the next row down.
  useEffect(() => {
    setProofWorklist(sortedProjects.map((p) => ({
      proofId: p.proof_id,
      label: p.company_name ?? p.contact_name ?? 'Untitled project',
    })))
  }, [sortedProjects])

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
    // Bundle cards are then gathered into the section of the bundle's most
    // recently active card, so the whole bundle renders as one block instead
    // of splitting across Today / This week / Older when one card moves ahead
    // of its siblings (see lib/dashboardBundles.ts).
    const tailSections = hoistBundleSections(
      group === 'company' ? groupByCompany(remaining) : groupByTime(remaining),
      bundleIndex,
    )
    const visibleSnoozed = showSnoozed ? snoozedSections : []
    // "Snoozed" selected in the status dropdown — suppress pins + tail so only
    // the Snoozed section is visible (same as a status filter for other statuses).
    if (snoozedOnly) return visibleSnoozed
    return [...pinSections, ...visibleSnoozed, ...tailSections]
  }, [sortedProjects, group, minePinAt, teamPinAt, snoozedSections, showSnoozed, snoozedOnly, bundleIndex])

  const noResults = !loading && sections.every((s) => s.projects.length === 0)

  // ── Row rendering ────────────────────────────────────────────────────────
  //
  // One row, whether it's loose in a section or nested inside a bundle block.
  // Extracted so the plain and virtualised paths can't drift.
  function renderProjectRow(p: DashboardProject, nested: boolean) {
    return (
      <ProjectRow
        key={p.proof_id}
        project={p}
        minePinned={minePinAt.has(p.proof_id)}
        teamPinned={teamPinAt.has(p.proof_id)}
        thumb={p.current_version_id ? thumbnailUrls.get(p.current_version_id) : undefined}
        onToggleMinePin={toggleMinePin}
        onToggleTeamPin={toggleTeamPin}
        onSnooze={handleSnooze}
        onUnsnooze={handleUnsnooze}
        onAfterResolve={() => loadDashboard()}
        bundle={bundleIndex.byProof.get(p.proof_id) ?? null}
        bundleNested={nested}
      />
    )
  }

  // A section entry: a lone project, or a bundle block wrapping the siblings
  // that landed in this same section (see lib/dashboardBundles.ts).
  function renderRowItem(item: ReturnType<typeof buildRowItems>[number]) {
    if (item.kind === 'project') return renderProjectRow(item.project, false)
    return (
      <BundleBlock
        key={item.key}
        bundle={item.bundle}
        shownHere={bundleShownHere(item.projects, item.bundle)}
      >
        {item.projects.map((p) => renderProjectRow(p, true))}
      </BundleBlock>
    )
  }

  // ── /activity page mode: same data, page-shaped rendering. Placed after
  // every hook so both modes run the identical hook sequence.
  if (activityView) {
    return (
      <DesignerChrome active="activity">
        {/* Below md this column flex-fills the app frame's scroller (see
            DesignerChrome) so the Activity tab can hand the events list the
            whole screen instead of a half-height card. Desktop is unchanged
            — the max-md: utilities are inert there. */}
        <div className="mx-auto w-full max-w-3xl px-4 py-4 sm:px-6 max-md:flex max-md:min-h-0 max-md:flex-1 max-md:flex-col">
          <SegmentedControl
            value={activityTab}
            onChange={setActivityTab}
            options={[
              { value: 'activity', label: 'Activity' },
              { value: 'followups', label: 'Follow-ups' },
              { value: 'leadtimes', label: 'Lead times' },
            ]}
          />
          <div className="mt-3 max-md:flex max-md:min-h-0 max-md:flex-1 max-md:flex-col">
            {loading ? (
              <div className="flex justify-center py-16">
                <div
                  className="h-6 w-6 animate-spin rounded-full border-2 border-line motion-reduce:animate-none"
                  style={{ borderTopColor: 'var(--c-ink)' }}
                />
              </div>
            ) : (
              <>
                {activityTab === 'activity' && (
                  <LatestActivityPanel events={latestEvents} navigate={navigate} fill />
                )}
                {activityTab === 'followups' && (
                  <NudgeOutboxPanel projects={projects} onAfterSend={() => loadDashboard()} fill />
                )}
                {activityTab === 'leadtimes' && (
                  <LeadTimesChart leadTimes={leadTimes} navigate={navigate} fill />
                )}
              </>
            )}
          </div>
        </div>
      </DesignerChrome>
    )
  }

  return (
    <DesignerChrome
      active="proofs"
      search={{ value: search, onChange: setSearch }}
      activityUnseen={activityHasUnseen}
      onProfileSaved={() => {
        // Refetch dashboard rows so the designer-avatar columns on
        // every project tile pick up the new avatar/initials/colour
        // immediately rather than waiting for the next
        // visibilitychange tick (PV-2026W21-071).
        void loadDashboard()
      }}
    >
    <div className="min-h-dvh bg-canvas">
      <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">

        {loading ? (
          <div className="flex justify-center py-20">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-line motion-reduce:animate-none" style={{ borderTopColor: 'var(--c-ink)' }} />
          </div>
        ) : (
          <>
            {loadError && (
              <div
                role="alert"
                className="mb-6 flex flex-wrap items-center gap-3 rounded-lg border border-out bg-out-soft px-4 py-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-out">Couldn’t load your projects</p>
                  <p className="mt-0.5 text-[13px] text-ink-soft">
                    This list may be out of date. {loadError}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => { setLoading(true); void loadDashboard() }}
                  className="inline-flex h-[30px] max-md:min-h-[44px] flex-shrink-0 items-center rounded-[4px] border border-line bg-surface px-3 text-[13px] font-medium text-ink-soft hover:bg-canvas focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--c-focus)]"
                >
                  Try again
                </button>
              </div>
            )}
            {actionError && (
              <div
                role="alert"
                className="mb-6 flex flex-wrap items-center gap-3 rounded-lg border border-out bg-out-soft px-4 py-3"
              >
                <p className="min-w-0 flex-1 text-[13px] text-ink-soft">{actionError}</p>
                <button
                  type="button"
                  onClick={() => setActionError(null)}
                  className="inline-flex h-[30px] max-md:min-h-[44px] flex-shrink-0 items-center rounded-[4px] border border-line bg-surface px-3 text-[13px] font-medium text-ink-soft hover:bg-canvas focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--c-focus)]"
                >
                  Dismiss
                </button>
              </div>
            )}
            <AnnouncementsBanner />

            {/* Unified hero + tile panel. One bordered card spanning
                the full page width: hero header (eyebrow + greeting +
                date+count line + Saved views + New proof) at the top,
                7-tile row below, divided by a hairline. The Latest
                activity sidebar (rendered further down inside the
                2-col grid) now starts below this unified area rather
                than aligning with the hero, matching the mockup. */}
            <section className="mb-6 rounded-[14px] bg-surface border border-line overflow-hidden">
              {/* Hero header */}
              <div className="px-6 py-5 flex flex-wrap items-end justify-between gap-4 border-b border-line-soft xl:border-b-0">
                <div>
                  <div className="eyebrow">Proofs at a glance</div>
                  <h1 className="mt-1 font-display font-medium tracking-[-0.02em] text-ink leading-tight m-0" style={{ fontSize: 'clamp(22px, 3vw, 28px)' }}>
                    <HeroGreeting />
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
                <div className="flex items-center gap-2 max-md:w-full">
                  {/* New project is a desktop-weight action — starting a
                      project is rarely done from a phone, so mobile gets
                      the quiet ghost treatment instead of the full coral
                      block that used to dominate the fold on iPhone. Each
                      variant is wrapped rather than toggled via a `hidden`
                      class on the button itself — the button's own base
                      class already sets `inline-flex` at the same
                      specificity, so `hidden` on the button can lose that
                      fight depending on Tailwind's utility ordering. */}
                  <span className="hidden md:inline-flex">
                    <ButtonCoral icon={Plus} onClick={() => navigate('/proofs/new')}>
                      New project
                    </ButtonCoral>
                  </span>
                  <span className="w-full md:hidden">
                    <ButtonGhost icon={Plus} onClick={() => navigate('/proofs/new')} className="w-full h-11">
                      New project
                    </ButtonGhost>
                  </span>
                </div>
              </div>

              {/* Tile row, structured as three zones so the workflow reads as a
                  pipeline rather than ten equal peers — the Alert/Workflow/On-hold
                  grouping that previously lived only in the colour palette:
                    • Triage   — Needs attention, the cross-cutting alert, in a
                      rose-tinted box set apart on the left (not pipeline stage 0).
                    • Workflow — the five/seven stages a proof passes through,
                      Not viewed → … → To order, boxed together with internal
                      hairlines so they read left to right.
                    • Parked   — Snoozed + Dormant, off-flow states, in a plain box
                      set apart on the right (not the pipeline's finish line).
                  Each zone box carries a 2px top bracket bar tied to its legend
                  (rose for Triage, ink-dim for Workflow/Parked); sides + bottom
                  stay hairline so the label+bracket reads as the section header.
                  Only the xl layout zones; below xl the zone wrappers are
                  display:contents, so the tiles flow into the existing md 3-col
                  grid and the mobile snap-scroll strip exactly as before. */}
              <div
                ref={tilesStripRef}
                onScroll={handleTilesScroll}
                className="flex gap-2.5 overflow-x-auto px-4 pb-3 [scroll-snap-type:x_mandatory] md:gap-0 md:overflow-x-visible md:px-0 md:pb-0 md:[scroll-snap-type:none] md:grid md:grid-cols-3 xl:flex xl:items-stretch xl:gap-3 xl:px-6 xl:pt-3 xl:pb-5"
              >
                {/* Triage zone — the cross-cutting alert, set apart so it isn't
                    read as pipeline stage zero. Rose top bracket + rose legend (no
                    fill, which would mimic the tile's active filter-on wash; the
                    sides/bottom stay hairline so the red isn't all-round). */}
                <div className="contents xl:flex xl:flex-col xl:relative xl:w-[150px] xl:shrink-0">
                  <span className="eyebrow hidden xl:block" style={{ position: 'absolute', top: '-7px', left: '11px', zIndex: 1, background: 'var(--c-bg-panel)', padding: '0 6px', color: 'var(--c-out)' }}>Triage</span>
                  <div
                    className="contents xl:flex xl:flex-1 xl:overflow-hidden"
                    style={{
                      borderRadius: '10px',
                      borderWidth: '0.5px',
                      borderStyle: 'solid',
                      borderColor: 'var(--c-line)',
                      borderTopWidth: '2px',
                      borderTopColor: 'var(--c-out)',
                    }}
                  >
                    <StatTile
                      label="Needs attention"
                      help={tagHelp('tile', 'needs_attention')}
                      count={needsAttentionCount}
                      active={tileFilter === 'needs_attention'}
                      tone="rose"
                      onClick={() => toggleTile('needs_attention')}
                    />
                  </div>
                </div>
                {/* Workflow zone — the stages a proof passes through, left to
                    right. Internal hairlines split the stages; the 2px top bracket
                    bar ties the band to its legend. Awaiting payment / To order
                    only when ordering is enabled. */}
                <div className="contents xl:flex xl:flex-col xl:relative xl:flex-1 xl:min-w-0">
                  <span className="eyebrow hidden xl:block" style={{ position: 'absolute', top: '-7px', left: '11px', zIndex: 1, background: 'var(--c-bg-panel)', padding: '0 6px' }}>Workflow</span>
                  <div
                    className="contents xl:flex xl:flex-1 xl:min-w-0 xl:overflow-hidden xl:divide-x xl:divide-line"
                    style={{
                      borderRadius: '10px',
                      borderWidth: '0.5px',
                      borderStyle: 'solid',
                      borderColor: 'var(--c-line)',
                      borderTopWidth: '2px',
                      borderTopColor: 'var(--c-ink-dim)',
                    }}
                  >
                    <StatTile
                      label="Not viewed"
                      help={tagHelp('tile', 'not_viewed')}
                      count={notViewedCount}
                      active={tileFilter === 'not_viewed'}
                      tone="amber"
                      onClick={() => toggleTile('not_viewed')}
                    />
                    <StatTile
                      label="Awaiting customer"
                      help={tagHelp('tile', 'awaiting_customer')}
                      count={awaitingCustomerCount}
                      active={tileFilter === 'awaiting_customer'}
                      tone="sky"
                      onClick={() => toggleTile('awaiting_customer')}
                    />
                    <StatTile
                      label="Follow-up"
                      srLabel="In auto follow-up"
                      help={tagHelp('tile', 'in_follow_up')}
                      count={inFollowUpCount}
                      active={tileFilter === 'in_follow_up'}
                      tone="indigo"
                      onClick={() => toggleTile('in_follow_up')}
                    />
                    <StatTile
                      label="Customer responded"
                      help={tagHelp('tile', 'customer_responded')}
                      count={customerRespondedCount}
                      active={tileFilter === 'customer_responded'}
                      tone="turquoise"
                      onClick={() => toggleTile('customer_responded')}
                    />
                    <StatTile
                      label="Approved"
                      srLabel="Approved this week"
                      help={tagHelp('tile', 'approved_this_week')}
                      count={approvedThisWeekCount}
                      active={tileFilter === 'approved_this_week'}
                      tone="green"
                      onClick={() => toggleTile('approved_this_week')}
                    />
                    {/* Order-stage tiles — only when ordering is enabled. These
                        navigate to the Orders page (orders aren't in the proof
                        list), so they never set tileFilter / show as active. */}
                    {orderingOn && (
                      <>
                        <StatTile
                          label="Awaiting payment"
                          count={orderCounts?.awaitingPayment ?? 0}
                          active={false}
                          tone="gold"
                          onClick={() => navigate('/orders')}
                        />
                        <StatTile
                          label="To order"
                          count={orderCounts?.toOrder ?? 0}
                          badge={orderCounts?.invoiceProblem ?? 0}
                          badgeTitle={
                            orderCounts?.invoiceProblem
                              ? `${orderCounts.invoiceProblem} paid order${orderCounts.invoiceProblem === 1 ? '' : 's'} with a failed Xero invoice — open Orders to retry`
                              : undefined
                          }
                          active={false}
                          tone="blue"
                          onClick={() => navigate('/orders')}
                        />
                      </>
                    )}
                    {/* Flagged board shortcut — navigates to /flagged (the cards
                        aren't in the proof list), so it never sets tileFilter. */}
                    <StatTile
                      label="Flagged"
                      help="Problem projects on the Flagged board (open or monitoring). Opens the board."
                      count={flaggedOpenCount}
                      active={false}
                      tone="rose"
                      onClick={() => navigate('/flagged')}
                    />
                  </div>
                </div>
                {/* Parked zone — proofs deliberately on hold or gone cold.
                    Off-flow, so a plain box set apart on the right rather than
                    the pipeline's tail. */}
                <div className="contents xl:flex xl:flex-col xl:relative xl:w-[224px] xl:shrink-0">
                  <span className="eyebrow hidden xl:block" style={{ position: 'absolute', top: '-7px', left: '11px', zIndex: 1, background: 'var(--c-bg-panel)', padding: '0 6px' }}>Parked</span>
                  <div
                    className="contents xl:flex xl:flex-1 xl:overflow-hidden xl:divide-x xl:divide-line"
                    style={{
                      borderRadius: '10px',
                      borderWidth: '0.5px',
                      borderStyle: 'solid',
                      borderColor: 'var(--c-line)',
                      borderTopWidth: '2px',
                      borderTopColor: 'var(--c-ink-dim)',
                    }}
                  >
                    <StatTile
                      label="Snoozed"
                      help={tagHelp('tile', 'snoozed')}
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
                      help={tagHelp('tile', 'dormant')}
                      count={dormantCount}
                      active={tileFilter === 'dormant'}
                      tone="neutral"
                      onClick={() => toggleTile('dormant')}
                    />
                  </div>
                </div>
              </div>
            </section>

            {/* Hot leads to chase — the daily prompt. Full width under the
                tiles so it's the first actionable thing on the page, on every
                viewport. Admin-only "Open in Analytics" deep-link (the page is
                admin-gated); fails quiet if the RPC isn't available. */}
            {hotLeadsOn && <HotLeadsCard isAdmin={role === 'admin'} currentUserId={userId} />}

            {/* 2-column grid for the rest of the page: list card on the
                left, Latest activity sidebar on the right. Lives below
                the unified hero+tile panel so the sidebar starts under
                the tile row rather than aligning with the hero. */}
            {/* Right rail: 22rem on smaller laptops (the project list is
                already snug there; chat pills wrap to a second line), widened
                to 25rem at xl so the docked chat fits all five thread pills +
                an unread badge on one line and every rail panel breathes. */}
            <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem] xl:grid-cols-[minmax(0,1fr)_25rem]">
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
                      <div className="flex flex-wrap items-center gap-3 max-md:flex-nowrap max-md:overflow-x-auto">
                        <span className="eyebrow text-ink-mute pr-1 max-md:shrink-0">Filter</span>
                        {(CHIPS as readonly { value: ChipKey; label: string }[]).map(({ value, label }) => {
                          const isActive = chipFilter === value
                          return (
                            <button
                              key={value}
                              type="button"
                              onClick={() => handleChipChange(value)}
                              aria-pressed={isActive}
                              className={[
                                'inline-flex items-center h-[30px] px-3 rounded-full text-[12px] font-medium transition-colors max-md:shrink-0',
                                isActive
                                  ? 'bg-ink text-on-ink border border-ink'
                                  : 'border border-line bg-surface text-ink-soft hover:bg-canvas',
                              ].join(' ')}
                            >
                              {label}
                            </button>
                          )
                        })}

                        {/* Right cluster. On mobile the spacer collapses so the
                            count + Sort/Group/Abandoned controls pack into the
                            same horizontal scroll row as the chips. */}
                        <span className="hidden md:block flex-1" aria-hidden="true" />
                        <span className="md:hidden w-2 shrink-0" aria-hidden="true" />
                        <span className="text-[12px] text-ink-mute tabular-nums font-mono max-md:shrink-0">
                          {filteredProjects.length} showing
                        </span>
                        <span className="h-4 w-px bg-line max-md:shrink-0" aria-hidden="true" />
                        <SelectField
                          label="Sort"
                          className="max-md:shrink-0"
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
                          className="max-md:shrink-0"
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
                          className={`inline-flex items-center gap-1.5 rounded-[8px] border px-2.5 py-1.5 text-xs font-medium transition-colors max-md:shrink-0 ${
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
                        // Bundle siblings were already hoisted into one
                        // section (hoistBundleSections, in the sections memo);
                        // here they're gathered into one block at the topmost
                        // member's position. The section's COUNT still counts
                        // projects, so gathering rows never changes the number
                        // in the header (or any tile count — those are
                        // server-side).
                        const rowItems = buildRowItems(section.projects, bundleIndex)
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
                                  data={rowItems}
                                  overscan={400}
                                  computeItemKey={(_, item) => item.key}
                                  itemContent={(_, item) => (
                                    <div className="mb-2 last:mb-0">{renderRowItem(item)}</div>
                                  )}
                                />
                              ) : (
                                rowItems.map((item) => renderRowItem(item))
                              )}
                            </div>
                          </div>
                        )
                      })
                    )}
                  </>
                )}
              </div>

              <DashboardRail>
                {/* lg:sticky lg:top-10 used to ride here so the panel
                    locked to the viewport top while the project list
                    scrolled. Dropped in PR 30 — the project list can
                    run many pages and a static panel hovering over
                    nothing related is more distracting than useful. */}
                <LatestActivityPanel events={latestEvents} navigate={navigate} />
                {/* Follow-up automation Outbox (Phase 1). Owns its own small
                    nudge_runs / proof_nudges queries; the projects array is
                    only passed for client-side contact/company labels. */}
                <NudgeOutboxPanel projects={projects} onAfterSend={() => loadDashboard()} />
                <LeadTimesChart leadTimes={leadTimes} navigate={navigate} />
              </DashboardRail>
            </div>
          </>
        )}
      </div>
    </div>

    </DesignerChrome>
  )
}

// The dashboard's right rail. Two layouts, chosen by whether the chat is
// docked here:
//
//   • chat elsewhere (floating / closed) — a plain column that scrolls with
//     the page, exactly as the rail has always behaved.
//   • chat docked — the WHOLE rail pins to the viewport instead of just the
//     chat card. The chat sits at the top and the panels are parked in the
//     space beneath it, scrolling within the rail. Previously only the chat
//     was sticky, so the panels slid up behind it on every page scroll — an
//     overlap that needed an opaque background, a z-index and an "apron" gap
//     to look tidy, and still read as pointless motion. Pinning the rail as a
//     unit means nothing ever passes behind anything.
//
// The children are passed through untouched, so a chat message re-rendering
// this wrapper doesn't re-render the panels (same element identity).
function DashboardRail({ children }: { children: ReactNode }) {
  const { placement } = useTeamChat()
  const isLarge = useIsLargeScreen()

  if (placement !== 'docked' || !isLarge) {
    return <aside className="hidden lg:block space-y-6">{children}</aside>
  }

  // top-14 clears the condensed page header; the 4.5rem height leaves a
  // matching gap plus a little breathing room at the window bottom. The
  // panels get whatever the chat card doesn't (min-h-0 so they may shrink
  // below their content height and scroll rather than overflow the rail).
  return (
    <aside className="hidden lg:sticky lg:top-14 lg:flex lg:h-[calc(100vh-4.5rem)] flex-col gap-1">
      <DockedChat />
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto">{children}</div>
    </aside>
  )
}

// lg breakpoint (1024px) — the width at which the dashboard right rail exists.
// The dock only mounts here so it never runs hidden (which would suppress the
// unread badge while the rail is display:none below lg).
function useIsLargeScreen() {
  const [lg, setLg] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia('(min-width: 1024px)').matches : false,
  )
  useEffect(() => {
    const mql = window.matchMedia('(min-width: 1024px)')
    const onChange = () => setLg(mql.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])
  return lg
}

// The docked card's saved height (per browser). Null = the default, which is
// a share of the window (55vh) so the rail panels below always keep a usable
// slice of the pinned rail — a fixed rem height left them a sliver on a
// laptop. DOCK_RESERVE is the room held back for them: the chat can never
// grow (by default or by drag) past `100vh - DOCK_RESERVE`, which leaves the
// panels ~190px — a header plus a couple of rows, enough to read as a panel
// you can scroll rather than a sliver. It also re-caps a too-tall height
// saved back when the chat was the only pinned thing in the rail.
const DOCK_HEIGHT_KEY = 'pv:chat-dock-height'
const DOCK_MIN_H = 360
const DOCK_RESERVE = 288

function readDockHeight(): number | null {
  try {
    const raw = localStorage.getItem(DOCK_HEIGHT_KEY)
    if (!raw) return null
    const n = Number(raw)
    return Number.isFinite(n) && n >= DOCK_MIN_H ? Math.round(n) : null
  } catch {
    return null
  }
}

// The dashboard-rail chat dock (Option A). Rendered by DashboardRail, which
// pins the whole rail — so this is a plain card at the top of that pinned
// column, not a sticky element in its own right. Height is CAPPED (not
// viewport-tall) so the whole card — header, messages, composer — sits
// comfortably in view AND the rail panels below keep their share; a
// full-height panel glued to the screen bottom read as an infinite wall and
// hid the composer below the fold at page top. The grip below the card drags
// the height (persisted). Reuses the shared TeamChatPanel — same live engine
// as the header dropdown and the /chat page.
function DockedChat() {
  const navigate = useNavigate()
  const isLarge = useIsLargeScreen()
  const { placement, setPlacement } = useTeamChat()
  const [dockH, setDockH] = useState<number | null>(readDockHeight)
  const dockHRef = useRef(dockH)
  dockHRef.current = dockH

  // Drag the grip under the card to change its height. Pointer capture +
  // touch-action:none so it works by finger too; saved on release.
  function onDockResizeStart(e: ReactPointerEvent<HTMLButtonElement>) {
    e.preventDefault()
    const handle = e.currentTarget
    const card = document.getElementById('team-chat-dock')
    const startH = card ? card.getBoundingClientRect().height : dockHRef.current ?? 560
    const startY = e.clientY
    const maxH = window.innerHeight - DOCK_RESERVE
    try {
      handle.setPointerCapture(e.pointerId)
    } catch {
      /* pointer capture unsupported — the listeners below still run */
    }
    function onMove(ev: PointerEvent) {
      setDockH(Math.min(maxH, Math.max(DOCK_MIN_H, Math.round(startH + (ev.clientY - startY)))))
    }
    function onEnd() {
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onEnd)
      handle.removeEventListener('pointercancel', onEnd)
      try {
        if (dockHRef.current != null) localStorage.setItem(DOCK_HEIGHT_KEY, String(dockHRef.current))
      } catch {
        /* ignore */
      }
    }
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onEnd)
    handle.addEventListener('pointercancel', onEnd)
  }

  if (placement !== 'docked' || !isLarge) return null
  return (
    /* flex-shrink-0 so the card keeps its chosen height and the panels
       below absorb the slack instead. The grip doubles as the gap to the
       first panel. */
    <div className="flex-shrink-0">
      <div
        id="team-chat-dock"
        className="flex h-[55vh] flex-col overflow-hidden rounded-[14px] border border-line bg-surface shadow-[0_14px_28px_-18px_rgba(22,19,17,0.35)]"
        style={{
          ...(dockH != null ? { height: dockH } : null),
          maxHeight: `calc(100vh - ${DOCK_RESERVE}px)`,
        }}
      >
        <div className="flex flex-shrink-0 items-center justify-between border-b border-line-soft px-3 py-2">
          <span className="text-[13px] font-semibold text-ink">Team chat</span>
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => navigate('/chat')}
              aria-label="Open full chat page"
              title="Open full page"
              className="flex h-7 w-7 items-center justify-center rounded-full text-ink-mute transition-colors hover:bg-canvas hover:text-ink"
            >
              <Maximize2 size={15} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => setPlacement('floating')}
              aria-label="Pop chat out to a floating window"
              title="Pop out to floating window"
              className="flex h-7 w-7 items-center justify-center rounded-full text-ink-mute transition-colors hover:bg-canvas hover:text-ink"
            >
              <PictureInPicture2 size={15} aria-hidden="true" />
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1">
          <TeamChatPanel variant="docked" />
        </div>
      </div>
      <button
        type="button"
        onPointerDown={onDockResizeStart}
        aria-label="Drag to change chat height"
        title="Drag to change chat height"
        className="group flex h-5 w-full touch-none cursor-ns-resize items-center justify-center"
      >
        <span
          aria-hidden="true"
          className="h-1 w-10 rounded-full bg-line transition-colors group-hover:bg-ink-mute"
        />
      </button>
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
  className = '',
}: {
  options: Array<{ value: T; label: string }>
  value: T
  onChange: (v: T) => void
  label?: string
  className?: string
}) {
  return (
    <div className={`relative inline-flex items-center rounded-[8px] border border-line bg-surface hover:bg-canvas focus-within:border-[var(--c-brand)] focus-within:outline focus-within:outline-2 focus-within:outline-offset-[-1px] focus-within:outline-[var(--c-brand)] transition-colors ${className}`}>
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

// Segmented control for the mobile activity sheet (Activity / Follow-ups /
// Lead times). A muted track with a white selected thumb; equal-width
// segments, flex-centred labels, 34px tall.
function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T
  onChange: (v: T) => void
  options: Array<{ value: T; label: string }>
}) {
  return (
    <div className="flex h-[34px] items-center rounded-[10px] bg-line p-0.5" role="tablist">
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.value)}
            className={[
              'flex h-full flex-1 items-center justify-center rounded-[8px] text-[12px] font-medium transition-colors',
              active ? 'bg-surface text-ink' : 'text-ink-mute',
            ].join(' ')}
            style={active ? { boxShadow: '0 1px 2px rgba(22,19,17,0.08)' } : undefined}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
