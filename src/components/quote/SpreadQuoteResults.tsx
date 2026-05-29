import { useMemo, useState } from 'react'
import { formatPrice } from '../../lib/currency'
import type { Currency } from '../../lib/types'
import {
  spreadCalculate,
  type SpreadRow,
} from '../../lib/quote/spreadCalculate'
import type { PriceTier } from '../../lib/quote/calculate'
import { formatSpreadQuoteForCopy } from '../../lib/quote/formatSpreadQuoteForCopy'
import type { LeadTimeState } from '../../lib/quote/leadTime'
import { CopyQuoteButton } from './CopyQuoteButton'

// Multi-quantity spread quote results — stacked list + quantity-
// independent items + custom-quote flags + copy export.
//
// Shape:
//   ┌────────────────────────────────────────────────────┐
//   │ Header (currency + N of M priced)                  │
//   │ {N} cards                            £{total}      │
//   │                                  £{unit} per card  │ ← when toggle on
//   │ ──────────────────────────────────────────────     │
//   │ {N} cards                          Not priced      │ ← invalid row
//   │ Nearest tiers …  [Swap to X]  [Swap to Y]          │
//   │ ──────────────────────────────────────────────     │
//   │ …                                                  │
//   └────────────────────────────────────────────────────┘
//   ┌────────────────────────────────────────────────────┐
//   │ Split-name tooling — Totals already include …      │
//   └────────────────────────────────────────────────────┘
//   ┌────────────────────────────────────────────────────┐
//   │ Custom-quote flags (only if any)                   │
//   └────────────────────────────────────────────────────┘
//   [ ☐ Include unit price ]   [ Copy quote ]
//
// "Saving vs previous" used to live on this view as an internal
// nudge, but Rob asked for it gone — totals are the headline
// number now, and the saving fraction wasn't pulling enough
// weight to justify the column. It's also already absent from
// the customer-facing copy.
//
// "Include unit price" is a session-only toggle, default OFF.
// When ON, a small per-card subline appears under each total in
// the on-screen list AND the unit-price column appears in the
// clipboard payload.
//
// Invalid quantities (typed values that aren't a tier in the
// active variant's price grid) used to be filtered out of the
// table and only surfaced by SpreadQuantityInput's chip
// warnings. They now also render in the stacked list with a
// muted "Not priced" affordance and inline swap buttons that
// replace the matching chip in the parent's quantity array.
export function SpreadQuoteResults({
  quantities,
  onChangeQuantities,
  variantTiers,
  finishSurchargesByQty,
  currency,
  materialDisplayName,
  variantDisplayName,
  finishOption,
  splitNameSurcharge,
  names,
  perExtraNameSurcharge,
  personalisationAt,
  personalisationActive,
  personalisationBreakevenQty,
  customFlags,
  discountPercent,
  includeLeadTime,
  onIncludeLeadTimeChange,
  leadTimeState,
  loading,
}: {
  quantities: number[]
  // Mutator for the parent's quantity list. Used by the inline
  // swap buttons on invalid rows: clicking [Swap to 50] replaces
  // the first occurrence of the invalid quantity with 50; the
  // remove (×) button drops it.
  onChangeQuantities: (next: number[]) => void
  variantTiers: readonly PriceTier[]
  // Active option's surcharge schedule (from
  // PricingData.surchargesByOptionId). Null = no surcharge
  // schedule for the active option (base options, wood species,
  // etc.) → every row's finish surcharge is 0.
  finishSurchargesByQty: Record<number, number> | null
  currency: Currency | null
  materialDisplayName: string | null
  variantDisplayName: string | null
  finishOption: { displayName: string; isBase: boolean } | null
  splitNameSurcharge: number
  names: number
  perExtraNameSurcharge: number | null
  // Migration 000172. Per-qty personalisation resolver from the
  // parent (closed-form formula). Returns 0 when personalisation
  // is off — the SpreadList only renders the dedicated column
  // when personalisationActive is true.
  personalisationAt: (qty: number) => number
  personalisationActive: boolean
  personalisationBreakevenQty: number | null
  customFlags: { nfc: boolean }
  // Internal discount percentage (0–100). Threaded into
  // spreadCalculate so every row's Total cell is the post-discount
  // figure, and into the copy formatter so the clipboard payload
  // matches the on-screen table. A non-zero value also renders a
  // disclosure footer below the table so the customer can see
  // where the lower number came from.
  discountPercent: number
  // Lead-time toggle state (migration 000175). Mirrors the
  // single-quantity Copy block in QuotePage: the toggle gates a
  // lead-time line in the copied body; the on-screen LeadTimeCard
  // (rendered by the parent above this card) is independent.
  // Toggle UI only renders when leadTimeState.kind === 'standard',
  // matching single-mode gating.
  includeLeadTime: boolean
  onIncludeLeadTimeChange: (next: boolean) => void
  leadTimeState: LeadTimeState | null
  loading: boolean
}) {
  // Component-local state, no persistence — the brief specifies
  // session-only behaviour. Default off so the simplest copy is
  // Quantity + Total.
  const [includeUnitPrice, setIncludeUnitPrice] = useState(false)

  const result = useMemo(
    () => spreadCalculate(quantities, variantTiers, finishSurchargesByQty, currency, splitNameSurcharge, personalisationAt, discountPercent),
    [quantities, variantTiers, finishSurchargesByQty, currency, splitNameSurcharge, personalisationAt, discountPercent],
  )

  const validRows = useMemo(
    () => result.rows.filter((r) => r.isValidBase && r.isValidFinish && r.total != null),
    [result.rows],
  )
  // Rows where the typed quantity isn't an exact tier in the
  // variant's price grid. Surfaced inline in the stacked list as
  // "Not priced" with swap suggestions below.
  const invalidBaseRows = useMemo(
    () => result.rows.filter((r) => !r.isValidBase),
    [result.rows],
  )
  // Rows where the base tier exists but the finish surcharge has
  // no row at this quantity. Defensive — today's seeded data
  // keeps these aligned, so this normally renders empty.
  const invalidFinishRows = useMemo(
    () => result.rows.filter((r) => r.isValidBase && !r.isValidFinish),
    [result.rows],
  )

  // Swap helpers: find-first-match by value, mirroring the
  // SpreadQuantityInput chip-level swap. The list rows are sorted
  // ascending by quantity, but the source array preserves entry
  // order — we replace the first occurrence so a typo of "75"
  // immediately becomes "50" rather than collapsing duplicates.
  function swapQuantity(oldQty: number, newQty: number) {
    const idx = quantities.indexOf(oldQty)
    if (idx === -1) return
    const next = [...quantities]
    next[idx] = newQty
    onChangeQuantities(next)
  }
  function removeQuantity(oldQty: number) {
    const idx = quantities.indexOf(oldQty)
    if (idx === -1) return
    onChangeQuantities(quantities.filter((_, i) => i !== idx))
  }

  if (loading) {
    return (
      <div className="rounded-2xl bg-surface p-8 shadow-sm ring-1 ring-line">
        <p className="text-sm text-ink-dim">Loading prices…</p>
      </div>
    )
  }

  if (!currency || !materialDisplayName) {
    return (
      <div className="rounded-2xl bg-surface p-8 shadow-sm ring-1 ring-line">
        <p className="text-xs font-semibold uppercase tracking-widest text-ink-dim">
          Spread quote
        </p>
        <p className="mt-3 text-sm text-ink-dim">
          Pick a material, variant, currency, and at least one quantity to see a spread quote.
        </p>
      </div>
    )
  }

  if (quantities.length === 0) {
    return (
      <div className="rounded-2xl bg-surface p-8 shadow-sm ring-1 ring-line">
        <p className="text-xs font-semibold uppercase tracking-widest text-ink-dim">
          Spread quote · {currency}
        </p>
        <p className="mt-3 text-sm text-ink-dim">
          Add quantities above to build the price grid.
        </p>
      </div>
    )
  }

  const showSplitNameRow =
    splitNameSurcharge > 0 && perExtraNameSurcharge != null && names > 1
  const showFlags = customFlags.nfc
  const isGbp = currency === 'GBP'
  const showDiscountRow = discountPercent > 0
  const discountLabel = formatSpreadDiscountPercent(discountPercent)

  // Format the formatted-copy payload once. Cheap.
  const formatted =
    validRows.length > 0
      ? formatSpreadQuoteForCopy({
          rows: validRows,
          currency,
          materialDisplayName,
          variantDisplayName,
          finishOption,
          splitNameSurcharge,
          names,
          perExtraNameSurcharge,
          customFlags,
          personalisationActive,
          personalisationBreakevenQty,
          discountPercent,
          includeUnitPrice,
          includeLeadTime,
          leadTimeState,
        })
      : null

  return (
    <div className="space-y-4">
      <div className="rounded-2xl bg-surface p-6 shadow-sm ring-1 ring-line">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-xs font-semibold uppercase tracking-widest text-ink-dim">
            Spread quote · {currency}
            {isGbp && <span className="ml-1.5 normal-case tracking-normal text-ink-dim">(inc VAT)</span>}
          </p>
          <p className="text-xs text-ink-dim">
            {validRows.length} of {quantities.length} priced
          </p>
        </div>

        {validRows.length === 0 && invalidBaseRows.length === 0 ? (
          <p className="mt-4 text-sm text-ink-mute">
            Add quantities above to build the price grid.
          </p>
        ) : (
          <SpreadList
            validRows={validRows}
            invalidBaseRows={invalidBaseRows}
            currency={currency}
            includeUnitPrice={includeUnitPrice}
            personalisationActive={personalisationActive}
            onSwap={swapQuantity}
            onRemove={removeQuantity}
          />
        )}

        {personalisationActive && personalisationBreakevenQty != null && validRows.length > 0 && (
          <p className="mt-3 text-xs text-ink-dim">
            Totals already include personalisation. A minimum personalisation charge applies below {personalisationBreakevenQty.toLocaleString()} cards.
          </p>
        )}

        {invalidFinishRows.length > 0 && (
          <ul className="mt-4 space-y-1.5 rounded-lg border border-low bg-low-soft px-3 py-2 text-xs text-low">
            {invalidFinishRows.map((r) => (
              <li key={`fin-${r.quantity}`}>
                <span className="font-semibold tabular-nums">{r.quantity.toLocaleString()}</span>:
                {' '}finish surcharge isn't priced at this quantity.{' '}
                {r.finishLower != null && (
                  <>
                    Nearest tier below: <span className="font-medium">{r.finishLower.toLocaleString()}</span>.{' '}
                  </>
                )}
                {r.finishUpper != null && (
                  <>
                    Nearest tier above: <span className="font-medium">{r.finishUpper.toLocaleString()}</span>.
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {showSplitNameRow && (
        <div className="rounded-2xl bg-surface p-5 shadow-sm ring-1 ring-line">
          <p className="text-xs font-semibold uppercase tracking-widest text-ink-dim">
            Split-name tooling
          </p>
          <p className="mt-2 text-base font-medium text-ink tabular-nums">
            Totals already include {formatPrice(splitNameSurcharge, currency)} charge to split batch between {names} names
          </p>
          <p className="mt-2 text-xs text-ink-mute">
            This covers the extra tooling and machine set up incurred.
          </p>
        </div>
      )}

      {showDiscountRow && validRows.length > 0 && (
        <div className="rounded-2xl bg-surface p-5 shadow-sm ring-1 ring-line">
          <p className="text-xs font-semibold uppercase tracking-widest text-ink-dim">
            Discount
          </p>
          <p className="mt-2 text-base font-medium text-in-stock tabular-nums">
            Totals above include a {discountLabel} discount.
          </p>
        </div>
      )}

      {showFlags && (
        <div className="rounded-2xl border border-low bg-low-soft p-5">
          <p className="text-xs font-semibold uppercase tracking-widest text-low">
            Needs a custom quote
          </p>
          <ul className="mt-2 space-y-1 text-sm text-low">
            {customFlags.nfc && (
              <li className="flex items-start gap-2">
                <span aria-hidden className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-low" />
                <span>NFC chips selected — prices above are without NFC.</span>
              </li>
            )}
          </ul>
        </div>
      )}

      {formatted && (
        <div className="flex flex-wrap items-center gap-3">
          <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-ink-soft">
            <input
              type="checkbox"
              checked={includeUnitPrice}
              onChange={(e) => setIncludeUnitPrice(e.target.checked)}
              className="h-4 w-4 rounded border-line text-brand focus:ring-brand"
            />
            <span>Include unit price</span>
          </label>
          {leadTimeState?.kind === 'standard' && (
            <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-ink-soft">
              <input
                type="checkbox"
                checked={includeLeadTime}
                onChange={(e) => onIncludeLeadTimeChange(e.target.checked)}
                className="h-4 w-4 rounded border-line text-brand focus:ring-brand"
              />
              <span>Include lead time</span>
            </label>
          )}
          <CopyQuoteButton plainText={formatted.plainText} html={formatted.html} />
        </div>
      )}
    </div>
  )
}

// Trim trailing zeros on the discount % so "10" reads as "10%"
// not "10.00%". Same shape as the helper in HeadlinePrice; kept
// local so the two files don't have a runtime dependency on each
// other.
function formatSpreadDiscountPercent(value: number): string {
  const rounded = Math.round(value * 100) / 100
  return `${rounded}%`
}

// Stacked list — one row per quantity, total as the visual
// headline on the right. Replaces the previous table; saving-vs-
// previous column is gone entirely. Invalid rows (typed
// quantities that aren't a tier) appear inline with a muted
// "Not priced" affordance and the existing swap suggestion
// below them.
//
// Sort: valid rows + invalid rows are merged and sorted ascending
// by quantity so the eye reads the run consistently regardless
// of validity.
function SpreadList({
  validRows,
  invalidBaseRows,
  currency,
  includeUnitPrice,
  personalisationActive,
  onSwap,
  onRemove,
}: {
  validRows: readonly SpreadRow[]
  invalidBaseRows: readonly SpreadRow[]
  currency: Currency
  includeUnitPrice: boolean
  personalisationActive: boolean
  onSwap: (oldQty: number, newQty: number) => void
  onRemove: (oldQty: number) => void
}) {
  const merged = useMemo(() => {
    const all = [
      ...validRows.map((r) => ({ row: r, kind: 'valid' as const })),
      ...invalidBaseRows.map((r) => ({ row: r, kind: 'invalid' as const })),
    ]
    all.sort((a, b) => a.row.quantity - b.row.quantity)
    return all
  }, [validRows, invalidBaseRows])

  return (
    <ul className="mt-4 divide-y divide-line-soft" role="list">
      {/* Header row appears only when the personalisation column
          is showing — otherwise the existing two-cell layout reads
          fine on its own. */}
      {personalisationActive && merged.length > 0 && (
        <li className="flex items-baseline justify-between gap-4 pb-2 pt-1">
          <p className="text-xs font-semibold uppercase tracking-widest text-ink-dim" />
          <div className="flex items-baseline gap-8 text-right">
            <p className="w-24 text-xs font-semibold uppercase tracking-widest text-ink-dim">
              Personalisation
            </p>
            <p className="w-28 text-xs font-semibold uppercase tracking-widest text-ink-dim">
              Total
            </p>
          </div>
        </li>
      )}
      {merged.map(({ row: r, kind }, i) => (
        <li key={`row-${r.quantity}-${i}`}>
          <div className="flex items-baseline justify-between gap-4 py-[18px]">
            <p className="tabular-nums">
              <span className="text-[22px] font-medium text-ink">
                {r.quantity.toLocaleString()}
              </span>
              <span className="ml-1.5 text-[16px] font-medium text-ink-mute">cards</span>
            </p>
            <div className="flex items-baseline gap-8 text-right">
              {/* Personalisation column — only renders when the
                  parent flagged personalisation active. The
                  closed-form formula always has a value (zero is a
                  valid result), but we only ever show this column
                  when the toggle is on so a vanilla spread quote
                  reads as before. */}
              {personalisationActive && (
                <div className="w-24 text-right">
                  {kind === 'valid' ? (
                    <p className="text-[18px] font-medium leading-none tabular-nums text-ink-soft">
                      {formatPrice(r.personalisationSurcharge, currency)}
                    </p>
                  ) : (
                    <p className="text-[16px] tabular-nums text-ink-dim">—</p>
                  )}
                </div>
              )}
              <div className={personalisationActive ? 'w-28 text-right' : 'text-right'}>
                {kind === 'valid' && r.total != null ? (
                  <>
                    <p className="text-[32px] font-medium leading-none tabular-nums text-ink">
                      {formatPrice(r.total, currency)}
                    </p>
                    {includeUnitPrice && r.unitPrice != null && (
                      <p className="mt-1.5 text-[13px] tabular-nums text-ink-mute">
                        {formatPrice(r.unitPrice, currency, 2)} per card
                      </p>
                    )}
                  </>
                ) : (
                  <p className="text-[16px] font-medium tabular-nums text-ink-dim">
                    Not priced
                  </p>
                )}
              </div>
            </div>
          </div>
          {/* Inline swap affordance for invalid-base rows. Same
              shape as the chip-level warning in
              SpreadQuantityInput; clicking either path lands on
              the same parent state. */}
          {kind === 'invalid' && (
            <div className="pb-[18px]">
              <p className="text-xs text-low">
                {r.baseLower != null && r.baseUpper != null
                  ? `Nearest tiers are ${r.baseLower.toLocaleString()} and ${r.baseUpper.toLocaleString()}.`
                  : r.baseLower != null
                    ? `Nearest tier below is ${r.baseLower.toLocaleString()}.`
                    : r.baseUpper != null
                      ? `Nearest tier above is ${r.baseUpper.toLocaleString()}.`
                      : 'No tiers in range.'}
              </p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {r.baseLower != null && (
                  <button
                    type="button"
                    onClick={() => onSwap(r.quantity, r.baseLower!)}
                    className="rounded border border-low bg-surface px-2 py-1 text-xs font-medium text-low hover:bg-low-soft"
                  >
                    Swap to {r.baseLower.toLocaleString()}
                  </button>
                )}
                {r.baseUpper != null && (
                  <button
                    type="button"
                    onClick={() => onSwap(r.quantity, r.baseUpper!)}
                    className="rounded border border-low bg-surface px-2 py-1 text-xs font-medium text-low hover:bg-low-soft"
                  >
                    Swap to {r.baseUpper.toLocaleString()}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onRemove(r.quantity)}
                  className="rounded border border-low bg-surface px-2 py-1 text-xs font-medium text-low hover:bg-low-soft"
                >
                  Remove
                </button>
              </div>
            </div>
          )}
        </li>
      ))}
    </ul>
  )
}
