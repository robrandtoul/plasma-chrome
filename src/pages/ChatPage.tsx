import { useNavigate } from 'react-router-dom'
import { MessagesSquare, Minimize2 } from 'lucide-react'
import DesignerChrome from '../design/DesignerChrome'
import { ButtonGhost } from '../design'
import TeamChatPanel from '../components/TeamChatPanel'

// The full-page team chat. A thin shell around the shared TeamChatPanel (the
// same body the header dropdown uses) — all the state lives in the
// TeamChatProvider, so this page and the dropdown stay in lockstep. This is the
// primary chat surface on mobile (the dropdown is desktop-only).

export default function ChatPage() {
  const navigate = useNavigate()

  // "Minimise" returns you to where you came from and, on desktop, re-opens the
  // compact dropdown there (ChatMenu consumes the flag on mount). Falls back to
  // the dashboard when there's no in-app history to go back to (direct link).
  function minimise() {
    try {
      if (window.matchMedia('(min-width: 768px)').matches) {
        sessionStorage.setItem('pv:reopen-chat', '1')
      }
    } catch {
      /* sessionStorage / matchMedia unavailable — just navigate */
    }
    const idx =
      window.history.state && typeof window.history.state.idx === 'number'
        ? window.history.state.idx
        : 0
    if (idx > 0) navigate(-1)
    else navigate('/')
  }

  return (
    <DesignerChrome active="chat">
      <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
        <div className="flex h-[calc(100dvh-8rem)] flex-col overflow-hidden rounded-[14px] border border-line bg-surface max-md:h-[calc(100dvh-12rem)]">
          <div className="flex flex-shrink-0 items-center justify-between gap-2.5 border-b border-line-soft px-4 py-3">
            <div className="flex items-center gap-2.5">
              <MessagesSquare size={18} className="text-ink-mute" aria-hidden="true" />
              <div>
                <h1 className="text-[17px] font-semibold leading-none text-ink sm:text-[15px]">Team chat</h1>
                <p className="mt-1 text-[13px] text-ink-mute sm:text-[12px]">A shared channel for the team.</p>
              </div>
            </div>
            {/* Desktop-only: "minimise back to the dropdown" means nothing on
                a phone, where this page IS the chat and the tab bar is the way
                out. */}
            <ButtonGhost size="sm" icon={Minimize2} onClick={minimise} className="max-md:hidden">
              Minimise
            </ButtonGhost>
          </div>
          <div className="min-h-0 flex-1">
            <TeamChatPanel variant="page" />
          </div>
        </div>
      </div>
    </DesignerChrome>
  )
}
