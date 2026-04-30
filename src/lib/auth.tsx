import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './supabase'

export type UserRole = 'admin' | 'designer'

interface AuthContextValue {
  session: Session | null
  /** Current user's role. null while we're still loading it or when signed out. */
  role: UserRole | null
  loading: boolean
}

const AuthContext = createContext<AuthContextValue>({ session: null, role: null, loading: true })

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [role, setRole] = useState<UserRole | null>(null)
  const [loading, setLoading] = useState(true)

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

  return <AuthContext.Provider value={{ session, role, loading }}>{children}</AuthContext.Provider>
}

export function useAuth() {
  return useContext(AuthContext)
}
