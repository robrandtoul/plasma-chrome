// Dashboard grouping utilities extracted from DashboardPage.tsx so they can
// be unit-tested independently of the React component tree.

import type { ProofStatus } from './types'

export type DesignerColour = 'blue' | 'teal' | 'coral' | 'purple'

export type NeedsAttentionRule =
  | 'request_changes_no_version'
  | 'helpscout_follow_up_tag'
  | 'sent_never_viewed'
  | 'viewed_not_actioned'
  | 'approaching_dormant'
  | 'stuck_in_progress'

export interface DashboardProject {
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
  designer_avatar_url: string | null
  latest_event_at: string | null
  latest_event_type: 'approve' | 'request_changes' | 'view' | 'designer_override_approve' | null
  latest_event_actor: string | null
  // Latest event excluding synthetic 'view' rows (migration 000198). Used by
  // the Changes-requested tile so a customer re-opening the proof after a
  // change request doesn't mask the outstanding request.
  latest_non_view_event_at: string | null
  latest_non_view_event_type: 'approve' | 'request_changes' | 'designer_override_approve' | null
  current_version_viewed_at: string | null
  rule_code: NeedsAttentionRule | null
  rule_meta: { days?: number } | null
  snooze_rule_code: NeedsAttentionRule | null
  snoozed_until: string | null
  snooze_note: string | null
  snoozed_by_name: string | null
  snoozed_by_initials: string | null
  snoozed_by_colour: DesignerColour | null
  // Help Scout reply activity (000208) — stamped by the helpscout-webhook edge
  // function. A recent reply suppresses the chase needs-attention rules; the
  // dashboard surfaces it as a "Last contact / Customer replied Nd ago" chip.
  helpscout_last_reply_at: string | null
  helpscout_last_customer_reply_at: string | null
}

export type SectionKind = 'pinned' | 'team' | 'snoozed' | 'time' | 'company'

export interface ProjectSection {
  key: string
  title: string
  kind: SectionKind
  projects: DashboardProject[]
}

// ── Date helpers ──────────────────────────────────────────────────────────────

export function startOfToday(): Date {
  const n = new Date()
  return new Date(n.getFullYear(), n.getMonth(), n.getDate())
}

export function isSameDay(iso: string): boolean {
  const t = new Date(iso)
  const s = startOfToday()
  return t.getFullYear() === s.getFullYear()
      && t.getMonth()    === s.getMonth()
      && t.getDate()     === s.getDate()
}

export function isThisWeek(iso: string): boolean {
  const t = new Date(iso)
  const s = startOfToday()
  const diffDays = Math.floor(
    (s.getTime() - new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime()) / 86_400_000
  )
  return diffDays > 0 && diffDays < 7
}

// ── Snooze state helpers ──────────────────────────────────────────────────────
//
// public_dashboard_projects (000186) carries snoozed_until forward for 24
// hours after a snooze expires so the dashboard can bucket recently-awakened
// proofs back into Today. The frontend therefore can't read
// `snoozed_until != null` as "this proof is currently snoozed" any more —
// it has to also check the timestamp is in the future. Wrapping that check
// in a helper keeps the same predicate consistent across the tile counts,
// the click-through filters, and the Snoozed-section grouping.

/**
 * Returns true when the proof has a snooze row whose snoozed_until is still
 * in the future. False for recently-awakened proofs (snoozed_until in the
 * 24-hour grace window) and for proofs that were never snoozed.
 */
export function isCurrentlySnoozed(p: DashboardProject): boolean {
  if (!p.snoozed_until) return false
  return new Date(p.snoozed_until).getTime() > Date.now()
}

/**
 * Returns true when the proof's snooze expired within the last 24 hours.
 * These proofs are bucketed in Today regardless of last_activity_at, since
 * the designer hasn't had a chance to act on them since they woke up.
 */
export function recentlyAwakened(p: DashboardProject): boolean {
  if (!p.snoozed_until) return false
  const expiry = new Date(p.snoozed_until).getTime()
  const now    = Date.now()
  return expiry <= now && expiry >= now - 24 * 60 * 60 * 1000
}

