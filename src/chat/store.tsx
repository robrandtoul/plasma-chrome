import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { playChatSound } from './sound'
import {
  POPOUT_HEARTBEAT_MS,
  isPopoutWindow,
  popoutIsAlive,
  popoutPath,
  preparePopoutDocument,
  readPopoutSize,
  syncChannelName,
  windowFeatures,
  writePopoutSize,
  type ChatSyncMessage,
} from './popout'
import {
  CHAT_CHANNEL,
  resolveChatConfig,
  type ChatAttachment,
  type ChatConfig,
  type ChatPlacement,
  type ChatPrefs,
  type ChatRealtimeChannel,
  type ChatSchemaClient,
  type ChatStatus,
  type ChatThread,
  type PresenceMember,
  type ReactionRow,
  type ResolvedChatConfig,
  type TeamMember,
  type TeamMessage,
} from './types'

// Shared "engine" for the team chat: one live connection (message realtime +
// presence) mounted once near the app root, so the header badge, the dropdown
// panel and the full /chat page all read the same state and nothing re-connects
// on navigation. Presence (who's online / idle / away / busy) rides the same
// channel and needs no database — it's ephemeral, live-only.

// Which thread a message belongs to, from my point of view: team-room rows to
// 'team'; a DM to the OTHER participant's id (their thread key), whether I
// sent or received it.
function threadOf(m: TeamMessage, myId: string | null): ChatThread {
  if (!m.recipient_id) return 'team'
  return m.author_id === myId ? m.recipient_id : (m.author_id ?? m.recipient_id)
}

// Ranked most-present → least, for picking a person's status across several open
// tabs and for sorting the roster.
const STATUS_RANK: Record<ChatStatus, number> = { online: 0, idle: 1, away: 2, busy: 3 }

// What each client broadcasts about itself on the presence channel.
interface PresenceMeta {
  // Index signature so this satisfies the channel's Record<string, unknown>
  // payload parameter. It is a plain data bag broadcast over presence, so
  // there is nothing to lose by saying so.
  [key: string]: unknown
  user_id: string
  name: string | null
  initials: string | null
  colour: string | null
  avatar_url?: string | null
  status: ChatStatus
}

interface TeamChatValue {
  /** The host's settings after defaults. The panel reads `client` for
   *  storage, `isAdmin` for the delete affordance, and `fullPagePath` +
   *  `popoutEnabled` for its own controls. Null only when something renders
   *  outside the provider (a preview harness, a signed-out route). */
  config: ResolvedChatConfig | null
  /** The schema-scoped accessor, derived once. Anything reading a chat table
   *  must go through this and never through `config.client` directly: each
   *  app pins its root client to its own schema, so a direct `.from()` there
   *  silently resolves against the wrong one. */
  db: ChatSchemaClient | null
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
  /** The header dropdown's size, and the setter the resize grip commits to on
   *  release. Held here rather than inside ChatMenu so it can be written to
   *  the profile as well as to this browser, and so a value arriving from
   *  another app lands on a live component instead of one that already read
   *  localStorage at mount. */
  chatSize: { w: number; h: number }
  setChatSize: (size: { w: number; h: number }) => void
  /** The docked panel's height in pixels, or null for the host's default.
   *  Only a host that sets `dockEnabled` renders a dock, and it owns the drag
   *  handle; this is where the resulting height is kept. */
  dockHeight: number | null
  setDockHeight: (height: number | null) => void
  /** Move chat into a window of its own — a floating always-on-top window
   *  where the browser supports it, otherwise a plain second window. */
  openPopout: () => void
  /** Bring a popped-out chat back into the app. */
  closePopout: () => void
  /** Bring the popped-out window to the front. False means it has gone (or was
   *  never reachable), so the caller should fall back to showing chat in-app. */
  focusPopout: () => boolean
  /** The picture-in-picture window the panel is rendered into, when that route
   *  is in use. Null on the second-window route, which renders itself.
   *  ChatPopoutHost is the only thing that should need this. */
  popoutWindow: Window | null
  /** Other people currently typing a message (auto-expires ~4.5s after their
   *  last keystroke). Never includes yourself. */
  typingUsers: { userId: string; name: string | null }[]
  /** Call as the user types to broadcast a throttled "typing" signal. */
  notifyTyping: () => void
}

/* ── Preferences ────────────────────────────────────────────────────────
   Two stores, and the split is deliberate.

   BROWSER STORAGE is the fast local copy. It is read synchronously in a
   lazy state initialiser, so the first paint is already correct and the
   dropdown does not flash open-then-closed while a request is in flight. It
   also means the chat still remembers your choices with the network down.

   THE DATABASE (proofs.profiles.team_chat_prefs) is the source of truth
   ACROSS apps. localStorage is scoped to an origin and the four staff apps
   are four subdomains, so browser storage physically cannot carry a
   preference from Proofs to Stock. Anything that should follow the person
   — sound, pinned, placement, and above all which conversation was open —
   is therefore written to both: local for speed, database for travel.

   On load the database wins, because it is the one that knows what you did
   in the app you were just in. If the column is missing (a host running
   against a database that predates the migration) or the read fails, the
   local value simply stands, which is exactly today's behaviour. */

