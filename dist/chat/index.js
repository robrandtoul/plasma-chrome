/* ─────────────────────────────────────────────────────────────
   @plasma/chrome/chat — public surface.

   The shared staff chat: one implementation for all four apps,
   replacing the two hand-maintained copies that had drifted apart.

   Import the stylesheet once per app, alongside the chrome's:

     import '@plasma/chrome/chrome.css';
     import '@plasma/chrome/chat.css';

   As with the chrome, it is NOT imported from this module, so the
   package stays consumable from plain JS and from any host whose
   bundler will not process a CSS import inside a dependency.

   ── Mounting it ──────────────────────────────────────────────

     // once, near the root, above anything that renders chat
     <TeamChatProvider config={{ client: supabase, userId, isAdmin }}>
       {routes}
       <ChatPopoutHost />
     </TeamChatProvider>

     // in the header, through the chrome's own chat slot
     <Chrome chat={<ChatMenu />} chatUnread={unread} … />

   `useTeamChat()` is safe to call outside the provider: it returns
   an inert value so a signed-out route or a preview harness renders
   nothing rather than throwing.
   ─────────────────────────────────────────────────────────── */
export { TeamChatProvider, useTeamChat } from './store.js';
export { default as TeamChatPanel } from './TeamChatPanel.js';
export { default as ChatMenu } from './ChatMenu.js';
export { default as ChatPopoutHost } from './ChatPopoutHost.js';
/* The popout's own helpers. A host needs `isPopoutWindow` to decide whether
   its chat route should render the bare popout shell rather than the full
   page, and `reopenKey` to ask the dropdown to reopen after that page
   minimises back into it. */
export { isPopoutWindow, isPopoutSearch, popoutPath, popoutWindowName, 
// The pure rules underneath the popout, plus the constants they are written
// against. Exported so a host can unit-test them: the package has no test
// runner of its own, and these three decide whether the feature behaves —
// read "am I the popout" wrong and the popped-out window mutes itself while
// the main one chimes, which is exactly backwards.
clampPopoutSize, popoutIsAlive, windowFeatures, DEFAULT_POPOUT_SIZE, MIN_POPOUT_W, MIN_POPOUT_H, POPOUT_ALIVE_MS, POPOUT_HEARTBEAT_MS, } from './popout.js';
export { reopenKey } from './ChatMenu.js';
/* Pure helpers, exported because a host may want to render a message the same
   way the panel does (a notification, a search result, an activity feed). */
export { attachmentsOf, authorBadgeColour, buildMessageSegments, dayKey, dayLabel, designerTint, formatBytes, isGroupedWithPrevious, messageTime, splitLinkifiedText, } from './message.js';
export { DESIGNER_COLOURS, designerColourCss, designerColourLabel, isDesignerColour, } from './colours.js';
export { CHAT_BUCKET, CHAT_CHANNEL, CHAT_DOCK_ID, CHAT_SCHEMA, CHAT_STATUS_META, resolveChatConfig, } from './types.js';
//# sourceMappingURL=index.js.map