// ── Status bucket (single source of truth) ────────────────────────────────────
//
// The dashboard headline tiles slice proofs into workflow buckets (Needs
// attention / Not viewed / Awaiting customer / Changes requested / Snoozed /
// Dormant / Approved). The per-row status pill and the row's coloured
// left-edge cap historically used a *different* taxonomy — the four raw DB
// statuses — so a row's pill could read "In review" while no headline tile
// carried that word. proofBucket() collapses all three onto one vocabulary:
// every proof resolves to exactly one bucket, and the pill, the cap, and the
// matching tile all read their label + colour from here.
//
// Precedence mirrors the tile predicates in dashboard_tile_counts()
// (migration 000202) and the established left-cap order:
//   snoozed > needs-attention > approved > dormant > abandoned >
//   changes-requested > awaiting-customer > not-viewed
// The terminal statuses (approved/dormant/abandoned) win over the in_progress
// workflow sub-states, matching the left cap; needs-attention and snooze sit
// above everything, matching how the tiles exclude those proofs from the
// workflow counts.

export type ProofBucket =
  | 'needs_attention'
  | 'approved'
  | 'dormant'
  | 'abandoned'
  | 'changes_requested'
  | 'awaiting_customer'
  | 'not_viewed'
  | 'snoozed'

export interface BucketDisplay {
  bucket: ProofBucket
  label: string
  /** CSS colour (design-system token var or hex) shared by pill + cap + tile. */
  colour: string
}

// The fields proofBucket() needs. DashboardProject is a superset, so a full
// dashboard row satisfies this directly; the proof detail page fetches just
// these columns from public_dashboard_projects to render the same pill.
export interface BucketInput {
  status: ProofStatus
  current_version_id: string | null
  current_version_viewed_at: string | null
  latest_non_view_event_type: 'approve' | 'request_changes' | 'designer_override_approve' | null
  latest_non_view_event_at: string | null
  version_created_at: string | null
  rule_code: NeedsAttentionRule | null
  rule_meta: { days?: number } | null
  snoozed_until: string | null
}

// Label + colour per bucket. Colours are the same tokens/hexes the headline
// tiles use (TILE_COLOUR in DashboardPage), so a row's pill and cap always
// match the tile that counts it. Dormant uses the neutral ink-mute token (the
// Dormant tile's tone); Abandoned — which has no tile — takes the quieter
// ink-dim so the two greys stay distinguishable.
const BUCKET_META: Record<ProofBucket, { label: string; colour: string }> = {
  needs_attention:   { label: 'Needs attention',   colour: 'var(--c-out)' },
  changes_requested: { label: 'Changes requested', colour: '#0d9488' },
  awaiting_customer: { label: 'Awaiting customer', colour: 'var(--c-allocated)' },
  not_viewed:        { label: 'Not viewed',        colour: 'var(--c-low)' },
  snoozed:           { label: 'Snoozed',           colour: '#7c3aed' },
  approved:          { label: 'Approved',          colour: 'var(--c-in-stock)' },
  dormant:           { label: 'Dormant',           colour: 'var(--c-ink-mute)' },
  abandoned:         { label: 'Abandoned',         colour: 'var(--c-ink-dim)' },
}

// Mirrors the changes_requested tile predicate (dashboard_tile_counts,
// 000202): the latest non-view customer event is a change request raised
// after the current version was uploaded (so a later page-view doesn't mask
// it, and a request answered by a fresh version doesn't linger).
function isChangesRequested(p: BucketInput): boolean {
  return (
    p.latest_non_view_event_type === 'request_changes' &&
    !!p.latest_non_view_event_at &&
    !!p.version_created_at &&
    new Date(p.latest_non_view_event_at).getTime() > new Date(p.version_created_at).getTime()
  )
}

/**
 * Resolve a proof to the single workflow bucket its pill, left cap, and
 * matching headline tile all share. See the precedence note above.
 */
