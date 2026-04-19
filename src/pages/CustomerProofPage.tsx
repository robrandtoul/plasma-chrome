import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import type { PublicProof, PublicProofVersion, AppSettings, PricingSnapshot, Currency } from '../lib/types'
import { formatPrice } from '../lib/currency'

const SIGNED_URL_TTL = 60 * 60 * 24 // 24 hours in seconds

export default function CustomerProofPage() {
  const { id } = useParams<{ id: string }>()

  const [proof, setProof] = useState<PublicProof | null>(null)
  const [versions, setVersions] = useState<PublicProofVersion[]>([])
  const [activeVersion, setActiveVersion] = useState<PublicProofVersion | null>(null)
  const [disclaimer, setDisclaimer] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)

  useEffect(() => {
    if (!id) { setNotFound(true); return }
    loadProof(id)
  }, [id])

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

    // Resolve signed URLs for all versions in parallel.
    const withUrls = await Promise.all(
      rawVersions.map(async (v) => {
        const { data } = await supabase.storage
          .from('proof-images')
          .createSignedUrl(v.image_path, SIGNED_URL_TTL)
        return { ...v, signed_image_url: data?.signedUrl ?? '' }
      })
    )

    setVersions(withUrls)
    setActiveVersion(withUrls.find((v) => v.is_current) ?? withUrls[withUrls.length - 1] ?? null)
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
            {/* Proof image */}
            <div className="mb-8 overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-gray-200">
              {activeVersion.signed_image_url ? (
                <img
                  src={activeVersion.signed_image_url}
                  alt={`Proof version ${activeVersion.version_number}`}
                  className="w-full object-contain"
                />
              ) : (
                <div className="flex h-64 items-center justify-center text-gray-400">
                  Image unavailable
                </div>
              )}
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

  // All quantities present in the snapshot, sorted ascending
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
