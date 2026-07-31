// Dashboard grouping utilities extracted from DashboardPage.tsx so they can
// be unit-tested independently of the React component tree.

import type { ProofStatus } from './types'
import type { DesignerColour } from './designerColours'

// Re-exported so the many existing `from '../lib/dashboardGrouping'` imports
// keep working; the palette itself lives in lib/designerColours.
export type { DesignerColour }

export type NeedsAttentionRule =
  | 'request_changes_no_version'
  | 'helpscout_follow_up_tag'
  | 'sent_never_viewed'
  | 'viewed_not_actioned'
  | 'approaching_dormant'
  | 'stuck_in_progress'
  | 'approved_earlier_version'
  | 'nudges_exhausted'
  | 'approved_no_order'
  // 000373: the customer asked for more of these cards from /p/:id and no
  // reorder project has been raised from it yet.
  | 'reorder_requested'

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
  // 000373: how many the customer asked for, when they said. Optional — the
  // quantity field on the reorder panel is optional, so plenty of requests
  // arrive without one.
  quantity?: number | null
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
  // 000279: the current version has at least one slot (recipient / layout /
  // shared section) still in `changes_requested`. The per-slot truth behind the
  // Changes-requested bucket — robust to a later approve on a *different* slot,
  // which the single latest_non_view_event_type signal would let mask the
  // outstanding request (the bug on multi-slot Set collections + multi-recipient
  // proofs). Self-clears when a new version resets the changed slot.
  has_open_change_request: boolean
  // 000307: furthest-along payable order state for the proof, so the row can show
  // the ordering journey past Approved. 'ordered' = an order is paid/fulfilled;
  // 'awaiting_payment' = a pay link is out and unpaid; null = no live payable
  // order (draft/expired/cancelled/revision don't count). Non-null only on
  // approved proofs, and only read by proofBucket on approved proofs.
  order_status: 'ordered' | 'awaiting_payment' | null
  // 000373. Non-null only on a project raised FROM a customer reorder request
  // — never on a designer Duplicate, which is what lets the row say "the
  // customer asked for this" rather than merely "this looks like a copy".
  //
  // Deliberately NOT part of BucketInput: a reorder is provenance, not a
  // workflow stage, so it must sit ALONGSIDE the Approved / Ordered pill
  // rather than replacing it and hiding the ordering journey the row exists
  // to show.
  reorder_of_proof_id: string | null
  // The stamp on the SOURCE project. Survives after the reorder is raised, so
  // the row can still say a customer asked once the rule has cleared.
  reorder_requested_at: string | null
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
    | 'pay_link_opened'
    | 'pay_link_sent'
    | 'order_reminder_sent'
    | 'declined'
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

// A decline-feedback row (proof_feedback, 000279). Like the reply rows above,
// it's bridged into the Latest-activity feed shape; proof display info is looked
// up from the loaded projects by proof_id. The reason itself shows on the proof
// detail timeline; here it reads as a generic "declined" cue that links through.
export interface ProofFeedbackFeedRow {
  id: string
  proof_id: string
  reason_code: string
  actor_name: string | null
  created_at: string
}

export function proofFeedbackEvents(
  rows: ProofFeedbackFeedRow[],
  projects: DashboardProject[],
): DashboardLatestEvent[] {
  const byId = new Map(projects.map((p) => [p.proof_id, p]))
  const cutoff = Date.now() - HELPSCOUT_REPLY_WINDOW_MS
  const out: DashboardLatestEvent[] = []
  for (const r of rows) {
    if (new Date(r.created_at).getTime() < cutoff) continue
    const p = byId.get(r.proof_id)
    out.push({
      id: `feedback-${r.id}`,
      created_at: r.created_at,
      event_type: 'declined',
      actor_name: r.actor_name || p?.contact_name || p?.company_name || 'Customer',
      recipient_name: null,
      helpscout_thread_id: null,
      proof_id: r.proof_id,
      version_number: p?.current_version_number ?? 0,
      contact_name: p?.contact_name ?? null,
      company_name: p?.company_name ?? null,
    })
  }
  return out
}

