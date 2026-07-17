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
} from '../lib/teamChat'

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
                <span className="block truncate text-[12px] font-medium text-ink">{f.name || 'File'}</span>
                {meta && <span className="block text-[11px] text-ink-mute">{meta}</span>}
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

// The hover "react" button + its emoji picker.
function ReactButton({ messageId }: { messageId: string }) {
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
        <div className="absolute right-0 top-7 z-30 flex gap-0.5 rounded-full border border-line bg-surface p-1 shadow-md">
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

// The shared chat body — presence strip + message list + composer — used by
// the header dropdown (variant="dropdown"), the full /chat page
// (variant="page") and the dashboard rail dock (variant="docked"). It reads
// everything from the TeamChatProvider, so every surface stays perfectly in
// sync. The parent sizes it (it fills its height).

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
  const names = users.map((u) => u.name ?? 'Someone')
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
  const searchQuery = search.trim().toLowerCase()
  const shown = useMemo(() => {
    if (!searchQuery) return messages
    return messages.filter(
      (m) =>
        m.body.toLowerCase().includes(searchQuery) ||
        (m.author_name ?? '').toLowerCase().includes(searchQuery),
    )
  }, [messages, searchQuery])
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

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, loading])

  function onDraftChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const value = e.target.value
    setDraft(value)
    if (value.trim()) notifyTyping()
    const caret = e.target.selectionStart ?? value.length
    const det = detectMention(value, caret)
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
    const lower = text.toLowerCase()
    const mentionedIds = [
      ...new Set(
        mentionCandidates
          .filter((m) => m.name && lower.includes('@' + m.name.toLowerCase()))
          .map((m) => m.id),
      ),
    ]
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

      {searchOpen && (
        <div className="flex items-center gap-2 border-b border-line-soft px-3 py-2">
          <SearchIcon size={14} className="text-ink-mute" aria-hidden="true" />
          <input
            type="search"
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search messages…"
            className="flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-dim"
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
        ) : shown.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <p className="text-[14px] text-ink-soft">No matches</p>
            <p className="text-[13px] text-ink-mute">Nothing matches “{search.trim()}”.</p>
          </div>
        ) : (
          <ul className="space-y-0">
            {shown.map((m, i) => {
              const prev = shown[i - 1]
              const grouped = isGroupedWithPrevious(prev, m)
              const showDay = !prev || dayKey(prev.created_at) !== dayKey(m.created_at)
              const canDelete = m.author_id === userId || isAdmin
              const msgReactions = groupReactions(reactionsByMessage.get(m.id) ?? [], userId)
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
                        <div className="min-w-0 flex-1">
                          {m.body && (
                            <p className="whitespace-pre-wrap break-words text-[14px] leading-snug text-ink-soft">
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
                                  title={g.names.join(', ')}
                                  className={[
                                    'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[12px] leading-none transition-colors',
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
                        <div className="mt-0.5 flex flex-shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                          <ReactButton messageId={m.id} />
                          {canDelete && (
                            <button
                              type="button"
                              onClick={() => void remove(m.id)}
                              aria-label="Delete message"
                              title="Delete"
                              className="flex h-6 w-6 items-center justify-center rounded text-ink-mute hover:bg-canvas hover:text-out"
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
          <div className="mb-1.5 text-[12px] italic text-ink-mute" aria-live="polite">
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
                  'flex w-full items-center gap-2 px-3 py-2 text-left text-[13px]',
                  i === mentionIndex ? 'bg-canvas' : 'hover:bg-canvas',
                ].join(' ')}
              >
                <span
                  className="inline-flex h-6 w-6 items-center justify-center rounded-full font-mono text-[9px] font-medium text-white"
                  style={{ backgroundColor: authorBadgeColour(m.colour) }}
                  aria-hidden="true"
                >
                  {(m.initials ?? '?').slice(0, 2)}
                </span>
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
                        <span className="block truncate text-[11px] font-medium text-ink">{a.name}</span>
                        {meta && <span className="block text-[10px] text-ink-mute">{meta}</span>}
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
            placeholder="Message the team… @ to mention"
            className="flex-1"
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
        <p className="mt-1.5 text-[11px] text-ink-dim">
          @ to mention · paste or drop any file (up to {MAX_MB} MB) · Enter to send · Shift + Enter for a
          new line
        </p>
      </div>
    </div>
  )
}
