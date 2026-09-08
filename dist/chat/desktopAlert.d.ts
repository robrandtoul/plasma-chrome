/** How much a notification is allowed to say. Stored per person and shared
 *  across the four apps, so the choice is made once. */
export type ChatAlertLevel = 'off' | 'sender' | 'preview';
export declare const CHAT_ALERT_LEVELS: {
    value: ChatAlertLevel;
    label: string;
    hint: string;
}[];
export declare const DEFAULT_ALERT_LEVEL: ChatAlertLevel;
export declare function isAlertLevel(v: unknown): v is ChatAlertLevel;
export declare function alertsSupported(): boolean;
export declare function alertPermission(): NotificationPermission | 'unsupported';
/**
 * Ask for permission. Must be called from a click: Safari requires a user
 * gesture, and a request fired on load is auto-suppressed by Chrome and burns
 * the one chance to ask.
 */
export declare function requestAlertPermission(): Promise<NotificationPermission | 'unsupported'>;
export interface ChatAlert {
    /** The message id. Becomes the tag, which is what makes this and the web
     *  push about the same message coalesce instead of stacking. */
    id: string;
    /** Who sent it. */
    sender: string;
    /** What they said, already trimmed to something notification-sized. */
    snippet: string;
    /** True for an @mention, so the wording can say which kind this is. */
    mention: boolean;
    level: ChatAlertLevel;
    /** Bring the app forward, and open the right conversation. */
    onClick: () => void;
}
export declare function showChatAlert(alert: ChatAlert): void;
/** Clear anything still on screen. Called when the person comes back to the
 *  app: they are here now, so a stack of notices about it is just litter. */
export declare function dismissChatAlerts(): void;
//# sourceMappingURL=desktopAlert.d.ts.map