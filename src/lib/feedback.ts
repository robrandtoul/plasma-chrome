// Shared types + display metadata for the staff feedback board.
// Kept in lockstep with the CHECK constraints on proofs.feedback_items
// (migration 000271): if you add a status or type here, widen the DB
// constraint in a migration too.

import type { PillColour } from '../design'

export const FEEDBACK_BUCKET = 'feedback-attachments'

export type FeedbackType = 'bug' | 'idea' | 'improvement'
export type FeedbackPriority = 'low' | 'medium' | 'high'
export type FeedbackStatus =
  | 'new'
  | 'under_review'
  | 'planned'
  | 'in_progress'
  | 'done'
  | 'wont_do'

// The row shape as read from proofs.feedback_items. Submitter display fields
// are denormalised on the row (profiles is self-read-only under RLS).
export interface FeedbackItem {
  id: string
  created_by: string | null
  created_by_name: string | null
  created_by_initials: string | null
  created_by_colour: string | null
  type: FeedbackType
  priority: FeedbackPriority
  title: string
  body: string | null
  area: string | null
  status: FeedbackStatus
  admin_note: string | null
  // The "what I did & how it works" completion explanation, written when an
  // item is resolved (done/wont_do) and surfaced prominently to the team.
  // Distinct from admin_note (the lightweight running triage note). See 000286.
  resolution_note: string | null
  attachment_paths: string[]
  status_changed_at: string | null
  status_changed_by: string | null
  status_changed_by_name: string | null
  created_at: string
  updated_at: string
}

// Ordered for the filter bar + any grouped view. label is the human form;
// colour maps onto the design system's Pill palette.
export const FEEDBACK_STATUSES: {
  value: FeedbackStatus
  label: string
  colour: PillColour
}[] = [
  { value: 'new', label: 'New', colour: 'critical' },
  { value: 'under_review', label: 'Under review', colour: 'neutral' },
  { value: 'planned', label: 'Planned', colour: 'allocated' },
  { value: 'in_progress', label: 'In progress', colour: 'low' },
  { value: 'done', label: 'Done', colour: 'in-stock' },
  { value: 'wont_do', label: "Won't do", colour: 'mute' },
]

export const FEEDBACK_STATUS_META: Record<
  FeedbackStatus,
  { label: string; colour: PillColour }
> = Object.fromEntries(
  FEEDBACK_STATUSES.map((s) => [s.value, { label: s.label, colour: s.colour }]),
) as Record<FeedbackStatus, { label: string; colour: PillColour }>

export const FEEDBACK_TYPES: {
  value: FeedbackType
  label: string
  colour: PillColour
}[] = [
  { value: 'bug', label: 'Bug', colour: 'out' },
  { value: 'idea', label: 'Idea', colour: 'allocated' },
  { value: 'improvement', label: 'Improvement', colour: 'in-stock' },
]

export const FEEDBACK_TYPE_META: Record<
  FeedbackType,
  { label: string; colour: PillColour }
> = Object.fromEntries(
  FEEDBACK_TYPES.map((t) => [t.value, { label: t.label, colour: t.colour }]),
) as Record<FeedbackType, { label: string; colour: PillColour }>

// Priority. Submitters suggest one when posting (default medium); admins can
// override it during triage. Ordered low → high for the filter bar.
export const FEEDBACK_PRIORITIES: {
  value: FeedbackPriority
  label: string
  colour: PillColour
}[] = [
  { value: 'low', label: 'Low', colour: 'neutral' },
  { value: 'medium', label: 'Medium', colour: 'low' },
  { value: 'high', label: 'High', colour: 'out' },
]

export const FEEDBACK_PRIORITY_META: Record<
  FeedbackPriority,
  { label: string; colour: PillColour }
> = Object.fromEntries(
  FEEDBACK_PRIORITIES.map((p) => [p.value, { label: p.label, colour: p.colour }]),
) as Record<FeedbackPriority, { label: string; colour: PillColour }>

// The two terminal statuses. An item in either is "resolved" — done means
// shipped, wont_do means considered-and-declined. Both are worth closing the
// loop on with the submitter.
export const FEEDBACK_RESOLVED_STATUSES: FeedbackStatus[] = ['done', 'wont_do']

export function isResolvedStatus(status: FeedbackStatus): boolean {
  return FEEDBACK_RESOLVED_STATUSES.includes(status)
}

// Heading for the resolution-note panel — frames the explanation by outcome.
export function resolutionHeading(status: FeedbackStatus): string {
  return status === 'wont_do' ? 'Why we closed this' : 'What we did'
}

// How many days back a "done" item still counts as recently shipped, for the
// team-momentum band that surfaces in the board's default (Open) view.
export const RECENTLY_SHIPPED_DAYS = 14

// The single source of truth for "this resolved item is new to this user since
// they last looked at the board". Used by both the header badge count
// (src/design/DesignerChrome.tsx) and the on-board personal callout
// (src/pages/FeedbackPage.tsx) so the two can never drift.
//
// seenAt is the user's profiles.feedback_seen_at *as captured before* this
// visit's re-stamp. A null baseline (only possible on a profile that predates
// the 000281 backfill, or one created without the column default) means the
// user has never acknowledged the board, so every resolved item of theirs is
// new.
export function isUnseenResolved(
  item: Pick<FeedbackItem, 'created_by' | 'status' | 'status_changed_at'>,
  userId: string | null,
  seenAt: string | null,
): boolean {
  if (!userId || item.created_by !== userId) return false
  if (!isResolvedStatus(item.status)) return false
  if (!item.status_changed_at) return false
  if (!seenAt) return true
  // Compare as instants, not strings: the baseline can arrive as the DB's
  // `+00:00` form (backfill) while the item's timestamp is the `Z` form, so a
  // lexical compare would depend on tail formatting. Parsing both sidesteps it
  // and matches isRecentlyShipped's approach.
  const changed = new Date(item.status_changed_at).getTime()
  if (Number.isNaN(changed)) return false
  return changed > new Date(seenAt).getTime()
}

// "Shipped recently enough to show in the team-momentum band." Pure date maths
// against RECENTLY_SHIPPED_DAYS; only `done` (genuinely shipped) qualifies —
// wont_do stays in the Parked section, it isn't momentum.
export function isRecentlyShipped(
  item: Pick<FeedbackItem, 'status' | 'status_changed_at'>,
  now: number = Date.now(),
): boolean {
  if (item.status !== 'done' || !item.status_changed_at) return false
  const changed = new Date(item.status_changed_at).getTime()
  if (Number.isNaN(changed)) return false
  return now - changed <= RECENTLY_SHIPPED_DAYS * 24 * 60 * 60 * 1000
}

// Map the four legacy designer-colour names onto a CSS colour for the small
// author initials badge on each card. Mirrors DesignerHeader's COLOUR_BG so
// a staffer's badge colour matches their header avatar.
const AUTHOR_BADGE_BG: Record<string, string> = {
  blue: 'var(--c-allocated)',
  teal: 'var(--c-in-stock)',
  coral: 'var(--c-brand)',
  purple: '#7b3ff2',
}

export function authorBadgeColour(colour: string | null | undefined): string {
  return AUTHOR_BADGE_BG[colour ?? ''] ?? 'var(--c-ink-mute, #8a8a8a)'
}
