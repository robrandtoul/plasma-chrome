/**
 * Show `count` unread, flagging whether any of it is personal (a DM or an
 * @mention). Safe to call on every render: it returns immediately when
 * nothing has changed.
 */
export declare function setChatBadge(count: number, personal: boolean): void;
/**
 * Put everything back as the host had it. Called when the chat provider
 * unmounts, so an app that tears the chat down does not leave a permanent
 * count in its own tab title.
 */
export declare function clearChatBadge(): void;
//# sourceMappingURL=badge.d.ts.map