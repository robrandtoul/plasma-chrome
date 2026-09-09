// The message that glides out from under the header pill when chat is shut.
//
// This fills the one case the rest of the notification work deliberately left
// open. The desktop notification only fires when the app is NOT the window in
// front of you, so a message arriving while you are working here got a badge, a
// chime and a three-beat pulse, and nothing that said who it was from or what
// they wanted. The two are complements and never both fire: the toast for when
// you are elsewhere, this for when you are here.
//
// Everything below is pure. The timing and the merge rules are the whole
// design, so they live where they can be read and tested rather than being
// scattered through a component as magic numbers.
// A personal message holds long enough to be read and thought about; room
// chatter holds long enough to be noticed and let go. The gap is deliberate
// and is meant to be FELT, which is why the two cards also look different:
// a difference in dwell alone would read as a glitch, but a difference in
// dwell that tracks a difference in colour reads as "mine stay longer".
export const PEEK_DWELL_PERSONAL_MS = 8000;
export const PEEK_DWELL_ROOM_MS = 3500;
export function peekDwell(peek) {
    return peek.personal ? PEEK_DWELL_PERSONAL_MS : PEEK_DWELL_ROOM_MS;
}
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
export function mergePeek(current, incoming) {
    if (!current)
        return incoming;
    return {
        ...incoming,
        personal: current.personal || incoming.personal,
        more: current.more + 1,
    };
}
/**
 * What the card is allowed to say.
 *
 * Follows the same preference as the desktop notification, because a card in
 * your own window is if anything MORE likely to be read over your shoulder
 * than a corner toast — you are sitting in front of it. 'off' there means "no
 * desktop notification", not "no privacy", so it resolves to the cautious
 * reading rather than to the full preview.
 */
export function peekBody(level, snippet) {
    return level === 'preview' ? snippet : null;
}
/** "Chris Jackson" / "Chris Jackson and 2 more". Kept out of the component so
 *  the plural is decided once. */
export function peekTitle(peek) {
    if (peek.more <= 0)
        return peek.sender;
    return `${peek.sender} and ${peek.more} more`;
}
//# sourceMappingURL=peek.js.map