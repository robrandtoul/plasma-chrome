import { formatPrice } from '../../lib/currency'
import type { Currency } from '../../lib/types'
import type { ShippingState, DomesticRegion, ParcelSplit } from '../../lib/quote/shipping'
import { applyIntlAdjustment } from '../../lib/quote/shipping'
import { gbpToCurrency, type ExchangeRates } from '../../lib/exchangeRates'

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
// Currency conversion: FedEx invoices Plasma in GBP regardless of
// the preferredCurrency on the request, so the rate the edge
// function returns is always denominated in GBP. When the
// compiler's currency selector is on EUR or USD, every line on
// the breakdown is converted at the live ECB rate (Frankfurter
// via getExchangeRates). The card surfaces the rate it used in a
// footnote so the designer can see what the conversion is based on.
//
// Other notes: shipping is zero-rated for VAT in the UK, so the
// GBP rendering does NOT add a "(includes N% VAT)" tag the way
// HeadlinePrice does for product price. The adjustment percentage
// is applied at render — the rate object is unmodified.

export interface ShippingCardProps {
  state: ShippingState
  currency: Currency | null
  intlAdjustPercent: number
  /** Resolved parcel split — per-box weights, total weight, and
   *  box count. Surfaced as a "Parcel weight" row plus an optional
   *  "Boxes" line when N > 1. Null while inputs aren't complete. */
  parcelSplit: ParcelSplit | null
  /** Live GBP → EUR / USD multipliers, or null while the helper is
   *  still resolving (or after a transient failure). When null the
   *  card falls through to GBP figures regardless of the compiler
   *  currency so designers never see a blank or zero figure mid-call. */
  exchangeRates: ExchangeRates | null
  /** GBP VAT rate from settings.vat_rate_gbp (migration 000115).
   *  Drives the "inc VAT (£X ex VAT)" footnote on the GBP path for
   *  domestic shipping — UK DPD shipments are standard-rated, unlike
   *  the FedEx zero-rated export. Null while still loading or for
   *  EUR/USD; both cases suppress the footnote. */
  vatRate: number | null
}

