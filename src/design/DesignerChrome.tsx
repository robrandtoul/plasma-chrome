import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { useTeamChat } from '../lib/teamChatStore'
import EditProfileModal, { type EditProfileSavedPayload } from '../components/EditProfileModal'
import PushNudge from '../components/PushNudge'
import { FEEDBACK_RESOLVED_STATUSES, isUnseenResolved } from '../lib/feedback'
import { getApprovedNoOrderCount, peekApprovedNoOrderCount } from '../lib/approvedNoOrder'
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

// Module-level cache of the signed-in user's feedback-unread count so the badge
// on the header's Feedback icon doesn't reset to 0 and flash back in on every
// navigation (each page remounts this chrome). Same seed-from-warm-cache idea
// as the Orders / Flagged nav badges, but this count is derived from the
// profile + feedback fetch in the effect below rather than a standalone cached
// helper, so the tiny cache lives here. Keyed by user id; the effect refreshes
// it on every mount, so it's stale-while-revalidate like the other badges.
let feedbackUnreadCache: { userId: string; value: number } | null = null

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
  mobileBell?: { onClick: () => void; hasUnseen: boolean }
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
  mobileBell,
  onProfileSaved,
  children,
}: DesignerChromeProps) {
  const navigate = useNavigate()
  const { session, role } = useAuth()
  const userId = session?.user.id ?? null
  const [profile, setProfile] = useState<DesignerProfile | null>(null)
  const [editProfileOpen, setEditProfileOpen] = useState(false)
  // Count of the signed-in user's own feedback items resolved (done/wont_do)
  // since they last opened the board — drives the header's Feedback badge. Seed
  // from the warm module cache (keyed by user) so a page switch doesn't blank
  // the badge and flash it back in; the effect below refreshes + re-caches it.
  const [feedbackUnread, setFeedbackUnread] = useState(() =>
    feedbackUnreadCache?.userId === userId ? feedbackUnreadCache.value : 0,
  )
  // Team-chat unread comes from the shared chat engine (one live connection for
  // the whole app), so the badge here, the header dropdown and the /chat page
  // never disagree.
  const { unread: chatUnread } = useTeamChat()
  // Count of approved proofs with no order link sent yet — badges the Orders
  // nav pill so the "Links to send" worklist is reachable from any page. Cached
  // (60s) in the helper so it doesn't re-query on every navigation. Seed the
  // initial state from the warm cache (peek*) so the badge doesn't flash 0 → N
  // and widen the pill on every page switch — the async refresh below still
  // runs, but a cache hit means the first paint already carries the count.
  const [ordersUnread, setOrdersUnread] = useState(() => peekApprovedNoOrderCount() ?? 0)
  // Count of open items on the Flagged board — badges the Flagged nav pill from
  // any page. Same cached-helper + seeded-initial-state pattern as ordersUnread.
  const [flaggedUnread, setFlaggedUnread] = useState(() => peekFlaggedCount() ?? 0)

  // Fetch the signed-in designer's profile for the header avatar +
  // any consumer that reads via useDesignerProfile(); the same fetch
  // also pulls feedback_seen_at so we can compute the Feedback badge in
  // one round trip.
  useEffect(() => {
    if (!userId) return
    let cancelled = false
    void (async () => {
      const { data } = await supabase
        .from('profiles')
        .select('designer_initials, designer_colour, full_name, avatar_url, feedback_seen_at')
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

      // The user's own resolved items, compared client-side against the
      // seen baseline via the same predicate the board uses, so the badge
      // and the on-board "new to you" highlight can never disagree.
      const seenAt = (data.feedback_seen_at as string | null) ?? null
      const { data: resolved } = await supabase
        .from('feedback_items')
        .select('created_by, status, status_changed_at')
        .eq('created_by', userId)
        .in('status', FEEDBACK_RESOLVED_STATUSES)
      if (cancelled) return
      const count = (resolved ?? []).filter((it) =>
        isUnseenResolved(it as Parameters<typeof isUnseenResolved>[0], userId, seenAt),
      ).length
      // Cache before setting state so the next navigation seeds from this value
      // (userId is non-null here — the effect early-returns otherwise).
      feedbackUnreadCache = { userId, value: count }
      setFeedbackUnread(count)
    })()
    return () => {
      cancelled = true
    }
  }, [userId])

  // The Orders badge count is independent of the profile fetch (no userId
  // dependency), so it gets its own effect. Runs once per chrome mount (i.e.
  // per navigation); the helper's 60s cache absorbs the repeats.
  useEffect(() => {
    let cancelled = false
    void getApprovedNoOrderCount().then((n) => { if (!cancelled) setOrdersUnread(n) })
    return () => { cancelled = true }
  }, [])

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

  return (
    <DesignerProfileContext.Provider value={profile}>
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
        mobileBell={mobileBell}
        // No badge while the user is already on the board — they're looking
        // at it; the board itself re-stamps feedback_seen_at on open.
        feedbackUnread={active === 'feedback' ? 0 : feedbackUnread}
        // No badge while the user is on the chat itself — the page re-stamps
        // team_chat_seen_at on open and as messages arrive.
        chatUnread={active === 'chat' ? 0 : chatUnread}
        // Both counts stay visible when their own tab is active — they simply
        // invert on the coral pill (see DesignerHeader). Hiding a badge on
        // navigation would shrink that pill and shove the pills to its right
        // sideways, so the count persists rather than clearing on arrival.
        ordersUnread={ordersUnread}
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
          the fixed BottomTabBar. One spacer here covers every designer
          page; hidden at md:+ so the desktop layout is untouched. */}
      <div
        aria-hidden="true"
        className="md:hidden"
        style={{ height: 'calc(64px + env(safe-area-inset-bottom))' }}
      />
    </DesignerProfileContext.Provider>
  )
}

export default DesignerChrome
