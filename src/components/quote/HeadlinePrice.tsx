import { formatPrice } from '../../lib/currency'
import type { Currency } from '../../lib/types'
import { LetterpressMotif } from '../../design'

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

// Format the discount percentage with up to 2 decimals, trimming
// trailing zeros so "10" reads as "10%" not "10.00%". The form
// allows 0.5-step input; the formatter accepts arbitrary precision
// (a future preset could land 12.5%).
function formatDiscountPercent(value: number): string {
  const rounded = Math.round(value * 100) / 100
  return `${rounded}%`
}
export function HeadlinePrice({
  total,
  baseTotal,
  splitNameSurcharge,
  perExtraNameSurcharge,
  names,
  finishSurcharge,
  finishLabel,
  personalisationSurcharge,
  personalisationBreakevenQty,
  subtotal,
  discountPercent,
  discountAmount,
  unitPrice,
  quantity,
  currency,
  loading,
  vatRate,
  interpolated = false,
  interpolationLowerQty = null,
  interpolationUpperQty = null,
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
  // Migration 000172. Personalisation surcharge at the current
  // quantity. Null mirrors total when no tier matches; zero when
  // personalisation is off. Renders as a separate breakdown line
  // plus a "Minimum charge applies below N cards" footnote keyed
  // off personalisationBreakevenQty.
  personalisationSurcharge: number | null
  personalisationBreakevenQty: number | null
  // Pre-discount subtotal (base + every surcharge). Surfaced as
  // a strikethrough sibling to the discounted headline so the
  // designer reads "was £X → now £Y" at a glance. Null when no
  // tier matches.
  subtotal: number | null
  // Internal discount percentage carried through from the result.
  // 0 means no discount applied; > 0 reveals the discount line in
  // the breakdown and the strikethrough subtotal beside the
  // headline figure.
  discountPercent: number
  // Absolute discount amount in major currency units. Null mirrors
  // total when no tier matches.
  discountAmount: number | null
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
  // Non-standard-quantity interpolation (migration-free, frontend
  // only). When the typed quantity sits between two listed tiers the
  // total is interpolated, not read from a tier — surface that as an
  // "Estimated" badge plus a "between X and Y" note so the designer
  // never mistakes an estimate for a published price. The two anchor
  // quantities drive the note copy. See
  // docs/ordering-checkout-spec.md "Non-standard quantities".
  interpolated?: boolean
  interpolationLowerQty?: number | null
  interpolationUpperQty?: number | null
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
    <div className="relative overflow-hidden rounded-2xl bg-ink p-8 text-on-ink">
      <LetterpressMotif size={220} top={-30} right={-30} opacity={0.13} />
      <div className="relative z-[1]">
      <p className="text-xs font-semibold uppercase tracking-widest text-on-ink/55">
        {currency ? `Total · ${currency}` : 'Total'}
      </p>
      <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-2">
        <span
          className={[
            'tabular-nums leading-none',
            // Big, but not exotic. 64px equivalent so it dominates
            // without breaking on narrow viewports.
            'text-6xl font-bold tracking-tight',
            showPrice ? 'text-on-ink' : 'text-on-ink/40',
          ].join(' ')}
        >
          {showPrice ? formatPrice(total!, currency!) : '—'}
        </span>
        {showPrice && discountPercent > 0 && subtotal != null && (
          <span className="text-sm font-medium text-on-ink/55 line-through tabular-nums">
            {formatPrice(subtotal, currency!)}
          </span>
        )}
        {showPrice && showVatNote && (
          <span className="text-sm font-medium text-on-ink/55">
            (includes {formatVatPercent(vatRate!)} VAT)
          </span>
        )}
        {showPrice && interpolated && (
          <span className="rounded-full bg-on-ink/15 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-on-ink/80">
            Estimated
          </span>
        )}
      </div>
      {showPrice && unitPrice != null && quantity != null && (
        <p className="mt-3 text-sm text-on-ink/75">
          {formatPrice(unitPrice, currency!, 2)} per card · {quantity.toLocaleString()} cards
        </p>
      )}
      {showPrice && exVatTotal != null && exPerCard != null && (
        <p className="mt-0.5 text-xs text-on-ink/55 tabular-nums">
          {formatPrice(exVatTotal, 'GBP', 2)} ex VAT · {formatPrice(exPerCard, 'GBP', 2)} per card ex
        </p>
      )}
      {showPrice && interpolated && interpolationLowerQty != null && interpolationUpperQty != null && (
        <p className="mt-2 text-xs text-on-ink/70">
          Estimated for a non-standard quantity — between the{' '}
          {interpolationLowerQty.toLocaleString()} and {interpolationUpperQty.toLocaleString()} tiers.
        </p>
      )}
      {/* Stacked breakdown — base + each surcharge on its own
          line so the designer can read the maths aloud cleanly,
          even when finish + split-name both apply. The leading
          "£X base" line only renders when at least one surcharge
          is non-zero, so a vanilla quote stays single-line.
          An active internal discount also triggers the breakdown
          so the "−£Y discount" line has its "£X base" anchor. */}
      {showPrice && baseTotal != null && (
        ((splitNameSurcharge ?? 0) > 0 || (finishSurcharge ?? 0) > 0 || (personalisationSurcharge ?? 0) > 0 || (discountAmount ?? 0) > 0) && (
          <div className="mt-1 space-y-0.5 text-sm text-on-ink/75 tabular-nums">
            <p>{formatPrice(baseTotal, currency!)} base</p>
            {(finishSurcharge ?? 0) > 0 && (
              <p>+ {formatPrice(finishSurcharge!, currency!)} {finishLabel ?? 'finish'} surcharge</p>
            )}
            {(splitNameSurcharge ?? 0) > 0 && perExtraNameSurcharge != null && names > 1 && (
              <p>+ {names - 1} × {formatPrice(perExtraNameSurcharge, currency!)} split-name surcharge</p>
            )}
            {(personalisationSurcharge ?? 0) > 0 && (
              <p>+ {formatPrice(personalisationSurcharge!, currency!)} personalisation</p>
            )}
            {(discountAmount ?? 0) > 0 && (
              <p className="text-in-stock">
                − {formatPrice(discountAmount!, currency!)} discount ({formatDiscountPercent(discountPercent)})
              </p>
            )}
          </div>
        )
      )}
      {showPrice && (personalisationSurcharge ?? 0) > 0 && personalisationBreakevenQty != null && (
        <p className="mt-2 text-xs text-on-ink/55">
          A minimum personalisation charge applies below {personalisationBreakevenQty.toLocaleString()} cards.
        </p>
      )}
      {!showPrice && !loading && (
        <p className="mt-3 text-sm text-on-ink/55">
          Pick a material, variant, currency and quantity to see a price.
        </p>
      )}
      {loading && (
        <p className="mt-3 text-sm text-on-ink/55">Loading prices…</p>
      )}
      </div>
    </div>
  )
}
