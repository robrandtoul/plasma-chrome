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
import { QuoteLink } from '../components/QuoteLink'
import { DesignerHeader, type DesignerNavId, type DesignerHeaderColour } from './DesignerHeader'

// Shared chrome wrapper for every designer-facing page. Owns the
// signed-in designer's profile fetch + edit-profile modal + sign-out
// handler so individual pages don't each reimplement the same ~40
// lines. Exposes the profile to children via useDesignerProfile() so
// e.g. the dashboard hero greeting can read firstName.
//
// The QuoteLink (new-tab "phone rings, jump to quote" affordance with
// the ⌘K shortcut) rides in the header's actions slot on every page —
// pages pass their own page-specific CTAs through the `actions` prop
// and they sit alongside QuoteLink.

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
  /** Page-specific CTAs rendered to the right of the QuoteLink in
   *  the header's actions slot. */
  actions?: ReactNode
  /** Optional controlled search field. Omit to hide. */
  search?: { value: string; onChange: (v: string) => void; placeholder?: string }
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

  const headerActions = actions ? (
    <>
      <QuoteLink />
      {actions}
    </>
  ) : (
    <QuoteLink />
  )

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
    </DesignerProfileContext.Provider>
  )
}

export default DesignerChrome
