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
import type { TeamMessage } from './teamChat'
import { playChatSound } from './chatSound'

// Shared "engine" for the team chat: one live connection (message realtime +
// presence) mounted once near the app root, so the header badge, the dropdown
// panel and the full /chat page all read the same state and nothing re-connects
// on navigation. Presence (who's online / idle / away / busy) rides the same
// channel and needs no database — it's ephemeral, live-only.

export type ChatStatus = 'online' | 'idle' | 'away' | 'busy'

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
  status: ChatStatus
}

// An active team member, for the @mention picker + message highlighting.
export interface TeamMember {
  id: string
  name: string | null
  initials: string | null
  colour: string | null
}

// What each client broadcasts about itself on the presence channel.
interface PresenceMeta {
  user_id: string
  name: string | null
  initials: string | null
  colour: string | null
  status: ChatStatus
}

interface TeamChatValue {
  messages: TeamMessage[]
  loading: boolean
  unread: number
  /** Everyone currently present, including yourself. */
  presence: PresenceMember[]
  /** Active team members, for the @mention picker + highlighting. */
  members: TeamMember[]
  /** Your own effective status (auto idle unless you've set Away/Busy). */
  myStatus: ChatStatus
  send: (body: string, mentionedUserIds?: string[]) => Promise<{ ok: boolean; error?: string }>
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

// Inert default so consumers (e.g. the header) don't crash if they render
// outside the provider (the design-system preview harness, signed-out routes).
const DEFAULT: TeamChatValue = {
  messages: [],
  loading: false,
  unread: 0,
  presence: [],
  members: [],
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
}

const TeamChatContext = createContext<TeamChatValue>(DEFAULT)

export function useTeamChat(): TeamChatValue {
  return useContext(TeamChatContext)
}

const INITIAL_LIMIT = 200
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
  const [unread, setUnread] = useState(0)
  const [presence, setPresence] = useState<PresenceMember[]>([])
  const [members, setMembers] = useState<TeamMember[]>([])
  const [myStatus, setMyStatus] = useState<ChatStatus>('online')
  const [dropdownPinned, setDropdownPinnedState] = useState<boolean>(readPinned)
  const [soundEnabled, setSoundEnabledState] = useState<boolean>(readSound)

  // Refs the realtime handlers / timers read so the channel never has to be torn
  // down and rebuilt just to see fresh values.
  const userIdRef = useRef<string | null>(userId)
  userIdRef.current = userId
  const soundEnabledRef = useRef(soundEnabled)
  soundEnabledRef.current = soundEnabled
  const lastGeneralSoundRef = useRef(0)
  const viewingRef = useRef(false)
  const manualRef = useRef<'away' | 'busy' | null>(null)
  const lastActivityRef = useRef(Date.now())
  const seenAtRef = useRef<string | null>(null)
  const myStatusRef = useRef<ChatStatus>('online')
  const profileRef = useRef<{ name: string | null; initials: string | null; colour: string | null }>({
    name: null,
    initials: null,
    colour: null,
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

  function stampSeen() {
    const uid = userIdRef.current
    if (!uid) return
    const nowIso = new Date().toISOString()
    seenAtRef.current = nowIso
    void supabase.from('profiles').update({ team_chat_seen_at: nowIso }).eq('id', uid)
  }

  // Load messages + presence identity, then open the shared channel.
  useEffect(() => {
    if (!userId) {
      setMessages([])
      setUnread(0)
      setPresence([])
      setMembers([])
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)

    void (async () => {
      const [{ data: prof }, { data: msgs }, { data: mem }] = await Promise.all([
        supabase
          .from('profiles')
          .select('full_name, designer_initials, designer_colour, team_chat_seen_at')
          .eq('id', userId)
          .single(),
        supabase
          .from('team_messages')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(INITIAL_LIMIT),
        supabase
          .from('profiles')
          .select('id, full_name, designer_initials, designer_colour')
          .is('deactivated_at', null)
          .order('full_name'),
      ])
      if (cancelled) return

      setMembers(
        ((mem ?? []) as Array<{
          id: string
          full_name: string | null
          designer_initials: string | null
          designer_colour: string | null
        }>).map((m) => ({
          id: m.id,
          name: m.full_name,
          initials: m.designer_initials,
          colour: m.designer_colour,
        })),
      )

      seenAtRef.current = (prof?.team_chat_seen_at as string | null) ?? null
      profileRef.current = {
        name: prof?.full_name ?? null,
        initials: prof?.designer_initials ?? null,
        colour: prof?.designer_colour ?? null,
      }

      const list = ((msgs ?? []) as TeamMessage[]).slice().reverse()
      setMessages(list)
      const seen = seenAtRef.current
      setUnread(
        list.filter((m) => m.author_id !== userId && (!seen || m.created_at > seen)).length,
      )
      setLoading(false)

      const channel = supabase
        .channel('team-chat', { config: { presence: { key: userId } } })
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'proofs', table: 'team_messages' },
          (payload) => {
            const row = payload.new as TeamMessage
            setMessages((prev) => (prev.some((m) => m.id === row.id) ? prev : [...prev, row]))
            if (row.author_id !== userIdRef.current) {
              if (viewingRef.current) stampSeen()
              else setUnread((n) => n + 1)
              // Audio cue: a brighter chime if it @mentions me, else a subtle
              // blip (throttled so a burst doesn't machine-gun).
              if (soundEnabledRef.current) {
                const mentions = (payload.new as { mentioned_user_ids?: string[] | null })
                  .mentioned_user_ids
                const mentioned =
                  Array.isArray(mentions) &&
                  !!userIdRef.current &&
                  mentions.includes(userIdRef.current)
                if (mentioned) {
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
        .on('presence', { event: 'sync' }, () => {
          const state = channel.presenceState() as unknown as Record<string, PresenceMeta[]>
          setPresence(reducePresence(state))
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

  const value: TeamChatValue = {
    messages,
    loading,
    unread,
    presence,
    members,
    myStatus,
    send: async (body: string, mentionedUserIds: string[] = []) => {
      const uid = userIdRef.current
      const text = body.trim()
      if (!text || !uid) return { ok: false }
      const { data, error } = await supabase
        .from('team_messages')
        .insert({ author_id: uid, body: text, mentioned_user_ids: mentionedUserIds })
        .select('*')
        .single()
      if (error || !data) return { ok: false, error: error?.message }
      const row = data as TeamMessage
      setMessages((prev) => (prev.some((m) => m.id === row.id) ? prev : [...prev, row]))
      lastActivityRef.current = Date.now()
      if (viewingRef.current) stampSeen()
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
      setUnread(0)
      stampSeen()
    },
    setViewing: (viewing: boolean) => {
      viewingRef.current = viewing
      if (viewing) {
        setUnread(0)
        stampSeen()
      }
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
  }

  return <TeamChatContext.Provider value={value}>{children}</TeamChatContext.Provider>
}
