import { Navigate } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { TrialModeBanner } from './TrialModeBanner'

export default function RequireAuth({ children }: { children: React.ReactNode }) {
  const { session, loading } = useAuth()

  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-gray-50">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-200 border-t-gray-900" />
      </div>
    )
  }

  if (!session) return <Navigate to="/login" replace />

  // TrialModeBanner is always mounted; it self-renders nothing
  // when the global customer-replies feature is enabled, so the
  // common path costs zero pixels. When the feature is paused
  // (default migration state, plus any kill-switch flip), the
  // banner shows on every authenticated page.
  return (
    <>
      <TrialModeBanner />
      {children}
    </>
  )
}
