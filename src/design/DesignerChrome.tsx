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
import ViewportDebugOverlay from '../components/ViewportDebugOverlay'
import { getFlaggedCount, peekFlaggedCount } from '../lib/flaggedCount'
import {
  describeTarget,
  glueMode,
  installDebugProbes,
  viewportDebugEnabled,
  vpLog,
} from '../lib/viewportDebug'
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
  // TEMPORARY: passive diagnostics (touchstart / keyboard-presented /
  // focused-node-integrity / programmatic-focus tripwire). No-op unless the
  // debug overlay is enabled. Runs in EVERY glue mode — pure observation.
  useEffect(() => installDebugProbes(), [])
  useEffect(() => {
    const vv = window.visualViewport
    // TEMPORARY debug instrumentation (see src/lib/viewportDebug.ts). The
    // glue can run in three modes so one Netlify preview can A/B the
    // behaviour on-device without a rebuild:
    //   main — exactly the behaviour main shipped (below, unchanged)
    //   off  — install NOTHING: pure CSS h-dvh frame, no listeners at all
    //   blur — hands-off while an editable element is focused (no height
    //          write, no transform, no scroll snap, no nudge); restore only
    //          when nothing is focused
    // vpLog() calls are no-ops in effect (array push) unless the overlay is
    // reading them; they exist so on-device screenshots show exactly which
    // mutation fired when, relative to focus and the vv events.
    const mode = glueMode()
    vpLog('glue-init', `mode=${mode}`)
    if (mode === 'off') return
    // Mobile viewport glue — the one-pass fix after every event-driven
    // approach failed on device. iOS gives three "viewport height" signals
    // (100dvh, window.innerHeight, visualViewport.height) that DISAGREE in
    // the standalone PWA: when the soft keyboard opens the webview resizes
    // but dvh does not follow, so a dvh-sized frame kept extending
    // underneath the keyboard (composer + tab bar hidden behind it), and
    // iOS's caret-chasing pan then stranded the layout when the keyboard
    // closed. The only signal that always matches what the user can see is
    // visualViewport.height — so below md the frame's height is driven from
    // it directly AT ALL TIMES: on every viewport/focus/visibility event,
    // and verified by a permanent 1s tick so a missed event can never
    // strand a stale height. Any stray window pan is snapped back in the
    // same pass. The h-dvh class remains only as the pre-JS first paint.
    // Each height signal is only trusted where it's honest. While an editable
    // element is focused (the only time a keyboard can be up), follow
    // visualViewport.height — the true visible area during typing. The moment
    // nothing is focused, hand the frame back to CSS h-dvh: after a
    // dismissal iOS sometimes NEVER updates visualViewport/innerHeight (they
    // keep reporting the keyboard's inset — Rob's bar floating at the old
    // keyboard top), but dvh always reads the full screen in the PWA, so the
    // release can't be lied to.
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
    const apply = (why: string) => {
      const el = frameRef.current
      if (!el) return
      if (!window.matchMedia('(max-width: 767px)').matches) {
        el.style.removeProperty('height')
        el.style.removeProperty('transform')
        return
      }
      const focused = editableFocused()
      // blur mode: while an editable element is focused, do NOTHING AT ALL —
      // no height write, no transform, no scroll snap. The hypothesis under
      // test is that ANY focus-time mutation is what makes iOS abandon
      // keyboard presentation.
      if (mode === 'blur' && focused) return
      if (focused) {
        const h = Math.round(vv?.height ?? window.innerHeight)
        if (h > 0) {
          const next = `${h}px`
          if (el.style.height !== next) {
            el.style.height = next
            vpLog('height-write', `${next} (${why})`)
          }
        }
        // NEVER counter-shift while a field is focused: during keyboard
        // open iOS pans legitimately to lift the input above the keyboard,
        // and compensating against that becomes a tug-of-war that ends with
        // iOS abandoning the keyboard entirely (Rob: "no keyboard at all").
        if (el.style.transform) {
          el.style.removeProperty('transform')
          vpLog('transform-clear', why)
        }
      } else {
        if (el.style.height) {
          el.style.removeProperty('height')
          vpLog('height-release', why)
        }
        // iOS sometimes leaves its keyboard pan behind after dismissal —
        // the entire rendered surface sits shifted up in a layer JS
        // scrolling cannot reach (the user can literally thumb-drag it
        // back). With nothing focused the keyboard is gone, so ANY
        // remaining visualViewport.offsetTop is exactly that stuck pan:
        // counter-shift the frame by it so the app stays aligned with the
        // visible area; the shift comes straight off when iOS (or a drag)
        // restores the pan. The vv 'scroll' listener keeps this live.
        const pan = Math.round(vv?.offsetTop ?? 0)
        if (pan > 0) {
          const shift = `translateY(${pan}px)`
          if (el.style.transform !== shift) {
            el.style.transform = shift
            vpLog('counter-shift', `${pan}px (${why})`)
          }
        } else if (el.style.transform) {
          el.style.removeProperty('transform')
          vpLog('counter-shift-clear', why)
        }
      }
      if (window.scrollY > 0) {
        vpLog('scroll-snap', `scrollY=${Math.round(window.scrollY)} (${why})`)
        window.scrollTo(0, 0)
      }
    }
    // Focus / orientation / app-switch changes settle over a few frames
    // (keyboard animation, webview resize), so re-check shortly after too.
    // The 1px scroll nudge runs WebKit's clamp path, which un-sticks a
    // stranded visual pan even though the document itself can't scroll.
    // (In blur mode the nudge is suppressed while a field is focused — a
    // scroll during keyboard presentation is itself a prime suspect.)
    const settle = (why: string) => {
      apply(why)
      window.setTimeout(() => {
        apply(`${why}+150ms`)
        if (mode === 'main' || !editableFocused()) {
          vpLog('scroll-nudge', why)
          window.scrollTo(0, 1)
          window.scrollTo(0, 0)
        }
      }, 150)
      window.setTimeout(() => apply(`${why}+450ms`), 450)
    }
    const vals = () =>
      `vv.h=${vv ? Math.round(vv.height) : '–'} vv.top=${vv ? Math.round(vv.offsetTop) : '–'} ih=${window.innerHeight} sy=${Math.round(window.scrollY)}`
    const onVvResize = () => {
      vpLog('vv-resize', vals())
      apply('vv-resize')
    }
    const onVvScroll = () => {
      vpLog('vv-scroll', vals())
      apply('vv-scroll')
    }
    const onWinResize = () => {
      vpLog('win-resize', vals())
      apply('win-resize')
    }
    const onOrientation = () => {
      vpLog('orientationchange', vals())
      settle('orientation')
    }
    const onFocusIn = (e: FocusEvent) => {
      vpLog('focusin', `${describeTarget(e.target)} ${vals()}`)
      settle('focusin')
    }
    const onFocusOut = (e: FocusEvent) => {
      vpLog('focusout', `${describeTarget(e.target)} ${vals()}`)
      settle('focusout')
    }
    const onVisibility = () => {
      vpLog('visibilitychange', document.visibilityState)
      settle('visibility')
    }
    const onPageShow = () => {
      vpLog('pageshow', vals())
      settle('pageshow')
    }
    vv?.addEventListener('resize', onVvResize)
    vv?.addEventListener('scroll', onVvScroll)
    window.addEventListener('resize', onWinResize)
    window.addEventListener('orientationchange', onOrientation)
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('focusout', onFocusOut)
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pageshow', onPageShow)
    const tick = window.setInterval(() => apply('tick'), 1000)
    apply('mount')
    return () => {
      vv?.removeEventListener('resize', onVvResize)
      vv?.removeEventListener('scroll', onVvScroll)
      window.removeEventListener('resize', onWinResize)
      window.removeEventListener('orientationchange', onOrientation)
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('focusout', onFocusOut)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pageshow', onPageShow)
      window.clearInterval(tick)
      frameRef.current?.style.removeProperty('height')
      frameRef.current?.style.removeProperty('transform')
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
        data-app-frame=""
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
      {/* TEMPORARY on-device viewport diagnostics — on by default on Netlify
          deploy previews, off in production unless ?debug=1 was visited.
          Portalled to document.body so the frame's inline styles never move
          it. Removed once the keyboard fix is confirmed on-device. */}
      {viewportDebugEnabled() && <ViewportDebugOverlay />}
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
