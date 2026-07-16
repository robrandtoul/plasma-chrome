import {
  useState,
  useRef,
  useEffect,
  type ChangeEvent,
  type ReactNode,
} from 'react'
import { Link } from 'react-router-dom'
import {
  Search,
  Bell,
  Layers,
  Package,
  FileText,
  Flag,
  UserCircle,
  LogOut,
  Settings,
  MessageSquare,
  type LucideIcon,
} from 'lucide-react'
import { PlasmaWordmark } from './PlasmaWordmark'
import { Sheet } from './Sheet'
import { useScrolled } from './useScrolled'
import { getOrderingEnabled } from '../lib/orderingEnabled'

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

export type DesignerNavId = 'proofs' | 'quote' | 'orders' | 'flagged' | 'feedback' | 'admin'
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
  // Orders is shown only when the ordering feature is switched on
  // (settings.ordering_enabled) — see the gate in DesignerHeader.
  { id: 'orders', label: 'Orders', to: '/orders' },
  // Flagged — the shared board of problem projects. All-staff (no gate), so
  // it falls through the visibleNav filter below like Proofs / Quote. (Distinct
  // from the per-proof "Watch" button, which is push-notification opt-in.)
  { id: 'flagged', label: 'Flagged', to: '/flagged' },
  // Feedback deliberately omitted here — it's a right-aligned icon button
  // next to the account pill (see the header) rather than a text nav pill.
  // /admin (not a specific tab) so the landing page is decided in one
  // place — the index route in App.tsx (the Admin home hub, AdminHomePage).
  { id: 'admin',  label: 'Admin',  to: '/admin' },
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
  /** Mobile-only bell button in the top bar (Dashboard activity rail).
   *  Hidden at md:+ where the activity aside is visible instead. */
  mobileBell?: { onClick: () => void; hasUnseen: boolean }
  /** Count of the user's own feedback items resolved since they last
   *  opened the board. Badges the Feedback icon / Account tab when > 0. */
  feedbackUnread?: number
  /** Count of approved proofs with no order link sent yet. Badges the Orders
   *  nav pill (desktop) and the Orders bottom tab (mobile) when > 0. */
  ordersUnread?: number
  /** Count of open items on the Flagged board. Badges the Flagged nav pill
   *  when > 0, inverting on the active (coral) pill so it stays legible. */
  flaggedCount?: number
  onEditProfile?: () => void
  onSignOut?: () => void
}

