import type { CustomQuoteFlagsState } from './CustomQuoteFlags'

// Bailout panel that replaces HeadlinePrice + adjacent strips +
// snap chips when a custom-quote trigger fires. Two triggers today:
//   - flags.nfc                       NFC chip selected
//   - aboveMax !== null               typed quantity exceeds the
//                                     largest priced tier for the
//                                     active (variant, currency)
//
// The first is user-driven (CustomQuoteFlags toggle). The second is
// derived in QuotePage from quantity + the loaded tiers map. The
// previous unique-content flag was retired by migration 000172 —
// the personalisation add-on now prices that case directly.
//
// Lists each active trigger in the "Why" block so the designer
// can read aloud what the customer asked for and why this needs a
// quote from Rob rather than a price off the live grid. The
// over-max reason carries material/variant context inline because
// the designer can't see the price area to confirm what they
// typed when the panel is up.
export interface AboveMaxDetail {
  typedQuantity: number
  maxQuantity: number
  // Material's display_name as-stored, proper case.
  materialName: string
  // Variant's display_name as-stored, lowercased before render.
  // Null for default-variant materials (Wood, Acrylic, base
  // Carbon Fibre, Carbon Fibre with CNC) — the parenthetical is
  // dropped in those cases.
  variantName: string | null
}

export function CustomQuotePanel({
  flags,
  aboveMax = null,
}: {
  flags: CustomQuoteFlagsState
  aboveMax?: AboveMaxDetail | null
}) {
  const reasons: string[] = []
  if (flags.nfc) reasons.push('NFC chips selected')
  if (aboveMax) {
    const variantSuffix = aboveMax.variantName
      ? ` (${aboveMax.variantName.toLowerCase()})`
      : ''
    reasons.push(
      `Quantity ${aboveMax.typedQuantity.toLocaleString()} exceeds the priced range for ${aboveMax.materialName}${variantSuffix}. Maximum priced tier is ${aboveMax.maxQuantity.toLocaleString()}.`,
    )
  }

  return (
    <div className="rounded-2xl border-2 border-low bg-low-soft p-8">
      <p className="text-xs font-semibold uppercase tracking-widest text-low">
        Custom quote required
      </p>
      <p className="mt-3 text-2xl font-bold leading-tight text-low">
        This needs a custom quote — flag for Rob
      </p>
      <p className="mt-3 text-sm text-low">
        Live pricing isn't available for this configuration. Send the spec
        to Rob with the customer's contact details and he'll come back
        with a quote.
      </p>
      <div className="mt-4 rounded-lg border border-low bg-surface/70 px-4 py-3">
        <p className="text-xs font-semibold uppercase tracking-widest text-low">
          Why
        </p>
        <ul className="mt-1.5 space-y-1 text-sm text-low">
          {reasons.map((r) => (
            <li key={r} className="flex items-start gap-2">
              <span aria-hidden className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-low" />
              <span>{r}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