export function ShippingCard({
  state,
  currency,
  intlAdjustPercent,
  parcelSplit,
  exchangeRates,
  vatRate,
}: ShippingCardProps) {
  if (state.kind === 'not_ready') return null
  // Convenience accessor — most rows read the total; only the
  // multi-box display reads the box count.
  const parcelWeightGrams = parcelSplit?.totalGrams ?? null
  const boxCount = parcelSplit?.boxCount ?? null

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
        <p className="mt-2 break-words text-sm font-medium text-amber-900">
          {state.message}
        </p>
      </div>
    )
  }

  // ── domestic UK (migration 000179) ────────────────────────────
  // Flat DPD rate from settings, no fetch. Single line total (no
  // per-line breakdown — there's nothing to break down for a flat
  // rate). VAT shown inclusive-of for GBP, exactly like the
  // product HeadlinePrice does. EUR / USD convert from the GBP
  // base at the live ECB rate.
  if (state.kind === 'domestic') {
    const displayCurrency: Currency = currency ?? 'GBP'
    const multiplier = gbpToCurrency(displayCurrency, exchangeRates)
    const totalDisplay = state.rate.totalGbp * multiplier
    const showVatFootnote = displayCurrency === 'GBP' && vatRate != null && vatRate > 0
    const exVatTotal = showVatFootnote
      ? Math.round((state.rate.totalGbp / (1 + vatRate)) * 100) / 100
      : null
    const showConversionNote = displayCurrency !== 'GBP' && exchangeRates !== null
    return (
      <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-gray-200">
        <p className="text-xs font-semibold uppercase tracking-widest text-gray-400">
          Shipping · {displayCurrency}
        </p>
        <p className="mt-1 text-sm font-medium text-gray-700">
          DPD UK · {regionLabel(state.rate.region)}
        </p>

        <dl className="mt-4 space-y-1.5 text-sm text-gray-600">
          {parcelWeightGrams != null && (
            <div className="flex items-baseline justify-between">
              <dt>Parcel weight</dt>
              <dd className="tabular-nums">{formatWeight(parcelWeightGrams)}</dd>
            </div>
          )}
          {boxCount != null && boxCount > 1 && (
            <div className="flex items-baseline justify-between">
              <dt>Boxes</dt>
              <dd className="tabular-nums">{formatBoxCount(parcelSplit!)}</dd>
            </div>
          )}
        </dl>

        <div className="mt-4 flex items-baseline justify-between border-t border-gray-100 pt-3">
          <span className="text-xs font-semibold uppercase tracking-widest text-gray-500">
            Total shipping
          </span>
          <span className="text-2xl font-bold tabular-nums text-gray-900">
            {formatPrice(totalDisplay, displayCurrency)}
          </span>
        </div>
        {showVatFootnote && exVatTotal != null && (
          <p className="mt-2 text-xs text-gray-400 tabular-nums">
            Includes {Math.round(vatRate * 100)}% VAT · {formatPrice(exVatTotal, 'GBP', 2)} ex VAT
          </p>
        )}
        {showConversionNote && exchangeRates && (
          <p className="mt-1 text-xs text-gray-400">
            Converted from {formatPrice(state.rate.totalGbp, 'GBP', 2)} at 1 GBP = {formatRate(multiplier, displayCurrency)}
            {exchangeRates.rateDate ? ` (ECB ${exchangeRates.rateDate})` : ''}.
          </p>
        )}
      </div>
    )
  }

  // ── quoted ────────────────────────────────────────────────────
  const { rate } = state
  // Display currency follows the compiler's selector, not the rate
  // object — the rate object is always GBP (see file header), the
  // selector decides what currency we present to the designer.
  const displayCurrency: Currency = currency ?? 'GBP'
  const multiplier = gbpToCurrency(displayCurrency, exchangeRates)
  const showConversionNote = displayCurrency !== 'GBP' && exchangeRates !== null

  // Base (GBP) figures from the rate. Convert each at render time
  // so the per-line breakdown reads in the displayed currency.
  const baseChargeGbp = rate.baseCharge ?? 0
  const discountAmountGbp = rate.discountAmount ?? 0
  const fuelSurchargeGbp = rate.fuelSurcharge ?? 0
  const fuelPercent = rate.fuelPercent
  const netChargeGbp = rate.netCharge ?? 0
  const otherSurchargesTotalGbp = rate.otherSurcharges.reduce((sum, s) => sum + s.amount, 0)
  const adjustedTotalGbp = applyIntlAdjustment(netChargeGbp, intlAdjustPercent)
  const adjustmentAmountGbp = adjustedTotalGbp - netChargeGbp
  const showAdjustment = intlAdjustPercent !== 0

  return (
    <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-gray-200">
      <p className="text-xs font-semibold uppercase tracking-widest text-gray-400">
        Shipping · {displayCurrency}
      </p>
      <p className="mt-1 text-sm font-medium text-gray-700">
        {rate.serviceName ?? 'FedEx International Priority'}
      </p>

      <dl className="mt-4 space-y-1.5 text-sm text-gray-600">
        {parcelWeightGrams != null && (
          <div className="flex items-baseline justify-between">
            <dt>Parcel weight</dt>
            <dd className="tabular-nums">{formatWeight(parcelWeightGrams)}</dd>
          </div>
        )}
        {boxCount != null && boxCount > 1 && (
          <div className="flex items-baseline justify-between">
            <dt>Boxes</dt>
            <dd className="tabular-nums">{formatBoxCount(parcelSplit!)}</dd>
          </div>
        )}
        <BreakdownRow label="Base carriage" amount={baseChargeGbp * multiplier} currency={displayCurrency} />
        {discountAmountGbp > 0 && (
          <BreakdownRow
            label={
              rate.discountPercent != null
                ? `Negotiated discount (${formatPercent(rate.discountPercent)})`
                : 'Negotiated discount'
            }
            amount={-discountAmountGbp * multiplier}
            currency={displayCurrency}
          />
        )}
        {fuelSurchargeGbp > 0 && (
          <BreakdownRow
            label={
              fuelPercent != null
                ? `Fuel surcharge (${formatPercent(fuelPercent)})`
                : 'Fuel surcharge'
            }
            amount={fuelSurchargeGbp * multiplier}
            currency={displayCurrency}
          />
        )}
        {otherSurchargesTotalGbp > 0 && (
          <BreakdownRow
            label={rate.otherSurcharges.length === 1
              ? rate.otherSurcharges[0].label
              : 'Other surcharges'}
            amount={otherSurchargesTotalGbp * multiplier}
            currency={displayCurrency}
          />
        )}
        {showAdjustment && (
          <BreakdownRow
            label={`International adjustment (${formatPercent(intlAdjustPercent)})`}
            amount={adjustmentAmountGbp * multiplier}
            currency={displayCurrency}
          />
        )}
      </dl>

      <div className="mt-4 flex items-baseline justify-between border-t border-gray-100 pt-3">
        <span className="text-xs font-semibold uppercase tracking-widest text-gray-500">
          Total shipping
        </span>
        <span className="text-2xl font-bold tabular-nums text-gray-900">
          {formatPrice(adjustedTotalGbp * multiplier, displayCurrency)}
        </span>
      </div>
      <p className="mt-2 text-xs text-gray-400">
        Shipping is zero-rated for VAT.
        {rate.cached ? ' · Cached rate' : ''}
      </p>
      {showConversionNote && exchangeRates && (
        <p className="mt-1 text-xs text-gray-400">
          Converted from GBP at 1 GBP = {formatRate(multiplier, displayCurrency)}
          {exchangeRates.rateDate ? ` (ECB ${exchangeRates.rateDate})` : ''}.
        </p>
      )}
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

// 1,250g → "1.25 kg", 500g → "0.5 kg". Reading aloud sounds more
// natural in kilograms once you're over a kilo, and stays
// reasonable below it (parcels under 1 kg show one decimal place).
function formatWeight(grams: number): string {
  const kg = grams / 1000
  if (kg >= 1) return `${kg.toFixed(2)} kg`
  return `${kg.toFixed(2)} kg`
}

function regionLabel(region: DomesticRegion): string {
  return region === 'uk_ni' ? 'Northern Ireland delivery' : 'Mainland delivery'
}

// "2 × 14.12 kg" when all boxes share a weight; "3 boxes (12.00,
// 12.00, 12.13 kg)" if rounding gave the last box a different
// total. Most splits are even (per-box weights match to the gram)
// so the simple form is what designers usually see.
function formatBoxCount(split: ParcelSplit): string {
  const { boxWeightsGrams, boxCount } = split
  const allEqual = boxWeightsGrams.every((w) => w === boxWeightsGrams[0])
  if (allEqual) {
    return `${boxCount} × ${(boxWeightsGrams[0] / 1000).toFixed(2)} kg`
  }
  const parts = boxWeightsGrams.map((w) => (w / 1000).toFixed(2))
  return `${boxCount} boxes (${parts.join(', ')} kg)`
}

// 1.1735 → "€1.17", 1.27 → "$1.27". Two decimals is plenty for
// rate display — the designer's reading the round figures from
// HeadlinePrice, not the per-unit conversion factor.
function formatRate(multiplier: number, currency: Currency): string {
  const symbol = currency === 'EUR' ? '€' : currency === 'USD' ? '$' : '£'
  return `${symbol}${multiplier.toFixed(4)}`
}