// A pay-link open is a timestamp on the order (record_order_pay_link_opened,
// 000262), never a stored event — so, like the *_reply rows above, it's bridged
// into the Latest-activity feed shape here. Proof display info is looked up from
// the loaded projects so the row reads "Acme opened the pay link". Same 30-day
// window + the feed's 20-row cap bound it.
export interface PayLinkOpenRow {
  id: string
  proof_id: string
  pay_link_opened_at: string | null
}
export function payLinkOpenEvents(opens: PayLinkOpenRow[], projects: DashboardProject[]): DashboardLatestEvent[] {
  const cutoff = Date.now() - HELPSCOUT_REPLY_WINDOW_MS
  const byProof = new Map(projects.map((p) => [p.proof_id, p]))
  const out: DashboardLatestEvent[] = []
  for (const o of opens) {
    if (!o.pay_link_opened_at || new Date(o.pay_link_opened_at).getTime() < cutoff) continue
    const p = byProof.get(o.proof_id)
    out.push({
      id: `paylink-${o.id}`,
      created_at: o.pay_link_opened_at,
      event_type: 'pay_link_opened',
      actor_name: p?.contact_name ?? p?.company_name ?? 'Customer',
      recipient_name: null,
      helpscout_thread_id: null,
      proof_id: o.proof_id,
      version_number: p?.current_version_number ?? 0,
      contact_name: p?.contact_name ?? null,
      company_name: p?.company_name ?? null,
    })
  }
  return out
}

// A successful order pay-link SEND (orders.sent_at, stamped by create-order when
// it posts the pay link). Like the open/reply rows, it's a timestamp bridged into
// the feed here. Offline orders send no link, so they're skipped. Same 30-day window.
export interface PayLinkSentRow {
  id: string
  proof_id: string
  sent_at: string | null
  payment_method: string | null
}
export function payLinkSentEvents(sents: PayLinkSentRow[], projects: DashboardProject[]): DashboardLatestEvent[] {
  const cutoff = Date.now() - HELPSCOUT_REPLY_WINDOW_MS
  const byProof = new Map(projects.map((p) => [p.proof_id, p]))
  const out: DashboardLatestEvent[] = []
  for (const o of sents) {
    if (o.payment_method === 'offline') continue
    if (!o.sent_at || new Date(o.sent_at).getTime() < cutoff) continue
    const p = byProof.get(o.proof_id)
    out.push({
      id: `paylink-sent-${o.id}`,
      created_at: o.sent_at,
      event_type: 'pay_link_sent',
      actor_name: p?.contact_name ?? p?.company_name ?? 'Customer',
      recipient_name: null,
      helpscout_thread_id: null,
      proof_id: o.proof_id,
      version_number: p?.current_version_number ?? 0,
      contact_name: p?.contact_name ?? null,
      company_name: p?.company_name ?? null,
    })
  }
  return out
}

