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

export { TeamChatProvider, useTeamChat } from './store';
export { default as TeamChatPanel } from './TeamChatPanel';
export { default as ChatMenu, type ChatMenuProps } from './ChatMenu';
export { default as ChatPopoutHost } from './ChatPopoutHost';

/* The popout's own helpers. A host needs `isPopoutWindow` to decide whether
   its chat route should render the bare popout shell rather than the full
   page, and `reopenKey` to ask the dropdown to reopen after that page
   minimises back into it. */
export { isPopoutWindow, isPopoutSearch, popoutPath, popoutWindowName } from './popout';
export { reopenKey } from './ChatMenu';

/* Pure helpers, exported because a host may want to render a message the same
   way the panel does (a notification, a search result, an activity feed). */
export {
  attachmentsOf,
  authorBadgeColour,
  buildMessageSegments,
  dayKey,
  dayLabel,
  designerTint,
  formatBytes,
  isGroupedWithPrevious,
  messageTime,
  splitLinkifiedText,
  type MessageSegment,
} from './message';

export {
  DESIGNER_COLOURS,
  designerColourCss,
  designerColourLabel,
  isDesignerColour,
  type DesignerColour,
} from './colours';

export {
  CHAT_BUCKET,
  CHAT_CHANNEL,
  CHAT_DOCK_ID,
  CHAT_SCHEMA,
  CHAT_STATUS_META,
  resolveChatConfig,
  type ChatAttachment,
  type ChatConfig,
  type ChatLinkComponent,
  type ChatPlacement,
  type ChatPrefs,
  type ChatStatus,
  type ChatThread,
  type PresenceMember,
  type ReactionRow,
  type ResolvedChatConfig,
  type TeamMember,
  type TeamMessage,
} from './types';
