import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useMemo, useRef, useState } from 'react';
import { Send, Trash2, ChevronDown, Check, Volume2, VolumeX, SearchIcon, X, Paperclip, FileText, FileIcon, Download, Smile, } from './icons.js';
import { useImageFileDrop } from './useFileDrop.js';
import { playChatSound } from './sound.js';
import { useTeamChat } from './store.js';
import { attachmentsOf, authorBadgeColour, buildMessageSegments, dayKey, dayLabel, formatBytes, isGroupedWithPrevious, messageTime, } from './message.js';
import { designerTint } from './colours.js';
import { CHAT_BUCKET, CHAT_STATUS_META, } from './types.js';
const EMOJI_CHOICES = ['👍', '❤️', '😂', '🎉', '👀', '✅', '🙏'];
const MAX_ATTACHMENTS = 6;
const MAX_MB = 25;
const MAX_BYTES = MAX_MB * 1024 * 1024; // matches the 000323 bucket cap
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
// Lucide icon for a non-image attachment chip.
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
    return (_jsxs(_Fragment, { children: [_jsx("div", { className: "pdc-mt-1-5 pdc-flex pdc-flex-wrap pdc-gap-1-5", children: files.map((f, i) => {
                    const url = urls[i];
                    if (!url)
                        return null;
                    if (isImageType(f.type)) {
                        return (_jsx("button", { type: "button", onClick: () => setLightbox(url), className: "pdc-overflow-hidden pdc-rounded-lg pdc-border pdc-border-line", children: _jsx("img", { src: url, alt: f.name || 'Attachment', loading: "lazy", className: "pdc-h-36 pdc-w-36 pdc-object-cover" }) }, i));
                    }
                    // Force a download with the real filename via the signed URL's
                    // ?download param (the stored key is a random uuid).
                    const href = `${url}${url.includes('?') ? '&' : '?'}download=${encodeURIComponent(f.name || 'file')}`;
                    const Icon = fileKindIcon(f.name, f.type);
                    const meta = [kindLabel(f.name, f.type), formatBytes(f.size)].filter(Boolean).join(' · ');
                    return (_jsxs("a", { href: href, target: "_blank", rel: "noopener noreferrer", title: `Download ${f.name}`, className: "pdc-flex pdc-max-w-240px pdc-items-center pdc-gap-2-5 pdc-rounded-lg pdc-border pdc-border-line pdc-bg-canvas pdc-px-3 pdc-py-2 pdc-transition-colors pdc-hover-bg-surface", children: [_jsx(Icon, { size: 22, "aria-hidden": "true", className: "pdc-flex-shrink-0 pdc-text-ink-mute" }), _jsxs("span", { className: "pdc-min-w-0 pdc-flex-1", children: [_jsx("span", { className: "pdc-block pdc-truncate pdc-text-14px pdc-font-medium pdc-text-ink pdc-sm-text-12px", children: f.name || 'File' }), meta && _jsx("span", { className: "pdc-block pdc-text-13px pdc-text-ink-mute pdc-sm-text-11px", children: meta })] }), _jsx(Download, { size: 14, "aria-hidden": "true", className: "pdc-flex-shrink-0 pdc-text-ink-dim" })] }, i));
                }) }), lightbox && (_jsxs("div", { className: "pdc-fixed pdc-inset-0 pdc-z-50 pdc-flex pdc-items-center pdc-justify-center pdc-bg-black-80 pdc-p-4", onClick: () => setLightbox(null), role: "dialog", "aria-modal": "true", children: [_jsx("img", { src: lightbox, alt: "Attachment", className: "pdc-max-h-full pdc-max-w-full pdc-rounded-lg", onClick: (e) => e.stopPropagation() }), _jsx("button", { type: "button", onClick: () => setLightbox(null), "aria-label": "Close image", className: "pdc-absolute pdc-right-4 pdc-top-4 pdc-rounded-full pdc-bg-white-10 pdc-p-2 pdc-text-white pdc-hover-bg-white-20", children: _jsx(X, { size: 20, "aria-hidden": "true" }) })] }))] }));
}
// The hover "react" button + its emoji picker. `pickerAnchor` sets which edge
// the popover hangs from so it always opens over the bubble (where there's
// room) rather than off the panel edge.
function ReactButton({ messageId, pickerAnchor, }) {
    const { toggleReaction } = useTeamChat();
    const [open, setOpen] = useState(false);
    const ref = useRef(null);
    useEffect(() => {
        if (!open)
            return;
        // Bind to the document this menu is actually in, not the app's: popped out
        // into a picture-in-picture window the panel lives in a second document,
        // where a listener on the main one never sees the click or the Escape.
        const doc = ref.current?.ownerDocument ?? document;
        function onDoc(e) {
            if (ref.current && !ref.current.contains(e.target))
                setOpen(false);
        }
        function onKey(e) {
            if (e.key === 'Escape')
                setOpen(false);
        }
        doc.addEventListener('mousedown', onDoc);
        doc.addEventListener('keydown', onKey);
        return () => {
            doc.removeEventListener('mousedown', onDoc);
            doc.removeEventListener('keydown', onKey);
        };
    }, [open]);
    return (_jsxs("div", { ref: ref, className: "pdc-relative", children: [_jsx("button", { type: "button", onClick: () => setOpen((v) => !v), "aria-label": "Add reaction", title: "React", className: "pdc-flex pdc-h-6 pdc-w-6 pdc-items-center pdc-justify-center pdc-rounded pdc-text-ink-mute pdc-hover-bg-canvas pdc-hover-text-ink", children: _jsx(Smile, { size: 14, "aria-hidden": "true" }) }), open && (_jsx("div", { className: [
                    'pdc-absolute pdc-top-7 pdc-z-30 pdc-flex pdc-gap-0-5 pdc-rounded-full pdc-border pdc-border-line pdc-bg-surface pdc-p-1 pdc-shadow-md',
                    pickerAnchor === 'left' ? 'pdc-left-0' : 'pdc-right-0',
                ].join(' '), children: EMOJI_CHOICES.map((e) => (_jsx("button", { type: "button", onClick: () => {
                        toggleReaction(messageId, e);
                        setOpen(false);
                    }, "aria-label": `React ${e}`, className: "pdc-rounded-full pdc-px-1 pdc-text-16px pdc-leading-none pdc-hover-bg-canvas", children: e }, e))) }))] }));
}
function firstName(name) {
    const n = (name ?? '').trim();
    return n ? n.split(/\s+/)[0] : 'Teammate';
}
// One pill in the thread switcher: the Team room or a teammate's private
// thread. Carries that thread's unread count and (for people) a presence dot.
function ThreadPill({ label, active, count, status, onClick, }) {
    return (_jsxs("button", { type: "button", onClick: onClick, "aria-pressed": active, className: [
            'pdc-flex pdc-h-9 pdc-flex-shrink-0 pdc-items-center pdc-gap-1-5 pdc-rounded-full pdc-border pdc-px-3 pdc-text-14px pdc-font-medium pdc-transition-colors pdc-sm-h-7 pdc-sm-px-2-5 pdc-sm-text-12px',
            active
                ? 'pdc-border-ink pdc-bg-ink pdc-text-on-ink'
                : 'pdc-border-line pdc-bg-surface pdc-text-ink-soft pdc-hover-bg-canvas pdc-hover-text-ink',
        ].join(' '), children: [status !== undefined && (_jsx("span", { className: "pdc-inline-block pdc-h-2 pdc-w-2 pdc-flex-shrink-0 pdc-rounded-full", style: { backgroundColor: status ? CHAT_STATUS_META[status].dot : 'var(--c-line)' }, "aria-hidden": "true" })), label, count > 0 && (_jsx("span", { className: "pdc-inline-flex pdc-h-18px pdc-min-w-18px pdc-items-center pdc-justify-center pdc-rounded-full pdc-bg-brand pdc-px-1 pdc-text-11px pdc-font-bold pdc-leading-none pdc-text-white pdc-sm-h-16px pdc-sm-min-w-16px pdc-sm-text-10px", "aria-label": `${count} unread`, children: count > 9 ? '9+' : count }))] }));
}
const SETTABLE = [
    { value: 'online', label: 'Online' },
    { value: 'away', label: 'Away' },
    { value: 'busy', label: 'Busy' },
];
function StatusDot({ status }) {
    return (_jsx("span", { className: "pdc-inline-block pdc-h-2-5 pdc-w-2-5 pdc-rounded-full", style: { backgroundColor: CHAT_STATUS_META[status].dot }, "aria-hidden": "true" }));
}
function PresenceAvatar({ member }) {
    const meta = CHAT_STATUS_META[member.status];
    return (_jsxs("span", { className: "pdc-relative pdc-inline-flex pdc-h-9 pdc-w-9 pdc-items-center pdc-justify-center pdc-overflow-visible pdc-rounded-full pdc-font-mono pdc-text-12px pdc-font-medium pdc-text-white pdc-sm-h-7 pdc-sm-w-7 pdc-sm-text-10px", style: member.avatarUrl ? undefined : { backgroundColor: authorBadgeColour(member.colour) }, title: `${firstName(member.name)} — ${meta.label}`, children: [member.avatarUrl ? (_jsx("img", { src: member.avatarUrl, alt: "", className: "pdc-h-9 pdc-w-9 pdc-rounded-full pdc-object-cover pdc-sm-h-7 pdc-sm-w-7" })) : ((member.initials ?? '?').slice(0, 2)), _jsx("span", { className: "pdc-absolute pdc-neg-bottom-0-5 pdc-neg-right-0-5 pdc-h-3 pdc-w-3 pdc-rounded-full", style: { backgroundColor: meta.dot, boxShadow: '0 0 0 2px var(--c-surface)' }, "aria-hidden": "true" })] }));
}
function StatusPicker() {
    const { myStatus, setManualStatus } = useTeamChat();
    const [open, setOpen] = useState(false);
    const ref = useRef(null);
    useEffect(() => {
        if (!open)
            return;
        // Bind to the document this menu is actually in, not the app's: popped out
        // into a picture-in-picture window the panel lives in a second document,
        // where a listener on the main one never sees the click or the Escape.
        const doc = ref.current?.ownerDocument ?? document;
        function onDoc(e) {
            if (ref.current && !ref.current.contains(e.target))
                setOpen(false);
        }
        function onKey(e) {
            if (e.key === 'Escape')
                setOpen(false);
        }
        doc.addEventListener('mousedown', onDoc);
        doc.addEventListener('keydown', onKey);
        return () => {
            doc.removeEventListener('mousedown', onDoc);
            doc.removeEventListener('keydown', onKey);
        };
    }, [open]);
    return (_jsxs("div", { ref: ref, className: "pdc-relative", children: [_jsxs("button", { type: "button", onClick: () => setOpen((v) => !v), "aria-haspopup": "menu", "aria-expanded": open, className: "pdc-inline-flex pdc-items-center pdc-gap-1-5 pdc-rounded-full pdc-border pdc-border-line pdc-bg-surface pdc-py-1 pdc-pl-2 pdc-pr-1-5 pdc-text-14px pdc-font-medium pdc-text-ink-soft pdc-hover-bg-canvas pdc-sm-text-12px", children: [_jsx(StatusDot, { status: myStatus }), CHAT_STATUS_META[myStatus].label, _jsx(ChevronDown, { size: 13, "aria-hidden": "true", className: "pdc-text-ink-mute" })] }), open && (_jsx("div", { role: "menu", className: "pdc-absolute pdc-left-0 pdc-top-9 pdc-z-30 pdc-min-w-9rem pdc-rounded-10px pdc-border pdc-border-line pdc-bg-surface pdc-py-1 pdc-shadow-md", children: SETTABLE.map((s) => (_jsxs("button", { type: "button", role: "menuitemradio", "aria-checked": myStatus === s.value, onClick: () => {
                        setManualStatus(s.value);
                        setOpen(false);
                    }, className: "pdc-flex pdc-w-full pdc-items-center pdc-gap-2 pdc-px-3 pdc-py-1-5 pdc-text-left pdc-text-15px pdc-text-ink-soft pdc-hover-bg-canvas pdc-sm-text-13px", children: [_jsx(StatusDot, { status: s.value }), _jsx("span", { className: "pdc-flex-1", children: s.label }), myStatus === s.value && _jsx(Check, { size: 14, "aria-hidden": "true", className: "pdc-text-ink-mute" })] }, s.value))) }))] }));
}
function SoundToggle() {
    const { soundEnabled, setSoundEnabled } = useTeamChat();
    return (_jsx("button", { type: "button", onClick: () => {
            const next = !soundEnabled;
            setSoundEnabled(next);
            if (next)
                playChatSound('general'); // confirm + unlock audio on enable
        }, "aria-pressed": soundEnabled, "aria-label": soundEnabled ? 'Mute chat sounds' : 'Unmute chat sounds', title: soundEnabled ? 'Mute chat sounds' : 'Unmute chat sounds', className: "pdc-flex pdc-h-7 pdc-w-7 pdc-flex-shrink-0 pdc-items-center pdc-justify-center pdc-rounded-full pdc-text-ink-mute pdc-transition-colors pdc-hover-bg-canvas pdc-hover-text-ink", children: soundEnabled ? (_jsx(Volume2, { size: 15, "aria-hidden": "true" })) : (_jsx(VolumeX, { size: 15, "aria-hidden": "true" })) }));
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
export default function TeamChatPanel({ variant }) {
    const { config, db, messages, loading, presence, members, send, remove, setViewing, typingUsers, notifyTyping, reactions, toggleReaction, activeThread, setActiveThread, threadUnread, loadEarlier, historyFor, } = useTeamChat();
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
    // Author → profile lookup, so message avatars can use uploaded profile
    // pictures (avatar_url isn't denormalised on the message rows).
    const membersById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
    const presenceByUser = useMemo(() => new Map(presence.map((p) => [p.userId, p.status])), [presence]);
    // Messages for the active thread: the shared room, or my DM pair with the
    // selected peer (both directions). RLS already scopes what arrives; this
    // just splits it into conversations.
    const threadMessages = useMemo(() => {
        if (activeThread === 'team')
            return messages.filter((m) => !m.recipient_id);
        return messages.filter((m) => (m.author_id === activeThread && m.recipient_id === userId) ||
            (m.author_id === userId && m.recipient_id === activeThread));
    }, [messages, activeThread, userId]);
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
    useEffect(() => {
        setViewing(true);
        return () => setViewing(false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
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
    }, [activeThread, loading]);
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
    }, [loading, activeThread, shown.length > 0]);
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
    async function handleSend() {
        const text = draft.trim();
        if ((!text && attachments.length === 0) || sending)
            return;
        if (!userId)
            return;
        setSending(true);
        setError(null);
        // Upload any staged files first; collect their storage keys + metadata.
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
                setSending(false);
                setError(upErr.message || 'Could not upload a file. Please try again.');
                return;
            }
            uploaded.push({ path, name: a.name, type: a.type, size: a.blob.size });
        }
        // Push targets are computed from the text against known member names, so
        // both picking from the list and typing "@Full Name" register a mention.
        // DMs never carry mentions — the DM push already targets the recipient.
        const lower = text.toLowerCase();
        const mentionedIds = activeThread === 'team'
            ? [
                ...new Set(mentionCandidates
                    .filter((m) => m.name && lower.includes('@' + m.name.toLowerCase()))
                    .map((m) => m.id)),
            ]
            : [];
        const res = await send(text, mentionedIds, uploaded);
        setSending(false);
        if (!res.ok) {
            if (uploaded.length > 0) {
                await config.client.storage.from(CHAT_BUCKET).remove(uploaded.map((u) => u.path));
            }
            setError(res.error || 'Could not send your message. Please try again.');
            return;
        }
        for (const a of attachments)
            URL.revokeObjectURL(a.url);
        setAttachments([]);
        setDraft('');
        setMentionQuery(null);
        // Sending always returns you to the latest message, even if you'd
        // scrolled up to re-read something before replying.
        stickToBottomRef.current = true;
        scrollPositionsRef.current.set(activeThread, 'bottom');
        const el = scrollRef.current;
        if (el)
            scrollToBottom(el);
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
            void handleSend();
        }
    }
    const others = presence.filter((m) => m.userId !== userId);
    return (
    /* `pd-chat` is the scope every rule in chat.css hangs off, so it has to be
       on the outermost node the panel renders or nothing below it is styled.
       It also declares the colour tokens, which is why the popout variant adds
       its own modifier rather than replacing this class. */
    _jsxs("div", { className: [
            'pd-chat',
            variant === 'popout' ? 'pd-chat--popout' : '',
            'pdc-flex pdc-h-full pdc-min-h-0 pdc-flex-col',
        ]
            .filter(Boolean)
            .join(' '), children: [_jsxs("div", { className: "pdc-flex pdc-items-center pdc-gap-3 pdc-border-b pdc-border-line-soft pdc-px-3 pdc-py-2", children: [_jsx(StatusPicker, {}), _jsx("div", { className: "pdc-flex pdc-min-w-0 pdc-flex-1 pdc-items-center pdc-gap-1-5 pdc-overflow-hidden", children: others.length === 0 ? (_jsx("span", { className: "pdc-truncate pdc-text-14px pdc-text-ink-mute pdc-sm-text-12px", children: "No-one else here right now" })) : (_jsxs(_Fragment, { children: [_jsx("div", { className: "pdc-flex pdc-flex-shrink-0 pdc-items-center pdc-neg-space-x-1-5", children: others.slice(0, 6).map((m) => (_jsx(PresenceAvatar, { member: m }, m.userId))) }), others.length > 6 && (_jsxs("span", { className: "pdc-text-12px pdc-text-ink-mute", children: ["+", others.length - 6] }))] })) }), _jsx("button", { type: "button", onClick: () => setSearchOpen((v) => {
                            const next = !v;
                            if (!next)
                                setSearch('');
                            return next;
                        }), "aria-pressed": searchOpen, "aria-label": searchOpen ? 'Close search' : 'Search messages', title: "Search messages", className: [
                            'pdc-flex pdc-h-7 pdc-w-7 pdc-flex-shrink-0 pdc-items-center pdc-justify-center pdc-rounded-full pdc-transition-colors',
                            searchOpen ? 'pdc-bg-canvas pdc-text-ink' : 'pdc-text-ink-mute pdc-hover-bg-canvas pdc-hover-text-ink',
                        ].join(' '), children: _jsx(SearchIcon, { size: 15, "aria-hidden": "true" }) }), _jsx(SoundToggle, {})] }), _jsxs("div", { className: "pdc-flex pdc-flex-shrink-0 pdc-flex-wrap pdc-items-center pdc-gap-1-5 pdc-border-b pdc-border-line-soft pdc-px-3 pdc-py-2", children: [_jsx(ThreadPill, { label: "Team", active: activeThread === 'team', count: threadUnread.team ?? 0, onClick: () => setActiveThread('team') }), mentionCandidates.map((m) => (_jsx(ThreadPill, { label: firstName(m.name), active: activeThread === m.id, count: threadUnread[m.id] ?? 0, status: presenceByUser.get(m.id) ?? null, onClick: () => setActiveThread(m.id) }, m.id)))] }), searchOpen && (_jsxs("div", { className: "pdc-flex pdc-items-center pdc-gap-2 pdc-border-b pdc-border-line-soft pdc-px-3 pdc-py-2", children: [_jsx(SearchIcon, { size: 14, className: "pdc-text-ink-mute", "aria-hidden": "true" }), _jsx("input", { type: "search", autoFocus: true, value: search, onChange: (e) => setSearch(e.target.value), placeholder: "Search messages\u2026", className: "pdc-flex-1 pdc-bg-transparent pdc-text-17px pdc-text-ink pdc-outline-none pdc-placeholder-text-ink-dim pdc-sm-text-13px" }), search && (_jsx("button", { type: "button", onClick: () => setSearch(''), "aria-label": "Clear search", className: "pdc-text-ink-mute pdc-hover-text-ink", children: _jsx(X, { size: 14, "aria-hidden": "true" }) }))] })), _jsx("div", { ref: scrollRef, onScroll: onListScroll, className: "pdc-flex pdc-min-h-0 pdc-flex-1 pdc-flex-col pdc-overflow-y-auto pdc-overscroll-contain pdc-px-3 pdc-py-3", children: loading ? (_jsx("div", { className: "pdc-flex pdc-h-full pdc-items-center pdc-justify-center", children: _jsx("div", { className: "pdc-h-6 pdc-w-6 pdc-animate-spin pdc-rounded-full pdc-border-2 pdc-border-line pdc-motion-reduce-animate-none", style: { borderTopColor: 'var(--c-ink)' } }) })) : threadMessages.length === 0 ? (_jsxs("div", { className: "pdc-flex pdc-h-full pdc-flex-col pdc-items-center pdc-justify-center pdc-px-6 pdc-text-center", children: [_jsx("p", { className: "pdc-text-17px pdc-text-ink-soft pdc-sm-text-14px", children: "No messages yet." }), _jsx("p", { className: "pdc-text-15px pdc-text-ink-mute pdc-sm-text-13px", children: activePeer
                                ? `This is a private conversation between you and ${firstName(activePeer.name)} — no-one else can see it.`
                                : 'Say hello to the team.' })] })) : shown.length === 0 ? (_jsx("div", { className: "pdc-flex pdc-h-full pdc-flex-col pdc-items-center pdc-justify-center pdc-text-center", children: searchingRemote ? (_jsx("p", { className: "pdc-text-15px pdc-text-ink-mute pdc-sm-text-13px", children: "Searching the full history\u2026" })) : (_jsxs(_Fragment, { children: [_jsx("p", { className: "pdc-text-17px pdc-text-ink-soft pdc-sm-text-14px", children: "No matches" }), _jsxs("p", { className: "pdc-text-15px pdc-text-ink-mute pdc-sm-text-13px", children: ["Nothing matches \u201C", search.trim(), "\u201D."] })] })) })) : (_jsxs("div", { ref: listRef, className: "pdc-mt-auto", children: [!searchQuery && historyFor(activeThread) !== 'exhausted' && (_jsx("div", { className: "pdc-flex pdc-justify-center pdc-pb-2", children: _jsx("button", { type: "button", onClick: () => void onLoadEarlier(), disabled: historyFor(activeThread) === 'loading', className: "pdc-rounded-full pdc-border pdc-border-line pdc-bg-surface pdc-px-3 pdc-py-1 pdc-text-14px pdc-font-medium pdc-text-ink-soft pdc-transition-colors pdc-hover-bg-canvas pdc-hover-text-ink pdc-disabled-opacity-60 pdc-sm-text-12px", children: historyFor(activeThread) === 'loading' ? 'Loading…' : 'Show earlier messages' }) })), searchQuery && searchingRemote && (_jsx("p", { className: "pdc-pb-2 pdc-text-center pdc-text-13px pdc-text-ink-mute pdc-sm-text-11px", children: "Searching the full history\u2026" })), _jsx("ul", { className: "pdc-space-y-0", children: shown.map((m, i) => {
                                const prev = shown[i - 1];
                                const grouped = isGroupedWithPrevious(prev, m);
                                const showDay = !prev || dayKey(prev.created_at) !== dayKey(m.created_at);
                                const mine = userId !== null && m.author_id === userId;
                                const canDelete = m.author_id === userId || isAdmin;
                                const msgReactions = groupReactions(reactionsByMessage.get(m.id) ?? [], userId);
                                const authorAvatar = m.author_id
                                    ? membersById.get(m.author_id)?.avatarUrl ?? null
                                    : null;
                                // Prefer the roster's live colour over the copy frozen onto the
                                // row when it was sent, so someone changing their colour
                                // recolours their whole history at once rather than splitting it
                                // into before-and-after. The frozen value is the fallback for an
                                // author who has since left the roster.
                                const authorColour = (m.author_id ? membersById.get(m.author_id)?.colour : null) ?? m.author_colour;
                                return (_jsxs("li", { children: [showDay && (_jsxs("div", { className: "pdc-my-3 pdc-flex pdc-items-center pdc-gap-3", children: [_jsx("span", { className: "pdc-h-px pdc-flex-1 pdc-bg-line-soft" }), _jsx("span", { className: "pdc-text-13px pdc-font-medium pdc-uppercase pdc-tracking-wide pdc-text-ink-mute pdc-sm-text-11px", children: dayLabel(m.created_at) }), _jsx("span", { className: "pdc-h-px pdc-flex-1 pdc-bg-line-soft" })] })), _jsxs("div", { className: [
                                                'pdc-group pdc-flex pdc-items-start pdc-gap-2-5',
                                                mine ? '' : 'pdc-flex-row-reverse',
                                                grouped ? 'pdc-mt-0-5' : 'pdc-mt-2-5',
                                            ].join(' '), children: [!mine && (_jsx("div", { className: "pdc-w-9 pdc-flex-shrink-0 pdc-sm-w-7", children: !grouped &&
                                                        (authorAvatar ? (_jsx("img", { src: authorAvatar, alt: "", className: "pdc-h-9 pdc-w-9 pdc-rounded-full pdc-object-cover pdc-sm-h-7 pdc-sm-w-7", "aria-hidden": "true" })) : (_jsx("span", { className: "pdc-inline-flex pdc-h-9 pdc-w-9 pdc-items-center pdc-justify-center pdc-rounded-full pdc-font-mono pdc-text-12px pdc-font-medium pdc-text-white pdc-sm-h-7 pdc-sm-w-7 pdc-sm-text-10px", style: { backgroundColor: authorBadgeColour(authorColour) }, "aria-hidden": "true", children: (m.author_initials ?? '?').slice(0, 2) }))) })), _jsxs("div", { className: [
                                                        'pdc-flex pdc-min-w-0 pdc-max-w-85 pdc-flex-col',
                                                        mine ? 'pdc-items-start' : 'pdc-items-end',
                                                    ].join(' '), children: [!grouped && (_jsxs("div", { className: "pdc-flex pdc-items-baseline pdc-gap-2 pdc-px-1", children: [_jsx("span", { className: "pdc-text-13px pdc-text-ink-mute pdc-sm-text-11px", children: messageTime(m.created_at) }), !mine && activeThread === 'team' && (_jsx("span", { className: "pdc-text-15px pdc-font-semibold pdc-text-ink pdc-sm-text-13px", children: firstName(m.author_name) }))] })), _jsxs("div", { className: ['pdc-flex pdc-items-start pdc-gap-2', mine ? '' : 'pdc-flex-row-reverse'].join(' '), children: [_jsxs("div", { className: [
                                                                        'pdc-min-w-0 pdc-rounded-14px pdc-px-3 pdc-py-1-5',
                                                                        !grouped ? (mine ? 'pdc-rounded-tl-5px' : 'pdc-rounded-tr-5px') : '',
                                                                    ].join(' '), style: { backgroundColor: designerTint(authorColour, 10) }, children: [m.body && (_jsx("p", { className: "pdc-whitespace-pre-wrap pdc-break-words pdc-text-19px pdc-leading-snug pdc-text-ink-soft pdc-sm-text-14px", children: buildMessageSegments(m.body, memberNames).map((seg, si) => seg.type === 'link' ? (_jsx("a", { href: seg.value, target: "_blank", rel: "noreferrer", className: "pdc-break-all pdc-text-brand pdc-underline pdc-underline-offset-2 pdc-hover-text-brand-600", children: seg.value }, si)) : seg.type === 'mention' ? (_jsx("span", { className: "pdc-rounded pdc-bg-brand-50 pdc-px-1 pdc-font-medium pdc-text-brand", children: seg.value }, si)) : (_jsx("span", { children: seg.value }, si))) })), attachmentsOf(m).length > 0 && (_jsx(ChatAttachments, { files: attachmentsOf(m) })), msgReactions.length > 0 && (_jsx("div", { className: "pdc-mt-1 pdc-flex pdc-flex-wrap pdc-gap-1", children: msgReactions.map((g) => (_jsxs("button", { type: "button", onClick: () => toggleReaction(m.id, g.emoji), title: g.names.map((n) => firstName(n)).join(', '), className: [
                                                                                    'pdc-inline-flex pdc-items-center pdc-gap-1 pdc-rounded-full pdc-border pdc-px-1-5 pdc-py-0-5 pdc-text-14px pdc-leading-none pdc-transition-colors pdc-sm-text-12px',
                                                                                    g.mine
                                                                                        ? 'pdc-border-brand pdc-bg-brand-50 pdc-text-ink'
                                                                                        : 'pdc-border-line pdc-bg-surface pdc-text-ink-soft pdc-hover-bg-canvas',
                                                                                ].join(' '), children: [_jsx("span", { children: g.emoji }), _jsx("span", { className: "pdc-font-medium", children: g.count })] }, g.emoji))) }))] }), _jsxs("div", { className: "pdc-mt-0-5 pdc-flex pdc-flex-shrink-0 pdc-items-center pdc-gap-0-5 pdc-transition-opacity pdc-max-md-opacity-100 pdc-md-opacity-0 pdc-focus-within-opacity-100 pdc-md-group-hover-opacity-100", children: [_jsx(ReactButton, { messageId: m.id, pickerAnchor: mine ? 'right' : 'left' }), canDelete && (_jsx("button", { type: "button", onClick: () => void remove(m.id), "aria-label": "Delete message", title: "Delete", className: "pdc-flex pdc-h-6 pdc-w-6 pdc-max-md-h-11 pdc-max-md-w-11 pdc-items-center pdc-justify-center pdc-rounded pdc-text-ink-mute pdc-hover-bg-canvas pdc-hover-text-out pdc-focus-visible-outline-2 pdc-focus-visible-outline-offset-1 pdc-focus-visible-outline-var-c-focus", children: _jsx(Trash2, { size: 14, "aria-hidden": "true" }) }))] })] })] })] })] }, m.id));
                            }) })] })) }), _jsxs("div", { ...zoneProps, className: [
                    'pdc-relative pdc-border-t pdc-border-line-soft pdc-p-2-5 pdc-transition-colors',
                    isZoneDragOver ? 'pdc-bg-brand-50' : '',
                ].join(' '), children: [typingUsers.length > 0 && (_jsx("div", { className: "pdc-mb-1-5 pdc-text-14px pdc-italic pdc-text-ink-mute pdc-sm-text-12px", "aria-live": "polite", children: typingLabel(typingUsers) })), mentionQuery !== null && filtered.length > 0 && (_jsx("div", { className: "pdc-absolute pdc-inset-x-2-5 pdc-bottom-full pdc-z-10 pdc-mb-1 pdc-max-h-52 pdc-overflow-y-auto pdc-rounded-10px pdc-border pdc-border-line pdc-bg-surface pdc-shadow-lg", children: filtered.map((m, i) => (_jsxs("button", { type: "button", 
                            // onMouseDown (not onClick) so selecting doesn't blur the textarea first.
                            onMouseDown: (e) => {
                                e.preventDefault();
                                selectMention(m);
                            }, onMouseEnter: () => setMentionIndex(i), className: [
                                'pdc-flex pdc-w-full pdc-items-center pdc-gap-2 pdc-px-3 pdc-py-2 pdc-text-left pdc-text-15px pdc-sm-text-13px',
                                i === mentionIndex ? 'pdc-bg-canvas' : 'pdc-hover-bg-canvas',
                            ].join(' '), children: [m.avatarUrl ? (_jsx("img", { src: m.avatarUrl, alt: "", className: "pdc-h-8 pdc-w-8 pdc-rounded-full pdc-object-cover pdc-sm-h-6 pdc-sm-w-6", "aria-hidden": "true" })) : (_jsx("span", { className: "pdc-inline-flex pdc-h-8 pdc-w-8 pdc-items-center pdc-justify-center pdc-rounded-full pdc-font-mono pdc-text-11px pdc-font-medium pdc-text-white pdc-sm-h-6 pdc-sm-w-6 pdc-sm-text-9px", style: { backgroundColor: authorBadgeColour(m.colour) }, "aria-hidden": "true", children: (m.initials ?? '?').slice(0, 2) })), _jsx("span", { className: "pdc-font-medium pdc-text-ink", children: m.name ?? 'Someone' })] }, m.id))) })), attachments.length > 0 && (_jsx("div", { className: "pdc-mb-2 pdc-flex pdc-flex-wrap pdc-gap-2", children: attachments.map((a) => {
                            const Icon = fileKindIcon(a.name, a.type);
                            const meta = [kindLabel(a.name, a.type), formatBytes(a.blob.size)]
                                .filter(Boolean)
                                .join(' · ');
                            return (_jsxs("div", { className: [
                                    'pdc-relative pdc-overflow-hidden pdc-rounded-lg pdc-border pdc-border-line',
                                    isImageType(a.type)
                                        ? 'pdc-h-14 pdc-w-14'
                                        : 'pdc-flex pdc-h-14 pdc-max-w-180px pdc-items-center pdc-gap-2 pdc-bg-canvas pdc-pl-2 pdc-pr-6',
                                ].join(' '), children: [isImageType(a.type) ? (_jsx("img", { src: a.url, alt: "", className: "pdc-h-full pdc-w-full pdc-object-cover" })) : (_jsxs(_Fragment, { children: [_jsx(Icon, { size: 18, "aria-hidden": "true", className: "pdc-flex-shrink-0 pdc-text-ink-mute" }), _jsxs("span", { className: "pdc-min-w-0", children: [_jsx("span", { className: "pdc-block pdc-truncate pdc-text-12px pdc-font-medium pdc-text-ink pdc-sm-text-11px", children: a.name }), meta && _jsx("span", { className: "pdc-block pdc-text-11px pdc-text-ink-mute pdc-sm-text-10px", children: meta })] })] })), _jsx("button", { type: "button", onClick: () => removeAttachment(a.id), "aria-label": "Remove attachment", className: "pdc-absolute pdc-right-0-5 pdc-top-0-5 pdc-rounded-full pdc-bg-black-55 pdc-p-0-5 pdc-text-white pdc-hover-bg-black-75", children: _jsx(X, { size: 11, "aria-hidden": "true" }) })] }, a.id));
                        }) })), error && (_jsx("p", { role: "alert", className: "pdc-mb-2 pdc-rounded-lg pdc-bg-out-soft pdc-px-3 pdc-py-1-5 pdc-text-12px pdc-text-out", children: error })), _jsxs("div", { className: "pdc-flex pdc-items-end pdc-gap-2", children: [_jsx("button", { type: "button", onClick: () => fileRef.current?.click(), disabled: attachments.length >= MAX_ATTACHMENTS, "aria-label": "Attach a file", title: "Attach a file", className: "pdc-inline-flex pdc-h-42px pdc-w-42px pdc-flex-shrink-0 pdc-items-center pdc-justify-center pdc-rounded-8px pdc-border pdc-border-line pdc-bg-surface pdc-text-ink-soft pdc-transition-colors pdc-hover-bg-canvas pdc-disabled-opacity-40", children: _jsx(Paperclip, { size: 18, "aria-hidden": "true" }) }), _jsx("textarea", { ref: textareaRef, value: draft, onChange: onDraftChange, onKeyDown: onKeyDown, onPaste: handlePaste, rows: variant === 'page' || variant === 'popout' ? 2 : 1, placeholder: activePeer ? `Message ${firstName(activePeer.name)}…` : 'Message the team…', className: "pd-chat__composer-input pdc-flex-1" }), _jsx("button", { type: "button", onClick: () => void handleSend(), disabled: (!draft.trim() && attachments.length === 0) || sending, "aria-label": "Send message", className: "pdc-inline-flex pdc-h-42px pdc-w-42px pdc-flex-shrink-0 pdc-items-center pdc-justify-center pdc-rounded-8px pdc-bg-ink pdc-text-on-ink pdc-transition-colors pdc-hover-bg-ink-soft pdc-disabled-opacity-40", children: _jsx(Send, { size: 18, "aria-hidden": "true" }) })] }), _jsx("input", { ref: fileRef, type: "file", multiple: true, className: "pdc-sr-only", tabIndex: -1, "aria-hidden": true, onChange: (e) => {
                            addFiles(Array.from(e.target.files ?? []));
                            e.target.value = '';
                        } }), _jsx("p", { className: "pdc-mt-1-5 pdc-text-13px pdc-text-ink-dim pdc-sm-text-11px", children: activePeer
                            ? `Private to ${firstName(activePeer.name)} · paste or drop any file (up to ${MAX_MB} MB) · Enter to send`
                            : `@ to mention · paste or drop any file (up to ${MAX_MB} MB) · Enter to send · Shift + Enter for a new line` })] })] }));
}
//# sourceMappingURL=TeamChatPanel.js.map