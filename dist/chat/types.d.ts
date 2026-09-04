/**
 * A PostgREST query builder. Deliberately `any`: it is a deep fluent chain
 * whose shape is supabase-js's business, not this package's, and reproducing
 * it here would reintroduce exactly the version coupling described above.
 * Results are narrowed at the point of use instead.
 */
export type ChatQueryBuilder = any;
/** A client scoped to one schema. */
export interface ChatSchemaClient {
    from(table: string): ChatQueryBuilder;
    rpc(fn: string, args?: Record<string, unknown>): ChatQueryBuilder;
}
/** The realtime channel, as the chat uses it. */
export interface ChatRealtimeChannel {
    on(type: string, filter: any, callback: (payload: any) => void): ChatRealtimeChannel;
    subscribe(callback?: (status: string) => void): ChatRealtimeChannel;
    send(message: Record<string, unknown>): unknown;
    track(payload: Record<string, unknown>): unknown;
    presenceState(): Record<string, unknown[]>;
}
/** One storage bucket, as the chat uses it. */
export interface ChatStorageBucket {
    createSignedUrls(paths: string[], expiresIn: number): Promise<{
        data: {
            signedUrl: string | null;
        }[] | null;
        error: any;
    }>;
    upload(path: string, body: any, options?: any): Promise<{
        data: any;
        error: any;
    }>;
    remove(paths: string[]): Promise<{
        data: any;
        error: any;
    }>;
}
/**
 * The host's Supabase client, described by the four things the chat calls on
 * it. A real `SupabaseClient` of any 2.x satisfies this.
 */
export interface ChatSupabaseClient {
    schema(name: string): ChatSchemaClient;
    channel(name: string, opts?: any): ChatRealtimeChannel;
    removeChannel(channel: any): unknown;
    storage: {
        from(bucket: string): ChatStorageBucket;
    };
}
/** The schema the chat tables live in. Overridable, but never in practice. */
export declare const CHAT_SCHEMA = "proofs";
/** The storage bucket attachments are read from and written to. */
export declare const CHAT_BUCKET = "chat-attachments";
/**
 * The realtime topic. Deliberately a fixed literal shared by every app:
 * presence, typing and read-receipts all ride it, so all four apps joining
 * the SAME topic is what makes one person appear once rather than four
 * times. This was already true of the two existing copies by accident;
 * here it is true on purpose.
 */
export declare const CHAT_CHANNEL = "team-chat";
/**
 * The id a host must put on its dock container if it sets `dockEnabled`.
 *
 * Pressing the header button while the panel is docked focuses the docked
 * composer rather than opening a redundant floating copy, and it finds it by
 * this id. It was a bare string in two places before, invisible to the type
 * system, so a host that spelled it differently got a silent no-op. Exported
 * so the contract is at least nameable.
 */
export declare const CHAT_DOCK_ID = "team-chat-dock";
export interface ChatConfig {
    /**
     * The host's own Supabase client, exactly as it built it.
     *
     * Pass the ROOT client, not a schema-scoped one. The package derives its
     * own `client.schema(CHAT_SCHEMA)` accessor for every table and RPC, and
     * uses the root only for `channel()`, `removeChannel()` and `storage`,
     * which are not schema-scoped.
     *
     * ⚠ This is why the accessor is derived here rather than left to the
     * host. Each app pins its client to its OWN schema (`public`, `proofs`,
     * `qr`, `programme`), so a host that passed its pinned client and let the
     * package call `.from()` directly would resolve against the wrong schema.
     * That is not hypothetical: stock-control's fork made exactly that slip on
     * one query, and its message search silently returned nothing for months
     * because `public.team_messages` does not exist. Deriving the accessor in
     * one place makes that mistake unavailable.
     */
    client: ChatSupabaseClient;
    /** The signed-in person, or null when signed out. The chat renders nothing without it. */
    userId: string | null;
    /**
     * May this person delete a colleague's message? Nothing else reads it.
     * Each host resolves it from its own role model; the database enforces the
     * real rule regardless (`team_messages_delete` allows author-or-admin), so
     * getting this wrong costs a disabled button, never an escalation.
     */
    isAdmin?: boolean;
    /**
     * Namespace for this app's browser-local storage keys and its
     * BroadcastChannel. Defaults to 'plasma:chat'.
     *
     * ⚠ It does NOT make preferences cross-app, and cannot: the four apps are
     * on four subdomains, and localStorage is per origin. Anything that must
     * follow a person between apps lives on proofs.profiles.team_chat_prefs
     * instead, which is why sound, pinned and the open conversation are stored
     * there and not here. What is left in browser storage is genuinely
     * per-window furniture: the popout's size, the dropdown's size, and the
     * tab-scoped "am I the popout" flag.
     */
    storagePrefix?: string;
    /** Where this app's own full-page chat lives. Defaults to '/chat'. */
    fullPagePath?: string;
    /**
     * Whether this app offers "pop out into its own window". Hosts without a
     * route for it should pass false, and the control disappears rather than
     * opening a window onto a 404.
     */
    popoutEnabled?: boolean;
    /**
     * The popout's window name. MUST be unique per app.
     *
     * ⚠ Named windows are keyed per browser, not per origin. With one SSO
     * session across four subdomains, a shared name means pressing "Pop out"
     * in Stock re-uses and navigates the window Proofs already opened. It
     * therefore defaults to the storage prefix rather than to a constant, so
     * two apps can only collide if they were deliberately given the same
     * namespace.
     */
    popoutWindowName?: string;
    /**
     * Whether this app has somewhere to dock the panel (proof-viewer's
     * dashboard rail). Hosts without one pass false and the placement is not
     * offered; the stored preference is left untouched so it survives.
     */
    dockEnabled?: boolean;
    /** The schema override. Present for completeness; leave it alone. */
    schema?: string;
}
/** Config after defaults, which is what the internals actually read. */
export interface ResolvedChatConfig extends Required<Omit<ChatConfig, 'client' | 'userId'>> {
    client: ChatSupabaseClient;
    userId: string | null;
}
export declare function resolveChatConfig(config: ChatConfig): ResolvedChatConfig;
/** Presence: what a colleague's dot says about them. */
export type ChatStatus = 'online' | 'idle' | 'away' | 'busy';
/**
 * Where the panel is showing: the header dropdown, docked into a host's own
 * rail, or in a window of its own.
 *
 * 'floating' and 'docked' persist; 'popout' deliberately does not. A popped
 * out window cannot survive a reload of the app that opened it, so
 * remembering the choice would mean starting up pointing at a window that
 * may not be there, with the chat reachable from nowhere.
 */
