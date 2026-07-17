import { useEffect, useRef, useState } from 'react'
import { Send, Trash2, ChevronDown, Check } from 'lucide-react'
import { Textarea } from '../design'
import { useAuth } from '../lib/auth'
import {
  useTeamChat,
  CHAT_STATUS_META,
  type ChatStatus,
  type PresenceMember,
} from '../lib/teamChatStore'
import {
  authorBadgeColour,
  dayKey,
  dayLabel,
  isGroupedWithPrevious,
  messageTime,
  splitLinkifiedText,
} from '../lib/teamChat'

// The shared chat body — presence strip + message list + composer — used by
// both the header dropdown (variant="dropdown") and the full /chat page
// (variant="page"). It reads everything from the TeamChatProvider, so the two
// surfaces stay perfectly in sync. The parent sizes it (it fills its height).

interface TeamChatPanelProps {
  variant: 'dropdown' | 'page'
}

// The three statuses a person can set for themselves. "Idle" isn't here — it's
// applied automatically when you go quiet.
const SETTABLE: { value: 'online' | 'away' | 'busy'; label: string }[] = [
  { value: 'online', label: 'Online' },
  { value: 'away', label: 'Away' },
  { value: 'busy', label: 'Busy' },
]

function StatusDot({ status, ring }: { status: ChatStatus; ring?: string }) {
  return (
    <span
      className="inline-block h-2.5 w-2.5 rounded-full"
      style={{ backgroundColor: CHAT_STATUS_META[status].dot, boxShadow: ring ? `0 0 0 2px ${ring}` : undefined }}
      aria-hidden="true"
    />
  )
}

// A small avatar with a status dot, for the "who's around" strip.
function PresenceAvatar({ member }: { member: PresenceMember }) {
  const meta = CHAT_STATUS_META[member.status]
  return (
    <span
      className="relative inline-flex h-7 w-7 items-center justify-center rounded-full font-mono text-[10px] font-medium text-white"
      style={{ backgroundColor: authorBadgeColour(member.colour) }}
      title={`${member.name ?? 'Someone'} — ${meta.label}`}
    >
      {(member.initials ?? '?').slice(0, 2)}
      <span
        className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full"
        style={{ backgroundColor: meta.dot, boxShadow: '0 0 0 2px var(--c-surface)' }}
        aria-hidden="true"
      />
    </span>
  )
}

function StatusPicker() {
  const { myStatus, setManualStatus } = useTeamChat()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface py-1 pl-2 pr-1.5 text-[12px] font-medium text-ink-soft hover:bg-canvas"
      >
        <StatusDot status={myStatus} />
        {CHAT_STATUS_META[myStatus].label}
        <ChevronDown size={13} aria-hidden="true" className="text-ink-mute" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute left-0 top-9 z-30 min-w-[9rem] rounded-[10px] border border-line bg-surface py-1 shadow-md"
        >
          {SETTABLE.map((s) => (
            <button
              key={s.value}
              type="button"
              role="menuitemradio"
              aria-checked={myStatus === s.value}
              onClick={() => {
                setManualStatus(s.value)
                setOpen(false)
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-ink-soft hover:bg-canvas"
            >
              <StatusDot status={s.value} />
              <span className="flex-1">{s.label}</span>
              {myStatus === s.value && <Check size={14} aria-hidden="true" className="text-ink-mute" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default function TeamChatPanel({ variant }: TeamChatPanelProps) {
  const { session, role } = useAuth()
  const userId = session?.user.id ?? null
  const isAdmin = role === 'admin'
  const { messages, loading, presence, send, remove, setViewing } = useTeamChat()

  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // While this panel is visible, incoming messages shouldn't accrue unread.
  useEffect(() => {
    setViewing(true)
    return () => setViewing(false)
    // setViewing only flips a ref in the provider; safe to run once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, loading])

  async function handleSend() {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    setError(null)
    const res = await send(text)
    setSending(false)
    if (!res.ok) {
      setError(res.error || 'Could not send your message. Please try again.')
      return
    }
    setDraft('')
  }

  // "Who's around" — everyone present except me.
  const others = presence.filter((m) => m.userId !== userId)

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Presence strip */}
      <div className="flex items-center gap-3 border-b border-line-soft px-3 py-2">
        <StatusPicker />
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
          {others.length === 0 ? (
            <span className="truncate text-[12px] text-ink-mute">No-one else here right now</span>
          ) : (
            <>
              <div className="flex flex-shrink-0 items-center -space-x-1.5">
                {others.slice(0, 6).map((m) => (
                  <PresenceAvatar key={m.userId} member={m} />
                ))}
              </div>
              {others.length > 6 && (
                <span className="text-[12px] text-ink-mute">+{others.length - 6}</span>
              )}
            </>
          )}
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <div
              className="h-6 w-6 animate-spin rounded-full border-2 border-line motion-reduce:animate-none"
              style={{ borderTopColor: 'var(--c-ink)' }}
            />
          </div>
        ) : messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <p className="text-[14px] text-ink-soft">No messages yet.</p>
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
                            onClick={() => void remove(m.id)}
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
      <div className="border-t border-line-soft p-2.5">
        {error && (
          <p role="alert" className="mb-2 rounded-lg bg-out-soft px-3 py-1.5 text-[12px] text-out">
            {error}
          </p>
        )}
        <div className="flex items-end gap-2">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={variant === 'dropdown' ? 1 : 2}
            placeholder="Message the team…"
            className="flex-1"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void handleSend()
              }
            }}
          />
          <button
            type="button"
            onClick={() => void handleSend()}
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
  )
}
