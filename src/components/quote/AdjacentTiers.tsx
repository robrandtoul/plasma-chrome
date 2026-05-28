import type { CSSProperties } from 'react'
import { formatPrice } from '../../lib/currency'
import type { Currency } from '../../lib/types'
import type { PriceTier } from '../../lib/quote/calculate'
import { getPublicTiers } from '../../lib/quote/headlineTiers'

const currentCellStyle: CSSProperties = {
  background: 'rgba(123,63,242,0.08)',
  boxShadow: 'inset 0 0 0 1.5px #7b3ff2',
}

// Adjacent quantity tiers — neighbour-below / current / neighbour-
// above for the chosen variant + currency. Visually consultative:
// smaller than the headline price, three columns, current cell
// outlined in violet so the designer can read "next-up / current /
// next-down" at a glance.
//
// Neighbours are picked from the per-material public tier list
// (src/lib/quote/headlineTiers.ts) intersected with the variant's
// actual price_tiers. This surfaces meaningful round-number jumps —
// "going from 250 to 500 saves £X" — rather than the noisy ±25
// neighbours the variant's raw tier list would produce. The current
// cell, however, always shows the actual current quantity and its
// computed price, regardless of whether that quantity is itself a
// public tier.
//
// Hidden entirely when:
// - There's no current quantity yet (nothing to compare against).
// - The current quantity isn't a valid tier (snap chips already
//   own that nudge — showing "next tier above 237" is ambiguous).
// - There are no neighbours to display in either direction (the
//   public tier list is empty for this material, or the current
//   qty is the sole filtered candidate).
//
// Each neighbour cell shows total + per-card unit price, and a
// signed unit-price delta vs the current cell (e.g. "-£0.28/card"
// when going up to a cheaper-per-card tier). Edge cases: at the
// smallest or largest *public* tier in the variant's set, the
// missing direction renders a quiet "—" placeholder.
//
// extraTotalAt resolves the per-cell additive surcharge — the sum
// of any flat-additive surcharge (split-name tooling, constant
// across qty) plus any quantity-tiered surcharge (finish upgrade
// on Steel/Gold). Each cell calls it with its own quantity so
// neighbour rows reflect the surcharge schedule at that qty
// rather than just the headline figure.
export function AdjacentTiers({
  tiers,
  materialCode,
  currentQuantity,
  currency,
  extraTotalAt = () => 0,
  discountPercent = 0,
}: {
  tiers: readonly PriceTier[]
  // Material code for the public-tier lookup. When empty or
  // unmapped the strip suppresses itself rather than guessing.
  materialCode: string | null
  currentQuantity: number | null
  currency: Currency | null
  extraTotalAt?: (qty: number) => number
  // Internal discount percentage (0–100). When non-zero, each
  // cell's total + per-card figure are scaled by (1 − percent/100)
  // so the strip matches the post-discount headline. Per-card
  // deltas between cells still read meaningfully — both sides
  // share the same multiplier, so the relative comparison is
  // preserved.
  discountPercent?: number
}) {
  if (!currency || currentQuantity == null || !materialCode) return null
  const discountMultiplier = 1 - Math.min(Math.max(discountPercent, 0), 100) / 100

  const sorted = [...tiers].sort((a, b) => a.quantity - b.quantity)
  const current = sorted.find((t) => t.quantity === currentQuantity)
  if (!current) return null

  // Public-tier filter. Restricts neighbour candidates to qtys that
  // are both (a) advertised on the public pricing page for this
  // material AND (b) actually present in the variant's tier set.
  // The intersection guards against drift between the public list
  // and the per-variant tier set (e.g. an ink count whose tiers
  // start at 250 even though the material lists 100 publicly).
  const publicQtys = getPublicTiers(materialCode)
  if (publicQtys.length === 0) return null

  const variantQtySet = new Set(sorted.map((t) => t.quantity))
  const filtered = publicQtys
    .filter((q) => variantQtySet.has(q))
    .sort((a, b) => a - b)

  let lowerQty: number | null = null
  let upperQty: number | null = null
  for (const q of filtered) {
    if (q < currentQuantity) lowerQty = q
    else if (q > currentQuantity) { upperQty = q; break }
  }

  // No neighbours either side — strip would be the current cell
  // alone, which adds no comparison value. Suppress.
  if (lowerQty == null && upperQty == null) return null

  const lower = lowerQty != null ? sorted.find((t) => t.quantity === lowerQty) ?? null : null
  const upper = upperQty != null ? sorted.find((t) => t.quantity === upperQty) ?? null : null

  const currentUnit = ((current.totalPrice + extraTotalAt(current.quantity)) * discountMultiplier) / current.quantity

  return (
    <div className="rounded-2xl bg-surface p-5 shadow-sm ring-1 ring-line">
      <p className="text-xs font-semibold uppercase tracking-widest text-ink-dim">
        Adjacent quantities
      </p>
      <div className="mt-3 grid grid-cols-3 gap-2">
        <Cell
          tier={lower}
          currency={currency}
          extraTotal={lower ? extraTotalAt(lower.quantity) : 0}
          discountMultiplier={discountMultiplier}
          deltaUnit={lower ? ((lower.totalPrice + extraTotalAt(lower.quantity)) * discountMultiplier) / lower.quantity - currentUnit : null}
          arrow="◄"
        />
        <Cell
          tier={current}
          currency={currency}
          extraTotal={extraTotalAt(current.quantity)}
          discountMultiplier={discountMultiplier}
          deltaUnit={null}
          isCurrent
        />
        <Cell
          tier={upper}
          currency={currency}
          extraTotal={upper ? extraTotalAt(upper.quantity) : 0}
          discountMultiplier={discountMultiplier}
          deltaUnit={upper ? ((upper.totalPrice + extraTotalAt(upper.quantity)) * discountMultiplier) / upper.quantity - currentUnit : null}
          arrow="►"
          arrowRight
        />
      </div>
    </div>
  )
}

