import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import type { PublicProof, PublicProofVersion, PublicMaterialOption, PublicMaterialOptionSurcharge } from '../lib/types'
import { formatPrice } from '../lib/currency'
import { PricingDisplay } from '../components/PricingDisplay'
import { ImageGrid, type GridImage } from '../components/ImageGrid'
import { logCustomerEvent } from '../lib/audit'
import { getPublicSettings, type PublicSettings } from '../lib/publicSettings'

const SIGNED_URL_TTL = 60 * 60 * 24 // 24 hours

export default function CustomerProofPage() {
  const { id } = useParams<{ id: string }>()

  const [proof, setProof] = useState<PublicProof | null>(null)
  const [versions, setVersions] = useState<PublicProofVersion[]>([])
  const [activeVersion, setActiveVersion] = useState<PublicProofVersion | null>(null)
  const [versionImages, setVersionImages] = useState<Record<string, GridImage[]>>({})
  const [materialOptions, setMaterialOptions] = useState<PublicMaterialOption[]>([])
  const [optionSurcharges, setOptionSurcharges] = useState<PublicMaterialOptionSurcharge[]>([])
  const [activeOptionCode, setActiveOptionCode] = useState<string | null>(null)
  const [publicSettings, setPublicSettings] = useState<PublicSettings | null>(null)
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

  // When active version changes, reset the option switcher to the first option
  // this version exposes.
  useEffect(() => {
    if (!activeVersion) return
    setActiveOptionCode(activeVersion.material_options[0] ?? null)
  }, [activeVersion?.id])

  async function loadProof(proofId: string) {
    setLoading(true)

    const [proofResult, versionsResult, settingsResult] = await Promise.all([
      supabase.from('public_proofs').select('*').eq('id', proofId).maybeSingle(),
      supabase.from('public_proof_versions').select('*').eq('proof_id', proofId).order('version_number', { ascending: true }),
      getPublicSettings(),
    ])

    if (proofResult.error || !proofResult.data) {
      setNotFound(true)
      setLoading(false)
      return
    }

    const freshProof = proofResult.data as PublicProof
    setProof(freshProof)
    setPublicSettings(settingsResult)

    const rawVersions = (versionsResult.data ?? []) as PublicProofVersion[]
    setVersions(rawVersions)
    const initialVersion = rawVersions.find((v) => v.is_current) ?? rawVersions[rawVersions.length - 1] ?? null
    setActiveVersion(initialVersion)

    // Fire a single view audit entry per page load. We don't expose the
    // customer's email on the public view, so actor_email stays null; the
    // row still tells us "someone viewed this proof at this time".
    void logCustomerEvent({
      action: 'version.viewed',
      targetType: 'proof',
      targetId: freshProof.id,
      targetLabel: freshProof.customer_name ?? 'proof view',
      metadata: {
        user_agent: navigator.userAgent,
        viewed_version: initialVersion?.version_number ?? null,
      },
    })

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

      // Load material options for every material referenced by these versions
      const materialIds = [...new Set(rawVersions.map(v => v.material_id))]
      const { data: optionRows } = await supabase
        .from('public_material_options')
        .select('*')
        .in('material_id', materialIds)
        .order('sort_order')

      const loadedOptions = (optionRows ?? []) as PublicMaterialOption[]
      setMaterialOptions(loadedOptions)

      if (loadedOptions.length > 0) {
        const optionIds = loadedOptions.map(o => o.id)
        const { data: surchargeRows } = await supabase
          .from('public_material_option_surcharges')
          .select('*')
          .in('material_option_id', optionIds)
        setOptionSurcharges((surchargeRows ?? []) as PublicMaterialOptionSurcharge[])
      }
    }

    setLoading(false)
  }

  if (loading) return <LoadingScreen />
  if (notFound || !proof) return <NotFoundScreen />
  if (proof.status === 'abandoned') return <AbandonedScreen proof={proof} />

  const isApproved = proof.status === 'approved'
  const viewingApprovedVersion = isApproved && activeVersion?.is_current === true

  // Derived: options for the currently-viewed version.
  const versionOptions = activeVersion?.material_options ?? []
  const showOptionSwitcher = versionOptions.length >= 2
  const activeOption = activeOptionCode && activeVersion
    ? materialOptions.find(o => o.material_id === activeVersion.material_id && o.code === activeOptionCode) ?? null
    : null

  // Filter images for the active option (if this version is in option mode)
  const allVersionImages = activeVersion ? (versionImages[activeVersion.id] ?? []) : []
  const displayImages = versionOptions.length > 0 && activeOptionCode
    ? allVersionImages.filter(img => img.material_option === activeOptionCode || img.material_option == null)
    : allVersionImages

  // Per-quantity surcharge map for the active option, baked into every
  // pricing cell. Empty for base options or materials with no surcharges
  // (e.g. wood species).
  const quantitySurcharges: Record<number, number> = {}
  if (activeOption && activeVersion) {
    optionSurcharges
      .filter(s => s.material_option_id === activeOption.id && s.currency === activeVersion.currency)
      .forEach(s => { quantitySurcharges[s.quantity] = s.surcharge })
  }

  // Smallest-quantity surcharge for a given option in the active currency,
  // or null if this option carries no surcharge (base/Natural, or wood).
  function optionFromPrice(code: string): number | null {
    if (!activeVersion) return null
    const o = materialOptions.find(x => x.material_id === activeVersion.material_id && x.code === code)
    if (!o) return null
    const sorted = optionSurcharges
      .filter(s => s.material_option_id === o.id && s.currency === activeVersion.currency)
      .sort((a, b) => a.quantity - b.quantity)
    const first = sorted[0]
    return first && first.surcharge > 0 ? first.surcharge : null
  }

  // Does this material carry any surcharges at all? Drives whether we show
  // the "Prices shown for X" subtitle — for wood (no surcharges) the grid
  // is identical across species so the subtitle would be noise.
  const materialHasSurcharges = activeVersion
    ? versionOptions.some(code => optionFromPrice(code) !== null)
    : false

  // Display label for the option dimension — singular form, used in copy
  // like "Prices shown for Brushed finish" and the spec summary. No plural
  // form is needed on the customer page (no section heading for options).
  const optionLabelSingular = activeVersion?.option_label ?? 'Finish'

  return (
    <div className="min-h-screen bg-gray-50">

      {/* Approval banner — only when viewing the approved version */}
      {viewingApprovedVersion && (
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
            {/* Option switcher — shown when this version offers 2+ options */}
            {showOptionSwitcher && (
              <div className="mb-6 flex flex-wrap gap-2">
                {versionOptions.map(code => {
                  const o = materialOptions.find(x => x.material_id === activeVersion.material_id && x.code === code)
                  const isActive = activeOptionCode === code
                  const fromPrice = optionFromPrice(code)
                  return (
                    <button
                      key={code}
                      onClick={() => setActiveOptionCode(code)}
                      className={[
                        'rounded-full px-4 py-1.5 text-sm font-medium transition-colors',
                        isActive
                          ? 'bg-gray-900 text-white'
                          : 'bg-white text-gray-600 ring-1 ring-gray-200 hover:bg-gray-50',
                      ].join(' ')}
                    >
                      {o?.display_name ?? code}
                      {fromPrice != null && !activeVersion.custom_quote && (
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
                {activeOption && <SpecItem label={optionLabelSingular} value={activeOption.display_name} />}
                {activeVersion.ink_names.length > 0 && (
                  <SpecItem label="Inks" value={activeVersion.ink_names.join('\n')} />
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
            {(publicSettings?.disclaimer_text || activeVersion.material_disclaimer) && (
              <div className="mb-8 space-y-4">
                {publicSettings?.disclaimer_text && (
                  <div className="rounded-2xl bg-gray-50 p-6 ring-1 ring-gray-200">
                    <h2 className="mb-3 text-sm font-semibold uppercase tracking-widest text-gray-400">
                      Important information
                    </h2>
                    <p className="whitespace-pre-line text-sm text-gray-500">{publicSettings.disclaimer_text}</p>
                    {publicSettings.reply_email && (
                      <p className="mt-4 text-xs text-gray-400">
                        Need changes? Reply to{' '}
                        <a href={`mailto:${publicSettings.reply_email}`} className="text-gray-600 underline underline-offset-2 hover:text-gray-900">
                          {publicSettings.reply_email}
                        </a>.
                      </p>
                    )}
                  </div>
                )}
                {activeVersion.material_description && (
                  <div className="rounded-2xl bg-gray-50 p-6 ring-1 ring-gray-200">
                    <h2 className="mb-3 text-sm font-semibold uppercase tracking-widest text-gray-400">
                      About {activeVersion.material_display}
                    </h2>
                    <div
                      className={[
                        'grid gap-5 items-center',
                        activeVersion.material_icon_url ? 'sm:grid-cols-3' : 'grid-cols-1',
                      ].join(' ')}
                    >
                      {activeVersion.material_icon_url && (
                        <div className="order-first flex items-center justify-center sm:order-last sm:col-span-1">
                          <img
                            src={activeVersion.material_icon_url}
                            alt={`${activeVersion.material_display} icon`}
                            className="max-h-48 max-w-[240px] object-contain"
                          />
                        </div>
                      )}
                      <p className={[
                        'whitespace-pre-line text-sm text-gray-500',
                        activeVersion.material_icon_url ? 'sm:col-span-2' : '',
                      ].join(' ')}>
                        {activeVersion.material_description}
                      </p>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Pricing table — replaced with a quote message when the version is custom-quote */}
            <div className="mb-8 rounded-2xl bg-white shadow-sm ring-1 ring-gray-200">
              <div className="border-b border-gray-100 px-6 py-4">
                <h2 className="text-sm font-semibold uppercase tracking-widest text-gray-400">
                  Pricing
                </h2>
                {!activeVersion.custom_quote && activeOption && versionOptions.length > 0 && materialHasSurcharges && (
                  <p className="mt-1 text-xs text-gray-400">
                    Prices shown for {activeOption.display_name} {optionLabelSingular.toLowerCase()}
                  </p>
                )}
              </div>
              {activeVersion.custom_quote ? (
                <div className="px-6 py-8 text-center">
                  <p className="mx-auto max-w-md text-sm text-gray-600">
                    This proof requires a custom quote. We'll be in touch separately with pricing.
                  </p>
                </div>
              ) : (
                <>
                  <PricingDisplay
                    snapshot={activeVersion.pricing_snapshot}
                    currency={activeVersion.currency}
                    featuredQuantities={activeVersion.featured_quantities}
                    quantitySurcharges={quantitySurcharges}
                  />
                  <div className="border-t border-gray-100 px-6 py-3">
                    <p className="text-xs text-gray-400">
                      {activeVersion.currency === 'GBP' ? 'Prices include VAT. ' : ''}
                      {activeVersion.shipping_note}
                    </p>
                  </div>
                </>
              )}
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
      <dd className="mt-1 whitespace-pre-line text-sm font-medium text-gray-900">{value}</dd>
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

function AbandonedScreen({ proof }: { proof: PublicProof }) {
  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6 lg:px-8">
        <header className="mb-12">
          <p className="text-sm font-medium uppercase tracking-widest text-gray-400">Proof for</p>
          <h1 className="mt-1 text-3xl font-bold text-gray-900">{proof.customer_name}</h1>
          {proof.company && (
            <p className="mt-1 text-lg text-gray-500">{proof.company}</p>
          )}
        </header>
        <div className="rounded-2xl bg-white p-10 text-center shadow-sm ring-1 ring-gray-200">
          <h2 className="text-xl font-semibold text-gray-800">This proof is closed</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-gray-500">
            If you'd like to revisit your business cards, please get in touch.
          </p>
        </div>
      </div>
    </div>
  )
}