function keyFor(prefix: string, name: string): string {
  return `${prefix}-${name}`
}

function readLocal(prefix: string, name: string): string | null {
  try {
    return localStorage.getItem(keyFor(prefix, name))
  } catch {
    return null
  }
}

function writeLocal(prefix: string, name: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(keyFor(prefix, name))
    else localStorage.setItem(keyFor(prefix, name), value)
  } catch {
    /* storage unavailable (private mode, embedded contexts) — the setting
       still applies for this session, it just will not survive a reload. */
  }
}

export const DEFAULT_CHAT_SIZE = { w: 460, h: 460 }
const MIN_CHAT_W = 320
const MIN_CHAT_H = 300

/** A stored {w,h}, floored at the minimum. Deliberately NOT capped to the
 *  viewport here: the cap belongs at render, so a laptop shows a desktop's
 *  size shrunk to fit while the stored value stays intact for the desktop. */
function readSize(prefix: string): { w: number; h: number } {
  const raw = readLocal(prefix, 'size')
  if (raw) {
    try {
      const p = JSON.parse(raw) as { w?: unknown; h?: unknown }
      if (typeof p.w === 'number' && typeof p.h === 'number') {
        return { w: Math.max(MIN_CHAT_W, p.w), h: Math.max(MIN_CHAT_H, p.h) }
      }
    } catch {
      /* ignore */
    }
  }
  return DEFAULT_CHAT_SIZE
}

function readDockHeight(prefix: string): number | null {
  const raw = readLocal(prefix, 'dock-height')
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null
}

function readPinned(prefix: string): boolean {
  return readLocal(prefix, 'pinned') === '1'
}

// Sounds default ON; only an explicit '0' turns them off.
function readSound(prefix: string): boolean {
  return readLocal(prefix, 'sound') !== '0'
}

// Placement defaults to floating; only an explicit 'docked' opts in.
function readPlacement(prefix: string): ChatPlacement {
  return readLocal(prefix, 'placement') === 'docked' ? 'docked' : 'floating'
}

// The last-open conversation: 'team' or a peer's user id. A restored peer who
// has since been deactivated is validated against the live roster on load (see
// the guard in the mount effect) and falls back to the room.
function readThread(prefix: string): ChatThread {
  return readLocal(prefix, 'thread') || 'team'
}

