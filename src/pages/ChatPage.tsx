import { useEffect, useId, useRef, useState } from 'react'
import { Send, Trash2, MessagesSquare } from 'lucide-react'
import DesignerChrome from '../design/DesignerChrome'
import { Textarea } from '../design'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import {
  authorBadgeColour,
  dayKey,
  dayLabel,
  isGroupedWithPrevious,
  messageTime,
  splitLinkifiedText,
  type TeamMessage,
} from '../lib/teamChat'

// The internal team chat page (migration 000319). One shared channel for the
// team, right inside the dashboard we all live in. Live via a realtime
// subscription (unlike the fetch-on-mount feedback board); the header unread
// badge is driven by profiles.team_chat_seen_at, which we stamp on open and as
// messages arrive while we're watching.

const INITIAL_LIMIT = 200

export default function ChatPage() {
  const { session, role } = useAuth()
  const userId = session?.user.id ?? null
  const isAdmin = role === 'admin'
  // Per-mount channel suffix so a StrictMode double-mount / fast HMR doesn't
  // collide on an identical channel name (same guard as useLiveProofViews).
  const channelSuffix = useId()

  const [messages, setMessages] = useState<TeamMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const scrollRef = useRef<HTMLDivElement>(null)

  // Mark "seen up to now" so the header unread badge clears. Fire-and-forget.
  function stampSeen() {
    if (!userId) return
    void supabase
      .from('profiles')
      .update({ team_chat_seen_at: new Date().toISOString() })
      .eq('id', userId)
  }

  // Initial load: newest-first from the server, reversed to oldest→newest for
  // display.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const { data, error: loadErr } = await supabase
        .from('team_messages')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(INITIAL_LIMIT)
      if (cancelled) return
      if (loadErr) {
        setError('Could not load messages. Please reload the page.')
        setLoading(false)
        return
      }
      setMessages(((data ?? []) as TeamMessage[]).reverse())
      setLoading(false)
      stampSeen()
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId])

  // Realtime: new + deleted messages land without a refresh.
  useEffect(() => {
    const channel = supabase
      .channel(`team-chat-${channelSuffix}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'proofs', table: 'team_messages' },
        (payload) => {
          const row = payload.new as TeamMessage
          setMessages((prev) => (prev.some((m) => m.id === row.id) ? prev : [...prev, row]))
          // Keep our marker current while we're watching, but only for other
          // people's messages — our own send already stamps.
          if (row.author_id !== userId) stampSeen()
        },
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'proofs', table: 'team_messages' },
        (payload) => {
          const oldRow = payload.old as { id?: string }
          if (!oldRow?.id) return
          setMessages((prev) => prev.filter((m) => m.id !== oldRow.id))
        },
      )
      .subscribe()
    return () => {
      void supabase.removeChannel(channel)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelSuffix, userId])

  // Keep the view pinned to the latest message. Low-volume team channel, so
  // always-scroll-to-bottom is fine (no "reading history" contention).
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, loading])

  async function send() {
    const text = draft.trim()
    if (!text || sending || !userId) return
    setSending(true)
    setError(null)
    const { data, error: insErr } = await supabase
      .from('team_messages')
      .insert({ author_id: userId, body: text })
      .select('*')
      .single()
    setSending(false)
    if (insErr || !data) {
      setError(insErr?.message || 'Could not send your message. Please try again.')
      return
    }
    setDraft('')
    const row = data as TeamMessage
    setMessages((prev) => (prev.some((m) => m.id === row.id) ? prev : [...prev, row]))
    stampSeen()
  }

  async function remove(id: string) {
    const snapshot = messages
    // Optimistic: drop it now, restore if the delete fails.
    setMessages((prev) => prev.filter((m) => m.id !== id))
    const { error: delErr } = await supabase.from('team_messages').delete().eq('id', id)
    if (delErr) setMessages(snapshot)
  }

  return (
    <DesignerChrome active="chat">
      <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
        <div className="flex h-[calc(100dvh-8rem)] flex-col overflow-hidden rounded-[14px] border border-line bg-surface max-md:h-[calc(100dvh-12rem)]">
          {/* Header */}
          <div className="flex items-center gap-2.5 border-b border-line-soft px-4 py-3">
            <MessagesSquare size={18} className="text-ink-mute" aria-hidden="true" />
            <div>
              <h1 className="text-[15px] font-semibold leading-none text-ink">Team chat</h1>
              <p className="mt-1 text-[12px] text-ink-mute">A shared channel for the team.</p>
            </div>
          </div>

          {/* Messages */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4">
            {loading ? (
              <div className="flex h-full items-center justify-center">
                <div
                  className="h-6 w-6 animate-spin rounded-full border-2 border-line motion-reduce:animate-none"
                  style={{ borderTopColor: 'var(--c-ink)' }}
                />
              </div>
            ) : messages.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center text-center">
                <MessagesSquare size={28} className="text-ink-dim" aria-hidden="true" />
                <p className="mt-2 text-[14px] text-ink-soft">No messages yet.</p>
                <p className="text-[13px] text-ink-mute">Say hello to the team.</p>
              </div>
            ) : (
              <ul className="space-y-0">
                {messages.map((m, i) => {
                  const prev = messages[i - 1]
                  const grouped = isGroupedWithPrevious(prev, m)
                  const showDay = !prev || dayKey(prev.created_at) !== dayKey(m.created_at)
                  const canDelete = m.author_id === userId || isAdmin
                  return (
                    <li key={m.id}>
                      {showDay && (
                        <div className="my-3 flex items-center gap-3">
                          <span className="h-px flex-1 bg-line-soft" />
                          <span className="text-[11px] font-medium uppercase tracking-wide text-ink-mute">
                            {dayLabel(m.created_at)}
                          </span>
                          <span className="h-px flex-1 bg-line-soft" />
                        </div>
                      )}
                      <div className={['group flex items-start gap-2.5', grouped ? 'mt-0.5' : 'mt-2.5'].join(' ')}>
                        <div className="w-7 flex-shrink-0">
                          {!grouped && (
                            <span
                              className="inline-flex h-7 w-7 items-center justify-center rounded-full font-mono text-[10px] font-medium text-white"
                              style={{ backgroundColor: authorBadgeColour(m.author_colour) }}
                              aria-hidden="true"
                            >
                              {(m.author_initials ?? '?').slice(0, 2)}
                            </span>
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          {!grouped && (
                            <div className="flex items-baseline gap-2">
                              <span className="text-[13px] font-semibold text-ink">
                                {m.author_name ?? 'Someone'}
                              </span>
                              <span className="text-[11px] text-ink-mute">{messageTime(m.created_at)}</span>
                            </div>
                          )}
                          <div className="flex items-start gap-2">
                            <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[14px] leading-snug text-ink-soft">
                              {splitLinkifiedText(m.body).map((seg, si) =>
                                seg.type === 'link' ? (
                                  <a
                                    key={si}
                                    href={seg.value}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="break-all text-brand underline underline-offset-2 hover:text-brand-600"
                                  >
                                    {seg.value}
                                  </a>
                                ) : (
                                  <span key={si}>{seg.value}</span>
                                ),
                              )}
                            </p>
                            {canDelete && (
                              <button
                                type="button"
                                onClick={() => remove(m.id)}
                                aria-label="Delete message"
                                title="Delete"
                                className="mt-0.5 flex-shrink-0 rounded p-1 text-ink-mute opacity-0 transition-opacity hover:bg-canvas hover:text-out focus-visible:opacity-100 group-hover:opacity-100"
                              >
                                <Trash2 size={14} aria-hidden="true" />
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>

          {/* Composer */}
          <div className="border-t border-line-soft p-3">
            {error && (
              <p role="alert" className="mb-2 rounded-lg bg-out-soft px-3 py-1.5 text-[12px] text-out">
                {error}
              </p>
            )}
            <div className="flex items-end gap-2">
              <Textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={2}
                placeholder="Message the team…"
                className="flex-1"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void send()
                  }
                }}
              />
              <button
                type="button"
                onClick={() => void send()}
                disabled={!draft.trim() || sending}
                aria-label="Send message"
                className="inline-flex h-[42px] w-[42px] flex-shrink-0 items-center justify-center rounded-[8px] bg-ink text-on-ink transition-colors hover:bg-ink-soft disabled:opacity-40"
              >
                <Send size={18} aria-hidden="true" />
              </button>
            </div>
            <p className="mt-1.5 text-[11px] text-ink-dim">Enter to send · Shift + Enter for a new line</p>
          </div>
        </div>
      </div>
    </DesignerChrome>
  )
}
