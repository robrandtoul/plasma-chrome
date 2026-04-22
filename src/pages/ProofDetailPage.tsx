import { useEffect, useState, useRef } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import VersionDetailModal, { type ModalVersion } from '../components/VersionDetailModal'
import HelpScoutEditModal from '../components/HelpScoutEditModal'
import { logAudit } from '../lib/audit'
import { relativeTime, formatAbsoluteDateTime } from '../lib/relativeTime'
import {
  computeViewedState,
  viewedStateDotClass,
  viewedStateTitle,
  type ViewedState,
} from '../lib/viewedState'

interface Proof {
  id: string
  status: 'in_progress' | 'approved' | 'dormant' | 'abandoned'
  approved_at: string | null
  abandoned_at: string | null
  helpscout_thread_url: string | null
  helpscout_conversation_id: string | null
  helpscout_conversation_url: string | null
  helpscout_override_reason: string | null
  internal_notes: string | null
  created_at: string
  contacts: {
    full_name: string
    email: string
    companies: { name: string } | null
  }
}

function formatLongDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
}

export default function ProofDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { role } = useAuth()
  const [proof, setProof] = useState<Proof | null>(null)
  const [versions, setVersions] = useState<ModalVersion[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedVersion, setSelectedVersion] = useState<ModalVersion | null>(null)
  // Real (non-bot) view times per version id for the dot indicators
  // and the VersionDetailModal history panel.
  const [viewsByVersion, setViewsByVersion] = useState<Map<string, { viewed_at: string; user_agent: string | null }[]>>(new Map())
  const [toast, setToast] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [statusDialog, setStatusDialog] = useState<'approve' | 'reopen' | 'abandon' | 'delete' | null>(null)
  const [statusWorking, setStatusWorking] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [showHelpscoutEdit, setShowHelpscoutEdit] = useState(false)
  const [showCustomerPreview, setShowCustomerPreview] = useState(false)
  const fallbackInputRef = useRef<HTMLInputElement>(null)
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (id) loadProof(id)
  }, [id])

  async function loadProof(proofId: string) {
    const [proofResult, versionsResult] = await Promise.all([
      supabase
        .from('proofs')
        .select('id, status, approved_at, abandoned_at, helpscout_thread_url, helpscout_conversation_id, helpscout_conversation_url, helpscout_override_reason, internal_notes, created_at, contacts(full_name, email, companies(name))')
        .eq('id', proofId)
        .single(),
      supabase
        .from('proof_versions')
        .select('id, version_number, material_id, material_display, ink_names, currency, is_current, created_at, change_notes, pricing_snapshot, shipping_note, custom_quote, names, materials(featured_quantities)')
        .eq('proof_id', proofId)
        .order('version_number', { ascending: false }),
    ])

    if (proofResult.error || !proofResult.data) {
      navigate('/')
      return
    }

    const loadedVersions = (versionsResult.data ?? []) as unknown as ModalVersion[]
    setProof(proofResult.data as unknown as Proof)
    setVersions(loadedVersions)
    setLoading(false)

    // Pull non-bot view rows for every version on this proof. Same
    // query shape as the dashboard's map; kept separate so reload
    // flows (e.g. after a status change) refresh view data too.
    const versionIds = loadedVersions.map((v) => v.id)
    if (versionIds.length > 0) {
      const { data: viewRows } = await supabase
        .from('proof_version_views')
        .select('proof_version_id, viewed_at, user_agent')
        .eq('is_bot', false)
        .in('proof_version_id', versionIds)
        .order('viewed_at', { ascending: false })
      const map = new Map<string, { viewed_at: string; user_agent: string | null }[]>()
      for (const r of (viewRows ?? []) as any[]) {
        const list = map.get(r.proof_version_id) ?? []
        list.push({ viewed_at: r.viewed_at, user_agent: r.user_agent })
        map.set(r.proof_version_id, list)
      }
      setViewsByVersion(map)
    } else {
      setViewsByVersion(new Map())
    }
  }

  function showToast(message: string) {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    setToast(message)
    toastTimerRef.current = setTimeout(() => setToast(null), 3000)
  }

  function handleVersionUpdated(message: string) {
    setSelectedVersion(null)
    showToast(message)
    if (id) loadProof(id)
  }

  async function handleApprove() {
    if (!proof) return
    setStatusWorking(true)
    const { error } = await supabase
      .from('proofs')
      .update({ status: 'approved', approved_at: new Date().toISOString() })
      .eq('id', proof.id)
    setStatusWorking(false)
    setStatusDialog(null)
    if (!error) {
      void logAudit({
        action: 'proof.approved',
        targetType: 'proof',
        targetId: proof.id,
        targetLabel: proof.contacts.full_name,
        beforeValue: { status: proof.status },
        afterValue: { status: 'approved' },
      })
      showToast('Project marked as approved')
      if (id) loadProof(id)
    }
  }

  async function handleReopen() {
    if (!proof) return
    setStatusWorking(true)
    // Clear both terminal timestamps so the same flow works for approved and abandoned.
    const { error } = await supabase
      .from('proofs')
      .update({ status: 'in_progress', approved_at: null, abandoned_at: null })
      .eq('id', proof.id)
    setStatusWorking(false)
    setStatusDialog(null)
    if (!error) {
      showToast('Project reopened')
      if (id) loadProof(id)
    }
  }

  async function handleDelete() {
    if (!proof) return
    setStatusWorking(true)
    setDeleteError(null)

    // Gather every storage path linked to any version of this proof so we
    // can clean those files up after the DB cascade fires.
    const versionIds = versions.map((v) => v.id)
    let imagePaths: string[] = []
    if (versionIds.length > 0) {
      const { data: images } = await supabase
        .from('proof_version_images')
        .select('image_path')
        .in('proof_version_id', versionIds)
      imagePaths = (images ?? []).map((r: any) => r.image_path)
    }

    const { error } = await supabase.rpc('delete_proof_cascade', { p_proof_id: proof.id })
    if (error) {
      setDeleteError(error.message)
      setStatusWorking(false)
      return
    }

    // Best-effort storage cleanup — the DB record is already gone, so a
    // storage miss just leaves orphan files (not a correctness issue).
    if (imagePaths.length > 0) {
      await supabase.storage.from('proof-images').remove(imagePaths)
    }

    void logAudit({
      action: 'proof.deleted',
      targetType: 'proof',
      targetId: proof.id,
      targetLabel: proof.contacts.full_name,
      metadata: { versions_deleted: versions.length, storage_paths_removed: imagePaths.length },
    })

    setStatusWorking(false)
    setStatusDialog(null)
    navigate('/')
  }

  async function handleAbandon() {
    if (!proof) return
    setStatusWorking(true)
    const { error } = await supabase
      .from('proofs')
      .update({ status: 'abandoned', abandoned_at: new Date().toISOString() })
      .eq('id', proof.id)
    setStatusWorking(false)
    setStatusDialog(null)
    if (!error) {
      void logAudit({
        action: 'proof.abandoned',
        targetType: 'proof',
        targetId: proof.id,
        targetLabel: proof.contacts.full_name,
        beforeValue: { status: proof.status },
        afterValue: { status: 'abandoned' },
      })
      showToast('Project abandoned')
      if (id) loadProof(id)
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-200 border-t-gray-900" />
      </div>
    )
  }

  async function copyCustomerUrl() {
    const url = `${window.location.origin}/p/${proof!.id}`
    try {
      await navigator.clipboard.writeText(url)
    } catch {
      if (fallbackInputRef.current) {
        fallbackInputRef.current.value = url
        fallbackInputRef.current.select()
        document.execCommand('copy')
      }
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  if (!proof) return null

  const isApproved  = proof.status === 'approved'
  const isDormant   = proof.status === 'dormant'
  const isAbandoned = proof.status === 'abandoned'
  const isLocked    = isApproved || isAbandoned

  const currentVersion = versions.find((v) => v.is_current)
  const currentIsCustomQuote = !!currentVersion?.custom_quote

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6 lg:px-8">

        {/* Back */}
        <div className="mb-6">
          <Link to="/" className="text-sm text-gray-400 hover:text-gray-700">← Back to projects</Link>
        </div>

        {/* Proof header */}
        <div className="mb-8 flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{proof.contacts.full_name}</h1>
            {proof.contacts.companies?.name && (
              <p className="mt-1 text-gray-500">{proof.contacts.companies.name}</p>
            )}
            <p className="mt-0.5 text-sm text-gray-400">{proof.contacts.email}</p>
            {/* Status badge */}
            <div className="mt-3">
              <div className="flex flex-wrap items-center gap-2">
                {isApproved ? (
                  <span className="inline-flex items-center rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-700">
                    Approved{proof.approved_at ? ` on ${formatLongDate(proof.approved_at)}` : ''}
                  </span>
                ) : isAbandoned ? (
                  <span className="inline-flex items-center rounded-full bg-slate-200 px-3 py-1 text-xs font-semibold text-slate-700">
                    Abandoned{proof.abandoned_at ? ` on ${formatLongDate(proof.abandoned_at)}` : ''}
                  </span>
                ) : isDormant ? (
                  <span className="inline-flex items-center rounded-full bg-gray-100 px-3 py-1 text-xs font-semibold text-gray-500">
                    Dormant
                  </span>
                ) : (
                  <span className="inline-flex items-center rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-700">
                    In progress
                  </span>
                )}
                {currentIsCustomQuote && (
                  <span className="inline-flex items-center rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
                    Custom quote
                  </span>
                )}
              </div>
              {isDormant && (
                <p className="mt-1.5 text-xs text-gray-400">No activity for 30+ days. Add a version to reactivate.</p>
              )}
            </div>
          </div>
          {/* Action cluster — two right-aligned rows.
              Row 1 (day-to-day workflow): Preview, Copy, Add version.
              Add version keeps its filled-black primary style and
              anchors the right edge of the row.
              Row 2 (terminal state): Abandon, Mark as approved.
              Mark as approved (positive) anchors the right edge;
              Abandon is placed to its left so the destructive
              control sits furthest from the primary Add version
              directly above.
              Locked variant (approved/abandoned): Add version is
              hidden on row 1, and row 2 collapses to a lone Reopen
              button in the same right-aligned slot. */}
          <div className="flex flex-col items-end gap-8">
            {/* Row 1 */}
            <div className="flex flex-wrap justify-end gap-2">
              {/* Preview is gated on there being at least one proof
                  version — otherwise the customer page renders
                  near-blank. Disabled rendering keeps the affordance
                  discoverable and teaches the unlock. */}
              <button
                type="button"
                onClick={() => setShowCustomerPreview(true)}
                disabled={versions.length === 0}
                title={versions.length === 0 ? 'Add a version to enable preview' : undefined}
                className="flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium text-gray-500 ring-1 ring-gray-200 hover:bg-gray-50 disabled:cursor-not-allowed disabled:text-gray-400 disabled:ring-gray-100 disabled:hover:bg-transparent"
              >
                <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 3H3.5A1.5 1.5 0 002 4.5v8A1.5 1.5 0 003.5 14h8A1.5 1.5 0 0013 12.5V10M10 2h4m0 0v4m0-4L7 9" />
                </svg>
                Preview as customer
              </button>
              <button
                onClick={copyCustomerUrl}
                className="flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium text-gray-500 ring-1 ring-gray-200 hover:bg-gray-50"
              >
                {copied ? (
                  <>
                    <svg className="h-4 w-4 text-emerald-500" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l3.5 3.5 6.5-7" />
                    </svg>
                    <span className="text-emerald-600">Link copied</span>
                  </>
                ) : (
                  <>
                    <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <rect x="5" y="5" width="8" height="8" rx="1.5" />
                      <path strokeLinecap="round" d="M11 5V3.5A1.5 1.5 0 009.5 2h-6A1.5 1.5 0 002 3.5v6A1.5 1.5 0 003.5 11H5" />
                    </svg>
                    Copy customer URL
                  </>
                )}
              </button>
              {!isLocked && (
                <Link
                  to={`/proofs/${proof.id}/versions/new`}
                  className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-700"
                >
                  Add version
                </Link>
              )}
            </div>

            {/* Hidden input for clipboard fallback. Sits outside the
                rows so it can't disturb the flex layout. */}
            <input ref={fallbackInputRef} className="sr-only" readOnly aria-hidden="true" />

            {/* Row 2 */}
            {isLocked ? (
              <div className="flex justify-end">
                <button
                  onClick={() => setStatusDialog('reopen')}
                  className="rounded-lg px-4 py-2 text-sm font-medium text-gray-500 ring-1 ring-gray-200 hover:bg-gray-50"
                >
                  Reopen
                </button>
              </div>
            ) : (
              <div className="flex flex-wrap justify-end gap-2">
                <button
                  onClick={() => setStatusDialog('abandon')}
                  className="rounded-lg px-4 py-2 text-sm font-medium text-rose-500 ring-1 ring-rose-200 hover:bg-rose-50"
                >
                  Abandon project
                </button>
                <button
                  onClick={() => setStatusDialog('approve')}
                  className="rounded-lg bg-emerald-50 px-4 py-2 text-sm font-medium text-emerald-700 ring-1 ring-emerald-200 hover:bg-emerald-100"
                >
                  Mark as approved
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Internal metadata. Always rendered so the Change Help
            Scout button is always reachable — even proofs with
            nothing recorded can have their link set from here. */}
        <div className="mb-8 rounded-2xl bg-amber-50 p-5 ring-1 ring-amber-100">
          <div className="flex items-start justify-between gap-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-amber-600">Internal</p>
            <button
              type="button"
              onClick={() => setShowHelpscoutEdit(true)}
              className="shrink-0 text-xs text-amber-700 underline hover:text-amber-900"
            >
              Change Help Scout conversation
            </button>
          </div>
          <div className="mt-2 space-y-1 text-sm">
            {proof.helpscout_conversation_url ? (
              <p>
                <span className="text-gray-500">Help Scout: </span>
                <a href={proof.helpscout_conversation_url} target="_blank" rel="noopener noreferrer"
                  className="text-amber-800 underline">
                  {proof.helpscout_conversation_url}
                </a>
              </p>
            ) : proof.helpscout_override_reason ? (
              <p className="text-amber-900">
                <span className="text-gray-500">Help Scout override: </span>
                <span className="italic">{proof.helpscout_override_reason}</span>
              </p>
            ) : proof.helpscout_thread_url ? (
              <p>
                <span className="text-gray-500">Help Scout (legacy): </span>
                <a href={proof.helpscout_thread_url} target="_blank" rel="noopener noreferrer"
                  className="text-amber-800 underline">
                  {proof.helpscout_thread_url}
                </a>
              </p>
            ) : (
              <p className="italic text-gray-500">No Help Scout conversation linked.</p>
            )}
            {proof.internal_notes && (
              <p className="text-amber-900">{proof.internal_notes}</p>
            )}
          </div>
        </div>

        {/* Versions */}
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-widest text-gray-400">Versions</h2>

        {versions.length === 0 ? (
          <div className="rounded-2xl bg-white py-16 text-center shadow-sm ring-1 ring-gray-200">
            <p className="text-gray-400">No versions yet.</p>
            {!isApproved && (
              <Link to={`/proofs/${proof.id}/versions/new`}
                className="mt-3 inline-block text-sm font-medium text-gray-900 underline">
                Add the first version
              </Link>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto rounded-2xl bg-white shadow-sm ring-1 ring-gray-200">
            <table className="w-full table-fixed text-sm">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="w-36 truncate px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Version</th>
                  <th className="w-36 truncate px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Material</th>
                  <th className="w-28 truncate px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Currency</th>
                  <th className="truncate px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Notes</th>
                  <th className="w-28 truncate px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Added</th>
                  <th className="w-40 truncate px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Status</th>
                  <th className="w-12 px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {versions.map((v) => {
                  const viewsForThis = viewsByVersion.get(v.id) ?? []
                  const hasReal = viewsForThis.length > 0
                  let rowState: ViewedState
                  if (v.is_current) {
                    // Current version: three-state based on whether
                    // any real view exists anywhere on the project
                    // and whether this specific version is viewed.
                    const viewedSet = new Set<string>()
                    for (const [id, list] of viewsByVersion) {
                      if (list.length > 0) viewedSet.add(id)
                    }
                    rowState = computeViewedState({ currentVersionId: v.id, viewedVersionIds: viewedSet })
                  } else {
                    // Older version: two-state. Green when the
                    // customer actually opened that specific
                    // version, grey when not.
                    rowState = hasReal ? 'viewed_current' : 'unviewed'
                  }
                  const latest = viewsForThis[0]?.viewed_at ?? null
                  return (
                  <tr
                    key={v.id}
                    onClick={() => setSelectedVersion(v)}
                    className="cursor-pointer border-b border-gray-50 last:border-0 hover:bg-gray-50"
                  >
                    <td className="truncate px-4 py-4 font-medium text-gray-900">
                      <span className="flex items-center gap-2">
                        <span
                          aria-label={viewedStateTitle(rowState)}
                          title={v.is_current ? viewedStateTitle(rowState) : (hasReal ? 'Viewed' : 'Not viewed')}
                          className={['inline-block h-2.5 w-2.5 shrink-0 rounded-full', viewedStateDotClass(rowState)].join(' ')}
                        />
                        <span>v{v.version_number}</span>
                        {latest && (
                          <span className="ml-1 text-xs font-normal text-gray-400" title={formatAbsoluteDateTime(latest)}>· {relativeTime(latest)}</span>
                        )}
                      </span>
                    </td>
                    <td className="truncate px-4 py-4 text-gray-700" title={v.material_display}>{v.material_display}</td>
                    <td className="truncate px-4 py-4 text-gray-500">{v.currency}</td>
                    <td className="truncate px-4 py-4 text-gray-500" title={v.change_notes ?? undefined}>{v.change_notes ?? '—'}</td>
                    <td className="truncate px-4 py-4 text-gray-500">
                      {new Date(v.created_at).toLocaleDateString('en-GB')}
                    </td>
                    <td className="px-4 py-4">
                      <div className="flex flex-wrap gap-1">
                        {v.is_current && (
                          <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-semibold text-emerald-700">
                            Current
                          </span>
                        )}
                        {v.custom_quote && (
                          <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-600">
                            Custom quote
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-4">
                      <svg className="h-4 w-4 text-gray-300" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 3l5 5-5 5" />
                      </svg>
                    </td>
                  </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Danger zone — permanent delete, kept subtle to avoid accidental
            clicks. Admin-only to match the DB gate (migration 000074),
            which restricts DELETE on proofs to is_admin(). A non-admin
            clicking here would get an RLS error — hiding the control is
            the clean frontend mirror of that. */}
        {role === 'admin' && (
          <div className="mt-12 flex flex-col gap-3 border-t border-gray-100 pt-6 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-gray-400">
              Permanently remove this project and all its proof versions. Different from abandon, this cannot be undone.
            </p>
            <button
              onClick={() => { setDeleteError(null); setStatusDialog('delete') }}
              className="shrink-0 self-start rounded-lg border border-rose-200 px-4 py-2 text-sm font-medium text-rose-600 hover:bg-rose-50 sm:self-auto"
            >
              Delete project
            </button>
          </div>
        )}
      </div>

      {/* Customer preview modal. An iframe loading the real public
          proof URL so the designer sees exactly what renders for the
          customer, not a reproduction. Faster than a new tab
          (no context switch) and still accurate. */}
      {showCustomerPreview && (
        <>
          <div className="fixed inset-0 z-40 bg-black/60" onClick={() => setShowCustomerPreview(false)} />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="flex h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl">
              <div className="flex items-center justify-between border-b border-gray-100 px-6 py-3">
                <div className="flex items-center gap-3">
                  <h3 className="text-sm font-semibold text-gray-900">Preview as customer</h3>
                  <span className="text-xs text-gray-500">Exactly what the customer sees.</span>
                </div>
                <button
                  type="button"
                  onClick={() => setShowCustomerPreview(false)}
                  className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                  aria-label="Close"
                >
                  <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                    <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
                  </svg>
                </button>
              </div>
              <iframe
                src={`/p/${proof.id}?preview=1`}
                title="Customer preview"
                className="flex-1 border-0 bg-white"
              />
            </div>
          </div>
        </>
      )}

      {/* Change Help Scout conversation modal */}
      {showHelpscoutEdit && (
        <HelpScoutEditModal
          proofId={proof.id}
          proofLabel={proof.contacts?.full_name ?? proof.id}
          contactEmail={proof.contacts?.email ?? null}
          current={{
            conversationId: proof.helpscout_conversation_id,
            conversationUrl: proof.helpscout_conversation_url,
            overrideReason: proof.helpscout_override_reason,
          }}
          onSaved={() => {
            if (id) loadProof(id)
            showToast('Help Scout link updated.')
          }}
          onClose={() => setShowHelpscoutEdit(false)}
        />
      )}

      {/* Version detail modal */}
      {selectedVersion && (
        <VersionDetailModal
          version={selectedVersion}
          proofId={proof.id}
          proofLocked={isLocked}
          lockReason={isAbandoned ? 'abandoned' : isApproved ? 'approved' : null}
          allVersions={versions}
          viewHistory={viewsByVersion.get(selectedVersion.id) ?? []}
          contactFullName={proof.contacts.full_name}
          onClose={() => setSelectedVersion(null)}
          onVersionUpdated={handleVersionUpdated}
          onDeleteProofRequested={() => {
            setSelectedVersion(null)
            setDeleteError(null)
            setStatusDialog('delete')
          }}
        />
      )}

      {/* Approve confirm dialog */}
      {statusDialog === 'approve' && (
        <ConfirmDialog
          message="Mark this project as approved? This locks the project — no more proof versions can be added."
          confirmLabel="Mark as approved"
          confirmClass="bg-emerald-600 hover:bg-emerald-700 text-white"
          working={statusWorking}
          onConfirm={handleApprove}
          onCancel={() => setStatusDialog(null)}
        />
      )}

      {/* Abandon confirm dialog */}
      {statusDialog === 'abandon' && (
        <ConfirmDialog
          message="Abandon this project? This will lock the project. No new proof versions can be added, and the customer-facing page will show a closed state. You can reopen the project later if needed."
          confirmLabel="Abandon project"
          confirmClass="bg-slate-700 hover:bg-slate-800 text-white"
          working={statusWorking}
          onConfirm={handleAbandon}
          onCancel={() => setStatusDialog(null)}
        />
      )}

      {/* Delete confirm dialog */}
      {statusDialog === 'delete' && (
        <ConfirmDialog
          message={`Permanently delete this project and all ${versions.length} proof version${versions.length === 1 ? '' : 's'}? This cannot be undone.`}
          confirmLabel="Delete project"
          confirmClass="bg-rose-600 hover:bg-rose-700 text-white"
          working={statusWorking}
          errorMsg={deleteError}
          onConfirm={handleDelete}
          onCancel={() => { setStatusDialog(null); setDeleteError(null) }}
        />
      )}

      {/* Reopen confirm dialog */}
      {statusDialog === 'reopen' && (
        <ConfirmDialog
          message={
            isAbandoned
              ? 'Reopen this project? This will reopen the project and allow new proof versions to be added.'
              : 'Reopen this project? It will go back to in progress and you\'ll be able to add new proof versions.'
          }
          confirmLabel="Reopen"
          confirmClass="bg-gray-900 hover:bg-gray-700 text-white"
          working={statusWorking}
          onConfirm={handleReopen}
          onCancel={() => setStatusDialog(null)}
        />
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-gray-900 px-5 py-2.5 text-sm font-medium text-white shadow-lg">
          {toast}
        </div>
      )}
    </div>
  )
}

function ConfirmDialog({
  message,
  confirmLabel,
  confirmClass,
  working,
  errorMsg,
  onConfirm,
  onCancel,
}: {
  message: string
  confirmLabel: string
  confirmClass: string
  working: boolean
  errorMsg?: string | null
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/50" onClick={() => !working && onCancel()} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
          <p className="text-sm text-gray-700">{message}</p>
          {errorMsg && (
            <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{errorMsg}</p>
          )}
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
