import { useEffect, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../lib/auth'
import AddUserDialog from './AddUserDialog'

// ── Types ─────────────────────────────────────────────────────────────────────

interface AdminUser {
  id: string
  email: string
  full_name: string | null
  role: 'admin' | 'designer'
  deactivated_at: string | null
  created_at: string
  last_sign_in_at: string | null
}

type ActionDialog =
  | null
  | { kind: 'changeRole'; user: AdminUser }
  | { kind: 'deactivate'; user: AdminUser }
  | { kind: 'reactivate'; user: AdminUser }

// ── Helpers ───────────────────────────────────────────────────────────────────

// Relative date matching the dashboard's formatter — Today / Yesterday /
// N days ago, then absolute after 7 days.
function formatRelative(iso: string): string {
  const now = new Date()
  const then = new Date(iso)
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const thenDay = new Date(then.getFullYear(), then.getMonth(), then.getDate())
  const d = Math.floor((today.getTime() - thenDay.getTime()) / 86_400_000)
  if (d <= 0) return 'Today'
  if (d === 1) return 'Yesterday'
  if (d <= 7) return `${d} days ago`
  if (then.getFullYear() === now.getFullYear()) {
    return then.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  }
  return then.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AdminUsersPage() {
  const { session } = useAuth()
  const currentUserId = session?.user?.id ?? ''

  const [users, setUsers] = useState<AdminUser[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [actionDialog, setActionDialog] = useState<ActionDialog>(null)
  const [actionWorking, setActionWorking] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)
  const menuContainerRef = useRef<HTMLDivElement>(null)

  useEffect(() => { load() }, [])

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!openMenuId) return
      if (menuContainerRef.current && !menuContainerRef.current.contains(e.target as Node)) {
        setOpenMenuId(null)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [openMenuId])

  async function load() {
    setLoading(true)
    setLoadError(null)
    const { data, error } = await supabase.rpc('admin_list_users')
    if (error) {
      setLoadError(error.message)
      setLoading(false)
      return
    }
    setUsers((data ?? []) as AdminUser[])
    setLoading(false)
  }

  function openDialog(d: ActionDialog) {
    setActionDialog(d)
    setActionError(null)
    setOpenMenuId(null)
  }

  async function confirmChangeRole(user: AdminUser) {
    const targetRole = user.role === 'admin' ? 'designer' : 'admin'
    setActionWorking(true)
    setActionError(null)
    const { error } = await supabase
      .from('profiles')
      .update({ role: targetRole })
      .eq('id', user.id)
    setActionWorking(false)
    if (error) {
      setActionError(error.message)
      return
    }
    setActionDialog(null)
    await load()
  }

  async function confirmDeactivate(user: AdminUser) {
    setActionWorking(true)
    setActionError(null)
    const { error } = await supabase.functions.invoke('deactivate-user', { body: { user_id: user.id } })
    setActionWorking(false)
    if (error) {
      setActionError(error.message)
      return
    }
    setActionDialog(null)
    await load()
  }

  async function confirmReactivate(user: AdminUser) {
    setActionWorking(true)
    setActionError(null)
    const { error } = await supabase.functions.invoke('reactivate-user', { body: { user_id: user.id } })
    setActionWorking(false)
    if (error) {
      setActionError(error.message)
      return
    }
    setActionDialog(null)
    await load()
  }

  // Precompute counts for the last-admin guard.
  const activeAdminCount = users.filter((u) => u.role === 'admin' && !u.deactivated_at).length

  return (
    <div>
      {/* Header row */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Users</h2>
          <p className="mt-1 text-sm text-gray-500">
            Manage designer and admin accounts. Deactivated users keep their proof history.
          </p>
        </div>
        <button
          onClick={() => setShowAdd(true)}
          className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-700"
        >
          Add user
        </button>
      </div>

      {loading ? (
        <div className="flex justify-center py-20">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-200 border-t-gray-900" />
        </div>
      ) : loadError ? (
        <div className="rounded-2xl bg-rose-50 p-6 text-sm text-rose-700 ring-1 ring-rose-200">
          Failed to load users: {loadError}
        </div>
      ) : users.length === 0 ? (
        <div className="rounded-2xl bg-white py-16 text-center shadow-sm ring-1 ring-gray-200">
          <p className="text-gray-400">No users yet.</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-gray-200" ref={menuContainerRef}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100">
                <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Name</th>
                <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Email</th>
                <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Role</th>
                <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Added</th>
                <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Last sign-in</th>
                <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Status</th>
                <th className="w-12 px-5 py-3" />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const isSelf = u.id === currentUserId
                const deactivated = !!u.deactivated_at
                const isLastActiveAdmin = u.role === 'admin' && !deactivated && activeAdminCount <= 1
                return (
                  <tr key={u.id} className={['border-b border-gray-50 last:border-0', deactivated ? 'opacity-50' : ''].join(' ')}>
                    <td className="px-5 py-3 font-medium text-gray-900">{u.full_name ?? '—'}{isSelf && <span className="ml-2 text-xs font-normal text-gray-400">(you)</span>}</td>
                    <td className="px-5 py-3 text-gray-600">{u.email}</td>
                    <td className="px-5 py-3">
                      <RolePill role={u.role} />
                    </td>
                    <td className="px-5 py-3 text-gray-500">{formatRelative(u.created_at)}</td>
                    <td className="px-5 py-3 text-gray-500">{u.last_sign_in_at ? formatRelative(u.last_sign_in_at) : 'Never'}</td>
                    <td className="px-5 py-3">
                      {deactivated
                        ? <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-500">Deactivated</span>
                        : <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700">Active</span>}
                    </td>
                    <td className="px-5 py-3 text-right">
                      <div className="relative inline-block">
                        <button
                          onClick={() => setOpenMenuId(openMenuId === u.id ? null : u.id)}
                          aria-label={`Actions for ${u.full_name ?? u.email}`}
                          className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                        >
                          <svg viewBox="0 0 16 16" className="h-4 w-4" fill="currentColor">
                            <circle cx="3" cy="8" r="1.5" />
                            <circle cx="8" cy="8" r="1.5" />
                            <circle cx="13" cy="8" r="1.5" />
                          </svg>
                        </button>
                        {openMenuId === u.id && (
                          <div className="absolute right-0 top-full z-10 mt-1 w-56 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg">
                            <MenuItem
                              label={u.role === 'admin' ? 'Change to Designer' : 'Change to Admin'}
                              onClick={() => openDialog({ kind: 'changeRole', user: u })}
                              disabled={isSelf && isLastActiveAdmin}
                              disabledHint={isSelf && isLastActiveAdmin ? 'You are the last admin' : undefined}
                            />
                            {deactivated ? (
                              <MenuItem
                                label="Reactivate"
                                onClick={() => openDialog({ kind: 'reactivate', user: u })}
                                disabled={isSelf}
                              />
                            ) : (
                              <MenuItem
                                label="Deactivate"
                                onClick={() => openDialog({ kind: 'deactivate', user: u })}
                                disabled={isSelf}
                                disabledHint={isSelf ? 'You cannot deactivate yourself' : undefined}
                                danger
                              />
                            )}
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Add user dialog */}
      {showAdd && (
        <AddUserDialog
          onClose={() => setShowAdd(false)}
          onCreated={() => { load() }}
        />
      )}

      {/* Change role confirmation */}
      {actionDialog?.kind === 'changeRole' && (
        <ConfirmDialog
          message={
            `Change ${actionDialog.user.full_name ?? actionDialog.user.email}'s role ` +
            `from ${actionDialog.user.role === 'admin' ? 'Admin' : 'Designer'} ` +
            `to ${actionDialog.user.role === 'admin' ? 'Designer' : 'Admin'}?`
          }
          confirmLabel="Change role"
          confirmClass="bg-gray-900 hover:bg-gray-700 text-white"
          working={actionWorking}
          errorMsg={actionError}
          onConfirm={() => confirmChangeRole(actionDialog.user)}
          onCancel={() => { setActionDialog(null); setActionError(null) }}
        />
      )}

      {/* Deactivate confirmation */}
      {actionDialog?.kind === 'deactivate' && (
        <ConfirmDialog
          message={`Deactivate ${actionDialog.user.full_name ?? actionDialog.user.email}? They won't be able to sign in until reactivated. Their proof history will be preserved.`}
          confirmLabel="Deactivate"
          confirmClass="bg-rose-600 hover:bg-rose-700 text-white"
          working={actionWorking}
          errorMsg={actionError}
          onConfirm={() => confirmDeactivate(actionDialog.user)}
          onCancel={() => { setActionDialog(null); setActionError(null) }}
        />
      )}

      {/* Reactivate confirmation */}
      {actionDialog?.kind === 'reactivate' && (
        <ConfirmDialog
          message={`Reactivate ${actionDialog.user.full_name ?? actionDialog.user.email}?`}
          confirmLabel="Reactivate"
          confirmClass="bg-emerald-600 hover:bg-emerald-700 text-white"
          working={actionWorking}
          errorMsg={actionError}
          onConfirm={() => confirmReactivate(actionDialog.user)}
          onCancel={() => { setActionDialog(null); setActionError(null) }}
        />
      )}
    </div>
  )
}

// ── Row-level UI bits ─────────────────────────────────────────────────────────

function RolePill({ role }: { role: 'admin' | 'designer' }) {
  if (role === 'admin') {
    return <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-semibold text-indigo-700">Admin</span>
  }
  return <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-600">Designer</span>
}

function MenuItem({ label, onClick, disabled, disabledHint, danger }: {
  label: string
  onClick: () => void
  disabled?: boolean
  disabledHint?: string
  danger?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={disabled ? disabledHint : undefined}
      className={[
        'block w-full px-3 py-2 text-left text-sm transition-colors',
        disabled
          ? 'cursor-not-allowed text-gray-300'
          : danger
            ? 'text-rose-600 hover:bg-rose-50'
            : 'text-gray-700 hover:bg-gray-50',
      ].join(' ')}
    >
      {label}
    </button>
  )
}

function ConfirmDialog({ message, confirmLabel, confirmClass, working, errorMsg, onConfirm, onCancel }: {
  message: string
  confirmLabel: string
  confirmClass: string
  working: boolean
  errorMsg: string | null
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/50" onClick={() => !working && onCancel()} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
          <p className="text-sm text-gray-700">{message}</p>
          {errorMsg && <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{errorMsg}</p>}
          <div className="mt-5 flex justify-end gap-2">
            <button
              onClick={onCancel}
              disabled={working}
              className="rounded-lg px-4 py-2 text-sm font-medium text-gray-500 hover:bg-gray-100 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={onConfirm}
              disabled={working}
              className={`rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50 ${confirmClass}`}
            >
              {working ? 'Working…' : confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
