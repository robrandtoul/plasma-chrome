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
  | 'approved_earlier_version'
  | 'nudges_exhausted'

// rule_meta from proofs_needing_attention(). Threshold rules carry `days`;
// approved_earlier_version carries `version`; nudges_exhausted (000221)
// carries the underlying chase rule, the reminder count, and the
// no-contact-ever deliverability flag. `others` (000221) lists every other
// rule that also fired and survived the snooze/grace guards — the engine
// still emits one chip, but secondary signals stay visible in the popover.
export interface NeedsAttentionMeta {
  days?: number
  version?: number
  rule?: string
  sent?: number
  no_contact?: boolean
  others?: string[]
}

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
  rule_meta: NeedsAttentionMeta | null
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
  // Automated follow-up state (000246). Non-null follow_up_rule_code means the
  // automation is actively chasing this proof (a reminder is sent, the cap
  // isn't spent, the rule is in auto mode). The count fields drive the
  // "Reminder N of M" row label.
  follow_up_rule_code: 'sent_never_viewed' | 'viewed_not_actioned' | null
  follow_up_sent_count: number | null
  follow_up_max_nudges: number | null
  follow_up_last_sent_at: string | null
}

export type SectionKind = 'pinned' | 'team' | 'snoozed' | 'time' | 'company'

export interface ProjectSection {
  key: string
  title: string
  kind: SectionKind
  projects: DashboardProject[]
}

// One row in the dashboard's "Latest activity" feed. The first four event types
// come straight from the dashboard_latest_events view (customer page-views,
// approvals, change requests, designer overrides). The two `*_reply` types are
// synthesised client-side from the proof's Help Scout reply timestamps (see
// helpscoutReplyEvents) — an email reply is only a timestamp on the proof, never
// a stored event, so it has to be bridged into the feed shape here.
export interface DashboardLatestEvent {
  id: string
  created_at: string
  event_type:
    | 'approve'
    | 'request_changes'
    | 'view'
    | 'designer_override_approve'
    | 'customer_reply'
    | 'staff_reply'
  actor_name: string
  recipient_name: string | null
  helpscout_thread_id: string | null
  proof_id: string
  version_number: number
  contact_name: string | null
  company_name: string | null
}

// Only surface email replies from the last 30 days in the Latest activity feed.
// The feed's final sort-by-time + 20-row cap is the real bound; this window just
// stops a months-old reply (still the proof's latest) sitting near the top when
// the working set is quiet.
const HELPSCOUT_REPLY_WINDOW_MS = 30 * 86_400_000

/**
 * Synthesise Latest-activity feed rows from each proof's Help Scout reply
 * timestamps (stamped by the helpscout-webhook edge function, 000208). A
 * customer email reply and a staff reply are timestamps on the proof, not stored
 * events, so they never appear in dashboard_latest_events — this bridges them
 * into the same feed shape. The caller merges these with the real events, sorts
 * by created_at, and caps the list.
 *
 * Staff replies are attributed generically ("You") — the webhook records that an
 * agent reply happened, not which teammate sent it.
 */
export function helpscoutReplyEvents(projects: DashboardProject[]): DashboardLatestEvent[] {
  const cutoff = Date.now() - HELPSCOUT_REPLY_WINDOW_MS
  const out: DashboardLatestEvent[] = []
  for (const p of projects) {
    const base = {
      recipient_name: null,
      helpscout_thread_id: null,
      proof_id: p.proof_id,
      version_number: p.current_version_number ?? 0,
      contact_name: p.contact_name,
      company_name: p.company_name,
    }
    const customerAt = p.helpscout_last_customer_reply_at
    if (customerAt && new Date(customerAt).getTime() >= cutoff) {
      out.push({
        ...base,
        id: `hs-customer-${p.proof_id}`,
        created_at: customerAt,
        event_type: 'customer_reply',
        actor_name: p.contact_name ?? p.company_name ?? 'Customer',
      })
    }
    const staffAt = p.helpscout_last_reply_at
    if (staffAt && new Date(staffAt).getTime() >= cutoff) {
      out.push({
        ...base,
        id: `hs-staff-${p.proof_id}`,
        created_at: staffAt,
        event_type: 'staff_reply',
        actor_name: 'You',
      })
    }
  }
  return out
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
// (migration 000213) and the established left-cap order:
//   snoozed > needs-attention > approved > dormant > abandoned >
//   changes-requested > customer-replied > awaiting-customer > not-viewed
// changes-requested and customer-replied are the two "customer responded"
// sub-states (sidebar vs email) that share the one headline tile; the
// sidebar request ranks higher as the more specific signal.
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
  | 'customer_replied'
  | 'in_follow_up'
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
  rule_meta: NeedsAttentionMeta | null
  snoozed_until: string | null
  // Help Scout reply activity (000208) — used by the customer_replied
  // bucket to detect a customer who responded by email rather than via
  // the in-app sidebar.
  helpscout_last_reply_at: string | null
  helpscout_last_customer_reply_at: string | null
  // 000246: non-null when the automation is actively chasing this proof.
  follow_up_rule_code: 'sent_never_viewed' | 'viewed_not_actioned' | null
}

