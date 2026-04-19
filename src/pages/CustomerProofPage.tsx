import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import type { PublicProof, PublicProofVersion, AppSettings, PricingSnapshot, Currency } from '../lib/types'
import { formatPrice } from '../lib/currency'

const SIGNED_URL_TTL = 60 * 60 * 24 // 24 hours in seconds

interface VersionImage {
  id: string
  proof_version_id: string
  image_path: string
  label: string
  sort_order: number
  signed_url: string
}

export default function CustomerProofPage() {
  const { id } = useParams<{ id: string }>()

  const [proof, setProof] = useState<PublicProof | null>(null)
  const [versions, setVersions] = useState<PublicProofVersion[]>([])
  const [activeVersion, setActiveVersion] = useState<PublicProofVersion | null>(null)
  const [versionImages, setVersionImages] = useState<Record<string, VersionImage[]>>({})
  const [disclaimer, setDisclaimer] = useState<string>('')
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)

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

  async function loadProof(proofId: string) {
    setLoading(true)

    const [proofResult, versionsResult, settingsResult] = await Promise.all([
      supabase.from('public_proofs').select('*').eq('id', proofId).maybeSingle(),
      supabase.from('public_proof_versions').select('*').eq('proof_id', proofId).order('version_number', { ascending: true }),
      supabase.from('app_settings').select('disclaimer_html').eq('id', 1).maybeSingle(),
    ])

    if (proofResult.error || !proofResult.data) {
      setNotFound(true)
      setLoading(false)
      return
    }

    setProof(proofResult.data as PublicProof)
    if (settingsResult.data) setDisclaimer((settingsResult.data as AppSettings).disclaimer_html)

    const rawVersions = (versionsResult.data ?? []) as PublicProofVersion[]
    setVersions(rawVersions)
    setActiveVersion(rawVersions.find((v) => v.is_current) ?? rawVersions[rawVersions.length - 1] ?? null)

    // Load images for all versions
    if (rawVersions.length > 0) {
      const versionIds = rawVersions.map((v) => v.id)
      const { data: imageRows } = await supabase
        .from('public_proof_version_images')
        .select('*')
        .in('proof_version_id', versionIds)
        .order('sort_order')

      const imagesWithUrls = await Promise.all(
        ((imageRows ?? []) as Omit<VersionImage, 'signed_url'>[]).map(async (img) => {
          const { data } = await supabase.storage
            .from('proof-images')
            .createSignedUrl(img.image_path, SIGNED_URL_TTL)
          return { ...img, signed_url: data?.signedUrl ?? '' }
        })
      )

      const byVersion: Record<string, VersionImage[]> = {}
      imagesWithUrls.forEach((img) => {
        if (!byVersion[img.proof_version_id]) byVersion[img.proof_version_id] = []
        byVersion[img.proof_version_id].push(img)
      })
      setVersionImages(byVersion)
    }

    setLoading(false)
  }

  if (loading) return <LoadingScreen />
  if (notFound || !proof) return <NotFoundScreen />

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6 lg:px-8">

        {/* Header */}
        <header className="mb-8">
          <p className="text-sm font-medium uppercase tracking-widest text-gray-400">Proof for</p>
          <h1 className="mt-1 text-3xl font-bold text-gray-900">{proof.customer_name}</h1>
          {proof.company && (
            <p className="mt-1 text-lg text-gray-500">{proof.company}</p>
          )}
        </header>

        {/* Version tabs */}
        {versions.length > 1 && (
          <div className="mb-6 flex gap-2 overflow-x-auto">
            {versions.map((v) => (
              <button
                key={v.id}
                onClick={() => setActiveVersion(v)}
                className={[
                  'shrink-0 rounded-full px-4 py-1.5 text-sm font-medium transition-colors',
                  activeVersion?.id === v.id
                    ? 'bg-gray-900 text-white'
                    : 'bg-white text-gray-600 ring-1 ring-gray-200 hover:bg-gray-50',
                ].join(' ')}
              >
                Version {v.version_number}
                {v.is_current && (
                  <span className="ml-2 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700">
                    Current
                  </span>
                )}
              </button>
            ))}
          </div>
        )}

        {activeVersion && (
          <>
            {/* Proof images */}
            <div className="mb-8">
              <ImageGrid
                images={versionImages[activeVersion.id] ?? []}
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
                {activeVersion.ink_names.length > 0 && (
                  <SpecItem label="Inks" value={activeVersion.ink_names.join(', ')} />
                )}
              </dl>
            </div>

            {/* Pricing table */}
            <div className="mb-8 rounded-2xl bg-white shadow-sm ring-1 ring-gray-200">
              <div className="border-b border-gray-100 px-6 py-4">
                <h2 className="text-sm font-semibold uppercase tracking-widest text-gray-400">
                  Pricing
                </h2>
              </div>
              <PricingDisplay
                snapshot={activeVersion.pricing_snapshot}
                currency={activeVersion.currency}
                featuredQuantities={activeVersion.featured_quantities}
              />
              <div className="border-t border-gray-100 px-6 py-3">
                <p className="text-xs text-gray-400">{activeVersion.shipping_note}</p>
              </div>
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
          </>
        )}

        {/* Disclaimer */}
        {disclaimer && (
          <div
            className="prose prose-sm max-w-none text-gray-400"
            dangerouslySetInnerHTML={{ __html: disclaimer }}
          />
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

function ImageGrid({
  images,
  versionNumber,
  onImageClick,
}: {
  images: VersionImage[]
  versionNumber: number
  onImageClick: (src: string) => void
}) {
  if (images.length === 0) {
    return (
      <div className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-gray-200">
        <div className="flex h-64 items-center justify-center text-gray-400">
          Image unavailable
        </div>
      </div>
    )
  }

  if (images.length === 1) {
    return (
      <div
        className="cursor-zoom-in overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-gray-200"
        onClick={() => onImageClick(images[0].signed_url)}
      >
        <img
          src={images[0].signed_url}
          alt={`Proof version ${versionNumber}`}
          className="w-full object-contain"
        />
        {images[0].label && (
          <div className="border-t border-gray-100 px-4 py-2 text-center text-sm text-gray-500">
            {images[0].label}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {images.map((img) => (
        <div
          key={img.id}
          className="cursor-zoom-in overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-gray-200"
          onClick={() => onImageClick(img.signed_url)}
        >
          <img
            src={img.signed_url}
            alt={img.label || `Proof version ${versionNumber}`}
            className="w-full object-contain"
          />
          {img.label && (
            <div className="border-t border-gray-100 px-4 py-2 text-center text-sm text-gray-500">
              {img.label}
            </div>
          )}
        </div>
      ))}
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

function PricingDisplay({
  snapshot,
  currency,
  featuredQuantities,
}: {
  snapshot: PricingSnapshot
  currency: Currency
  featuredQuantities: number[]
}) {
  const [showAll, setShowAll] = useState(false)
  const { variants } = snapshot
  if (!variants?.length) return null

  const allQuantities = [...new Set(
    variants.flatMap((v) => Object.keys(v.prices).map(Number))
  )].sort((a, b) => a - b)

  const featured = new Set(featuredQuantities)
  const visibleQuantities = showAll
    ? allQuantities
    : allQuantities.filter((q) => featured.has(q))

  const hasHidden = allQuantities.length > visibleQuantities.length

  return (
    <>
      {variants.length === 1
        ? <SingleVariantTable variant={variants[0]} currency={currency} quantities={visibleQuantities} />
        : <MultiVariantGrid variants={variants} currency={currency} quantities={visibleQuantities} />
      }
      {(hasHidden || showAll) && (
        <div className="border-t border-gray-50 px-6 py-3">
          <button
            onClick={() => setShowAll((v) => !v)}
            className="text-xs text-gray-400 underline underline-offset-2 hover:text-gray-600"
          >
            {showAll ? 'Show fewer quantities' : 'Show all quantities'}
          </button>
        </div>
      )}
    </>
  )
}

function SingleVariantTable({
  variant,
  currency,
  quantities,
}: {
  variant: PricingSnapshot['variants'][0]
  currency: Currency
  quantities: number[]
}) {
  const rows = quantities
    .filter((qty) => variant.prices[String(qty)] != null)
    .map((qty) => ({ qty, price: variant.prices[String(qty)] }))

  if (rows.length === 0) return null

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-gray-100">
          <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Quantity</th>
          <th className="px-6 py-3 text-right text-xs font-semibold uppercase tracking-wider text-gray-400">Total</th>
          <th className="px-6 py-3 text-right text-xs font-semibold uppercase tracking-wider text-gray-400">Per card</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ qty, price }) => (
          <tr key={qty} className="border-b border-gray-50 last:border-0">
            <td className="px-6 py-3 font-medium text-gray-900">{qty.toLocaleString()}</td>
            <td className="px-6 py-3 text-right text-gray-900">{formatPrice(price, currency)}</td>
            <td className="px-6 py-3 text-right text-gray-500">{formatPrice(price / qty, currency, 2)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function MultiVariantGrid({
  variants,
  currency,
  quantities,
}: {
  variants: PricingSnapshot['variants']
  currency: Currency
  quantities: number[]
}) {
  if (quantities.length === 0) return null

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-100">
            <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">
              Quantity
            </th>
            {variants.map((v) => (
              <th key={v.variant_id} className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-gray-400">
                {v.display}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {quantities.map((qty) => (
            <tr key={qty} className="border-b border-gray-50 last:border-0">
              <td className="px-6 py-3 font-medium text-gray-900">{qty.toLocaleString()}</td>
              {variants.map((v) => {
                const price = v.prices[String(qty)]
                return (
                  <td key={v.variant_id} className="px-4 py-3 text-right">
                    {price != null ? (
                      <>
                        <div className="font-medium text-gray-900">{formatPrice(price, currency)}</div>
                        <div className="text-xs text-gray-400">{formatPrice(price / qty, currency, 2)} each</div>
                      </>
                    ) : (
                      <span className="text-gray-300">—</span>
                    )}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
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
