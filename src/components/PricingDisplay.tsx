import { useState } from 'react'
import { formatPrice } from '../lib/currency'
import { compilePersonalisationSurcharges, personalisationBreakeven } from '../lib/personalisation'
import type { Currency, PersonalisationPricing, PricingSnapshot } from '../lib/types'

export function PricingDisplay({
  snapshot,
  currency,
  displayQuantities,
  quantitySurcharges = {},
  personalisationPricing = null,
}: {
  // Nullable snapshot: post-000117, proof_versions.pricing_snapshot
  // can legitimately be null (the column became nullable when the
  // pricing grid moved to live computation from price_tiers). The
  // designer-side modal builds the snapshot client-side and gates
  // the loading state outside this component, but a defensive
  // null-guard here protects against any future call site that
  // forgets — destructuring a null prop without a guard threw a
  // TypeError that crashed the whole modal in the past.
  snapshot: PricingSnapshot | null | undefined
  currency: Currency
  displayQuantities: number[]
  quantitySurcharges?: Record<number, number>
  // Membership-style personalisation (migration 000172). When set,
  // a separate row group renders beneath the variant table with one
  // (quantity, per-batch surcharge) row per visible quantity, plus a
  // breakeven footnote. Deliberately NOT folded into the base/finish
  // cells: the customer page renders Personalisation as its own row
  // group too (see PaperPricingTable in CustomerProofPage.tsx) and a
  // designer flipping between surfaces must see the same shape.
  // Caller gates this at the version level (has_personalisation +
  // !custom_quote + !is_per_direction_pricing), mirroring the
  // customer page's activePersonalisationPricing reducer.
  personalisationPricing?: PersonalisationPricing | null
}) {
  const [showAll, setShowAll] = useState(false)
  if (!snapshot) return null
  const { variants } = snapshot
  if (!variants?.length) return null

  const allQuantities = [...new Set(
    variants.flatMap((v) => Object.keys(v.prices).map(Number))
  )].sort((a, b) => a - b)

  // Designer preview keeps a show-more toggle so the designer can
  // audit every tier behind the curated list. Customer page (post
  // migration 000095) uses the curated list only — no toggle —
  // and defers to quote bounds + the lookup input for anything
  // outside the shown rows.
  const displaySet = new Set(displayQuantities)
  const visibleQuantities = showAll
    ? allQuantities
    : allQuantities.filter((q) => displaySet.has(q))

  const hiddenCount = allQuantities.length - allQuantities.filter((q) => displaySet.has(q)).length
  const showToggle = hiddenCount > 0

  // Personalisation rows render beneath the variant table when the
  // prop is set. Computed across allQuantities so the show-all
  // toggle reveals correctly priced rows for any quantity exposed
  // above. Option surcharges stay in quantitySurcharges and merge
  // into the base/finish cells in the variant tables themselves.
  const personalisationByQty = personalisationPricing
    ? compilePersonalisationSurcharges(allQuantities, personalisationPricing)
    : null
  const breakevenQty = personalisationPricing
    ? personalisationBreakeven(personalisationPricing)
    : null

  return (
    <>
      {variants.length === 1 ? (
        <SingleVariantTable
          variant={variants[0]}
          currency={currency}
          quantities={visibleQuantities}
          displaySet={displaySet}
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
          displaySet={displaySet}
          quantitySurcharges={quantitySurcharges}
          showToggle={showToggle}
          showAll={showAll}
          onToggle={() => setShowAll((v) => !v)}
        />
      )}
      {personalisationByQty && (
        <PersonalisationRowGroup
          currency={currency}
          quantities={visibleQuantities}
          personalisationByQty={personalisationByQty}
          breakevenQty={breakevenQty}
        />
      )}
    </>
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
  displaySet,
  quantitySurcharges,
  showToggle,
  showAll,
  onToggle,
}: {
  variant: PricingSnapshot['variants'][0]
  currency: Currency
  quantities: number[]
  displaySet: Set<number>
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
          {/* "Total quantity" + "Price" (rather than the earlier
              "Quantity" + "Total") spells out that the quantity
              is the full run across every name/variant, not
              per-identity. Switching the second header away from
              "Total" also avoids the adjacent double-use of the
              word when "Total quantity" sits next to it. */}
          <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Total quantity</th>
          <th className="px-6 py-3 text-right text-xs font-semibold uppercase tracking-wider text-gray-400">Price</th>
          <th className="px-6 py-3 text-right text-xs font-semibold uppercase tracking-wider text-gray-400">Per card</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ qty, price }) => {
          const isReveal = !displaySet.has(qty)
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
  displaySet,
  quantitySurcharges,
  showToggle,
  showAll,
  onToggle,
}: {
  variants: PricingSnapshot['variants']
  currency: Currency
  quantities: number[]
  displaySet: Set<number>
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
            const isReveal = !displaySet.has(qty)
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

// ── Personalisation row group ────────────────────────────────────────────────
//
// Per-batch personalisation surcharge per visible quantity. Mirrors
// the customer page's PaperPricingTable (CustomerProofPage.tsx, search
// "function PaperPricingTable") which renders Personalisation as a
// sibling row group beneath the price grid, not folded into the cells.
// Designer-side styling uses the modal's own gray/tailwind idiom (the
// surrounding card is gray-on-white; PaperPricingTable's serif/mono
// paper styling would clash) — the structural match is what matters
// when a designer compares numbers across the two surfaces.

function PersonalisationRowGroup({
  currency,
  quantities,
  personalisationByQty,
  breakevenQty,
}: {
  currency: Currency
  quantities: number[]
  personalisationByQty: Record<number, number>
  breakevenQty: number | null
}) {
  if (quantities.length === 0) return null
  return (
    <div className="border-t border-gray-100">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-100">
            <th
              colSpan={2}
              className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400"
            >
              Personalisation
            </th>
          </tr>
        </thead>
        <tbody>
          {quantities.map((qty) => {
            const surcharge = personalisationByQty[qty] ?? 0
            return (
              <tr key={qty} className="border-b border-gray-50 last:border-0">
                <td className="px-6 py-3 font-medium text-gray-900">{qty.toLocaleString()}</td>
                <td className="px-6 py-3 text-right text-gray-900">
                  + {formatPrice(surcharge, currency)}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {breakevenQty != null && breakevenQty > 0 && (
        <p className="px-6 py-3 text-xs text-gray-500">
          A minimum personalisation charge applies below {breakevenQty.toLocaleString()} cards.
        </p>
      )}
    </div>
  )
}
