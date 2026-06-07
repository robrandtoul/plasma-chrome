import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './supabase'

export type UserRole = 'admin' | 'designer'

// Password-recovery (admin-triggered email link) state.
//   'set'   -> on a valid recovery link; show the set-new-password screen.
//   'error' -> the link was expired or already used; show a friendly notice.
export type RecoveryState = 'none' | 'set' | 'error'

interface AuthContextValue {
  session: Session | null
  /** Current user's role. null while we're still loading it or when signed out. */
  role: UserRole | null
  loading: boolean
  /** Password-recovery flow state, driven by the recovery link's URL hash and
      the PASSWORD_RECOVERY auth event. */
  recovery: RecoveryState
  recoveryError: string | null
  /** Leave the recovery flow (after a successful set, or from the error screen)
      and tidy the URL hash. */
  endRecovery: () => void
}

const AuthContext = createContext<AuthContextValue>({
  session: null,
  role: null,
  loading: true,
  recovery: 'none',
  recoveryError: null,
  endRecovery: () => {},
})

// Capture the URL hash at module load, BEFORE supabase-js's detectSessionInUrl
// consumes it. The admin recovery email links to
// https://...supabase.co/auth/v1/verify?...&type=recovery&redirect_to=<app>,
// which verifies and redirects to the app with tokens in the URL hash (implicit
// flow). Reading the hash here means:
//   * we can show the set-password screen even if the PASSWORD_RECOVERY event
//     fires before our onAuthStateChange listener subscribes, and
//   * we can recognise an expired / already-used link, which arrives as
//     #error=access_denied&error_code=otp_expired&error_description=... and
//     fires no auth event at all.
const INITIAL_HASH = typeof window !== 'undefined' ? window.location.hash : ''

function readRecoveryFromHash(): { state: RecoveryState; error: string | null } {
  const params = new URLSearchParams(INITIAL_HASH.replace(/^#/, ''))
  if (params.get('error') || params.get('error_code') || params.get('error_description')) {
    return {
      state: 'error',
      error:
        'This reset link has expired or has already been used. Ask an admin to send you a new one.',
    }
  }
  if (params.get('type') === 'recovery') return { state: 'set', error: null }
  return { state: 'none', error: null }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [role, setRole] = useState<UserRole | null>(null)
  const [loading, setLoading] = useState(true)
  const [recoveryInit] = useState(readRecoveryFromHash)
  const [recovery, setRecovery] = useState<RecoveryState>(recoveryInit.state)
  const [recoveryError, setRecoveryError] = useState<string | null>(recoveryInit.error)

  const endRecovery = useCallback(() => {
    setRecovery('none')
    setRecoveryError(null)
    // Drop the recovery hash so a refresh doesn't re-open the screen. (For a
    // successful 'set' supabase-js has already cleaned the token hash; this also
    // covers the error case, whose hash carries no token.)
    if (typeof window !== 'undefined' && window.location.hash) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    // Monotonic id so a slower in-flight bootstrap can't overwrite the
    // results of a newer one (sign-in immediately followed by token
    // refresh). Without this the role for the older session could
    // win the last-write race.
    let bootstrapId = 0
    // Last bootstrapped user id — closure-tracked rather than read
    // from React state so the auth-event callback sees the
    // up-to-date value without re-subscribing each render.
    let currentUserId: string | null = null

    async function bootstrap(s: Session | null) {
      const id = ++bootstrapId
      // Flip loading on every transition so RequireAuth/RequireAdmin
      // show the spinner instead of redirecting on the brief window
      // where session is set but the profile fetch hasn't returned.
      setLoading(true)
      setSession(s)
      currentUserId = s?.user.id ?? null
      if (!s) {
        setRole(null)
        if (!cancelled && id === bootstrapId) setLoading(false)
        return
      }
      const { data } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', s.user.id)
        .maybeSingle()
      if (cancelled || id !== bootstrapId) return
      // Default to 'designer' for missing rows; keeps the app usable even if
      // the profile trigger somehow failed to fire.
      setRole(((data?.role as UserRole | undefined) ?? 'designer'))
      setLoading(false)
    }

    void supabase.auth.getSession().then(({ data }) => bootstrap(data.session))

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, s) => {
      // A recovery link establishes a session and fires PASSWORD_RECOVERY; flag
      // it so the app shows the set-password screen instead of dropping the user
      // on the dashboard signed in (the bug this fixes). The initial-hash read
      // above is the backstop for the case where this fires before we subscribe.
      if (event === 'PASSWORD_RECOVERY') setRecovery('set')
      // INITIAL_SESSION fires once on subscribe; getSession() above
      // already handles that bootstrap, so skip to avoid a redundant
      // role re-fetch.
      if (event === 'INITIAL_SESSION') return
      // Tab-visibility quirk in supabase-js: SIGNED_IN /
      // TOKEN_REFRESHED re-fire when the tab regains focus even
      // though the user identity is unchanged. Refresh the session
      // in state silently (so future calls carry the new access
      // token) but don't flip loading or re-fetch role — that would
      // remount auth-gated routes and read as a hard page refresh.
      // Sign-out (s=null) falls through because null !== currentUserId
      // unless we're already signed out.
      if (s?.user.id != null && s.user.id === currentUserId) {
        setSession(s)
        return
      }
      void bootstrap(s)
    })

    return () => {
      cancelled = true
      subscription.unsubscribe()
    }
  }, [])

  return (
    <AuthContext.Provider
      value={{ session, role, loading, recovery, recoveryError, endRecovery }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