// Inert default so consumers (e.g. the header) don't crash if they render
// outside the provider (the design-system preview harness, signed-out routes).
const DEFAULT: TeamChatValue = {
  config: null,
  db: null,
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
  chatSize: DEFAULT_CHAT_SIZE,
  setChatSize: () => {},
  dockHeight: null,
  setDockHeight: () => {},
  openPopout: () => {},
  closePopout: () => {},
  focusPopout: () => false,
  popoutWindow: null,
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
const RESYNC_THROTTLE_MS = 3000 // collapse a burst of focus/visibility events

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

export function TeamChatProvider({
  config,
  children,
}: {
  config: ChatConfig
  children: ReactNode
}) {
  // Defaults applied once per config identity. Hosts building the object
  // inline in JSX would otherwise hand us a new object every render; the
  // fields are primitives plus the client, so memoising on those is enough
  // and saves every consumer having to remember useMemo.
  const cfg = useMemo(
    () => resolveChatConfig(config),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      config.client,
      config.userId,
      config.isAdmin,
      config.storagePrefix,
      config.fullPagePath,
      config.popoutEnabled,
      config.popoutWindowName,
      config.dockEnabled,
      config.schema,
    ],
  )

  const userId = cfg.userId
  const prefix = cfg.storagePrefix

  // The chat's own view of the database, ALWAYS schema-scoped. Every table
  // read and every RPC goes through this; the root client is used only for
  // channel(), removeChannel() and storage, none of which are schema-scoped.
  // See the note on ChatConfig.client for why this is derived here and not
  // left to the host.
  const db = useMemo(() => cfg.client.schema(cfg.schema), [cfg.client, cfg.schema])

  const cfgRef = useRef(cfg)
  cfgRef.current = cfg
  const dbRef = useRef(db)
  dbRef.current = db

  const [messages, setMessages] = useState<TeamMessage[]>([])
  const [loading, setLoading] = useState(true)
  // Unread per thread ('team' or peer id). Totals are derived at render.
  const [threadUnread, setThreadUnread] = useState<Record<string, number>>({})
  const [mentionUnread, setMentionUnread] = useState(0)
  const [activeThread, setActiveThreadState] = useState<ChatThread>(() => readThread(prefix))
  // Per-thread history pager: absent = unknown, 'loading' = fetch in flight,
  // 'exhausted' = the start of that thread's history is loaded.
  const [historyStatus, setHistoryStatus] = useState<Record<string, 'loading' | 'exhausted'>>({})
  const [presence, setPresence] = useState<PresenceMember[]>([])
  const [members, setMembers] = useState<TeamMember[]>([])
  const [reactions, setReactions] = useState<ReactionRow[]>([])
  const [myStatus, setMyStatus] = useState<ChatStatus>('online')
  const [dropdownPinned, setDropdownPinnedState] = useState<boolean>(() => readPinned(prefix))
  const [soundEnabled, setSoundEnabledState] = useState<boolean>(() => readSound(prefix))
  const [placement, setPlacementState] = useState<ChatPlacement>(() => readPlacement(prefix))
  const [chatSize, setChatSizeState] = useState(() => readSize(prefix))
  const [dockHeight, setDockHeightState] = useState<number | null>(() => readDockHeight(prefix))
  const [typingUsers, setTypingUsers] = useState<{ userId: string; name: string | null }[]>([])
  // The picture-in-picture window, when chat has been popped out that way. It
  // is state (not just a ref) because ChatPopoutHost renders the panel into it.
  const [popoutWindow, setPopoutWindow] = useState<Window | null>(null)

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
  // The last-known preference blob, so a write can MERGE rather than replace:
  // two apps changing different settings at the same moment must not clobber
  // each other's.
  const prefsRef = useRef<ChatPrefs>({})
  // Per-peer DM "last read" stamps (team_chat_dm_reads), keyed by peer id.
  const dmReadsRef = useRef<Record<string, string>>({})
  const activeThreadRef = useRef<ChatThread>(readThread(prefix))
  const messagesRef = useRef<TeamMessage[]>([])
  messagesRef.current = messages
  const historyStatusRef = useRef(historyStatus)
  historyStatusRef.current = historyStatus
  // Whether the latest window came back full — if not, the entire history is
  // already loaded and no thread has anything earlier to fetch. Only ever set
  // from a SUCCESSFUL sync: a failed fetch that set it false used to hide the
  // "Show earlier messages" button, removing the last way back to the history.
  const initialFullRef = useRef(false)
  // Guards against overlapping syncs (resume and reconnect often coincide).
  const syncingRef = useRef(false)
  // Set when the realtime socket drops so the next SUBSCRIBED resyncs the gap.
  const staleRef = useRef(false)
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
  const channelRef = useRef<ChatRealtimeChannel | null>(null)

  // ── Popout plumbing ───────────────────────────────────────────────────────
  // The two routes are tracked separately because they need different handling:
  // the picture-in-picture window is rendered INTO (same React tree, so nothing
  // to synchronise), while the plain second window is a separate copy of the
  // app that can only be talked to.
  const pipWindowRef = useRef<Window | null>(null)
  const plainWindowRef = useRef<Window | null>(null)
  // Fixed for the life of this window: am I the popped-out copy?
  const [amPopout] = useState(() => isPopoutWindow(prefix))
  const syncChannelRef = useRef<BroadcastChannel | null>(null)
  // When another window last announced itself as the popout. Drives both "chat
  // lives over there" in the header and this window keeping quiet.
  const remoteBeatRef = useRef(0)
  const placementRef = useRef<ChatPlacement>(placement)
  placementRef.current = placement

  // Only one window should make a noise for an incoming message. On the second
  // window route two copies of the app are listening, so the popped-out one —
  // the window the user is actually looking at chat in — wins and everything
  // else stays quiet. The picture-in-picture route never reaches this: there is
  // only one copy of the app, so nothing is broadcasting and nothing is muted.
  function anotherWindowOwnsSound(): boolean {
    return !amPopout && popoutIsAlive(remoteBeatRef.current, Date.now())
  }

  function postSync(msg: ChatSyncMessage) {
    try {
      syncChannelRef.current?.postMessage(msg)
    } catch {
      /* channel closed mid-teardown — nothing to co-ordinate */
    }
  }

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

  /**
   * Write one preference to BOTH stores: browser storage for this app's own
   * speed and offline behaviour, and proofs.profiles.team_chat_prefs so it
   * follows the person into the other three apps.
   *
   * The database write is fire-and-forget and merges rather than replaces, so
   * two apps changing different settings at once cannot clobber each other.
   * ⚠ supabase-js builders are lazy: a bare `void builder` never reaches the
   * network. That is exactly how the read stamps once shipped broken, so the
   * .then() here is load-bearing, not decoration.
   *
   * A failure is logged and otherwise ignored. The local write has already
   * happened, so the setting still applies here; it just will not travel. A
   * database that predates the migration has no such column and fails the same
   * way, which is what makes the deploy order free.
   */
  function persistPref(patch: ChatPrefs, local: Array<[string, string | null]>) {
    const prefix = cfgRef.current.storagePrefix
    for (const [name, val] of local) writeLocal(prefix, name, val)

    const uid = userIdRef.current
    if (!uid) return
    prefsRef.current = { ...prefsRef.current, ...patch }
    void dbRef.current
      .from('profiles')
      .update({ team_chat_prefs: prefsRef.current })
      .eq('id', uid)
      .then(({ error }: { error: { message: string } | null }) => {
        if (error) console.warn('[chat] preference did not sync across apps:', error.message)
      })
  }

  // Mark one thread read: persist the stamp (profiles.team_chat_seen_at for
  // the room, team_chat_dm_reads for a DM) and zero its unread count.
  function stampSeen(thread: ChatThread) {
    const uid = userIdRef.current
    if (!uid) return
    const nowIso = new Date().toISOString()
    // ⚠ supabase-js builders are lazy — the request only fires once .then()
    // is invoked (i.e. on await). A bare `void builder` never hits the
    // network, which is exactly how these stamps shipped broken: unread
    // counts cleared locally but resurrected on every reload. Fire-and-forget
    // writes must attach .then to execute (and surface failures).
    if (thread === 'team') {
      seenAtRef.current = nowIso
      void dbRef.current
        .from('profiles')
        .update({ team_chat_seen_at: nowIso })
        .eq('id', uid)
        .then(({ error }: { error: { message: string } | null }) => {
          if (error) console.error('[chat] team seen stamp failed:', error.message)
        })
      setMentionUnread(0)
    } else {
      dmReadsRef.current[thread] = nowIso
      void dbRef.current
        .from('team_chat_dm_reads')
        .upsert({ user_id: uid, peer_id: thread, seen_at: nowIso }, { onConflict: 'user_id,peer_id' })
        .then(({ error }: { error: { message: string } | null }) => {
          if (error) console.error('[chat] DM read stamp failed:', error.message)
        })
    }
    setThreadUnread((prev) => {
      if (!prev[thread]) return prev
      const next = { ...prev }
      delete next[thread]
      return next
    })
    // Tell any other window of this app (a second tab, or the popped-out chat)
    // that this thread has been read, so its badge clears too. Without this,
    // reading in the popout leaves the main window's header still claiming
    // unread messages until its next resync.
    postSync({ kind: 'seen', thread, at: nowIso })

    // And tell the OTHER APPS, over the topic all four share. The stamp above
    // is already durable in the database, so this is purely about latency: it
    // is the difference between Stock's badge clearing the moment you read a
    // message in Proofs, and clearing whenever Stock next resyncs. Best
    // effort by design — if the socket is down the durable stamp still wins
    // at the next sync, so nothing is lost, only delayed.
    const ch = channelRef.current
    if (ch) {
      void ch.send({
        type: 'broadcast',
        event: 'seen',
        payload: { userId: uid, thread, at: nowIso },
      })
    }
  }

  // The other half of the above: another window read a thread, so clear it
  // here. The seen stamps are updated as well as the counts — a resync
  // recomputes unread from those stamps, so skipping them would resurrect the
  // badge seconds later.
  function applyRemoteSeen(thread: ChatThread, at: string) {
    if (thread === 'team') {
      seenAtRef.current = at
      setMentionUnread(0)
    } else {
      dmReadsRef.current[thread] = at
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

  // Pull the newest window of messages and reconcile it against what's in
  // memory. Runs on mount, whenever the app returns to the foreground, and
  // after the realtime socket reconnects.
  //
  // Why a resync is needed at all: messages used to be fetched exactly once,
  // with the live channel expected to carry everything after that. iOS kills
  // the socket when an installed PWA is backgrounded but keeps the page in
  // memory, so reopening the app neither remounts nor refetches — every
  // message sent while the phone was asleep was missed permanently, and
  // silently. Reconciling here is what makes a phone self-heal.
  async function syncMessages(): Promise<void> {
    const uid = userIdRef.current
    if (!uid || syncingRef.current) return
    syncingRef.current = true
    try {
      // RLS scopes this to the team room + my own DM threads (000324).
      const { data, error } = await dbRef.current
        .from('team_messages')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(INITIAL_LIMIT)

      // Never clobber a good history with a bad answer. A failed request (or a
      // quietly expired session) arrives as `data: null`, which — before this
      // guard — emptied the list and left no way back to the conversation.
      if (error) {
        console.error('[chat] message sync failed:', error.message)
        return
      }
      const fetched = ((data ?? []) as TeamMessage[]).slice().reverse()
      // An empty answer when we already hold messages is far more likely to be
      // a transient read failure than every message having been deleted, so
      // keep what we have; the DELETE handler covers genuine removals.
      if (fetched.length === 0 && messagesRef.current.length > 0) return

      // The window is authoritative for its own time range: anything in memory
      // inside it is replaced (so deletions made while away disappear), while
      // older pages pulled in via "Show earlier messages" are kept.
      const windowStart = fetched[0]?.created_at ?? null
      const merged = windowStart
        ? [...messagesRef.current.filter((m) => m.created_at < windowStart), ...fetched]
        : fetched
      messagesRef.current = merged
      setMessages(merged)
      initialFullRef.current = fetched.length >= INITIAL_LIMIT

      // Recompute unread from the seen stamps rather than incrementing, so a
      // resync that replays known messages can't inflate the badges. The team
      // room measures against team_chat_seen_at, each DM against its own
      // team_chat_dm_reads stamp.
      const counts: Record<string, number> = {}
      let mentions = 0
      for (const m of merged) {
        if (m.author_id === uid) continue
        const thread = threadOf(m, uid)
        if (thread === 'team') {
          const seen = seenAtRef.current
          if (!seen || m.created_at > seen) {
            counts.team = (counts.team ?? 0) + 1
            if (Array.isArray(m.mentioned_user_ids) && m.mentioned_user_ids.includes(uid)) {
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
      // Messages that landed while away in the thread already on screen count
      // as read the moment they're shown, matching the live INSERT path. Gated
      // on there being something to clear so a routine resync doesn't write a
      // stamp every time the window regains focus.
      if (viewingRef.current && counts[activeThreadRef.current]) {
        stampSeen(activeThreadRef.current)
      }

      // Reactions for the window, which may have changed while we were away.
      // Scoped to the window's ids so the query stays bounded no matter how
      // many earlier pages are loaded; reactions on older messages are kept.
      const windowIds = fetched.map((m) => m.id)
      if (windowIds.length > 0) {
        const { data: reactData, error: reactError } = await dbRef.current
          .from('team_message_reactions')
          .select('*')
          .in('message_id', windowIds)
        if (!reactError) {
          const inWindow = new Set(windowIds)
          setReactions((prev) => [
            ...prev.filter((r) => !inWindow.has(r.message_id)),
            ...((reactData ?? []) as ReactionRow[]),
          ])
        }
      }
    } finally {
      syncingRef.current = false
    }
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
    // Start from empty so a sign-in as someone else can't have the previous
    // account's messages survive the merge inside syncMessages().
    messagesRef.current = []
    setMessages([])

    void (async () => {
      const [{ data: prof }, { data: mem }, { data: dmReads }, prefsRow] = await Promise.all([
        dbRef.current
          .from('profiles')
          .select('full_name, designer_initials, designer_colour, avatar_url, team_chat_seen_at')
          .eq('id', userId)
          .single(),
        // Roster for the DM pills, @mention picker and message author
        // avatar/name lookup. Via the SECURITY DEFINER team_roster() RPC
        // (000329), NOT a direct profiles read: the profiles SELECT policies
        // only let a non-admin see their OWN row, so a direct read collapsed
        // the roster to [me] for every designer — no DM pills, no @mention
        // candidates. The RPC returns the same five roster columns for active
        // staff to any authenticated caller (sensitive columns stay admin-only).
        dbRef.current.rpc('team_roster'),
        dbRef.current.from('team_chat_dm_reads').select('peer_id, seen_at').eq('user_id', userId),
        // ⚠ Preferences are fetched SEPARATELY, and that is load-bearing.
        // PostgREST rejects an entire select if one named column does not
        // exist, so folding team_chat_prefs into the profile read above would
        // mean an app running against a database that predates the migration
        // lost the whole profile row: no seen stamp, no avatar, unread counts
        // recomputed from null. A column that may not be there yet gets its
        // own request, whose failure costs only the thing that is missing.
        dbRef.current
          .from('profiles')
          .select('team_chat_prefs')
          .eq('id', userId)
          .maybeSingle()
          .then(
            ({ data }: { data: { team_chat_prefs?: unknown } | null }) => data,
            () => null,
          ),
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

      // Preferences that followed the person from whichever app they were
      // last in. The database wins over the local copy here, because it is
      // the one that knows what they just did next door.
      //
      // ⚠ Every branch is guarded on the key being PRESENT, not merely
      // truthy, so a partial blob only overrides what it actually carries.
      // An absent column (a database predating the migration) or a failed
      // read leaves `prefs` empty and every local value standing, which is
      // precisely today's behaviour — that is what makes the deploy order
      // free in either direction.
      const rawPrefs = prefsRow?.team_chat_prefs
      const prefs: ChatPrefs =
        rawPrefs && typeof rawPrefs === 'object' && !Array.isArray(rawPrefs)
          ? (rawPrefs as ChatPrefs)
          : {}
      prefsRef.current = prefs

      if (typeof prefs.sound === 'boolean') {
        setSoundEnabledState(prefs.sound)
        writeLocal(prefix, 'sound', prefs.sound ? null : '0')
      }
      if (typeof prefs.pinned === 'boolean') {
        setDropdownPinnedState(prefs.pinned)
        writeLocal(prefix, 'pinned', prefs.pinned ? '1' : null)
      }
      // Placement is only honoured where the host actually has a dock to
      // honour it with. Proof-viewer has a dashboard rail; the other three do
      // not, and a stored 'docked' there would leave the panel nowhere.
      // The stored value is deliberately left untouched so it still works when
      // the person returns to the app that can render it.
      if (prefs.placement === 'docked' && cfgRef.current.dockEnabled) {
        setPlacementState('docked')
      }
      // Sizes. These land on live state rather than only in storage, because
      // ChatMenu reads its size once at mount and this arrives after: writing
      // localStorage alone would leave the panel at the old size until the
      // next reload, which is exactly the "it didn't follow me" complaint.
      if (
        prefs.size &&
        typeof prefs.size.w === 'number' &&
        typeof prefs.size.h === 'number'
      ) {
        const size = {
          w: Math.max(MIN_CHAT_W, prefs.size.w),
          h: Math.max(MIN_CHAT_H, prefs.size.h),
        }
        setChatSizeState(size)
        writeLocal(prefix, 'size', JSON.stringify(size))
      }
      if (
        prefs.popoutSize &&
        typeof prefs.popoutSize.w === 'number' &&
        typeof prefs.popoutSize.h === 'number'
      ) {
        // Straight to storage: the popout reads its size when it opens, which
        // is always after this, so there is no live component to update.
        writePopoutSize(prefix, prefs.popoutSize)
      }
      if (typeof prefs.dockHeight === 'number' && prefs.dockHeight > 0) {
        const h = Math.round(prefs.dockHeight)
        setDockHeightState(h)
        writeLocal(prefix, 'dock-height', String(h))
      }
      if (prefs.status === 'away' || prefs.status === 'busy') {
        manualRef.current = prefs.status
        refreshStatus()
      }
      if (typeof prefs.thread === 'string' && prefs.thread !== activeThreadRef.current) {
        activeThreadRef.current = prefs.thread
        setActiveThreadState(prefs.thread)
        writeLocal(prefix, 'thread', prefs.thread === 'team' ? null : prefs.thread)
      }

      // Guard the restored thread against the live roster: a DM whose peer has
      // since been deactivated/removed isn't in `mem`, so fall back to the team
      // room rather than stranding the user on a thread with no pill and a
      // "Message the team…" composer. 'team' is always valid.
      const restoredThread = activeThreadRef.current
      if (
        restoredThread !== 'team' &&
        !((mem ?? []) as Array<{ id: string }>).some((m) => m.id === restoredThread)
      ) {
        activeThreadRef.current = 'team'
        setActiveThreadState('team')
        persistPref({ thread: 'team' }, [['thread', null]])
      }

      seenAtRef.current = (prof?.team_chat_seen_at as string | null) ?? null
      profileRef.current = {
        name: prof?.full_name ?? null,
        initials: prof?.designer_initials ?? null,
        colour: prof?.designer_colour ?? null,
        avatarUrl: prof?.avatar_url ?? null,
      }

      // Messages, unread counts and reactions all come from the shared sync so
      // the first load and every later resume take exactly the same path.
      setHistoryStatus({})
      await syncMessages()
      if (cancelled) return
      setLoading(false)

      const channel = cfgRef.current.client
        .channel(CHAT_CHANNEL, { config: { presence: { key: userId } } })
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: cfgRef.current.schema, table: 'team_messages' },
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
              // subtle blip (throttled so a burst doesn't machine-gun). Muted
              // while chat is popped out into a window of its own — that window
              // is listening too, and two copies of the app would chime at once.
              if (soundEnabledRef.current && !anotherWindowOwnsSound()) {
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
          { event: 'DELETE', schema: cfgRef.current.schema, table: 'team_messages' },
          (payload) => {
            const old = payload.old as { id?: string }
            if (old?.id) setMessages((prev) => prev.filter((m) => m.id !== old.id))
          },
        )
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: cfgRef.current.schema, table: 'team_message_reactions' },
          (payload) => {
            const row = payload.new as ReactionRow
            setReactions((prev) => (prev.some((r) => r.id === row.id) ? prev : [...prev, row]))
          },
        )
        .on(
          'postgres_changes',
          { event: 'DELETE', schema: cfgRef.current.schema, table: 'team_message_reactions' },
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
        .on('broadcast', { event: 'seen' }, ({ payload }) => {
          // The SAME person reading in ANOTHER APP.
          //
          // This is what makes read state cross the estate. The
          // BroadcastChannel next to it is origin-scoped, so it can only ever
          // reach this app's own tabs and its popout; four apps on four
          // subdomains cannot hear each other that way. This topic is shared
          // by all four, so a badge cleared in Stock clears in Proofs as it
          // happens rather than at whenever Proofs next happens to resync.
          //
          // Ignore everyone else's receipts: another person reading their own
          // thread says nothing about mine.
          const p = payload as { userId?: string; thread?: string; at?: string }
          if (!p.userId || p.userId !== userIdRef.current) return
          if (!p.thread || !p.at) return
          applyRemoteSeen(p.thread, p.at)
        })
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            lastActivityRef.current = Date.now()
            myStatusRef.current = computeStatus()
            setMyStatus(myStatusRef.current)
            void channel.track(presencePayload())
            // Anything sent while the socket was down never arrived as an
            // INSERT, so close the gap on the way back up.
            if (staleRef.current) {
              staleRef.current = false
              void syncMessages()
            }
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            staleRef.current = true
          }
        })
      channelRef.current = channel
    })()

    return () => {
      cancelled = true
      if (channelRef.current) {
        void cfgRef.current.client.removeChannel(channelRef.current)
        channelRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId])

  // Resync whenever the app comes back to the user, or the network returns.
  //
  // This is the fix for a phone showing a conversation frozen hours earlier: an
  // installed PWA that gets backgrounded has its socket torn down by iOS, but
  // the page stays in memory, so returning to it neither remounts nor reopens
  // anything. Without this the missed messages never arrived at all — and with
  // no error and no gap marker, the chat simply looked finished.
  useEffect(() => {
    if (!userId) return
    let lastResync = 0
    function resync() {
      if (document.hidden) return
      // These three events overlap heavily (a desktop window switch can fire
      // all of them), so collapse a burst into one fetch.
      const now = Date.now()
      if (now - lastResync < RESYNC_THROTTLE_MS) return
      lastResync = now
      void syncMessages()
    }
    document.addEventListener('visibilitychange', resync)
    window.addEventListener('focus', resync)
    window.addEventListener('online', resync)
    return () => {
      document.removeEventListener('visibilitychange', resync)
      window.removeEventListener('focus', resync)
      window.removeEventListener('online', resync)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId])

  // Keep this app's windows in step: which one owns the notification sound,
  // what has been read, and whether a popped-out window is still open.
  //
  // Only the second-window route needs any of this. Picture-in-picture moves
  // the existing panel rather than starting a second copy of the app, so there
  // is no second listener to co-ordinate with and nothing below ever fires.
  // It also quietly fixes two ordinary tabs of the app double-chiming and
  // disagreeing about unread counts, which was true before any of this.
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return
    let channel: BroadcastChannel
    try {
      channel = new BroadcastChannel(syncChannelName(cfgRef.current.storagePrefix))
    } catch {
      return /* unavailable — each window simply behaves independently */
    }
    syncChannelRef.current = channel

    channel.onmessage = (e: MessageEvent<ChatSyncMessage>) => {
      const msg = e.data
      if (!msg || typeof msg !== 'object') return
      switch (msg.kind) {
        case 'seen':
          applyRemoteSeen(msg.thread, msg.at)
          break
        case 'popout-alive':
          if (amPopout) break
          remoteBeatRef.current = Date.now()
          // Guarded, or a heartbeat every couple of seconds re-renders the app.
          if (placementRef.current !== 'popout') setPlacementState('popout')
          break
        case 'popout-closed':
          if (amPopout) break
          remoteBeatRef.current = 0
          plainWindowRef.current = null
          // Back to whatever placement was saved, not a hardcoded 'floating' —
          // someone who had chat docked should find it docked again.
          if (placementRef.current === 'popout') setPlacementState(readPlacement(cfgRef.current.storagePrefix))
          break
        case 'popout-close-request':
          // "Bring chat back", pressed in an app window that no longer holds a
          // handle on this one (it has reloaded since opening it).
          if (amPopout) window.close()
          break
      }
    }

    let beat: number | undefined
    let watchdog: number | undefined
    if (amPopout) {
      const announce = () => postSync({ kind: 'popout-alive' })
      announce()
      beat = window.setInterval(announce, POPOUT_HEARTBEAT_MS)
    } else {
      // A force-quit sends no farewell, so notice the silence instead —
      // otherwise the header goes on pointing at a window that has gone and
      // chat becomes unreachable from the app.
      watchdog = window.setInterval(() => {
        if (placementRef.current !== 'popout') return
        if (pipWindowRef.current) return /* that route resets on its own pagehide */
        const handle = plainWindowRef.current
        // A handle we still hold is the authoritative answer, and it covers the
        // second or so before a freshly opened window starts its heartbeat.
        if (handle && !handle.closed) return
        if (popoutIsAlive(remoteBeatRef.current, Date.now())) return
        remoteBeatRef.current = 0
        plainWindowRef.current = null
        setPlacementState(readPlacement(cfgRef.current.storagePrefix))
      }, POPOUT_HEARTBEAT_MS)
    }

    function farewell() {
      if (amPopout) postSync({ kind: 'popout-closed' })
    }
    window.addEventListener('pagehide', farewell)

    return () => {
      window.removeEventListener('pagehide', farewell)
      if (beat) window.clearInterval(beat)
      if (watchdog) window.clearInterval(watchdog)
      syncChannelRef.current = null
      channel.close()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amPopout])

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

  // ── Popout actions ────────────────────────────────────────────────────────

  function focusPopout(): boolean {
    const win = pipWindowRef.current ?? plainWindowRef.current
    if (win && !win.closed) {
      try {
        win.focus()
        return true
      } catch {
        return false
      }
    }
    // No handle: this window has reloaded since opening the popout. A named
    // window can be re-found by name — and passing an empty URL re-uses it
    // without navigating it. Only attempted while it is still heartbeating, so
    // this can never conjure a blank popup for a window that has gone.
    if (!popoutIsAlive(remoteBeatRef.current, Date.now())) return false
    try {
      const found = window.open('', cfgRef.current.popoutWindowName)
      if (!found || found.closed) return false
      plainWindowRef.current = found
      found.focus()
      return true
    } catch {
      return false
    }
  }

  async function openPopout() {
    // Already open — bring it forward rather than opening a second one.
    if (focusPopout()) return

    const size = readPopoutSize(cfgRef.current.storagePrefix)
    // Everything up to requestWindow stays synchronous: it may only be called
    // while the click that asked for it is still being handled.
    const pip = window.documentPictureInPicture
    if (pip) {
      let win: Window | null = null
      try {
        win = await pip.requestWindow({ width: size.w, height: size.h })
      } catch {
        // Refused: no user gesture left, one is already open, or there is no
        // real browser window to attach it to (an embedded web view answers
        // "InvalidStateError: no window"). A plain window works everywhere, so
        // fall through rather than doing nothing at all.
        win = null
      }
      if (win) {
        try {
          preparePopoutDocument(win)
        } catch {
          // Never leave an empty window sitting on screen: close it and take
          // the ordinary route instead.
          try {
            win.close()
          } catch {
            /* already gone */
          }
          win = null
        }
      }
      if (win) {
        const opened = win
        // Remember the size it's left at, and put chat back in the app the
        // moment the window goes — including when the browser closes it for us.
        opened.addEventListener('pagehide', () => {
          const popoutSize = { w: opened.innerWidth, h: opened.innerHeight }
          writePopoutSize(cfgRef.current.storagePrefix, popoutSize)
          // Also onto the profile, so re-opening the popout from a different
          // app gets the size you last dragged it to rather than the default.
          // A closing window reports 0×0 in some browsers; writePopoutSize
          // already ignores that, and so must this.
          if (popoutSize.w && popoutSize.h) persistPref({ popoutSize }, [])
          pipWindowRef.current = null
          setPopoutWindow(null)
          setPlacementState(readPlacement(cfgRef.current.storagePrefix))
        })
        pipWindowRef.current = opened
        setPopoutWindow(opened)
        setPlacementState('popout')
        return
      }
    }

    const win = window.open(
      popoutPath(cfgRef.current.fullPagePath),
      cfgRef.current.popoutWindowName,
      windowFeatures(size, { x: window.screenX, y: window.screenY, width: window.outerWidth }),
    )
    // Blocked by the browser: leave chat exactly where it was, so the panel
    // being looked at isn't traded for nothing.
    if (!win) return
    plainWindowRef.current = win
    setPlacementState('popout')
  }

  function closePopout() {
    const pip = pipWindowRef.current
    const plain = plainWindowRef.current
    try {
      if (pip && !pip.closed) pip.close()
      else if (plain && !plain.closed) plain.close()
      // No handle to it: this window has reloaded since opening the popout, so
      // ask the popout to close itself instead.
      else postSync({ kind: 'popout-close-request' })
    } catch {
      postSync({ kind: 'popout-close-request' })
    }
    pipWindowRef.current = null
    plainWindowRef.current = null
    remoteBeatRef.current = 0
    setPopoutWindow(null)
    setPlacementState(readPlacement(cfgRef.current.storagePrefix))
  }

  // Totals derived from the per-thread map (tiny arrays; no memo needed).
  const unread = Object.values(threadUnread).reduce((a, b) => a + b, 0)
  const dmUnread = unread - (threadUnread.team ?? 0)

  const value: TeamChatValue = {
    config: cfg,
    db,
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
      // Remember it so a hard refresh — or a switch to another app — reopens
      // this conversation rather than dumping you back in the room. 93% of
      // messages on live are DMs, so this is the preference that matters most.
      persistPref({ thread }, [['thread', thread === 'team' ? null : thread]])
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

      let q = dbRef.current.from('team_messages').select('*')
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
        const { data: reactData } = await dbRef.current
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
        void dbRef.current
          .from('team_message_reactions')
          .delete()
          .eq('id', existing.id)
          .then(({ error }: { error: { message: string } | null }) => {
            // Lazy-builder rule (see stampSeen): .then makes the delete real.
            // If it fails, put the optimistically-removed reaction back.
            if (error)
              setReactions((prev) =>
                prev.some((r) => r.id === existing.id) ? prev : [...prev, existing],
              )
          })
      } else {
        void (async () => {
          const { data } = await dbRef.current
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
      const { data, error } = await dbRef.current
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
      const { error } = await dbRef.current.from('team_messages').delete().eq('id', id)
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
      // Persisted because presence is reduced across a person's tabs by
      // keeping their MOST-present status: without this, an idle tab in
      // another app reporting 'online' silently overrides a deliberate
      // 'Busy' set here. Four apps makes that worse, not better.
      persistPref({ status }, [])
    },
    dropdownPinned,
    setDropdownPinned: (pinned: boolean) => {
      setDropdownPinnedState(pinned)
      persistPref({ pinned }, [['pinned', pinned ? '1' : null]])
    },
    soundEnabled,
    setSoundEnabled: (enabled: boolean) => {
      setSoundEnabledState(enabled)
      // Muting is the preference people most expect to travel: turn the sound
      // off in one app and the others must stop chiming too.
      persistPref({ sound: enabled }, [['sound', enabled ? null : '0']])
    },
    placement,
    setPlacement: (next: ChatPlacement) => {
      setPlacementState(next)
      // 'popout' is deliberately never persisted: a reload cannot re-find the
      // window it opened, so remembering it would start the app pointing at a
      // window that may be gone, with chat reachable from nowhere.
      if (next === 'popout') return
      persistPref({ placement: next }, [['placement', next === 'docked' ? 'docked' : null]])
    },
    chatSize,
    setChatSize: (size: { w: number; h: number }) => {
      const next = {
        w: Math.max(MIN_CHAT_W, Math.round(size.w)),
        h: Math.max(MIN_CHAT_H, Math.round(size.h)),
      }
      setChatSizeState(next)
      persistPref({ size: next }, [['size', JSON.stringify(next)]])
    },
    dockHeight,
    setDockHeight: (height: number | null) => {
      const next = height == null ? null : Math.round(height)
      setDockHeightState(next)
      persistPref({ dockHeight: next ?? undefined }, [
        ['dock-height', next == null ? null : String(next)],
      ])
    },
    openPopout: () => {
      void openPopout()
    },
    closePopout,
    focusPopout,
    popoutWindow,
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
