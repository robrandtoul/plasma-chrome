import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { useTeamChat } from '../lib/teamChatStore'
import EditProfileModal, { type EditProfileSavedPayload } from '../components/EditProfileModal'
import PushNudge from '../components/PushNudge'
import { getFlaggedCount, peekFlaggedCount } from '../lib/flaggedCount'
import { DesignerHeader, type DesignerNavId, type DesignerHeaderColour } from './DesignerHeader'

// Shared chrome wrapper for every designer-facing page. Owns the
// signed-in designer's profile fetch + edit-profile modal + sign-out
// handler so individual pages don't each reimplement the same ~40
// lines. Exposes the profile to children via useDesignerProfile() so
// e.g. the dashboard hero greeting can read firstName.
//
// Pages pass their own page-specific CTAs through the `actions` prop;
// they render in the header's actions slot. (The old persistent
// "Quote compiler" link that used to ride here was removed — it
// duplicated the "Quote" nav pill. The ⌘K jump-to-quote shortcut is
// still wired globally in App.tsx via useQuoteShortcut().)

export interface DesignerProfile {
  initials: string
  colour: DesignerHeaderColour
  avatarUrl: string | null
  firstName: string | null
}

const DesignerProfileContext = createContext<DesignerProfile | null>(null)

export function useDesignerProfile(): DesignerProfile | null {
  return useContext(DesignerProfileContext)
}

// Module-level cache of the signed-in user's unseen-paid-orders count so the
// Orders nav badge doesn't reset to 0 and flash back in on every navigation
// (each page remounts this chrome). Keyed by user id; the effect refreshes it
// on every mount, so it's stale-while-revalidate like the other badges.
let ordersUnreadCache: { userId: string; value: number } | null = null

interface DesignerChromeProps {
  /** Which nav pill in the header is highlighted. Pass null to
   *  highlight nothing (rare — proof-detail / new-version etc.
   *  still reside under the Proofs nav). */
  active: DesignerNavId | null
  /** Page-specific CTAs rendered in the header's actions slot. */
  actions?: ReactNode
  /** Optional controlled search field. Omit to hide. */
  search?: { value: string; onChange: (v: string) => void; placeholder?: string }
  /** Mobile-only bell button in the top bar (Dashboard activity rail). */
  activityUnseen?: boolean
  /** Called after the EditProfileModal saves. Lets the host page
   *  refetch any data that depends on the profile (e.g. dashboard
   *  rows that show designer-avatar columns). */
  onProfileSaved?: () => void
  children: ReactNode
}

