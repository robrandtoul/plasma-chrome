import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { PricingDisplay } from './PricingDisplay'
import { ImageGrid } from './ImageGrid'
import { safeRemoveImagePaths } from '../lib/imageStorage'
import type {
  Currency,
  PricingSnapshot,
  ProofNameApproval,
  PublicMaterialVariant,
  PublicPriceTier,
} from '../lib/types'
import { SHARED_APPROVAL_KEY } from '../lib/types'
import { DEFAULT_DISPLAY_QUANTITIES } from '../lib/constants'
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
  // Legacy column. Migration 000117 made this nullable when the
  // pricing grid moved to live computation from price_tiers; the
  // modal now rebuilds the snapshot client-side via the
  // useEffect below and ignores this field for the price grid.
  // Kept on the type for any downstream consumers that still
  // care about the historical snapshot (e.g. audit views).
  pricing_snapshot: PricingSnapshot | null
  shipping_note: string
  custom_quote: boolean
  // Designer's curated variant subset for this version (000118).
  // Null = "show every active variant of this material" (the
  // pre-000118 default). Used to scope the live pricing rebuild
  // below to the same rows the customer page shows.
  displayed_variant_ids: string[] | null
  // Recipient names for this version (migration 000070). Drives the
  // per-name approval grouping below. Empty array = single-subject
  // project, approval section collapses to just the shared image
  // group with no per-name controls. In membership mode (see
  // card_type below), names holds tier variant labels rather than
  // recipient names.
  names: string[]
  // Top-level mode (migration 000086). Drives column-label copy
  // in approved-artwork + variant-vs-name framing. Customer-
  // facing surfaces don't distinguish.
  card_type: 'business' | 'membership'
  materials: { display_quantities: number[] } | null
  // Denormalised hot-path indicator (migration 000103) populated
  // by the send-helpscout-reply edge function on a successful HS
  // POST. Powers the Customer reply section on ProofDetailPage.
  // Loaded here so the data is already in scope when a future
  // ship surfaces per-version send history inside this modal;
  // Ship 3 doesn't render it here, only on the page.
  last_reply_sent_at: string | null
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
  // Live pricing rebuild (000117). proof_versions.pricing_snapshot
  // became nullable when the customer page moved to live pricing
  // from price_tiers; this modal followed up later. Loaded lazily
  // when the modal opens — keyed off version.id so re-opening on a
  // different version refreshes both fetches.
  const [variantRows, setVariantRows] = useState<PublicMaterialVariant[]>([])
  const [tierRows, setTierRows] = useState<PublicPriceTier[]>([])
  const [loadingPricing, setLoadingPricing] = useState(true)
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
    void loadPricing()
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

  // Live pricing rebuild for this version (000117). Mirrors the
  // CustomerProofPage pattern but lazy-loads on modal open rather
  // than batch-loading at page mount, since the modal is the only
  // designer-side surface that renders pricing and only one
  // version is in scope at a time.
  //
  // Two queries: variants for the version's material (filtered to
  // displayed_variant_ids if curated), and price tiers for those
  // variants in the version's currency. The snapshot shape is then
  // computed in livePricingSnapshot below.
  async function loadPricing() {
    setLoadingPricing(true)
    try {
      const { data: variantData } = await supabase
        .from('public_material_variants')
        .select('*')
        .eq('material_id', version.material_id)
        .order('sort_order')
      const loadedVariants = (variantData ?? []) as PublicMaterialVariant[]
      setVariantRows(loadedVariants)

      if (loadedVariants.length > 0) {
        const variantIds = loadedVariants.map((v) => v.id)
        const { data: tierData } = await supabase
          .from('public_price_tiers')
          .select('*')
          .in('material_variant_id', variantIds)
          .eq('currency', version.currency)
        setTierRows((tierData ?? []) as PublicPriceTier[])
      } else {
        setTierRows([])
      }
    } finally {
      setLoadingPricing(false)
    }
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

    // Remove from storage best-effort; version row is already
    // gone. Guard against nuking carried paths that another
    // version (likely a v2 cloned from this one, or the v1 this
    // was cloned from) still references via shared image_path.
    if (imagePaths.length > 0) {
      await safeRemoveImagePaths(imagePaths)
    }

    onVersionUpdated(`v${version.version_number} deleted`)
  }

  const displayQuantities = version.materials?.display_quantities ?? DEFAULT_DISPLAY_QUANTITIES
  const isOnlyVersion = allVersions.length === 1

  // Live pricing snapshot rebuild (000117). Mirrors
  // CustomerProofPage.livePricingSnapshot — same filter rules,
  // same shape, same currency scoping. Memoised on the row sets
  // + version identity so re-renders during the approval flow
  // don't recompute. Variants with zero priced tiers in the
  // active currency drop out, matching the customer page.
  const livePricingSnapshot: PricingSnapshot = useMemo(() => ({
    variants: variantRows
      .filter((v) => v.material_id === version.material_id)
      .filter((v) =>
        version.displayed_variant_ids == null ||
        version.displayed_variant_ids.includes(v.id),
      )
      .map((v) => {
        const prices: Record<string, number> = {}
        for (const t of tierRows) {
          if (t.material_variant_id === v.id && t.currency === version.currency) {
            prices[String(t.quantity)] = t.total_price
          }
        }
        return {
          variant_id: v.id,
          display: v.variant_type === 'default' ? 'Default' : v.display_name,
          prices,
        }
      })
      .filter((v) => Object.keys(v.prices).length > 0),
  }), [variantRows, tierRows, version.id, version.material_id, version.currency, version.displayed_variant_ids])
  // Resolver for the "Carried from vN" provenance pill on
  // ApprovalStateHeader. Built once per render from the same
  // versions list the parent page already loaded. Returns
  // undefined for version IDs not in this proof (FK ON DELETE
  // SET NULL cascade, or pre-migration rows) so the pill
  // silently hides.
  const versionNumberById = new Map<string, number>()
  for (const v of allVersions) versionNumberById.set(v.id, v.version_number)

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
                  {/* One section per named recipient. Ordering
                      follows the names[] snapshot so designer and
                      customer views agree. Rendered before Shared
                      so the most specific approvals read first and
                      the cross-cutting Shared section sits at the
                      bottom as the distinct entity it is. */}
                  {version.names.map((name) => {
                    const nameImages = images.filter((img) => img.associated_name === name)
                    const approval = approvals[name]
                    return (
                      <ApprovalGroup
                        key={name}
                        heading={name}
                        approval={approval}
                        approvalKey={name}
                        images={nameImages}
                        proofLocked={proofLocked}
                        versionNumber={version.version_number}
                        versionNumberById={versionNumberById}
                        onOpenApprove={() => setDialog({ mode: 'approve', name })}
                        onOpenChanges={() => setDialog({ mode: 'changes', name })}
                        onClear={() => clearApproval(name)}
                        onImageClick={setLightboxSrc}
                        emptyHint="No images associated with this name."
                      />
                    )
                  })}

                  {/* Shared group — images without an associated_name
                      apply to every recipient. Has its own approval
                      controls via the SHARED_APPROVAL_KEY sentinel
                      on proof_name_approvals. A light divider above
                      the heading separates Shared from the per-name
                      sections above, since it's a cross-cutting
                      entity rather than another name. */}
                  {(() => {
                    const shared = images.filter((img) => img.associated_name == null)
                    if (shared.length === 0) return null
                    const approval = approvals[SHARED_APPROVAL_KEY]
                    return (
                      <div className="border-t border-gray-200 pt-6">
                        <ApprovalGroup
                          heading="Shared"
                          approval={approval}
                          approvalKey={SHARED_APPROVAL_KEY}
                          images={shared}
                          proofLocked={proofLocked}
                          versionNumber={version.version_number}
                          versionNumberById={versionNumberById}
                          onOpenApprove={() => setDialog({ mode: 'approve', name: SHARED_APPROVAL_KEY })}
                          onOpenChanges={() => setDialog({ mode: 'changes', name: SHARED_APPROVAL_KEY })}
                          onClear={() => clearApproval(SHARED_APPROVAL_KEY)}
                          onImageClick={setLightboxSrc}
                        />
                      </div>
                    )
                  })()}
                </div>
              )}
            </div>

            {/* Pricing */}
            <div className="overflow-hidden rounded-2xl bg-white ring-1 ring-gray-200">
              <div className="border-b border-gray-100 px-6 py-4">
                <p className="text-xs font-semibold uppercase tracking-widest text-gray-400">Pricing</p>
              </div>
              {version.custom_quote ? (
                // Custom-quote path — triggered either by the
                // designer explicitly choosing Custom quote in the
                // PricingDisplayField radio, or automatically when
                // a 5+ ink variant (which has no price_tiers rows)
                // is selected. Either way, the underlying column
                // is proof_versions.custom_quote and the UI here
                // doesn't need to know which trigger fired.
                <div className="px-6 py-8 text-center text-sm text-gray-500">
                  Custom quote — price and quantity agreed separately.
                </div>
              ) : loadingPricing ? (
                // Lazy fetch in flight — small spinner to telegraph
                // the inflight load. ~100ms typical RTT to Supabase
                // so this rarely flashes; the "Custom quote" path
                // skips this entirely and renders synchronously.
                <div className="flex justify-center px-6 py-12">
                  <div className="h-5 w-5 animate-spin rounded-full border-2 border-gray-200 border-t-gray-700" />
                </div>
              ) : (
                <PricingDisplay
                  snapshot={livePricingSnapshot}
                  currency={version.currency as Currency}
                  displayQuantities={displayQuantities}
                />
              )}
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
// One approval-group card: heading, state header, action row,
// image grid. Used for both per-name recipient groups and the
// Shared section. Keeps every path (Approve, Record change request,
// Edit, Clear) in one place so the two surfaces can't drift. The
// `approvalKey` is stored separately from the display `heading`
// because Shared uses the sentinel internally but renders as
// "Shared" to the user.
function ApprovalGroup({
  heading,
  approval,
  approvalKey,
  images,
  proofLocked,
  versionNumber,
  versionNumberById,
  onOpenApprove,
  onOpenChanges,
  onClear,
  onImageClick,
  emptyHint,
}: {
  heading: string
  approval: ProofNameApproval | undefined
  approvalKey: string
  images: ModalImage[]
  proofLocked: boolean
  versionNumber: number
  // Map from proof_versions.id to version_number, for the
  // carry-forward provenance pill inside ApprovalStateHeader.
  versionNumberById: Map<string, number>
  onOpenApprove: () => void
  onOpenChanges: () => void
  onClear: () => void
  onImageClick: (src: string) => void
  emptyHint?: string
}) {
  // approvalKey is part of the type signature for clarity — each
  // handler closes over it at the call site. Referencing it here
  // in a no-op keeps TS from flagging it as unused and documents
  // that the group knows which sentinel/name it represents.
  void approvalKey
  return (
    <div className="rounded-2xl ring-1 ring-gray-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-gray-900">{heading}</p>
      </div>
      <ApprovalStateHeader approval={approval} versionNumberById={versionNumberById} />
      {!proofLocked && (
        <div className="mb-3">
          {!approval ? (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={onOpenApprove}
                className="rounded-lg bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-700 ring-1 ring-emerald-200 hover:bg-emerald-100"
              >
                Mark as approved
              </button>
              <button
                type="button"
                onClick={onOpenChanges}
                className="rounded-lg bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-700 ring-1 ring-amber-200 hover:bg-amber-100"
              >
                Record change request
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={approval.state === 'approved' ? onOpenApprove : onOpenChanges}
                className="text-xs font-medium text-gray-500 underline-offset-2 hover:text-gray-900 hover:underline"
              >
                Edit
              </button>
              <button
                type="button"
                onClick={onClear}
                className="text-xs font-medium text-gray-400 underline-offset-2 hover:text-gray-700 hover:underline"
              >
                Clear
              </button>
            </div>
          )}
        </div>
      )}
      {images.length > 0 ? (
        <ImageGrid images={images} versionNumber={versionNumber} onImageClick={onImageClick} />
      ) : (
        <p className="text-xs text-gray-400">{emptyHint ?? 'No images.'}</p>
      )}
    </div>
  )
}

