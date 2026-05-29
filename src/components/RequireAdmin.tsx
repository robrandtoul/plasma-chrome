import { Navigate } from 'react-router-dom'
import { useAuth } from '../lib/auth'

export default function RequireAdmin({ children }: { children: React.ReactNode }) {
  const { session, role, loading } = useAuth()

  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-canvas">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-line border-t-gray-900" />
      </div>
    )
  }

  if (!session) return <Navigate to="/login" replace />
  if (role !== 'admin') return <Navigate to="/" replace />

  return <>{children}</>
}
