import { useState } from 'react'
import { formatPrice } from '../lib/currency'
import type { Currency, PricingSnapshot } from '../lib/types'

export function PricingDisplay({
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