function Cell({
  tier,
  currency,
  extraTotal,
  discountMultiplier,
  deltaUnit,
  isCurrent = false,
  arrow,
  arrowRight = false,
}: {
  tier: PriceTier | null
  currency: Currency
  extraTotal: number
  discountMultiplier: number
  deltaUnit: number | null
  isCurrent?: boolean
  arrow?: string
  arrowRight?: boolean
}) {
  if (!tier) {
    // Edge of the tier range — render a quiet placeholder so the
    // grid layout stays stable and the designer sees "no neighbour
    // this side" without ambiguity.
    return (
      <div className="rounded-lg border border-dashed border-line-soft px-3 py-3 text-center">
        <p className="text-xs text-ink-dim">—</p>
      </div>
    )
  }
  const total = (tier.totalPrice + extraTotal) * discountMultiplier
  const unit = total / tier.quantity
  return (
    <div
      className={[
        'rounded-lg border px-3 py-3',
        isCurrent ? 'border-transparent text-ink' : 'border-line text-ink-soft',
      ].join(' ')}
      style={isCurrent ? currentCellStyle : undefined}
    >
      <p className="flex items-center justify-between text-xs font-medium uppercase tracking-wider text-ink-dim">
        {!arrowRight && arrow && <span aria-hidden>{arrow}</span>}
        <span>{tier.quantity.toLocaleString()}</span>
        {arrowRight && arrow && <span aria-hidden>{arrow}</span>}
      </p>
      <p className="mt-1 text-base font-semibold tabular-nums">
        {formatPrice(total, currency)}
      </p>
      <p className="mt-0.5 text-xs text-ink-mute tabular-nums">
        {formatPrice(unit, currency, 2)}/card
      </p>
      {deltaUnit != null && Math.abs(deltaUnit) > 0.005 && (
        <p
          className={[
            'mt-1 text-xs font-medium tabular-nums',
            deltaUnit < 0 ? 'text-in-stock' : 'text-low',
          ].join(' ')}
        >
          {deltaUnit < 0 ? '−' : '+'}{formatPrice(Math.abs(deltaUnit), currency, 2)}/card
        </p>
      )}
    </div>
  )
}
