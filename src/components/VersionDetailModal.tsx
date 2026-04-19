import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { PricingDisplay } from './PricingDisplay'
import { ImageGrid } from './ImageGrid'
import type { Currency, PricingSnapshot } from '../lib/types'

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
  materials: { featured_quantities: number[] } | null
}

interface ModalImage {
  id: string
  proof_version_id: string
  image_path: string
  label: string
  sort_order: number
  signed_url: string
}

const DEFAULT_FEATURED = [100, 250, 500, 750, 1000]

export default function VersionDetailModal({
  version,
  proofId,
  allVersions,
  onClose,
  onVersionUpdated,
}: {
  version: ModalVersion
  proofId: string
  allVersions: ModalVersion[]
  onClose: () => void
  onVersionUpdated: (message: string) => void
}) {
  const navigate = useNavigate()
  const [images, setImages] = useState<ModalImage[]>([])
  const [loadingImages, setLoadingImages] = useState(true)
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)
  const [deleteState, setDeleteState] = useState<'idle' | 'confirm' | 'working'>('idle')
  const [settingCurrent, setSettingCurrent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    loadImages()
  }, [version.id])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (lightboxSrc) { setLightboxSrc(null); return }
        if (deleteState !== 'working') onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [lightboxSrc, deleteState, onClose])

  useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = '' }
  }, [])

  async function loadImages() {
    setLoadingImages(true)
    const { data } = await supabase
      .from('proof_version_images')
      .select('id, proof_version_id, image_path, label, sort_order')
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

  const featuredQuantities = version.materials?.featured_quantities ?? DEFAULT_FEATURED
  const isOnlyVersion = allVersions.length === 1

  const deleteConfirmText = isOnlyVersion
    ? 'This is the only version — delete the whole proof instead.'
    : version.is_current
    ? `Delete v${version.version_number}? The most recent remaining version will become current.`
    : `Delete v${version.version_number}? This removes its images too.`

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/50"
        onClick={() => deleteState === 'idle' && !lightboxSrc && onClose()}
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
            </div>
            <button
              onClick={onClose}
              className="ml-4 shrink-0 rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            >
              <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
              </svg>
            </button>
          </div>

          {/* Scrollable body */}
          <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">

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

            {/* Images */}
            <div>
              <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-gray-400">Images</p>
              {loadingImages ? (
                <div className="flex h-32 items-center justify-center rounded-2xl bg-white ring-1 ring-gray-200">
                  <div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-200 border-t-gray-900" />
                </div>
              ) : (
                <ImageGrid
                  images={images}
                  versionNumber={version.version_number}
                  onImageClick={setLightboxSrc}
                />
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
                <p className="text-xs text-gray-400">{version.shipping_note}</p>
              </div>
            </div>

            {error && (
              <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>
            )}
          </div>

          {/* Footer actions */}
          <div className="shrink-0 border-t border-gray-100 px-6 py-4">
            {deleteState === 'confirm' || deleteState === 'working' ? (
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
                  {!isOnlyVersion && (
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
                    onClick={onClose}
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
    </>
  )
}
