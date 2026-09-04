import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { createPortal } from 'react-dom';
import { CornerUpLeft } from './icons.js';
import { useTeamChat } from './store.js';
import TeamChatPanel from './TeamChatPanel.js';
// Draws the chat panel inside the picture-in-picture window, when that is the
// route in use (Chrome / Edge). Mounted once, alongside the routes.
//
// The portal is the point: the panel stays in the SAME React tree, so this is
// still one store on one realtime connection — one unread count, one set of
// sounds, nothing to keep in step. The window is only where it's drawn.
//
// The second-window route renders nothing here. That window is a separate copy
// of the app and draws its own /chat page (see ChatPage's popout shell).
export default function ChatPopoutHost() {
    const { popoutWindow, closePopout } = useTeamChat();
    if (!popoutWindow)
        return null;
    return createPortal(_jsxs("div", { className: "pd-chat pd-chat--popout pdc-bg-surface pdc-text-ink", children: [_jsxs("div", { className: "pdc-flex pdc-flex-shrink-0 pdc-items-center pdc-justify-between pdc-gap-2 pdc-border-b pdc-border-line-soft pdc-px-3 pdc-py-2", children: [_jsx("span", { className: "pdc-text-13px pdc-font-semibold pdc-text-ink", children: "Team chat" }), _jsxs("button", { type: "button", onClick: closePopout, title: "Close this window and put chat back in the app", className: "pdc-inline-flex pdc-h-7 pdc-items-center pdc-gap-1-5 pdc-rounded-full pdc-px-2-5 pdc-text-12px pdc-font-semibold pdc-text-ink-mute pdc-transition-colors pdc-hover-bg-canvas pdc-hover-text-ink", children: [_jsx(CornerUpLeft, { size: 14, "aria-hidden": "true" }), "Back in app"] })] }), _jsx("div", { className: "pdc-min-h-0 pdc-flex-1", children: _jsx(TeamChatPanel, { variant: "popout" }) })] }), popoutWindow.document.body);
}
//# sourceMappingURL=ChatPopoutHost.js.map