import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { supabase } from './supabase'
import { useAuth } from './auth'
import type { TeamMessage, ChatAttachment } from './teamChat'
import { playChatSound } from './chatSound'

// Shared "engine" for the team chat: one live connection (message realtime +
// presence) mounted once near the app root, so the header badge, the dropdown
// panel and the full /chat page all read the same state and nothing re-connects
// on navigation. Presence (who's online / idle / away / busy) rides the same
// channel and needs no database — it's ephemeral, live-only.

export type ChatStatus = 'online' | 'idle' | 'away' | 'busy'

// Where the chat lives: the header dropdown (floating) or docked into the
// dashboard right rail. Persisted per browser.
export type ChatPlacement = 'floating' | 'docked'

// Which conversation is showing: the shared team room, or a private
// person-to-person thread keyed by the peer's user id (000324).
export type ChatThread = 'team' | string

// Which thread a message belongs to, from my point of view: team-room rows to
// 'team'; a DM to the OTHER participant's id (their thread key), whether I
// sent or received it.
function threadOf(m: TeamMessage, myId: string | null): ChatThread {
  if (!m.recipient_id) return 'team'
  return m.author_id === myId ? m.recipient_id : (m.author_id ?? m.recipient_id)
}

// Traffic-light status colours. Deliberately literal (not design tokens) — these
// read as universal presence signals and should look the same everywhere.
export const CHAT_STATUS_META: Record<ChatStatus, { label: string; dot: string }> = {
  online: { label: 'Online', dot: '#22c55e' },
  idle: { label: 'Idle', dot: '#f59e0b' },
  away: { label: 'Away', dot: '#9ca3af' },
  busy: { label: 'Busy', dot: '#ef4444' },
}

// Ranked most-present → least, for picking a person's status across several open
// tabs and for sorting the roster.
const STATUS_RANK: Record<ChatStatus, number> = { online: 0, idle: 1, away: 2, busy: 3 }

export interface PresenceMember {
  userId: string
  name: string | null
  initials: string | null
  colour: string | null
  avatarUrl: string | null
  status: ChatStatus
}

// An active team member, for the @mention picker + message highlighting.
export interface TeamMember {
  id: string
  name: string | null
  initials: string | null
  colour: string | null
  avatarUrl: string | null
}

// A single emoji reaction on a message (one row per message + user + emoji).
export interface ReactionRow {
  id: string
  message_id: string
  user_id: string | null
  user_name: string | null
  emoji: string
}

// What each client broadcasts about itself on the presence channel.
interface PresenceMeta {
  user_id: string
  name: string | null
  initials: string | null
  colour: string | null
  avatar_url?: string | null
  status: ChatStatus
}