export function proofBucket(p: BucketInput): BucketDisplay {
  let bucket: ProofBucket
  if (p.snoozed_until && new Date(p.snoozed_until).getTime() > Date.now()) {
    bucket = 'snoozed'
  } else if (p.rule_code != null) {
    bucket = 'needs_attention'
  } else if (p.status === 'approved') {
    bucket = 'approved'
  } else if (p.status === 'dormant') {
    bucket = 'dormant'
  } else if (p.status === 'abandoned') {
    bucket = 'abandoned'
  } else if (isChangesRequested(p)) {
    bucket = 'changes_requested'
  } else if (p.current_version_id && p.current_version_viewed_at) {
    bucket = 'awaiting_customer'
  } else {
    bucket = 'not_viewed'
  }
  return { bucket, ...BUCKET_META[bucket] }
}

// ── Help Scout activity chip ──────────────────────────────────────────────────

export interface HelpscoutActivity {
  kind: 'staff' | 'customer'
  at: string
}

/**
 * The most recent Help Scout reply (staff or customer) on the proof's
 * conversation if it landed within `withinDays` days, else null. Powers the
 * dashboard's "Last contact / Customer replied Nd ago" chip — and mirrors why the
 * chase rules are suppressed (the default 3 days matches the rule guard's
 * default grace window).
 */
export function recentHelpscoutActivity(p: DashboardProject, withinDays = 3): HelpscoutActivity | null {
  const candidates: HelpscoutActivity[] = []
  if (p.helpscout_last_reply_at) candidates.push({ kind: 'staff', at: p.helpscout_last_reply_at })
  if (p.helpscout_last_customer_reply_at) candidates.push({ kind: 'customer', at: p.helpscout_last_customer_reply_at })
  if (candidates.length === 0) return null
  const newest = candidates.sort((a, b) => b.at.localeCompare(a.at))[0]
  const cutoff = Date.now() - withinDays * 86_400_000
  return new Date(newest.at).getTime() >= cutoff ? newest : null
}

// ── Grouping functions ────────────────────────────────────────────────────────

export function groupByTime(projects: DashboardProject[]): ProjectSection[] {
  const today: DashboardProject[] = []
  const week:  DashboardProject[] = []
  const older: DashboardProject[] = []
  for (const p of projects) {
    const ts = p.last_activity_at
    if (!ts) {
      older.push(p)
      continue
    }
    if (recentlyAwakened(p) || isSameDay(ts)) today.push(p)
    else if (isThisWeek(ts))                  week.push(p)
    else                                       older.push(p)
  }
  const out: ProjectSection[] = []
  if (today.length) out.push({ key: 'today', title: 'Today',     kind: 'time', projects: today })
  if (week.length)  out.push({ key: 'week',  title: 'This week', kind: 'time', projects: week  })
  if (older.length) out.push({ key: 'older', title: 'Older',     kind: 'time', projects: older })
  return out
}

export function groupByCompany(projects: DashboardProject[]): ProjectSection[] {
  const map = new Map<string, ProjectSection>()
  for (const p of projects) {
    const key   = p.company_id ?? '__individual__'
    const title = p.company_name ?? 'No company'
    if (!map.has(key)) map.set(key, { key, title, kind: 'company', projects: [] })
    map.get(key)!.projects.push(p)
  }
  const sections   = [...map.values()]
  const individual = sections.find((s) => s.key === '__individual__')
  const named      = sections.filter((s) => s.key !== '__individual__')
  named.sort((a, b) => a.title.localeCompare(b.title, 'en', { sensitivity: 'base' }))
  return individual ? [...named, individual] : named
}

export function buildSnoozedSection(projects: DashboardProject[]): ProjectSection[] {
  const snoozed = projects.filter(isCurrentlySnoozed)
  if (!snoozed.length) return []
  return [{ key: '__snoozed__', title: 'Snoozed', kind: 'snoozed', projects: snoozed }]
}