export type ChatPlacement = 'floating' | 'docked' | 'popout';
/** The shared room, or a private thread keyed by the other person's id. */
export type ChatThread = 'team' | string;
/** One attachment's metadata. The storage key is a uuid, so the real name rides here. */
export interface ChatAttachment {
    path: string;
    name: string;
    type: string;
    size: number;
}
export interface TeamMessage {
    id: string;
    author_id: string | null;
    /** Denormalised by the team_messages_set_author trigger, so the feed never
     *  joins back to the self-read-only profiles table. */
    author_name: string | null;
    author_initials: string | null;
    author_colour: string | null;
    body: string;
    /** Ids picked from the @mention autocomplete. Drives the push and the
     *  louder mention badge; the cosmetic highlight still matches on text. */
    mentioned_user_ids?: string[] | null;
    /** NULL = the shared room; set = a DM visible only to its two participants. */
    recipient_id?: string | null;
    /** Legacy image-only paths, pre-dating attachment_files. */
    attachment_paths?: string[] | null;
    attachment_files?: ChatAttachment[] | null;
    created_at: string;
}
/** A colleague as presence sees them right now. Live-only, never stored. */
export interface PresenceMember {
    userId: string;
    name: string | null;
    initials: string | null;
    colour: string | null;
    avatarUrl: string | null;
    status: ChatStatus;
}
/** An active colleague, for the @mention picker and message highlighting.
 *  Sourced from proofs.team_roster(), never from a direct profiles read:
 *  profiles SELECT is self-or-admin only, so a plain select would return
 *  exactly one row for most of the team. */
export interface TeamMember {
    id: string;
    name: string | null;
    initials: string | null;
    colour: string | null;
    avatarUrl: string | null;
}
/** One emoji reaction: a row per message + user + emoji. */
export interface ReactionRow {
    id: string;
    message_id: string;
    user_id: string | null;
    user_name: string | null;
    emoji: string;
}
/** Traffic-light presence colours. Deliberately literal rather than design
 *  tokens: these read as universal signals and must look the same in all four
 *  apps, only two of which share a token set. */
export declare const CHAT_STATUS_META: Record<ChatStatus, {
    label: string;
    dot: string;
}>;
/**
 * Preferences that follow a person between apps, stored as one jsonb column
 * (proofs.profiles.team_chat_prefs) rather than in browser storage.
 *
 * Every field is optional and every reader must cope with the column being
 * absent: a host running against a database that predates the migration gets
 * the code defaults and nothing breaks.
 */
export interface ChatPrefs {
    sound?: boolean;
    pinned?: boolean;
    placement?: ChatPlacement;
    thread?: ChatThread;
    status?: ChatStatus;
    /** The header dropdown's size. Travels because the four staff apps are four
     *  subdomains: resize it in Proofs and it should still be that size in vCard
     *  Studio a second later, which is the whole point of one shared chat.
     *
     *  It was left in browser storage at first, on the argument that a large
     *  monitor's size has no business travelling to a laptop. That is weaker
     *  than it sounds: the size is clamped to a minimum on read and capped to
     *  the viewport at RENDER, not on write, so a small screen shows it capped
     *  while the stored value survives intact for the big one. */
    size?: {
        w: number;
        h: number;
    };
    /** The popped-out window's size, same reasoning. */
    popoutSize?: {
        w: number;
        h: number;
    };
    /** The height of the docked panel in a host's rail. Only proof-viewer has a
     *  dock, so this does not travel BETWEEN apps — it is here so the setting
     *  survives a new browser or cleared storage like every other one. */
    dockHeight?: number;
}
/**
 * The router seam: whatever the host hands us — react-router's Link, the
 * ChromeLink adapter each app already wrote for the nav, or the default 'a'.
 *
 * ⚠ Deliberately `ComponentType<any>`, exactly as the chrome's own
 * `ChromeLinkComponent` is, and for the reason the chrome found first. A
 * precisely-typed props shape looks better and does not work: a forwardRef
 * component whose own `to` is optional is not assignable to one whose `to` is
 * required, and every app's ChromeLink is written that way so it can accept
 * either `to` or `href`. Being strict here made three of the four apps fail to
 * typecheck against a component they were already passing to the chrome next
 * door.
 */
export type ChatLinkComponent = React.ComponentType<any>;
//# sourceMappingURL=types.d.ts.map