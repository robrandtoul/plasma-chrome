import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'

// ── Types ────────────────────────────────────────────────────────────────────

interface AuditEntry {
  id: string
  actor_id: string | null
  actor_email: string | null
  actor_label: string | null
  action: string
  target_type: string | null
  target_id: string | null
  target_label: string | null
  created_at: string
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatRelative(iso: string): string {
  const now = new Date()
  const then = new Date(iso)
  const diffMs = now.getTime() - then.getTime()
  const diffMin = Math.floor(diffMs / 60_000)
  if (diffMin < 1) return 'Just now'
  if (diffMin < 60) return `${diffMin} min ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr} hour${diffHr === 1 ? '' : 's'} ago`
  const diffDay = Math.floor(diffHr / 24)
  if (diffDay === 1) return 'Yesterday'
  if (diffDay <= 7) return `${diffDay} days ago`
  if (then.getFullYear() === now.getFullYear()) {
    return then.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  }
  return then.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

function formatAbsolute(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function AdminActivityPage() {
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    setError(null)
    const { data, error } = await supabase
      .from('audit_log')
      .select('id, actor_id, actor_email, actor_label, action, target_type, target_id, target_label, created_at')
      .order('created_at', { ascending: false })
      .limit(50)
    if (error) {
      setError(error.message)
      setLoading(false)
      return
    }
    setEntries((data ?? []) as AuditEntry[])
    setLoading(false)
  }

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-xl font-bold text-gray-900">Activity</h2>
        <p className="mt-1 text-sm text-gray-500">
          Showing 50 most recent events. Filters and detailed views coming soon.
        </p>
      </div>

      {loading ? (
        <div className="flex justify-center py-20">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-200 border-t-gray-900" />
        </div>
      ) : error ? (
        <div className="rounded-2xl bg-rose-50 p-6 text-sm text-rose-700 ring-1 ring-rose-200">
          Failed to load activity: {error}
        </div>
      ) : entries.length === 0 ? (
        <div className="rounded-2xl bg-white py-16 text-center shadow-sm ring-1 ring-gray-200">
          <p className="text-gray-400">No activity logged yet.</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-gray-200">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100">
                <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">When</th>
                <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Actor</th>
                <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Action</th>
                <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Target</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className="border-b border-gray-50 last:border-0">
                  <td className="px-5 py-3 text-gray-500 whitespace-nowrap" title={formatAbsolute(e.created_at)}>
                    {formatRelative(e.created_at)}
                  </td>
                  <td className="px-5 py-3">
                    <div className="truncate text-sm font-medium text-gray-900">{e.actor_label ?? '—'}</div>
                    {e.actor_email && e.actor_email !== e.actor_label && (
                      <div className="truncate text-xs text-gray-400">{e.actor_email}</div>
                    )}
                  </td>
                  <td className="px-5 py-3 text-xs font-mono text-gray-700">{e.action}</td>
                  <td className="px-5 py-3 text-sm text-gray-600">{e.target_label ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
