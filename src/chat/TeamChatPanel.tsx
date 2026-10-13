import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type ReactNode,
} from 'react'
import {
  ArrowUp,
  AtSign,
  Bell,
  Check,
  ChevronLeft,
  Copy,
  Download,
  FileIcon,
  FileText,
  MoreHorizontal,
  Paperclip,
  SearchIcon,
  Smile,
  Sparkle,
  Trash2,
  Users,
  Volume2,
  X,
} from './icons'
import { useImageFileDrop } from './useFileDrop'
import { playChatSound } from './sound'
import {
  CHAT_ALERT_LEVELS,
  alertPermission,
  requestAlertPermission,
  type ChatAlertLevel,
} from './desktopAlert'
import { useTeamChat } from './store'
import {
  attachmentsOf,
  authorBadgeColour,
  buildMessageSegments,
  dayKey,
  dayLabel,
  formatBytes,
  isGroupedWithPrevious,
  messageTime,
} from './message'
import {
  CHAT_BUCKET,
  CHAT_STATUS_META,
  type ChatAttachment,
  type ChatLinkComponent,
  type ChatStatus,
  type ChatThread,
  type ReactionRow,
  type TeamMember,
  type TeamMessage,
} from './types'

const EMOJI_CHOICES = ['👍', '❤️', '😂', '🎉', '👀', '✅', '🙏']
const MAX_ATTACHMENTS = 6
const MAX_MB = 25
const MAX_BYTES = MAX_MB * 1024 * 1024 // matches the 000323 bucket cap

// Below this width the full page draws its conversations as chips above the
// thread, as the dropdown does; above it they are a list beside the thread.
const PAGE_WIDE_PX = 760
// Below this the page is a phone: the list and the thread take turns.
const PAGE_PHONE_PX = 640

// What an empty thread with the assistant offers as a start. Examples in
// code, not a history: the point is to show the kind of question it answers.
const BOT_SUGGESTIONS = [
  'Where has the latest order for a customer got to?',
  'Has this customer ordered before?',
  'What does 500 gold cards cost?',
  'How do I park a sale?',
]

/**
 * One entry in the panel's ⋯ menu, provided by the host surface: where chat
 * lives (pop out, dock, the full page) and whether it stays open. The panel
 * owns the rest of the menu (sounds, alerts, status) itself.
 */
export interface ChatPlacementItem {
  key: string
  label: string
  icon?: ReactNode
  /** An action. Closing the menu is the panel's job. */
  onSelect?: () => void
  /** A router link instead of an action, rendered through `linkComponent`. */
  to?: string
  /** A toggle: drawn with its state, as "on" / "off". */
  checked?: boolean
}

interface TeamChatPanelProps {
  variant: 'dropdown' | 'page' | 'docked' | 'popout'
  /** The ⋯ menu's first section. See `ChatPlacementItem`. */
  placementItems?: ChatPlacementItem[]
  /** A control at the far right of the header: close, undock, back. */
  headerAction?: ReactNode
  /** The host's router link, for `to` items. Defaults to a plain anchor. */
  linkComponent?: ChatLinkComponent
}

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

function firstName(name: string | null | undefined): string {
  const n = (name ?? '').trim()
  return n ? n.split(/\s+/)[0] : 'Teammate'
}

function statusDotClass(status: ChatStatus | null | undefined): string {
  return `pd-chat__dot pd-chat__dot--${status ?? 'offline'}`
}

