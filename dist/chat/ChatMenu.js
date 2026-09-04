import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useRef, useState } from 'react';
import { MessagesSquare, Maximize2, X, Pin, AtSign, PanelRight, PictureInPicture2, } from './icons.js';
import { useTeamChat } from './store.js';
import TeamChatPanel from './TeamChatPanel.js';
import { CHAT_DOCK_ID } from './types.js';
// Wide enough that the five thread pills (Team + four names, with an unread
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
// The desktop header chat control: the speech-bubble icon + unread badge that
// opens the shared chat panel as a dropdown. A pin keeps it open across pages
// (and reloads) so you can keep chatting while working elsewhere; unpinned it's
// a transient popover that closes on outside-click / navigation. Desktop only —
// mobile uses the full /chat page via the account sheet.
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
/**
 * One link, rendered through whatever the host uses for navigation.
 *
 * `to` for a router component (react-router's Link, and the ChromeLink each
 * app already wrote for the nav), `href` for the plain anchor fallback. The
 * fallback is a real navigation rather than a no-op, so an app with no router
 * still gets a working "open full page".
 */
function FullPageLink({ as: As, to, ...rest }) {
    if (As)
        return _jsx(As, { to: to, ...rest });
    return _jsx("a", { href: to, ...rest });
}
export default function ChatMenu({ active = false, dockAvailable = false, linkComponent, }) {
    const { config, unread, mentionUnread, dmUnread, dropdownPinned, setDropdownPinned, placement, setPlacement, openPopout, closePopout, focusPopout, chatSize, setChatSize, } = useTeamChat();
    const prefix = config?.storagePrefix ?? 'plasma:chat';
    const fullPagePath = config?.fullPagePath ?? '/chat';
    const popoutEnabled = config?.popoutEnabled ?? true;
    // The resize handler runs off a listener bound once, so it reads the prefix
    // through a ref rather than closing over the render's value.
    const prefixRef = useRef(prefix);
    prefixRef.current = prefix;
    // The resize listeners are bound once per drag, so they reach the latest
    // setter through a ref rather than re-subscribing on every render.
    const setChatSizeRef = useRef(setChatSize);
    setChatSizeRef.current = setChatSize;
    const isDesktop = useIsDesktop();
    const isLarge = useIsLarge();
    const onDashboard = dockAvailable;
    // When the docked panel is showing (dashboard rail, lg+), the header icon
    // shouldn't open a redundant floating copy, and "Dock to sidebar" is only
    // offered while chat is still floating.
    const dockVisible = placement === 'docked' && onDashboard && isLarge;
    const canDock = placement === 'floating' && onDashboard && isLarge;
    // Chat is living in a window of its own. The dropdown stays shut — a second
    // copy of the same conversation in the header would be baffling — and the
    // header button becomes the way back to that window.
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
    if (!isDesktop)
        return null;
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
    // touch-action:none on the button (below) so iPad Safari doesn't claim the
    // drag as a page scroll. The final size is saved to localStorage on release
    // (sizeRef holds the latest committed value).
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
    // Popped out counts as "chat is on" even though nothing is showing here.
    const current = open || active || poppedOut;
    const hasUnread = unread > 0;
    // DMs are personal, so they get the same loud coral treatment as @mentions.
    const hasMention = mentionUnread > 0 || dmUnread > 0;
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
                        // wrapper (top-14), so aligning its top to the viewport can never
                        // settle — the sticky re-pins the card every call, leaving the goal
                        // unmet, so each click nudged the page a little further down.
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
                    .join(' '), "aria-haspopup": "dialog", "aria-expanded": open && !poppedOut, title: poppedOut ? 'Chat is in its own window — click to bring it forward' : 'Team chat', className: [
                    'pdc-relative pdc-inline-flex pdc-h-9 pdc-items-center pdc-justify-center pdc-rounded-full pdc-border pdc-text-13px pdc-font-semibold pdc-transition-colors',
                    // Icon-only on tablets; grows a "Chat" label at lg+ where there's room.
                    'pdc-w-9 pdc-lg-w-auto pdc-lg-justify-start pdc-lg-gap-1-5 pdc-lg-pl-2-5 pdc-lg-pr-3-5',
                    current
                        ? 'pdc-border-line pdc-bg-canvas pdc-text-ink'
                        : hasMention
                            ? 'pdc-border-brand pdc-bg-brand-50 pdc-text-brand pdc-hover-bg-brand-50'
                            : hasUnread
                                ? 'pdc-border-line pdc-bg-canvas pdc-text-ink pdc-hover-bg-canvas'
                                : 'pdc-border-line pdc-bg-surface pdc-text-ink-soft pdc-hover-bg-canvas pdc-hover-text-ink',
                ].join(' '), children: [_jsx(MessagesSquare, { size: 17, "aria-hidden": "true" }), _jsx("span", { className: "pdc-hidden pdc-lg-inline", children: "Chat" }), hasUnread && (_jsxs("span", { className: [
                            'pdc-absolute pdc-neg-right-1-5 pdc-neg-top-1-5 pdc-inline-flex pdc-h-18px pdc-min-w-18px pdc-items-center pdc-justify-center pdc-gap-0-5 pdc-rounded-full pdc-px-1 pdc-text-10px pdc-font-bold pdc-leading-none pdc-text-white',
                            hasMention ? 'pdc-bg-brand' : 'pdc-bg-ink',
                        ].join(' '), style: { boxShadow: '0 0 0 2px var(--c-surface)' }, "aria-hidden": "true", children: [hasMention && _jsx(AtSign, { size: 10, strokeWidth: 2.5, "aria-hidden": "true" }), unread > 9 ? '9+' : unread] }))] }), open && !poppedOut && (_jsxs("div", { role: "dialog", "aria-label": "Team chat", className: "pdc-absolute pdc-right-0 pdc-top-11 pdc-z-40 pdc-flex pdc-flex-col pdc-overflow-hidden pdc-rounded-14px pdc-border pdc-border-line pdc-bg-surface pdc-shadow-xl", style: {
                    width: size.w,
                    height: size.h,
                    maxWidth: 'calc(100vw - 1rem)',
                    maxHeight: 'calc(100vh - 6rem)',
                }, children: [_jsxs("div", { className: "pdc-flex pdc-flex-shrink-0 pdc-items-center pdc-justify-between pdc-border-b pdc-border-line-soft pdc-px-3 pdc-py-2", children: [_jsx("span", { className: "pdc-text-13px pdc-font-semibold pdc-text-ink", children: "Team chat" }), _jsxs("div", { className: "pdc-flex pdc-items-center pdc-gap-0-5", children: [popoutEnabled && (_jsx("button", { type: "button", onClick: () => {
                                            openPopout();
                                            setDropdownPinned(false);
                                            setOpen(false);
                                        }, "aria-label": "Pop chat out into its own window", title: "Pop out into its own window", className: "pdc-flex pdc-h-7 pdc-w-7 pdc-items-center pdc-justify-center pdc-rounded-full pdc-text-ink-mute pdc-transition-colors pdc-hover-bg-canvas pdc-hover-text-ink", children: _jsx(PictureInPicture2, { size: 15, "aria-hidden": "true" }) })), canDock && (_jsx("button", { type: "button", onClick: () => {
                                            setPlacement('docked');
                                            setDropdownPinned(false);
                                            setOpen(false);
                                        }, "aria-label": "Dock chat to the dashboard sidebar", title: "Dock to sidebar", className: "pdc-flex pdc-h-7 pdc-w-7 pdc-items-center pdc-justify-center pdc-rounded-full pdc-text-ink-mute pdc-transition-colors pdc-hover-bg-canvas pdc-hover-text-ink", children: _jsx(PanelRight, { size: 15, "aria-hidden": "true" }) })), _jsx("button", { type: "button", onClick: () => setDropdownPinned(!dropdownPinned), "aria-pressed": dropdownPinned, "aria-label": dropdownPinned ? 'Unpin chat' : 'Keep chat open across pages', title: dropdownPinned ? 'Unpin — stop keeping open' : 'Keep open across pages', className: [
                                            'pdc-flex pdc-h-7 pdc-w-7 pdc-items-center pdc-justify-center pdc-rounded-full pdc-transition-colors',
                                            dropdownPinned
                                                ? 'pdc-bg-brand-50 pdc-text-brand'
                                                : 'pdc-text-ink-mute pdc-hover-bg-canvas pdc-hover-text-ink',
                                        ].join(' '), children: _jsx(Pin, { size: 15, "aria-hidden": "true", fill: dropdownPinned ? 'currentColor' : 'none' }) }), _jsx(FullPageLink, { as: linkComponent, to: fullPagePath, onClick: () => setOpen(false), "aria-label": "Open full chat page", title: "Open full page", className: "pdc-flex pdc-h-7 pdc-w-7 pdc-items-center pdc-justify-center pdc-rounded-full pdc-text-ink-mute pdc-transition-colors pdc-hover-bg-canvas pdc-hover-text-ink", children: _jsx(Maximize2, { size: 15, "aria-hidden": "true" }) }), _jsx("button", { type: "button", onClick: close, "aria-label": "Close chat", className: "pdc-flex pdc-h-7 pdc-w-7 pdc-items-center pdc-justify-center pdc-rounded-full pdc-text-ink-mute pdc-transition-colors pdc-hover-bg-canvas pdc-hover-text-ink", children: _jsx(X, { size: 16, "aria-hidden": "true" }) })] })] }), _jsx("div", { className: "pdc-min-h-0 pdc-flex-1", children: _jsx(TeamChatPanel, { variant: "dropdown" }) }), _jsx("button", { type: "button", onPointerDown: onResizeStart, "aria-label": "Resize chat window", title: "Drag to resize", className: "pdc-absolute pdc-bottom-0 pdc-left-0 pdc-z-10 pdc-flex pdc-h-18px pdc-w-18px pdc-touch-none pdc-cursor-nesw-resize pdc-items-end pdc-justify-start pdc-p-1 pdc-text-ink-mute-70 pdc-transition-colors pdc-hover-text-ink", children: _jsx("svg", { width: "10", height: "10", viewBox: "0 0 10 10", fill: "none", stroke: "currentColor", strokeWidth: "1.3", strokeLinecap: "round", "aria-hidden": "true", children: _jsx("path", { d: "M9 2 L2 9 M9 6 L6 9" }) }) })] }))] }));
}
//# sourceMappingURL=ChatMenu.js.map