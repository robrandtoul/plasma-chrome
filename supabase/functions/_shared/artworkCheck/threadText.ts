// Flatten a Help Scout thread trail into the chronological, labelled text the
// model reads as the PRIMARY reference. Rules from the spec:
//   * oldest → newest — the request-form submission is typically the FIRST
//     message, and later values supersede earlier ones (latest-wins).
//   * RAW bodies, only HTML-stripped — not the lossy human-preview cleaner
//     (signature/quote stripping could remove the very detail block we need).
//   * notes included but labelled — internal notes can carry phoned-in
//     corrections, but also machine copies the model should weigh accordingly.
//   * attachments surfaced by NAME so an unread attachment becomes an honest
//     reference_gap ("details supplied as attachment X"), never silence.

import { normaliseBody } from '../aiDrafts/htmlText.ts'

export interface ThreadLike {
  type?: string
  state?: string
  body?: string
  createdAt?: string
  createdBy?: {
    type?: string
    first?: string
    last?: string
    email?: string
  }
  _embedded?: {
    attachments?: { filename?: string }[]
  }
}

// Per-message + whole-trail caps. The details block is short; the caps only
// bite on threads carrying long quoted histories. On overflow the OLDEST and
// NEWEST messages are kept (form + latest revisions) and the middle elided
// with an explicit marker, so the model never mistakes trimming for absence.
export const MESSAGE_CHAR_CAP = 6_000
export const THREAD_CHAR_CAP = 60_000

interface RenderedMessage {
  text: string
  at: number
}

function authorLabel(t: ThreadLike): string {
  const who = [t.createdBy?.first, t.createdBy?.last].filter(Boolean).join(' ').trim()
  const kind = t.type === 'note' ? 'Internal note' : t.createdBy?.type === 'customer' ? 'Customer' : 'Staff'
  return who ? `${kind} (${who})` : kind
}

function renderOne(t: ThreadLike): RenderedMessage | null {
  // Only real messages: customer threads, staff replies/messages, and notes.
  // Drafts and lineitems (status changes, no body) are noise.
  if (t.state === 'draft') return null
  if (t.type !== 'customer' && t.type !== 'message' && t.type !== 'reply' && t.type !== 'note') return null
  const body = normaliseBody(t.body ?? '')
  const attachments = (t._embedded?.attachments ?? [])
    .map((a) => (a.filename ?? '').trim())
    .filter(Boolean)
  if (!body && attachments.length === 0) return null
  const at = Date.parse(t.createdAt ?? '')
  const when = Number.isFinite(at) ? new Date(at).toISOString().slice(0, 10) : 'unknown date'
  const clipped = body.length > MESSAGE_CHAR_CAP
    ? `${body.slice(0, MESSAGE_CHAR_CAP)}\n[… message truncated]`
    : body
  const lines = [`— ${when} · ${authorLabel(t)}:`]
  if (clipped) lines.push(clipped)
  if (attachments.length) lines.push(`[attachments: ${attachments.join(', ')}]`)
  return { text: lines.join('\n'), at: Number.isFinite(at) ? at : 0 }
}

export function threadToText(threads: ThreadLike[]): { text: string; messageCount: number } {
  const rendered = threads
    .map(renderOne)
    .filter((m): m is RenderedMessage => m !== null)
    .sort((a, b) => a.at - b.at)
  if (rendered.length === 0) return { text: '', messageCount: 0 }

  const total = rendered.reduce((s, m) => s + m.text.length, 0)
  let kept = rendered
  let elided = 0
  if (total > THREAD_CHAR_CAP) {
    // Keep messages from both ends until the budget is spent, biased towards
    // the oldest (where the form lives) — walk head/tail alternately, head first.
    const head: RenderedMessage[] = []
    const tail: RenderedMessage[] = []
    let budget = THREAD_CHAR_CAP
    let lo = 0
    let hi = rendered.length - 1
    let takeHead = true
    while (lo <= hi) {
      const candidate = takeHead ? rendered[lo] : rendered[hi]
      if (candidate.text.length > budget) break
      budget -= candidate.text.length
      if (takeHead) {
        head.push(candidate)
        lo++
      } else {
        tail.unshift(candidate)
        hi--
      }
      takeHead = !takeHead
    }
    elided = hi - lo + 1
    kept = elided > 0
      ? [...head, { text: `[… ${elided} message${elided === 1 ? '' : 's'} omitted for length …]`, at: 0 }, ...tail]
      : [...head, ...tail]
  }

  return {
    text: kept.map((m) => m.text).join('\n\n'),
    messageCount: rendered.length,
  }
}
