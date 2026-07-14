// Stand-in for src/lib/auth.tsx (aliased in by vite.verify.config.ts):
// a signed-in admin, no Supabase round-trips. Only the members the designer
// pages actually consume are provided.

/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ReactNode } from 'react'

export type UserRole = 'admin' | 'designer'
export type RecoveryState = 'none' | 'set' | 'error'

const VALUE = {
  session: { access_token: 'test-token', user: { id: 'user-rob', email: 'rob@example.test' } } as any,
  role: 'admin' as UserRole,
  loading: false,
  recovery: 'none' as RecoveryState,
  recoveryError: null as string | null,
  endRecovery: () => {},
}

export function AuthProvider({ children }: { children: ReactNode }) {
  return <>{children}</>
}

export function useAuth() {
  return VALUE
}
