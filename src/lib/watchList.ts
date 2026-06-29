// Shared types + display metadata for the "Flagged" board (problem projects).
// NB: the user-facing board is called "Flagged"; the storage tables keep their
// original names (watch_items / watch_updates) — these types deliberately mirror
// the DB, so "Watch*" type names = the storage layer, "Flagged" = the UI.
// Kept in lockstep with the CHECK constraints on proofs.watch_items /
// proofs.watch_updates (migration 000290): if you add a category, status, or
// update kind here, widen the DB constraint in a migration too.

import type { PillColour } from '../design'

// Re-exported so the board's author badge matches the header avatar colour
// without each call site importing from two lib modules.
export { authorBadgeColour } from './feedback'

export type WatchCategory =
  | 'lost_in_transit'
  | 'reprint'
  | 'quality_complaint'
  | 'delayed'
  | 'payment_issue'
  | 'general'

export type WatchStatus = 'open' | 'monitoring' | 'resolved'

export type WatchUpdateKind = 'note' | 'phone_call'

// One flagged project (the card). Proof + author context are denormalised on
// the row and stamped server-side (profiles is self-read-only; see 000290).
export interface WatchItem {
  id: string
  proof_id: string
  category: WatchCategory
  status: WatchStatus
  ordered_on: string | null
  company_name: string | null
  contact_name: string | null
  designer_name: string | null
  stock_order_number: string | null
  helpscout_conversation_url: string | null
  created_by: string | null
  created_by_name: string | null
  created_by_initials: string | null
  created_by_colour: string | null
  status_changed_at: string | null
  status_changed_by: string | null
  status_changed_by_name: string | null
  created_at: string
  updated_at: string
}

// One entry in a card's shared thread — a note or a logged phone call.
export interface WatchUpdate {
  id: string
  watch_item_id: string
  kind: WatchUpdateKind
  body: string
  created_by: string | null
  created_by_name: string | null
  created_by_initials: string | null
  created_by_colour: string | null
  created_at: string
}

// Ordered for the flag form's category picker + card pills.
export const WATCH_CATEGORIES: {
  value: WatchCategory
  label: string
  colour: PillColour
}[] = [
  { value: 'lost_in_transit', label: 'Lost in transit', colour: 'critical' },
  { value: 'reprint', label: 'Reprint', colour: 'allocated' },
  { value: 'quality_complaint', label: 'Quality complaint', colour: 'brand' },
  { value: 'delayed', label: 'Delayed', colour: 'low' },
  { value: 'payment_issue', label: 'Payment issue', colour: 'neutral' },
  { value: 'general', label: 'General', colour: 'mute' },
]

export const WATCH_CATEGORY_META: Record<
  WatchCategory,
  { label: string; colour: PillColour }
> = Object.fromEntries(
  WATCH_CATEGORIES.map((c) => [c.value, { label: c.label, colour: c.colour }]),
) as Record<WatchCategory, { label: string; colour: PillColour }>

// Pipeline order: open → monitoring → resolved.
export const WATCH_STATUSES: {
  value: WatchStatus
  label: string
  colour: PillColour
}[] = [
  { value: 'open', label: 'Open', colour: 'out' },
  { value: 'monitoring', label: 'Monitoring', colour: 'low' },
  { value: 'resolved', label: 'Resolved', colour: 'in-stock' },
]

export const WATCH_STATUS_META: Record<
  WatchStatus,
  { label: string; colour: PillColour }
> = Object.fromEntries(
  WATCH_STATUSES.map((s) => [s.value, { label: s.label, colour: s.colour }]),
) as Record<WatchStatus, { label: string; colour: PillColour }>

export const WATCH_UPDATE_KINDS: { value: WatchUpdateKind; label: string }[] = [
  { value: 'note', label: 'Note' },
  { value: 'phone_call', label: 'Phone call' },
]

// "resolved" is the single terminal status — drops off the default board view
// but stays searchable under the Resolved / All scopes.
export function isResolvedWatch(status: WatchStatus): boolean {
  return status === 'resolved'
}

// Short, human relative time for the "last update 2h ago" line on a card.
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const secs = Math.max(0, Math.round((now - then) / 1000))
  if (secs < 60) return 'just now'
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.round(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.round(months / 12)}y ago`
}
