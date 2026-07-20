import { useEffect, useMemo, useRef, useState, type ClipboardEvent } from 'react'
import {
  Send,
  Trash2,
  ChevronDown,
  Check,
  Volume2,
  VolumeX,
  Search as SearchIcon,
  X,
  Paperclip,
  FileText,
  File as FileIcon,
  Download,
  Smile,
} from 'lucide-react'
import { Textarea } from '../design'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { useImageFileDrop } from '../lib/useImageFileDrop'
import { playChatSound } from '../lib/chatSound'
import {
  useTeamChat,
  CHAT_STATUS_META,
  type ChatStatus,
  type PresenceMember,
  type TeamMember,
  type ReactionRow,
} from '../lib/teamChatStore'
import {
  attachmentsOf,
  authorBadgeColour,
  buildMessageSegments,
  dayKey,
  dayLabel,
  formatBytes,
  isGroupedWithPrevious,
  messageTime,
  type ChatAttachment,
  type TeamMessage,
} from '../lib/teamChat'
import { designerTint } from '../lib/designerColours'

const CHAT_BUCKET = 'chat-attachments'
const EMOJI_CHOICES = ['👍', '❤️', '😂', '🎉', '👀', '✅', '🙏']
const MAX_ATTACHMENTS = 6
const MAX_MB = 25
const MAX_BYTES = MAX_MB * 1024 * 1024 // matches the 000323 bucket cap

interface StagedAttachment {
  id: string
  blob: Blob
  // Object URL for the composer thumbnail (images only; harmless for others).
  url: string
  // Original filename + mime, preserved onto the stored attachment metadata.
  name: string
  type: string
}

function isImageType(type: string): boolean {
  return (type ?? '').startsWith('image/')
}

// Extension for the storage key: prefer the real filename's, fall back to a
// sensible image extension from the mime. Cosmetic — the download filename
// comes from the stored `name`, not the key.
function extForFile(name: string, type: string): string {
  const fromName = (name.split('.').pop() ?? '').toLowerCase()
  if (fromName && fromName !== name.toLowerCase() && /^[a-z0-9]{1,8}$/.test(fromName)) return fromName
  if (type === 'image/jpeg') return 'jpg'
  if (type === 'image/webp') return 'webp'
  if (type === 'image/gif') return 'gif'
  if (type === 'image/png') return 'png'
  return ''
}

// A short kind label ("PDF", "AI", "TTF") for a non-image chip.
function kindLabel(name: string, type: string): string {
  const ext = (name.split('.').pop() ?? '').toLowerCase()
  if (ext && ext !== name.toLowerCase() && ext.length <= 5) return ext.toUpperCase()
  return (type.split('/').pop() ?? '').toUpperCase()
}

// Lucide icon for a non-image attachment chip.
function fileKindIcon(name: string, type: string) {
  const ext = (name.split('.').pop() ?? '').toLowerCase()
  if (type === 'application/pdf' || ext === 'pdf') return FileText
  return FileIcon
}

// Group a message's reaction rows by emoji, tracking count / whether I reacted /
// who reacted (for the tooltip).
function groupReactions(rows: ReactionRow[], userId: string | null) {
  const map = new Map<string, { emoji: string; count: number; mine: boolean; names: string[] }>()
  for (const r of rows) {
    const g = map.get(r.emoji) ?? { emoji: r.emoji, count: 0, mine: false, names: [] }
    g.count += 1
    if (r.user_id === userId) g.mine = true
    if (r.user_name) g.names.push(r.user_name)
    map.set(r.emoji, g)
  }
  return [...map.values()]
}

// Renders a message's attachments: images preview as thumbnails (private
// bucket → signed URLs, full-screen on click); any other file shows a
// downloadable chip carrying its original name / kind / size (000323).
function ChatAttachments({ files }: { files: ChatAttachment[] }) {
  const [urls, setUrls] = useState<string[]>([])
  const [lightbox, setLightbox] = useState<string | null>(null)
  const key = files.map((f) => f.path).join(',')
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const { data } = await supabase.storage
        .from(CHAT_BUCKET)
        .createSignedUrls(files.map((f) => f.path), 3600)
      if (cancelled) return
      setUrls((data ?? []).map((d) => d.signedUrl ?? ''))
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  if (urls.length === 0) return null
  return (
    <>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {files.map((f, i) => {
          const url = urls[i]
          if (!url) return null
          if (isImageType(f.type)) {
            return (
              <button
                key={i}
                type="button"
                onClick={() => setLightbox(url)}
                className="overflow-hidden rounded-lg border border-line"
              >
                <img
                  src={url}
                  alt={f.name || 'Attachment'}
                  loading="lazy"
                  className="h-36 w-36 object-cover"
                />
              </button>
            )
          }
          // Force a download with the real filename via the signed URL's
          // ?download param (the stored key is a random uuid).
          const href = `${url}${url.includes('?') ? '&' : '?'}download=${encodeURIComponent(f.name || 'file')}`
          const Icon = fileKindIcon(f.name, f.type)
          const meta = [kindLabel(f.name, f.type), formatBytes(f.size)].filter(Boolean).join(' · ')
          return (
            <a
              key={i}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              title={`Download ${f.name}`}
              className="flex max-w-[240px] items-center gap-2.5 rounded-lg border border-line bg-canvas px-3 py-2 transition-colors hover:bg-surface"
            >
              <Icon size={22} aria-hidden="true" className="flex-shrink-0 text-ink-mute" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-medium text-ink sm:text-[12px]">{f.name || 'File'}</span>
                {meta && <span className="block text-[13px] text-ink-mute sm:text-[11px]">{meta}</span>}
              </span>
              <Download size={14} aria-hidden="true" className="flex-shrink-0 text-ink-dim" />
            </a>
          )
        })}
      </div>
      {lightbox && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setLightbox(null)}
          role="dialog"
          aria-modal="true"
        >
          <img
            src={lightbox}
            alt="Attachment"
            className="max-h-full max-w-full rounded-lg"
            onClick={(e) => e.stopPropagation()}
          />
          <button
            type="button"
            onClick={() => setLightbox(null)}
            aria-label="Close image"
            className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
          >
            <X size={20} aria-hidden="true" />
          </button>
        </div>
      )}
    </>
  )
}

