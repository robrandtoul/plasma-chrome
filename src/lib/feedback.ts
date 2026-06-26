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
  { value: 'new', label: 'New', colour: 'brand' },
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
