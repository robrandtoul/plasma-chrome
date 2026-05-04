import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../lib/auth'
import { logAudit } from '../../lib/audit'
import AddUserDialog from './AddUserDialog'
import Modal from '../../components/Modal'

// ── Types ─────────────────────────────────────────────────────────────────────

interface AdminUser {
  id: string
  email: string
  full_name: string | null
  role: 'admin' | 'designer'
  deactivated_at: string | null
  created_at: string
  last_sign_in_at: string | null
  /** Per-designer Help Scout user id (migration 000123).
   *  Null = falls back to HELPSCOUT_DEFAULT_USER_ID at reply time. */
  helpscout_user_id: number | null
}

type ActionDialog =
  | null
  | { kind: 'changeRole'; user: AdminUser }
  | { kind: 'deactivate'; user: AdminUser }
  | { kind: 'reactivate'; user: AdminUser }
  | { kind: 'sendPasswordReset'; user: AdminUser }
  | { kind: 'setPassword'; user: AdminUser }
  | { kind: 'setHelpscoutUserId'; user: AdminUser }

// Charset + length match AddUserDialog so generated overrides feel
// consistent across the admin surface (no 0/O, 1/l/I).
const PW_CHARS = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
function generatePassword(length = 12): string {
  const arr = new Uint32Array(length)
  crypto.getRandomValues(arr)
  let out = ''
  for (let i = 0; i < length; i++) out += PW_CHARS[arr[i] % PW_CHARS.length]
  return out
}

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
  // Per-open placement decision. The menu is rendered with
  // position: fixed and viewport-relative coordinates derived
  // from the trigger button's bounding rect — so the menu
  // escapes the table wrapper's overflow clip (necessary now
  // that the wrapper has overflow-x-auto for narrow viewports).
  // Default 'down' placement; the useLayoutEffect below flips
  // to 'up' when the natural-down placement would clip below
  // the viewport. Reset on each open so a previously-flipped
  // row doesn't carry stale placement to the next click.
  const [menuPlacement, setMenuPlacement] = useState<'down' | 'up'>('down')
  const [openTriggerRect, setOpenTriggerRect] = useState<DOMRect | null>(null)
  const openMenuRef = useRef<HTMLDivElement | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  // Set-password modal state — reset every time the dialog opens so a
  // typo'd password never bleeds across sessions.
  const [pwInput, setPwInput] = useState('')
  const [pwShow, setPwShow] = useState(false)
  // Set-Help-Scout-user-id modal state. Empty string = "no value
  // entered" (treated as a clear when saved). Each modal open
  // pre-fills with the user's current helpscout_user_id.
  const [hsIdInput, setHsIdInput] = useState('')

  useEffect(() => { load() }, [])

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!openMenuId) return
      if (menuContainerRef.current && !menuContainerRef.current.contains(e.target as Node)) {
        setOpenMenuId(null)
        setOpenTriggerRect(null)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [openMenuId])

  // Flip the per-row kebab menu when natural-down placement would
  // clip below the viewport. Runs synchronously after mount via
  // useLayoutEffect — setState inside it triggers a re-render
  // before paint, so the user never sees the down→up jump.
  //
  // Algorithm: every open starts with placement='down' (the kebab
  // onClick resets it). The effect measures the menu's rendered
  // rect; if rect.bottom overflows past a 16px safety margin,
  // flip to 'up' — but only if there's room above. The dep array
  // is [openMenuId] only, so the post-flip re-render doesn't
  // loop the effect.
  useLayoutEffect(() => {
    if (!openMenuId || !openTriggerRect) return
    const el = openMenuRef.current
    if (!el) return
    const SAFE_MARGIN = 16
    const rect = el.getBoundingClientRect()
    if (rect.bottom > window.innerHeight - SAFE_MARGIN) {
      // Room above? If yes, flip up. If no (e.g. the page is
      // longer than the viewport AND the kebab is near the top),
      // leave it as-is — clipping below is no worse than clipping
      // above, and the page is naturally scrollable.
      if (openTriggerRect.top - rect.height - 4 >= SAFE_MARGIN) {
        setMenuPlacement('up')
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openMenuId])

  // Close the menu on any scroll or resize. Fixed-position
  // coordinates were captured from the trigger's rect at open
  // time, so a scroll event would visually disconnect the menu
  // from its trigger. Closing matches the standard dropdown
  // convention and is cheaper than continuously re-anchoring.
  useEffect(() => {
    if (!openMenuId) return
    const close = () => setOpenMenuId(null)
    // Capture-phase + passive so we catch scrolls inside any
    // overflow ancestor (e.g. the table's overflow-x-auto
    // wrapper) without preventing them.
    window.addEventListener('scroll', close, { capture: true, passive: true })
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('scroll', close, { capture: true } as any)
      window.removeEventListener('resize', close)
    }
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
    setOpenTriggerRect(null)
    // setPassword modal opens with a freshly-generated default. Admin
    // can clear + replace, or click Generate again. Reset every open
    // to avoid leaking the previous target's input.
    if (d?.kind === 'setPassword') {
      setPwInput(generatePassword(12))
      setPwShow(false)
    } else {
      setPwInput('')
      setPwShow(false)
    }
    // setHelpscoutUserId modal pre-fills with the user's current
    // mapping, or empty when null. Reset on every open so the
    // previous target's value never bleeds across.
    if (d?.kind === 'setHelpscoutUserId') {
      const current = d.user.helpscout_user_id
      setHsIdInput(current == null ? '' : String(current))
    } else {
      setHsIdInput('')
    }
  }

  function showToast(message: string) {
    setToast(message)
    window.setTimeout(() => setToast(null), 3000)
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
    void logAudit({
      action: 'user.role_changed',
      targetType: 'user',
      targetId: user.id,
      targetLabel: user.full_name ?? user.email,
      beforeValue: { role: user.role },
      afterValue: { role: targetRole },
    })
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

  // Standard Supabase recovery flow — fires the project's recovery
  // email template against the user's address. The admin doesn't see
  // the link itself; only confirmation that the email was queued.
  async function confirmSendPasswordReset(user: AdminUser) {
    setActionWorking(true)
    setActionError(null)
    const { data, error } = await supabase.functions.invoke<{
      status?: 'ok' | 'failed'; reason?: string; detail?: string; error?: string
    }>('admin-user-password', {
      body: { userId: user.id, mode: 'reset_email' },
    })
    setActionWorking(false)
    if (error) {
      setActionError(error.message)
      return
    }
    if (data?.status !== 'ok') {
      setActionError(data?.detail ?? data?.error ?? data?.reason ?? 'Failed to send reset email')
      return
    }
    setActionDialog(null)
    showToast(`Password reset email sent to ${user.email}`)
  }

  async function confirmSetPassword(user: AdminUser, password: string) {
    if (password.length < 8) {
      setActionError('Password must be at least 8 characters.')
      return
    }
    setActionWorking(true)
    setActionError(null)
    const { data, error } = await supabase.functions.invoke<{
      status?: 'ok' | 'failed'; reason?: string; detail?: string; error?: string
    }>('admin-user-password', {
      body: { userId: user.id, mode: 'set', newPassword: password },
    })
    setActionWorking(false)
    if (error) {
      setActionError(error.message)
      return
    }
    if (data?.status !== 'ok') {
      setActionError(data?.detail ?? data?.error ?? data?.reason ?? 'Failed to update password')
      return
    }
    setActionDialog(null)
    showToast(`Password updated for ${user.full_name ?? user.email}`)
  }

  // Save / clear the per-designer Help Scout user id mapping.
  // Empty input → null (clear). Any other input must parse as a
  // positive integer. Validation is mirrored on the edge function;
  // surfacing it client-side here keeps the modal copy useful.
  async function confirmSetHelpscoutUserId(user: AdminUser, raw: string) {
    const trimmed = raw.trim()
    let nextValue: number | null
    if (trimmed === '') {
      nextValue = null
    } else {
      const parsed = Number(trimmed)
      if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
        setActionError('Help Scout user ID must be a positive integer.')
        return
      }
      nextValue = parsed
    }
    setActionWorking(true)
    setActionError(null)
    const { data, error } = await supabase.functions.invoke<{
      status?: 'ok' | 'failed'; reason?: string; detail?: string; error?: string
    }>('admin-set-helpscout-user-id', {
      body: { userId: user.id, helpscoutUserId: nextValue },
    })
    setActionWorking(false)
    if (error) {
      setActionError(error.message)
      return
    }
    if (data?.status !== 'ok') {
      setActionError(data?.detail ?? data?.error ?? data?.reason ?? 'Failed to update mapping')
      return
    }
    setActionDialog(null)
    showToast(
      nextValue == null
        ? `Help Scout user ID cleared for ${user.full_name ?? user.email}`
        : `Help Scout user ID updated for ${user.full_name ?? user.email}`,
    )
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
        // overflow-x-auto so eight columns + a kebab don't squeeze
        // into illegible 70-90px slivers on a narrow viewport
        // (laptop with a side panel open). The kebab menu used to
        // be CSS-absolute-positioned inside this wrapper, which
        // forced overflow-x: visible to avoid clipping it; the
        // menu now renders with position: fixed (anchored to its
        // trigger's bounding rect) so it escapes any overflow
        // ancestor and the wrapper can clip horizontally without
        // hiding menu items. overflow-y stays hidden to preserve
        // the rounded-2xl corner mask on the top + bottom edges.
        <div className="overflow-x-auto overflow-y-hidden rounded-2xl bg-white shadow-sm ring-1 ring-gray-200" ref={menuContainerRef}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100">
                <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Name</th>
                <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Email</th>
                <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Role</th>
                <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Added</th>
                <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Last sign-in</th>
                <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400" title="Help Scout user ID — used to attribute staff replies. Default = HELPSCOUT_DEFAULT_USER_ID env var.">HS user</th>
                <th className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Status</th>
                <th className="w-12 px-5 py-3" />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const isSelf = u.id === currentUserId
                const deactivated = !!u.deactivated_at
                const isLastActiveAdmin = u.role === 'admin' && !deactivated && activeAdminCount <= 1
                // Deactivated rows used to apply opacity-50 to the
                // <tr>, but CSS opacity propagates to descendants and
                // creates a stacking context — so the kebab menu's
                // bg-white was rendered at α=0.5 (letting rows beneath
                // bleed through) and disabled vs enabled menu-item
                // text-greys collapsed into the same washed-out tone.
                // Replaced with explicit muted text colours on the
                // text cells; the kebab cell stays at full opacity so
                // the menu surface is clean. The Status pill still
                // carries the primary "deactivated" visual signal.
                const textCellClass = deactivated
                  ? 'px-5 py-3 text-gray-400'
                  : 'px-5 py-3 text-gray-600'
                const subtleCellClass = deactivated
                  ? 'px-5 py-3 text-gray-300'
                  : 'px-5 py-3 text-gray-500'
                return (
                  <tr key={u.id} className="border-b border-gray-50 last:border-0">
                    <td className={['px-5 py-3 font-medium', deactivated ? 'text-gray-400' : 'text-gray-900'].join(' ')}>
                      {u.full_name ?? '—'}{isSelf && <span className="ml-2 text-xs font-normal text-gray-400">(you)</span>}
                    </td>
                    <td className={textCellClass}>{u.email}</td>
                    <td className="px-5 py-3">
                      <RolePill role={u.role} muted={deactivated} />
                    </td>
                    <td className={subtleCellClass}>{formatRelative(u.created_at)}</td>
                    <td className={subtleCellClass}>{u.last_sign_in_at ? formatRelative(u.last_sign_in_at) : 'Never'}</td>
                    <td className={subtleCellClass}>
                      {u.helpscout_user_id == null
                        ? <span className="text-gray-400" title="No mapping — falls back to HELPSCOUT_DEFAULT_USER_ID">Default</span>
                        : <span className="font-mono">{u.helpscout_user_id}</span>}
                    </td>
                    <td className="px-5 py-3">
                      {deactivated
                        ? <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-500">Deactivated</span>
                        : <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700">Active</span>}
                    </td>
                    <td className="px-5 py-3 text-right">
                      <div className="relative inline-block">
                        <button
                          onClick={(e) => {
                            // Opening a different row's menu: reset
                            // placement to 'down' so the layout
                            // effect measures from the natural
                            // position. Capture the trigger rect
                            // so the menu can render with fixed
                            // positioning anchored to it. Closing
                            // (same id): just null out openMenuId;
                            // placement is ignored when closed.
                            if (openMenuId === u.id) {
                              setOpenMenuId(null)
                              setOpenTriggerRect(null)
                            } else {
                              setMenuPlacement('down')
                              setOpenTriggerRect(e.currentTarget.getBoundingClientRect())
                              setOpenMenuId(u.id)
                            }
                          }}
                          aria-label={`Actions for ${u.full_name ?? u.email}`}
                          className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                        >
                          <svg viewBox="0 0 16 16" className="h-4 w-4" fill="currentColor">
                            <circle cx="3" cy="8" r="1.5" />
                            <circle cx="8" cy="8" r="1.5" />
                            <circle cx="13" cy="8" r="1.5" />
                          </svg>
                        </button>
                        {openMenuId === u.id && openTriggerRect && (
                          <div
                            ref={openMenuRef}
                            // Fixed-positioned so the menu escapes
                            // the table wrapper's overflow-x-auto
                            // clip. Coordinates are derived from
                            // the trigger's bounding rect captured
                            // at open time; the close-on-scroll
                            // effect above means we never have to
                            // reposition mid-life.
                            style={
                              menuPlacement === 'up'
                                ? {
                                    position: 'fixed',
                                    bottom: window.innerHeight - openTriggerRect.top + 4,
                                    right: window.innerWidth - openTriggerRect.right,
                                  }
                                : {
                                    position: 'fixed',
                                    top: openTriggerRect.bottom + 4,
                                    right: window.innerWidth - openTriggerRect.right,
                                  }
                            }
                            className="z-50 w-56 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg"
                          >
                            {/* Send password reset — primary affordance.
                                Disabled for deactivated users (their auth
                                row is banned, so any reset would land
                                them unable to actually use the link). */}
                            <MenuItem
                              label="Send password reset"
                              onClick={() => openDialog({ kind: 'sendPasswordReset', user: u })}
                              disabled={deactivated}
                              disabledHint={deactivated ? 'Reactivate the user first' : undefined}
                            />
                            <MenuItem
                              label={u.role === 'admin' ? 'Change to Designer' : 'Change to Admin'}
                              onClick={() => openDialog({ kind: 'changeRole', user: u })}
                              disabled={deactivated || (isSelf && isLastActiveAdmin)}
                              disabledHint={
                                deactivated
                                  ? 'Reactivate the user first'
                                  : isSelf && isLastActiveAdmin
                                    ? 'You are the last admin'
                                    : undefined
                              }
                            />
                            {/* Per-designer HS user attribution
                                (migration 000123). Same disabled rule
                                as Change role — a deactivated user
                                isn't sending replies anyway, so the
                                mapping has no effect; lock it down
                                until they're reactivated for the same
                                "no orphaned config on banned accounts"
                                reason as the password actions. */}
                            <MenuItem
                              label="Set Help Scout user ID…"
                              onClick={() => openDialog({ kind: 'setHelpscoutUserId', user: u })}
                              disabled={deactivated}
                              disabledHint={deactivated ? 'Reactivate the user first' : undefined}
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
                            {/* Override case — set a new password directly.
                                Divider above signals this is distinct
                                from the primary actions; "Set new
                                password…" trailing ellipsis hints at the
                                modal it opens. Disabled for deactivated
                                users for the same reason as the reset
                                email (their auth row is banned). */}
                            <div className="border-t border-gray-100" />
                            <MenuItem
                              label="Set new password…"
                              onClick={() => openDialog({ kind: 'setPassword', user: u })}
                              disabled={deactivated}
                              disabledHint={deactivated ? 'Reactivate the user first' : undefined}
                            />
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

      {/* Send password reset confirmation —
          standard recovery email flow. The link goes to the user's
          email; the admin only sees confirmation that the email was
          queued. */}
      {actionDialog?.kind === 'sendPasswordReset' && (
        <ConfirmDialog
          message={`Send a password reset email to ${actionDialog.user.email}? They'll receive a recovery link they can use to set a new password themselves.`}
          confirmLabel="Send reset email"
          confirmClass="bg-gray-900 hover:bg-gray-700 text-white"
          working={actionWorking}
          errorMsg={actionError}
          onConfirm={() => confirmSendPasswordReset(actionDialog.user)}
          onCancel={() => { setActionDialog(null); setActionError(null) }}
        />
      )}

      {/* Set-new-password modal —
          override case for when the admin needs to give a user a
          temporary password directly. Distinct from the recovery
          email flow: the admin sees the password they're setting,
          and shares it out-of-band. Same Generate/Show/Hide pattern
          as AddUserDialog so the muscle memory carries over. */}
      {actionDialog?.kind === 'setPassword' && (
        <SetPasswordDialog
          user={actionDialog.user}
          password={pwInput}
          showPassword={pwShow}
          onPasswordChange={setPwInput}
          onToggleShow={() => setPwShow(v => !v)}
          onGenerate={() => setPwInput(generatePassword(12))}
          working={actionWorking}
          errorMsg={actionError}
          onConfirm={() => confirmSetPassword(actionDialog.user, pwInput)}
          onCancel={() => { setActionDialog(null); setActionError(null) }}
        />
      )}

      {/* Set Help Scout user ID modal —
          per-designer mapping that overrides the project-wide
          HELPSCOUT_DEFAULT_USER_ID env var when sending staff
          replies via send-helpscout-reply. Empty input = clear
          the mapping (designer falls back to the default). */}
      {actionDialog?.kind === 'setHelpscoutUserId' && (
        <SetHelpscoutUserIdDialog
          user={actionDialog.user}
          value={hsIdInput}
          onChange={setHsIdInput}
          onClear={() => setHsIdInput('')}
          working={actionWorking}
          errorMsg={actionError}
          onConfirm={() => confirmSetHelpscoutUserId(actionDialog.user, hsIdInput)}
          onCancel={() => { setActionDialog(null); setActionError(null) }}
        />
      )}

      {toast && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-gray-900 px-5 py-2.5 text-sm font-medium text-white shadow-lg">
          {toast}
        </div>
      )}
    </div>
  )
}

// ── Row-level UI bits ─────────────────────────────────────────────────────────

function RolePill({ role, muted }: { role: 'admin' | 'designer'; muted?: boolean }) {
  // Muted variant for deactivated rows — replaces the previous
  // opacity-50 propagation. Same shape, faded fill + text so the
  // pill still reads as a role marker but recedes alongside the
  // rest of the row's text.
  if (role === 'admin') {
    const cls = muted
      ? 'rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-semibold text-indigo-300'
      : 'rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-semibold text-indigo-700'
    return <span className={cls}>Admin</span>
  }
  const cls = muted
    ? 'rounded-full bg-gray-50 px-2 py-0.5 text-xs font-semibold text-gray-400'
    : 'rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-600'
  return <span className={cls}>Designer</span>
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
    <Modal
      open
      onClose={onCancel}
      preventClose={working}
      ariaLabel="Confirm action"
      panelClassName="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl"
    >
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
    </Modal>
  )
}

function SetPasswordDialog({
  user, password, showPassword, onPasswordChange, onToggleShow, onGenerate,
  working, errorMsg, onConfirm, onCancel,
}: {
  user: AdminUser
  password: string
  showPassword: boolean
  onPasswordChange: (v: string) => void
  onToggleShow: () => void
  onGenerate: () => void
  working: boolean
  errorMsg: string | null
  onConfirm: () => void
  onCancel: () => void
}) {
  const inputClass = 'w-full rounded-lg border border-gray-300 px-3 py-2 text-[17px] sm:text-sm focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900'
  return (
    <Modal
      open
      onClose={onCancel}
      preventClose={working}
      ariaLabelledBy="set-password-title"
    >
      <div>
        <h3 id="set-password-title" className="text-lg font-semibold text-gray-900">Set new password</h3>
        <p className="mt-1 text-xs text-gray-500">
          Override the password for {user.full_name ?? user.email}. Share the new password with them out-of-band — they'll be signed out of any active sessions and need to use this to sign in next time.
        </p>
      </div>

      <div className="mt-4">
        <label className="mb-1.5 block text-sm font-medium text-gray-700">
          New password <span className="text-rose-500">*</span>
        </label>
        <div className="flex gap-2">
          <input
            type={showPassword ? 'text' : 'password'}
            value={password}
            onChange={(e) => onPasswordChange(e.target.value)}
            disabled={working}
            className={inputClass + ' font-mono'}
            placeholder="At least 8 characters"
          />
          <button
            type="button"
            onClick={onGenerate}
            disabled={working}
            className="shrink-0 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
          >
            Generate
          </button>
          <button
            type="button"
            onClick={onToggleShow}
            disabled={working}
            aria-label={showPassword ? 'Hide password' : 'Show password'}
            className="shrink-0 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
          >
            {showPassword ? 'Hide' : 'Show'}
          </button>
        </div>
      </div>

      {errorMsg && <p className="mt-4 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{errorMsg}</p>}

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
          disabled={working || password.length < 8}
          className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-700 disabled:opacity-50"
        >
          {working ? 'Setting…' : 'Set password'}
        </button>
      </div>
    </Modal>
  )
}

function SetHelpscoutUserIdDialog({
  user, value, onChange, onClear, working, errorMsg, onConfirm, onCancel,
}: {
  user: AdminUser
  value: string
  onChange: (v: string) => void
  onClear: () => void
  working: boolean
  errorMsg: string | null
  onConfirm: () => void
  onCancel: () => void
}) {
  const inputClass = 'w-full rounded-lg border border-gray-300 px-3 py-2 text-[17px] sm:text-sm focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900'
  // Save label flips between Clear / Save based on whether the input
  // is empty — the empty case sends null to the edge function, which
  // clears the mapping. Distinct labels make the destructive case
  // explicit before the click.
  const trimmed = value.trim()
  const isClearing = trimmed === ''
  return (
    <Modal
      open
      onClose={onCancel}
      preventClose={working}
      ariaLabelledBy="set-hs-user-title"
    >
      <div>
        <h3 id="set-hs-user-title" className="text-lg font-semibold text-gray-900">
          Help Scout user ID for {user.full_name ?? user.email}
        </h3>
        <p className="mt-1 text-xs text-gray-500">
          When this designer sends staff replies via the proof viewer, replies will appear in Help Scout under this user ID. Leave empty to use the project default.
        </p>
      </div>

      <div className="mt-4">
        <label className="mb-1.5 block text-sm font-medium text-gray-700">
          Help Scout user ID
        </label>
        <div className="flex gap-2">
          <input
            type="number"
            min="1"
            step="1"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            disabled={working}
            className={inputClass + ' font-mono'}
            placeholder="Leave empty to use project default"
          />
          <button
            type="button"
            onClick={onClear}
            disabled={working || value === ''}
            className="shrink-0 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
            title="Empty the field. Click 'Clear mapping' below to actually save the change."
          >
            Empty field
          </button>
        </div>
        <p className="mt-1.5 text-xs text-gray-400">
          Current: {user.helpscout_user_id == null
            ? <span>using project default (HELPSCOUT_DEFAULT_USER_ID)</span>
            : <span className="font-mono">{user.helpscout_user_id}</span>}
        </p>
        {isClearing && user.helpscout_user_id != null && (
          <p className="mt-1.5 text-xs text-amber-700">
            Field is empty — click <strong>Clear mapping</strong> below to remove the saved value.
          </p>
        )}
      </div>

      {errorMsg && <p className="mt-4 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{errorMsg}</p>}

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
          className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-700 disabled:opacity-50"
        >
          {working ? 'Saving…' : isClearing ? 'Clear mapping' : 'Save'}
        </button>
      </div>
    </Modal>
  )
}
