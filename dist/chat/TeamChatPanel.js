import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useMemo, useRef, useState, } from 'react';
import { ArrowUp, AtSign, Bell, Check, ChevronLeft, Clock, Copy, Download, FileIcon, FileText, MoreHorizontal, Paperclip, SearchIcon, Smile, Sparkle, Trash2, Users, Volume2, X, } from './icons.js';
import { useImageFileDrop } from './useFileDrop.js';
import { playChatSound } from './sound.js';
import { CHAT_ALERT_LEVELS, alertPermission, requestAlertPermission, } from './desktopAlert.js';
import { useTeamChat } from './store.js';
import { earliestSendAt, fromLocalInputValue, scheduleProblem, schedulePresets, scheduledForThread, sendAtLabel, toLocalInputValue, } from './later.js';
import { attachmentsOf, authorBadgeColour, buildMessageSegments, dayKey, dayLabel, formatBytes, isGroupedWithPrevious, messageTime, } from './message.js';
import { CHAT_BUCKET, CHAT_STATUS_META, } from './types.js';
const EMOJI_CHOICES = ['👍', '❤️', '😂', '🎉', '👀', '✅', '🙏'];
const MAX_ATTACHMENTS = 6;
const MAX_MB = 25;
const MAX_BYTES = MAX_MB * 1024 * 1024; // matches the 000323 bucket cap
// Below this width the full page draws its conversations as chips above the
// thread, as the dropdown does; above it they are a list beside the thread.
const PAGE_WIDE_PX = 760;
// Below this the page is a phone: the list and the thread take turns.
const PAGE_PHONE_PX = 640;
// What an empty thread with the assistant offers as a start. Examples in
// code, not a history: the point is to show the kind of question it answers.
const BOT_SUGGESTIONS = [
    'Where has the latest order for a customer got to?',
    'Has this customer ordered before?',
    'What does 500 gold cards cost?',
    'How do I park a sale?',
];
function isImageType(type) {
    return (type ?? '').startsWith('image/');
}
// Extension for the storage key: prefer the real filename's, fall back to a
// sensible image extension from the mime. Cosmetic — the download filename
// comes from the stored `name`, not the key.
function extForFile(name, type) {
    const fromName = (name.split('.').pop() ?? '').toLowerCase();
    if (fromName && fromName !== name.toLowerCase() && /^[a-z0-9]{1,8}$/.test(fromName))
        return fromName;
    if (type === 'image/jpeg')
        return 'jpg';
    if (type === 'image/webp')
        return 'webp';
    if (type === 'image/gif')
        return 'gif';
    if (type === 'image/png')
        return 'png';
    return '';
}
// A short kind label ("PDF", "AI", "TTF") for a non-image chip.
function kindLabel(name, type) {
    const ext = (name.split('.').pop() ?? '').toLowerCase();
    if (ext && ext !== name.toLowerCase() && ext.length <= 5)
        return ext.toUpperCase();
    return (type.split('/').pop() ?? '').toUpperCase();
}
function fileKindIcon(name, type) {
    const ext = (name.split('.').pop() ?? '').toLowerCase();
    if (type === 'application/pdf' || ext === 'pdf')
        return FileText;
    return FileIcon;
}
// Group a message's reaction rows by emoji, tracking count / whether I reacted /
// who reacted (for the tooltip).
function groupReactions(rows, userId) {
    const map = new Map();
    for (const r of rows) {
        const g = map.get(r.emoji) ?? { emoji: r.emoji, count: 0, mine: false, names: [] };
        g.count += 1;
        if (r.user_id === userId)
            g.mine = true;
        if (r.user_name)
            g.names.push(r.user_name);
        map.set(r.emoji, g);
    }
    return [...map.values()];
}
function firstName(name) {
    const n = (name ?? '').trim();
    return n ? n.split(/\s+/)[0] : 'Teammate';
}
function statusDotClass(status) {
    return `pd-chat__dot pd-chat__dot--${status ?? 'offline'}`;
}
// A conversation row's time: the clock today, the weekday this week, else
// the date. Short, because it sits at the end of a 64px row.
function rowTime(iso) {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime()))
        return '';
    const now = new Date();
    const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diffDays = Math.round((startOf(now) - startOf(d)) / 86400000);
    if (diffDays === 0)
        return messageTime(iso);
    if (diffDays === 1)
        return 'Yest';
    if (diffDays < 7)
        return d.toLocaleDateString('en-GB', { weekday: 'short' });
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
// Binds outside-click and Escape to the document the element is actually in,
// not the app's: popped out into a picture-in-picture window the panel lives
// in a second document, where a listener on the main one never sees either.
function useCloseOnOutside(open, ref, close) {
    useEffect(() => {
        if (!open)
            return;
        const doc = ref.current?.ownerDocument ?? document;
        function onDoc(e) {
            if (ref.current && !ref.current.contains(e.target))
                close();
        }
        // Escape closes the innermost thing. Heard in the capture phase and
        // stopped there, so the dropdown's own Escape (which closes the whole
        // panel) does not fire for the same press.
        function onKey(e) {
            if (e.key !== 'Escape')
                return;
            e.stopPropagation();
            close();
        }
        doc.addEventListener('mousedown', onDoc);
        doc.addEventListener('keydown', onKey, true);
        return () => {
            doc.removeEventListener('mousedown', onDoc);
            doc.removeEventListener('keydown', onKey, true);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);
}
// ── Small parts ────────────────────────────────────────────────────────────
// The team chat assistant's tag ("AI") and avatar. Claude is not a person:
// it never holds a presence, so instead of a status dot (which would read as
// "offline") it carries a tag, and instead of initials a spark.
// ⚠ Both class names are read by proof-viewer's e2e specs; keep them.
export function BotTag() {
    return (_jsx("span", { className: "pd-chat__bot-tag", title: "The team chat assistant. It looks things up; it cannot change anything.", children: "AI" }));
}
function BotAvatar({ size }) {
    const px = { xs: 18, sm: 22, md: 28, lg: 32, xl: 44 }[size];
    const glyph = { xs: 10, sm: 12, md: 14, lg: 16, xl: 20 }[size];
    return (_jsx("span", { className: "pd-chat__bot-avatar", style: { width: px, height: px }, "aria-hidden": "true", children: _jsx(Sparkle, { size: glyph }) }));
}
// A person's avatar: their photo, or their initials on their identity
// colour, with an optional presence dot.
function PersonAvatar({ size, initials, colour, avatarUrl, status, }) {
    return (_jsxs("span", { className: `pd-chat__av pd-chat__av--${size}`, style: avatarUrl ? undefined : { backgroundColor: authorBadgeColour(colour ?? null) }, "aria-hidden": "true", children: [avatarUrl ? _jsx("img", { src: avatarUrl, alt: "" }) : (initials ?? '?').slice(0, 2), status !== undefined && _jsx("span", { className: statusDotClass(status) })] }));
}
function TeamAvatar({ size }) {
    const glyph = { xs: 10, sm: 12, md: 14, lg: 16, xl: 18 }[size];
    return (_jsx("span", { className: `pd-chat__av pd-chat__av--${size} pd-chat__av--team`, "aria-hidden": "true", children: _jsx(Users, { size: glyph }) }));
}
// One avatar for any thread party: the room, a person, or the assistant.
function ThreadAvatar({ thread, member, status, size, }) {
    if (thread === 'team')
        return _jsx(TeamAvatar, { size: size });
    if (member?.isBot)
        return _jsx(BotAvatar, { size: size });
    return (_jsx(PersonAvatar, { size: size, initials: member?.initials, colour: member?.colour, avatarUrl: member?.avatarUrl, status: status }));
}
function UnreadCount({ count, room }) {
    if (count <= 0)
        return null;
    return (_jsx("span", { className: ['pd-chat__count', room ? 'pd-chat__count--room' : ''].filter(Boolean).join(' '), "aria-label": `${count} unread`, children: count > 9 ? '9+' : count }));
}
// Renders a message's attachments: images preview as thumbnails (private
// bucket → signed URLs, full-screen on click); any other file shows a
// downloadable chip carrying its original name / kind / size (000323).
function ChatAttachments({ files }) {
    // This is its own component rather than part of the panel, so it reads the
    // client from the store the same way the panel does. The bucket is private,
    // so every image needs a signed URL before it can be rendered at all.
    const { config } = useTeamChat();
    const [urls, setUrls] = useState([]);
    const [lightbox, setLightbox] = useState(null);
    const key = files.map((f) => f.path).join(',');
    useEffect(() => {
        if (!config)
            return;
        let cancelled = false;
        void (async () => {
            const { data } = await config.client.storage
                .from(CHAT_BUCKET)
                .createSignedUrls(files.map((f) => f.path), 3600);
            if (cancelled)
                return;
            setUrls((data ?? []).map((d) => d.signedUrl ?? ''));
        })();
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, config]);
    if (urls.length === 0)
        return null;
    return (_jsxs(_Fragment, { children: [_jsx("div", { className: "pd-chat__files", children: files.map((f, i) => {
                    const url = urls[i];
                    if (!url)
                        return null;
                    if (isImageType(f.type)) {
                        return (_jsxs("button", { type: "button", onClick: () => setLightbox(url), className: "pdc-text-left", children: [_jsx("span", { className: "pd-chat__thumb", children: _jsx("img", { src: url, alt: f.name || 'Attachment', loading: "lazy" }) }), f.name && _jsx("span", { className: "pd-chat__thumb-caption", children: f.name })] }, i));
                    }
                    // Force a download with the real filename via the signed URL's
                    // ?download param (the stored key is a random uuid).
                    const href = `${url}${url.includes('?') ? '&' : '?'}download=${encodeURIComponent(f.name || 'file')}`;
                    const meta = [kindLabel(f.name, f.type), formatBytes(f.size)].filter(Boolean).join(' · ');
                    return (_jsxs("a", { href: href, target: "_blank", rel: "noopener noreferrer", title: `Download ${f.name}`, className: "pd-chat__file", children: [_jsx("span", { className: "pd-chat__file-kind", children: kindLabel(f.name, f.type).slice(0, 4) || 'FILE' }), _jsxs("span", { className: "pd-chat__file-text", children: [_jsx("span", { className: "pd-chat__file-name", children: f.name || 'File' }), meta && _jsx("span", { className: "pd-chat__file-meta", children: meta })] }), _jsx(Download, { size: 14, "aria-hidden": "true", className: "pdc-text-ink-dim" })] }, i));
                }) }), lightbox && (_jsxs("div", { className: "pd-chat__lightbox", onClick: () => setLightbox(null), role: "dialog", "aria-modal": "true", children: [_jsx("img", { src: lightbox, alt: "Attachment", onClick: (e) => e.stopPropagation() }), _jsx("button", { type: "button", onClick: () => setLightbox(null), "aria-label": "Close image", className: "pd-chat__lightbox-close", children: _jsx(X, { size: 20, "aria-hidden": "true" }) })] }))] }));
}
// The hover toolbar's "react" button + its emoji picker.
function ReactButton({ messageId, onOpenChange }) {
    const { toggleReaction } = useTeamChat();
    const [open, setOpen] = useState(false);
    const ref = useRef(null);
    useCloseOnOutside(open, ref, () => setOpen(false));
    useEffect(() => onOpenChange(open), [open, onOpenChange]);
    return (_jsxs("div", { ref: ref, className: "pdc-relative", children: [_jsx("button", { type: "button", onClick: () => setOpen((v) => !v), "aria-label": "Add reaction", title: "React", className: "pd-chat__tool", children: _jsx(Smile, { size: 14, "aria-hidden": "true" }) }), open && (_jsx("div", { className: "pd-chat__picker pd-chat__picker--right", children: EMOJI_CHOICES.map((e) => (_jsx("button", { type: "button", onClick: () => {
                        toggleReaction(messageId, e);
                        setOpen(false);
                    }, "aria-label": `React ${e}`, children: e }, e))) }))] }));
}
// One chip in the conversation row: the Team room, a teammate, or Claude.
// Carries that thread's unread count and (for people) a presence dot.
function ThreadChip({ thread, label, member, active, count, status, onClick, }) {
    return (_jsxs("button", { type: "button", onClick: onClick, "aria-pressed": active, className: "pd-chat__chip", children: [_jsx(ThreadAvatar, { thread: thread, member: member, status: status, size: "xs" }), label, _jsx(UnreadCount, { count: count, room: thread === 'team' })] }));
}
function typingLabel(users) {
    const names = users.map((u) => firstName(u.name));
    if (names.length === 1)
        return `${names[0]} is typing…`;
    if (names.length === 2)
        return `${names[0]} and ${names[1]} are typing…`;
    return 'Several people are typing…';
}
// Is the caret sitting in an "@query" the composer should autocomplete?
function detectMention(text, caret) {
    const before = text.slice(0, caret);
    const at = before.lastIndexOf('@');
    if (at < 0)
        return null;
    if (at > 0 && !/\s/.test(before[at - 1]))
        return null; // must start the token
    const query = before.slice(at + 1);
    if (/[\n@]/.test(query) || query.length > 40)
        return null;
    return { at, query };
}
// ── The ⋯ menu ─────────────────────────────────────────────────────────────
// Every setting and every "where does chat live" choice, in one place, in
// every placement. The placement items come from the host; the rest is the
// panel's own.
const SETTABLE = [
    { value: 'online', label: 'Online' },
    { value: 'away', label: 'Away' },
    { value: 'busy', label: 'Busy' },
];
function PanelMenu({ items, linkComponent: As, }) {
    const { myStatus, setManualStatus, soundEnabled, setSoundEnabled, alertLevel, setAlertLevel, peekEnabled, setPeekEnabled, } = useTeamChat();
    const [open, setOpen] = useState(false);
    const [permission, setPermission] = useState(() => alertPermission());
    const ref = useRef(null);
    useCloseOnOutside(open, ref, () => setOpen(false));
    const alertsSupported = permission !== 'unsupported';
    const blocked = permission === 'denied';
    // Nothing appears unless the browser has been asked and said yes, so the
    // value reports what is really happening rather than what has been chosen.
    const alertValue = !alertsSupported
        ? null
        : blocked
            ? 'blocked'
            : alertLevel === 'off' || permission !== 'granted'
                ? 'off'
                : alertLevel;
    async function choose(level) {
        if (level !== 'off' && permission !== 'granted') {
            // This is a click, which is the only context Safari will accept a
            // permission request from, and asking on load burns the single chance.
            const result = await requestAlertPermission();
            setPermission(result);
            if (result !== 'granted')
                return; // leave the old level; nothing would show
        }
        setAlertLevel(level);
        setOpen(false);
    }
    return (_jsxs("div", { ref: ref, className: "pdc-relative", children: [_jsx("button", { type: "button", onClick: () => setOpen((v) => !v), "aria-haspopup": "menu", "aria-expanded": open, "aria-label": "More options", title: "More", className: "pd-chat__ib", children: _jsx(MoreHorizontal, { size: 16, "aria-hidden": "true" }) }), open && (_jsxs("div", { role: "menu", className: "pd-chat__menu", children: [items.map((it) => {
                        if (it.to) {
                            const props = {
                                role: 'menuitem',
                                className: 'pd-chat__menu-item',
                                onClick: () => {
                                    setOpen(false);
                                    it.onSelect?.();
                                },
                            };
                            return As ? (_jsxs(As, { to: it.to, ...props, children: [it.icon, it.label] }, it.key)) : (_jsxs("a", { href: it.to, ...props, children: [it.icon, it.label] }, it.key));
                        }
                        if (it.checked !== undefined) {
                            return (_jsxs("button", { type: "button", role: "menuitemcheckbox", "aria-checked": it.checked, onClick: () => {
                                    it.onSelect?.();
                                    setOpen(false);
                                }, className: "pd-chat__menu-item", children: [it.icon, it.label, _jsx("span", { className: ['pd-chat__menu-value', it.checked ? 'pd-chat__menu-value--on' : ''].join(' '), children: it.checked ? 'on' : 'off' })] }, it.key));
                        }
                        return (_jsxs("button", { type: "button", role: "menuitem", onClick: () => {
                                setOpen(false);
                                it.onSelect?.();
                            }, className: "pd-chat__menu-item", children: [it.icon, it.label] }, it.key));
                    }), items.length > 0 && _jsx("div", { className: "pd-chat__menu-divider" }), _jsxs("button", { type: "button", role: "menuitemcheckbox", "aria-checked": soundEnabled, onClick: () => {
                            const next = !soundEnabled;
                            setSoundEnabled(next);
                            if (next)
                                playChatSound('general'); // confirm + unlock audio on enable
                        }, className: "pd-chat__menu-item", children: [_jsx(Volume2, { size: 15, "aria-hidden": "true" }), "Sounds", _jsx("span", { className: ['pd-chat__menu-value', soundEnabled ? 'pd-chat__menu-value--on' : ''].join(' '), children: soundEnabled ? 'on' : 'off' })] }), _jsxs("button", { type: "button", role: "menuitemcheckbox", "aria-checked": peekEnabled, onClick: () => setPeekEnabled(!peekEnabled), className: "pd-chat__menu-item", children: [_jsx(MoreHorizontal, { size: 15, "aria-hidden": "true", style: { visibility: 'hidden' } }), "Show a new message here", _jsx("span", { className: ['pd-chat__menu-value', peekEnabled ? 'pd-chat__menu-value--on' : ''].join(' '), children: peekEnabled ? 'on' : 'off' })] }), alertsSupported && (_jsxs(_Fragment, { children: [_jsx("div", { className: "pd-chat__menu-heading", children: "Desktop alerts" }), CHAT_ALERT_LEVELS.map((l) => (_jsxs("button", { type: "button", role: "menuitemradio", "aria-checked": alertLevel === l.value, disabled: blocked && l.value !== 'off', onClick: () => void choose(l.value), className: "pd-chat__menu-item", children: [_jsx(Bell, { size: 15, "aria-hidden": "true", style: { visibility: alertValue === l.value ? 'visible' : 'hidden' } }), l.label, alertLevel === l.value && _jsx(Check, { size: 14, "aria-hidden": "true", className: "pd-chat__menu-value pd-chat__menu-value--on" })] }, l.value))), blocked && (_jsx("p", { className: "pd-chat__menu-note", children: "Your browser is blocking notifications for this site. Turn them back on in its site settings." }))] })), _jsx("div", { className: "pd-chat__menu-divider" }), _jsx("div", { className: "pd-chat__menu-heading", children: "My status" }), SETTABLE.map((s) => (_jsxs("button", { type: "button", role: "menuitemradio", "aria-checked": myStatus === s.value, onClick: () => {
                            setManualStatus(s.value);
                            setOpen(false);
                        }, className: "pd-chat__menu-item", children: [_jsx("span", { className: `pd-chat__status-dot pd-chat__dot--${s.value}`, "aria-hidden": "true" }), s.label, myStatus === s.value && _jsx(Check, { size: 14, "aria-hidden": "true", className: "pd-chat__menu-value pd-chat__menu-value--on" })] }, s.value)))] }))] }));
}
// ── The panel ──────────────────────────────────────────────────────────────
// The shared chat body — thread header, conversation chips (or, on the full
// page, a list beside the thread), message list and composer — used by the
// header dropdown, the /chat page, the dashboard rail dock and the popout
// window. It reads everything from the TeamChatProvider, so every surface
// stays in sync (including which thread is open). The parent sizes it.
export default function TeamChatPanel({ variant, placementItems = [], headerAction, linkComponent, }) {
    const { config, db, messages, loading, presence, members, send, remove, scheduled, scheduledSupported, scheduleSend, cancelScheduled, sendScheduledNow, setViewing, typingUsers, notifyTyping, reactions, toggleReaction, activeThread, setActiveThread, threadUnread, loadEarlier, historyFor, } = useTeamChat();
    // Identity and capability come from the host through the store, not from an
    // auth module: each of the four apps has its own, with its own shape.
    const userId = config?.userId ?? null;
    const isAdmin = config?.isAdmin ?? false;
    const [draft, setDraft] = useState('');
    const [sending, setSending] = useState(false);
    const [error, setError] = useState(null);
    const [search, setSearch] = useState('');
    const [searchOpen, setSearchOpen] = useState(false);
    const [attachments, setAttachments] = useState([]);
    const fileRef = useRef(null);
    const rootRef = useRef(null);
    // Send later. `editing` is the waiting row whose words are in the composer
    // (Edit on the strip); `carried` its already-uploaded files, drawn beside
    // any newly staged ones and written onto whatever replaces the row. The row
    // itself stays in the waiting room until Save, Send or Schedule replaces
    // it, so abandoning the edit loses nothing.
    const [editing, setEditing] = useState(null);
    const [carried, setCarried] = useState([]);
    const [laterOpen, setLaterOpen] = useState(false);
    const [laterValue, setLaterValue] = useState('');
    const [laterProblem, setLaterProblem] = useState(null);
    const laterRef = useRef(null);
    useCloseOnOutside(laterOpen, laterRef, () => setLaterOpen(false));
    // The strip's rows re-label themselves ("Tomorrow at 09:00" becomes "Today
    // at 09:00" overnight, then "Sending now"), so the panel keeps a clock.
    const [clock, setClock] = useState(() => Date.now());
    useEffect(() => {
        if (scheduled.length === 0)
            return;
        const t = window.setInterval(() => setClock(Date.now()), 30000);
        return () => window.clearInterval(t);
    }, [scheduled.length]);
    // The page measures itself to pick its shape; the other variants are
    // always the one-column chips-over-thread layout.
    const [width, setWidth] = useState(0);
    useEffect(() => {
        const el = rootRef.current;
        if (!el || variant !== 'page' || typeof ResizeObserver === 'undefined')
            return;
        const ro = new ResizeObserver((entries) => {
            const w = entries[0]?.contentRect.width ?? 0;
            setWidth(w);
        });
        ro.observe(el);
        setWidth(el.getBoundingClientRect().width);
        return () => ro.disconnect();
    }, [variant]);
    const pageWide = variant === 'page' && width >= PAGE_WIDE_PX;
    const pagePhone = variant === 'page' && width > 0 && width < PAGE_PHONE_PX;
    // On a phone the list and the thread take turns. Opening the page lands on
    // the list; a row opens its thread; back returns.
    const [phoneThreadOpen, setPhoneThreadOpen] = useState(false);
    const showingList = pagePhone && !phoneThreadOpen;
    const reactionsByMessage = useMemo(() => {
        const map = new Map();
        for (const r of reactions) {
            const arr = map.get(r.message_id) ?? [];
            arr.push(r);
            map.set(r.message_id, arr);
        }
        return map;
    }, [reactions]);
    // Revoke object URLs on unmount.
    const attachmentsRef = useRef(attachments);
    attachmentsRef.current = attachments;
    useEffect(() => () => {
        for (const a of attachmentsRef.current)
            URL.revokeObjectURL(a.url);
    }, []);
    function addFiles(files) {
        if (files.length === 0)
            return;
        const sized = files.filter((f) => f.size <= MAX_BYTES);
        const room = Math.max(0, MAX_ATTACHMENTS - attachmentsRef.current.length);
        const additions = sized.slice(0, room).map((f) => ({
            id: crypto.randomUUID(),
            blob: f,
            url: URL.createObjectURL(f),
            name: f.name || 'file',
            type: f.type || '',
        }));
        let message = null;
        if (sized.length < files.length)
            message = `Each file must be ${MAX_MB} MB or smaller.`;
        if (sized.length > room)
            message = `You can attach up to ${MAX_ATTACHMENTS} files.`;
        if (message)
            setError(message);
        if (additions.length > 0)
            setAttachments((prev) => [...prev, ...additions]);
    }
    const { isZoneDragOver, zoneProps } = useImageFileDrop({ onFiles: addFiles });
    function handlePaste(e) {
        const items = Array.from(e.clipboardData?.items ?? []);
        const files = items
            .filter((it) => it.kind === 'file')
            .map((it) => it.getAsFile())
            .filter((f) => f != null);
        if (files.length > 0) {
            e.preventDefault();
            addFiles(files);
        }
    }
    function removeAttachment(id) {
        setAttachments((prev) => {
            const found = prev.find((a) => a.id === id);
            if (found)
                URL.revokeObjectURL(found.url);
            return prev.filter((a) => a.id !== id);
        });
    }
    const scrollRef = useRef(null);
    const textareaRef = useRef(null);
    // @mention autocomplete state.
    const [mentionQuery, setMentionQuery] = useState(null);
    const [mentionAnchor, setMentionAnchor] = useState(0);
    const [mentionCaret, setMentionCaret] = useState(0);
    const [mentionIndex, setMentionIndex] = useState(0);
    const mentionCandidates = useMemo(() => members.filter((m) => m.id !== userId), [members, userId]);
    const memberNames = useMemo(() => members.map((m) => m.name ?? '').filter(Boolean), [members]);
    // The DM peer when a private thread is open; null in the team room.
    const activePeer = useMemo(() => (activeThread === 'team' ? null : members.find((m) => m.id === activeThread) ?? null), [activeThread, members]);
    const bot = useMemo(() => members.find((m) => m.isBot) ?? null, [members]);
    // Author → profile lookup, so message avatars can use uploaded profile
    // pictures (avatar_url isn't denormalised on the message rows).
    const membersById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
    const presenceByUser = useMemo(() => new Map(presence.map((p) => [p.userId, p.status])), [presence]);
    const others = presence.filter((m) => m.userId !== userId);
    // Messages for the active thread: the shared room, or my DM pair with the
    // selected peer (both directions). RLS already scopes what arrives; this
    // just splits it into conversations.
    const threadMessages = useMemo(() => {
        if (activeThread === 'team')
            return messages.filter((m) => !m.recipient_id);
        return messages.filter((m) => (m.author_id === activeThread && m.recipient_id === userId) ||
            (m.author_id === userId && m.recipient_id === activeThread));
    }, [messages, activeThread, userId]);
    // The newest message in every thread, for the conversation list.
    const latestByThread = useMemo(() => {
        const map = new Map();
        for (const m of messages) {
            const thread = !m.recipient_id ? 'team' : m.author_id === userId ? m.recipient_id : m.author_id;
            const cur = map.get(thread);
            if (!cur || cur.created_at < m.created_at)
                map.set(thread, m);
        }
        return map;
    }, [messages, userId]);
    const searchQuery = search.trim().toLowerCase();
    // Full-history search: the instant local filter is merged with a debounced
    // server search over the thread's ENTIRE history (RLS scopes DM reads), so
    // matches older than the loaded window surface too.
    const [remoteResults, setRemoteResults] = useState([]);
    const [searchingRemote, setSearchingRemote] = useState(false);
    useEffect(() => {
        if (!searchQuery || !userId) {
            setRemoteResults([]);
            setSearchingRemote(false);
            return;
        }
        let cancelled = false;
        setSearchingRemote(true);
        const timer = setTimeout(() => {
            void (async () => {
                // Escape LIKE wildcards so "50%" searches literally.
                const pattern = '%' + searchQuery.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
                const base = () => {
                    let q = db.from('team_messages').select('*');
                    if (activeThread === 'team')
                        q = q.is('recipient_id', null);
                    else
                        q = q.or(`and(author_id.eq.${activeThread},recipient_id.eq.${userId}),and(author_id.eq.${userId},recipient_id.eq.${activeThread})`);
                    return q;
                };
                // Two single-filter queries (body, author) rather than one .or() so the
                // user's text never has to be escaped for the filter-list syntax.
                const [byBody, byAuthor] = await Promise.all([
                    base().ilike('body', pattern).order('created_at', { ascending: false }).limit(50),
                    base().ilike('author_name', pattern).order('created_at', { ascending: false }).limit(50),
                ]);
                if (cancelled)
                    return;
                const merged = [...(byBody.data ?? []), ...(byAuthor.data ?? [])];
                setRemoteResults(merged);
                setSearchingRemote(false);
            })();
        }, 350);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [searchQuery, activeThread, userId]);
    const shown = useMemo(() => {
        if (!searchQuery)
            return threadMessages;
        const local = threadMessages.filter((m) => m.body.toLowerCase().includes(searchQuery) ||
            (m.author_name ?? '').toLowerCase().includes(searchQuery));
        if (remoteResults.length === 0)
            return local;
        const byId = new Map();
        for (const m of [...remoteResults, ...local])
            byId.set(m.id, m);
        return [...byId.values()].sort((a, b) => a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0);
    }, [threadMessages, searchQuery, remoteResults]);
    const filtered = useMemo(() => {
        if (mentionQuery === null)
            return [];
        const q = mentionQuery.toLowerCase();
        return mentionCandidates.filter((m) => (m.name ?? '').toLowerCase().includes(q)).slice(0, 6);
    }, [mentionQuery, mentionCandidates]);
    // A mounted panel is a chat surface being looked at, with one exception:
    // the phone's conversation list, where the open thread is not on screen,
    // so its messages must not be stamped read.
    useEffect(() => {
        setViewing(!showingList);
        return () => setViewing(false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [showingList]);
    // ── The "New" rule ────────────────────────────────────────────────────
    // Marks where you left off: placed above the first unread message when a
    // thread opens, removed when you next send. The count is read from the
    // PREVIOUS render's snapshot, because by the time the thread has changed
    // the store has already stamped it read and zeroed the count.
    const unreadSnapshotRef = useRef(threadUnread);
    const [newMarkerId, setNewMarkerId] = useState(null);
    useEffect(() => {
        const n = unreadSnapshotRef.current[activeThread] ?? 0;
        if (n <= 0) {
            setNewMarkerId(null);
            return;
        }
        const fromOthers = threadMessages.filter((m) => m.author_id !== userId);
        const target = fromOthers[fromOthers.length - n];
        setNewMarkerId(target?.id ?? null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeThread]);
    useEffect(() => {
        unreadSnapshotRef.current = threadUnread;
    });
    // ── Scroll management ─────────────────────────────────────────────────
    // Three behaviours, matching what a chat should do:
    //   1. Each thread REMEMBERS where you left it — switch away and back and
    //      you're on the same message ('bottom' = you were pinned to latest).
    //   2. A thread you haven't left mid-read lands on the LATEST message, and
    //      stays pinned there as new messages arrive — but never yanks you
    //      down while you're reading history.
    //   3. "Show earlier" re-anchors so the visible messages stay put.
    // Late layout (an image or a wrapping file chip finishing after the first
    // scroll) used to strand the view mid-history — the rAF double-set and the
    // ResizeObserver below re-pin whenever content grows while pinned.
    const scrollPositionsRef = useRef(new Map());
    const stickToBottomRef = useRef(true);
    const preserveScrollRef = useRef(null);
    const listRef = useRef(null);
    function nearBottom(el) {
        return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    }
    function scrollToBottom(el) {
        el.scrollTop = el.scrollHeight;
        // Once more next frame — catches layout that settles just after render.
        requestAnimationFrame(() => {
            el.scrollTop = el.scrollHeight;
        });
    }
    function onListScroll() {
        const el = scrollRef.current;
        if (!el)
            return;
        stickToBottomRef.current = nearBottom(el);
        scrollPositionsRef.current.set(activeThread, stickToBottomRef.current ? 'bottom' : el.scrollTop);
    }
    // Thread switch (and the initial load): restore where you left this thread,
    // or land pinned to the latest message.
    useEffect(() => {
        const el = scrollRef.current;
        if (!el || loading)
            return;
        const saved = scrollPositionsRef.current.get(activeThread);
        if (typeof saved === 'number') {
            el.scrollTop = saved;
            stickToBottomRef.current = nearBottom(el);
        }
        else {
            stickToBottomRef.current = true;
            scrollToBottom(el);
        }
    }, [activeThread, loading, showingList]);
    // New messages: follow the conversation only while pinned; after "Show
    // earlier", re-anchor so what you were reading stays in place.
    useEffect(() => {
        const el = scrollRef.current;
        if (!el)
            return;
        const keep = preserveScrollRef.current;
        if (keep) {
            preserveScrollRef.current = null;
            el.scrollTop = el.scrollHeight - keep.height + keep.top;
            return;
        }
        if (stickToBottomRef.current)
            scrollToBottom(el);
    }, [messages.length]);
    // Content that grows after render (image decode, chip wrapping, fonts)
    // silently un-bottoms a pinned view — watch the list's size and re-pin.
    useEffect(() => {
        const el = scrollRef.current;
        const content = listRef.current;
        if (!el || !content || typeof ResizeObserver === 'undefined')
            return;
        const ro = new ResizeObserver(() => {
            if (stickToBottomRef.current && !preserveScrollRef.current) {
                el.scrollTop = el.scrollHeight;
            }
        });
        ro.observe(content);
        return () => ro.disconnect();
    }, [loading, activeThread, shown.length > 0, showingList]);
    async function onLoadEarlier() {
        const el = scrollRef.current;
        if (el)
            preserveScrollRef.current = { height: el.scrollHeight, top: el.scrollTop };
        const added = await loadEarlier(activeThread);
        // Nothing added → no render → the anchor would leak into the next real
        // message arrival. Clear it.
        if (added === 0)
            preserveScrollRef.current = null;
    }
    // A DM thread can look empty just because its history predates the loaded
    // window — probe once for its most recent page so old conversations
    // reappear on open instead of claiming "No messages yet".
    useEffect(() => {
        if (loading)
            return;
        if (threadMessages.length > 0)
            return;
        if (historyFor(activeThread) !== 'can-load')
            return;
        void loadEarlier(activeThread);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeThread, threadMessages.length, loading]);
    // Switching thread dismisses any half-open @mention autocomplete (mentions
    // are a team-room thing; a DM already targets its one recipient).
    useEffect(() => {
        setMentionQuery(null);
    }, [activeThread]);
    // The composer grows with its text, up to a few lines.
    function fitTextarea(el) {
        el.style.height = 'auto';
        el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
    }
    useEffect(() => {
        if (textareaRef.current)
            fitTextarea(textareaRef.current);
    }, [draft]);
    function onDraftChange(e) {
        const value = e.target.value;
        setDraft(value);
        if (value.trim())
            notifyTyping();
        const caret = e.target.selectionStart ?? value.length;
        const det = activeThread === 'team' ? detectMention(value, caret) : null;
        if (det) {
            setMentionQuery(det.query);
            setMentionAnchor(det.at);
            setMentionCaret(caret);
            setMentionIndex(0);
        }
        else {
            setMentionQuery(null);
        }
    }
    function selectMention(member) {
        const insert = '@' + (member.name ?? '') + ' ';
        const next = draft.slice(0, mentionAnchor) + insert + draft.slice(mentionCaret);
        setDraft(next);
        setMentionQuery(null);
        setMentionIndex(0);
        const pos = mentionAnchor + insert.length;
        requestAnimationFrame(() => {
            const el = textareaRef.current;
            if (el) {
                el.focus();
                el.setSelectionRange(pos, pos);
            }
        });
    }
    // The hover toolbar's "mention" — start a reply naming the author.
    function mentionAuthor(m) {
        const name = m.author_name ?? '';
        if (!name)
            return;
        const prefix = `@${name} `;
        setDraft((d) => (d.startsWith(prefix) ? d : prefix + d));
        requestAnimationFrame(() => textareaRef.current?.focus());
    }
    function applySuggestion(text) {
        setDraft(text);
        requestAnimationFrame(() => {
            const el = textareaRef.current;
            if (el) {
                el.focus();
                el.setSelectionRange(text.length, text.length);
            }
        });
    }
    async function copyText(m) {
        try {
            await navigator.clipboard.writeText(m.body);
        }
        catch {
            /* no clipboard access — nothing to do */
        }
    }
    // Upload the staged files and hand back their storage records, or an error.
    // Shared by sending now and sending later: either way the files go up
    // first, and a failure part-way removes what did go up.
    async function uploadStaged() {
        const uploaded = [];
        for (const a of attachments) {
            const ext = extForFile(a.name, a.type);
            const path = `${userId}/${crypto.randomUUID()}${ext ? '.' + ext : ''}`;
            const { error: upErr } = await config.client.storage
                .from(CHAT_BUCKET)
                .upload(path, a.blob, { contentType: a.type || 'application/octet-stream', upsert: false });
            if (upErr) {
                if (uploaded.length > 0) {
                    await config.client.storage.from(CHAT_BUCKET).remove(uploaded.map((u) => u.path));
                }
                return { error: upErr.message || 'Could not upload a file. Please try again.' };
            }
            uploaded.push({ path, name: a.name, type: a.type, size: a.blob.size });
        }
        return { files: uploaded };
    }
    // Push targets are computed from the text against known member names, so
    // both picking from the list and typing "@Full Name" register a mention.
    // DMs never carry mentions — the DM push already targets the recipient.
    function mentionedIdsIn(text) {
        if (activeThread !== 'team')
            return [];
        const lower = text.toLowerCase();
        return [
            ...new Set(mentionCandidates
                .filter((m) => m.name && lower.includes('@' + m.name.toLowerCase()))
                .map((m) => m.id)),
        ];
    }
    // Everything that follows a successful send or schedule: the composer is
    // emptied and the thread returns to its latest message, even if you had
    // scrolled up to re-read something before replying.
    function clearComposer() {
        for (const a of attachments)
            URL.revokeObjectURL(a.url);
        setAttachments([]);
        setCarried([]);
        setEditing(null);
        setDraft('');
        setMentionQuery(null);
        setNewMarkerId(null);
        setLaterOpen(false);
        stickToBottomRef.current = true;
        scrollPositionsRef.current.set(activeThread, 'bottom');
        const el = scrollRef.current;
        if (el)
            scrollToBottom(el);
    }
    // When the composer holds an edit, the row being edited is taken back
    // first, keeping its files (the replacement carries them). `removed: false`
    // means the cron sent it meanwhile: say so and stop, rather than send the
    // same words twice.
    async function retireEdited() {
        if (!editing)
            return true;
        const res = await cancelScheduled(editing.id, { keepFiles: true });
        if (!res.ok) {
            setError(res.error || 'Could not change that message. Please try again.');
            return false;
        }
        if (!res.removed) {
            setError('That message has already been sent, so there is nothing left to change.');
            setEditing(null);
            setCarried([]);
            return false;
        }
        return true;
    }
    // Files the edit dropped from a row it has now replaced: nothing names them
    // any more, so they go. Best effort.
    function removeDroppedCarried(from) {
        const kept = new Set(carried.map((c) => c.path));
        const dropped = (from.attachment_files ?? []).filter((f) => !kept.has(f.path)).map((f) => f.path);
        if (dropped.length > 0)
            void config.client.storage.from(CHAT_BUCKET).remove(dropped);
    }
    async function handleSend() {
        const text = draft.trim();
        if ((!text && attachments.length === 0 && carried.length === 0) || sending)
            return;
        if (!userId)
            return;
        setSending(true);
        setError(null);
        const up = await uploadStaged();
        if ('error' in up) {
            setSending(false);
            setError(up.error);
            return;
        }
        const files = [...carried, ...up.files];
        const edited = editing;
        if (!(await retireEdited())) {
            setSending(false);
            if (up.files.length > 0)
                await config.client.storage.from(CHAT_BUCKET).remove(up.files.map((u) => u.path));
            return;
        }
        const res = await send(text, mentionedIdsIn(text), files);
        setSending(false);
        if (!res.ok) {
            if (up.files.length > 0) {
                await config.client.storage.from(CHAT_BUCKET).remove(up.files.map((u) => u.path));
            }
            setError(res.error || 'Could not send your message. Please try again.');
            return;
        }
        if (edited)
            removeDroppedCarried(edited);
        clearComposer();
    }
    async function handleSchedule(at) {
        const text = draft.trim();
        if ((!text && attachments.length === 0 && carried.length === 0) || sending)
            return;
        if (!userId)
            return;
        const problem = scheduleProblem(at);
        if (problem) {
            setLaterProblem(problem);
            return;
        }
        setSending(true);
        setError(null);
        setLaterProblem(null);
        const up = await uploadStaged();
        if ('error' in up) {
            setSending(false);
            setError(up.error);
            return;
        }
        const files = [...carried, ...up.files];
        const edited = editing;
        if (!(await retireEdited())) {
            setSending(false);
            if (up.files.length > 0)
                await config.client.storage.from(CHAT_BUCKET).remove(up.files.map((u) => u.path));
            return;
        }
        const res = await scheduleSend(text, mentionedIdsIn(text), files, at);
        setSending(false);
        if (!res.ok) {
            if (up.files.length > 0) {
                await config.client.storage.from(CHAT_BUCKET).remove(up.files.map((u) => u.path));
            }
            setError(res.error || 'Could not schedule your message. Please try again.');
            return;
        }
        if (edited)
            removeDroppedCarried(edited);
        clearComposer();
    }
    // Open the time picker, seeded with the row's own time when editing, else
    // the first preset, so the custom field never opens empty.
    function openLater() {
        const seed = editing ? new Date(editing.send_at) : schedulePresets()[0].at;
        setLaterValue(toLocalInputValue(seed.getTime() < earliestSendAt().getTime() ? earliestSendAt() : seed));
        setLaterProblem(null);
        setLaterOpen((v) => !v);
    }
    // Edit: the row's words into the composer, its files carried, and the
    // conversation switched to the row's own. The row stays put until the
    // edit is saved as something.
    function startEdit(row) {
        const thread = row.recipient_id ?? 'team';
        if (thread !== activeThread)
            openThread(thread);
        for (const a of attachments)
            URL.revokeObjectURL(a.url);
        setAttachments([]);
        setCarried(row.attachment_files ?? []);
        setEditing(row);
        setDraft(row.body);
        setError(null);
        setLaterOpen(false);
        requestAnimationFrame(() => {
            const el = textareaRef.current;
            if (!el)
                return;
            el.focus();
            el.setSelectionRange(el.value.length, el.value.length);
        });
    }
    function cancelEdit() {
        setEditing(null);
        setCarried([]);
        setDraft('');
        setError(null);
    }
    async function onSendNow(row) {
        setError(null);
        if (editing?.id === row.id)
            cancelEdit();
        const res = await sendScheduledNow(row.id);
        if (!res.ok)
            setError(res.error || 'Could not send it. It is still waiting.');
    }
    async function onCancelScheduled(row) {
        setError(null);
        if (editing?.id === row.id)
            cancelEdit();
        const res = await cancelScheduled(row.id);
        if (!res.ok)
            setError(res.error || 'Could not cancel it. Please try again.');
    }
    function onKeyDown(e) {
        if (mentionQuery !== null && filtered.length > 0) {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                setMentionIndex((i) => (i + 1) % filtered.length);
                return;
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                setMentionIndex((i) => (i - 1 + filtered.length) % filtered.length);
                return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                selectMention(filtered[Math.min(mentionIndex, filtered.length - 1)]);
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                setMentionQuery(null);
                return;
            }
        }
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (editing)
                void handleSchedule(new Date(editing.send_at));
            else
                void handleSend();
        }
    }
    function openThread(thread) {
        setActiveThread(thread);
        if (pagePhone)
            setPhoneThreadOpen(true);
    }
    // ── Header copy ───────────────────────────────────────────────────────
    const peerStatus = activePeer
        ? activePeer.isBot
            ? undefined
            : presenceByUser.get(activePeer.id) ?? null
        : undefined;
    const headName = activeThread === 'team' ? 'Team' : activePeer?.name ?? 'Teammate';
    const headSub = activeThread === 'team'
        ? others.length > 0
            ? `${others.length} around · everyone on the team can see this`
            : 'Everyone on the team can see this'
        : activePeer?.isBot
            ? 'Reads the apps, never changes them · private to you'
            : `${peerStatus ? CHAT_STATUS_META[peerStatus].label : 'Offline'} · private to the two of you`;
    const botTyping = bot !== null && typingUsers.some((u) => u.userId === bot.id);
    const peopleTyping = typingUsers.filter((u) => !bot || u.userId !== bot.id);
    // ── Pieces ────────────────────────────────────────────────────────────
    const chips = (_jsxs("div", { className: "pd-chat__chips", children: [_jsx(ThreadChip, { thread: "team", label: "Team", member: null, active: activeThread === 'team', count: threadUnread.team ?? 0, onClick: () => openThread('team') }), mentionCandidates.map((m) => (_jsx(ThreadChip, { thread: m.id, label: firstName(m.name), member: m, active: activeThread === m.id, count: threadUnread[m.id] ?? 0, status: m.isBot ? undefined : presenceByUser.get(m.id) ?? null, onClick: () => openThread(m.id) }, m.id)))] }));
    // The conversation list for the page: Team first, then everyone by their
    // last message, those with none after, the assistant last among those.
    const listRows = useMemo(() => {
        const people = mentionCandidates.slice().sort((a, b) => {
            const la = latestByThread.get(a.id)?.created_at ?? '';
            const lb = latestByThread.get(b.id)?.created_at ?? '';
            if (la !== lb)
                return la > lb ? -1 : 1;
            if (a.isBot !== b.isBot)
                return a.isBot ? 1 : -1;
            return (a.name ?? '').localeCompare(b.name ?? '');
        });
        return people;
    }, [mentionCandidates, latestByThread]);
    function snippetFor(thread, member) {
        const last = latestByThread.get(thread);
        if (last) {
            const who = last.author_id === userId ? 'You' : firstName(last.author_name);
            const text = last.body.trim() || 'Sent an attachment';
            return thread === 'team' || last.author_id === userId ? `${who}: ${text}` : text;
        }
        if (thread === 'team')
            return 'Say hello to the team';
        if (member?.isBot)
            return 'Ask about a project, an order or a customer';
        return 'No messages yet';
    }
    const conversationList = (_jsxs("div", { className: ['pd-chat__convos', pagePhone ? 'pd-chat__convos--phone' : ''].filter(Boolean).join(' '), children: [_jsxs("div", { className: "pd-chat__convos-head", children: [_jsx("span", { className: "pdc-t-title", children: pagePhone ? 'Chat' : 'Conversations' }), _jsx("span", { className: "pdc-t-caption pdc-text-ink-mute", children: others.length > 0 ? `${others.length} around` : 'Nobody else around' })] }), pagePhone && others.length > 0 && (_jsx("div", { className: "pd-chat__around", children: others.slice(0, 8).map((p) => (_jsxs("button", { type: "button", className: "pd-chat__around-person", onClick: () => openThread(p.userId), children: [_jsx(PersonAvatar, { size: "xl", initials: p.initials, colour: p.colour, avatarUrl: p.avatarUrl, status: p.status }), _jsx("span", { className: "pd-chat__around-name", children: firstName(p.name) })] }, p.userId))) })), _jsx("div", { className: "pd-chat__convos-list", children: ['team', ...listRows.map((m) => m.id)].map((thread) => {
                    const member = thread === 'team' ? null : membersById.get(thread) ?? null;
                    const count = threadUnread[thread] ?? 0;
                    const last = latestByThread.get(thread);
                    const name = thread === 'team' ? 'Team' : member?.name ?? 'Teammate';
                    return (_jsxs("button", { type: "button", onClick: () => openThread(thread), "aria-pressed": !pagePhone && activeThread === thread, className: ['pd-chat__row', count > 0 ? 'pd-chat__row--unread' : ''].filter(Boolean).join(' '), children: [_jsx(ThreadAvatar, { thread: thread, member: member, status: member && !member.isBot ? presenceByUser.get(member.id) ?? null : undefined, size: "xl" }), _jsxs("span", { className: "pd-chat__row-text", children: [_jsxs("span", { className: "pd-chat__row-name", children: [name, member?.isBot && _jsx(BotTag, {})] }), _jsx("span", { className: "pd-chat__row-snip", children: snippetFor(thread, member) })] }), _jsxs("span", { className: "pd-chat__row-end", children: [last && _jsx("span", { className: "pd-chat__row-time", children: rowTime(last.created_at) }), _jsx(UnreadCount, { count: count, room: thread === 'team' })] })] }, thread));
                }) })] }));
    const header = (_jsxs("div", { className: "pd-chat__head", children: [pagePhone && (_jsx("button", { type: "button", className: "pd-chat__ib", "aria-label": "Back to conversations", onClick: () => setPhoneThreadOpen(false), children: _jsx(ChevronLeft, { size: 18, "aria-hidden": "true" }) })), _jsx(ThreadAvatar, { thread: activeThread, member: activePeer, status: peerStatus, size: "lg" }), _jsxs("div", { className: "pd-chat__head-text", children: [_jsxs("span", { className: "pd-chat__head-name", children: [headName, activePeer?.isBot && _jsx(BotTag, {})] }), _jsx("span", { className: "pd-chat__head-sub", children: headSub })] }), _jsxs("div", { className: "pd-chat__head-actions", children: [_jsx("button", { type: "button", onClick: () => setSearchOpen((v) => {
                            const next = !v;
                            if (!next)
                                setSearch('');
                            return next;
                        }), "aria-pressed": searchOpen, "aria-label": searchOpen ? 'Close search' : 'Search this conversation', title: "Search this conversation", className: "pd-chat__ib", children: _jsx(SearchIcon, { size: 16, "aria-hidden": "true" }) }), _jsx(PanelMenu, { items: placementItems, linkComponent: linkComponent }), headerAction] })] }));
    const searchRow = searchOpen && (_jsx("div", { className: "pd-chat__search", children: _jsxs("label", { className: "pd-chat__search-field", children: [_jsx(SearchIcon, { size: 14, "aria-hidden": "true" }), _jsx("input", { type: "search", autoFocus: true, value: search, onChange: (e) => setSearch(e.target.value), placeholder: "Search this conversation", "aria-label": "Search this conversation" }), search && (_jsx("button", { type: "button", onClick: () => setSearch(''), "aria-label": "Clear search", className: "pd-chat__ib pd-chat__ib--sm", children: _jsx(X, { size: 14, "aria-hidden": "true" }) }))] }) }));
    const emptyState = activePeer?.isBot ? (_jsxs("div", { className: "pd-chat__empty", children: [_jsx(BotAvatar, { size: "xl" }), _jsx("span", { className: "pd-chat__empty-title", children: "Ask about a project, an order or a customer" }), _jsxs("span", { className: "pd-chat__empty-text", children: [firstName(activePeer.name), " reads the proof viewer, Stock Control, Help Scout and the Xero ledger. It only reads. Prices it quotes are checked against the catalogue, and it says when it could not check one."] }), _jsx("div", { className: "pd-chat__suggestions", children: BOT_SUGGESTIONS.map((s) => (_jsx("button", { type: "button", className: "pd-chat__suggestion", onClick: () => applySuggestion(s), children: s }, s))) }), _jsx("span", { className: "pdc-t-caption pdc-text-ink-mute", children: "Only you see this conversation. Nothing you ask is posted anywhere." })] })) : activePeer ? (_jsxs("div", { className: "pd-chat__empty", children: [_jsx("span", { className: "pd-chat__empty-title", children: "No messages yet" }), _jsxs("span", { className: "pd-chat__empty-text", children: ["A private conversation between you and ", firstName(activePeer.name), ". No-one else can see it."] })] })) : (_jsxs("div", { className: "pd-chat__empty", children: [_jsx("span", { className: "pd-chat__empty-title", children: "No messages yet" }), _jsx("span", { className: "pd-chat__empty-text", children: "Say hello to the team. Everyone signed in can read the room." })] }));
    const list = (_jsx("div", { ref: scrollRef, onScroll: onListScroll, className: ['pd-chat__list pdc-overflow-y-auto', pageWide ? 'pd-chat__list--page' : ''].filter(Boolean).join(' '), children: loading ? (_jsx("div", { className: "pdc-flex pdc-h-full pdc-items-center pdc-justify-center", children: _jsx("div", { className: "pd-chat__spinner" }) })) : threadMessages.length === 0 && !searchQuery ? (emptyState) : shown.length === 0 ? (_jsx("div", { className: "pd-chat__empty", children: searchingRemote ? (_jsx("span", { className: "pd-chat__empty-text", children: "Searching the whole conversation\u2026" })) : (_jsxs(_Fragment, { children: [_jsx("span", { className: "pd-chat__empty-title", children: "No matches" }), _jsxs("span", { className: "pd-chat__empty-text", children: ["Nothing here says \u201C", search.trim(), "\u201D."] })] })) })) : (_jsxs("div", { ref: listRef, className: "pdc-mt-auto", children: [!searchQuery && historyFor(activeThread) !== 'exhausted' && (_jsx("div", { className: "pdc-flex pdc-justify-center", style: { paddingBottom: 8 }, children: _jsx("button", { type: "button", onClick: () => void onLoadEarlier(), disabled: historyFor(activeThread) === 'loading', className: "pd-chat__earlier", children: historyFor(activeThread) === 'loading' ? 'Loading…' : 'Show earlier messages' }) })), searchQuery && searchingRemote && (_jsx("p", { className: "pdc-t-caption pdc-text-ink-mute pdc-text-center", style: { paddingBottom: 8 }, children: "Searching the whole conversation\u2026" })), _jsx("ul", { children: shown.map((m, i) => {
                        const prev = shown[i - 1];
                        const showDay = !prev || dayKey(prev.created_at) !== dayKey(m.created_at);
                        const showNew = newMarkerId === m.id;
                        const grouped = !showDay && !showNew && isGroupedWithPrevious(prev, m);
                        const mine = userId !== null && m.author_id === userId;
                        const canDelete = m.author_id === userId || isAdmin;
                        const msgReactions = groupReactions(reactionsByMessage.get(m.id) ?? [], userId);
                        const author = m.author_id ? membersById.get(m.author_id) : undefined;
                        const authorIsBot = author?.isBot === true;
                        // Prefer the roster's live colour over the copy frozen onto the
                        // row when it was sent, so someone changing their colour
                        // recolours their whole history at once rather than splitting it
                        // into before-and-after. The frozen value is the fallback for an
                        // author who has since left the roster.
                        const authorColour = author?.colour ?? m.author_colour;
                        return (_jsxs("li", { children: [showDay && (_jsxs("div", { className: "pd-chat__divider", children: [_jsx("span", { className: "pd-chat__divider-rule" }), _jsx("span", { className: "pdc-t-label pdc-text-ink-mute", children: dayLabel(m.created_at) }), _jsx("span", { className: "pd-chat__divider-rule" })] })), showNew && (_jsxs("div", { className: "pd-chat__divider pd-chat__divider--new", role: "separator", "aria-label": "New messages", children: [_jsx("span", { className: "pd-chat__divider-rule" }), _jsx("span", { className: "pdc-t-label", children: "New" }), _jsx("span", { className: "pd-chat__divider-rule" })] })), _jsx(MessageRow, { message: m, grouped: grouped, mine: mine, canDelete: canDelete, canMention: !mine && activeThread === 'team' && !!m.author_name, authorIsBot: authorIsBot, authorAvatar: author?.avatarUrl ?? null, authorColour: authorColour, reactions: msgReactions, memberNames: memberNames, onReact: (emoji) => toggleReaction(m.id, emoji), onMention: () => mentionAuthor(m), onCopy: () => void copyText(m), onDelete: () => void remove(m.id) })] }, m.id));
                    }) }), botTyping && (_jsxs("div", { className: "pd-chat__thinking", "aria-live": "polite", children: [_jsx(BotAvatar, { size: "md" }), _jsxs("span", { className: "pd-chat__thinking-dots", "aria-hidden": "true", children: [_jsx("span", {}), _jsx("span", {}), _jsx("span", {})] }), firstName(bot?.name), " is looking\u2026"] }))] })) }));
    const nothingToSend = !draft.trim() && attachments.length === 0 && carried.length === 0;
    // The banner over an edit names the time the row still holds. Once that
    // time has come the cron is about to take it, and the banner says so.
    const editingLine = (() => {
        if (!editing)
            return '';
        const when = sendAtLabel(editing.send_at, new Date(clock));
        if (when === 'Sending now')
            return 'Editing a message that is about to be sent';
        return `Editing a message scheduled for ${when.replace(/^(Today|Tomorrow)/, (w) => w.toLowerCase())}`;
    })();
    // The waiting messages for the conversation on screen, as a strip between
    // the thread and the composer: each with its time, its words, and Send now
    // / Edit / Cancel. Drawn only once there is something waiting, so a thread
    // with nothing scheduled looks exactly as it did.
    const waiting = scheduledSupported ? scheduledForThread(scheduled, activeThread) : [];
    const scheduledStrip = waiting.length > 0 && (_jsxs("div", { className: ['pd-chat__scheduled', pageWide ? 'pd-chat__scheduled--page' : ''].filter(Boolean).join(' '), "aria-label": "Scheduled messages", children: [_jsx("div", { className: "pd-chat__scheduled-head", children: _jsxs("span", { className: "pdc-t-label pdc-text-ink-mute", children: ["Scheduled \u00B7 ", waiting.length] }) }), _jsx("ul", { className: "pd-chat__scheduled-list", children: waiting.map((row) => {
                    const files = row.attachment_files ?? [];
                    const isEditing = editing?.id === row.id;
                    return (_jsxs("li", { className: ['pd-chat__scheduled-row', isEditing ? 'pd-chat__scheduled-row--editing' : ''].filter(Boolean).join(' '), children: [_jsx(Clock, { size: 14, "aria-hidden": "true", className: "pd-chat__scheduled-glyph" }), _jsxs("span", { className: "pd-chat__scheduled-text", children: [_jsx("span", { className: "pd-chat__scheduled-when", children: sendAtLabel(row.send_at, new Date(clock)) }), _jsxs("span", { className: "pd-chat__scheduled-body", children: [row.body.trim() || (files.length === 1 ? 'Sends an attachment' : `Sends ${files.length} attachments`), row.body.trim() && files.length > 0 ? ` · ${files.length === 1 ? '1 file' : `${files.length} files`}` : ''] })] }), _jsxs("span", { className: "pd-chat__scheduled-actions", children: [_jsx("button", { type: "button", onClick: () => void onSendNow(row), disabled: sending, "aria-label": "Send now", className: "pd-chat__scheduled-act", children: "Send now" }), _jsx("button", { type: "button", onClick: () => startEdit(row), disabled: sending || isEditing, "aria-label": "Edit scheduled message", className: "pd-chat__scheduled-act", children: "Edit" }), _jsx("button", { type: "button", onClick: () => void onCancelScheduled(row), disabled: sending, "aria-label": "Cancel scheduled message", className: "pd-chat__scheduled-act pd-chat__scheduled-act--cancel", children: "Cancel" })] })] }, row.id));
                }) })] }));
    const composer = (_jsxs("div", { ...zoneProps, className: [
            'pd-chat__composer',
            pageWide ? 'pd-chat__composer--page' : '',
            isZoneDragOver ? 'pd-chat__composer--drag' : '',
        ]
            .filter(Boolean)
            .join(' '), children: [mentionQuery !== null && filtered.length > 0 && (_jsx("div", { className: "pd-chat__mentions", children: filtered.map((m, i) => (_jsxs("button", { type: "button", 
                    // onMouseDown (not onClick) so selecting doesn't blur the textarea first.
                    onMouseDown: (e) => {
                        e.preventDefault();
                        selectMention(m);
                    }, onMouseEnter: () => setMentionIndex(i), className: ['pd-chat__mention-row', i === mentionIndex ? 'pd-chat__mention-row--on' : ''].filter(Boolean).join(' '), children: [m.isBot ? (_jsx(BotAvatar, { size: "sm" })) : (_jsx(PersonAvatar, { size: "sm", initials: m.initials, colour: m.colour, avatarUrl: m.avatarUrl })), _jsx("span", { className: "pdc-font-medium", children: m.name ?? 'Someone' }), m.isBot && _jsx(BotTag, {})] }, m.id))) })), editing && (_jsxs("div", { className: "pd-chat__editing", role: "status", children: [_jsx(Clock, { size: 13, "aria-hidden": "true" }), _jsx("span", { className: "pd-chat__editing-text", children: editingLine }), _jsx("button", { type: "button", onClick: cancelEdit, className: "pd-chat__editing-cancel", children: "Keep it as it was" })] })), (attachments.length > 0 || carried.length > 0) && (_jsxs("div", { className: "pd-chat__staged", children: [carried.map((c) => {
                        const Icon = fileKindIcon(c.name, c.type);
                        const meta = [kindLabel(c.name, c.type), formatBytes(c.size)].filter(Boolean).join(' · ');
                        return (_jsxs("div", { className: "pd-chat__staged-item pd-chat__staged-item--file", children: [_jsx(Icon, { size: 18, "aria-hidden": "true", className: "pdc-text-ink-mute" }), _jsxs("span", { className: "pd-chat__file-text", children: [_jsx("span", { className: "pd-chat__file-name", children: c.name }), meta && _jsx("span", { className: "pd-chat__file-meta", children: meta })] }), _jsx("button", { type: "button", onClick: () => setCarried((prev) => prev.filter((x) => x.path !== c.path)), "aria-label": "Remove attachment", className: "pd-chat__staged-remove", children: _jsx(X, { size: 11, "aria-hidden": "true" }) })] }, c.path));
                    }), attachments.map((a) => {
                        const Icon = fileKindIcon(a.name, a.type);
                        const meta = [kindLabel(a.name, a.type), formatBytes(a.blob.size)].filter(Boolean).join(' · ');
                        return (_jsxs("div", { className: ['pd-chat__staged-item', isImageType(a.type) ? 'pd-chat__staged-item--image' : 'pd-chat__staged-item--file'].join(' '), children: [isImageType(a.type) ? (_jsx("img", { src: a.url, alt: "" })) : (_jsxs(_Fragment, { children: [_jsx(Icon, { size: 18, "aria-hidden": "true", className: "pdc-text-ink-mute" }), _jsxs("span", { className: "pd-chat__file-text", children: [_jsx("span", { className: "pd-chat__file-name", children: a.name }), meta && _jsx("span", { className: "pd-chat__file-meta", children: meta })] })] })), _jsx("button", { type: "button", onClick: () => removeAttachment(a.id), "aria-label": "Remove attachment", className: "pd-chat__staged-remove", children: _jsx(X, { size: 11, "aria-hidden": "true" }) })] }, a.id));
                    })] })), error && (_jsx("p", { role: "alert", className: "pd-chat__error", children: error })), _jsx("div", { className: "pd-chat__typing", "aria-live": "polite", children: peopleTyping.length > 0 ? typingLabel(peopleTyping) : '' }), _jsxs("div", { className: "pd-chat__field", children: [_jsx("textarea", { ref: textareaRef, value: draft, onChange: onDraftChange, onKeyDown: onKeyDown, onPaste: handlePaste, rows: 1, placeholder: activePeer?.isBot
                            ? `Ask ${firstName(activePeer.name)}`
                            : activePeer
                                ? `Message ${firstName(activePeer.name)}`
                                : 'Message the team', "aria-label": activePeer ? `Message ${firstName(activePeer.name)}` : 'Message the team', className: "pd-chat__composer-input" }), _jsx("button", { type: "button", onClick: () => fileRef.current?.click(), disabled: attachments.length >= MAX_ATTACHMENTS, "aria-label": "Attach a file", title: "Attach a file", className: "pd-chat__ib", children: _jsx(Paperclip, { size: 16, "aria-hidden": "true" }) }), scheduledSupported && (_jsxs("div", { ref: laterRef, className: "pd-chat__later-wrap", children: [_jsx("button", { type: "button", onClick: openLater, disabled: nothingToSend || sending, "aria-haspopup": "dialog", "aria-expanded": laterOpen, "aria-label": "Send later", title: "Send later", className: "pd-chat__ib", children: _jsx(Clock, { size: 16, "aria-hidden": "true" }) }), laterOpen && (_jsxs("div", { role: "dialog", "aria-label": "Send later", className: "pd-chat__later", children: [_jsx("div", { className: "pd-chat__later-heading", children: editing ? 'Send it instead' : 'Send this' }), schedulePresets(new Date(clock)).map((preset) => (_jsxs("button", { type: "button", onClick: () => void handleSchedule(preset.at), className: "pd-chat__later-preset", children: [_jsx("span", { children: preset.label }), _jsx("span", { className: "pd-chat__later-time", children: sendAtLabel(preset.at, new Date(clock)) })] }, preset.key))), _jsx("div", { className: "pd-chat__later-divider" }), _jsxs("label", { className: "pd-chat__later-custom", children: [_jsx("span", { className: "pd-chat__later-custom-label", children: "Or pick a time" }), _jsx("input", { type: "datetime-local", value: laterValue, min: toLocalInputValue(earliestSendAt(new Date(clock))), onChange: (e) => {
                                                    setLaterValue(e.target.value);
                                                    setLaterProblem(null);
                                                }, className: "pd-chat__later-input" })] }), laterProblem && _jsx("p", { className: "pd-chat__later-problem", children: laterProblem }), _jsx("button", { type: "button", onClick: () => {
                                            const at = fromLocalInputValue(laterValue);
                                            const problem = scheduleProblem(at, new Date(clock));
                                            if (problem || !at) {
                                                setLaterProblem(problem ?? 'Pick a time to send it.');
                                                return;
                                            }
                                            void handleSchedule(at);
                                        }, disabled: sending, className: "pd-chat__later-go", children: editing ? 'Save for then' : 'Schedule' })] }))] })), editing ? (_jsx("button", { type: "button", onClick: () => void handleSchedule(new Date(editing.send_at)), disabled: nothingToSend || sending, "aria-label": "Save changes", title: "Save (Enter)", className: "pd-chat__send", children: _jsx(Check, { size: 16, "aria-hidden": "true" }) })) : (_jsx("button", { type: "button", onClick: () => void handleSend(), disabled: nothingToSend || sending, "aria-label": "Send message", title: "Send (Enter)", className: "pd-chat__send", children: _jsx(ArrowUp, { size: 16, "aria-hidden": "true" }) }))] }), _jsx("input", { ref: fileRef, type: "file", multiple: true, className: "pdc-sr-only", tabIndex: -1, "aria-hidden": true, onChange: (e) => {
                    addFiles(Array.from(e.target.files ?? []));
                    e.target.value = '';
                } })] }));
    const thread = (_jsxs("div", { className: "pd-chat__thread", children: [header, !pageWide && !pagePhone && chips, searchRow, list, scheduledStrip, composer] }));
    return (
    /* `pd-chat` is the scope every rule in chat.css hangs off, so it has to be
       on the outermost node the panel renders or nothing below it is styled.
       It also declares the colour tokens, which is why the popout variant adds
       its own modifier rather than replacing this class. `pd-chat__panel` is
       the flex column the whole height chain depends on: the list inside
       scrolls only because this fills its host and nothing else grows. */
    _jsx("div", { ref: rootRef, className: ['pd-chat', 'pd-chat__panel', variant === 'popout' ? 'pd-chat--popout' : ''].filter(Boolean).join(' '), children: pageWide ? (_jsxs("div", { className: "pd-chat__page", children: [conversationList, thread] })) : showingList ? (conversationList) : (thread) }));
}
// ── A message row ──────────────────────────────────────────────────────────
function MessageRow({ message: m, grouped, mine, canDelete, canMention, authorIsBot, authorAvatar, authorColour, reactions, memberNames, onReact, onMention, onCopy, onDelete, }) {
    const [pickerOpen, setPickerOpen] = useState(false);
    const files = attachmentsOf(m);
    return (_jsxs("div", { className: ['pd-chat__msg', grouped ? 'pd-chat__msg--grouped' : ''].filter(Boolean).join(' '), children: [_jsx("div", { className: "pd-chat__msg-gutter", children: grouped ? (_jsx("span", { className: "pd-chat__msg-gutter-time", children: messageTime(m.created_at) })) : authorIsBot ? (_jsx(BotAvatar, { size: "md" })) : (_jsx(PersonAvatar, { size: "md", initials: m.author_initials, colour: authorColour, avatarUrl: authorAvatar })) }), _jsxs("div", { className: "pd-chat__msg-main", children: [!grouped && (_jsxs("div", { className: "pd-chat__msg-meta", children: [_jsxs("span", { className: "pd-chat__msg-name", children: [mine ? 'You' : firstName(m.author_name), authorIsBot && _jsx(BotTag, {})] }), _jsx("span", { className: "pd-chat__msg-time", children: messageTime(m.created_at) })] })), m.body && (_jsx("p", { className: "pd-chat__msg-body", children: buildMessageSegments(m.body, memberNames).map((seg, si) => seg.type === 'link' ? (_jsx("a", { href: seg.value, target: "_blank", rel: "noreferrer", children: seg.value }, si)) : seg.type === 'mention' ? (_jsx("span", { className: "pd-chat__mention", children: seg.value }, si)) : (_jsx("span", { children: seg.value }, si))) })), files.length > 0 && _jsx(ChatAttachments, { files: files }), reactions.length > 0 && (_jsx("div", { className: "pd-chat__reactions", children: reactions.map((g) => (_jsxs("button", { type: "button", onClick: () => onReact(g.emoji), title: g.names.map((n) => firstName(n)).join(', '), "aria-pressed": g.mine, className: ['pd-chat__react', g.mine ? 'pd-chat__react--mine' : ''].filter(Boolean).join(' '), children: [_jsx("span", { children: g.emoji }), _jsx("span", { className: "pd-chat__react-count", children: g.count })] }, g.emoji))) }))] }), _jsxs("div", { className: ['pd-chat__tools', pickerOpen ? 'pd-chat__tools--open' : ''].filter(Boolean).join(' '), children: [_jsx(ReactButton, { messageId: m.id, onOpenChange: setPickerOpen }), canMention && (_jsx("button", { type: "button", onClick: onMention, "aria-label": `Reply mentioning ${firstName(m.author_name)}`, title: "Reply with a mention", className: "pd-chat__tool", children: _jsx(AtSign, { size: 14, "aria-hidden": "true" }) })), m.body && (_jsx("button", { type: "button", onClick: onCopy, "aria-label": "Copy message text", title: "Copy text", className: "pd-chat__tool", children: _jsx(Copy, { size: 14, "aria-hidden": "true" }) })), canDelete && (_jsx("button", { type: "button", onClick: onDelete, "aria-label": "Delete message", title: "Delete", className: "pd-chat__tool pd-chat__tool--danger", children: _jsx(Trash2, { size: 14, "aria-hidden": "true" }) }))] })] }));
}
//# sourceMappingURL=TeamChatPanel.js.map