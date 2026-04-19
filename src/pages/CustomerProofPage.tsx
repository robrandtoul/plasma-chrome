import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import type { PublicProof, PublicProofVersion, PublicFinish, PublicFinishSurcharge, SiteSettings } from '../lib/types'
import { formatPrice } from '../lib/currency'
import { PricingDisplay } from '../components/PricingDisplay'
import { ImageGrid, type GridImage } from '../components/ImageGrid'

const SIGNED_URL_TTL = 60 * 60 * 24 // 24 hours

export default function CustomerProofPage() {
  const { id } = useParams<{ id: string }>()

  const [proof, setProof] = useState<PublicProof | null>(null)
  const [versions, setVersions] = useState<PublicProofVersion[]>([])
  const [activeVersion, setActiveVersion] = useState<PublicProofVersion | null>(null)
  const [versionImages, setVersionImages] = useState<Record<string, GridImage[]>>({})
  const [finishes, setFinishes] = useState<PublicFinish[]>([])
  const [finishSurcharges, setFinishSurcharges] = useState<PublicFinishSurcharge[]>([])
  const [activeFinishCode, setActiveFinishCode] = useState<string | null>(null)
  const [globalDisclaimer, setGlobalDisclaimer] = useState<string | null>(null)
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const tabStripRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!id) { setNotFound(true); return }
    loadProof(id)
  }, [id])

  useEffect(() => {
    if (!lightboxSrc) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setLightboxSrc(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [lightboxSrc])

  // On initial load, scroll the active tab to the left edge of the strip.
  useEffect(() => {
    if (loading) return
    const strip = tabStripRef.current
    if (!strip) return
    const activeTab = strip.querySelector<HTMLElement>('[data-active="true"]')
    if (!activeTab) return
    strip.scrollLeft = Math.max(0, activeTab.offsetLeft - 8)
  }, [loading])

  // When active version changes, reset finish selection to the version's first finish.
  useEffect(() => {
    if (!activeVersion) return
    setActiveFinishCode(activeVersion.finishes[0] ?? null)
  }, [activeVersion?.id])

  async function loadProof(proofId: string) {
    setLoading(true)

    const [proofResult, versionsResult, settingsResult] = await Promise.all([
      supabase.from('public_proofs').select('*').eq('id', proofId).maybeSingle(),
      supabase.from('public_proof_versions').select('*').eq('proof_id', proofId).order('version_number', { ascending: true }),
      supabase.from('public_site_settings').select('global_disclaimer').maybeSingle(),
    ])

    if (proofResult.error || !proofResult.data) {
      setNotFound(true)
      setLoading(false)
      return
    }

    setProof(proofResult.data as PublicProof)
    if (settingsResult.data) setGlobalDisclaimer((settingsResult.data as SiteSettings).global_disclaimer)

    const rawVersions = (versionsResult.data ?? []) as PublicProofVersion[]
    setVersions(rawVersions)
    const initialVersion = rawVersions.find((v) => v.is_current) ?? rawVersions[rawVersions.length - 1] ?? null
    setActiveVersion(initialVersion)

    if (rawVersions.length > 0) {
      // Load images for all versions
      const versionIds = rawVersions.map((v) => v.id)
      const { data: imageRows } = await supabase
        .from('public_proof_version_images')
        .select('*')
        .in('proof_version_id', versionIds)
        .order('sort_order')

      const imagesWithUrls = await Promise.all(
        ((imageRows ?? []) as Omit<GridImage, 'signed_url'>[]).map(async (img) => {
          const { data } = await supabase.storage
            .from('proof-images')
            .createSignedUrl((img as any).image_path, SIGNED_URL_TTL)
          return { ...img, signed_url: data?.signedUrl ?? '' }
        })
      )

      const byVersion: Record<string, GridImage[]> = {}
      imagesWithUrls.forEach((img) => {
        const pvid = (img as any).proof_version_id as string
        if (!byVersion[pvid]) byVersion[pvid] = []
        byVersion[pvid].push(img as GridImage)
      })
      setVersionImages(byVersion)

      // Load finishes for all materials used across versions
      const materialIds = [...new Set(rawVersions.map(v => v.material_id))]
      const { data: finishRows } = await supabase
        .from('public_finishes')
        .select('*')
        .in('material_id', materialIds)
        .order('sort_order')

      const loadedFinishes = (finishRows ?? []) as PublicFinish[]
      setFinishes(loadedFinishes)

      if (loadedFinishes.length > 0) {
        const finishIds = loadedFinishes.map(f => f.id)
        const { data: surchargeRows } = await supabase
          .from('public_finish_surcharges')
          .select('*')
          .in('finish_id', finishIds)
        setFinishSurcharges((surchargeRows ?? []) as PublicFinishSurcharge[])
      }
    }

    setLoading(false)
  }

  if (loading) return <LoadingScreen />
  if (notFound || !proof) return <NotFoundScreen />

  const isApproved = proof.status === 'approved'

  // Finish logic for the active version
  const versionFinishes = activeVersion?.finishes ?? []
  const showFinishSwitcher = versionFinishes.length >= 2
  const activeFinish = activeFinishCode && activeVersion
    ? finishes.find(f => f.material_id === activeVersion.material_id && f.code === activeFinishCode) ?? null
    : null

  // Filter images for the active finish (if in finish mode)
  const allVersionImages = activeVersion ? (versionImages[activeVersion.id] ?? []) : []
  const displayImages = versionFinishes.length > 0 && activeFinishCode
    ? allVersionImages.filter(img => img.finish === activeFinishCode || img.finish == null)
    : allVersionImages

  // Per-quantity surcharge map for the active finish, used to bake surcharges
  // into every pricing cell. Empty for base finishes (no surcharge rows exist).
  const quantitySurcharges: Record<number, number> = {}
  if (activeFinish && activeVersion) {
    finishSurcharges
      .filter(s => s.finish_id === activeFinish.id && s.currency === activeVersion.currency)
      .forEach(s => { quantitySurcharges[s.quantity] = s.surcharge })
  }

  // "From" price per finish — the smallest-quantity surcharge in the active currency.
  // Null for finishes with no surcharges (base / Natural).
  function finishFromPrice(finishCode: string): number | null {
    if (!activeVersion) return null
    const f = finishes.find(x => x.material_id === activeVersion.material_id && x.code === finishCode)
    if (!f) return null
    const sorted = finishSurcharges
      .filter(s => s.finish_id === f.id && s.currency === activeVersion.currency)
      .sort((a, b) => a.quantity - b.quantity)
    const first = sorted[0]
    return first && first.surcharge > 0 ? first.surcharge : null
  }

  return (
    <div className="min-h-screen bg-gray-50">

      {/* Approval banner */}
      {isApproved && (
        <div className="bg-emerald-100 px-4 py-4 text-center">
          <p className="text-sm font-bold text-emerald-800">This proof has been approved</p>
          {proof.approved_at && (
            <p className="mt-0.5 text-xs text-emerald-700">
              Approved on {new Date(proof.approved_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
            </p>
          )}
        </div>
      )}

      <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6 lg:px-8">

        {/* Header */}
        <header className="mb-8">
          <p className="text-sm font-medium uppercase tracking-widest text-gray-400">Proof for</p>
          <h1 className="mt-1 text-3xl font-bold text-gray-900">{proof.customer_name}</h1>
          {proof.company && (
            <p className="mt-1 text-lg text-gray-500">{proof.company}</p>
          )}
        </header>

        {/* Version tabs — highest version first so latest is always leftmost */}
        {versions.length > 1 && (
          <div ref={tabStripRef} className="mb-6 flex gap-2 overflow-x-auto pb-1">
            {[...versions].reverse().map((v) => {
              const isActive = activeVersion?.id === v.id
              return (
                <button
                  key={v.id}
                  data-active={isActive ? 'true' : undefined}
                  onClick={() => setActiveVersion(v)}
                  className={[
                    'shrink-0 rounded-full px-4 py-1.5 text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-gray-900 text-white'
                      : 'bg-white text-gray-600 ring-1 ring-gray-200 hover:bg-gray-50',
                  ].join(' ')}
                >
                  Version {v.version_number}
                  {v.is_current && (
                    <span className={[
                      'ml-2 rounded-full px-2 py-0.5 text-xs font-semibold',
                      isActive ? 'bg-emerald-700 text-emerald-100' : 'bg-emerald-100 text-emerald-700',
                    ].join(' ')}>
                      {isApproved ? 'Approved' : 'Current'}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        )}

        {activeVersion && (
          <>
            {/* Finish switcher — shown when this version offers 2+ finishes */}
            {showFinishSwitcher && (
              <div className="mb-6 flex flex-wrap gap-2">
                {versionFinishes.map(fCode => {
                  const f = finishes.find(x => x.material_id === activeVersion.material_id && x.code === fCode)
                  const isActive = activeFinishCode === fCode
                  const fromPrice = finishFromPrice(fCode)
                  return (
                    <button
                      key={fCode}
                      onClick={() => setActiveFinishCode(fCode)}
                      className={[
                        'rounded-full px-4 py-1.5 text-sm font-medium transition-colors',
                        isActive
                          ? 'bg-gray-900 text-white'
                          : 'bg-white text-gray-600 ring-1 ring-gray-200 hover:bg-gray-50',
                      ].join(' ')}
                    >
                      {f?.display_name ?? fCode}
                      {fromPrice != null && (
                        <span className={['ml-1.5 font-normal', isActive ? 'text-gray-300' : 'text-gray-400'].join(' ')}>
                          (+from {formatPrice(fromPrice, activeVersion.currency, 0)})
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            )}

            {/* Proof images */}
            <div className="mb-8">
              <ImageGrid
                images={displayImages}
                versionNumber={activeVersion.version_number}
                onImageClick={setLightboxSrc}
              />
            </div>

            {/* Spec summary */}
            <div className="mb-8 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-gray-200">
              <h2 className="mb-4 text-sm font-semibold uppercase tracking-widest text-gray-400">
                Specification
              </h2>
              <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                <SpecItem label="Material" value={activeVersion.material_display} />
                {activeFinish && <SpecItem label="Finish" value={activeFinish.display_name} />}
                {activeVersion.ink_names.length > 0 && (
                  <SpecItem label="Inks" value={activeVersion.ink_names.join(', ')} />
                )}
              </dl>
            </div>

            {/* Change notes */}
            {activeVersion.change_notes && (
              <div className="mb-8 rounded-2xl bg-amber-50 p-6 ring-1 ring-amber-100">
                <h2 className="mb-2 text-sm font-semibold uppercase tracking-widest text-amber-600">
                  Notes on this version
                </h2>
                <p className="text-sm text-amber-900">{activeVersion.change_notes}</p>
              </div>
            )}

            {/* Disclaimers — rendered only when at least one block has content */}
            {(globalDisclaimer || activeVersion.material_disclaimer) && (
              <div className="mb-8 space-y-4">
                {globalDisclaimer && (
                  <div className="rounded-2xl bg-gray-50 p-6 ring-1 ring-gray-200">
                    <h2 className="mb-3 text-sm font-semibold uppercase tracking-widest text-gray-400">
                      Important information
                    </h2>
                    <p className="whitespace-pre-line text-sm text-gray-500">{globalDisclaimer}</p>
                  </div>
                )}
                {activeVersion.material_disclaimer && (
                  <div className="rounded-2xl bg-gray-50 p-6 ring-1 ring-gray-200">
                    <h2 className="mb-3 text-sm font-semibold uppercase tracking-widest text-gray-400">
                      About {activeVersion.material_display}
                    </h2>
                    <p className="whitespace-pre-line text-sm text-gray-500">{activeVersion.material_disclaimer}</p>
                  </div>
                )}
              </div>
            )}

            {/* Pricing table */}
            <div className="mb-8 rounded-2xl bg-white shadow-sm ring-1 ring-gray-200">
              <div className="border-b border-gray-100 px-6 py-4">
                <h2 className="text-sm font-semibold uppercase tracking-widest text-gray-400">
                  Pricing
                </h2>
                {activeFinish && versionFinishes.length > 0 && (
                  <p className="mt-1 text-xs text-gray-400">
                    Prices shown for {activeFinish.display_name} finish
                  </p>
                )}
              </div>
              <PricingDisplay
                snapshot={activeVersion.pricing_snapshot}
                currency={activeVersion.currency}
                featuredQuantities={activeVersion.featured_quantities}
                quantitySurcharges={quantitySurcharges}
              />
              <div className="border-t border-gray-100 px-6 py-3">
                <p className="text-xs text-gray-400">{activeVersion.shipping_note}</p>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Lightbox */}
      {lightboxSrc && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
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
    </div>
  )
}

function SpecItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-gray-400">{label}</dt>
      <dd className="mt-1 text-sm font-medium text-gray-900">{value}</dd>
    </div>
  )
}

function LoadingScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="text-center">
        <div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-2 border-gray-200 border-t-gray-900" />
        <p className="text-sm text-gray-400">Loading your proof…</p>
      </div>
    </div>
  )
}

function NotFoundScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="text-center">
        <p className="text-4xl font-bold text-gray-200">404</p>
        <p className="mt-2 text-sm text-gray-400">This proof link isn't valid or has expired.</p>
      </div>
    </div>
  )
}