export function DesignerChrome({
  active,
  actions,
  search,
  activityUnseen,
  onProfileSaved,
  children,
}: DesignerChromeProps) {
  const navigate = useNavigate()
  const { session, role } = useAuth()
  const userId = session?.user.id ?? null
  const [profile, setProfile] = useState<DesignerProfile | null>(null)
  const [editProfileOpen, setEditProfileOpen] = useState(false)
  // Team-chat unread comes from the shared chat engine (one live connection for
  // the whole app), so the badge here, the header dropdown and the /chat page
  // never disagree. mention + DM counts make the mobile Chat tab badge coral.
  const { unread: chatUnread, mentionUnread, dmUnread } = useTeamChat()
  // Payments received since this person last opened /orders — an event signal,
  // deliberately NOT the links-to-send worklist (jobs sit there intentionally
  // for a long time, which kept the old badge permanently lit). Computed in the
  // profile effect below against profiles.orders_seen_at (000325); seeded from
  // the warm module cache so a page switch doesn't blank-and-flash the badge.
  const [ordersUnread, setOrdersUnread] = useState(() =>
    ordersUnreadCache?.userId === userId ? ordersUnreadCache.value : 0,
  )
  // Count of open items on the Flagged board — badges the Flagged nav pill from
  // any page. Same cached-helper + seeded-initial-state pattern as ordersUnread.
  const [flaggedUnread, setFlaggedUnread] = useState(() => peekFlaggedCount() ?? 0)

  // Fetch the signed-in designer's profile for the header avatar +
  // any consumer that reads via useDesignerProfile(); the same fetch
  // also pulls orders_seen_at so the Orders badge (payments received
  // since that stamp) computes in one follow-up head-count query.
  useEffect(() => {
    if (!userId) return
    let cancelled = false
    void (async () => {
      const { data } = await supabase
        .from('profiles')
        .select('designer_initials, designer_colour, full_name, avatar_url, orders_seen_at')
        .eq('id', userId)
        .single()
      if (cancelled || !data) return
      setProfile({
        initials: (
          data.designer_initials ??
          data.full_name?.split(' ').map((n: string) => n[0]).join('') ??
          '?'
        ).slice(0, 2),
        colour: (data.designer_colour ?? 'blue') as DesignerHeaderColour,
        avatarUrl: data.avatar_url ?? null,
        firstName: data.full_name?.split(' ')[0] ?? null,
      })

      // Payments received since the stamp. Head-count only — no rows.
      const seenAt = (data.orders_seen_at as string | null) ?? null
      if (!seenAt) return
      const { count } = await supabase
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'paid')
        .gt('paid_at', seenAt)
      if (cancelled) return
      const value = count ?? 0
      // Cache before setting state so the next navigation seeds from this value
      // (userId is non-null here — the effect early-returns otherwise).
      ordersUnreadCache = { userId, value }
      setOrdersUnread(value)
    })()
    return () => {
      cancelled = true
    }
  }, [userId])

  // Flagged-board open count for the nav badge. Independent of the profile
  // fetch; the helper's 60s cache absorbs per-navigation repeats.
  useEffect(() => {
    let cancelled = false
    void getFlaggedCount().then((n) => { if (!cancelled) setFlaggedUnread(n) })
    return () => { cancelled = true }
  }, [])

  async function handleSignOut() {
    await supabase.auth.signOut()
    navigate('/login')
  }

  // Header CTAs are page-specific only now. The persistent "Quote
  // compiler" link was removed (it duplicated the "Quote" nav pill in
  // the header); the ⌘K shortcut still works — it's registered
  // globally in App.tsx via useQuoteShortcut(), not by this link.
  const headerActions = actions ?? null

  // Keyboard-aware frame height. index.html already asks for
  // interactive-widget=resizes-content, but iOS ignores it — so with the app
  // frame locked at 100dvh, the soft keyboard would simply cover the bottom
  // of the frame, including whatever field you're typing into (the chat
  // composer). Fallback: while the keyboard is up, shrink the frame to the
  // visual viewport's height so the focused field (and the tab bar) sit above
  // the keyboard; restore 100dvh when it closes. On browsers that DO honour
  // the meta, innerHeight shrinks in step with the visual viewport, the
  // measured keyboard height stays ~0, and this never fires.
  const frameRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    // A single missed resize event (iOS drops them around app switches and
    // fast keyboard dismissals) must never strand the frame at keyboard
    // height — that reappeared as "the tab bar is floating mid-screen again".
    // Three defences: the override only ever applies while an editable
    // element is genuinely focused (no keyboard without one), focus changes
    // re-evaluate directly, and a slow tick keeps re-checking while (and
    // only while) an override is active, so a stale height self-heals within
    // a second even with no events at all.
    let tick: number | null = null
    const editableFocused = () => {
      const el = document.activeElement
      if (!el) return false
      const tag = el.tagName
      return (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        (el as HTMLElement).isContentEditable
      )
    }
    const stopTick = () => {
      if (tick != null) {
        window.clearInterval(tick)
        tick = null
      }
    }
    const apply = () => {
      const el = frameRef.current
      if (!el) return
      const keyboardHeight = window.innerHeight - vv.height
      const keyboardUp =
        window.matchMedia('(max-width: 767px)').matches &&
        keyboardHeight > 80 &&
        editableFocused()
      if (keyboardUp) {
        el.style.height = `${Math.round(vv.height)}px`
        // Nothing should stay panned while the frame tracks the keyboard.
        window.scrollTo(0, 0)
        if (tick == null) tick = window.setInterval(apply, 700)
      } else {
        el.style.removeProperty('height')
        stopTick()
      }
    }
    // Focus moves settle over a couple of frames (blur → keyboard retract),
    // so re-check shortly after as well as immediately.
    const onFocusChange = () => {
      apply()
      window.setTimeout(apply, 120)
      window.setTimeout(apply, 450)
    }
    vv.addEventListener('resize', apply)
    window.addEventListener('resize', apply)
    document.addEventListener('focusin', onFocusChange)
    document.addEventListener('focusout', onFocusChange)
    document.addEventListener('visibilitychange', apply)
    window.addEventListener('pageshow', apply)
    apply()
    return () => {
      vv.removeEventListener('resize', apply)
      window.removeEventListener('resize', apply)
      document.removeEventListener('focusin', onFocusChange)
      document.removeEventListener('focusout', onFocusChange)
      document.removeEventListener('visibilitychange', apply)
      window.removeEventListener('pageshow', apply)
      stopTick()
      frameRef.current?.style.removeProperty('height')
    }
  }, [])

  return (
    <DesignerProfileContext.Provider value={profile}>
      {/* Mobile app frame. Below md the app becomes a locked, exactly
          viewport-height flex column whose middle (#app-scroll) owns ALL
          scrolling — the window itself can never scroll. This is the
          comprehensive fix for the bottom tab bar detaching on iOS: WebKit
          pans the layout viewport in several situations (keyboard, documents
          shorter than a stale scroll offset, overscroll bounce) and
          position:fixed elements ride the pan. Inside the frame the tab bar
          is positioned against the frame element instead (absolute, see
          BottomTabBar), and with zero window scrollability there is nothing
          for WebKit to mis-pan. At md:+ every class here is inert and the
          desktop layout is byte-for-byte unchanged. */}
      <div
        ref={frameRef}
        className="max-md:relative max-md:flex max-md:h-dvh max-md:flex-col max-md:overflow-hidden"
      >
        {/* The scroller is itself a flex column on mobile so a page can opt
            into filling the remaining height exactly (ChatPage does, with
            flex-1) instead of guessing at viewport maths. Normal pages are
            plain blocks inside it and scroll as before. */}
        <div
          id="app-scroll"
          className="max-md:flex max-md:min-h-0 max-md:flex-1 max-md:flex-col max-md:overflow-y-auto max-md:overscroll-contain"
        >
      <DesignerHeader
        active={active}
        role={role}
        user={{
          initials: profile?.initials ?? '…',
          colour: (profile?.colour ?? 'teal') as DesignerHeaderColour,
          avatarUrl: profile?.avatarUrl ?? null,
          name: profile?.initials ? undefined : 'Account',
        }}
        search={search}
        actions={headerActions}
        activityUnseen={activityUnseen}
        // No badge while the user is on the chat itself — the page re-stamps
        // team_chat_seen_at on open and as messages arrive.
        chatUnread={active === 'chat' ? 0 : chatUnread}
        chatMentionUnread={active === 'chat' ? 0 : mentionUnread + dmUnread}
        // No badge while the user is on the Orders page — it stamps
        // orders_seen_at on open, so they're looking at the payments now.
        ordersUnread={active === 'orders' ? 0 : ordersUnread}
        flaggedCount={flaggedUnread}
        onEditProfile={() => setEditProfileOpen(true)}
        onSignOut={handleSignOut}
      />
      {editProfileOpen && userId && (
        <EditProfileModal
          userId={userId}
          onClose={() => setEditProfileOpen(false)}
          onSaved={(payload: EditProfileSavedPayload) => {
            setProfile((prev) => ({
              initials: payload.initials,
              colour: payload.colour as DesignerHeaderColour,
              avatarUrl: payload.avatarUrl,
              // EditProfileModal's payload doesn't carry firstName,
              // so preserve the previously-loaded value rather than
              // wiping any consumer that reads it (e.g. dashboard
              // hero greeting).
              firstName: prev?.firstName ?? null,
            }))
            onProfileSaved?.()
          }}
        />
      )}
      {children}
      {/* One-time "turn on notifications?" nudge (self-gating — shows only
          when push is possible on this device and undecided). Staff chrome
          only; customers never see it. */}
      <PushNudge />
      {/* Mobile-only bottom clearance so page content can scroll clear of
          the tab bar overlaying the frame's bottom edge. One spacer here
          covers every designer page; hidden at md:+ so the desktop layout
          is untouched. */}
      <div
        aria-hidden="true"
        className="md:hidden"
        style={{ height: 'calc(64px + env(safe-area-inset-bottom))' }}
      />
        </div>
      </div>
    </DesignerProfileContext.Provider>
  )
}

export default DesignerChrome