// Label + colour per bucket. Colours are the same tokens/hexes the headline
// tiles use (TILE_COLOUR in DashboardPage), so a row's pill and cap always
// match the tile that counts it. Dormant uses the neutral ink-mute token (the
// Dormant tile's tone); Abandoned — which has no tile — takes the quieter
// ink-dim so the two greys stay distinguishable.
// changes_requested and customer_replied share the teal hue: both feed the
// single "Customer responded" headline tile (TILE_COLOUR.turquoise), so they
// stay in the same colour family. They differ by label only — "Changes
// requested" (sidebar; owes a new version) vs "Replied by email" (Help Scout
// reply; go read the thread) — which is the distinction the designer acts on.
const BUCKET_META: Record<ProofBucket, { label: string; colour: string }> = {
  needs_attention:   { label: 'Needs attention',   colour: 'var(--c-out)' },
  changes_requested: { label: 'Changes requested', colour: 'var(--c-responded)' },
  customer_replied:  { label: 'Replied by email',  colour: 'var(--c-responded)' },
  in_follow_up:      { label: 'In auto follow-up', colour: '#6366f1' },
  awaiting_customer: { label: 'Awaiting customer', colour: 'var(--c-allocated)' },
  not_viewed:        { label: 'Not viewed',        colour: 'var(--c-low)' },
  snoozed:           { label: 'Snoozed',           colour: '#7c3aed' },
  approved:          { label: 'Approved',          colour: 'var(--c-in-stock)' },
  dormant:           { label: 'Dormant',           colour: 'var(--c-ink-mute)' },
  abandoned:         { label: 'Abandoned',         colour: 'var(--c-ink-dim)' },
}

// Mirrors the change-request half of the customer_responded tile predicate
// (dashboard_tile_counts, 000213): the latest non-view customer event is a
// change request raised after the current version was uploaded (so a later
// page-view doesn't mask it, and a request answered by a fresh version
// doesn't linger). Exported so the dashboard click-through filter reuses the
// exact same test, keeping the tile and the list in lockstep.
export function isChangesRequested(p: BucketInput): boolean {
  return (
    p.latest_non_view_event_type === 'request_changes' &&
    !!p.latest_non_view_event_at &&
    !!p.version_created_at &&
    new Date(p.latest_non_view_event_at).getTime() > new Date(p.version_created_at).getTime()
  )
}

// Mirrors the "replied by email" half of the customer_responded tile predicate
// (dashboard_tile_counts, 000213): the customer's last Help Scout reply is
// newer than our last reply (so a thread we've answered doesn't count) AND
// newer than the current version's upload (so a reply already answered by a
// fresh version doesn't linger). A never-replied-to thread still counts (no
// staff timestamp to beat); a null version date can't gate it out. This is the
// email-response path — the customer responded on the conversation rather than
// via the in-app sidebar.
export function isCustomerReplied(p: BucketInput): boolean {
  if (!p.helpscout_last_customer_reply_at) return false
  const cust = new Date(p.helpscout_last_customer_reply_at).getTime()
  if (p.helpscout_last_reply_at && cust <= new Date(p.helpscout_last_reply_at).getTime()) {
    return false
  }
  if (p.version_created_at && cust <= new Date(p.version_created_at).getTime()) {
    return false
  }
  return true
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
  } else if (isCustomerReplied(p)) {
    // Below changes_requested: a structured sidebar request is the more
    // specific signal, so it wins when both apply (avoids double labelling).
    bucket = 'customer_replied'
  } else if (p.follow_up_rule_code != null) {
    // 000246: the automation is actively chasing this proof. Below the
    // customer-response buckets (a reply needs a human) but above the passive
    // awaiting/not-viewed states, so a chased proof reads as "we're on it"
    // rather than sitting silently in Awaiting customer / Not viewed.
    bucket = 'in_follow_up'
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

// ── Activity clock (single source of truth for sort + grouping) ───────────────
//
// The dashboard's "most recent activity" is `latest_event_at` (the latest
// proof event — including the latest customer view of the day, since migration
// 000242), falling back to `last_activity_at` only for proofs that have no
// events at all. The Activity sort and the Today / This week / Older grouping
// MUST read this same field, or a proof can sort to the top of the list yet be
// filed under a lower time bucket (the bug that buried Willis). Keeping the key
// in one helper guarantees the sort order and the section headers never drift.

export function activityTimestamp(
  p: Pick<DashboardProject, 'latest_event_at' | 'last_activity_at'>,
): string | null {
  return p.latest_event_at ?? p.last_activity_at ?? null
}

// ── Grouping functions ────────────────────────────────────────────────────────

export function groupByTime(projects: DashboardProject[]): ProjectSection[] {
  const today: DashboardProject[] = []
  const week:  DashboardProject[] = []
  const older: DashboardProject[] = []
  for (const p of projects) {
    const ts = activityTimestamp(p)
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