interface TeamChatValue {
  messages: TeamMessage[]
  loading: boolean
  /** Total unread across every thread (team room + all DMs). */
  unread: number
  /** Of the team room's unread, how many @mention me. Drives the louder
   *  mention badge so a direct tag reads differently from ordinary chatter. */
  mentionUnread: number
  /** Total unread across the private DM threads. DMs are personal, so this
   *  gets the same loud badge treatment as mentions. */
  dmUnread: number
  /** Per-thread unread counts, keyed 'team' or the peer's user id. Missing
   *  key = zero. Drives the thread-switcher badges. */
  threadUnread: Record<string, number>
  /** The conversation every chat surface is showing (they stay in sync via
   *  this shared engine): 'team' or a peer's user id. */
  activeThread: ChatThread
  /** Switch thread. If a chat surface is open, the new thread is immediately
   *  marked read. */
  setActiveThread: (thread: ChatThread) => void
  /** Fetch one older page (100) of a thread's history into the pool.
   *  Resolves to the number of messages actually added. */
  loadEarlier: (thread: ChatThread) => Promise<number>
  /** Whether a thread may have more history to load: 'can-load' (show the
   *  button), 'loading' (fetch in flight), or 'exhausted' (start reached). */
  historyFor: (thread: ChatThread) => 'can-load' | 'loading' | 'exhausted'
  /** Everyone currently present, including yourself. */
  presence: PresenceMember[]
  /** Active team members, for the @mention picker + highlighting. */
  members: TeamMember[]
  /** All loaded emoji reactions (flat; group by message_id in the view). */
  reactions: ReactionRow[]
  /** Add your reaction to a message, or remove it if you've already reacted. */
  toggleReaction: (messageId: string, emoji: string) => void
  /** Your own effective status (auto idle unless you've set Away/Busy). */
  myStatus: ChatStatus
  send: (
    body: string,
    mentionedUserIds?: string[],
    attachments?: ChatAttachment[],
  ) => Promise<{ ok: boolean; error?: string }>
  remove: (id: string) => Promise<void>
  /** Clear the unread badge and stamp "seen up to now". */
  markSeen: () => void
  /** Tell the engine a chat surface is open (true) or closed (false). While
   *  open, incoming messages don't accrue unread — you're looking at them. */
  setViewing: (viewing: boolean) => void
  /** Set your manual status. 'online' clears the manual override (back to auto
   *  online/idle); 'away' / 'busy' pin it until you change it. */
  setManualStatus: (status: 'online' | 'away' | 'busy') => void
  /** Whether the header chat dropdown is "kept open" across pages + reloads
   *  (persisted to localStorage). When true it survives navigation and ignores
   *  outside-clicks, so you can keep chatting while working elsewhere. */
  dropdownPinned: boolean
  setDropdownPinned: (pinned: boolean) => void
  /** Whether notification sounds play on incoming messages (persisted). A subtle
   *  blip for a general message, a brighter chime when you're @mentioned. */
  soundEnabled: boolean
  setSoundEnabled: (enabled: boolean) => void
  /** Where the chat lives: 'floating' (header dropdown) or 'docked' (in the
   *  dashboard right rail). Only the dashboard renders the docked panel; the
   *  floating dropdown stays available everywhere. Persisted. */
  placement: ChatPlacement
  setPlacement: (placement: ChatPlacement) => void
  /** Other people currently typing a message (auto-expires ~4.5s after their
   *  last keystroke). Never includes yourself. */
  typingUsers: { userId: string; name: string | null }[]
  /** Call as the user types to broadcast a throttled "typing" signal. */
  notifyTyping: () => void
}

const PINNED_KEY = 'pv:chat-pinned'
const SOUND_KEY = 'pv:chat-sound'

function readPinned(): boolean {
  try {
    return localStorage.getItem(PINNED_KEY) === '1'
  } catch {
    return false
  }
}

// Sounds default ON; only an explicit '0' turns them off.
function readSound(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) !== '0'
  } catch {
    return true
  }
}

const PLACEMENT_KEY = 'pv:chat-placement'
// Placement defaults to floating; only an explicit 'docked' opts in.
function readPlacement(): ChatPlacement {
  try {
    return localStorage.getItem(PLACEMENT_KEY) === 'docked' ? 'docked' : 'floating'
  } catch {
    return 'floating'
  }
}

// Inert default so consumers (e.g. the header) don't crash if they render
// outside the provider (the design-system preview harness, signed-out routes).
const DEFAULT: TeamChatValue = {
  messages: [],
  loading: false,
  unread: 0,
  mentionUnread: 0,
  dmUnread: 0,
  threadUnread: {},
  activeThread: 'team',
  setActiveThread: () => {},
  loadEarlier: async () => 0,
  historyFor: () => 'exhausted',
  presence: [],
  members: [],
  reactions: [],
  toggleReaction: () => {},
  myStatus: 'online',
  send: async () => ({ ok: false }),
  remove: async () => {},
  markSeen: () => {},
  setViewing: () => {},
  setManualStatus: () => {},
  dropdownPinned: false,
  setDropdownPinned: () => {},
  soundEnabled: true,
  setSoundEnabled: () => {},
  placement: 'floating',
  setPlacement: () => {},
  typingUsers: [],
  notifyTyping: () => {},
}

