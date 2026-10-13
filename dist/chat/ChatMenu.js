import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useRef, useState } from 'react';
import { MessagesSquare, X, Pin, ExternalLink, PanelRight, PictureInPicture2 } from './icons.js';
import { useTeamChat } from './store.js';
import TeamChatPanel from './TeamChatPanel.js';
import { CHAT_DOCK_ID } from './types.js';
import { peekBody, peekTitle } from './peek.js';
// Wide enough that the conversation chips (Team + four names, with an unread
// badge or two) fit on one line out of the box.
const MIN_W = 320;
const MIN_H = 300;
/** The dropdown's own storage keys, namespaced per app.
 *
 *  Both are genuinely per-window furniture rather than preferences: a
 *  dropdown sized for a 27-inch monitor has no business travelling to a
 *  laptop, and "reopen after minimising" is answering a question about THIS
 *  tab. That is why they stay in browser storage while sound, pinned and the
 *  open conversation moved to the database. */
export function reopenKey(prefix) {
    return `${prefix}-reopen`;
}
// The desktop header chat control: the same shape as a nav item in the
// chrome, with an unread count, that opens the shared chat panel as a
// dropdown. "Keep open across pages" (in the panel's ⋯ menu) makes it stay put
// across pages and reloads; unpinned it is a transient popover that closes on
// outside-click / navigation. Desktop only — mobile uses the full /chat page
// via the Chat tab.
function useIsDesktop() {
    const [isDesktop, setIsDesktop] = useState(() => typeof window !== 'undefined' ? window.matchMedia('(min-width: 768px)').matches : true);
    useEffect(() => {
        const mql = window.matchMedia('(min-width: 768px)');
        const onChange = () => setIsDesktop(mql.matches);
        mql.addEventListener('change', onChange);
        return () => mql.removeEventListener('change', onChange);
    }, []);
    return isDesktop;
}
// lg breakpoint (1024px) — where the dashboard right rail (and thus the chat
// dock) exists. Docking is only offered at this width.
function useIsLarge() {
    const [isLarge, setIsLarge] = useState(() => typeof window !== 'undefined' ? window.matchMedia('(min-width: 1024px)').matches : true);
    useEffect(() => {
        const mql = window.matchMedia('(min-width: 1024px)');
        const onChange = () => setIsLarge(mql.matches);
        mql.addEventListener('change', onChange);
        return () => mql.removeEventListener('change', onChange);
    }, []);
    return isLarge;
}
export default function ChatMenu({ active = false, dockAvailable = false, linkComponent, }) {
    const { config, unread, mentionUnread, dmUnread, dropdownPinned, setDropdownPinned, placement, setPlacement, openPopout, closePopout, focusPopout, chatSize, setChatSize, peek, dismissPeek, holdPeek, alertLevel, setActiveThread, } = useTeamChat();
    const prefix = config?.storagePrefix ?? 'plasma:chat';
    const fullPagePath = config?.fullPagePath ?? '/chat';
    const popoutEnabled = config?.popoutEnabled ?? true;
    // The resize listeners are bound once per drag, so they reach the latest
    // setter through a ref rather than re-subscribing on every render.
    const setChatSizeRef = useRef(setChatSize);
    setChatSizeRef.current = setChatSize;
    const isDesktop = useIsDesktop();
    const isLarge = useIsLarge();
    const onDashboard = dockAvailable;
    // When the docked panel is showing (dashboard rail, lg+), the header control
    // shouldn't open a redundant floating copy, and "Dock to the dashboard" is
    // only offered while chat is still floating.
    const dockVisible = placement === 'docked' && onDashboard && isLarge;
    const canDock = placement === 'floating' && onDashboard && isLarge;
    // Chat is living in a window of its own. The dropdown stays shut — a second
    // copy of the same conversation in the header would be baffling — and the
    // header control becomes the way back to that window.
    const poppedOut = placement === 'popout';
    // Seed open from the pinned preference so a pinned panel is already open on
    // every page (no closed→open flicker as this remounts on navigation). Never
    // auto-open on the /chat page itself, nor when chat is showing elsewhere.
    const [open, setOpen] = useState(() => dropdownPinned && !active && !dockVisible && !poppedOut);
    const ref = useRef(null);
    // User-resizable dropdown. `size` drives the box during a drag; `sizeRef`
    // lets the drag's pointerup commit the latest value without re-subscribing
    // listeners. The COMMITTED size lives in the store, which persists it to
    // this browser and to the person's profile — so resizing in Proofs is the
    // size you get in vCard Studio a moment later.
    const [size, setSize] = useState(chatSize);
    const sizeRef = useRef(size);
    sizeRef.current = size;
    // Adopt a size that arrived from the profile after mount. Skipped mid-drag,
    // or a late read would yank the panel out from under the pointer.
    const draggingRef = useRef(false);
    useEffect(() => {
        if (!draggingRef.current)
            setSize(chatSize);
    }, [chatSize]);
    // Re-open when the full /chat page "minimises" back to the dropdown.
    useEffect(() => {
        try {
            if (sessionStorage.getItem(reopenKey(prefix)) === '1') {
                sessionStorage.removeItem(reopenKey(prefix));
                if (!dockVisible)
                    setOpen(true);
            }
        }
        catch {
            /* sessionStorage unavailable — ignore */
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    // React to chat moving: close the floating dropdown when it goes to the rail
    // or into its own window, and re-open it when it comes back (so it doesn't
    // vanish). Guarded on a real transition so the initial mount forces nothing.
    const prevPlacementRef = useRef(placement);
    useEffect(() => {
        const prev = prevPlacementRef.current;
        prevPlacementRef.current = placement;
        if (prev === placement)
            return;
        if (placement === 'docked' || placement === 'popout')
            setOpen(false);
        else if (prev === 'docked' || prev === 'popout')
            setOpen(true);
    }, [placement]);
    // Outside-click / Escape close — only when NOT pinned. A pinned panel is meant
    // to stay put while you work on other pages.
    useEffect(() => {
        if (!open || dropdownPinned)
            return;
        function onDoc(e) {
            if (ref.current && !ref.current.contains(e.target))
                setOpen(false);
        }
        function onKey(e) {
            if (e.key === 'Escape')
                setOpen(false);
        }
        document.addEventListener('mousedown', onDoc);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDoc);
            document.removeEventListener('keydown', onKey);
        };
    }, [open, dropdownPinned]);
    // ⌘⇧C / Ctrl+Shift+C opens the chat from any page. Deliberately not a bare
    // letter: the hosts have their own palettes and the composer is a textarea.
    useEffect(() => {
        if (!isDesktop)
            return;
        function onKey(e) {
            if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'c' || e.key === 'C')) {
                if (poppedOut || dockVisible || active)
                    return;
                e.preventDefault();
                setOpen((v) => !v);
            }
        }
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [isDesktop, poppedOut, dockVisible, active]);
    // Any direct close also releases the pin, so a "kept open" panel can't linger
    // closed on this page yet reappear on the next.
    function close() {
        setOpen(false);
        if (dropdownPinned)
            setDropdownPinned(false);
    }
    // Drag the bottom-left corner to resize. The panel is anchored top-right, so
    // width grows leftward (right edge pinned) and height grows downward. We
    // capture the pointer to the handle so every move/up — finger or mouse — is
    // delivered here even once it leaves the little grip; paired with
    // touch-action:none on the button so iPad Safari doesn't claim the drag as a
    // page scroll. The final size is saved on release (sizeRef holds the latest
    // committed value).
    function onResizeStart(e) {
        e.preventDefault();
        const handle = e.currentTarget;
        const pointerId = e.pointerId;
        const startX = e.clientX;
        const startY = e.clientY;
        draggingRef.current = true;
        const startW = sizeRef.current.w;
        const startH = sizeRef.current.h;
        const maxW = Math.min(760, window.innerWidth - 16);
        const maxH = window.innerHeight - 96;
        try {
            handle.setPointerCapture(pointerId);
        }
        catch {
            /* pointer capture unsupported — the listeners below still run */
        }
        function onMove(ev) {
            const w = Math.min(maxW, Math.max(MIN_W, startW - (ev.clientX - startX)));
            const h = Math.min(maxH, Math.max(MIN_H, startH + (ev.clientY - startY)));
            // The ref is set here as well as during render: pointerup can arrive
            // before React has flushed the render this schedules, and the release
            // would then save the size from one move ago.
            sizeRef.current = { w, h };
            setSize({ w, h });
        }
        function onEnd() {
            handle.removeEventListener('pointermove', onMove);
            handle.removeEventListener('pointerup', onEnd);
            handle.removeEventListener('pointercancel', onEnd);
            draggingRef.current = false;
            setChatSizeRef.current(sizeRef.current);
        }
        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', onEnd);
        handle.addEventListener('pointercancel', onEnd);
    }
    // Opening the panel answers the card, so retire it rather than leaving it in
    // state to reappear for the tail of its dwell when the panel closes again.
    // Desktop only, as it was when this sat below the early return: on a phone
    // the menu draws nothing, so a pinned `open` there answers no card.
    useEffect(() => {
        if (open && isDesktop)
            dismissPeek();
    }, [open, isDesktop, dismissPeek]);
    // Popped out counts as "chat is on" even though nothing is showing here.
    const current = open || active || poppedOut;
    const hasUnread = unread > 0;
    // DMs are personal, so they get the same loud treatment as @mentions.
    const hasMention = mentionUnread > 0 || dmUnread > 0;
    // Pulse the control when the personal count GOES UP, not merely while it is
    // above zero. Keyed off the rise so a second message pulses again instead
    // of being swallowed by the first one's animation, and so returning to a
    // page with old unread does not replay an alert about nothing new.
    const personal = mentionUnread + dmUnread;
    const [pulsing, setPulsing] = useState(false);
    const lastPersonal = useRef(personal);
    useEffect(() => {
        const rose = personal > lastPersonal.current;
        lastPersonal.current = personal;
        if (!rose)
            return;
        // Off first, so an animation already running is torn down and restarted
        // rather than left mid-cycle. Two frames: one to apply the removal, one
        // for the browser to notice it before the class comes back.
        setPulsing(false);
        let second = 0;
        const first = requestAnimationFrame(() => {
            second = requestAnimationFrame(() => setPulsing(true));
        });
        // Matches the three one-second beats in the stylesheet. Clearing the class
        // afterwards is what lets the next message start it again.
        const done = window.setTimeout(() => setPulsing(false), 3200);
        return () => {
            cancelAnimationFrame(first);
            cancelAnimationFrame(second);
            window.clearTimeout(done);
        };
    }, [personal]);
    // ⚠ After every hook, never above one. Rotating a phone from portrait to
    // landscape crosses 768px, and an early return placed among the hooks made
    // the landscape render call more hooks than the portrait one, which React
    // refuses (error #310, "Rendered more hooks than during the previous
    // render"): the whole page fell over on every app that mounts this menu.
    if (!isDesktop)
        return null;
    // Where chat lives, for the panel's ⋯ menu. Every one of these used to be
    // its own icon in the dropdown's header; they are one kind of decision.
    const placementItems = [
        {
            key: 'page',
            label: 'Open the chat page',
            icon: _jsx(ExternalLink, { size: 15, "aria-hidden": "true" }),
            to: fullPagePath,
            onSelect: () => setOpen(false),
        },
        ...(canDock
            ? [
                {
                    key: 'dock',
                    label: 'Dock to the dashboard',
                    icon: _jsx(PanelRight, { size: 15, "aria-hidden": "true" }),
                    onSelect: () => {
                        setPlacement('docked');
                        setDropdownPinned(false);
                        setOpen(false);
                    },
                },
            ]
            : []),
        // Only offered where the host has a chat route to pop out TO. Without a
        // route the second-window fallback would open onto a 404, which is worse
        // than not offering it.
        ...(popoutEnabled
            ? [
                {
                    key: 'popout',
                    label: 'Pop out into a window',
                    icon: _jsx(PictureInPicture2, { size: 15, "aria-hidden": "true" }),
                    onSelect: () => {
                        openPopout();
                        setDropdownPinned(false);
                        setOpen(false);
                    },
                },
            ]
            : []),
        {
            key: 'pin',
            label: 'Keep open across pages',
            icon: _jsx(Pin, { size: 15, "aria-hidden": "true" }),
            checked: dropdownPinned,
            onSelect: () => setDropdownPinned(!dropdownPinned),
        },
    ];
    return (_jsxs("div", { ref: ref, className: "pd-chat pdc-relative", children: [_jsxs("button", { type: "button", onClick: () => {
                    if (poppedOut) {
                        // Bring the chat window to the front. If it can't be reached —
                        // closed by the operating system, or gone since this window
                        // reloaded — put chat back in the app rather than leave a button
                        // that appears to do nothing.
                        if (!focusPopout())
                            closePopout();
                        return;
                    }
                    if (dockVisible) {
                        // Chat already lives in the dashboard rail as a sticky card that
                        // stays in view while the list scrolls, so there is nothing to
                        // reveal — just drop the cursor into its composer. We deliberately
                        // do NOT scrollIntoView: the dock sits inside a position:sticky
                        // wrapper, so aligning its top to the viewport can never settle —
                        // the sticky re-pins the card every call, leaving the goal unmet,
                        // so each click nudged the page a little further down.
                        // preventScroll keeps the focus itself from scrolling too.
                        document
                            .querySelector(`#${CHAT_DOCK_ID} textarea`)
                            ?.focus({ preventScroll: true });
                        return;
                    }
                    open ? close() : setOpen(true);
                }, "aria-label": [
                    dmUnread > 0
                        ? `Team chat — ${unread} new, including a private message for you`
                        : hasMention
                            ? `Team chat — ${unread} new, you were mentioned`
                            : hasUnread
                                ? `Team chat — ${unread} new`
                                : 'Team chat',
                    poppedOut ? '(open in its own window)' : '',
                ]
                    .filter(Boolean)
                    .join(' '), "aria-haspopup": "dialog", "aria-expanded": open && !poppedOut, title: poppedOut ? 'Chat is in its own window — click to bring it forward' : 'Team chat (⌘⇧C)', className: [
                    'pd-chat__pill',
                    current ? 'pd-chat__pill--on' : '',
                    pulsing ? 'pd-chat__pill--attention' : '',
                ]
                    .filter(Boolean)
                    .join(' '), children: [poppedOut ? (_jsx(PictureInPicture2, { size: 16, "aria-hidden": "true" })) : (_jsx(MessagesSquare, { size: 16, "aria-hidden": "true" })), _jsx("span", { className: "pd-chat__pill-label", children: "Chat" }), hasUnread && (_jsx("span", { className: ['pd-chat__pill-count', hasMention ? 'pd-chat__pill-count--personal' : ''].filter(Boolean).join(' '), "aria-hidden": "true", children: unread > 9 ? '9+' : unread }))] }), peek && !open && !poppedOut && (_jsxs("div", { className: ['pd-chat__peek', peek.personal ? 'pd-chat__peek--personal' : ''].filter(Boolean).join(' '), 
                // Announced politely rather than assertively: this arrives while
                // someone is working, and a card about a room message has no
                // business interrupting a screen reader mid-sentence.
                role: "status", "aria-live": "polite", onMouseEnter: () => holdPeek(true), onMouseLeave: () => holdPeek(false), 
                // Keyboard focus holds it too, or tabbing to the card would be a
                // race against its own dwell.
                onFocus: () => holdPeek(true), onBlur: () => holdPeek(false), children: [_jsx("button", { type: "button", className: "pd-chat__peek-open", onClick: () => {
                            setActiveThread(peek.thread);
                            dismissPeek();
                            // The dock case cannot arrive here (a visible dock means the
                            // panel is mounted and reading, which is what stops the card
                            // being raised at all), but if it ever does, dropping the cursor
                            // into the composer is the right answer rather than opening a
                            // second copy of the panel over the top of it.
                            if (dockVisible) {
                                document
                                    .querySelector(`#${CHAT_DOCK_ID} textarea`)
                                    ?.focus({ preventScroll: true });
                                return;
                            }
                            setOpen(true);
                        }, children: _jsxs("span", { className: "pd-chat__peek-text", children: [_jsxs("span", { className: "pd-chat__peek-who", children: [peekTitle(peek), _jsx("span", { className: "pd-chat__peek-where", children: peek.thread === 'team' ? 'in Team' : 'to you' })] }), peekBody(alertLevel, peek.snippet) && (_jsx("span", { className: "pd-chat__peek-what", children: peekBody(alertLevel, peek.snippet) }))] }) }), _jsx("button", { type: "button", className: "pd-chat__peek-dismiss", "aria-label": "Dismiss", onClick: dismissPeek, children: _jsx(X, { size: 14, "aria-hidden": "true" }) })] })), open && !poppedOut && (_jsxs("div", { role: "dialog", "aria-label": "Team chat", className: "pd-chat__dropdown", style: {
                    width: size.w,
                    height: size.h,
                    maxWidth: 'calc(100vw - 1rem)',
                    maxHeight: 'calc(100vh - 6rem)',
                }, children: [_jsx("div", { className: "pdc-min-h-0 pdc-flex-1", children: _jsx(TeamChatPanel, { variant: "dropdown", placementItems: placementItems, linkComponent: linkComponent, headerAction: _jsx("button", { type: "button", onClick: close, "aria-label": "Close chat", title: "Close (Esc)", className: "pd-chat__ib", children: _jsx(X, { size: 16, "aria-hidden": "true" }) }) }) }), _jsx("button", { type: "button", onPointerDown: onResizeStart, "aria-label": "Resize chat window", title: "Drag to resize", className: "pd-chat__resize", children: _jsx("svg", { width: "11", height: "11", viewBox: "0 0 11 11", fill: "none", stroke: "currentColor", strokeWidth: "1.25", strokeLinecap: "round", "aria-hidden": "true", children: _jsx("path", { d: "M1 1 L10 10 M1 5 L6 10 M1 9 L2 10" }) }) })] }))] }));
}
//# sourceMappingURL=ChatMenu.js.map