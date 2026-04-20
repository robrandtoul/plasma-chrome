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

    async function bootstrap(s: Session | null) {
      setSession(s)
      if (!s) {
        setRole(null)
        return
      }
      const { data } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', s.user.id)
        .maybeSingle()
      if (cancelled) return
      // Default to 'designer' for missing rows; keeps the app usable even if
      // the profile trigger somehow failed to fire.
      setRole(((data?.role as UserRole | undefined) ?? 'designer'))
    }

    supabase.auth.getSession().then(async ({ data }) => {
      await bootstrap(data.session)
      if (!cancelled) setLoading(false)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, s) => {
      bootstrap(s)
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
