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
  ClipboardList,
  Flag,
  UserCircle,
  LogOut,
  Settings,
  MessageSquare,
  MessagesSquare,
  MoreHorizontal,
  type LucideIcon,
} from 'lucide-react'
import { PlasmaWordmark } from './PlasmaWordmark'
import { Sheet } from './Sheet'
import { useScrolled } from './useScrolled'
import { getOrderingEnabled, peekOrderingEnabled } from '../lib/orderingEnabled'
import { openCommandPalette } from '../lib/useQuoteShortcut'
import ChatMenu from '../components/ChatMenu'
import { designerColourCss, type DesignerColour } from '../lib/designerColours'

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

export type DesignerNavId =
  | 'proofs'
  | 'quote'
  | 'orders'
  | 'orderlog'
  | 'flagged'
  | 'feedback'
  | 'chat'
  | 'activity'
  | 'admin'
// Alias kept so the many `DesignerHeaderColour` imports keep working; the
// palette itself lives in lib/designerColours.
export type DesignerHeaderColour = DesignerColour

interface NavItem {
  id: DesignerNavId
  label: string
  to: string
}

// Customers deliberately omitted here — it lives in the Admin sidebar
// (AdminLayout), which the Admin nav item already leads into. Listing
// it in the top bar too was redundant (the whole admin section
// highlights "Admin" anyway).
// Order matters: this is the left-to-right reading order of the pill strip.
// The everyday work queues lead (Dashboard → Orders → Logbook → Flagged) and
// the occasional tools trail (Quote, then Admin).
const NAV: NavItem[] = [
  // id stays 'proofs' — it's the internal key every page passes as `active`,
  // and renaming it would churn a dozen files for a label change.
  { id: 'proofs', label: 'Dashboard', to: '/' },
  // Orders is shown only when the ordering feature is switched on
  // (settings.ordering_enabled) — see the gate in DesignerHeader.
  { id: 'orders', label: 'Orders', to: '/orders' },
  // Logbook — the searchable archive of every order (distinct from the
  // Orders work queue above, and from the admin-only /admin/orders log).
  // Shares the ordering_enabled gate with Orders.
  { id: 'orderlog', label: 'Logbook', to: '/orders/log' },
  // Flagged — the shared board of problem projects. All-staff (no gate), so
  // it falls through the visibleNav filter below like Dashboard / Quote.
  // (Distinct from the per-proof "Watch" button, which is push-notification
  // opt-in.)
  { id: 'flagged', label: 'Flagged', to: '/flagged' },
  { id: 'quote',  label: 'Quote',  to: '/quote' },
  // Feedback deliberately omitted here — it's a right-aligned icon button
  // next to the account pill (see the header) rather than a text nav pill.
  // /admin (not a specific tab) so the landing page is decided in one
  // place — the index route in App.tsx (the Admin home hub, AdminHomePage).
  { id: 'admin',  label: 'Admin',  to: '/admin' },
]


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
  /** Dots the mobile Activity tab when the feed has entries newer than the
   *  user's last visit to /activity. Only the dashboard knows this (it owns
   *  the feed data), so other pages simply omit it. */
  activityUnseen?: boolean
  /** Count of team-chat messages from others since the user last opened the
   *  chat. Badges the Chat icon / Chat tab when > 0. */
  chatUnread?: number
  /** Of chatUnread, how many are personal (@mentions + DMs). Makes the
   *  mobile Chat tab badge coral instead of ink. */
  chatMentionUnread?: number
  /** Payments received since the user last opened the Orders page. Badges the
   *  Orders nav pill (desktop) and the Orders bottom tab (mobile) when > 0. */
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
  activityUnseen = false,
  chatUnread = 0,
  chatMentionUnread = 0,
  ordersUnread = 0,
  flaggedCount = 0,
  onEditProfile,
  onSignOut,
}: DesignerHeaderProps) {
  // Ordering is OFF by default; the Orders nav pill stays hidden until an
  // admin turns the feature on. Fail-safe false (getOrderingEnabled) so a
  // settings outage never reveals the unfinished feature. Seed from the warm
  // module cache (peekOrderingEnabled) so on every navigation after the first
  // the pill is already in its final state at first paint — otherwise the async
  // refresh flips it a tick later and the pill pops in, shoving the pills beside
  // it sideways on each page switch.
  const [orderingEnabled, setOrderingEnabled] = useState(() => peekOrderingEnabled() ?? false)
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
    if (n.id === 'orders' || n.id === 'orderlog') return orderingEnabled
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
                    ? `${n.label} — ${badge} paid since you last looked`
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
          {/* The mobile top-bar Activity bell moved to the bottom tab bar
              (Proofs · Orders · Chat · Activity · More) — mobileBell now
              drives that Activity tab instead of a button here. */}

          {/* Team chat — desktop dropdown from the icon; mobile uses the full
              page via the account sheet (below). */}
          <ChatMenu active={active === 'chat'} />

          {/* Feedback used to sit here as its own icon, but it read as a twin
              of the chat icon. It now lives inside the account menu (UserPill),
              deliberately without any notification indicator. */}
          <UserPill
            user={user}
            feedbackActive={active === 'feedback'}
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
        chatUnread={chatUnread}
        chatMentionUnread={chatMentionUnread}
        ordersUnread={ordersUnread}
        activityUnseen={activityUnseen}
        onMore={() => setAccountOpen(true)}
      />

      <AccountSheet
        open={accountOpen}
        onClose={() => setAccountOpen(false)}
        user={user}
        role={role}
        orderingEnabled={orderingEnabled}
        flaggedCount={flaggedCount}
        onEditProfile={onEditProfile}
        onSignOut={onSignOut}
      />
    </>
  )
}