export function DesignerHeader({
  active,
  role,
  user,
  search,
  actions,
  mobileBell,
  feedbackUnread = 0,
  ordersUnread = 0,
  flaggedCount = 0,
  onEditProfile,
  onSignOut,
}: DesignerHeaderProps) {
  // Ordering is OFF by default; the Orders nav pill stays hidden until an
  // admin turns the feature on. Fail-safe false (getOrderingEnabled) so a
  // settings outage never reveals the unfinished feature.
  const [orderingEnabled, setOrderingEnabled] = useState(false)
  // Mobile-only: the search field collapses behind an icon button, and
  // the bottom-tab Account entry opens an account sheet. Neither piece of
  // state has any effect at md:+ where the desktop chrome is rendered.
  const [searchOpen, setSearchOpen] = useState(false)
  const [accountOpen, setAccountOpen] = useState(false)
  // Condense-on-scroll: past a small threshold the bar tightens its vertical
  // padding, tucks the wordmark tagline, and drops a soft shadow. Window-scroll
  // driven (see useScrolled) — the same scroll context `sticky top-0` binds to.
  const condensed = useScrolled()
  useEffect(() => {
    let cancelled = false
    void getOrderingEnabled().then((on) => { if (!cancelled) setOrderingEnabled(on) })
    return () => { cancelled = true }
  }, [])
  const visibleNav = NAV.filter((n) => {
    if (n.id === 'admin') return role === 'admin'
    if (n.id === 'orders') return orderingEnabled
    return true
  })
  return (
    <>
      {/* The mobile-only cream/blur top bar is layered behind max-md:
          variants so the desktop bar (bg-surface, no blur) is byte-for-byte
          unchanged at md:+. */}
      <header
        className={[
          'sticky top-0 z-[5] bg-surface border-b border-line transition-shadow duration-[250ms]',
          'max-md:bg-[rgba(251,247,240,0.92)] max-md:backdrop-blur-[8px]',
          condensed ? 'shadow-[0_6px_16px_-8px_rgba(22,19,17,0.20)]' : '',
        ].join(' ')}
      >
        <div
          className={[
            'mx-auto max-w-[1280px] flex items-center gap-4 px-4 sm:gap-5 sm:px-7',
            'transition-[padding] duration-[220ms]',
            // Tighten top/bottom padding when condensed (12px → 9px). The
            // safe-area-inset-top stays in both states so the bar never tucks
            // under a phone notch.
            condensed
              ? 'pt-[calc(env(safe-area-inset-top)+9px)] pb-[9px]'
              : 'pt-[calc(env(safe-area-inset-top)+0.75rem)] pb-3',
          ].join(' ')}
        >
          <Link to="/" className="flex-shrink-0">
            <PlasmaWordmark tagline="Proofs" collapsed={condensed} />
          </Link>
          <nav
            aria-label="Designer navigation"
            className="hidden md:flex items-center gap-[5px] ml-3"
          >
            {visibleNav.map((n) => {
              const isActive = n.id === active
              // Orders and Flagged both carry a count badge; every other pill
              // has none. Per-nav aria copy so the number is announced in
              // context.
              const badge =
                n.id === 'orders' ? ordersUnread : n.id === 'flagged' ? flaggedCount : 0
              const badgeAria =
                badge > 0
                  ? n.id === 'orders'
                    ? `${n.label} — ${badge} approved, no order link sent`
                    : `${n.label} — ${badge} open`
                  : undefined
              const cls = [
                'inline-flex items-center gap-1.5 h-9 px-[15px] rounded-full text-[14px] font-medium transition-colors',
                isActive
                  ? 'bg-brand text-on-brand'
                  : 'text-ink-mute hover:text-ink hover:bg-canvas',
              ].join(' ')
              return (
                <Link
                  key={n.id}
                  to={n.to}
                  className={cls}
                  aria-current={isActive ? 'page' : undefined}
                  aria-label={badgeAria}
                >
                  {n.label}
                  {badge > 0 && (
                    <span
                      className={[
                        'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1',
                        'font-mono text-[10px] font-semibold leading-none',
                        // Invert on the active coral pill so the badge stays
                        // legible; brand-fill on inactive pills as before.
                        isActive ? 'bg-white/25 text-white' : 'bg-brand text-white',
                      ].join(' ')}
                      aria-hidden="true"
                    >
                      {badge > 9 ? '9+' : badge}
                    </span>
                  )}
                </Link>
              )
            })}
          </nav>

          {search ? (
            <SearchField {...search} />
          ) : (
            <span className="flex-1" aria-hidden="true" />
          )}

          {/* SearchField is hidden < md, so add a mobile flex spacer to
              push the right-hand icon cluster to the screen edge. */}
          {search && <span className="flex-1 md:hidden" aria-hidden="true" />}

          {actions && <div className="flex items-center gap-2">{actions}</div>}

          {/* Mobile-only: search toggle + (Dashboard) bell. Hidden at md:+
              where the desktop search field and activity rail take over. */}
          {search && (
            <button
              type="button"
              onClick={() => setSearchOpen((v) => !v)}
              aria-label="Search"
              aria-expanded={searchOpen}
              className="md:hidden flex h-11 w-11 items-center justify-center rounded-full text-ink-soft hover:bg-canvas"
            >
              <Search size={20} aria-hidden="true" />
            </button>
          )}
          {mobileBell && (
            <button
              type="button"
              onClick={mobileBell.onClick}
              aria-label="Latest activity"
              className="md:hidden relative flex h-11 w-11 items-center justify-center rounded-full text-ink-soft hover:bg-canvas"
            >
              <Bell size={20} aria-hidden="true" />
              {mobileBell.hasUnseen && (
                <span
                  className="absolute right-2.5 top-2.5 h-2 w-2 rounded-full bg-brand"
                  style={{ boxShadow: '0 0 0 2px var(--c-bg)' }}
                  aria-hidden="true"
                />
              )}
            </button>
          )}

          {/* Feedback — a right-aligned icon by the account button rather than
              a text pill in the main nav. Desktop only; on mobile it lives in
              the account sheet (below). */}
          <Link
            to="/feedback"
            aria-label={
              feedbackUnread > 0
                ? `Feedback — ${feedbackUnread} of your suggestions resolved`
                : 'Feedback'
            }
            title="Feedback"
            aria-current={active === 'feedback' ? 'page' : undefined}
            className={[
              'relative hidden md:flex h-9 w-9 items-center justify-center rounded-full transition-colors',
              active === 'feedback'
                ? 'text-ink bg-canvas border border-line'
                : 'text-ink-mute hover:text-ink hover:bg-canvas',
            ].join(' ')}
          >
            <MessageSquare size={18} aria-hidden="true" />
            {feedbackUnread > 0 && <CountBadge count={feedbackUnread} />}
          </Link>

          <UserPill
            user={user}
            onEditProfile={onEditProfile}
            onSignOut={onSignOut}
          />
        </div>

        {/* Mobile expandable search row, shown directly under the top bar. */}
        {search && searchOpen && (
          <div className="md:hidden px-4 pb-3">
            <MobileSearchField {...search} onClose={() => setSearchOpen(false)} />
          </div>
        )}
      </header>

      <BottomTabBar
        active={active}
        orderingEnabled={orderingEnabled}
        feedbackUnread={feedbackUnread}
        ordersUnread={ordersUnread}
        onAccount={() => setAccountOpen(true)}
      />

      <AccountSheet
        open={accountOpen}
        onClose={() => setAccountOpen(false)}
        user={user}
        role={role}
        feedbackUnread={feedbackUnread}
        onEditProfile={onEditProfile}
        onSignOut={onSignOut}
      />
    </>
  )
}

