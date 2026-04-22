import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { PricingDisplay } from './PricingDisplay'
import { ImageGrid } from './ImageGrid'
import type { Currency, PricingSnapshot, ProofNameApproval } from '../lib/types'
import { DEFAULT_FEATURED_QUANTITIES } from '../lib/constants'
import { relativeTime, formatAbsoluteDateTime } from '../lib/relativeTime'

export interface ModalVersion {
  id: string
  version_number: number
  material_id: string
  material_display: string
  ink_names: string[]
  currency: string
  is_current: boolean
  created_at: string
  change_notes: string | null
  pricing_snapshot: PricingSnapshot
  shipping_note: string
  custom_quote: boolean
  // Recipient names for this version (migration 000070). Drives the
  // per-name approval grouping below. Empty array = single-subject
  // project, approval section collapses to just the shared image
  // group with no per-name controls.
  names: string[]
  materials: { featured_quantities: number[] } | null
}

interface ModalImage {
  id: string
  proof_version_id: string
  image_path: string
  sort_order: number
  signed_url: string
  // Added for the name-grouped rendering introduced alongside the
  // approval section. Null = shared image (applies to every name).
  associated_name: string | null
}


export default function VersionDetailModal({
  version,
  proofId,
  proofLocked,
  lockReason,
  allVersions,
  viewHistory,
  contactFullName,
  onClose,
  onVersionUpdated,
  onDeleteProofRequested,
  onApprovalsChanged,
}: {
  version: ModalVersion
  proofId: string
  proofLocked: boolean
  lockReason: 'approved' | 'abandoned' | null
  allVersions: ModalVersion[]
  viewHistory?: { viewed_at: string; user_agent: string | null }[]
  // Project contact's full name, prefilled into the approve /
  // request-changes dialogs as the actor_name default. Optional so
  // the modal still renders if the parent hasn't plumbed it.
  contactFullName?: string
  onClose: () => void
  onVersionUpdated: (message: string) => void
  onDeleteProofRequested?: () => void
  // Fired on close when the user made at least one approval write
  // (upsert or clear) during this modal session. Parent uses this
  // to refresh the project-level Names roll-up which otherwise
  // goes stale — the roll-up on ProofDetailPage reads approvals
  // separately from the modal's own scoped fetch. No-op if nothing
  // was written; no-op if the prop isn't supplied.
  onApprovalsChanged?: () => void
}) {
  const navigate = useNavigate()
  const [images, setImages] = useState<ModalImage[]>([])
  const [loadingImages, setLoadingImages] = useState(true)
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)
  const [deleteState, setDeleteState] = useState<'idle' | 'confirm' | 'working'>('idle')
  const [settingCurrent, setSettingCurrent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Per-name approval state. Keyed by the recipient name string —
  // matches proof_name_approvals.name which is plain text, not FK.
  // Absence of a key = no row yet = "Pending" in the UI.
  const [approvals, setApprovals] = useState<Record<string, ProofNameApproval>>({})
  // Dialog state for approve / request-changes flows. `name` drives
  // which recipient the dialog applies to; `mode` picks the form
  // shape.
  const [dialog, setDialog] = useState<
    | { mode: 'approve' | 'changes'; name: string }
    | null
  >(null)
  // Dirty flag — set true after any approval write, checked on
  // close to decide whether to fire onApprovalsChanged. Kept as a
  // ref rather than state because we don't want a re-render when
  // it flips; it's purely a "has something changed since modal
  // opened" marker that only needs to survive until close. Firing
  // the callback only on close (not per-write) avoids work on the
  // parent's roll-up while it's obscured by the modal.
  const approvalsDirtyRef = useRef(false)

  // Wrapped close handler. Flushes the dirty flag up to the parent
  // via onApprovalsChanged before calling onClose, so the project
  // page's Names roll-up refreshes the next time it's visible. Used
  // by every close path — Esc key, backdrop click, header X button,
  // and both footer Close buttons (locked + active variants) — so
  // no path can skip the flush.
  function handleClose() {
    if (approvalsDirtyRef.current) {
      onApprovalsChanged?.()
      approvalsDirtyRef.current = false
    }
    onClose()
  }

  useEffect(() => {
    loadImages()
    loadApprovals()
  }, [version.id])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (lightboxSrc) { setLightboxSrc(null); return }
        if (deleteState !== 'working') handleClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
    // handleClose is defined in render scope; we don't put it in
    // deps because the effect only cares about the latest reference
    // at fire time and deleteState already triggers re-registration.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lightboxSrc, deleteState, onClose])

  useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = '' }
  }, [])

  async function loadImages() {
    setLoadingImages(true)
    const { data } = await supabase
      .from('proof_version_images')
      .select('id, proof_version_id, image_path, sort_order, associated_name')
      .eq('proof_version_id', version.id)
      .order('sort_order')

    if (!data?.length) {
      setImages([])
      setLoadingImages(false)
      return
    }

    const withUrls = await Promise.all(
      data.map(async (img) => {
        const { data: urlData } = await supabase.storage
          .from('proof-images')
          .createSignedUrl(img.image_path, 3600)
        return { ...img, signed_url: urlData?.signedUrl ?? '' }
      })
    )
    setImages(withUrls as ModalImage[])
    setLoadingImages(false)
  }

  // Load every approval row for this version into a name → row
  // lookup. Called on mount and after every successful upsert so
  // the UI reflects the latest state without optimistic updates.
  async function loadApprovals() {
    const { data } = await supabase
      .from('proof_name_approvals')
      .select('*')
      .eq('proof_version_id', version.id)

    const map: Record<string, ProofNameApproval> = {}
    for (const row of (data ?? []) as ProofNameApproval[]) {
      map[row.name] = row
    }
    setApprovals(map)
  }

  // Upsert a single approval row for (version, name). Unique
  // constraint on (proof_version_id, name) handles the conflict
  // target. actor_ip / actor_ua stay null — designer records are
  // keyboard-driven, no telemetry needed. change_request is
  // explicitly cleared on approval so the record doesn't carry a
  // stale "what needs to change" note from a prior state.
  async function upsertApproval(args: {
    name: string
    state: 'approved' | 'changes_requested'
    actorName: string
    changeRequest: string | null
  }) {
    const { error: err } = await supabase
      .from('proof_name_approvals')
      .upsert(
        {
          proof_version_id: version.id,
          name: args.name,
          state: args.state,
          change_request: args.state === 'approved' ? null : args.changeRequest,
          actor_name: args.actorName,
          actor_ip: null,
          actor_ua: null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'proof_version_id,name' },
      )
    if (err) {
      setError(`Failed to save approval: ${err.message}`)
      return
    }
    setError(null)
    setDialog(null)
    await loadApprovals()
    approvalsDirtyRef.current = true
  }

  // Delete the approval row for a given name, returning the UI to
  // the Pending state. No confirmation dialog — the action is
  // reversible by clicking Mark as approved / Record change request
  // again. Surfaces any error (notably: non-admins hit the admin-only
  // DELETE policy from migration 000076 and will see a "Failed to
  // clear" message rather than a silent no-op).
  async function clearApproval(name: string) {
    const { error: err } = await supabase
      .from('proof_name_approvals')
      .delete()
      .eq('proof_version_id', version.id)
      .eq('name', name)
    if (err) {
      setError(`Failed to clear approval: ${err.message}`)
      return
    }
    setError(null)
    await loadApprovals()
    approvalsDirtyRef.current = true
  }

  async function handleSetCurrent() {
    setSettingCurrent(true)
    setError(null)
    const { error: err } = await supabase
      .from('proof_versions')
      .update({ is_current: true })
      .eq('id', version.id)

    if (err) {
      setError(`Failed to update: ${err.message}`)
      setSettingCurrent(false)
      return
    }
    onVersionUpdated(`v${version.version_number} set as current`)
  }

  async function handleDelete() {
    setDeleteState('working')
    setError(null)

    // If this is the current version and others exist, auto-promote the most recent sibling
    const others = allVersions.filter((v) => v.id !== version.id)
    if (version.is_current && others.length > 0) {
      const nextCurrent = others.reduce((best, v) =>
        v.version_number > best.version_number ? v : best
      )
      const { error: promoteErr } = await supabase
        .from('proof_versions')
        .update({ is_current: true })
        .eq('id', nextCurrent.id)
      if (promoteErr) {
        setError(`Failed to promote next version: ${promoteErr.message}`)
        setDeleteState('confirm')
        return
      }
    }

    // Capture image paths before the CASCADE delete removes them
    const imagePaths = images.map((img) => img.image_path)

    const { error: deleteErr } = await supabase
      .from('proof_versions')
      .delete()
      .eq('id', version.id)

    if (deleteErr) {
      setError(`Failed to delete: ${deleteErr.message}`)
      setDeleteState('confirm')
      return
    }

    // Remove from storage best-effort; version row is already gone
    if (imagePaths.length > 0) {
      await supabase.storage.from('proof-images').remove(imagePaths)
    }

    onVersionUpdated(`v${version.version_number} deleted`)
  }

  const featuredQuantities = version.materials?.featured_quantities ?? DEFAULT_FEATURED_QUANTITIES
  const isOnlyVersion = allVersions.length === 1

  const deleteConfirmText = isOnlyVersion
    ? 'This is the only proof version. To remove it, delete the whole project instead.'
    : version.is_current
    ? `Delete v${version.version_number}? The most recent remaining proof version will become current.`
    : `Delete v${version.version_number}? This removes its images too.`

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/50"
        onClick={() => deleteState === 'idle' && !lightboxSrc && handleClose()}
      />

      {/* Panel — full-screen on mobile, centred sheet on desktop */}
      <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4 pointer-events-none">
        <div className="pointer-events-auto relative flex max-h-full w-full flex-col overflow-hidden bg-white sm:max-h-[90vh] sm:max-w-2xl sm:rounded-2xl">

          {/* Header */}
          <div className="flex shrink-0 items-start justify-between border-b border-gray-100 px-6 py-4">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-bold text-gray-900">
                v{version.version_number} — {version.material_display}
              </h2>
              <span className="rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-600">
                {version.currency}
              </span>
              {version.is_current && (
                <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-semibold text-emerald-700">
                  Current
                </span>
              )}
              {version.custom_quote && (
                <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-600">
                  Custom quote
                </span>
              )}
            </div>
            <button
              onClick={handleClose}
              className="ml-4 shrink-0 rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            >
              <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
              </svg>
            </button>
          </div>

          {/* Scrollable body */}
          <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">

            {/* Customer view history for this version. Hidden when
                no real (non-bot) views have landed yet. Up to five
                most recent rows; anything older lives in audit_log
                + proof_version_views. */}
            {viewHistory && viewHistory.length > 0 && (
              <div className="rounded-2xl bg-white p-5 ring-1 ring-gray-200">
                <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-gray-400">Customer views</p>
                <ul className="space-y-1">
                  {viewHistory.slice(0, 5).map((v, i) => (
                    <li key={i} className="flex items-center justify-between gap-3 text-sm">
                      <span className="truncate text-gray-700">{summariseUserAgent(v.user_agent)}</span>
                      <span className="shrink-0 text-xs text-gray-400" title={formatAbsoluteDateTime(v.viewed_at)}>
                        {relativeTime(v.viewed_at)}
                      </span>
                    </li>
                  ))}
                </ul>
                {viewHistory.length > 5 && (
                  <p className="mt-2 text-xs text-gray-400">+{viewHistory.length - 5} earlier view{viewHistory.length - 5 === 1 ? '' : 's'}</p>
                )}
              </div>
            )}

            {/* Change notes */}
            {version.change_notes && (
              <div className="rounded-2xl bg-amber-50 p-5 ring-1 ring-amber-100">
                <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-amber-600">Notes on this version</p>
                <p className="text-sm text-amber-900">{version.change_notes}</p>
              </div>
            )}

            {/* Specification */}
            <div className="rounded-2xl bg-white p-5 ring-1 ring-gray-200">
              <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-gray-400">Specification</p>
              <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-gray-400">Material</dt>
                  <dd className="mt-1 text-sm font-medium text-gray-900">{version.material_display}</dd>
                </div>
                {version.ink_names.length > 0 && (
                  <div>
                    <dt className="text-xs font-medium uppercase tracking-wide text-gray-400">Inks</dt>
                    <dd className="mt-1 text-sm font-medium text-gray-900">{version.ink_names.join(', ')}</dd>
                  </div>
                )}
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-gray-400">Added</dt>
                  <dd className="mt-1 text-sm font-medium text-gray-900">
                    {new Date(version.created_at).toLocaleDateString('en-GB')}
                  </dd>
                </div>
              </dl>
            </div>

            {/* Images + per-name approvals.
                When the version has no names[] (single-subject
                project), we fall back to one flat image grid, same
                as before the approvals section existed. When names
                are present, we render a Shared group first
                (associated_name IS NULL images — apply to every
                recipient) then one group per name with its own
                approval header and action row. */}
            <div>
              <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-gray-400">Images</p>
              {loadingImages ? (
                <div className="flex h-32 items-center justify-center rounded-2xl bg-white ring-1 ring-gray-200">
                  <div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-200 border-t-gray-900" />
                </div>
              ) : version.names.length === 0 ? (
                <ImageGrid
                  images={images}
                  versionNumber={version.version_number}
                  onImageClick={setLightboxSrc}
                />
              ) : (
                <div className="space-y-6">
                  {/* Shared group — images without an associated_name
                      apply to every recipient. No approval header
                      here; approval is recorded per named recipient. */}
                  {(() => {
                    const shared = images.filter((img) => img.associated_name == null)
                    if (shared.length === 0) return null
                    return (
                      <div>
                        <p className="mb-2 text-xs font-medium uppercase tracking-wider text-gray-500">Shared</p>
                        <ImageGrid
                          images={shared}
                          versionNumber={version.version_number}
                          onImageClick={setLightboxSrc}
                        />
                      </div>
                    )
                  })()}

                  {/* One section per named recipient. Ordering
                      follows the names[] snapshot so designer and
                      customer views agree. */}
                  {version.names.map((name) => {
                    const nameImages = images.filter((img) => img.associated_name === name)
                    const approval = approvals[name]
                    return (
                      <div key={name} className="rounded-2xl ring-1 ring-gray-200 bg-white p-4">
                        <div className="mb-3 flex items-center justify-between gap-3">
                          <p className="text-sm font-semibold text-gray-900">{name}</p>
                        </div>

                        {/* State header */}
                        <ApprovalStateHeader approval={approval} />

                        {/* Action row — pending gives two buttons,
                            any set state gives an Edit link that
                            re-opens the matching dialog. Suppressed
                            when the whole project is locked. */}
                        {!proofLocked && (
                          <div className="mb-3">
                            {!approval ? (
                              <div className="flex flex-wrap gap-2">
                                <button
                                  type="button"
                                  onClick={() => setDialog({ mode: 'approve', name })}
                                  className="rounded-lg bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-700 ring-1 ring-emerald-200 hover:bg-emerald-100"
                                >
                                  Mark as approved
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setDialog({ mode: 'changes', name })}
                                  className="rounded-lg bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-700 ring-1 ring-amber-200 hover:bg-amber-100"
                                >
                                  Record change request
                                </button>
                              </div>
                            ) : (
                              <div className="flex items-center gap-3">
                                <button
                                  type="button"
                                  onClick={() => setDialog({
                                    mode: approval.state === 'approved' ? 'approve' : 'changes',
                                    name,
                                  })}
                                  className="text-xs font-medium text-gray-500 underline-offset-2 hover:text-gray-900 hover:underline"
                                >
                                  Edit
                                </button>
                                {/* Clear returns the group to Pending
                                    by deleting the row. Muted gray-400
                                    so Edit reads as the primary amend
                                    path and Clear as the secondary
                                    reset. No confirm dialog — safely
                                    reversible via the action buttons
                                    that reappear in the Pending state. */}
                                <button
                                  type="button"
                                  onClick={() => clearApproval(name)}
                                  className="text-xs font-medium text-gray-400 underline-offset-2 hover:text-gray-700 hover:underline"
                                >
                                  Clear
                                </button>
                              </div>
                            )}
                          </div>
                        )}

                        {/* Images for this recipient */}
                        {nameImages.length > 0 ? (
                          <ImageGrid
                            images={nameImages}
                            versionNumber={version.version_number}
                            onImageClick={setLightboxSrc}
                          />
                        ) : (
                          <p className="text-xs text-gray-400">No images associated with this name.</p>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            {/* Pricing */}
            <div className="overflow-hidden rounded-2xl bg-white ring-1 ring-gray-200">
              <div className="border-b border-gray-100 px-6 py-4">
                <p className="text-xs font-semibold uppercase tracking-widest text-gray-400">Pricing</p>
              </div>
              <PricingDisplay
                snapshot={version.pricing_snapshot}
                currency={version.currency as Currency}
                featuredQuantities={featuredQuantities}
              />
              <div className="border-t border-gray-100 px-6 py-3">
                <p className="text-xs text-gray-400">
                  {!version.custom_quote && version.currency === 'GBP' ? 'Prices include VAT. ' : ''}
                  {version.shipping_note}
                </p>
              </div>
            </div>

            {error && (
              <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>
            )}
          </div>

          {/* Footer actions */}
          <div className="shrink-0 border-t border-gray-100 px-6 py-4">
            {proofLocked ? (
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-gray-400">
                  {lockReason === 'abandoned'
                    ? 'This project is abandoned and locked. Reopen the project to make changes.'
                    : 'This project is approved and locked. Reopen the project to make changes.'}
                </p>
                <button
                  onClick={handleClose}
                  className="rounded-lg bg-gray-900 px-3 py-2 text-sm font-semibold text-white hover:bg-gray-700"
                >
                  Close
                </button>
              </div>
            ) : deleteState === 'confirm' || deleteState === 'working' ? (
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm text-gray-700">{deleteConfirmText}</p>
                <div className="flex shrink-0 gap-2">
                  <button
                    onClick={() => { setDeleteState('idle'); setError(null) }}
                    disabled={deleteState === 'working'}
                    className="rounded-lg px-3 py-2 text-sm font-medium text-gray-500 hover:bg-gray-100 disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  {isOnlyVersion ? (
                    onDeleteProofRequested && (
                      <button
                        onClick={onDeleteProofRequested}
                        disabled={deleteState === 'working'}
                        className="rounded-lg bg-rose-600 px-3 py-2 text-sm font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
                      >
                        Delete project
                      </button>
                    )
                  ) : (
                    <button
                      onClick={handleDelete}
                      disabled={deleteState === 'working'}
                      className="rounded-lg bg-red-600 px-3 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50"
                    >
                      {deleteState === 'working' ? 'Deleting…' : 'Confirm delete'}
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-3">
                <button
                  onClick={() => setDeleteState('confirm')}
                  className="rounded-lg px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50"
                >
                  Delete version
                </button>
                <div className="flex gap-2">
                  {!version.is_current && (
                    <button
                      onClick={handleSetCurrent}
                      disabled={settingCurrent}
                      className="rounded-lg px-3 py-2 text-sm font-medium text-gray-600 ring-1 ring-gray-200 hover:bg-gray-50 disabled:opacity-50"
                    >
                      {settingCurrent ? 'Setting…' : 'Set as current'}
                    </button>
                  )}
                  <button
                    onClick={() => navigate(`/proofs/${proofId}/versions/${version.id}/edit`)}
                    className="rounded-lg px-3 py-2 text-sm font-medium text-gray-600 ring-1 ring-gray-200 hover:bg-gray-50"
                  >
                    Edit version
                  </button>
                  <button
                    onClick={handleClose}
                    className="rounded-lg bg-gray-900 px-3 py-2 text-sm font-semibold text-white hover:bg-gray-700"
                  >
                    Close
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Lightbox — above the modal */}
      {lightboxSrc && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4"
          onClick={() => setLightboxSrc(null)}
        >
          <img
            src={lightboxSrc}
            alt="Proof image"
            className="max-h-full max-w-full rounded-lg object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}

      {/* Approval dialogs — rendered on top of the modal (z-[70] so
          they also sit above the lightbox at z-[60], though the two
          never open simultaneously). */}
      {dialog?.mode === 'approve' && (
        <ApproveDialog
          name={dialog.name}
          prefillActor={contactFullName ?? ''}
          existing={approvals[dialog.name]}
          onConfirm={(actorName) =>
            upsertApproval({
              name: dialog.name,
              state: 'approved',
              actorName,
              changeRequest: null,
            })
          }
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.mode === 'changes' && (
        <RequestChangesDialog
          name={dialog.name}
          prefillActor={contactFullName ?? ''}
          existing={approvals[dialog.name]}
          onSubmit={(actorName, changeRequest) =>
            upsertApproval({
              name: dialog.name,
              state: 'changes_requested',
              actorName,
              changeRequest,
            })
          }
          onCancel={() => setDialog(null)}
        />
      )}
    </>
  )
}

// Per-name approval state header. Three states:
//   no row       → muted "Pending" pill
//   approved     → emerald "Approved DD/MM/YYYY by actor" pill
//   changes_req  → amber "Changes requested DD/MM/YYYY by actor"
//                  with an optional second line for the comment
// Kept colocated with VersionDetailModal because it's the only
// surface using it and extracting to its own file would just add
// a context-switching tax.
function ApprovalStateHeader({ approval }: { approval: ProofNameApproval | undefined }) {
  if (!approval) {
    return (
      <div className="mb-3 rounded-lg bg-gray-50 px-3 py-2 text-xs font-medium text-gray-500 ring-1 ring-gray-200">
        Pending
      </div>
    )
  }
  const when = new Date(approval.updated_at).toLocaleDateString('en-GB')
  if (approval.state === 'approved') {
    return (
      <div className="mb-3 rounded-lg bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-800 ring-1 ring-emerald-200">
        Approved {when} by {approval.actor_name}
      </div>
    )
  }
  // changes_requested
  return (
    <div className="mb-3 rounded-lg bg-amber-50 px-3 py-2 ring-1 ring-amber-200">
      <p className="text-xs font-medium text-amber-800">
        Changes requested {when} by {approval.actor_name}
      </p>
      {approval.change_request && (
        <p className="mt-1 text-xs text-amber-700/80">{approval.change_request}</p>
      )}
    </div>
  )
}

// Approve dialog. Single text input for actor name, prefilled with
// the project contact's full name if known. No IP/UA capture here —
// it's a designer-side record, telemetry is noise.
function ApproveDialog({
  name,
  prefillActor,
  existing,
  onConfirm,
  onCancel,
}: {
  name: string
  prefillActor: string
  existing: ProofNameApproval | undefined
  onConfirm: (actorName: string) => void
  onCancel: () => void
}) {
  const [actor, setActor] = useState(
    existing?.state === 'approved' ? existing.actor_name : prefillActor,
  )
  const trimmed = actor.trim()
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-base font-semibold text-gray-900">Approve for {name}</h3>
        <label className="mt-4 block">
          <span className="block text-xs font-medium uppercase tracking-wider text-gray-500">Approved by</span>
          <input
            type="text"
            value={actor}
            onChange={(e) => setActor(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none"
            autoFocus
          />
        </label>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg px-3 py-2 text-sm font-medium text-gray-500 hover:bg-gray-100"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm(trimmed)}
            disabled={trimmed.length === 0}
            className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  )
}

// Request changes dialog. Textarea for the change note (optional)
// plus actor name input. Empty textarea stores null, not an empty
// string, so query-side `where change_request is not null` reads
// as "had a written note" rather than "had some kind of note".
function RequestChangesDialog({
  name,
  prefillActor,
  existing,
  onSubmit,
  onCancel,
}: {
  name: string
  prefillActor: string
  existing: ProofNameApproval | undefined
  onSubmit: (actorName: string, changeRequest: string | null) => void
  onCancel: () => void
}) {
  const [actor, setActor] = useState(
    existing?.state === 'changes_requested' ? existing.actor_name : prefillActor,
  )
  const [note, setNote] = useState(
    existing?.state === 'changes_requested' ? existing.change_request ?? '' : '',
  )
  const trimmedActor = actor.trim()
  const trimmedNote = note.trim()
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-base font-semibold text-gray-900">Record change request for {name}</h3>
        <label className="mt-4 block">
          <span className="block text-xs font-medium uppercase tracking-wider text-gray-500">What needs to change?</span>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={4}
            className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none"
            autoFocus
          />
        </label>
        <label className="mt-4 block">
          <span className="block text-xs font-medium uppercase tracking-wider text-gray-500">Reported by</span>
          <input
            type="text"
            value={actor}
            onChange={(e) => setActor(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none"
          />
        </label>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg px-3 py-2 text-sm font-medium text-gray-500 hover:bg-gray-100"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onSubmit(trimmedActor, trimmedNote === '' ? null : trimmedNote)}
            disabled={trimmedActor.length === 0}
            className="rounded-lg bg-amber-600 px-3 py-2 text-sm font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
          >
            Submit
          </button>
        </div>
      </div>
    </div>
  )
}

// One-line summary of a user-agent string for the view history
// panel. Proper UA parsing is a rabbit hole; this picks the
// obvious browser + platform tokens and composes "Chrome on
// iPhone" style output. Falls back to the truncated raw UA if
// neither rule matches.
function summariseUserAgent(ua: string | null): string {
  if (!ua) return 'Unknown client'
  const browser =
    /Edg\//.test(ua) ? 'Edge'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Safari\//.test(ua) && !/Chrome\//.test(ua) ? 'Safari'
    : null
  const platform =
    /iPhone/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) ? 'iPad'
    : /Android/.test(ua) ? 'Android'
    : /Mac OS X/.test(ua) ? 'Mac'
    : /Windows/.test(ua) ? 'Windows'
    : /Linux/.test(ua) ? 'Linux'
    : null
  if (browser && platform) return `${browser} on ${platform}`
  if (browser) return browser
  if (platform) return platform
  return ua.length > 60 ? ua.slice(0, 57) + '…' : ua
}