// ── Mobile bottom tab bar ──────────────────────────────────────────────
//
// Fixed bottom navigation, rendered only below md:. The day-to-day
// surfaces are first-class tabs — Proofs / Orders (only when ordering is
// on) / Chat / Activity — and everything else (Quote, Flagged, Feedback,
// Admin, profile, sign out) folds into More, which opens the sheet.
// Chat carries a real count badge (coral when any of it is personal —
// an @mention or a DM); Activity opens the dashboard activity sheet.
function BottomTabBar({
  active,
  orderingEnabled,
  chatUnread,
  chatMentionUnread,
  ordersUnread,
  activityUnseen,
  onMore,
}: {
  active: DesignerNavId | null
  orderingEnabled: boolean
  chatUnread: number
  chatMentionUnread: number
  ordersUnread: number
  activityUnseen: boolean
  onMore: () => void
}) {
  const moreActive =
    active === 'quote' || active === 'flagged' || active === 'admin' || active === 'feedback' ||
    active === 'orderlog'
  return (
    <nav
      aria-label="Primary"
      // absolute (not fixed): the containing block is DesignerChrome's
      // viewport-locked app frame, which iOS can never pan — fixed tracked
      // the layout viewport and visibly broke away from the screen edge
      // whenever WebKit panned it (keyboard, short pages, overscroll).
      className="md:hidden absolute inset-x-0 bottom-0 z-40 flex items-stretch border-t border-line bg-[rgba(255,255,255,0.94)] backdrop-blur-[14px]"
      style={{
        height: 'calc(64px + env(safe-area-inset-bottom))',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      <Link
        to="/"
        className="flex flex-1 items-center justify-center"
        aria-current={active === 'proofs' ? 'page' : undefined}
      >
        <TabInner label="Dashboard" Icon={Layers} active={active === 'proofs'} />
      </Link>
      {orderingEnabled && (
        <Link
          to="/orders"
          className="flex flex-1 items-center justify-center"
          aria-current={active === 'orders' ? 'page' : undefined}
        >
          <TabInner label="Orders" Icon={Package} active={active === 'orders'} showDot={ordersUnread > 0} />
        </Link>
      )}
      <Link
        to="/chat"
        className="flex flex-1 items-center justify-center"
        aria-current={active === 'chat' ? 'page' : undefined}
        aria-label={
          chatMentionUnread > 0
            ? `Chat — ${chatUnread} new, including a message for you`
            : chatUnread > 0
              ? `Chat — ${chatUnread} new`
              : 'Chat'
        }
      >
        <TabInner
          label="Chat"
          Icon={MessagesSquare}
          active={active === 'chat'}
          badge={chatUnread}
          badgeLoud={chatMentionUnread > 0}
        />
      </Link>
      {/* A real page like the other tabs (was a full-screen sheet with a
          Close button — jarring next to Chat's page idiom, and it hid the
          nav). */}
      <Link
        to="/activity"
        className="flex flex-1 items-center justify-center"
        aria-current={active === 'activity' ? 'page' : undefined}
        aria-label="Latest activity"
      >
        <TabInner label="Activity" Icon={Bell} active={active === 'activity'} showDot={activityUnseen} />
      </Link>
      <button
        type="button"
        onClick={onMore}
        className="flex flex-1 items-center justify-center"
        aria-current={moreActive ? 'page' : undefined}
        aria-label="More"
      >
        <TabInner label="More" Icon={MoreHorizontal} active={moreActive} />
      </button>
    </nav>
  )
}

function TabInner({
  label,
  Icon,
  active,
  showDot = false,
  badge = 0,
  badgeLoud = false,
}: {
  label: string
  Icon: LucideIcon
  active: boolean
  showDot?: boolean
  /** Count bubble on the icon (replaces the dot when > 0). */
  badge?: number
  /** Coral bubble instead of ink — for personal signals (@mention / DM). */
  badgeLoud?: boolean
}) {
  return (
    <span
      className={[
        'relative flex min-h-[52px] min-w-[60px] flex-col items-center justify-center gap-0.5 rounded-[12px] px-3 py-1.5 transition-colors',
        active ? 'text-brand bg-brand-50' : 'text-ink-mute',
      ].join(' ')}
    >
      <Icon size={22} aria-hidden="true" />
      {badge > 0 ? (
        <span
          className={[
            'absolute right-[10px] top-[2px] inline-flex h-[16px] min-w-[16px] items-center justify-center rounded-full px-1 text-[9px] font-bold leading-none text-white',
            badgeLoud ? 'bg-brand' : 'bg-ink',
          ].join(' ')}
          style={{ boxShadow: '0 0 0 2px var(--c-bg)' }}
          aria-hidden="true"
        >
          {badge > 9 ? '9+' : badge}
        </span>
      ) : (
        showDot && (
          <span
            className="absolute right-[18px] top-[6px] h-2 w-2 rounded-full bg-brand"
            style={{ boxShadow: '0 0 0 2px var(--c-bg)' }}
            aria-hidden="true"
          />
        )
      )}
      <span className="text-[11px] font-medium leading-none">{label}</span>
    </span>
  )
}

// Mobile "More" sheet, opened from the More bottom tab. Carries everything
// that isn't a first-class tab: Logbook, Flagged, Quote, Notifications,
// Feedback, the Admin entry for admins, plus Edit profile + Sign out — in the
// same order as the desktop pill strip (see NAV). (Team chat left this sheet
// when Chat became its own bottom tab.)
function AccountSheet({
  open,
  onClose,
  user,
  role,
  orderingEnabled,
  flaggedCount,
  onEditProfile,
  onSignOut,
}: {
  open: boolean
  onClose: () => void
  user: UserProps
  role: 'admin' | 'designer' | null
  orderingEnabled: boolean
  flaggedCount: number
  onEditProfile?: () => void
  onSignOut?: () => void
}) {
  return (
    <Sheet open={open} onClose={onClose} title="More" ariaLabel="More">
      <div className="px-4">
        <div className="flex items-center gap-3 px-2 py-2">
          <span
            className="inline-flex h-10 w-10 items-center justify-center overflow-hidden rounded-full font-mono text-[13px] font-medium"
            style={user.avatarUrl ? undefined : { backgroundColor: designerColourCss(user.colour), color: '#fff' }}
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
          {orderingEnabled && (
            <Link
              to="/orders/log"
              onClick={onClose}
              className="flex min-h-[56px] items-center gap-3 border-b border-line-soft px-4 text-[15px] text-ink-soft hover:bg-canvas"
            >
              <ClipboardList size={18} aria-hidden="true" className="text-ink-mute" />
              Logbook
            </Link>
          )}
          <Link
            to="/flagged"
            onClick={onClose}
            className="flex min-h-[56px] items-center gap-3 border-b border-line-soft px-4 text-[15px] text-ink-soft hover:bg-canvas"
          >
            <Flag size={18} aria-hidden="true" className="text-ink-mute" />
            Flagged
            {flaggedCount > 0 && (
              <span className="ml-auto inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-brand px-1.5 text-[11px] font-semibold leading-none text-white">
                {flaggedCount > 9 ? '9+' : flaggedCount}
              </span>
            )}
          </Link>
          <Link
            to="/quote"
            onClick={onClose}
            className="flex min-h-[56px] items-center gap-3 border-b border-line-soft px-4 text-[15px] text-ink-soft hover:bg-canvas"
          >
            <FileText size={18} aria-hidden="true" className="text-ink-mute" />
            Quote
          </Link>
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
    <label className="hidden md:flex flex-1 max-w-[420px] ml-auto items-center gap-2 h-8 px-2.5 rounded-[8px] border border-line bg-surface focus-within:border-[var(--c-brand)] focus-within:outline focus-within:outline-2 focus-within:outline-offset-[-1px] focus-within:outline-[var(--c-focus)]">
      <Search size={14} aria-hidden="true" className="text-ink-mute flex-shrink-0" />
      <input
        type="search"
        value={value}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
        placeholder={placeholder ?? 'Search by customer or company…'}
        className="flex-1 bg-transparent text-[13px] text-ink placeholder:text-ink-dim outline-none"
      />
      {/* This badge used to be a plain <span>, and ⌘K opened the quote
          compiler in a new tab — so the one hint the header gave about
          keyboard shortcuts pointed at the wrong thing. ⌘K now opens the
          command palette, and the badge is a real button that does the same,
          so clicking and pressing it agree. preventDefault stops the wrapping
          <label> focusing the input instead. */}
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          e.preventDefault()
          openCommandPalette()
        }}
        title="Search everything (⌘K)"
        aria-label="Open the search palette"
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[4px] bg-canvas border border-line-soft font-mono text-[10px] text-ink-mute hover:text-ink hover:border-line focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--c-focus)]"
        style={{ letterSpacing: '0.06em' }}
      >
        ⌘ K
      </button>
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
    <label className="flex h-[46px] items-center gap-2 rounded-[10px] border border-line bg-surface px-3 focus-within:border-[var(--c-brand)] focus-within:outline focus-within:outline-2 focus-within:outline-offset-[-1px] focus-within:outline-[var(--c-focus)]">
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
  feedbackActive,
  onEditProfile,
  onSignOut,
}: {
  user: UserProps
  feedbackActive: boolean
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

  const bg = designerColourCss(user.colour)
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
          <Link
            to="/feedback"
            role="menuitem"
            onClick={() => setOpen(false)}
            aria-current={feedbackActive ? 'page' : undefined}
            className="flex w-full items-center gap-2 px-4 py-2 text-left text-[13px] text-ink-soft hover:bg-canvas"
          >
            <MessageSquare size={15} aria-hidden="true" className="text-ink-mute" />
            Feedback
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
