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
import EditProfileModal, { type EditProfileSavedPayload } from '../components/EditProfileModal'
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

  // Fetch the signed-in designer's profile for the header avatar +
  // any consumer that reads via useDesignerProfile().
  useEffect(() => {
    if (!userId) return
    supabase
      .from('profiles')
      .select('designer_initials, designer_colour, full_name, avatar_url')
      .eq('id', userId)
      .single()
      .then(({ data }) => {
        if (!data) return
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
      })
  }, [userId])

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
