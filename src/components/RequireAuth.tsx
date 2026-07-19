import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { TrialModeBanner } from './TrialModeBanner'

export default function RequireAuth({ children }: { children: React.ReactNode }) {
  const { session, loading } = useAuth()
  const location = useLocation()

  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-canvas">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-line border-t-gray-900" />
      </div>
    )
  }

  // Carry where they were trying to go. A token refresh that fails mid-session
  // lands here, and without `from` the designer signs back in and is dumped on
  // the dashboard — `replace` means Back can't recover it either. LoginPage
  // reads this and returns them to the page they were on.
  if (!session) return <Navigate to="/login" replace state={{ from: location }} />

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