function ApprovalStateHeader({
  approval,
  versionNumberById,
}: {
  approval: ProofNameApproval | undefined
  versionNumberById: Map<string, number>
}) {
  if (!approval) {
    return (
      <div className="mb-3 rounded-lg bg-gray-50 px-3 py-2 text-xs font-medium text-gray-500 ring-1 ring-gray-200">
        Pending
      </div>
    )
  }
  const when = new Date(approval.updated_at).toLocaleDateString('en-GB')
  // Carry-forward provenance pill (migration 000083). Only resolves
  // when the approval is still approved AND the source version
  // still exists. Hidden on changes_requested even if the row is a
  // carry — the pill means "carried AND still valid", not abstract
  // provenance. Hidden if versionNumberById can't resolve the
  // pointer (FK ON DELETE SET NULL cleared it, or the parent list
  // is out of sync).
  const carriedLabel =
    approval.state === 'approved' && approval.carried_from_version_id
      ? versionNumberById.get(approval.carried_from_version_id)
      : undefined

  if (approval.state === 'approved') {
    return (
      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 ring-1 ring-emerald-200">
        <span className="text-xs font-medium text-emerald-800">
          Approved {when} by {approval.actor_name}
        </span>
        {carriedLabel != null && (
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-normal text-gray-500">
            Carried from v{carriedLabel}
          </span>
        )}
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
        <h3 className="text-base font-semibold text-gray-900">Approve for {name === SHARED_APPROVAL_KEY ? 'Shared' : name}</h3>
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
        <h3 className="text-base font-semibold text-gray-900">Record change request for {name === SHARED_APPROVAL_KEY ? 'Shared' : name}</h3>
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