const TeamChatContext = createContext<TeamChatValue>(DEFAULT)

export function useTeamChat(): TeamChatValue {
  return useContext(TeamChatContext)
}

const INITIAL_LIMIT = 200
const EARLIER_PAGE = 100 // "Show earlier messages" page size, per thread
const IDLE_MS = 5 * 60 * 1000 // flip to "idle" after 5 minutes of no activity
const ACTIVITY_THROTTLE_MS = 1000
const STATUS_TICK_MS = 20_000

function reducePresence(state: Record<string, PresenceMeta[]>): PresenceMember[] {
  const byUser = new Map<string, PresenceMember>()
  for (const key of Object.keys(state)) {
    for (const meta of state[key]) {
      if (!meta?.user_id) continue
      const cand: PresenceMember = {
        userId: meta.user_id,
        name: meta.name ?? null,
        initials: meta.initials ?? null,
        colour: meta.colour ?? null,
        avatarUrl: meta.avatar_url ?? null,
        status: meta.status ?? 'online',
      }
      const existing = byUser.get(cand.userId)
      // Across a person's tabs, show their most-present status.
      if (!existing || STATUS_RANK[cand.status] < STATUS_RANK[existing.status]) {
        byUser.set(cand.userId, cand)
      }
    }
  }
  return [...byUser.values()].sort((a, b) => {
    const r = STATUS_RANK[a.status] - STATUS_RANK[b.status]
    return r !== 0 ? r : (a.name ?? '').localeCompare(b.name ?? '')
  })
}