// The hover "react" button + its emoji picker. `pickerAnchor` sets which edge
// the popover hangs from so it always opens over the bubble (where there's
// room) rather than off the panel edge.
function ReactButton({
  messageId,
  pickerAnchor,
}: {
  messageId: string
  pickerAnchor: 'left' | 'right'
}) {
  const { toggleReaction } = useTeamChat()
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
        aria-label="Add reaction"
        title="React"
        className="flex h-6 w-6 items-center justify-center rounded text-ink-mute hover:bg-canvas hover:text-ink"
      >
        <Smile size={14} aria-hidden="true" />
      </button>
      {open && (
        <div
          className={[
            'absolute top-7 z-30 flex gap-0.5 rounded-full border border-line bg-surface p-1 shadow-md',
            pickerAnchor === 'left' ? 'left-0' : 'right-0',
          ].join(' ')}
        >
          {EMOJI_CHOICES.map((e) => (
            <button
              key={e}
              type="button"
              onClick={() => {
                toggleReaction(messageId, e)
                setOpen(false)
              }}
              aria-label={`React ${e}`}
              className="rounded-full px-1 text-[16px] leading-none hover:bg-canvas"
            >
              {e}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function firstName(name: string | null | undefined): string {
  const n = (name ?? '').trim()
  return n ? n.split(/\s+/)[0] : 'Teammate'
}

// One pill in the thread switcher: the Team room or a teammate's private
// thread. Carries that thread's unread count and (for people) a presence dot.
function ThreadPill({
  label,
  active,
  count,
  status,
  onClick,
}: {
  label: string
  active: boolean
  count: number
  /** Presence dot: a ChatStatus, null = offline, undefined = no dot (Team). */
  status?: ChatStatus | null
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={[
        'flex h-9 flex-shrink-0 items-center gap-1.5 rounded-full border px-3 text-[14px] font-medium transition-colors sm:h-7 sm:px-2.5 sm:text-[12px]',
        active
          ? 'border-ink bg-ink text-on-ink'
          : 'border-line bg-surface text-ink-soft hover:bg-canvas hover:text-ink',
      ].join(' ')}
    >
      {status !== undefined && (
        <span
          className="inline-block h-2 w-2 flex-shrink-0 rounded-full"
          style={{ backgroundColor: status ? CHAT_STATUS_META[status].dot : 'var(--c-line)' }}
          aria-hidden="true"
        />
      )}
      {label}
      {count > 0 && (
        <span
          className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-brand px-1 text-[11px] font-bold leading-none text-white sm:h-[16px] sm:min-w-[16px] sm:text-[10px]"
          aria-label={`${count} unread`}
        >
          {count > 9 ? '9+' : count}
        </span>
      )}
    </button>
  )
}

// The shared chat body — presence strip + thread switcher + message list +
// composer — used by the header dropdown (variant="dropdown"), the full /chat
// page (variant="page") and the dashboard rail dock (variant="docked"). It
// reads everything from the TeamChatProvider, so every surface stays perfectly
// in sync (including which thread is open). The parent sizes it.

interface TeamChatPanelProps {
  variant: 'dropdown' | 'page' | 'docked'
}

const SETTABLE: { value: 'online' | 'away' | 'busy'; label: string }[] = [
  { value: 'online', label: 'Online' },
  { value: 'away', label: 'Away' },
  { value: 'busy', label: 'Busy' },
]

function StatusDot({ status }: { status: ChatStatus }) {
  return (
    <span
      className="inline-block h-2.5 w-2.5 rounded-full"
      style={{ backgroundColor: CHAT_STATUS_META[status].dot }}
      aria-hidden="true"
    />
  )
}

function PresenceAvatar({ member }: { member: PresenceMember }) {
  const meta = CHAT_STATUS_META[member.status]
  return (
    <span
      className="relative inline-flex h-9 w-9 items-center justify-center overflow-visible rounded-full font-mono text-[12px] font-medium text-white sm:h-7 sm:w-7 sm:text-[10px]"
      style={member.avatarUrl ? undefined : { backgroundColor: authorBadgeColour(member.colour) }}
      title={`${firstName(member.name)} — ${meta.label}`}
    >
      {member.avatarUrl ? (
        <img src={member.avatarUrl} alt="" className="h-9 w-9 rounded-full object-cover sm:h-7 sm:w-7" />
      ) : (
        (member.initials ?? '?').slice(0, 2)
      )}
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
        className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface py-1 pl-2 pr-1.5 text-[14px] font-medium text-ink-soft hover:bg-canvas sm:text-[12px]"
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
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[15px] text-ink-soft hover:bg-canvas sm:text-[13px]"
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

function SoundToggle() {
  const { soundEnabled, setSoundEnabled } = useTeamChat()
  return (
    <button
      type="button"
      onClick={() => {
        const next = !soundEnabled
        setSoundEnabled(next)
        if (next) playChatSound('general') // confirm + unlock audio on enable
      }}
      aria-pressed={soundEnabled}
      aria-label={soundEnabled ? 'Mute chat sounds' : 'Unmute chat sounds'}
      title={soundEnabled ? 'Mute chat sounds' : 'Unmute chat sounds'}
      className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-ink-mute transition-colors hover:bg-canvas hover:text-ink"
    >
      {soundEnabled ? (
        <Volume2 size={15} aria-hidden="true" />
      ) : (
        <VolumeX size={15} aria-hidden="true" />
      )}
    </button>
  )
}

function typingLabel(users: { name: string | null }[]): string {
  const names = users.map((u) => firstName(u.name))
  if (names.length === 1) return `${names[0]} is typing…`
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`
  return 'Several people are typing…'
}

// Is the caret sitting in an "@query" the composer should autocomplete?
function detectMention(text: string, caret: number): { at: number; query: string } | null {
  const before = text.slice(0, caret)
  const at = before.lastIndexOf('@')
  if (at < 0) return null
  if (at > 0 && !/\s/.test(before[at - 1])) return null // must start the token
  const query = before.slice(at + 1)
  if (/[\n@]/.test(query) || query.length > 40) return null
  return { at, query }
}

export default function TeamChatPanel({ variant }: TeamChatPanelProps) {
  const { session, role } = useAuth()
  const userId = session?.user.id ?? null
  const isAdmin = role === 'admin'
  const {
    messages,
    loading,
    presence,
    members,
    send,
    remove,
    setViewing,
    typingUsers,
    notifyTyping,
    reactions,
    toggleReaction,
    activeThread,
    setActiveThread,
    threadUnread,
    loadEarlier,
    historyFor,
  } = useTeamChat()

  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [attachments, setAttachments] = useState<StagedAttachment[]>([])
  const fileRef = useRef<HTMLInputElement>(null)

  const reactionsByMessage = useMemo(() => {
    const map = new Map<string, ReactionRow[]>()
    for (const r of reactions) {
      const arr = map.get(r.message_id) ?? []
      arr.push(r)
      map.set(r.message_id, arr)
    }
    return map
  }, [reactions])

  // Revoke object URLs on unmount.
  const attachmentsRef = useRef(attachments)
  attachmentsRef.current = attachments
  useEffect(
    () => () => {
      for (const a of attachmentsRef.current) URL.revokeObjectURL(a.url)
    },
    [],
  )

  function addFiles(files: File[]) {
    if (files.length === 0) return
    const sized = files.filter((f) => f.size <= MAX_BYTES)
    const room = Math.max(0, MAX_ATTACHMENTS - attachmentsRef.current.length)
    const additions: StagedAttachment[] = sized.slice(0, room).map((f) => ({
      id: crypto.randomUUID(),
      blob: f as Blob,
      url: URL.createObjectURL(f),
      name: f.name || 'file',
      type: f.type || '',
    }))
    let message: string | null = null
    if (sized.length < files.length) message = `Each file must be ${MAX_MB} MB or smaller.`
    if (sized.length > room) message = `You can attach up to ${MAX_ATTACHMENTS} files.`
    if (message) setError(message)
    if (additions.length > 0) setAttachments((prev) => [...prev, ...additions])
  }

  const { isZoneDragOver, zoneProps } = useImageFileDrop({ onFiles: addFiles })

  function handlePaste(e: ClipboardEvent) {
    const items = Array.from(e.clipboardData?.items ?? [])
    const files = items
      .filter((it) => it.kind === 'file')
      .map((it) => it.getAsFile())
      .filter((f): f is File => f != null)
    if (files.length > 0) {
      e.preventDefault()
      addFiles(files)
    }
  }

  function removeAttachment(id: string) {
    setAttachments((prev) => {
      const found = prev.find((a) => a.id === id)
      if (found) URL.revokeObjectURL(found.url)
      return prev.filter((a) => a.id !== id)
    })
  }
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // @mention autocomplete state.
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [mentionAnchor, setMentionAnchor] = useState(0)
  const [mentionCaret, setMentionCaret] = useState(0)
  const [mentionIndex, setMentionIndex] = useState(0)

  const mentionCandidates = useMemo(() => members.filter((m) => m.id !== userId), [members, userId])
  const memberNames = useMemo(
    () => members.map((m) => m.name ?? '').filter(Boolean),
    [members],
  )
  // The DM peer when a private thread is open; null in the team room.
  const activePeer = useMemo(
    () => (activeThread === 'team' ? null : members.find((m) => m.id === activeThread) ?? null),
    [activeThread, members],
  )
  // Author → profile lookup, so message avatars can use uploaded profile
  // pictures (avatar_url isn't denormalised on the message rows).
  const membersById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members])
  const presenceByUser = useMemo(
    () => new Map(presence.map((p) => [p.userId, p.status])),
    [presence],
  )
  // Messages for the active thread: the shared room, or my DM pair with the
  // selected peer (both directions). RLS already scopes what arrives; this
  // just splits it into conversations.
  const threadMessages = useMemo(() => {
    if (activeThread === 'team') return messages.filter((m) => !m.recipient_id)
    return messages.filter(
      (m) =>
        (m.author_id === activeThread && m.recipient_id === userId) ||
        (m.author_id === userId && m.recipient_id === activeThread),
    )
  }, [messages, activeThread, userId])
  const searchQuery = search.trim().toLowerCase()
  // Full-history search: the instant local filter is merged with a debounced
  // server search over the thread's ENTIRE history (RLS scopes DM reads), so
  // matches older than the loaded window surface too.
  const [remoteResults, setRemoteResults] = useState<TeamMessage[]>([])
  const [searchingRemote, setSearchingRemote] = useState(false)
  useEffect(() => {
    if (!searchQuery || !userId) {
      setRemoteResults([])
      setSearchingRemote(false)
      return
    }
    let cancelled = false
    setSearchingRemote(true)
    const timer = setTimeout(() => {
      void (async () => {
        // Escape LIKE wildcards so "50%" searches literally.
        const pattern = '%' + searchQuery.replace(/[\\%_]/g, (c) => '\\' + c) + '%'
        const base = () => {
          let q = supabase.from('team_messages').select('*')
          if (activeThread === 'team') q = q.is('recipient_id', null)
          else
            q = q.or(
              `and(author_id.eq.${activeThread},recipient_id.eq.${userId}),and(author_id.eq.${userId},recipient_id.eq.${activeThread})`,
            )
          return q
        }
        // Two single-filter queries (body, author) rather than one .or() so the
        // user's text never has to be escaped for the filter-list syntax.
        const [byBody, byAuthor] = await Promise.all([
          base().ilike('body', pattern).order('created_at', { ascending: false }).limit(50),
          base().ilike('author_name', pattern).order('created_at', { ascending: false }).limit(50),
        ])
        if (cancelled) return
        const merged = [...(byBody.data ?? []), ...(byAuthor.data ?? [])] as TeamMessage[]
        setRemoteResults(merged)
        setSearchingRemote(false)
      })()
    }, 350)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [searchQuery, activeThread, userId])
  const shown = useMemo(() => {
    if (!searchQuery) return threadMessages
    const local = threadMessages.filter(
      (m) =>
        m.body.toLowerCase().includes(searchQuery) ||
        (m.author_name ?? '').toLowerCase().includes(searchQuery),
    )
    if (remoteResults.length === 0) return local
    const byId = new Map<string, TeamMessage>()
    for (const m of [...remoteResults, ...local]) byId.set(m.id, m)
    return [...byId.values()].sort((a, b) =>
      a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0,
    )
  }, [threadMessages, searchQuery, remoteResults])
  const filtered = useMemo(() => {
    if (mentionQuery === null) return []
    const q = mentionQuery.toLowerCase()
    return mentionCandidates.filter((m) => (m.name ?? '').toLowerCase().includes(q)).slice(0, 6)
  }, [mentionQuery, mentionCandidates])

  useEffect(() => {
    setViewing(true)
    return () => setViewing(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Scroll management ─────────────────────────────────────────────────
  // Three behaviours, matching what a chat should do:
  //   1. Each thread REMEMBERS where you left it — switch away and back and
  //      you're on the same message ('bottom' = you were pinned to latest).
  //   2. A thread you haven't left mid-read lands on the LATEST message, and
  //      stays pinned there as new messages arrive — but never yanks you
  //      down while you're reading history.
  //   3. "Show earlier" re-anchors so the visible messages stay put.
  // Late layout (an image or a wrapping file chip finishing after the first
  // scroll) used to strand the view mid-history — the rAF double-set and the
  // ResizeObserver below re-pin whenever content grows while pinned.
  const scrollPositionsRef = useRef<Map<string, number | 'bottom'>>(new Map())
  const stickToBottomRef = useRef(true)
  const preserveScrollRef = useRef<{ height: number; top: number } | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  function nearBottom(el: HTMLDivElement): boolean {
    return el.scrollHeight - el.scrollTop - el.clientHeight < 120
  }
  function scrollToBottom(el: HTMLDivElement) {
    el.scrollTop = el.scrollHeight
    // Once more next frame — catches layout that settles just after render.
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight
    })
  }
  function onListScroll() {
    const el = scrollRef.current
    if (!el) return
    stickToBottomRef.current = nearBottom(el)
    scrollPositionsRef.current.set(
      activeThread,
      stickToBottomRef.current ? 'bottom' : el.scrollTop,
    )
  }

  // Thread switch (and the initial load): restore where you left this thread,
  // or land pinned to the latest message.
  useEffect(() => {
    const el = scrollRef.current
    if (!el || loading) return
    const saved = scrollPositionsRef.current.get(activeThread)
    if (typeof saved === 'number') {
      el.scrollTop = saved
      stickToBottomRef.current = nearBottom(el)
    } else {
      stickToBottomRef.current = true
      scrollToBottom(el)
    }
  }, [activeThread, loading])

  // New messages: follow the conversation only while pinned; after "Show
  // earlier", re-anchor so what you were reading stays in place.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const keep = preserveScrollRef.current
    if (keep) {
      preserveScrollRef.current = null
      el.scrollTop = el.scrollHeight - keep.height + keep.top
      return
    }
    if (stickToBottomRef.current) scrollToBottom(el)
  }, [messages.length])

  // Content that grows after render (image decode, chip wrapping, fonts)
  // silently un-bottoms a pinned view — watch the list's size and re-pin.
  useEffect(() => {
    const el = scrollRef.current
    const content = listRef.current
    if (!el || !content || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (stickToBottomRef.current && !preserveScrollRef.current) {
        el.scrollTop = el.scrollHeight
      }
    })
    ro.observe(content)
    return () => ro.disconnect()
  }, [loading, activeThread, shown.length > 0])

  async function onLoadEarlier() {
    const el = scrollRef.current
    if (el) preserveScrollRef.current = { height: el.scrollHeight, top: el.scrollTop }
    const added = await loadEarlier(activeThread)
    // Nothing added → no render → the anchor would leak into the next real
    // message arrival. Clear it.
    if (added === 0) preserveScrollRef.current = null
  }

  // A DM thread can look empty just because its history predates the loaded
  // window — probe once for its most recent page so old conversations
  // reappear on open instead of claiming "No messages yet".
  useEffect(() => {
    if (loading) return
    if (threadMessages.length > 0) return
    if (historyFor(activeThread) !== 'can-load') return
    void loadEarlier(activeThread)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeThread, threadMessages.length, loading])

  // Switching thread dismisses any half-open @mention autocomplete (mentions
  // are a team-room thing; a DM already targets its one recipient).
  useEffect(() => {
    setMentionQuery(null)
  }, [activeThread])

  function onDraftChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const value = e.target.value
    setDraft(value)
    if (value.trim()) notifyTyping()
    const caret = e.target.selectionStart ?? value.length
    const det = activeThread === 'team' ? detectMention(value, caret) : null
    if (det) {
      setMentionQuery(det.query)
      setMentionAnchor(det.at)
      setMentionCaret(caret)
      setMentionIndex(0)
    } else {
      setMentionQuery(null)
    }
  }

  function selectMention(member: TeamMember) {
    const insert = '@' + (member.name ?? '') + ' '
    const next = draft.slice(0, mentionAnchor) + insert + draft.slice(mentionCaret)
    setDraft(next)
    setMentionQuery(null)
    setMentionIndex(0)
    const pos = mentionAnchor + insert.length
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (el) {
        el.focus()
        el.setSelectionRange(pos, pos)
      }
    })
  }

  async function handleSend() {
    const text = draft.trim()
    if ((!text && attachments.length === 0) || sending) return
    if (!userId) return
    setSending(true)
    setError(null)

    // Upload any staged files first; collect their storage keys + metadata.
    const uploaded: ChatAttachment[] = []
    for (const a of attachments) {
      const ext = extForFile(a.name, a.type)
      const path = `${userId}/${crypto.randomUUID()}${ext ? '.' + ext : ''}`
      const { error: upErr } = await supabase.storage
        .from(CHAT_BUCKET)
        .upload(path, a.blob, { contentType: a.type || 'application/octet-stream', upsert: false })
      if (upErr) {
        if (uploaded.length > 0) {
          await supabase.storage.from(CHAT_BUCKET).remove(uploaded.map((u) => u.path))
        }
        setSending(false)
        setError(upErr.message || 'Could not upload a file. Please try again.')
        return
      }
      uploaded.push({ path, name: a.name, type: a.type, size: a.blob.size })
    }

    // Push targets are computed from the text against known member names, so
    // both picking from the list and typing "@Full Name" register a mention.
    // DMs never carry mentions — the DM push already targets the recipient.
    const lower = text.toLowerCase()
    const mentionedIds =
      activeThread === 'team'
        ? [
            ...new Set(
              mentionCandidates
                .filter((m) => m.name && lower.includes('@' + m.name.toLowerCase()))
                .map((m) => m.id),
            ),
          ]
        : []
    const res = await send(text, mentionedIds, uploaded)
    setSending(false)
    if (!res.ok) {
      if (uploaded.length > 0) {
        await supabase.storage.from(CHAT_BUCKET).remove(uploaded.map((u) => u.path))
      }
      setError(res.error || 'Could not send your message. Please try again.')
      return
    }
    for (const a of attachments) URL.revokeObjectURL(a.url)
    setAttachments([])
    setDraft('')
    setMentionQuery(null)
    // Sending always returns you to the latest message, even if you'd
    // scrolled up to re-read something before replying.
    stickToBottomRef.current = true
    scrollPositionsRef.current.set(activeThread, 'bottom')
    const el = scrollRef.current
    if (el) scrollToBottom(el)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (mentionQuery !== null && filtered.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMentionIndex((i) => (i + 1) % filtered.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMentionIndex((i) => (i - 1 + filtered.length) % filtered.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        selectMention(filtered[Math.min(mentionIndex, filtered.length - 1)])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMentionQuery(null)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSend()
    }
  }

  const others = presence.filter((m) => m.userId !== userId)

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Presence strip */}
      <div className="flex items-center gap-3 border-b border-line-soft px-3 py-2">
        <StatusPicker />
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
          {others.length === 0 ? (
            <span className="truncate text-[14px] text-ink-mute sm:text-[12px]">No-one else here right now</span>
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
        <button
          type="button"
          onClick={() =>
            setSearchOpen((v) => {
              const next = !v
              if (!next) setSearch('')
              return next
            })
          }
          aria-pressed={searchOpen}
          aria-label={searchOpen ? 'Close search' : 'Search messages'}
          title="Search messages"
          className={[
            'flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full transition-colors',
            searchOpen ? 'bg-canvas text-ink' : 'text-ink-mute hover:bg-canvas hover:text-ink',
          ].join(' ')}
        >
          <SearchIcon size={15} aria-hidden="true" />
        </button>
        <SoundToggle />
      </div>

      {/* Thread switcher: the shared room + a private thread per teammate.
          Lives in the shared engine, so the dropdown / dock / page all show
          the same conversation. */}
      <div className="flex flex-shrink-0 flex-wrap items-center gap-1.5 border-b border-line-soft px-3 py-2">
        <ThreadPill
          label="Team"
          active={activeThread === 'team'}
          count={threadUnread.team ?? 0}
          onClick={() => setActiveThread('team')}
        />
        {mentionCandidates.map((m) => (
          <ThreadPill
            key={m.id}
            label={firstName(m.name)}
            active={activeThread === m.id}
            count={threadUnread[m.id] ?? 0}
            status={presenceByUser.get(m.id) ?? null}
            onClick={() => setActiveThread(m.id)}
          />
        ))}
      </div>

      {searchOpen && (
        <div className="flex items-center gap-2 border-b border-line-soft px-3 py-2">
          <SearchIcon size={14} className="text-ink-mute" aria-hidden="true" />
          <input
            type="search"
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search messages…"
            className="flex-1 bg-transparent text-[17px] text-ink outline-none placeholder:text-ink-dim sm:text-[13px]"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              aria-label="Clear search"
              className="text-ink-mute hover:text-ink"
            >
              <X size={14} aria-hidden="true" />
            </button>
          )}
        </div>
      )}

      {/* Messages. flex-col + the list's mt-auto bottom-anchors the thread, so
          a few messages sit just above the composer (history grows upward) —
          otherwise a tall panel (e.g. the docked rail) shows a big empty gap
          between the messages and the composer. */}
      <div
        ref={scrollRef}
        onScroll={onListScroll}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-3 py-3"
      >
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <div
              className="h-6 w-6 animate-spin rounded-full border-2 border-line motion-reduce:animate-none"
              style={{ borderTopColor: 'var(--c-ink)' }}
            />
          </div>
        ) : threadMessages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <p className="text-[17px] text-ink-soft sm:text-[14px]">No messages yet.</p>
            <p className="text-[15px] text-ink-mute sm:text-[13px]">
              {activePeer
                ? `This is a private conversation between you and ${firstName(activePeer.name)} — no-one else can see it.`
                : 'Say hello to the team.'}
            </p>
          </div>
        ) : shown.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            {searchingRemote ? (
              <p className="text-[15px] text-ink-mute sm:text-[13px]">Searching the full history…</p>
            ) : (
              <>
                <p className="text-[17px] text-ink-soft sm:text-[14px]">No matches</p>
                <p className="text-[15px] text-ink-mute sm:text-[13px]">Nothing matches “{search.trim()}”.</p>
              </>
            )}
          </div>
        ) : (
          <div ref={listRef} className="mt-auto">
            {/* Older history pager. Hidden while searching (the search already
                covers the full history server-side). */}
            {!searchQuery && historyFor(activeThread) !== 'exhausted' && (
              <div className="flex justify-center pb-2">
                <button
                  type="button"
                  onClick={() => void onLoadEarlier()}
                  disabled={historyFor(activeThread) === 'loading'}
                  className="rounded-full border border-line bg-surface px-3 py-1 text-[14px] font-medium text-ink-soft transition-colors hover:bg-canvas hover:text-ink disabled:opacity-60 sm:text-[12px]"
                >
                  {historyFor(activeThread) === 'loading' ? 'Loading…' : 'Show earlier messages'}
                </button>
              </div>
            )}
            {searchQuery && searchingRemote && (
              <p className="pb-2 text-center text-[13px] text-ink-mute sm:text-[11px]">
                Searching the full history…
              </p>
            )}
          <ul className="space-y-0">
            {shown.map((m, i) => {
              const prev = shown[i - 1]
              const grouped = isGroupedWithPrevious(prev, m)
              const showDay = !prev || dayKey(prev.created_at) !== dayKey(m.created_at)
              const mine = userId !== null && m.author_id === userId
              const canDelete = m.author_id === userId || isAdmin
              const msgReactions = groupReactions(reactionsByMessage.get(m.id) ?? [], userId)
              const authorAvatar = m.author_id
                ? membersById.get(m.author_id)?.avatarUrl ?? null
                : null
              // Prefer the roster's live colour over the copy frozen onto the
              // row when it was sent, so someone changing their colour
              // recolours their whole history at once rather than splitting it
              // into before-and-after. The frozen value is the fallback for an
              // author who has since left the roster.
              const authorColour =
                (m.author_id ? membersById.get(m.author_id)?.colour : null) ?? m.author_colour
              return (
                <li key={m.id}>
                  {showDay && (
                    <div className="my-3 flex items-center gap-3">
                      <span className="h-px flex-1 bg-line-soft" />
                      <span className="text-[13px] font-medium uppercase tracking-wide text-ink-mute sm:text-[11px]">
                        {dayLabel(m.created_at)}
                      </span>
                      <span className="h-px flex-1 bg-line-soft" />
                    </div>
                  )}
                  {/* Messenger-style split: your own messages sit on the left,
                      everyone else's on the right with their avatar on the
                      outer edge. flex-row-reverse flips a row without changing
                      the DOM order, so grouping/hover logic is identical on
                      both sides. */}
                  <div
                    className={[
                      'group flex items-start gap-2.5',
                      mine ? '' : 'flex-row-reverse',
                      grouped ? 'mt-0.5' : 'mt-2.5',
                    ].join(' ')}
                  >
                    {!mine && (
                      <div className="w-9 flex-shrink-0 sm:w-7">
                        {!grouped &&
                          (authorAvatar ? (
                            <img
                              src={authorAvatar}
                              alt=""
                              className="h-9 w-9 rounded-full object-cover sm:h-7 sm:w-7"
                              aria-hidden="true"
                            />
                          ) : (
                            <span
                              className="inline-flex h-9 w-9 items-center justify-center rounded-full font-mono text-[12px] font-medium text-white sm:h-7 sm:w-7 sm:text-[10px]"
                              style={{ backgroundColor: authorBadgeColour(authorColour) }}
                              aria-hidden="true"
                            >
                              {(m.author_initials ?? '?').slice(0, 2)}
                            </span>
                          ))}
                      </div>
                    )}
                    <div
                      className={[
                        'flex min-w-0 max-w-[85%] flex-col',
                        mine ? 'items-start' : 'items-end',
                      ].join(' ')}
                    >
                      {!grouped && (
                        <div className="flex items-baseline gap-2 px-1">
                          <span className="text-[13px] text-ink-mute sm:text-[11px]">{messageTime(m.created_at)}</span>
                          {/* Your own bubbles and DM threads don't need a name —
                              you know who you are, and a private thread has
                              exactly one other person. */}
                          {!mine && activeThread === 'team' && (
                            <span className="text-[15px] font-semibold text-ink sm:text-[13px]">
                              {firstName(m.author_name)}
                            </span>
                          )}
                        </div>
                      )}
                      <div className={['flex items-start gap-2', mine ? '' : 'flex-row-reverse'].join(' ')}>
                        {/* A wash of the author's own colour, so a glance down
                            the thread reads as "Chris, Chris, Donna" without
                            parsing names. 10% rather than the 14% used for
                            small chips — a bubble is a much larger filled area,
                            and above ~12% the tint starts competing with the
                            message text instead of sitting behind it. */}
                        <div
                          className={[
                            'min-w-0 rounded-[14px] px-3 py-1.5',
                            !grouped ? (mine ? 'rounded-tl-[5px]' : 'rounded-tr-[5px]') : '',
                          ].join(' ')}
                          style={{ backgroundColor: designerTint(authorColour, 10) }}
                        >
                          {m.body && (
                            <p className="whitespace-pre-wrap break-words text-[19px] leading-snug text-ink-soft sm:text-[14px]">
                              {buildMessageSegments(m.body, memberNames).map((seg, si) =>
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
                                ) : seg.type === 'mention' ? (
                                  <span
                                    key={si}
                                    className="rounded bg-brand-50 px-1 font-medium text-brand"
                                  >
                                    {seg.value}
                                  </span>
                                ) : (
                                  <span key={si}>{seg.value}</span>
                                ),
                              )}
                            </p>
                          )}
                          {attachmentsOf(m).length > 0 && (
                            <ChatAttachments files={attachmentsOf(m)} />
                          )}
                          {msgReactions.length > 0 && (
                            <div className="mt-1 flex flex-wrap gap-1">
                              {msgReactions.map((g) => (
                                <button
                                  key={g.emoji}
                                  type="button"
                                  onClick={() => toggleReaction(m.id, g.emoji)}
                                  title={g.names.map((n) => firstName(n)).join(', ')}
                                  className={[
                                    'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[14px] leading-none transition-colors sm:text-[12px]',
                                    g.mine
                                      ? 'border-brand bg-brand-50 text-ink'
                                      : 'border-line bg-surface text-ink-soft hover:bg-canvas',
                                  ].join(' ')}
                                >
                                  <span>{g.emoji}</span>
                                  <span className="font-medium">{g.count}</span>
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                        {/* React / delete. These were hover-reveal only, so on
                            a phone — where Chat is a first-class bottom tab and
                            the primary chat surface — you could read and send
                            but never react or delete your own message. Always
                            visible below md (no hover exists to reveal them);
                            hover/focus-reveal kept on desktop. */}
                        <div className="mt-0.5 flex flex-shrink-0 items-center gap-0.5 transition-opacity max-md:opacity-100 md:opacity-0 focus-within:opacity-100 md:group-hover:opacity-100">
                          {/* The picker opens over the bubble side, where
                              there's guaranteed room inside the panel. */}
                          <ReactButton messageId={m.id} pickerAnchor={mine ? 'right' : 'left'} />
                          {canDelete && (
                            <button
                              type="button"
                              onClick={() => void remove(m.id)}
                              aria-label="Delete message"
                              title="Delete"
                              className="flex h-6 w-6 max-md:h-11 max-md:w-11 items-center justify-center rounded text-ink-mute hover:bg-canvas hover:text-out focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--c-focus)]"
                            >
                              <Trash2 size={14} aria-hidden="true" />
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
          </div>
        )}
      </div>

      {/* Composer */}
      <div
        {...zoneProps}
        className={[
          'relative border-t border-line-soft p-2.5 transition-colors',
          isZoneDragOver ? 'bg-brand-50' : '',
        ].join(' ')}
      >
        {typingUsers.length > 0 && (
          <div className="mb-1.5 text-[14px] italic text-ink-mute sm:text-[12px]" aria-live="polite">
            {typingLabel(typingUsers)}
          </div>
        )}
        {/* @mention autocomplete — opens upward above the composer. */}
        {mentionQuery !== null && filtered.length > 0 && (
          <div className="absolute inset-x-2.5 bottom-full z-10 mb-1 max-h-52 overflow-y-auto rounded-[10px] border border-line bg-surface shadow-lg">
            {filtered.map((m, i) => (
              <button
                key={m.id}
                type="button"
                // onMouseDown (not onClick) so selecting doesn't blur the textarea first.
                onMouseDown={(e) => {
                  e.preventDefault()
                  selectMention(m)
                }}
                onMouseEnter={() => setMentionIndex(i)}
                className={[
                  'flex w-full items-center gap-2 px-3 py-2 text-left text-[15px] sm:text-[13px]',
                  i === mentionIndex ? 'bg-canvas' : 'hover:bg-canvas',
                ].join(' ')}
              >
                {m.avatarUrl ? (
                  <img
                    src={m.avatarUrl}
                    alt=""
                    className="h-8 w-8 rounded-full object-cover sm:h-6 sm:w-6"
                    aria-hidden="true"
                  />
                ) : (
                  <span
                    className="inline-flex h-8 w-8 items-center justify-center rounded-full font-mono text-[11px] font-medium text-white sm:h-6 sm:w-6 sm:text-[9px]"
                    style={{ backgroundColor: authorBadgeColour(m.colour) }}
                    aria-hidden="true"
                  >
                    {(m.initials ?? '?').slice(0, 2)}
                  </span>
                )}
                <span className="font-medium text-ink">{m.name ?? 'Someone'}</span>
              </button>
            ))}
          </div>
        )}

        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {attachments.map((a) => {
              const Icon = fileKindIcon(a.name, a.type)
              const meta = [kindLabel(a.name, a.type), formatBytes(a.blob.size)]
                .filter(Boolean)
                .join(' · ')
              return (
                <div
                  key={a.id}
                  className={[
                    'relative overflow-hidden rounded-lg border border-line',
                    isImageType(a.type)
                      ? 'h-14 w-14'
                      : 'flex h-14 max-w-[180px] items-center gap-2 bg-canvas pl-2 pr-6',
                  ].join(' ')}
                >
                  {isImageType(a.type) ? (
                    <img src={a.url} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <>
                      <Icon size={18} aria-hidden="true" className="flex-shrink-0 text-ink-mute" />
                      <span className="min-w-0">
                        <span className="block truncate text-[12px] font-medium text-ink sm:text-[11px]">{a.name}</span>
                        {meta && <span className="block text-[11px] text-ink-mute sm:text-[10px]">{meta}</span>}
                      </span>
                    </>
                  )}
                  <button
                    type="button"
                    onClick={() => removeAttachment(a.id)}
                    aria-label="Remove attachment"
                    className="absolute right-0.5 top-0.5 rounded-full bg-black/55 p-0.5 text-white hover:bg-black/75"
                  >
                    <X size={11} aria-hidden="true" />
                  </button>
                </div>
              )
            })}
          </div>
        )}
        {error && (
          <p role="alert" className="mb-2 rounded-lg bg-out-soft px-3 py-1.5 text-[12px] text-out">
            {error}
          </p>
        )}
        <div className="flex items-end gap-2">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={attachments.length >= MAX_ATTACHMENTS}
            aria-label="Attach a file"
            title="Attach a file"
            className="inline-flex h-[42px] w-[42px] flex-shrink-0 items-center justify-center rounded-[8px] border border-line bg-surface text-ink-soft transition-colors hover:bg-canvas disabled:opacity-40"
          >
            <Paperclip size={18} aria-hidden="true" />
          </button>
          <Textarea
            ref={textareaRef}
            value={draft}
            onChange={onDraftChange}
            onKeyDown={onKeyDown}
            onPaste={handlePaste}
            rows={variant === 'page' ? 2 : 1}
            placeholder={activePeer ? `Message ${firstName(activePeer.name)}…` : 'Message the team…'}
            // 16px on phones: anything smaller makes iOS Safari zoom the whole
            // page when the composer is focused. (! outranks the component's
            // own text-sm.)
            className="flex-1 max-sm:text-[17px]!"
          />
          <button
            type="button"
            onClick={() => void handleSend()}
            disabled={(!draft.trim() && attachments.length === 0) || sending}
            aria-label="Send message"
            className="inline-flex h-[42px] w-[42px] flex-shrink-0 items-center justify-center rounded-[8px] bg-ink text-on-ink transition-colors hover:bg-ink-soft disabled:opacity-40"
          >
            <Send size={18} aria-hidden="true" />
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          multiple
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={(e) => {
            addFiles(Array.from(e.target.files ?? []))
            e.target.value = ''
          }}
        />
        <p className="mt-1.5 text-[13px] text-ink-dim sm:text-[11px]">
          {activePeer
            ? `Private to ${firstName(activePeer.name)} · paste or drop any file (up to ${MAX_MB} MB) · Enter to send`
            : `@ to mention · paste or drop any file (up to ${MAX_MB} MB) · Enter to send · Shift + Enter for a new line`}
        </p>
      </div>
    </div>
  )
}
