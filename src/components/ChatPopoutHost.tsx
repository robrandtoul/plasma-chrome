import { createPortal } from 'react-dom'
import { CornerUpLeft } from 'lucide-react'
import { useTeamChat } from '../lib/teamChatStore'
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
    <div className="flex h-full flex-col bg-surface text-ink">
      <div className="flex flex-shrink-0 items-center justify-between gap-2 border-b border-line-soft px-3 py-2">
        <span className="text-[13px] font-semibold text-ink">Team chat</span>
        <button
          type="button"
          onClick={closePopout}
          title="Close this window and put chat back in the app"
          className="inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-semibold text-ink-mute transition-colors hover:bg-canvas hover:text-ink"
        >
          <CornerUpLeft size={14} aria-hidden="true" />
          Back in app
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <TeamChatPanel variant="popout" />
      </div>
    </div>,
    popoutWindow.document.body,
  )
}