// A conversation row's time: the clock today, the weekday this week, else
// the date. Short, because it sits at the end of a 64px row.
function rowTime(iso: string): string {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return ''
  const now = new Date()
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diffDays = Math.round((startOf(now) - startOf(d)) / 86_400_000)
  if (diffDays === 0) return messageTime(iso)
  if (diffDays === 1) return 'Yest'
  if (diffDays < 7) return d.toLocaleDateString('en-GB', { weekday: 'short' })
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

// Binds outside-click and Escape to the document the element is actually in,
// not the app's: popped out into a picture-in-picture window the panel lives
// in a second document, where a listener on the main one never sees either.
function useCloseOnOutside(open: boolean, ref: React.RefObject<HTMLElement | null>, close: () => void) {
  useEffect(() => {
    if (!open) return
    const doc = ref.current?.ownerDocument ?? document
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) close()
    }
    // Escape closes the innermost thing. Heard in the capture phase and
    // stopped there, so the dropdown's own Escape (which closes the whole
    // panel) does not fire for the same press.
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      close()
    }
    doc.addEventListener('mousedown', onDoc)
    doc.addEventListener('keydown', onKey, true)
    return () => {
      doc.removeEventListener('mousedown', onDoc)
      doc.removeEventListener('keydown', onKey, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
}

// ── Small parts ────────────────────────────────────────────────────────────

// The team chat assistant's tag ("AI") and avatar. Claude is not a person:
// it never holds a presence, so instead of a status dot (which would read as
// "offline") it carries a tag, and instead of initials a spark.
// ⚠ Both class names are read by proof-viewer's e2e specs; keep them.
export function BotTag() {
  return (
    <span className="pd-chat__bot-tag" title="The team chat assistant. It looks things up; it cannot change anything.">
      AI
    </span>
  )
}

function BotAvatar({ size }: { size: 'xs' | 'sm' | 'md' | 'lg' | 'xl' }) {
  const px = { xs: 18, sm: 22, md: 28, lg: 32, xl: 44 }[size]
  const glyph = { xs: 10, sm: 12, md: 14, lg: 16, xl: 20 }[size]
  return (
    <span className="pd-chat__bot-avatar" style={{ width: px, height: px }} aria-hidden="true">
      <Sparkle size={glyph} />
    </span>
  )
}

type AvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl'

// A person's avatar: their photo, or their initials on their identity
// colour, with an optional presence dot.
function PersonAvatar({
  size,
  initials,
  colour,
  avatarUrl,
  status,
}: {
  size: AvatarSize
  initials: string | null | undefined
  colour: string | null | undefined
  avatarUrl?: string | null
  /** A ChatStatus, null = offline, undefined = no dot. */
  status?: ChatStatus | null
}) {
  return (
    <span
      className={`pd-chat__av pd-chat__av--${size}`}
      style={avatarUrl ? undefined : { backgroundColor: authorBadgeColour(colour ?? null) }}
      aria-hidden="true"
    >
      {avatarUrl ? <img src={avatarUrl} alt="" /> : (initials ?? '?').slice(0, 2)}
      {status !== undefined && <span className={statusDotClass(status)} />}
    </span>
  )
}

function TeamAvatar({ size }: { size: AvatarSize }) {
  const glyph = { xs: 10, sm: 12, md: 14, lg: 16, xl: 18 }[size]
  return (
    <span className={`pd-chat__av pd-chat__av--${size} pd-chat__av--team`} aria-hidden="true">
      <Users size={glyph} />
    </span>
  )
}

// One avatar for any thread party: the room, a person, or the assistant.
function ThreadAvatar({
  thread,
  member,
  status,
  size,
}: {
  thread: ChatThread
  member: TeamMember | null
  status?: ChatStatus | null
  size: AvatarSize
}) {
  if (thread === 'team') return <TeamAvatar size={size} />
  if (member?.isBot) return <BotAvatar size={size} />
  return (
    <PersonAvatar
      size={size}
      initials={member?.initials}
      colour={member?.colour}
      avatarUrl={member?.avatarUrl}
      status={status}
    />
  )
}

function UnreadCount({ count, room }: { count: number; room?: boolean }) {
  if (count <= 0) return null
  return (
    <span className={['pd-chat__count', room ? 'pd-chat__count--room' : ''].filter(Boolean).join(' ')} aria-label={`${count} unread`}>
      {count > 9 ? '9+' : count}
    </span>
  )
}

// Renders a message's attachments: images preview as thumbnails (private
// bucket → signed URLs, full-screen on click); any other file shows a
// downloadable chip carrying its original name / kind / size (000323).
function ChatAttachments({ files }: { files: ChatAttachment[] }) {
  // This is its own component rather than part of the panel, so it reads the
  // client from the store the same way the panel does. The bucket is private,
  // so every image needs a signed URL before it can be rendered at all.
  const { config } = useTeamChat()
  const [urls, setUrls] = useState<string[]>([])
  const [lightbox, setLightbox] = useState<string | null>(null)
  const key = files.map((f) => f.path).join(',')
  useEffect(() => {
    if (!config) return
    let cancelled = false
    void (async () => {
      const { data } = await config.client.storage
        .from(CHAT_BUCKET)
        .createSignedUrls(
          files.map((f) => f.path),
          3600,
        )
      if (cancelled) return
      setUrls((data ?? []).map((d: { signedUrl: string | null }) => d.signedUrl ?? ''))
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, config])

  if (urls.length === 0) return null
  return (
    <>
      <div className="pd-chat__files">
        {files.map((f, i) => {
          const url = urls[i]
          if (!url) return null
          if (isImageType(f.type)) {
            return (
              <button key={i} type="button" onClick={() => setLightbox(url)} className="pdc-text-left">
                <span className="pd-chat__thumb">
                  <img src={url} alt={f.name || 'Attachment'} loading="lazy" />
                </span>
                {f.name && <span className="pd-chat__thumb-caption">{f.name}</span>}
              </button>
            )
          }
          // Force a download with the real filename via the signed URL's
          // ?download param (the stored key is a random uuid).
          const href = `${url}${url.includes('?') ? '&' : '?'}download=${encodeURIComponent(f.name || 'file')}`
          const meta = [kindLabel(f.name, f.type), formatBytes(f.size)].filter(Boolean).join(' · ')
          return (
            <a
              key={i}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              title={`Download ${f.name}`}
              className="pd-chat__file"
            >
              <span className="pd-chat__file-kind">{kindLabel(f.name, f.type).slice(0, 4) || 'FILE'}</span>
              <span className="pd-chat__file-text">
                <span className="pd-chat__file-name">{f.name || 'File'}</span>
                {meta && <span className="pd-chat__file-meta">{meta}</span>}
              </span>
              <Download size={14} aria-hidden="true" className="pdc-text-ink-dim" />
            </a>
          )
        })}
      </div>
      {lightbox && (
        <div className="pd-chat__lightbox" onClick={() => setLightbox(null)} role="dialog" aria-modal="true">
          <img src={lightbox} alt="Attachment" onClick={(e) => e.stopPropagation()} />
          <button type="button" onClick={() => setLightbox(null)} aria-label="Close image" className="pd-chat__lightbox-close">
            <X size={20} aria-hidden="true" />
          </button>
        </div>
      )}
    </>
  )
}

// The hover toolbar's "react" button + its emoji picker.
function ReactButton({ messageId, onOpenChange }: { messageId: string; onOpenChange: (open: boolean) => void }) {
  const { toggleReaction } = useTeamChat()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useCloseOnOutside(open, ref, () => setOpen(false))
  useEffect(() => onOpenChange(open), [open, onOpenChange])

  return (
    <div ref={ref} className="pdc-relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Add reaction"
        title="React"
        className="pd-chat__tool"
      >
        <Smile size={14} aria-hidden="true" />
      </button>
      {open && (
        <div className="pd-chat__picker pd-chat__picker--right">
          {EMOJI_CHOICES.map((e) => (
            <button
              key={e}
              type="button"
              onClick={() => {
                toggleReaction(messageId, e)
                setOpen(false)
              }}
              aria-label={`React ${e}`}
            >
              {e}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// One chip in the conversation row: the Team room, a teammate, or Claude.
// Carries that thread's unread count and (for people) a presence dot.
function ThreadChip({
  thread,
  label,
  member,
  active,
  count,
  status,
  onClick,
}: {
  thread: ChatThread
  label: string
  member: TeamMember | null
  active: boolean
  count: number
  status?: ChatStatus | null
  onClick: () => void
}) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active} className="pd-chat__chip">
      <ThreadAvatar thread={thread} member={member} status={status} size="xs" />
      {label}
      <UnreadCount count={count} room={thread === 'team'} />
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

// ── The ⋯ menu ─────────────────────────────────────────────────────────────
// Every setting and every "where does chat live" choice, in one place, in
// every placement. The placement items come from the host; the rest is the
// panel's own.

const SETTABLE: { value: 'online' | 'away' | 'busy'; label: string }[] = [
  { value: 'online', label: 'Online' },
  { value: 'away', label: 'Away' },
  { value: 'busy', label: 'Busy' },
]

function PanelMenu({
  items,
  linkComponent: As,
}: {
  items: ChatPlacementItem[]
  linkComponent?: ChatLinkComponent
}) {
  const {
    myStatus,
    setManualStatus,
    soundEnabled,
    setSoundEnabled,
    alertLevel,
    setAlertLevel,
    peekEnabled,
    setPeekEnabled,
  } = useTeamChat()
  const [open, setOpen] = useState(false)
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(() => alertPermission())
  const ref = useRef<HTMLDivElement>(null)
  useCloseOnOutside(open, ref, () => setOpen(false))

  const alertsSupported = permission !== 'unsupported'
  const blocked = permission === 'denied'
  // Nothing appears unless the browser has been asked and said yes, so the
  // value reports what is really happening rather than what has been chosen.
  const alertValue = !alertsSupported
    ? null
    : blocked
      ? 'blocked'
      : alertLevel === 'off' || permission !== 'granted'
        ? 'off'
        : alertLevel

  async function choose(level: ChatAlertLevel) {
    if (level !== 'off' && permission !== 'granted') {
      // This is a click, which is the only context Safari will accept a
      // permission request from, and asking on load burns the single chance.
      const result = await requestAlertPermission()
      setPermission(result)
      if (result !== 'granted') return // leave the old level; nothing would show
    }
    setAlertLevel(level)
    setOpen(false)
  }

  return (
    <div ref={ref} className="pdc-relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More options"
        title="More"
        className="pd-chat__ib"
      >
        <MoreHorizontal size={16} aria-hidden="true" />
      </button>
      {open && (
        <div role="menu" className="pd-chat__menu">
          {items.map((it) => {
            if (it.to) {
              const props = {
                role: 'menuitem',
                className: 'pd-chat__menu-item',
                onClick: () => {
                  setOpen(false)
                  it.onSelect?.()
                },
              }
              return As ? (
                <As key={it.key} to={it.to} {...props}>
                  {it.icon}
                  {it.label}
                </As>
              ) : (
                <a key={it.key} href={it.to} {...props}>
                  {it.icon}
                  {it.label}
                </a>
              )
            }
            if (it.checked !== undefined) {
              return (
                <button
                  key={it.key}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={it.checked}
                  onClick={() => {
                    it.onSelect?.()
                    setOpen(false)
                  }}
                  className="pd-chat__menu-item"
                >
                  {it.icon}
                  {it.label}
                  <span className={['pd-chat__menu-value', it.checked ? 'pd-chat__menu-value--on' : ''].join(' ')}>
                    {it.checked ? 'on' : 'off'}
                  </span>
                </button>
              )
            }
            return (
              <button
                key={it.key}
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false)
                  it.onSelect?.()
                }}
                className="pd-chat__menu-item"
              >
                {it.icon}
                {it.label}
              </button>
            )
          })}
          {items.length > 0 && <div className="pd-chat__menu-divider" />}

          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={soundEnabled}
            onClick={() => {
              const next = !soundEnabled
              setSoundEnabled(next)
              if (next) playChatSound('general') // confirm + unlock audio on enable
            }}
            className="pd-chat__menu-item"
          >
            <Volume2 size={15} aria-hidden="true" />
            Sounds
            <span className={['pd-chat__menu-value', soundEnabled ? 'pd-chat__menu-value--on' : ''].join(' ')}>
              {soundEnabled ? 'on' : 'off'}
            </span>
          </button>
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={peekEnabled}
            onClick={() => setPeekEnabled(!peekEnabled)}
            className="pd-chat__menu-item"
          >
            <MoreHorizontal size={15} aria-hidden="true" style={{ visibility: 'hidden' }} />
            Show a new message here
            <span className={['pd-chat__menu-value', peekEnabled ? 'pd-chat__menu-value--on' : ''].join(' ')}>
              {peekEnabled ? 'on' : 'off'}
            </span>
          </button>

          {alertsSupported && (
            <>
              <div className="pd-chat__menu-heading">Desktop alerts</div>
              {CHAT_ALERT_LEVELS.map((l) => (
                <button
                  key={l.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={alertLevel === l.value}
                  disabled={blocked && l.value !== 'off'}
                  onClick={() => void choose(l.value)}
                  className="pd-chat__menu-item"
                >
                  <Bell size={15} aria-hidden="true" style={{ visibility: alertValue === l.value ? 'visible' : 'hidden' }} />
                  {l.label}
                  {alertLevel === l.value && <Check size={14} aria-hidden="true" className="pd-chat__menu-value pd-chat__menu-value--on" />}
                </button>
              ))}
              {blocked && (
                <p className="pd-chat__menu-note">
                  Your browser is blocking notifications for this site. Turn them back on in its site settings.
                </p>
              )}
            </>
          )}

          <div className="pd-chat__menu-divider" />
          <div className="pd-chat__menu-heading">My status</div>
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
              className="pd-chat__menu-item"
            >
              <span className={`pd-chat__status-dot pd-chat__dot--${s.value}`} aria-hidden="true" />
              {s.label}
              {myStatus === s.value && <Check size={14} aria-hidden="true" className="pd-chat__menu-value pd-chat__menu-value--on" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── The panel ──────────────────────────────────────────────────────────────
// The shared chat body — thread header, conversation chips (or, on the full
// page, a list beside the thread), message list and composer — used by the
// header dropdown, the /chat page, the dashboard rail dock and the popout
// window. It reads everything from the TeamChatProvider, so every surface
// stays in sync (including which thread is open). The parent sizes it.

export default function TeamChatPanel({
  variant,
  placementItems = [],
  headerAction,
  linkComponent,
}: TeamChatPanelProps) {
  const {
    config,
    db,
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

  // Identity and capability come from the host through the store, not from an
  // auth module: each of the four apps has its own, with its own shape.
  const userId = config?.userId ?? null
  const isAdmin = config?.isAdmin ?? false

  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [attachments, setAttachments] = useState<StagedAttachment[]>([])
  const fileRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  // The page measures itself to pick its shape; the other variants are
  // always the one-column chips-over-thread layout.
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = rootRef.current
    if (!el || variant !== 'page' || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0
      setWidth(w)
    })
    ro.observe(el)
    setWidth(el.getBoundingClientRect().width)
    return () => ro.disconnect()
  }, [variant])
  const pageWide = variant === 'page' && width >= PAGE_WIDE_PX
  const pagePhone = variant === 'page' && width > 0 && width < PAGE_PHONE_PX
  // On a phone the list and the thread take turns. Opening the page lands on
  // the list; a row opens its thread; back returns.
  const [phoneThreadOpen, setPhoneThreadOpen] = useState(false)
  const showingList = pagePhone && !phoneThreadOpen

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
  const memberNames = useMemo(() => members.map((m) => m.name ?? '').filter(Boolean), [members])
  // The DM peer when a private thread is open; null in the team room.
  const activePeer = useMemo(
    () => (activeThread === 'team' ? null : members.find((m) => m.id === activeThread) ?? null),
    [activeThread, members],
  )
  const bot = useMemo(() => members.find((m) => m.isBot) ?? null, [members])
  // Author → profile lookup, so message avatars can use uploaded profile
  // pictures (avatar_url isn't denormalised on the message rows).
  const membersById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members])
  const presenceByUser = useMemo(() => new Map(presence.map((p) => [p.userId, p.status])), [presence])
  const others = presence.filter((m) => m.userId !== userId)

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

  // The newest message in every thread, for the conversation list.
  const latestByThread = useMemo(() => {
    const map = new Map<ChatThread, TeamMessage>()
    for (const m of messages) {
      const thread: ChatThread = !m.recipient_id ? 'team' : m.author_id === userId ? (m.recipient_id as ChatThread) : (m.author_id as ChatThread)
      const cur = map.get(thread)
      if (!cur || cur.created_at < m.created_at) map.set(thread, m)
    }
    return map
  }, [messages, userId])

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
          let q = db!.from('team_messages').select('*')
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

  // A mounted panel is a chat surface being looked at, with one exception:
  // the phone's conversation list, where the open thread is not on screen,
  // so its messages must not be stamped read.
  useEffect(() => {
    setViewing(!showingList)
    return () => setViewing(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showingList])

  // ── The "New" rule ────────────────────────────────────────────────────
  // Marks where you left off: placed above the first unread message when a
  // thread opens, removed when you next send. The count is read from the
  // PREVIOUS render's snapshot, because by the time the thread has changed
  // the store has already stamped it read and zeroed the count.
  const unreadSnapshotRef = useRef(threadUnread)
  const [newMarkerId, setNewMarkerId] = useState<string | null>(null)
  useEffect(() => {
    const n = unreadSnapshotRef.current[activeThread] ?? 0
    if (n <= 0) {
      setNewMarkerId(null)
      return
    }
    const fromOthers = threadMessages.filter((m) => m.author_id !== userId)
    const target = fromOthers[fromOthers.length - n]
    setNewMarkerId(target?.id ?? null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeThread])
  useEffect(() => {
    unreadSnapshotRef.current = threadUnread
  })

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
    scrollPositionsRef.current.set(activeThread, stickToBottomRef.current ? 'bottom' : el.scrollTop)
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
  }, [activeThread, loading, showingList])

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
  }, [loading, activeThread, shown.length > 0, showingList])

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

  // The composer grows with its text, up to a few lines.
  function fitTextarea(el: HTMLTextAreaElement) {
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`
  }
  useEffect(() => {
    if (textareaRef.current) fitTextarea(textareaRef.current)
  }, [draft])

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

  // The hover toolbar's "mention" — start a reply naming the author.
  function mentionAuthor(m: TeamMessage) {
    const name = m.author_name ?? ''
    if (!name) return
    const prefix = `@${name} `
    setDraft((d) => (d.startsWith(prefix) ? d : prefix + d))
    requestAnimationFrame(() => textareaRef.current?.focus())
  }

  function applySuggestion(text: string) {
    setDraft(text)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (el) {
        el.focus()
        el.setSelectionRange(text.length, text.length)
      }
    })
  }

  async function copyText(m: TeamMessage) {
    try {
      await navigator.clipboard.writeText(m.body)
    } catch {
      /* no clipboard access — nothing to do */
    }
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
      const { error: upErr } = await config!.client.storage
        .from(CHAT_BUCKET)
        .upload(path, a.blob, { contentType: a.type || 'application/octet-stream', upsert: false })
      if (upErr) {
        if (uploaded.length > 0) {
          await config!.client.storage.from(CHAT_BUCKET).remove(uploaded.map((u) => u.path))
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
        await config!.client.storage.from(CHAT_BUCKET).remove(uploaded.map((u) => u.path))
      }
      setError(res.error || 'Could not send your message. Please try again.')
      return
    }
    for (const a of attachments) URL.revokeObjectURL(a.url)
    setAttachments([])
    setDraft('')
    setMentionQuery(null)
    setNewMarkerId(null)
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

  function openThread(thread: ChatThread) {
    setActiveThread(thread)
    if (pagePhone) setPhoneThreadOpen(true)
  }

  // ── Header copy ───────────────────────────────────────────────────────
  const peerStatus: ChatStatus | null | undefined = activePeer
    ? activePeer.isBot
      ? undefined
      : presenceByUser.get(activePeer.id) ?? null
    : undefined
  const headName = activeThread === 'team' ? 'Team' : activePeer?.name ?? 'Teammate'
  const headSub =
    activeThread === 'team'
      ? others.length > 0
        ? `${others.length} around · everyone on the team can see this`
        : 'Everyone on the team can see this'
      : activePeer?.isBot
        ? 'Reads the apps, never changes them · private to you'
        : `${peerStatus ? CHAT_STATUS_META[peerStatus].label : 'Offline'} · private to the two of you`

  const botTyping = bot !== null && typingUsers.some((u) => u.userId === bot.id)
  const peopleTyping = typingUsers.filter((u) => !bot || u.userId !== bot.id)

  // ── Pieces ────────────────────────────────────────────────────────────

  const chips = (
    <div className="pd-chat__chips">
      <ThreadChip
        thread="team"
        label="Team"
        member={null}
        active={activeThread === 'team'}
        count={threadUnread.team ?? 0}
        onClick={() => openThread('team')}
      />
      {mentionCandidates.map((m) => (
        <ThreadChip
          key={m.id}
          thread={m.id}
          label={firstName(m.name)}
          member={m}
          active={activeThread === m.id}
          count={threadUnread[m.id] ?? 0}
          status={m.isBot ? undefined : presenceByUser.get(m.id) ?? null}
          onClick={() => openThread(m.id)}
        />
      ))}
    </div>
  )

  // The conversation list for the page: Team first, then everyone by their
  // last message, those with none after, the assistant last among those.
  const listRows = useMemo(() => {
    const people = mentionCandidates.slice().sort((a, b) => {
      const la = latestByThread.get(a.id)?.created_at ?? ''
      const lb = latestByThread.get(b.id)?.created_at ?? ''
      if (la !== lb) return la > lb ? -1 : 1
      if (a.isBot !== b.isBot) return a.isBot ? 1 : -1
      return (a.name ?? '').localeCompare(b.name ?? '')
    })
    return people
  }, [mentionCandidates, latestByThread])

  function snippetFor(thread: ChatThread, member: TeamMember | null): string {
    const last = latestByThread.get(thread)
    if (last) {
      const who = last.author_id === userId ? 'You' : firstName(last.author_name)
      const text = last.body.trim() || 'Sent an attachment'
      return thread === 'team' || last.author_id === userId ? `${who}: ${text}` : text
    }
    if (thread === 'team') return 'Say hello to the team'
    if (member?.isBot) return 'Ask about a project, an order or a customer'
    return 'No messages yet'
  }

  const conversationList = (
    <div className={['pd-chat__convos', pagePhone ? 'pd-chat__convos--phone' : ''].filter(Boolean).join(' ')}>
      <div className="pd-chat__convos-head">
        <span className="pdc-t-title">{pagePhone ? 'Chat' : 'Conversations'}</span>
        <span className="pdc-t-caption pdc-text-ink-mute">
          {others.length > 0 ? `${others.length} around` : 'Nobody else around'}
        </span>
      </div>
      {pagePhone && others.length > 0 && (
        <div className="pd-chat__around">
          {others.slice(0, 8).map((p) => (
            <button key={p.userId} type="button" className="pd-chat__around-person" onClick={() => openThread(p.userId)}>
              <PersonAvatar size="xl" initials={p.initials} colour={p.colour} avatarUrl={p.avatarUrl} status={p.status} />
              <span className="pd-chat__around-name">{firstName(p.name)}</span>
            </button>
          ))}
        </div>
      )}
      <div className="pd-chat__convos-list">
        {(['team', ...listRows.map((m) => m.id)] as ChatThread[]).map((thread) => {
          const member = thread === 'team' ? null : membersById.get(thread) ?? null
          const count = threadUnread[thread] ?? 0
          const last = latestByThread.get(thread)
          const name = thread === 'team' ? 'Team' : member?.name ?? 'Teammate'
          return (
            <button
              key={thread}
              type="button"
              onClick={() => openThread(thread)}
              aria-pressed={!pagePhone && activeThread === thread}
              className={['pd-chat__row', count > 0 ? 'pd-chat__row--unread' : ''].filter(Boolean).join(' ')}
            >
              <ThreadAvatar
                thread={thread}
                member={member}
                status={member && !member.isBot ? presenceByUser.get(member.id) ?? null : undefined}
                size="xl"
              />
              <span className="pd-chat__row-text">
                <span className="pd-chat__row-name">
                  {name}
                  {member?.isBot && <BotTag />}
                </span>
                <span className="pd-chat__row-snip">{snippetFor(thread, member)}</span>
              </span>
              <span className="pd-chat__row-end">
                {last && <span className="pd-chat__row-time">{rowTime(last.created_at)}</span>}
                <UnreadCount count={count} room={thread === 'team'} />
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )

  const header = (
    <div className="pd-chat__head">
      {pagePhone && (
        <button type="button" className="pd-chat__ib" aria-label="Back to conversations" onClick={() => setPhoneThreadOpen(false)}>
          <ChevronLeft size={18} aria-hidden="true" />
        </button>
      )}
      <ThreadAvatar thread={activeThread} member={activePeer} status={peerStatus} size="lg" />
      <div className="pd-chat__head-text">
        <span className="pd-chat__head-name">
          {headName}
          {activePeer?.isBot && <BotTag />}
        </span>
        <span className="pd-chat__head-sub">{headSub}</span>
      </div>
      <div className="pd-chat__head-actions">
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
          aria-label={searchOpen ? 'Close search' : 'Search this conversation'}
          title="Search this conversation"
          className="pd-chat__ib"
        >
          <SearchIcon size={16} aria-hidden="true" />
        </button>
        <PanelMenu items={placementItems} linkComponent={linkComponent} />
        {headerAction}
      </div>
    </div>
  )

  const searchRow = searchOpen && (
    <div className="pd-chat__search">
      <label className="pd-chat__search-field">
        <SearchIcon size={14} aria-hidden="true" />
        <input
          type="search"
          autoFocus
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search this conversation"
          aria-label="Search this conversation"
        />
        {search && (
          <button type="button" onClick={() => setSearch('')} aria-label="Clear search" className="pd-chat__ib pd-chat__ib--sm">
            <X size={14} aria-hidden="true" />
          </button>
        )}
      </label>
    </div>
  )

  const emptyState =
    activePeer?.isBot ? (
      <div className="pd-chat__empty">
        <BotAvatar size="xl" />
        <span className="pd-chat__empty-title">Ask about a project, an order or a customer</span>
        <span className="pd-chat__empty-text">
          {firstName(activePeer.name)} reads the proof viewer, Stock Control, Help Scout and the Xero ledger. It only reads. Prices it quotes are checked against the catalogue, and it says when it could not check one.
        </span>
        <div className="pd-chat__suggestions">
          {BOT_SUGGESTIONS.map((s) => (
            <button key={s} type="button" className="pd-chat__suggestion" onClick={() => applySuggestion(s)}>
              {s}
            </button>
          ))}
        </div>
        <span className="pdc-t-caption pdc-text-ink-mute">Only you see this conversation. Nothing you ask is posted anywhere.</span>
      </div>
    ) : activePeer ? (
      <div className="pd-chat__empty">
        <span className="pd-chat__empty-title">No messages yet</span>
        <span className="pd-chat__empty-text">
          A private conversation between you and {firstName(activePeer.name)}. No-one else can see it.
        </span>
      </div>
    ) : (
      <div className="pd-chat__empty">
        <span className="pd-chat__empty-title">No messages yet</span>
        <span className="pd-chat__empty-text">Say hello to the team. Everyone signed in can read the room.</span>
      </div>
    )

  const list = (
    <div
      ref={scrollRef}
      onScroll={onListScroll}
      className={['pd-chat__list pdc-overflow-y-auto', pageWide ? 'pd-chat__list--page' : ''].filter(Boolean).join(' ')}
    >
      {loading ? (
        <div className="pdc-flex pdc-h-full pdc-items-center pdc-justify-center">
          <div className="pd-chat__spinner" />
        </div>
      ) : threadMessages.length === 0 && !searchQuery ? (
        emptyState
      ) : shown.length === 0 ? (
        <div className="pd-chat__empty">
          {searchingRemote ? (
            <span className="pd-chat__empty-text">Searching the whole conversation…</span>
          ) : (
            <>
              <span className="pd-chat__empty-title">No matches</span>
              <span className="pd-chat__empty-text">Nothing here says “{search.trim()}”.</span>
            </>
          )}
        </div>
      ) : (
        <div ref={listRef} className="pdc-mt-auto">
          {/* Older history pager. Hidden while searching (the search already
              covers the full history server-side). */}
          {!searchQuery && historyFor(activeThread) !== 'exhausted' && (
            <div className="pdc-flex pdc-justify-center" style={{ paddingBottom: 8 }}>
              <button
                type="button"
                onClick={() => void onLoadEarlier()}
                disabled={historyFor(activeThread) === 'loading'}
                className="pd-chat__earlier"
              >
                {historyFor(activeThread) === 'loading' ? 'Loading…' : 'Show earlier messages'}
              </button>
            </div>
          )}
          {searchQuery && searchingRemote && (
            <p className="pdc-t-caption pdc-text-ink-mute pdc-text-center" style={{ paddingBottom: 8 }}>
              Searching the whole conversation…
            </p>
          )}
          <ul>
            {shown.map((m, i) => {
              const prev = shown[i - 1]
              const showDay = !prev || dayKey(prev.created_at) !== dayKey(m.created_at)
              const showNew = newMarkerId === m.id
              const grouped = !showDay && !showNew && isGroupedWithPrevious(prev, m)
              const mine = userId !== null && m.author_id === userId
              const canDelete = m.author_id === userId || isAdmin
              const msgReactions = groupReactions(reactionsByMessage.get(m.id) ?? [], userId)
              const author = m.author_id ? membersById.get(m.author_id) : undefined
              const authorIsBot = author?.isBot === true
              // Prefer the roster's live colour over the copy frozen onto the
              // row when it was sent, so someone changing their colour
              // recolours their whole history at once rather than splitting it
              // into before-and-after. The frozen value is the fallback for an
              // author who has since left the roster.
              const authorColour = author?.colour ?? m.author_colour
              return (
                <li key={m.id}>
                  {showDay && (
                    <div className="pd-chat__divider">
                      <span className="pd-chat__divider-rule" />
                      <span className="pdc-t-label pdc-text-ink-mute">{dayLabel(m.created_at)}</span>
                      <span className="pd-chat__divider-rule" />
                    </div>
                  )}
                  {showNew && (
                    <div className="pd-chat__divider pd-chat__divider--new" role="separator" aria-label="New messages">
                      <span className="pd-chat__divider-rule" />
                      <span className="pdc-t-label">New</span>
                      <span className="pd-chat__divider-rule" />
                    </div>
                  )}
                  <MessageRow
                    message={m}
                    grouped={grouped}
                    mine={mine}
                    canDelete={canDelete}
                    canMention={!mine && activeThread === 'team' && !!m.author_name}
                    authorIsBot={authorIsBot}
                    authorAvatar={author?.avatarUrl ?? null}
                    authorColour={authorColour}
                    reactions={msgReactions}
                    memberNames={memberNames}
                    onReact={(emoji) => toggleReaction(m.id, emoji)}
                    onMention={() => mentionAuthor(m)}
                    onCopy={() => void copyText(m)}
                    onDelete={() => void remove(m.id)}
                  />
                </li>
              )
            })}
          </ul>
          {botTyping && (
            <div className="pd-chat__thinking" aria-live="polite">
              <BotAvatar size="md" />
              <span className="pd-chat__thinking-dots" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
              {firstName(bot?.name)} is looking…
            </div>
          )}
        </div>
      )}
    </div>
  )

  const composer = (
    <div
      {...zoneProps}
      className={[
        'pd-chat__composer',
        pageWide ? 'pd-chat__composer--page' : '',
        isZoneDragOver ? 'pd-chat__composer--drag' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {/* @mention autocomplete — opens upward above the field. */}
      {mentionQuery !== null && filtered.length > 0 && (
        <div className="pd-chat__mentions">
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
              className={['pd-chat__mention-row', i === mentionIndex ? 'pd-chat__mention-row--on' : ''].filter(Boolean).join(' ')}
            >
              {m.isBot ? (
                <BotAvatar size="sm" />
              ) : (
                <PersonAvatar size="sm" initials={m.initials} colour={m.colour} avatarUrl={m.avatarUrl} />
              )}
              <span className="pdc-font-medium">{m.name ?? 'Someone'}</span>
              {m.isBot && <BotTag />}
            </button>
          ))}
        </div>
      )}

      {attachments.length > 0 && (
        <div className="pd-chat__staged">
          {attachments.map((a) => {
            const Icon = fileKindIcon(a.name, a.type)
            const meta = [kindLabel(a.name, a.type), formatBytes(a.blob.size)].filter(Boolean).join(' · ')
            return (
              <div
                key={a.id}
                className={['pd-chat__staged-item', isImageType(a.type) ? 'pd-chat__staged-item--image' : 'pd-chat__staged-item--file'].join(' ')}
              >
                {isImageType(a.type) ? (
                  <img src={a.url} alt="" />
                ) : (
                  <>
                    <Icon size={18} aria-hidden="true" className="pdc-text-ink-mute" />
                    <span className="pd-chat__file-text">
                      <span className="pd-chat__file-name">{a.name}</span>
                      {meta && <span className="pd-chat__file-meta">{meta}</span>}
                    </span>
                  </>
                )}
                <button type="button" onClick={() => removeAttachment(a.id)} aria-label="Remove attachment" className="pd-chat__staged-remove">
                  <X size={11} aria-hidden="true" />
                </button>
              </div>
            )
          })}
        </div>
      )}
      {error && (
        <p role="alert" className="pd-chat__error">
          {error}
        </p>
      )}
      {/* The typing line keeps its height whether or not anyone is typing, so
          the field never moves under the cursor. */}
      <div className="pd-chat__typing" aria-live="polite">
        {peopleTyping.length > 0 ? typingLabel(peopleTyping) : ''}
      </div>
      <div className="pd-chat__field">
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={onDraftChange}
          onKeyDown={onKeyDown}
          onPaste={handlePaste}
          rows={1}
          placeholder={
            activePeer?.isBot
              ? `Ask ${firstName(activePeer.name)}`
              : activePeer
                ? `Message ${firstName(activePeer.name)}`
                : 'Message the team'
          }
          aria-label={activePeer ? `Message ${firstName(activePeer.name)}` : 'Message the team'}
          className="pd-chat__composer-input"
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={attachments.length >= MAX_ATTACHMENTS}
          aria-label="Attach a file"
          title="Attach a file"
          className="pd-chat__ib"
        >
          <Paperclip size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => void handleSend()}
          disabled={(!draft.trim() && attachments.length === 0) || sending}
          aria-label="Send message"
          title="Send (Enter)"
          className="pd-chat__send"
        >
          <ArrowUp size={16} aria-hidden="true" />
        </button>
      </div>
      <input
        ref={fileRef}
        type="file"
        multiple
        className="pdc-sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          addFiles(Array.from(e.target.files ?? []))
          e.target.value = ''
        }}
      />
    </div>
  )

  const thread = (
    <div className="pd-chat__thread">
      {header}
      {!pageWide && !pagePhone && chips}
      {searchRow}
      {list}
      {composer}
    </div>
  )

  return (
    /* `pd-chat` is the scope every rule in chat.css hangs off, so it has to be
       on the outermost node the panel renders or nothing below it is styled.
       It also declares the colour tokens, which is why the popout variant adds
       its own modifier rather than replacing this class. `pd-chat__panel` is
       the flex column the whole height chain depends on: the list inside
       scrolls only because this fills its host and nothing else grows. */
    <div
      ref={rootRef}
      className={['pd-chat', 'pd-chat__panel', variant === 'popout' ? 'pd-chat--popout' : ''].filter(Boolean).join(' ')}
    >
      {pageWide ? (
        <div className="pd-chat__page">
          {conversationList}
          {thread}
        </div>
      ) : showingList ? (
        conversationList
      ) : (
        thread
      )}
    </div>
  )
}

// ── A message row ──────────────────────────────────────────────────────────

function MessageRow({
  message: m,
  grouped,
  mine,
  canDelete,
  canMention,
  authorIsBot,
  authorAvatar,
  authorColour,
  reactions,
  memberNames,
  onReact,
  onMention,
  onCopy,
  onDelete,
}: {
  message: TeamMessage
  grouped: boolean
  mine: boolean
  canDelete: boolean
  canMention: boolean
  authorIsBot: boolean
  authorAvatar: string | null
  authorColour: string | null
  reactions: { emoji: string; count: number; mine: boolean; names: string[] }[]
  memberNames: string[]
  onReact: (emoji: string) => void
  onMention: () => void
  onCopy: () => void
  onDelete: () => void
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const files = attachmentsOf(m)
  return (
    <div className={['pd-chat__msg', grouped ? 'pd-chat__msg--grouped' : ''].filter(Boolean).join(' ')}>
      <div className="pd-chat__msg-gutter">
        {grouped ? (
          <span className="pd-chat__msg-gutter-time">{messageTime(m.created_at)}</span>
        ) : authorIsBot ? (
          <BotAvatar size="md" />
        ) : (
          <PersonAvatar size="md" initials={m.author_initials} colour={authorColour} avatarUrl={authorAvatar} />
        )}
      </div>
      <div className="pd-chat__msg-main">
        {!grouped && (
          <div className="pd-chat__msg-meta">
            <span className="pd-chat__msg-name">
              {mine ? 'You' : firstName(m.author_name)}
              {authorIsBot && <BotTag />}
            </span>
            <span className="pd-chat__msg-time">{messageTime(m.created_at)}</span>
          </div>
        )}
        {m.body && (
          <p className="pd-chat__msg-body">
            {buildMessageSegments(m.body, memberNames).map((seg, si) =>
              seg.type === 'link' ? (
                <a key={si} href={seg.value} target="_blank" rel="noreferrer">
                  {seg.value}
                </a>
              ) : seg.type === 'mention' ? (
                <span key={si} className="pd-chat__mention">
                  {seg.value}
                </span>
              ) : (
                <span key={si}>{seg.value}</span>
              ),
            )}
          </p>
        )}
        {files.length > 0 && <ChatAttachments files={files} />}
        {reactions.length > 0 && (
          <div className="pd-chat__reactions">
            {reactions.map((g) => (
              <button
                key={g.emoji}
                type="button"
                onClick={() => onReact(g.emoji)}
                title={g.names.map((n) => firstName(n)).join(', ')}
                aria-pressed={g.mine}
                className={['pd-chat__react', g.mine ? 'pd-chat__react--mine' : ''].filter(Boolean).join(' ')}
              >
                <span>{g.emoji}</span>
                <span className="pd-chat__react-count">{g.count}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {/* One toolbar, top right, on hover or focus; always on below md,
          where there is no hover to reveal it. */}
      <div className={['pd-chat__tools', pickerOpen ? 'pd-chat__tools--open' : ''].filter(Boolean).join(' ')}>
        <ReactButton messageId={m.id} onOpenChange={setPickerOpen} />
        {canMention && (
          <button type="button" onClick={onMention} aria-label={`Reply mentioning ${firstName(m.author_name)}`} title="Reply with a mention" className="pd-chat__tool">
            <AtSign size={14} aria-hidden="true" />
          </button>
        )}
        {m.body && (
          <button type="button" onClick={onCopy} aria-label="Copy message text" title="Copy text" className="pd-chat__tool">
            <Copy size={14} aria-hidden="true" />
          </button>
        )}
        {canDelete && (
          <button type="button" onClick={onDelete} aria-label="Delete message" title="Delete" className="pd-chat__tool pd-chat__tool--danger">
            <Trash2 size={14} aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  )
}
