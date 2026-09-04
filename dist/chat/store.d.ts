import { type ReactNode } from 'react';
import { type ChatAttachment, type ChatConfig, type ChatPlacement, type ChatSchemaClient, type ChatStatus, type ChatThread, type PresenceMember, type ReactionRow, type ResolvedChatConfig, type TeamMember, type TeamMessage } from './types.js';
interface TeamChatValue {
    /** The host's settings after defaults. The panel reads `client` for
     *  storage, `isAdmin` for the delete affordance, and `fullPagePath` +
     *  `popoutEnabled` for its own controls. Null only when something renders
     *  outside the provider (a preview harness, a signed-out route). */
    config: ResolvedChatConfig | null;
    /** The schema-scoped accessor, derived once. Anything reading a chat table
     *  must go through this and never through `config.client` directly: each
     *  app pins its root client to its own schema, so a direct `.from()` there
     *  silently resolves against the wrong one. */
    db: ChatSchemaClient | null;
    messages: TeamMessage[];
    loading: boolean;
    /** Total unread across every thread (team room + all DMs). */
    unread: number;
    /** Of the team room's unread, how many @mention me. Drives the louder
     *  mention badge so a direct tag reads differently from ordinary chatter. */
    mentionUnread: number;
    /** Total unread across the private DM threads. DMs are personal, so this
     *  gets the same loud badge treatment as mentions. */
    dmUnread: number;
    /** Per-thread unread counts, keyed 'team' or the peer's user id. Missing
     *  key = zero. Drives the thread-switcher badges. */
    threadUnread: Record<string, number>;
    /** The conversation every chat surface is showing (they stay in sync via
     *  this shared engine): 'team' or a peer's user id. */
    activeThread: ChatThread;
    /** Switch thread. If a chat surface is open, the new thread is immediately
     *  marked read. */
    setActiveThread: (thread: ChatThread) => void;
    /** Fetch one older page (100) of a thread's history into the pool.
     *  Resolves to the number of messages actually added. */
    loadEarlier: (thread: ChatThread) => Promise<number>;
    /** Whether a thread may have more history to load: 'can-load' (show the
     *  button), 'loading' (fetch in flight), or 'exhausted' (start reached). */
    historyFor: (thread: ChatThread) => 'can-load' | 'loading' | 'exhausted';
    /** Everyone currently present, including yourself. */
    presence: PresenceMember[];
    /** Active team members, for the @mention picker + highlighting. */
    members: TeamMember[];
    /** All loaded emoji reactions (flat; group by message_id in the view). */
    reactions: ReactionRow[];
    /** Add your reaction to a message, or remove it if you've already reacted. */
    toggleReaction: (messageId: string, emoji: string) => void;
    /** Your own effective status (auto idle unless you've set Away/Busy). */
    myStatus: ChatStatus;
    send: (body: string, mentionedUserIds?: string[], attachments?: ChatAttachment[]) => Promise<{
        ok: boolean;
        error?: string;
    }>;
    remove: (id: string) => Promise<void>;
    /** Clear the unread badge and stamp "seen up to now". */
    markSeen: () => void;
    /** Tell the engine a chat surface is open (true) or closed (false). While
     *  open, incoming messages don't accrue unread — you're looking at them. */
    setViewing: (viewing: boolean) => void;
    /** Set your manual status. 'online' clears the manual override (back to auto
     *  online/idle); 'away' / 'busy' pin it until you change it. */
    setManualStatus: (status: 'online' | 'away' | 'busy') => void;
    /** Whether the header chat dropdown is "kept open" across pages + reloads
     *  (persisted to localStorage). When true it survives navigation and ignores
     *  outside-clicks, so you can keep chatting while working elsewhere. */
    dropdownPinned: boolean;
    setDropdownPinned: (pinned: boolean) => void;
    /** Whether notification sounds play on incoming messages (persisted). A subtle
     *  blip for a general message, a brighter chime when you're @mentioned. */
    soundEnabled: boolean;
    setSoundEnabled: (enabled: boolean) => void;
    /** Where the chat lives: 'floating' (header dropdown) or 'docked' (in the
     *  dashboard right rail). Only the dashboard renders the docked panel; the
     *  floating dropdown stays available everywhere. Persisted. */
    placement: ChatPlacement;
    setPlacement: (placement: ChatPlacement) => void;
    /** The header dropdown's size, and the setter the resize grip commits to on
     *  release. Held here rather than inside ChatMenu so it can be written to
     *  the profile as well as to this browser, and so a value arriving from
     *  another app lands on a live component instead of one that already read
     *  localStorage at mount. */
    chatSize: {
        w: number;
        h: number;
    };
    setChatSize: (size: {
        w: number;
        h: number;
    }) => void;
    /** The docked panel's height in pixels, or null for the host's default.
     *  Only a host that sets `dockEnabled` renders a dock, and it owns the drag
     *  handle; this is where the resulting height is kept. */
    dockHeight: number | null;
    setDockHeight: (height: number | null) => void;
    /** Move chat into a window of its own — a floating always-on-top window
     *  where the browser supports it, otherwise a plain second window. */
    openPopout: () => void;
    /** Bring a popped-out chat back into the app. */
    closePopout: () => void;
    /** Bring the popped-out window to the front. False means it has gone (or was
     *  never reachable), so the caller should fall back to showing chat in-app. */
    focusPopout: () => boolean;
    /** The picture-in-picture window the panel is rendered into, when that route
     *  is in use. Null on the second-window route, which renders itself.
     *  ChatPopoutHost is the only thing that should need this. */
    popoutWindow: Window | null;
    /** Other people currently typing a message (auto-expires ~4.5s after their
     *  last keystroke). Never includes yourself. */
    typingUsers: {
        userId: string;
        name: string | null;
    }[];
    /** Call as the user types to broadcast a throttled "typing" signal. */
    notifyTyping: () => void;
}
export declare const DEFAULT_CHAT_SIZE: {
    w: number;
    h: number;
};
export declare function useTeamChat(): TeamChatValue;
export declare function TeamChatProvider({ config, children, }: {
    config: ChatConfig;
    children: ReactNode;
}): import("react").JSX.Element;
export {};
//# sourceMappingURL=store.d.ts.map