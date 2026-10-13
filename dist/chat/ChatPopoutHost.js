import { jsx as _jsx } from "react/jsx-runtime";
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
    return createPortal(_jsx("div", { className: "pd-chat pd-chat--popout", children: _jsx(TeamChatPanel, { variant: "popout", headerAction: _jsx("button", { type: "button", onClick: closePopout, "aria-label": "Close this window and put chat back in the app", title: "Back in the app", className: "pd-chat__ib", children: _jsx(CornerUpLeft, { size: 16, "aria-hidden": "true" }) }) }) }), popoutWindow.document.body);
}
//# sourceMappingURL=ChatPopoutHost.js.map