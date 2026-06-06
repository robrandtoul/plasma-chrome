import {
  useState,
  useRef,
  useEffect,
  type ChangeEvent,
  type ReactNode,
} from 'react'
import { Link } from 'react-router-dom'
import { Search } from 'lucide-react'
import { PlasmaWordmark } from './PlasmaWordmark'

// Shared chrome for every designer-facing page. Sticky top bar with
// the wordmark on the left, a pill nav strip beside it, an optional
// global search field in the middle/right, optional action slot to
// the left of the user pill, and a user pill with a popover for
// Edit profile + Sign out. Admin nav item is auto-hidden unless
// the caller passes role='admin'.
//
// Lift the search state into the parent — DesignerHeader treats the
// field as a controlled input so the parent can both read the value
// (to drive filtering) and clear it from elsewhere if needed.

export type DesignerNavId = 'proofs' | 'quote' | 'admin'
export type DesignerHeaderColour = 'blue' | 'teal' | 'coral' | 'purple'

interface NavItem {
  id: DesignerNavId
  label: string
  to: string
}

// Customers deliberately omitted here — it lives in the Admin sidebar
// (AdminLayout), which the Admin nav item already leads into. Listing
// it in the top bar too was redundant (the whole admin section
// highlights "Admin" anyway).
const NAV: NavItem[] = [
  { id: 'proofs', label: 'Proofs', to: '/' },
  { id: 'quote',  label: 'Quote',  to: '/quote' },
  { id: 'admin',  label: 'Admin',  to: '/admin/users' },
]

// Map the four legacy designer colours to design-system tokens. The
// older Tailwind palette (sky/teal/orange/violet) is retained for
// the dashboard-row DesignerAvatar component for now; the header
// pill uses these brand-system colours so the chrome matches the
// reskin tokens. Purple has no exact token match — falls back to
// a hand-picked violet that lives only here.
const COLOUR_BG: Record<DesignerHeaderColour, string> = {
  blue:   'var(--c-allocated)',
  teal:   'var(--c-in-stock)',
  coral:  'var(--c-brand)',
  purple: '#7b3ff2',
}

interface SearchProps {
  value: string
  onChange: (next: string) => void
  placeholder?: string
}

interface UserProps {
  initials: string
  colour: DesignerHeaderColour
  avatarUrl?: string | null
  name?: string | null
}

interface DesignerHeaderProps {
  /** Which nav pill is highlighted. Pass null to highlight nothing. */
  active: DesignerNavId | null
  /** Auth role. 'admin' shows the Admin nav pill, others hide it. */
  role: 'admin' | 'designer' | null
  user: UserProps
  /** Controlled search field. Omit to hide. */
  search?: SearchProps
  /** Optional content placed to the left of the user pill. Use for
   *  page-specific CTAs like the dashboard's "New proof" button. */
  actions?: ReactNode
  onEditProfile?: () => void
  onSignOut?: () => void
}

export function DesignerHeader({
  active,
  role,
  user,
  search,
  actions,
  onEditProfile,
  onSignOut,
}: DesignerHeaderProps) {
  const visibleNav = NAV.filter((n) => n.id !== 'admin' || role === 'admin')
  return (
    <header className="sticky top-0 z-[5] bg-surface border-b border-line">
      <div className="mx-auto max-w-[1280px] flex items-center gap-4 px-4 pt-[calc(env(safe-area-inset-top)+0.75rem)] pb-3 sm:gap-5 sm:px-7">
        <Link to="/" className="flex-shrink-0">
          <PlasmaWordmark tagline="Proofs" />
        </Link>
        <nav
          aria-label="Designer navigation"
          className="hidden md:flex items-center gap-1 ml-3"
        >
          {visibleNav.map((n) => {
            const isActive = n.id === active
            const cls = [
              'inline-flex items-center h-8 px-3 rounded-full text-[13px] transition-colors',
              isActive
                ? 'text-ink bg-canvas border border-line'
                : 'text-ink-mute border border-transparent hover:text-ink hover:bg-canvas',
            ].join(' ')
            return (
              <Link key={n.id} to={n.to} className={cls}>
                {n.label}
              </Link>
            )
          })}
        </nav>

        {search ? (
          <SearchField {...search} />
        ) : (
          <span className="flex-1" aria-hidden="true" />
        )}

        {actions && <div className="flex items-center gap-2">{actions}</div>}

        <UserPill
          user={user}
          onEditProfile={onEditProfile}
          onSignOut={onSignOut}
        />
      </div>
    </header>
  )
}

function SearchField({ value, onChange, placeholder }: SearchProps) {
  return (
    <label className="hidden md:flex flex-1 max-w-[420px] ml-auto items-center gap-2 h-8 px-2.5 rounded-[8px] border border-line bg-surface focus-within:border-[var(--c-brand)] focus-within:outline focus-within:outline-2 focus-within:outline-offset-[-1px] focus-within:outline-[var(--c-brand)]">
      <Search size={14} aria-hidden="true" className="text-ink-mute flex-shrink-0" />
      <input
        type="search"
        value={value}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
        placeholder={placeholder ?? 'Search by customer or company…'}
        className="flex-1 bg-transparent text-[13px] text-ink placeholder:text-ink-dim outline-none"
      />
      <span
        aria-hidden="true"
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[4px] bg-canvas border border-line-soft font-mono text-[10px] text-ink-mute"
        style={{ letterSpacing: '0.06em' }}
      >
        ⌘ K
      </span>
    </label>
  )
}

function UserPill({
  user,
  onEditProfile,
  onSignOut,
}: {
  user: UserProps
  onEditProfile?: () => void
  onSignOut?: () => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Close on outside click / Escape. Same pattern as the prior
  // dashboard avatar popover so the muscle memory survives.
  useEffect(() => {
    if (!open) return
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const bg = COLOUR_BG[user.colour]
  const avatarStyle = user.avatarUrl
    ? undefined
    : { backgroundColor: bg, color: '#fff' }

  return (
    <div ref={ref} className="relative flex-shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Account menu"
        aria-expanded={open}
        className="inline-flex items-center gap-2 h-8 pl-1 pr-3 rounded-full border border-line bg-surface text-[12px] text-ink-soft hover:bg-canvas transition-colors"
      >
        <span
          className="inline-flex items-center justify-center w-[22px] h-[22px] rounded-full overflow-hidden font-mono font-medium text-[10px]"
          style={avatarStyle}
        >
          {user.avatarUrl ? (
            <img src={user.avatarUrl} alt="" className="w-full h-full object-cover" />
          ) : (
            user.initials
          )}
        </span>
        <span className="hidden sm:inline">{user.name ?? 'Account'}</span>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-10 z-20 min-w-[10rem] rounded-[10px] bg-surface py-1 shadow-md border border-line"
        >
          {onEditProfile && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                onEditProfile()
              }}
              className="w-full px-4 py-2 text-left text-[13px] text-ink-soft hover:bg-canvas"
            >
              Edit profile
            </button>
          )}
          {onEditProfile && onSignOut && (
            <div className="mx-3 my-1 border-t border-line-soft" />
          )}
          {onSignOut && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                onSignOut()
              }}
              className="w-full px-4 py-2 text-left text-[13px] text-ink-soft hover:bg-canvas"
            >
              Sign out
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export default DesignerHeader
