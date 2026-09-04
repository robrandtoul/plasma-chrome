import { createPortal } from 'react-dom'
import { CornerUpLeft } from './icons'
import { useTeamChat } from './store'
import TeamChatPanel from './TeamChatPanel'

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
  const { popoutWindow, closePopout } = useTeamChat()
  if (!popoutWindow) return null

  return createPortal(
    <div className="pd-chat pd-chat--popout pdc-bg-surface pdc-text-ink">
      <div className="pdc-flex pdc-flex-shrink-0 pdc-items-center pdc-justify-between pdc-gap-2 pdc-border-b pdc-border-line-soft pdc-px-3 pdc-py-2">
        <span className="pdc-text-13px pdc-font-semibold pdc-text-ink">Team chat</span>
        <button
          type="button"
          onClick={closePopout}
          title="Close this window and put chat back in the app"
          className="pdc-inline-flex pdc-h-7 pdc-items-center pdc-gap-1-5 pdc-rounded-full pdc-px-2-5 pdc-text-12px pdc-font-semibold pdc-text-ink-mute pdc-transition-colors pdc-hover-bg-canvas pdc-hover-text-ink"
        >
          <CornerUpLeft size={14} aria-hidden="true" />
          Back in app
        </button>
      </div>
      <div className="pdc-min-h-0 pdc-flex-1">
        <TeamChatPanel variant="popout" />
      </div>
    </div>,
    popoutWindow.document.body,
  )
}
