import { formatPrice } from '../../lib/currency'
import type { Currency } from '../../lib/types'
import type { ShippingState } from '../../lib/quote/shipping'
import { applyIntlAdjustment } from '../../lib/quote/shipping'

// FedEx shipping breakdown card. Sits in the Quote compiler's price
// column, styled to match HeadlinePrice / LeadTimeCard chrome
// (rounded-2xl, white background, gray-200 ring).
//
// State-driven render: the parent computes a ShippingState via
// resolveShippingState and passes it in. Four visible states:
//   * loading      — placeholder shimmer
//   * quoted       — full breakdown (base − discount + fuel + other,
//                    plus the international adjustment line and the
//                    final total)
//   * unavailable  — amber affordance, no figure
//   * error        — amber affordance + the error text
//
// not_ready returns null — the parent's render predicate already
// gates on the same inputs, but null-guarding here keeps the
// component self-contained for future call sites.
//
// Currency notes: shipping is zero-rated for VAT in the UK, so the
// GBP rendering does NOT add a "(includes N% VAT)" tag the way
// HeadlinePrice does for product price. The adjustment percentage
// is applied at render — the rate object is unmodified.

export interface ShippingCardProps {
  state: ShippingState
  currency: Currency | null
  intlAdjustPercent: number
}

export function ShippingCard({ state, currency, intlAdjustPercent }: ShippingCardProps) {
  if (state.kind === 'not_ready') return null

  if (state.kind === 'loading') {
    return (
      <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-gray-200">
        <p className="text-xs font-semibold uppercase tracking-widest text-gray-400">
          Shipping
        </p>
        <div className="mt-3 h-7 w-32 animate-pulse rounded bg-gray-100" />
        <div className="mt-2 h-3 w-48 animate-pulse rounded bg-gray-100" />
      </div>
    )
  }

  if (state.kind === 'unavailable') {
    return (
      <div className="rounded-2xl bg-amber-50 p-6 shadow-sm ring-1 ring-amber-200">
        <p className="text-xs font-semibold uppercase tracking-widest text-amber-700">
          Shipping
        </p>
        <p className="mt-2 text-sm font-medium text-amber-900">
          No FedEx Priority service to this destination
        </p>
        <p className="mt-2 text-xs text-amber-800">
          Confirm the destination postcode and country, or quote shipping separately.
        </p>
      </div>
    )
  }

  if (state.kind === 'error') {
    return (
      <div className="rounded-2xl bg-amber-50 p-6 shadow-sm ring-1 ring-amber-200">
        <p className="text-xs font-semibold uppercase tracking-widest text-amber-700">
          Shipping
        </p>
        <p className="mt-2 text-sm font-medium text-amber-900">
          Couldn't fetch a FedEx rate
        </p>
        <p className="mt-2 break-words text-xs text-amber-800">{state.message}</p>
      </div>
    )
  }

  // ── quoted ────────────────────────────────────────────────────
  const { rate } = state
  const renderCurrency = rate.currency ?? currency
  if (!renderCurrency) return null

  // Format negotiated discount as a negative line; FedEx returns
  // discount.amount as a positive number representing the reduction.
  const baseCharge = rate.baseCharge ?? 0
  const discountAmount = rate.discountAmount ?? 0
  const fuelSurcharge = rate.fuelSurcharge ?? 0
  const fuelPercent = rate.fuelPercent
  const netCharge = rate.netCharge ?? 0
  const otherSurchargesTotal = rate.otherSurcharges.reduce((sum, s) => sum + s.amount, 0)

  // International adjustment — applied here at render time so the
  // admin can tweak the percentage and see it reflected on the
  // next reload without flushing the rate cache. 0% leaves
  // netCharge unchanged.
  const adjustedTotal = applyIntlAdjustment(netCharge, intlAdjustPercent)
  const adjustmentAmount = adjustedTotal - netCharge
  const showAdjustment = intlAdjustPercent !== 0

  return (
    <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-gray-200">
      <p className="text-xs font-semibold uppercase tracking-widest text-gray-400">
        Shipping · {renderCurrency}
      </p>
      <p className="mt-1 text-sm font-medium text-gray-700">
        {rate.serviceName ?? 'FedEx International Priority'}
      </p>

      <dl className="mt-4 space-y-1.5 text-sm text-gray-600">
        <BreakdownRow label="Base carriage" amount={baseCharge} currency={renderCurrency} />
        {discountAmount > 0 && (
          <BreakdownRow
            label={
              rate.discountPercent != null
                ? `Negotiated discount (${formatPercent(rate.discountPercent)})`
                : 'Negotiated discount'
            }
            amount={-discountAmount}
            currency={renderCurrency}
          />
        )}
        {fuelSurcharge > 0 && (
          <BreakdownRow
            label={
              fuelPercent != null
                ? `Fuel surcharge (${formatPercent(fuelPercent)})`
                : 'Fuel surcharge'
            }
            amount={fuelSurcharge}
            currency={renderCurrency}
          />
        )}
        {otherSurchargesTotal > 0 && (
          <BreakdownRow
            label={rate.otherSurcharges.length === 1
              ? rate.otherSurcharges[0].label
              : 'Other surcharges'}
            amount={otherSurchargesTotal}
            currency={renderCurrency}
          />
        )}
        {showAdjustment && (
          <BreakdownRow
            label={`International adjustment (${formatPercent(intlAdjustPercent)})`}
            amount={adjustmentAmount}
            currency={renderCurrency}
          />
        )}
      </dl>

      <div className="mt-4 flex items-baseline justify-between border-t border-gray-100 pt-3">
        <span className="text-xs font-semibold uppercase tracking-widest text-gray-500">
          Total shipping
        </span>
        <span className="text-2xl font-bold tabular-nums text-gray-900">
          {formatPrice(adjustedTotal, renderCurrency)}
        </span>
      </div>
      <p className="mt-2 text-xs text-gray-400">
        Shipping is zero-rated for VAT.
        {rate.cached ? ' · Cached rate' : ''}
      </p>
    </div>
  )
}

function BreakdownRow({
  label,
  amount,
  currency,
}: {
  label: string
  amount: number
  currency: Currency
}) {
  // formatPrice rounds to the nearest unit for whole-currency
  // figures; pass 2dp explicitly because shipping breakdowns
  // routinely involve small fractional amounts.
  const isNeg = amount < 0
  const display = isNeg
    ? `−${formatPrice(-amount, currency, 2)}`
    : formatPrice(amount, currency, 2)
  return (
    <div className="flex items-baseline justify-between">
      <dt>{label}</dt>
      <dd className="tabular-nums">{display}</dd>
    </div>
  )
}

// 16.5 → "16.5%", 16 → "16%", 16.25 → "16.25%". Mirrors the
// formatDiscountPercent shape in HeadlinePrice / formatQuoteForCopy
// so on-card and copy-output percentages agree.
function formatPercent(value: number): string {
  const rounded = Math.round(value * 100) / 100
  return `${rounded}%`
}