export function TeamChatProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth()
  const userId = session?.user.id ?? null

  const [messages, setMessages] = useState<TeamMessage[]>([])
  const [loading, setLoading] = useState(true)
  // Unread per thread ('team' or peer id). Totals are derived at render.
  const [threadUnread, setThreadUnread] = useState<Record<string, number>>({})
  const [mentionUnread, setMentionUnread] = useState(0)
  const [activeThread, setActiveThreadState] = useState<ChatThread>('team')
  // Per-thread history pager: absent = unknown, 'loading' = fetch in flight,
  // 'exhausted' = the start of that thread's history is loaded.
  const [historyStatus, setHistoryStatus] = useState<Record<string, 'loading' | 'exhausted'>>({})
  const [presence, setPresence] = useState<PresenceMember[]>([])
  const [members, setMembers] = useState<TeamMember[]>([])
  const [reactions, setReactions] = useState<ReactionRow[]>([])
  const [myStatus, setMyStatus] = useState<ChatStatus>('online')
  const [dropdownPinned, setDropdownPinnedState] = useState<boolean>(readPinned)
  const [soundEnabled, setSoundEnabledState] = useState<boolean>(readSound)
  const [placement, setPlacementState] = useState<ChatPlacement>(readPlacement)
  const [typingUsers, setTypingUsers] = useState<{ userId: string; name: string | null }[]>([])

  // Refs the realtime handlers / timers read so the channel never has to be torn
  // down and rebuilt just to see fresh values.
  const userIdRef = useRef<string | null>(userId)
  userIdRef.current = userId
  const soundEnabledRef = useRef(soundEnabled)
  soundEnabledRef.current = soundEnabled
  const lastGeneralSoundRef = useRef(0)
  const typingMapRef = useRef<Map<string, { name: string | null; expiresAt: number; thread: ChatThread }>>(
    new Map(),
  )
  const lastTypingSentRef = useRef(0)
  const reactionsRef = useRef<ReactionRow[]>([])
  reactionsRef.current = reactions
  const viewingRef = useRef(false)
  const manualRef = useRef<'away' | 'busy' | null>(null)
  const lastActivityRef = useRef(Date.now())
  const seenAtRef = useRef<string | null>(null)
  // Per-peer DM "last read" stamps (team_chat_dm_reads), keyed by peer id.
  const dmReadsRef = useRef<Record<string, string>>({})
  const activeThreadRef = useRef<ChatThread>('team')
  const messagesRef = useRef<TeamMessage[]>([])
  messagesRef.current = messages
  const historyStatusRef = useRef(historyStatus)
  historyStatusRef.current = historyStatus
  // Whether the initial window came back full — if not, the entire history is
  // already loaded and no thread has anything earlier to fetch.
  const initialFullRef = useRef(false)
  const myStatusRef = useRef<ChatStatus>('online')
  const profileRef = useRef<{
    name: string | null
    initials: string | null
    colour: string | null
    avatarUrl: string | null
  }>({
    name: null,
    initials: null,
    colour: null,
    avatarUrl: null,
  })
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null)

  function computeStatus(): ChatStatus {
    if (manualRef.current === 'away') return 'away'
    if (manualRef.current === 'busy') return 'busy'
    if (Date.now() - lastActivityRef.current > IDLE_MS) return 'idle'
    return 'online'
  }

  function presencePayload(): PresenceMeta {
    return {
      user_id: userIdRef.current ?? '',
      name: profileRef.current.name,
      initials: profileRef.current.initials,
      colour: profileRef.current.colour,
      avatar_url: profileRef.current.avatarUrl,
      status: myStatusRef.current,
    }
  }

  // Recompute effective status; if it changed, reflect it + re-broadcast.
  function refreshStatus() {
    const next = computeStatus()
    if (next === myStatusRef.current) return
    myStatusRef.current = next
    setMyStatus(next)
    const ch = channelRef.current
    if (ch) void ch.track(presencePayload())
  }

  // Mark one thread read: persist the stamp (profiles.team_chat_seen_at for
  // the room, team_chat_dm_reads for a DM) and zero its unread count.
  function stampSeen(thread: ChatThread) {
    const uid = userIdRef.current
    if (!uid) return
    const nowIso = new Date().toISOString()
    if (thread === 'team') {
      seenAtRef.current = nowIso
      void supabase.from('profiles').update({ team_chat_seen_at: nowIso }).eq('id', uid)
      setMentionUnread(0)
    } else {
      dmReadsRef.current[thread] = nowIso
      void supabase
        .from('team_chat_dm_reads')
        .upsert({ user_id: uid, peer_id: thread, seen_at: nowIso }, { onConflict: 'user_id,peer_id' })
    }
    setThreadUnread((prev) => {
      if (!prev[thread]) return prev
      const next = { ...prev }
      delete next[thread]
      return next
    })
  }

  // Rebuild the typing-users list from the ref, dropping any that have expired
  // and showing only entries for the thread currently on screen.
  function recomputeTyping() {
    const now = Date.now()
    const arr: { userId: string; name: string | null }[] = []
    for (const [uid, v] of typingMapRef.current) {
      if (v.expiresAt <= now) {
        typingMapRef.current.delete(uid)
        continue
      }
      if (v.thread === activeThreadRef.current) arr.push({ userId: uid, name: v.name })
    }
    setTypingUsers(arr)
  }

  // Load messages + presence identity, then open the shared channel.
  useEffect(() => {
    if (!userId) {
      setMessages([])
      setThreadUnread({})
      setMentionUnread(0)
      setPresence([])
      setMembers([])
      setReactions([])
      setHistoryStatus({})
      initialFullRef.current = false
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)

    void (async () => {
      const [{ data: prof }, { data: msgs }, { data: mem }, { data: dmReads }] = await Promise.all([
        supabase
          .from('profiles')
          .select('full_name, designer_initials, designer_colour, avatar_url, team_chat_seen_at')
          .eq('id', userId)
          .single(),
        // RLS scopes this to the team room + my own DM threads (000324).
        supabase
          .from('team_messages')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(INITIAL_LIMIT),
        supabase
          .from('profiles')
          .select('id, full_name, designer_initials, designer_colour, avatar_url')
          .is('deactivated_at', null)
          .order('full_name'),
        supabase.from('team_chat_dm_reads').select('peer_id, seen_at').eq('user_id', userId),
      ])
      if (cancelled) return

      dmReadsRef.current = Object.fromEntries(
        ((dmReads ?? []) as Array<{ peer_id: string; seen_at: string }>).map((r) => [
          r.peer_id,
          r.seen_at,
        ]),
      )

      setMembers(
        ((mem ?? []) as Array<{
          id: string
          full_name: string | null
          designer_initials: string | null
          designer_colour: string | null
          avatar_url: string | null
        }>).map((m) => ({
          id: m.id,
          name: m.full_name,
          initials: m.designer_initials,
          colour: m.designer_colour,
          avatarUrl: m.avatar_url,
        })),
      )

      seenAtRef.current = (prof?.team_chat_seen_at as string | null) ?? null
      profileRef.current = {
        name: prof?.full_name ?? null,
        initials: prof?.designer_initials ?? null,
        colour: prof?.designer_colour ?? null,
        avatarUrl: prof?.avatar_url ?? null,
      }

      const list = ((msgs ?? []) as TeamMessage[]).slice().reverse()
      setMessages(list)
      initialFullRef.current = list.length >= INITIAL_LIMIT
      setHistoryStatus({})
      // Per-thread unread: the team room measures against team_chat_seen_at,
      // each DM thread against its own team_chat_dm_reads stamp.
      const counts: Record<string, number> = {}
      let mentions = 0
      for (const m of list) {
        if (m.author_id === userId) continue
        const thread = threadOf(m, userId)
        if (thread === 'team') {
          const seen = seenAtRef.current
          if (!seen || m.created_at > seen) {
            counts.team = (counts.team ?? 0) + 1
            if (Array.isArray(m.mentioned_user_ids) && m.mentioned_user_ids.includes(userId)) {
              mentions++
            }
          }
        } else {
          const seen = dmReadsRef.current[thread]
          if (!seen || m.created_at > seen) counts[thread] = (counts[thread] ?? 0) + 1
        }
      }
      setThreadUnread(counts)
      setMentionUnread(mentions)
      setLoading(false)

      const messageIds = list.map((m) => m.id)
      if (messageIds.length > 0) {
        const { data: reactData } = await supabase
          .from('team_message_reactions')
          .select('*')
          .in('message_id', messageIds)
        if (cancelled) return
        setReactions((reactData ?? []) as ReactionRow[])
      } else {
        setReactions([])
      }

      const channel = supabase
        .channel('team-chat', { config: { presence: { key: userId } } })
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'proofs', table: 'team_messages' },
          (payload) => {
            const row = payload.new as TeamMessage
            setMessages((prev) => (prev.some((m) => m.id === row.id) ? prev : [...prev, row]))
            if (row.author_id !== userIdRef.current) {
              // Which thread, and is it personal? A DM or an @mention of me
              // gets the loud treatment (badge + chime); room chatter stays
              // subtle. RLS means a DM row only ever reaches its participants.
              const thread = threadOf(row, userIdRef.current)
              const isDm = thread !== 'team'
              const mentions = (payload.new as { mentioned_user_ids?: string[] | null })
                .mentioned_user_ids
              const mentioned =
                !isDm &&
                Array.isArray(mentions) &&
                !!userIdRef.current &&
                mentions.includes(userIdRef.current)
              if (viewingRef.current && activeThreadRef.current === thread) {
                stampSeen(thread)
              } else {
                setThreadUnread((prev) => ({ ...prev, [thread]: (prev[thread] ?? 0) + 1 }))
                if (mentioned) setMentionUnread((n) => n + 1)
              }
              // Audio cue: a brighter chime for a DM or an @mention, else a
              // subtle blip (throttled so a burst doesn't machine-gun).
              if (soundEnabledRef.current) {
                if (mentioned || isDm) {
                  playChatSound('mention')
                } else {
                  const now = Date.now()
                  if (now - lastGeneralSoundRef.current > 2000) {
                    lastGeneralSoundRef.current = now
                    playChatSound('general')
                  }
                }
              }
            }
          },
        )
        .on(
          'postgres_changes',
          { event: 'DELETE', schema: 'proofs', table: 'team_messages' },
          (payload) => {
            const old = payload.old as { id?: string }
            if (old?.id) setMessages((prev) => prev.filter((m) => m.id !== old.id))
          },
        )
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'proofs', table: 'team_message_reactions' },
          (payload) => {
            const row = payload.new as ReactionRow
            setReactions((prev) => (prev.some((r) => r.id === row.id) ? prev : [...prev, row]))
          },
        )
        .on(
          'postgres_changes',
          { event: 'DELETE', schema: 'proofs', table: 'team_message_reactions' },
          (payload) => {
            const old = payload.old as { id?: string }
            if (old?.id) setReactions((prev) => prev.filter((r) => r.id !== old.id))
          },
        )
        .on('presence', { event: 'sync' }, () => {
          const state = channel.presenceState() as unknown as Record<string, PresenceMeta[]>
          setPresence(reducePresence(state))
        })
        .on('broadcast', { event: 'typing' }, ({ payload }) => {
          const p = payload as { userId?: string; name?: string | null; to?: string | null }
          if (!p.userId || p.userId === userIdRef.current) return
          // Route to a thread: room typing to 'team'; DM typing only to its
          // recipient (thread = the sender's id); anyone else's DM typing is
          // none of our business.
          let thread: ChatThread | null = null
          if (!p.to) thread = 'team'
          else if (p.to === userIdRef.current) thread = p.userId
          if (!thread) return
          typingMapRef.current.set(p.userId, {
            name: p.name ?? null,
            expiresAt: Date.now() + 4500,
            thread,
          })
          recomputeTyping()
        })
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            lastActivityRef.current = Date.now()
            myStatusRef.current = computeStatus()
            setMyStatus(myStatusRef.current)
            void channel.track(presencePayload())
          }
        })
      channelRef.current = channel
    })()

    return () => {
      cancelled = true
      if (channelRef.current) {
        void supabase.removeChannel(channelRef.current)
        channelRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId])

  // Activity + idle tracking. A throttled "bump" records the last activity; a
  // slow tick (and visibility changes) flips online↔idle and re-broadcasts.
  useEffect(() => {
    if (!userId) return
    let lastBump = 0
    function bump() {
      const now = Date.now()
      if (now - lastBump < ACTIVITY_THROTTLE_MS) return
      lastBump = now
      lastActivityRef.current = now
      refreshStatus()
    }
    const events: (keyof WindowEventMap)[] = ['mousemove', 'keydown', 'click', 'scroll', 'touchstart']
    events.forEach((e) => window.addEventListener(e, bump, { passive: true }))
    function onVisibility() {
      if (!document.hidden) lastActivityRef.current = Date.now()
      refreshStatus()
    }
    document.addEventListener('visibilitychange', onVisibility)
    const tick = window.setInterval(refreshStatus, STATUS_TICK_MS)
    return () => {
      events.forEach((e) => window.removeEventListener(e, bump))
      document.removeEventListener('visibilitychange', onVisibility)
      window.clearInterval(tick)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId])

  // Expire stale "typing" entries even if no new broadcast arrives.
  useEffect(() => {
    if (!userId) return
    const t = window.setInterval(recomputeTyping, 1500)
    return () => window.clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId])

  // Totals derived from the per-thread map (tiny arrays; no memo needed).
  const unread = Object.values(threadUnread).reduce((a, b) => a + b, 0)
  const dmUnread = unread - (threadUnread.team ?? 0)

  const value: TeamChatValue = {
    messages,
    loading,
    unread,
    mentionUnread,
    dmUnread,
    threadUnread,
    activeThread,
    setActiveThread: (thread: ChatThread) => {
      activeThreadRef.current = thread
      setActiveThreadState(thread)
      // If a chat surface is open, landing on the thread reads it.
      if (viewingRef.current) stampSeen(thread)
      recomputeTyping()
    },
    loadEarlier: async (thread: ChatThread) => {
      const uid = userIdRef.current
      if (!uid) return 0
      const status = historyStatusRef.current[thread]
      if (status === 'loading' || status === 'exhausted') return 0
      setHistoryStatus((prev) => ({ ...prev, [thread]: 'loading' }))

      // Anchor on the oldest loaded message of THIS thread (the pool is
      // sorted ascending, so the first match is the oldest). No anchor means
      // the thread has nothing loaded yet — fetch its latest page instead
      // (an old DM thread can sit entirely outside the initial window).
      let anchor: string | null = null
      for (const m of messagesRef.current) {
        if (threadOf(m, uid) === thread) {
          anchor = m.created_at
          break
        }
      }

      let q = supabase.from('team_messages').select('*')
      if (thread === 'team') q = q.is('recipient_id', null)
      else
        q = q.or(
          `and(author_id.eq.${thread},recipient_id.eq.${uid}),and(author_id.eq.${uid},recipient_id.eq.${thread})`,
        )
      if (anchor) q = q.lt('created_at', anchor)
      const { data, error } = await q
        .order('created_at', { ascending: false })
        .limit(EARLIER_PAGE)

      if (error) {
        // Transient failure — go back to "can load" so the button retries.
        setHistoryStatus((prev) => {
          const next = { ...prev }
          delete next[thread]
          return next
        })
        return 0
      }

      const older = ((data ?? []) as TeamMessage[]).slice().reverse()
      const have = new Set(messagesRef.current.map((m) => m.id))
      const fresh = older.filter((m) => !have.has(m.id))
      const reachedStart = older.length < EARLIER_PAGE
      setHistoryStatus((prev) => {
        const next = { ...prev }
        if (reachedStart) next[thread] = 'exhausted'
        else delete next[thread]
        return next
      })
      if (fresh.length > 0) {
        setMessages((prev) => {
          const seen = new Set(prev.map((m) => m.id))
          const add = fresh.filter((m) => !seen.has(m.id))
          if (add.length === 0) return prev
          return [...add, ...prev].sort((a, b) =>
            a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0,
          )
        })
        // Bring the reactions for the newly loaded page along too.
        const { data: reactData } = await supabase
          .from('team_message_reactions')
          .select('*')
          .in('message_id', fresh.map((m) => m.id))
        const rows = (reactData ?? []) as ReactionRow[]
        if (rows.length > 0) {
          setReactions((prev) => {
            const seen = new Set(prev.map((r) => r.id))
            return [...prev, ...rows.filter((r) => !seen.has(r.id))]
          })
        }
      }
      return fresh.length
    },
    historyFor: (thread: ChatThread) => {
      const s = historyStatus[thread]
      if (s === 'loading') return 'loading'
      if (s === 'exhausted') return 'exhausted'
      return initialFullRef.current ? 'can-load' : 'exhausted'
    },
    presence,
    members,
    reactions,
    toggleReaction: (messageId: string, emoji: string) => {
      const uid = userIdRef.current
      if (!uid) return
      const existing = reactionsRef.current.find(
        (r) => r.message_id === messageId && r.user_id === uid && r.emoji === emoji,
      )
      if (existing) {
        setReactions((prev) => prev.filter((r) => r.id !== existing.id))
        void supabase.from('team_message_reactions').delete().eq('id', existing.id)
      } else {
        void (async () => {
          const { data } = await supabase
            .from('team_message_reactions')
            .insert({ message_id: messageId, user_id: uid, emoji })
            .select('*')
            .single()
          if (data) {
            const row = data as ReactionRow
            setReactions((prev) => (prev.some((r) => r.id === row.id) ? prev : [...prev, row]))
          }
        })()
      }
    },
    myStatus,
    send: async (body: string, mentionedUserIds: string[] = [], attachments: ChatAttachment[] = []) => {
      const uid = userIdRef.current
      const text = body.trim()
      if ((!text && attachments.length === 0) || !uid) return { ok: false }
      // The message goes to whichever thread is on screen. DMs carry the
      // recipient and never carry mentions (the DM push already targets the
      // recipient; a mention array on a private row is meaningless).
      const thread = activeThreadRef.current
      const { data, error } = await supabase
        .from('team_messages')
        .insert({
          author_id: uid,
          body: text,
          recipient_id: thread === 'team' ? null : thread,
          mentioned_user_ids: thread === 'team' ? mentionedUserIds : [],
          // attachment_paths stays populated (lockstep) for backward compat;
          // attachment_files carries the original filename/type/size (000323).
          attachment_paths: attachments.map((a) => a.path),
          attachment_files: attachments,
        })
        .select('*')
        .single()
      if (error || !data) return { ok: false, error: error?.message }
      const row = data as TeamMessage
      setMessages((prev) => (prev.some((m) => m.id === row.id) ? prev : [...prev, row]))
      lastActivityRef.current = Date.now()
      if (viewingRef.current) stampSeen(thread)
      return { ok: true }
    },
    remove: async (id: string) => {
      let snapshot: TeamMessage[] = []
      setMessages((prev) => {
        snapshot = prev
        return prev.filter((m) => m.id !== id)
      })
      const { error } = await supabase.from('team_messages').delete().eq('id', id)
      if (error) setMessages(snapshot)
    },
    markSeen: () => {
      stampSeen(activeThreadRef.current)
    },
    setViewing: (viewing: boolean) => {
      viewingRef.current = viewing
      if (viewing) stampSeen(activeThreadRef.current)
    },
    setManualStatus: (status: 'online' | 'away' | 'busy') => {
      manualRef.current = status === 'online' ? null : status
      lastActivityRef.current = Date.now()
      refreshStatus()
    },
    dropdownPinned,
    setDropdownPinned: (pinned: boolean) => {
      setDropdownPinnedState(pinned)
      try {
        if (pinned) localStorage.setItem(PINNED_KEY, '1')
        else localStorage.removeItem(PINNED_KEY)
      } catch {
        /* localStorage unavailable — pin still works for this session */
      }
    },
    soundEnabled,
    setSoundEnabled: (enabled: boolean) => {
      setSoundEnabledState(enabled)
      try {
        if (enabled) localStorage.removeItem(SOUND_KEY)
        else localStorage.setItem(SOUND_KEY, '0')
      } catch {
        /* localStorage unavailable — still works for this session */
      }
    },
    placement,
    setPlacement: (next: ChatPlacement) => {
      setPlacementState(next)
      try {
        if (next === 'docked') localStorage.setItem(PLACEMENT_KEY, 'docked')
        else localStorage.removeItem(PLACEMENT_KEY)
      } catch {
        /* localStorage unavailable — still works for this session */
      }
    },
    typingUsers,
    notifyTyping: () => {
      const now = Date.now()
      if (now - lastTypingSentRef.current < 2500) return
      lastTypingSentRef.current = now
      const ch = channelRef.current
      if (!ch) return
      void ch.send({
        type: 'broadcast',
        event: 'typing',
        payload: {
          userId: userIdRef.current,
          name: profileRef.current.name,
          // Room typing broadcasts to everyone; DM typing is shown only by
          // its recipient (the receive handler drops anyone else's).
          to: activeThreadRef.current === 'team' ? null : activeThreadRef.current,
        },
      })
    },
  }

  return <TeamChatContext.Provider value={value}>{children}</TeamChatContext.Provider>
}