// A sent unpaid-order reminder (order_nudges, 000238 — the automated chase the
// send-order-reminders edge function posts on the Help Scout thread). Like the
// pay-link rows above it's a timestamp bridged into the feed; the reminder lives
// on the order, so its proof_id is resolved from the embedded parent order at
// fetch time. Only real sends reach here — the fetch filters state = 'sent', so
// dry-run rows (the current pre-go-live state) never appear. Same 30-day window
// + the feed's 20-row cap.
export interface OrderReminderRow {
  id: string
  proof_id: string
  created_at: string | null
}
export function orderReminderEvents(reminders: OrderReminderRow[], projects: DashboardProject[]): DashboardLatestEvent[] {
  const cutoff = Date.now() - HELPSCOUT_REPLY_WINDOW_MS
  const byProof = new Map(projects.map((p) => [p.proof_id, p]))
  const out: DashboardLatestEvent[] = []
  for (const r of reminders) {
    if (!r.created_at || new Date(r.created_at).getTime() < cutoff) continue
    const p = byProof.get(r.proof_id)
    out.push({
      id: `order-reminder-${r.id}`,
      created_at: r.created_at,
      event_type: 'order_reminder_sent',
      // Outbound like pay_link_sent: the customer is the recipient, so they
      // lead the row ("Acme was sent a payment reminder"), never "You".
      actor_name: p?.contact_name ?? p?.company_name ?? 'Customer',
      recipient_name: null,
      helpscout_thread_id: null,
      proof_id: r.proof_id,
      version_number: p?.current_version_number ?? 0,
      contact_name: p?.contact_name ?? null,
      company_name: p?.company_name ?? null,
    })
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
//   snoozed > needs-attention > approved* > dormant > abandoned >
//   changes-requested > customer-replied > awaiting-customer > not-viewed
// *the approved slot now resolves to Ordered / Awaiting payment / Approved by
// the proof's furthest-along payable order state (order_status, 000307), so the
// row shows the ordering journey past approval; the tiles are unaffected (they
// key off the raw proof status, which stays 'approved' through the order life).
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
  | 'awaiting_payment'
  | 'ordered'
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
  // 000279: an outstanding change request on any slot of the current version.
  has_open_change_request: boolean
  // 000307: furthest-along payable order state — only read on approved proofs.
  order_status: 'ordered' | 'awaiting_payment' | null
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
  // The two post-approval ordering states (000307), shown once a pay link is out
  // (Awaiting payment) or the order is paid (Ordered). Awaiting payment takes the
  // amber "we're waiting on the customer" tone; Ordered shares Approved's
  // happy-path green and is told apart by its label — the same shared-hue,
  // different-label choice as changes_requested vs customer_replied above.
  awaiting_payment:  { label: 'Awaiting payment',  colour: 'var(--c-low)' },
  ordered:           { label: 'Ordered',           colour: 'var(--c-in-stock)' },
  dormant:           { label: 'Dormant',           colour: 'var(--c-ink-mute)' },
  abandoned:         { label: 'Abandoned',         colour: 'var(--c-ink-dim)' },
}

// Mirrors the change-request half of the customer_responded tile predicate
// (dashboard_tile_counts, 000213 + 000279). Primary signal is the per-slot
// truth `has_open_change_request` (any slot of the current version still in
// `changes_requested`) — robust to a later approve on a *different* slot, which
// the latest-event signal alone would let mask the outstanding request on a
// multi-slot proof. The old latest-event test is kept as an OR fallback so no
// proof that already counted as Changes-requested loses the label. Exported so
// the dashboard click-through filter reuses the exact same test, keeping the
// tile and the list in lockstep with the SQL.
export function isChangesRequested(p: BucketInput): boolean {
  if (p.has_open_change_request) return true
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
    // The approved proof continues down the ordering path: once a pay link is
    // out it reads Awaiting payment, and once the order is paid it reads
    // Ordered. Falls back to plain Approved when there's no live payable order
    // (order_status null). Kept under needs_attention/snoozed, matching the left
    // cap and how those still take precedence on an approved proof.
    bucket = p.order_status === 'ordered' ? 'ordered'
      : p.order_status === 'awaiting_payment' ? 'awaiting_payment'
      : 'approved'
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
// The dashboard's "most recent activity" is the later of two things: the last
// customer event (`latest_event_at` — page views, approvals, change requests;
// includes the latest customer view of the day since migration 000242) and the
// last version we sent (`version_created_at`). Sending a new version is the
// single most significant designer action, but it never writes a
// `dashboard_latest_events` row, so reading `latest_event_at` alone left a
// just-sent proof filed under its last *customer* event — dropping it out of
// Today until the customer happened to reopen it. That's what hid the freshly
// sent Yanko v4: sent today, but the last customer event was three days back, so
// it sat in "This week". Taking the max of the two surfaces a freshly-sent proof
// in Today straight away. Falls back to `last_activity_at` only when a proof has
// neither (a brand-new proof with no current version).
//
// The Activity sort and the Today / This week / Older grouping MUST read this
// same field, or a proof can sort to the top of the list yet be filed under a
// lower time bucket (the bug that buried Willis). Keeping the key in one helper
// guarantees the sort order and the section headers never drift.

export function activityTimestamp(
  p: Pick<DashboardProject, 'latest_event_at' | 'version_created_at' | 'last_activity_at'>,
): string | null {
  // Both fields are PostgREST timestamptz strings in the same (+00) offset, so
  // localeCompare orders them correctly — the same string comparison the
  // Activity sort already uses. Pick the later of the customer-event clock and
  // the send; fall back to last_activity_at only when neither is present.
  const candidates = [p.latest_event_at, p.version_created_at].filter(Boolean) as string[]
  if (candidates.length === 0) return p.last_activity_at ?? null
  return candidates.reduce((a, b) => (a.localeCompare(b) >= 0 ? a : b))
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
