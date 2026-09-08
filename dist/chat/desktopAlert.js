// The operating system's own notification, for a message that arrives while
// the app is not the window you are looking at.
//
// This is the signal the chat never had. A DM already fired a web push, but a
// push is a round trip through Apple or Google and it is the one part of the
// stack that can fail without saying so. A notification raised by the page
// itself needs no server, no subscription and no service worker: if the tab is
// open, it works.
//
// Two things stop it becoming noise:
//
//   * It is only ever raised for something personal, a DM or an @mention, and
//     only when that something actually counted as unread. Room chatter gets
//     the tab badge and the chime, which is proportionate.
//   * The tag matches the one `send-push` sets, `chat:<message id>`. Where
//     both arrive, the operating system treats them as the same notification
//     and replaces rather than stacks, so nobody is told twice about one
//     message.
//
// It is deliberately silent. The panel plays its own chime for the same
// message, and letting the notification sound as well means two noises for one
// event, from two different places, a fraction of a second apart.
export const CHAT_ALERT_LEVELS = [
    { value: 'preview', label: 'Sender and message', hint: 'Shows a preview of what was said' },
    { value: 'sender', label: 'Sender only', hint: 'Safer when sharing your screen' },
    { value: 'off', label: 'Off', hint: 'Tab badge and sound only' },
];
export const DEFAULT_ALERT_LEVEL = 'preview';
export function isAlertLevel(v) {
    return v === 'off' || v === 'sender' || v === 'preview';
}
export function alertsSupported() {
    return typeof window !== 'undefined' && 'Notification' in window;
}
export function alertPermission() {
    if (!alertsSupported())
        return 'unsupported';
    return Notification.permission;
}
/**
 * Ask for permission. Must be called from a click: Safari requires a user
 * gesture, and a request fired on load is auto-suppressed by Chrome and burns
 * the one chance to ask.
 */
export async function requestAlertPermission() {
    if (!alertsSupported())
        return 'unsupported';
    if (Notification.permission !== 'default')
        return Notification.permission;
    try {
        return await Notification.requestPermission();
    }
    catch {
        return Notification.permission;
    }
}
/** Notifications the page raised itself, so they can be dismissed together
 *  when the person comes back rather than left piling up on the desktop. */
const live = new Set();
// Some desktops leave a notification on screen until it is dismissed by hand.
// Long enough to be read on the way past, short enough not to accumulate.
const AUTO_CLOSE_MS = 12000;
export function showChatAlert(alert) {
    if (alert.level === 'off')
        return;
    if (alertPermission() !== 'granted')
        return;
    const title = alert.mention
        ? `${alert.sender} mentioned you`
        : `${alert.sender} sent you a message`;
    // At 'sender' the body deliberately says nothing about the content, not even
    // its length: the whole point is that someone reading over your shoulder
    // learns only that a message exists.
    const body = alert.level === 'preview' ? alert.snippet : 'Open the chat to read it';
    try {
        const n = new Notification(title, {
            body,
            tag: `chat:${alert.id}`,
            silent: true,
            // Matches the icon the service worker uses for the push, so the two
            // really do look like one notification rather than two.
            icon: '/apple-touch-icon.png',
            badge: '/apple-touch-icon.png',
        });
        live.add(n);
        n.onclick = () => {
            try {
                window.focus();
                alert.onClick();
            }
            finally {
                n.close();
            }
        };
        n.onclose = () => live.delete(n);
        window.setTimeout(() => {
            n.close();
            live.delete(n);
        }, AUTO_CLOSE_MS);
    }
    catch {
        // Constructing a Notification throws on Android Chrome, which insists on
        // the service worker's showNotification instead. Push already covers that
        // case, so there is nothing to fall back to and nothing to report.
    }
}
/** Clear anything still on screen. Called when the person comes back to the
 *  app: they are here now, so a stack of notices about it is just litter. */
export function dismissChatAlerts() {
    live.forEach((n) => {
        try {
            n.close();
        }
        catch {
            /* already gone */
        }
    });
    live.clear();
}
//# sourceMappingURL=desktopAlert.js.map