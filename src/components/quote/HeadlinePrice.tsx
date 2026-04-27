import { formatPrice } from '../../lib/currency'
import type { Currency } from '../../lib/types'

// Headline price — the largest visual element on the compiler.
// Currency symbol welds directly onto the amount via
// Intl.NumberFormat so "£279" reads as a single token. Whole-pound
// rounding (no decimals) matches how prices are stored in the DB
// and how plasmadesign.co.uk displays them.
//
// VAT note: GBP prices are stored VAT-inclusive, so the inline
// "(includes N% VAT)" tag goes alongside the headline for GBP
// only — the percentage is computed from the configured
// settings.vat_rate_gbp (migration 000115) so an HMRC rate change
// only requires an admin save, no redeploy. EUR/USD prices are
// VAT-free; no VAT line, no fine print.
//
// Below the per-card subline, GBP gets a muted ex-VAT readout —
// "£732.50 ex VAT · £1.47 per card ex" — for designers quoting
// VAT-registered customers. Strips, breakdown lines and the
// custom-quote panel deliberately stay inclusive-only; the
// ex-VAT figure lives only on the headline.
//
// Custom-quote bailout (commit 8) replaces this component with a
// dedicated panel rather than rendering through here, so this
// stays purely numeric.

// Format the configured VAT rate as a human percentage with no
// trailing zeros. 0.20 → "20%", 0.175 → "17.5%", 0.2025 → "20.25%".
function formatVatPercent(rate: number): string {
  const pct = Math.round(rate * 100 * 100) / 100
  return `${pct}%`
}
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
  vatRate,
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
  // GBP VAT rate from settings.vat_rate_gbp. Drives both the
  // computed inline VAT note ("(includes N% VAT)") and the muted
  // ex-VAT readout below the per-card subline. Null while still
  // loading from the cached fetch in src/lib/vatRateGbp.ts; null
  // suppresses the inline note and the ex-VAT line for that
  // first paint rather than flashing a stale 20% figure.
  // Ignored entirely for EUR/USD — those prices are VAT-free.
  vatRate: number | null
}) {
  // Empty / waiting states. We render the chrome so the layout
  // doesn't jump when a price arrives — just dim the price slot
  // to a placeholder dash.
  const showPrice = total != null && currency != null && !loading
  const isGbp = currency === 'GBP'

  // Ex-VAT derivation only for GBP and only once the rate has
  // loaded. Round to 2dp at each step — the per-card figure is
  // derived from the rounded total so the displayed numbers stay
  // self-consistent (designer reading aloud sees total / qty
  // matching the per-card line within rounding).
  const showVatNote = isGbp && vatRate != null
  const exVatTotal =
    showPrice && showVatNote && total != null
      ? Math.round((total / (1 + vatRate)) * 100) / 100
      : null
  const exPerCard =
    exVatTotal != null && quantity != null && quantity > 0
      ? Math.round((exVatTotal / quantity) * 100) / 100
      : null

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
        {showPrice && showVatNote && (
          <span className="text-sm font-medium text-gray-400">
            (includes {formatVatPercent(vatRate!)} VAT)
          </span>
        )}
      </div>
      {showPrice && unitPrice != null && quantity != null && (
        <p className="mt-3 text-sm text-gray-500">
          {formatPrice(unitPrice, currency!, 2)} per card · {quantity.toLocaleString()} cards
        </p>
      )}
      {showPrice && exVatTotal != null && exPerCard != null && (
        <p className="mt-0.5 text-xs text-gray-400 tabular-nums">
          {formatPrice(exVatTotal, 'GBP', 2)} ex VAT · {formatPrice(exPerCard, 'GBP', 2)} per card ex
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