// ── Mobile bottom tab bar ──────────────────────────────────────────────
//
// Fixed bottom navigation, rendered only below md:. Four tabs drawn from
// the same nav set the desktop pill strip uses: Proofs / Orders (only
// when ordering is on) / Quote / Account. Admin folds into Account — the
// Account tab opens the AccountSheet, which carries the Admin link for
// admins plus Edit profile + Sign out. Active state is driven off the
// same `active` prop the desktop pills read; the Account tab lights up on
// admin routes (active === 'admin').
function BottomTabBar({
  active,
  orderingEnabled,
  feedbackUnread,
  ordersUnread,
  onAccount,
}: {
  active: DesignerNavId | null
  orderingEnabled: boolean
  feedbackUnread: number
  ordersUnread: number
  onAccount: () => void
}) {
  const linkTabs: { id: DesignerNavId; label: string; to: string; Icon: LucideIcon }[] = [
    { id: 'proofs', label: 'Proofs', to: '/', Icon: Layers },
    ...(orderingEnabled
      ? [{ id: 'orders' as DesignerNavId, label: 'Orders', to: '/orders', Icon: Package }]
      : []),
    { id: 'quote', label: 'Quote', to: '/quote', Icon: FileText },
    { id: 'flagged', label: 'Flagged', to: '/flagged', Icon: Flag },
  ]
  return (
    <nav
      aria-label="Primary"
      className="md:hidden fixed inset-x-0 bottom-0 z-40 flex items-stretch border-t border-line bg-[rgba(255,255,255,0.94)] backdrop-blur-[14px]"
      style={{
        height: 'calc(64px + env(safe-area-inset-bottom))',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      {linkTabs.map(({ id, label, to, Icon }) => (
        <Link
          key={id}
          to={to}
          className="flex flex-1 items-center justify-center"
          aria-current={active === id ? 'page' : undefined}
        >
          <TabInner label={label} Icon={Icon} active={active === id} showDot={id === 'orders' && ordersUnread > 0} />
        </Link>
      ))}
      <button
        type="button"
        onClick={onAccount}
        className="flex flex-1 items-center justify-center"
        aria-current={active === 'admin' || active === 'feedback' ? 'page' : undefined}
      >
        <TabInner
          label="Account"
          Icon={UserCircle}
          active={active === 'admin' || active === 'feedback'}
          showDot={feedbackUnread > 0}
        />
      </button>
    </nav>
  )
}

// Small numeric badge that rides the top-right of the desktop Feedback icon.
// Caps at "9+" so it never blows out the 9×9 button. The ring (box-shadow in
// the page background colour) lifts it off the icon like the mobileBell dot.
function CountBadge({ count }: { count: number }) {
  return (
    <span
      className="absolute -right-1 -top-1 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-brand px-1 text-[10px] font-semibold leading-none text-white"
      style={{ boxShadow: '0 0 0 2px var(--c-surface)' }}
      aria-hidden="true"
    >
      {count > 9 ? '9+' : count}
    </span>
  )
}

function TabInner({
  label,
  Icon,
  active,
  showDot = false,
}: {
  label: string
  Icon: LucideIcon
  active: boolean
  showDot?: boolean
}) {
  return (
    <span
      className={[
        'relative flex min-h-[52px] min-w-[60px] flex-col items-center justify-center gap-0.5 rounded-[12px] px-3 py-1.5 transition-colors',
        active ? 'text-brand bg-brand-50' : 'text-ink-mute',
      ].join(' ')}
    >
      <Icon size={22} aria-hidden="true" />
      {showDot && (
        <span
          className="absolute right-[18px] top-[6px] h-2 w-2 rounded-full bg-brand"
          style={{ boxShadow: '0 0 0 2px var(--c-bg)' }}
          aria-hidden="true"
        />
      )}
      <span className="text-[11px] font-medium leading-none">{label}</span>
    </span>
  )
}

// Mobile account sheet, opened from the Account bottom tab. Mirrors the
// UserPill popover (Edit profile + Sign out) and adds the Admin entry for
// admins — the desktop Admin pill has no bottom-tab equivalent, so it
// lives here.
function AccountSheet({
  open,
  onClose,
  user,
  role,
  feedbackUnread,
  onEditProfile,
  onSignOut,
}: {
  open: boolean
  onClose: () => void
  user: UserProps
  role: 'admin' | 'designer' | null
  feedbackUnread: number
  onEditProfile?: () => void
  onSignOut?: () => void
}) {
  return (
    <Sheet open={open} onClose={onClose} title="Account" ariaLabel="Account">
      <div className="px-4">
        <div className="flex items-center gap-3 px-2 py-2">
          <span
            className="inline-flex h-10 w-10 items-center justify-center overflow-hidden rounded-full font-mono text-[13px] font-medium"
            style={user.avatarUrl ? undefined : { backgroundColor: COLOUR_BG[user.colour], color: '#fff' }}
          >
            {user.avatarUrl ? (
              <img src={user.avatarUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              user.initials
            )}
          </span>
          <div className="min-w-0">
            <div className="truncate text-[15px] font-medium text-ink">{user.name ?? 'Account'}</div>
          </div>
        </div>

        <div className="mt-1 overflow-hidden rounded-[14px] border border-line bg-surface">
          <Link
            to="/settings/notifications"
            onClick={onClose}
            className="flex min-h-[56px] items-center gap-3 border-b border-line-soft px-4 text-[15px] text-ink-soft hover:bg-canvas"
          >
            <Bell size={18} aria-hidden="true" className="text-ink-mute" />
            Notifications
          </Link>
          <Link
            to="/feedback"
            onClick={onClose}
            className="flex min-h-[56px] items-center gap-3 border-b border-line-soft px-4 text-[15px] text-ink-soft hover:bg-canvas"
          >
            <MessageSquare size={18} aria-hidden="true" className="text-ink-mute" />
            Feedback
            {feedbackUnread > 0 && (
              <span className="ml-auto inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-brand px-1.5 text-[11px] font-semibold leading-none text-white">
                {feedbackUnread > 9 ? '9+' : feedbackUnread}
              </span>
            )}
          </Link>
          {role === 'admin' && (
            <Link
              to="/admin"
              onClick={onClose}
              className="flex min-h-[56px] items-center gap-3 border-b border-line-soft px-4 text-[15px] text-ink-soft hover:bg-canvas"
            >
              <Settings size={18} aria-hidden="true" className="text-ink-mute" />
              Admin
            </Link>
          )}
          {onEditProfile && (
            <button
              type="button"
              onClick={() => {
                onClose()
                onEditProfile()
              }}
              className="flex w-full min-h-[56px] items-center gap-3 px-4 text-left text-[15px] text-ink-soft hover:bg-canvas"
            >
              <UserCircle size={18} aria-hidden="true" className="text-ink-mute" />
              Edit profile
            </button>
          )}
        </div>

        {onSignOut && (
          <button
            type="button"
            onClick={() => {
              onClose()
              onSignOut()
            }}
            className="mt-3 flex w-full min-h-[56px] items-center justify-center gap-2 rounded-[14px] border border-line bg-surface text-[15px] font-medium text-out hover:bg-canvas"
          >
            <LogOut size={18} aria-hidden="true" />
            Sign out
          </button>
        )}
      </div>
    </Sheet>
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

// Full-width mobile search field, revealed under the top bar when the
// search icon is tapped. Drives the same controlled value/onChange as the
// desktop SearchField. 16px text avoids the iOS focus-zoom (the global
// rule in design-tokens.css already forces this < 640px, restated here
// for clarity).
function MobileSearchField({
  value,
  onChange,
  placeholder,
  onClose,
}: SearchProps & { onClose: () => void }) {
  return (
    <label className="flex h-[46px] items-center gap-2 rounded-[10px] border border-line bg-surface px-3 focus-within:border-[var(--c-brand)] focus-within:outline focus-within:outline-2 focus-within:outline-offset-[-1px] focus-within:outline-[var(--c-brand)]">
      <Search size={16} aria-hidden="true" className="text-ink-mute flex-shrink-0" />
      <input
        type="search"
        autoFocus
        value={value}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
        placeholder={placeholder ?? 'Search customer or company…'}
        className="flex-1 bg-transparent text-[16px] text-ink placeholder:text-ink-dim outline-none"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
        }}
      />
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
          <Link
            to="/settings/notifications"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="block w-full px-4 py-2 text-left text-[13px] text-ink-soft hover:bg-canvas"
          >
            Notifications
          </Link>
          <div className="mx-3 my-1 border-t border-line-soft" />
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
