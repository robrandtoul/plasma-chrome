import { useState } from 'react'
import { formatPrice } from '../lib/currency'
import type { Currency, PricingSnapshot } from '../lib/types'

export function PricingDisplay({
  snapshot,
  currency,
  featuredQuantities,
  quantitySurcharges = {},
}: {
  snapshot: PricingSnapshot
  currency: Currency
  featuredQuantities: number[]
  quantitySurcharges?: Record<number, number>
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

  const hiddenCount = allQuantities.length - allQuantities.filter((q) => featured.has(q)).length
  const showToggle = hiddenCount > 0

  return variants.length === 1 ? (
    <SingleVariantTable
      variant={variants[0]}
      currency={currency}
      quantities={visibleQuantities}
      featured={featured}
      quantitySurcharges={quantitySurcharges}
      showToggle={showToggle}
      showAll={showAll}
      onToggle={() => setShowAll((v) => !v)}
    />
  ) : (
    <MultiVariantGrid
      variants={variants}
      currency={currency}
      quantities={visibleQuantities}
      featured={featured}
      quantitySurcharges={quantitySurcharges}
      showToggle={showToggle}
      showAll={showAll}
      onToggle={() => setShowAll((v) => !v)}
    />
  )
}

// ── Toggle row ────────────────────────────────────────────────────────────────

function ToggleRow({
  colSpan,
  showAll,
  onToggle,
}: {
  colSpan: number
  showAll: boolean
  onToggle: () => void
}) {
  return (
    <tr>
      <td colSpan={colSpan} className="border-t border-gray-100 p-0">
        <button
          type="button"
          aria-expanded={showAll}
          onClick={onToggle}
          className="flex min-h-[44px] w-full cursor-pointer items-center justify-center gap-1.5 px-6 py-3 text-sm font-medium text-gray-500 transition-colors duration-150 hover:bg-gray-50 focus:outline-none focus-visible:bg-gray-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gray-300"
        >
          <span>{showAll ? 'Show fewer quantities' : 'Show all quantities'}</span>
          <svg
            viewBox="0 0 16 16"
            aria-hidden="true"
            className={[
              'h-3.5 w-3.5 transition-transform duration-200',
              showAll ? 'rotate-180' : '',
            ].join(' ')}
          >
            <path
              d="M6 3l5 5-5 5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </td>
    </tr>
  )
}

// ── Single variant ────────────────────────────────────────────────────────────

function SingleVariantTable({
  variant,
  currency,
  quantities,
  featured,
  quantitySurcharges,
  showToggle,
  showAll,
  onToggle,
}: {
  variant: PricingSnapshot['variants'][0]
  currency: Currency
  quantities: number[]
  featured: Set<number>
  quantitySurcharges: Record<number, number>
  showToggle: boolean
  showAll: boolean
  onToggle: () => void
}) {
  const rows = quantities
    .filter((qty) => variant.prices[String(qty)] != null)
    .map((qty) => ({ qty, price: variant.prices[String(qty)] + (quantitySurcharges[qty] ?? 0) }))

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
        {rows.map(({ qty, price }) => {
          const isReveal = !featured.has(qty)
          return (
            <tr
              key={qty}
              className={[
                'border-b border-gray-50 last:border-0',
                isReveal ? 'animate-[reveal-row_200ms_ease-out]' : '',
              ].join(' ')}
            >
              <td className="px-6 py-3 font-medium text-gray-900">{qty.toLocaleString()}</td>
              <td className="px-6 py-3 text-right text-gray-900">{formatPrice(price, currency)}</td>
              <td className="px-6 py-3 text-right text-gray-500">{formatPrice(price / qty, currency, 2)}</td>
            </tr>
          )
        })}
        {showToggle && (
          <ToggleRow colSpan={3} showAll={showAll} onToggle={onToggle} />
        )}
      </tbody>
    </table>
  )
}

// ── Multi-variant grid ────────────────────────────────────────────────────────

function MultiVariantGrid({
  variants,
  currency,
  quantities,
  featured,
  quantitySurcharges,
  showToggle,
  showAll,
  onToggle,
}: {
  variants: PricingSnapshot['variants']
  currency: Currency
  quantities: number[]
  featured: Set<number>
  quantitySurcharges: Record<number, number>
  showToggle: boolean
  showAll: boolean
  onToggle: () => void
}) {
  if (quantities.length === 0) return null

  const colSpan = 1 + variants.length

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
          {quantities.map((qty) => {
            const surcharge = quantitySurcharges[qty] ?? 0
            const isReveal = !featured.has(qty)
            return (
              <tr
                key={qty}
                className={[
                  'border-b border-gray-50 last:border-0',
                  isReveal ? 'animate-[reveal-row_200ms_ease-out]' : '',
                ].join(' ')}
              >
                <td className="px-6 py-3 font-medium text-gray-900">{qty.toLocaleString()}</td>
                {variants.map((v) => {
                  const base = v.prices[String(qty)]
                  if (base == null) {
                    return (
                      <td key={v.variant_id} className="px-4 py-3 text-right">
                        <span className="text-gray-300">—</span>
                      </td>
                    )
                  }
                  const price = base + surcharge
                  return (
                    <td key={v.variant_id} className="px-4 py-3 text-right">
                      <div className="font-medium text-gray-900">{formatPrice(price, currency)}</div>
                      <div className="text-xs text-gray-400">{formatPrice(price / qty, currency, 2)} each</div>
                    </td>
                  )
                })}
              </tr>
            )
          })}
          {showToggle && (
            <ToggleRow colSpan={colSpan} showAll={showAll} onToggle={onToggle} />
          )}
        </tbody>
      </table>
    </div>
  )
}
