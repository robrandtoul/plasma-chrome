import type { ChatThread } from './types.js';
import type { ChatAlertLevel } from './desktopAlert.js';
/** One card. It may stand in for several messages: see `mergePeek`. */
export interface ChatPeek {
    /** The newest message in the burst. Also the animation key, so each new
     *  message restarts the entrance and the dwell rather than inheriting the
     *  tail of the last one's. */
    id: string;
    /** Where clicking it should land. The newest message's thread. */
    thread: ChatThread;
    sender: string;
    snippet: string;
    /** True when anything in this burst was a DM or an @mention. Sticky: see
     *  `mergePeek`. */
    personal: boolean;
    /** How many earlier messages this card replaced. 0 for a lone message. */
    more: number;
}
export declare const PEEK_DWELL_PERSONAL_MS = 8000;
export declare const PEEK_DWELL_ROOM_MS = 3500;
export declare function peekDwell(peek: ChatPeek): number;
/**
 * Fold a new message into whatever card is already showing.
 *
 * A burst replaces rather than stacks. Four cards sliding down under the
 * header is how a helpful thing becomes the thing everyone turns off, and the
 * unread badge is already the complete count, so the card's job is "here is
 * the latest, and there are others" rather than a transcript.
 *
 * ⚠ `personal` is STICKY across the burst, and that is the load-bearing rule.
 * The card describes the newest message, so a room message arriving behind a
 * DM takes over the name and the text — but the DM is still sitting unread
 * underneath it. Letting the room message drag the card back to the short
 * dwell and the quiet colour would cut short the very message that earned the
 * long one. Once a burst contains something for you, the card is for you.
 */
export declare function mergePeek(current: ChatPeek | null, incoming: ChatPeek): ChatPeek;
/**
 * What the card is allowed to say.
 *
 * Follows the same preference as the desktop notification, because a card in
 * your own window is if anything MORE likely to be read over your shoulder
 * than a corner toast — you are sitting in front of it. 'off' there means "no
 * desktop notification", not "no privacy", so it resolves to the cautious
 * reading rather than to the full preview.
 */
export declare function peekBody(level: ChatAlertLevel, snippet: string): string | null;
/** "Chris Jackson" / "Chris Jackson and 2 more". Kept out of the component so
 *  the plural is decided once. */
export declare function peekTitle(peek: ChatPeek): string;
//# sourceMappingURL=peek.d.ts.map