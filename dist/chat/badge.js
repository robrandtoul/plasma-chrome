// Unread, said in the three places you can see without the app in front of you:
// the browser tab's title, its favicon, and the installed app's icon.
//
// Why this exists at all: the chat had a badge on its own header pill and
// nothing else. That badge is only visible on a tab you are already looking
// at, which is the one case where you did not need telling. With the tab in
// the background, or the app minimised, an arriving message produced a short
// quiet chime and no lasting trace of any kind, so anything missed in the
// moment was missed for good. Every mainstream chat client answers this the
// same way, and so now do we.
//
// All three are best-effort and independently guarded. A host with no favicon,
// a browser with no Badging API, a canvas that will not taint-free draw: each
// simply does nothing, and the other two still work.
const TITLE_PREFIX = /^\(\d+\+?\)\s+/;
let applied = { count: 0, personal: false };
/* ------------------------------------------------------------------ title */
// The title we last wrote, so the observer below can tell our own write from
// the host's. Without this, re-applying the prefix on every mutation is an
// endless loop.
let ourTitle = null;
// The host's title with any prefix of ours stripped off. This is the string we
// restore to, and the one we re-prefix when the count changes.
let baseTitle = null;
let titleObserver = null;
function writeTitle(next) {
    ourTitle = next;
    document.title = next;
}
function decorate(base, { count, personal }) {
    if (count <= 0)
        return base;
    // A DM or an @mention is worth distinguishing from room chatter even here,
    // where there is no room for colour: the bullet reads as "one of these is
    // for you" at tab width, which is often four or five characters.
    const n = count > 9 ? '9+' : String(count);
    return personal ? `(${n})• ${base}` : `(${n}) ${base}`;
}
/**
 * Keep the count in the title even as the host rewrites it.
 *
 * The hosts set their own titles per page, and proof-viewer restores the
 * previous one when a page unmounts. Left alone, that would either wipe the
 * count on the next navigation or, worse, capture a prefixed title as the
 * "previous" one and restore it later with a stale number frozen into it.
 * So we watch the element, treat any title we did not write as the new base,
 * and re-apply on top.
 */
function ensureTitleObserver() {
    if (titleObserver || typeof MutationObserver === 'undefined')
        return;
    const el = document.querySelector('title');
    if (!el)
        return;
    titleObserver = new MutationObserver(() => {
        if (document.title === ourTitle)
            return; // our own write, echoed back
        baseTitle = document.title.replace(TITLE_PREFIX, '');
        if (applied.count > 0)
            writeTitle(decorate(baseTitle, applied));
    });
    titleObserver.observe(el, { childList: true });
}
function applyTitle(state) {
    if (typeof document === 'undefined')
        return;
    if (baseTitle === null)
        baseTitle = document.title.replace(TITLE_PREFIX, '');
    ensureTitleObserver();
    writeTitle(decorate(baseTitle, state));
}
/* ---------------------------------------------------------------- favicon */
// The href the host shipped, kept so a cleared badge can put it back exactly.
let faviconOriginal = null;
let faviconImage = null;
let faviconLoadFailed = false;
function faviconLink() {
    // Deliberately not `link[rel~="icon"]`, which also matches apple-touch-icon:
    // that one is the Home Screen icon and has no business being redrawn here.
    const links = Array.from(document.querySelectorAll('link[rel~="icon"]')).filter((l) => !l.rel.includes('apple-touch-icon'));
    return links[0] ?? null;
}
function loadFavicon(href) {
    return new Promise((resolve) => {
        const img = new Image();
        // Same-origin in every host we ship to, but a cross-origin favicon would
        // taint the canvas and make toDataURL throw, so ask for CORS and accept a
        // failure as "no favicon badge".
        img.crossOrigin = 'anonymous';
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = href;
    });
}
async function applyFavicon(state) {
    if (typeof document === 'undefined' || faviconLoadFailed)
        return;
    const link = faviconLink();
    if (!link)
        return;
    if (faviconOriginal === null)
        faviconOriginal = link.getAttribute('href');
    if (!faviconOriginal)
        return;
    if (state.count <= 0) {
        if (link.getAttribute('href') !== faviconOriginal)
            setFaviconHref(faviconOriginal);
        return;
    }
    if (!faviconImage) {
        faviconImage = await loadFavicon(faviconOriginal);
        if (!faviconImage) {
            // An SVG with no intrinsic size, a 404, a cross-origin icon. Give up on
            // this one signal for the session rather than retrying on every message.
            faviconLoadFailed = true;
            return;
        }
    }
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx)
        return;
    try {
        ctx.drawImage(faviconImage, 0, 0, size, size);
        // A filled disc in the corner, ringed in the page's own background so it
        // reads as sitting on top of the icon rather than being part of it. No
        // digits: at 16 physical pixels a number is a smudge, and "something is
        // waiting" is the whole message a favicon can carry.
        const r = size * 0.28;
        const cx = size - r - 2;
        const cy = r + 2;
        ctx.beginPath();
        ctx.arc(cx, cy, r + 3, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fillStyle = state.personal ? '#e0533d' : '#3b82f6';
        ctx.fill();
        setFaviconHref(canvas.toDataURL('image/png'));
    }
    catch {
        faviconLoadFailed = true;
    }
}
function setFaviconHref(href) {
    const link = faviconLink();
    if (!link)
        return;
    // Replacing the element rather than just the attribute: some browsers hang
    // on to the old icon when only the href changes.
    const next = link.cloneNode(true);
    next.setAttribute('href', href);
    // A data: URL is a PNG whatever the original declared, and leaving
    // type="image/svg+xml" on it stops Firefox drawing it.
    if (href.startsWith('data:image/png'))
        next.setAttribute('type', 'image/png');
    else if (faviconOriginal === href)
        next.removeAttribute('type');
    link.replaceWith(next);
}
/* -------------------------------------------------------------- app badge */
function applyAppBadge(state) {
    const nav = navigator;
    try {
        if (state.count > 0)
            void nav.setAppBadge?.(state.count)?.catch(() => { });
        else
            void nav.clearAppBadge?.()?.catch(() => { });
    }
    catch {
        /* not supported, or not an installed app */
    }
}
/* ------------------------------------------------------------------- api  */
/**
 * Show `count` unread, flagging whether any of it is personal (a DM or an
 * @mention). Safe to call on every render: it returns immediately when
 * nothing has changed.
 */
export function setChatBadge(count, personal) {
    if (typeof document === 'undefined')
        return;
    const next = { count: Math.max(0, count), personal };
    if (next.count === applied.count && next.personal === applied.personal)
        return;
    applied = next;
    applyTitle(next);
    void applyFavicon(next);
    applyAppBadge(next);
}
/**
 * Put everything back as the host had it. Called when the chat provider
 * unmounts, so an app that tears the chat down does not leave a permanent
 * count in its own tab title.
 */
export function clearChatBadge() {
    if (typeof document === 'undefined')
        return;
    applied = { count: 0, personal: false };
    applyAppBadge(applied);
    void applyFavicon(applied);
    if (baseTitle !== null)
        writeTitle(baseTitle);
    titleObserver?.disconnect();
    titleObserver = null;
    ourTitle = null;
    baseTitle = null;
}
//# sourceMappingURL=badge.js.map