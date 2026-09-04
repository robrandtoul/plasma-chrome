/* ─────────────────────────────────────────────────────────────
   @plasma/chrome/chat — the contract between the chat and its host.

   The chat is ONE implementation shared by all four staff apps. It
   used to be two hand-maintained copies (proof-viewer's, and a fork
   in stock-control frozen at an older commit), and they drifted far
   enough that the stale one was writing its staleness back into
   shared database state. See docs/handoff/CHAT.md.

   Everything host-specific arrives through ChatConfig. The package
   itself reaches for nothing: no module-singleton client, no auth
   module, no router, no icon library, no Tailwind. That is the same
   rule the navigation chrome follows next door, and for the same
   reason — the four hosts are React 18, 18, 19 and 19, and Tailwind
   v3, v4, v4 and none at all. Depending on none of them is the fix.

   THE SUPABASE CLIENT IS INJECTED, NOT IMPORTED. `import type` is
   erased at build, so package.json still declares React and only
   React at runtime. @supabase/supabase-js is a devDependency here,
   present for typechecking only; every consumer already has it,
   since they need it to construct the client they pass in.
   ─────────────────────────────────────────────────────────── */

import type { SupabaseClient } from '@supabase/supabase-js';

/** The schema the chat tables live in. Overridable, but never in practice. */
export const CHAT_SCHEMA = 'proofs';

/** The storage bucket attachments are read from and written to. */
export const CHAT_BUCKET = 'chat-attachments';

/**
 * The realtime topic. Deliberately a fixed literal shared by every app:
 * presence, typing and read-receipts all ride it, so all four apps joining
 * the SAME topic is what makes one person appear once rather than four
 * times. This was already true of the two existing copies by accident;
 * here it is true on purpose.
 */
export const CHAT_CHANNEL = 'team-chat';

/**
 * The id a host must put on its dock container if it sets `dockEnabled`.
 *
 * Pressing the header button while the panel is docked focuses the docked
 * composer rather than opening a redundant floating copy, and it finds it by
 * this id. It was a bare string in two places before, invisible to the type
 * system, so a host that spelled it differently got a silent no-op. Exported
 * so the contract is at least nameable.
 */
export const CHAT_DOCK_ID = 'team-chat-dock';

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
  client: SupabaseClient;

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
  client: SupabaseClient;
  userId: string | null;
}

export function resolveChatConfig(config: ChatConfig): ResolvedChatConfig {
  const storagePrefix = config.storagePrefix ?? 'plasma:chat';
  return {
    client: config.client,
    userId: config.userId,
    isAdmin: config.isAdmin ?? false,
    storagePrefix,
    fullPagePath: config.fullPagePath ?? '/chat',
    popoutEnabled: config.popoutEnabled ?? true,
    popoutWindowName: config.popoutWindowName ?? `${storagePrefix}-popout`,
    dockEnabled: config.dockEnabled ?? false,
    schema: config.schema ?? CHAT_SCHEMA,
  };
}

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
export const CHAT_STATUS_META: Record<ChatStatus, { label: string; dot: string }> = {
  online: { label: 'Online', dot: '#22c55e' },
  idle: { label: 'Idle', dot: '#f59e0b' },
  away: { label: 'Away', dot: '#9ca3af' },
  busy: { label: 'Busy', dot: '#ef4444' },
};

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
}

/**
 * The router seam, identical in shape to the chrome's own `linkComponent`.
 * Defaults to a plain anchor, which is correct for the two apps that link
 * across to another subdomain.
 */
export type ChatLinkComponent = React.ComponentType<
  { to: string; className?: string; children?: React.ReactNode } & Record<string, unknown>
>;
