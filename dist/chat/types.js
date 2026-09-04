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

   THE SUPABASE CLIENT IS INJECTED, AND ITS TYPE IS STRUCTURAL.

   The obvious thing is `import type { SupabaseClient }`. It was the
   first version of this file and it does not work, because the four
   apps are on @supabase/supabase-js ^2.45, ^2.49 and ^2.112, and the
   shape of SupabaseClient has changed across that range: 2.112 added
   `getOpenApiSpec`, so a client built by an older copy is not
   assignable to the type from a newer one. Pinning the package to any
   one version would make it fail to typecheck in whichever apps
   disagreed, and force all four to upgrade in lockstep — the exact
   coupling this package exists to remove.

   So the client is described by what the chat ACTUALLY calls on it,
   below. Any real Supabase client satisfies it structurally, whatever
   its version, and the package keeps its best property: no
   dependencies at all, not even a type-only one.
   ─────────────────────────────────────────────────────────── */
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
export function resolveChatConfig(config) {
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
/** Traffic-light presence colours. Deliberately literal rather than design
 *  tokens: these read as universal signals and must look the same in all four
 *  apps, only two of which share a token set. */
export const CHAT_STATUS_META = {
    online: { label: 'Online', dot: '#22c55e' },
    idle: { label: 'Idle', dot: '#f59e0b' },
    away: { label: 'Away', dot: '#9ca3af' },
    busy: { label: 'Busy', dot: '#ef4444' },
};
//# sourceMappingURL=types.js.map