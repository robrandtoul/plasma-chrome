import { MessagesSquare } from 'lucide-react'
import DesignerChrome from '../design/DesignerChrome'
import TeamChatPanel from '../components/TeamChatPanel'

// The full-page team chat. A thin shell around the shared TeamChatPanel (the
// same body the header dropdown uses) — all the state lives in the
// TeamChatProvider, so this page and the dropdown stay in lockstep. This is the
// primary chat surface on mobile (the dropdown is desktop-only).

export default function ChatPage() {
  return (
    <DesignerChrome active="chat">
      <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
        <div className="flex h-[calc(100dvh-8rem)] flex-col overflow-hidden rounded-[14px] border border-line bg-surface max-md:h-[calc(100dvh-12rem)]">
          <div className="flex flex-shrink-0 items-center gap-2.5 border-b border-line-soft px-4 py-3">
            <MessagesSquare size={18} className="text-ink-mute" aria-hidden="true" />
            <div>
              <h1 className="text-[15px] font-semibold leading-none text-ink">Team chat</h1>
              <p className="mt-1 text-[12px] text-ink-mute">A shared channel for the team.</p>
            </div>
          </div>
          <div className="min-h-0 flex-1">
            <TeamChatPanel variant="page" />
          </div>
        </div>
      </div>
    </DesignerChrome>
  )
}
