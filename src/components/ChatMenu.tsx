import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { MessagesSquare, Maximize2, X } from 'lucide-react'
import { useTeamChat } from '../lib/teamChatStore'
import TeamChatPanel from './TeamChatPanel'

// The desktop header chat control: the speech-bubble icon + unread badge that
// opens the shared chat panel as a dropdown, so you can glance and reply without
// leaving the page. Mobile keeps the full /chat page via the account sheet.
// Opening the dropdown mounts TeamChatPanel, which marks the chat seen (clearing
// the badge) for as long as it's open.

export default function ChatMenu({ active = false }: { active?: boolean }) {
  const { unread } = useTeamChat()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const highlighted = open || active

  return (
    <div ref={ref} className="relative hidden md:block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={unread > 0 ? `Team chat — ${unread} new` : 'Team chat'}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Team chat"
        className={[
          'relative flex h-9 w-9 items-center justify-center rounded-full transition-colors',
          highlighted
            ? 'text-ink bg-canvas border border-line'
            : 'text-ink-mute hover:text-ink hover:bg-canvas',
        ].join(' ')}
      >
        <MessagesSquare size={18} aria-hidden="true" />
        {unread > 0 && (
          <span
            className="absolute -right-1 -top-1 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-brand px-1 text-[10px] font-semibold leading-none text-white"
            style={{ boxShadow: '0 0 0 2px var(--c-surface)' }}
            aria-hidden="true"
          >
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Team chat"
          className="absolute right-0 top-11 z-40 flex h-[460px] max-h-[calc(100vh-6rem)] w-[380px] max-w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-[14px] border border-line bg-surface shadow-xl"
        >
          <div className="flex flex-shrink-0 items-center justify-between border-b border-line-soft px-3 py-2">
            <span className="text-[13px] font-semibold text-ink">Team chat</span>
            <div className="flex items-center gap-0.5">
              <Link
                to="/chat"
                onClick={() => setOpen(false)}
                aria-label="Open full chat page"
                title="Open full page"
                className="flex h-7 w-7 items-center justify-center rounded-full text-ink-mute transition-colors hover:bg-canvas hover:text-ink"
              >
                <Maximize2 size={15} aria-hidden="true" />
              </Link>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close chat"
                className="flex h-7 w-7 items-center justify-center rounded-full text-ink-mute transition-colors hover:bg-canvas hover:text-ink"
              >
                <X size={16} aria-hidden="true" />
              </button>
            </div>
          </div>
          <div className="min-h-0 flex-1">
            <TeamChatPanel variant="dropdown" />
          </div>
        </div>
      )}
    </div>
  )
}
