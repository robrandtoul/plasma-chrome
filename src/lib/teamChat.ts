// Types + pure helpers for the internal team chat (migration 000319). No React
// here so it stays a plain, testable module; the ChatPage renders the segments.

// One chat attachment's metadata (000323). The storage key is a random uuid,
// so `name` / `type` / `size` are carried here to give the download a real
// filename and let the UI chip non-images by kind.
export interface ChatAttachment {
  path: string
  name: string
  type: string
  size: number
}

export interface TeamMessage {
  id: string
  author_id: string | null
  // Denormalised sender (stamped by the team_messages_set_author trigger), so
  // the shared channel never joins back to the self-read-only profiles table.
  author_name: string | null
  author_initials: string | null
  author_colour: string | null
  body: string
  // Ids picked from the @mention autocomplete (000320). Drives the mention
  // push and the header's louder mention badge; purely cosmetic highlighting
  // still matches on name text.
  mentioned_user_ids?: string[] | null
  // Storage keys in the chat-attachments bucket (000322). Read via signed URL.
  attachment_paths?: string[] | null
  // Richer per-attachment metadata (000323). Empty on pre-000323 image
  // messages, which fall back to attachment_paths via attachmentsOf().
  attachment_files?: ChatAttachment[] | null
  created_at: string
}

// The attachments to render for a message. Prefer the rich 000323 metadata;
// fall back to the legacy image-only paths so old messages still show.
export function attachmentsOf(m: TeamMessage): ChatAttachment[] {
  if (m.attachment_files && m.attachment_files.length > 0) return m.attachment_files
  return (m.attachment_paths ?? []).map((path) => ({
    path,
    name: 'Image',
    type: 'image/*',
    size: 0,
  }))
}

// "1.2 MB" / "834 KB" for an attachment chip. Empty for unknown/zero sizes.
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let value = n
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const rounded = value >= 10 || unit === 0 ? Math.round(value) : Math.round(value * 10) / 10
  return `${rounded} ${units[unit]}`
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
export type MessageSegment = { type: 'text' | 'link' | 'mention'; value: string }

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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Split a message into text / link / mention runs. Links come first (via
// splitLinkifiedText); then within plain text, any "@<known member name>" is
// pulled out as a mention run so it can be highlighted. Names are matched
// longest-first so "@Rob Randtoul" wins over "@Rob". Purely cosmetic — the push
// targets the ids the sender picked, not this text match.
export function buildMessageSegments(body: string, memberNames: string[]): MessageSegment[] {
  const linkSegs = splitLinkifiedText(body)
  const names = memberNames.filter((n): n is string => !!n && n.trim().length > 0)
  if (names.length === 0) return linkSegs
  const pattern = [...names].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|')
  const re = new RegExp('@(?:' + pattern + ')', 'g')

  const out: MessageSegment[] = []
  for (const seg of linkSegs) {
    if (seg.type !== 'text') {
      out.push(seg)
      continue
    }
    let last = 0
    for (const m of seg.value.matchAll(re)) {
      const start = m.index ?? 0
      if (start > last) out.push({ type: 'text', value: seg.value.slice(last, start) })
      out.push({ type: 'mention', value: m[0] })
      last = start + m[0].length
    }
    if (last < seg.value.length) out.push({ type: 'text', value: seg.value.slice(last) })
  }
  return out
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
