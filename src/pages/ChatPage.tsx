import { useNavigate } from 'react-router-dom'
import { MessagesSquare, Minimize2 } from 'lucide-react'
import DesignerChrome from '../design/DesignerChrome'
import { ButtonGhost } from '../design'
import TeamChatPanel from '../components/TeamChatPanel'
import { useTeamChat } from '../lib/teamChatStore'

// The full-page team chat. A thin shell around the shared TeamChatPanel (the
// same body the header dropdown uses) — all the state lives in the
// TeamChatProvider, so this page and the dropdown stay in lockstep. This is the
// primary chat surface on mobile (the dropdown is desktop-only).

export default function ChatPage() {
  const navigate = useNavigate()
  const { activeThread, members } = useTeamChat()
  // The open thread's peer, so the header describes what you're actually
  // looking at instead of always claiming the shared channel.
  const peer = activeThread === 'team' ? null : members.find((m) => m.id === activeThread) ?? null
  const peerFirstName = (peer?.name ?? '').trim().split(/\s+/)[0] || 'a teammate'

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
        {/* Mobile height must clear the REAL chrome: header + page padding +
            the fixed 64px tab bar, plus BOTH safe-area insets (notch above,
            home indicator below) — a flat guess left the composer sliced off
            behind the tab bar on iPhone. Underscores keep the calc spaces
            Tailwind needs. */}
        <div className="flex h-[calc(100dvh-8rem)] flex-col overflow-hidden rounded-[14px] border border-line bg-surface max-md:h-[calc(100dvh_-_12rem_-_env(safe-area-inset-top)_-_env(safe-area-inset-bottom))]">
          {/* Desktop-only header: on a phone the Chat tab + thread pills
              already say where you are, and "Team chat / a shared channel"
              was plain wrong over a private thread — so the whole row hides
              below md and describes the open thread above it. */}
          <div className="flex flex-shrink-0 items-center justify-between gap-2.5 border-b border-line-soft px-4 py-3 max-md:hidden">
            <div className="flex items-center gap-2.5">
              <MessagesSquare size={18} className="text-ink-mute" aria-hidden="true" />
              <div>
                <h1 className="text-[15px] font-semibold leading-none text-ink">
                  {peer ? peerFirstName : 'Team chat'}
                </h1>
                <p className="mt-1 text-[12px] text-ink-mute">
                  {peer
                    ? `A private conversation — only the two of you can see it.`
                    : 'A shared channel for the team.'}
                </p>
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
