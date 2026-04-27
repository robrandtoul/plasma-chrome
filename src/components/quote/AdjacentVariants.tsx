import type { CSSProperties } from 'react'
import { formatPrice } from '../../lib/currency'
import type { Currency } from '../../lib/types'
import type { PriceTier } from '../../lib/quote/calculate'
import { type QuoteVariant, variantSectionLabel } from '../../lib/quote/types'

const currentCellStyle: CSSProperties = {
  background: 'rgba(123,63,242,0.08)',
  boxShadow: 'inset 0 0 0 1.5px #7b3ff2',
}

// Adjacent variant comparison strip. Layout depends on the
// material's variant cardinality:
//
//   variantCount <= 3 → render ALL variants in their material's
//     sort_order. Selected one wears the violet ring. No "—"
//     placeholder cells — the whole set fits, so we show the whole
//     set. Covers all metals (3 thicknesses), Full Colour Plastic
//     (3 thicknesses), Standard Paper (3 finish variants).
//
//   variantCount >= 4 → keep the original "selected ± 1, capped
//     at 3" window. Used by Letterpress / Letterpress with
//     Gilding (8 inks) and Translucent / Tinted / Satin Plastic
//     (6 or 8 inks). At the edges of the range one neighbour is
//     missing; we render a "—" placeholder so the column count
//     stays at 3.
//
// Default-variant materials (Wood, Acrylic, base Carbon Fibre,
// Carbon Fibre with CNC) suppress the strip entirely — there's
// only one variant, nothing to compare against.
//
// The strip evaluates each visible variant at the same quantity
// as the current selection. Variants without a tier at that
// quantity (sparse ink-count tier sets, etc.) render a quiet
// "No price at N" cell rather than crashing.
//
// Hidden entirely when:
// - The current quantity isn't a tier on the *current* variant
//   (snap chips own that nudge).
// - There are fewer than 2 non-default variants.
// - There's no current variant selection.
export function AdjacentVariants({
  variants,
  currentVariantId,
  tiersByVariantId,
  currentQuantity,
  currency,
  extraTotalAt = () => 0,
}: {
  variants: readonly QuoteVariant[]
  currentVariantId: string | null
  tiersByVariantId: Map<string, PriceTier[]>
  currentQuantity: number | null
  currency: Currency | null
  // Per-cell additive surcharge resolved at that cell's quantity.
  // For this strip every cell shares the same quantity, so all
  // three pull the same value — but we keep the callback shape
  // consistent with AdjacentTiers in case a future surcharge
  // dimension keys on variant too.
  extraTotalAt?: (qty: number) => number
}) {
  if (!currency || !currentVariantId || currentQuantity == null) return null
  if (variants.length < 2) return null
  if (variants.length === 1 && variants[0].variant_type === 'default') return null

  const sorted = [...variants].sort((a, b) => a.sort_order - b.sort_order)
  const currentIndex = sorted.findIndex((v) => v.id === currentVariantId)
  if (currentIndex === -1) return null

  // Bail when current variant doesn't have a tier at the chosen
  // quantity. Snap chips already nudge the designer; a comparison
  // with no current cell to anchor against would be misleading.
  const currentTiers = tiersByVariantId.get(currentVariantId) ?? []
  const currentTier = currentTiers.find((t) => t.quantity === currentQuantity)
  if (!currentTier) return null

  const cellExtra = extraTotalAt(currentQuantity)
  const currentUnit = (currentTier.totalPrice + cellExtra) / currentTier.quantity

  // Cell list construction. ≤3 variants → render every one in
  // sort_order, no placeholders. ≥4 → selected ± 1 capped at
  // three, with null cells at range edges rendering as "—"
  // placeholders.
  const cellVariants: (QuoteVariant | null)[] = sorted.length <= 3
    ? sorted
    : [
        currentIndex > 0 ? sorted[currentIndex - 1] : null,
        sorted[currentIndex],
        currentIndex < sorted.length - 1 ? sorted[currentIndex + 1] : null,
      ]

  // Grid columns track cell count so the layout doesn't end up
  // with stretched cells when a 2-variant material renders.
  // Today this matters mostly for forward-compat — every
  // current multi-variant material has 3+ variants — but the
  // shape is right.
  const colsClass = cellVariants.length === 2 ? 'grid-cols-2' : 'grid-cols-3'

  const label = variantSectionLabel(sorted[0].variant_type)

  return (
    <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-gray-200">
      <p className="text-xs font-semibold uppercase tracking-widest text-gray-400">
        Adjacent {label.toLowerCase()}
      </p>
      <div className={`mt-3 grid ${colsClass} gap-2`}>
        {cellVariants.map((variant, idx) => (
          <VariantCell
            key={variant?.id ?? `placeholder-${idx}`}
            variant={variant}
            tiers={variant ? tiersByVariantId.get(variant.id) ?? [] : []}
            currentQuantity={currentQuantity}
            currency={currency}
            currentUnit={currentUnit}
            extraTotal={cellExtra}
            isCurrent={!!variant && variant.id === currentVariantId}
          />
        ))}
      </div>
    </div>
  )
}

function VariantCell({
  variant,
  tiers,
  currentQuantity,
  currency,
  currentUnit,
  extraTotal,
  isCurrent = false,
}: {
  variant: QuoteVariant | null
  tiers: readonly PriceTier[]
  currentQuantity: number
  currency: Currency
  currentUnit: number
  extraTotal: number
  isCurrent?: boolean
}) {
  if (!variant) {
    return (
      <div className="rounded-lg border border-dashed border-gray-100 px-3 py-3 text-center">
        <p className="text-xs text-gray-300">—</p>
      </div>
    )
  }
  const tier = tiers.find((t) => t.quantity === currentQuantity)
  if (!tier) {
    return (
      <div className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-3">
        <p className="text-xs font-medium uppercase tracking-wider text-gray-400">
          {variant.display_name}
        </p>
        <p className="mt-1 text-xs text-gray-300">No price at {currentQuantity.toLocaleString()}</p>
      </div>
    )
  }
  const total = tier.totalPrice + extraTotal
  const unit = total / tier.quantity
  const deltaUnit = isCurrent ? null : unit - currentUnit
  return (
    <div
      className={[
        'rounded-lg border px-3 py-3',
        isCurrent ? 'border-transparent text-gray-900' : 'border-gray-200 text-gray-700',
      ].join(' ')}
      style={isCurrent ? currentCellStyle : undefined}
    >
      <p className="text-xs font-medium uppercase tracking-wider text-gray-400">
        {variant.display_name}
      </p>
      <p className="mt-1 text-base font-semibold tabular-nums">
        {formatPrice(total, currency)}
      </p>
      <p className="mt-0.5 text-xs text-gray-500 tabular-nums">
        {formatPrice(unit, currency, 2)}/card
      </p>
      {deltaUnit != null && Math.abs(deltaUnit) > 0.005 && (
        <p
          className={[
            'mt-1 text-xs font-medium tabular-nums',
            deltaUnit < 0 ? 'text-emerald-700' : 'text-amber-700',
          ].join(' ')}
        >
          {deltaUnit < 0 ? '−' : '+'}{formatPrice(Math.abs(deltaUnit), currency, 2)}/card
        </p>
      )}
    </div>
  )
}
