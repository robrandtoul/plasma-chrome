import { formatPrice } from '../../lib/currency'
import type { Currency } from '../../lib/types'

// Headline price — the largest visual element on the compiler.
// Currency symbol welds directly onto the amount via
// Intl.NumberFormat so "£279" reads as a single token. Whole-pound
// rounding (no decimals) matches how prices are stored in the DB
// and how plasmadesign.co.uk displays them.
//
// VAT note: GBP prices are stored VAT-inclusive, so the inline
// "(includes 20% VAT)" tag goes alongside the headline for GBP
// only. EUR/USD prices are VAT-free; no VAT line, no fine print.
//
// Custom-quote bailout (commit 8) replaces this component with a
// dedicated panel rather than rendering through here, so this
// stays purely numeric.
export function HeadlinePrice({
  total,
  baseTotal,
  splitNameSurcharge,
  perExtraNameSurcharge,
  names,
  finishSurcharge,
  finishLabel,
  unitPrice,
  quantity,
  currency,
  loading,
}: {
  total: number | null
  baseTotal: number | null
  // Total split-name surcharge applied (across all extra names).
  // Drives the breakdown line below the headline; null or 0
  // suppresses it.
  splitNameSurcharge: number | null
  // Per-extra-name surcharge resolved for the active currency.
  // Used in the breakdown copy ("2 × £39") so the maths reads
  // aloud naturally.
  perExtraNameSurcharge: number | null
  names: number
  // Finish (or other material_option) surcharge applied at the
  // current quantity. Null mirrors total when no tier matches;
  // zero when the base option is selected. finishLabel is the
  // option's display name ("Brushed", "Mirror") used in the
  // breakdown copy.
  finishSurcharge: number | null
  finishLabel: string | null
  unitPrice: number | null
  quantity: number | null
  currency: Currency | null
  loading: boolean
}) {
  // Empty / waiting states. We render the chrome so the layout
  // doesn't jump when a price arrives — just dim the price slot
  // to a placeholder dash.
  const showPrice = total != null && currency != null && !loading
  const isGbp = currency === 'GBP'

  return (
    <div className="rounded-2xl bg-white p-8 shadow-sm ring-1 ring-gray-200">
      <p className="text-xs font-semibold uppercase tracking-widest text-gray-400">
        {currency ? `Total · ${currency}` : 'Total'}
      </p>
      <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-2">
        <span
          className={[
            'tabular-nums leading-none',
            // Big, but not exotic. 64px equivalent so it dominates
            // without breaking on narrow viewports.
            'text-6xl font-bold tracking-tight',
            showPrice ? 'text-gray-900' : 'text-gray-300',
          ].join(' ')}
        >
          {showPrice ? formatPrice(total!, currency!) : '—'}
        </span>
        {showPrice && isGbp && (
          <span className="text-sm font-medium text-gray-400">
            (includes 20% VAT)
          </span>
        )}
      </div>
      {showPrice && unitPrice != null && quantity != null && (
        <p className="mt-3 text-sm text-gray-500">
          {formatPrice(unitPrice, currency!, 2)} per card · {quantity.toLocaleString()} cards
        </p>
      )}
      {/* Stacked breakdown — base + each surcharge on its own
          line so the designer can read the maths aloud cleanly,
          even when finish + split-name both apply. The leading
          "£X base" line only renders when at least one surcharge
          is non-zero, so a vanilla quote stays single-line. */}
      {showPrice && baseTotal != null && (
        ((splitNameSurcharge ?? 0) > 0 || (finishSurcharge ?? 0) > 0) && (
          <div className="mt-1 space-y-0.5 text-sm text-gray-500 tabular-nums">
            <p>{formatPrice(baseTotal, currency!)} base</p>
            {(finishSurcharge ?? 0) > 0 && (
              <p>+ {formatPrice(finishSurcharge!, currency!)} {finishLabel ?? 'finish'} surcharge</p>
            )}
            {(splitNameSurcharge ?? 0) > 0 && perExtraNameSurcharge != null && names > 1 && (
              <p>+ {names - 1} × {formatPrice(perExtraNameSurcharge, currency!)} split-name surcharge</p>
            )}
          </div>
        )
      )}
      {!showPrice && !loading && (
        <p className="mt-3 text-sm text-gray-400">
          Pick a material, variant, currency and quantity to see a price.
        </p>
      )}
      {loading && (
        <p className="mt-3 text-sm text-gray-400">Loading prices…</p>
      )}
    </div>
  )
}
