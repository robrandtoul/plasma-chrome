import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { MessagesSquare, Maximize2, X, Pin, AtSign, PanelRight } from 'lucide-react'
import { useTeamChat } from '../lib/teamChatStore'
import TeamChatPanel from './TeamChatPanel'

const SIZE_KEY = 'pv:chat-size'
const DEFAULT_SIZE = { w: 380, h: 460 }
const MIN_W = 320
const MIN_H = 300

// The dropdown's saved size (per browser). Clamped on read so a stale value
// can't be smaller than the minimum; the render also caps it to the viewport.
function readChatSize(): { w: number; h: number } {
  try {
    const raw = localStorage.getItem(SIZE_KEY)
    if (raw) {
      const p = JSON.parse(raw) as { w?: unknown; h?: unknown }
      if (typeof p.w === 'number' && typeof p.h === 'number') {
        return { w: Math.max(MIN_W, p.w), h: Math.max(MIN_H, p.h) }
      }
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_SIZE
}

// The desktop header chat control: the speech-bubble icon + unread badge that
// opens the shared chat panel as a dropdown. A pin keeps it open across pages
// (and reloads) so you can keep chatting while working elsewhere; unpinned it's
// a transient popover that closes on outside-click / navigation. Desktop only —
// mobile uses the full /chat page via the account sheet.

function useIsDesktop() {
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia('(min-width: 768px)').matches : true,
  )
  useEffect(() => {
    const mql = window.matchMedia('(min-width: 768px)')
    const onChange = () => setIsDesktop(mql.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])
  return isDesktop
}

// lg breakpoint (1024px) — where the dashboard right rail (and thus the chat
// dock) exists. Docking is only offered at this width.
function useIsLarge() {
  const [isLarge, setIsLarge] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia('(min-width: 1024px)').matches : true,
  )
  useEffect(() => {
    const mql = window.matchMedia('(min-width: 1024px)')
    const onChange = () => setIsLarge(mql.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])
  return isLarge
}

export default function ChatMenu({ active = false }: { active?: boolean }) {
  const { unread, mentionUnread, dropdownPinned, setDropdownPinned, placement, setPlacement } =
    useTeamChat()
  const isDesktop = useIsDesktop()
  const isLarge = useIsLarge()
  const location = useLocation()
  const onDashboard = location.pathname === '/'
  // When the docked panel is showing (dashboard rail, lg+), the header icon
  // shouldn't open a redundant floating copy, and "Dock to sidebar" is only
  // offered while chat is still floating.
  const dockVisible = placement === 'docked' && onDashboard && isLarge
  const canDock = placement === 'floating' && onDashboard && isLarge
  // Seed open from the pinned preference so a pinned panel is already open on
  // every page (no closed→open flicker as this remounts on navigation). Never
  // auto-open on the /chat page itself, nor when the docked panel is visible.
  const [open, setOpen] = useState(() => dropdownPinned && !active && !dockVisible)
  const ref = useRef<HTMLDivElement>(null)
  // User-resizable dropdown. `size` drives the box; `sizeRef` lets the drag's
  // pointerup persist the latest size without re-subscribing listeners.
  const [size, setSize] = useState(readChatSize)
  const sizeRef = useRef(size)
  sizeRef.current = size

  // Re-open when the full /chat page "minimises" back to the dropdown.
  useEffect(() => {
    try {
      if (sessionStorage.getItem('pv:reopen-chat') === '1') {
        sessionStorage.removeItem('pv:reopen-chat')
        if (!dockVisible) setOpen(true)
      }
    } catch {
      /* sessionStorage unavailable — ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // React to docking: close the floating dropdown when chat moves to the rail,
  // and re-open it when chat pops back out (so it doesn't vanish). Guarded on a
  // real transition so the initial mount doesn't force anything.
  const prevPlacementRef = useRef(placement)
  useEffect(() => {
    const prev = prevPlacementRef.current
    prevPlacementRef.current = placement
    if (prev === placement) return
    if (placement === 'docked') setOpen(false)
    else if (prev === 'docked') setOpen(true)
  }, [placement])

  // Outside-click / Escape close — only when NOT pinned. A pinned panel is meant
  // to stay put while you work on other pages.
  useEffect(() => {
    if (!open || dropdownPinned) return
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
  }, [open, dropdownPinned])

  if (!isDesktop) return null

  // Any direct close also releases the pin, so a "kept open" panel can't linger
  // closed on this page yet reappear on the next.
  function close() {
    setOpen(false)
    if (dropdownPinned) setDropdownPinned(false)
  }

  // Drag the bottom-left corner to resize. The panel is anchored top-right, so
  // width grows leftward (right edge pinned) and height grows downward. We
  // capture the pointer to the handle so every move/up — finger or mouse — is
  // delivered here even once it leaves the little grip; paired with
  // touch-action:none on the button (below) so iPad Safari doesn't claim the
  // drag as a page scroll. The final size is saved to localStorage on release
  // (sizeRef holds the latest committed value).
  function onResizeStart(e: ReactPointerEvent<HTMLButtonElement>) {
    e.preventDefault()
    const handle = e.currentTarget
    const pointerId = e.pointerId
    const startX = e.clientX
    const startY = e.clientY
    const startW = sizeRef.current.w
    const startH = sizeRef.current.h
    const maxW = Math.min(760, window.innerWidth - 16)
    const maxH = window.innerHeight - 96
    try {
      handle.setPointerCapture(pointerId)
    } catch {
      /* pointer capture unsupported — the listeners below still run */
    }
    function onMove(ev: PointerEvent) {
      const w = Math.min(maxW, Math.max(MIN_W, startW - (ev.clientX - startX)))
      const h = Math.min(maxH, Math.max(MIN_H, startH + (ev.clientY - startY)))
      setSize({ w, h })
    }
    function onEnd() {
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onEnd)
      handle.removeEventListener('pointercancel', onEnd)
      try {
        localStorage.setItem(SIZE_KEY, JSON.stringify(sizeRef.current))
      } catch {
        /* ignore */
      }
    }
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onEnd)
    handle.addEventListener('pointercancel', onEnd)
  }

  const current = open || active
  const hasUnread = unread > 0
  const hasMention = mentionUnread > 0

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => {
          if (dockVisible) {
            document
              .getElementById('team-chat-dock')
              ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            return
          }
          open ? close() : setOpen(true)
        }}
        aria-label={
          hasMention
            ? `Team chat — ${unread} new, you were mentioned`
            : hasUnread
              ? `Team chat — ${unread} new`
              : 'Team chat'
        }
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Team chat"
        className={[
          'relative inline-flex h-9 items-center justify-center rounded-full border text-[13px] font-semibold transition-colors',
          // Icon-only on tablets; grows a "Chat" label at lg+ where there's room.
          'w-9 lg:w-auto lg:justify-start lg:gap-1.5 lg:pl-2.5 lg:pr-3.5',
          current
            ? 'border-line bg-canvas text-ink'
            : hasMention
              ? 'border-[var(--c-brand)] bg-brand-50 text-brand hover:bg-brand-50'
              : hasUnread
                ? 'border-line bg-canvas text-ink hover:bg-canvas'
                : 'border-line bg-surface text-ink-soft hover:bg-canvas hover:text-ink',
        ].join(' ')}
      >
        <MessagesSquare size={17} aria-hidden="true" />
        <span className="hidden lg:inline">Chat</span>
        {hasUnread && (
          <span
            className={[
              'absolute -right-1.5 -top-1.5 inline-flex h-[18px] min-w-[18px] items-center justify-center gap-0.5 rounded-full px-1 text-[10px] font-bold leading-none text-white',
              hasMention ? 'bg-brand' : 'bg-ink',
            ].join(' ')}
            style={{ boxShadow: '0 0 0 2px var(--c-surface)' }}
            aria-hidden="true"
          >
            {hasMention && <AtSign size={10} strokeWidth={2.5} aria-hidden="true" />}
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Team chat"
          className="absolute right-0 top-11 z-40 flex flex-col overflow-hidden rounded-[14px] border border-line bg-surface shadow-xl"
          style={{
            width: size.w,
            height: size.h,
            maxWidth: 'calc(100vw - 1rem)',
            maxHeight: 'calc(100vh - 6rem)',
          }}
        >
          <div className="flex flex-shrink-0 items-center justify-between border-b border-line-soft px-3 py-2">
            <span className="text-[13px] font-semibold text-ink">Team chat</span>
            <div className="flex items-center gap-0.5">
              {canDock && (
                <button
                  type="button"
                  onClick={() => {
                    setPlacement('docked')
                    setDropdownPinned(false)
                    setOpen(false)
                  }}
                  aria-label="Dock chat to the dashboard sidebar"
                  title="Dock to sidebar"
                  className="flex h-7 w-7 items-center justify-center rounded-full text-ink-mute transition-colors hover:bg-canvas hover:text-ink"
                >
                  <PanelRight size={15} aria-hidden="true" />
                </button>
              )}
              <button
                type="button"
                onClick={() => setDropdownPinned(!dropdownPinned)}
                aria-pressed={dropdownPinned}
                aria-label={dropdownPinned ? 'Unpin chat' : 'Keep chat open across pages'}
                title={dropdownPinned ? 'Unpin — stop keeping open' : 'Keep open across pages'}
                className={[
                  'flex h-7 w-7 items-center justify-center rounded-full transition-colors',
                  dropdownPinned
                    ? 'bg-brand-50 text-brand'
                    : 'text-ink-mute hover:bg-canvas hover:text-ink',
                ].join(' ')}
              >
                <Pin size={15} aria-hidden="true" fill={dropdownPinned ? 'currentColor' : 'none'} />
              </button>
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
                onClick={close}
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
          <button
            type="button"
            onPointerDown={onResizeStart}
            aria-label="Resize chat window"
            title="Drag to resize"
            className="absolute bottom-0 left-0 z-10 flex h-[18px] w-[18px] touch-none cursor-nesw-resize items-end justify-start p-1 text-ink-mute/70 transition-colors hover:text-ink"
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 10 10"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M9 2 L2 9 M9 6 L6 9" />
            </svg>
          </button>
        </div>
      )}
    </div>
  )
}
