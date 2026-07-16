// Types + pure helpers for the internal team chat (migration 000319). No React
// here so it stays a plain, testable module; the ChatPage renders the segments.

export interface TeamMessage {
  id: string
  author_id: string | null
  // Denormalised sender (stamped by the team_messages_set_author trigger), so
  // the shared channel never joins back to the self-read-only profiles table.
  author_name: string | null
  author_initials: string | null
  author_colour: string | null
  body: string
  created_at: string
}

// Map the four legacy designer-colour names to design tokens for the author
// chip. Duplicated (small) from DesignerHeader's COLOUR_BG / feedback's
// AUTHOR_BADGE_BG rather than cross-importing, keeping this module standalone.
const AUTHOR_BADGE_BG: Record<string, string> = {
  blue: 'var(--c-allocated)',
  teal: 'var(--c-in-stock)',
  coral: 'var(--c-brand)',
  purple: '#7b3ff2',
}

export function authorBadgeColour(colour: string | null | undefined): string {
  return AUTHOR_BADGE_BG[colour ?? ''] ?? 'var(--c-ink-mute, #8a8a8a)'
}

// Message text split into plain runs and URL runs, so the composer can stay
// text-only while a pasted link (e.g. a /proofs/:id URL — "can someone look at
// this?") renders clickable. The trailing-punctuation exclusion keeps a URL at
// the end of a sentence from swallowing the full stop.
export type MessageSegment = { type: 'text' | 'link'; value: string }

const URL_RE = /(https?:\/\/[^\s<]+[^\s<.,:;!?)\]}'"])/gi

export function splitLinkifiedText(body: string): MessageSegment[] {
  const segments: MessageSegment[] = []
  let lastIndex = 0
  for (const match of body.matchAll(URL_RE)) {
    const start = match.index ?? 0
    if (start > lastIndex) segments.push({ type: 'text', value: body.slice(lastIndex, start) })
    segments.push({ type: 'link', value: match[0] })
    lastIndex = start + match[0].length
  }
  if (lastIndex < body.length) segments.push({ type: 'text', value: body.slice(lastIndex) })
  return segments
}

// "Today" / "Yesterday" / "Tue 8 Jul" for the day divider between messages.
export function dayLabel(iso: string): string {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return ''
  const now = new Date()
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diffDays = Math.round((startOf(now) - startOf(d)) / 86_400_000)
  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  const includeYear = d.getFullYear() !== now.getFullYear()
  return d.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(includeYear ? { year: 'numeric' } : {}),
  })
}

// Local YYYY-MM-DD key for grouping messages into day blocks.
export function dayKey(iso: string): string {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return ''
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

// 24-hour HH:MM shown beside each message header.
export function messageTime(iso: string): string {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return ''
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })
}

// Whether message `b` should tuck under `a` (same author, same day, within a
// few minutes) so a run of messages reads as one turn rather than repeating the
// name + avatar on every line.
const GROUP_WINDOW_MS = 5 * 60 * 1000

export function isGroupedWithPrevious(
  previous: TeamMessage | undefined,
  current: TeamMessage,
): boolean {
  if (!previous) return false
  if (previous.author_id !== current.author_id) return false
  if (dayKey(previous.created_at) !== dayKey(current.created_at)) return false
  const gap = new Date(current.created_at).getTime() - new Date(previous.created_at).getTime()
  return Number.isFinite(gap) && gap >= 0 && gap < GROUP_WINDOW_MS
}
