// Quick-pick quantities for the checkout "How many cards?" step.
//
// Why this exists: the open-quantity pay page used to offer exactly ONE way to
// say how many cards you wanted — a narrow, right-aligned number box whose
// placeholder was the bare minimum ("25+"). Two customers in two days
// (2026-07-31) reported they could not order because of it. Kaz Daughtry's
// report is the precise one: "the field that says 25+ doesn't allow me to
// enter the quantity I want (250 cards)... the button that says 'Choose a
// quantity to continue' never becomes active".
//
// The field was not broken — verified in WebKit (the engine behind BOTH Safari
// and Chrome on an iPhone) at four device sizes and in his exact order of
// operations. The giveaway is that the button still read "Choose a quantity";
// one keystroke changes it, so not a single digit ever landed. He had already
// worked the country dropdown and the ZIP field on that same page, so his
// keyboard and his tapping were fine. The quantity box was the only control he
// could not use — because on a screen where thickness and finish are
// tap-to-choose cards, a grey right-aligned "25+" reads as a spec chip, not as
// somewhere to type. The one piece of text that tells you what to do ("Any
// quantity from 25 to 5,000.") is an inert <p>, not part of the label.
//
// So the fix is to let the customer TAP a quantity, like everything else on
// that screen. That also makes the fix robust to the residual uncertainty
// about Kaz's device: whatever stopped his digits landing, he no longer has to
// type at all. The free type-in stays for anything off-list.
//
// The chips are the material's own curated `display_quantities` — the same
// list the customer already saw on the proof page's price grid, so checkout
// agrees with the quote — clamped to what this order can actually be charged
// for. Real orders back the shape: 100/250/50/200/500 are the five most
// common quantities and cover ~80% of production orders in the last 180 days,
// and 250 (Kaz's) is the second most common of all.

import { DEFAULT_DISPLAY_QUANTITIES } from './constants'

/**
 * The tappable quantities to offer, in ascending order.
 *
 * `displayQuantities` is the material's curated list (null/empty → the shared
 * default set). `min`/`max` are the order's priceable bounds — the same ones
 * that gate the type-in — so a chip can never offer a quantity that would be
 * rejected at checkout. A null bound means unbounded on that side.
 *
 * Returns [] when nothing survives the clamp, which the caller treats as
 * "type-in only" rather than rendering an empty chip row.
 */
export function quickQuantities(
  displayQuantities: number[] | null | undefined,
  min: number | null,
  max: number | null,
): number[] {
  const base =
    displayQuantities != null && displayQuantities.length > 0
      ? displayQuantities
      : DEFAULT_DISPLAY_QUANTITIES

  const seen = new Set<number>()
  const out: number[] = []
  for (const q of base) {
    if (!Number.isFinite(q) || q <= 0) continue
    if (min != null && q < min) continue
    if (max != null && q > max) continue
    if (seen.has(q)) continue
    seen.add(q)
    out.push(q)
  }
  return out.sort((a, b) => a - b)
}
