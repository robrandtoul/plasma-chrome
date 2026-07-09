// Pure tier maths + chooser shapes for the open-spec checkout choosers,
// shared by the single-order pay page (OrderPayPage) and the group pay page
// (OrderGroupPayPage — bundle orders Slice 2's in-bundle choosers). Extracted
// verbatim from OrderPayPage when the group page became the second caller,
// per the house "second caller appears → extract then" rule.
//
// Mirrors the server's cardTotalForQuantity (supabase/functions/_shared/
// orderPricing.ts): exact tier, else interpolated between the bracketing
// tiers; flat at the top per-card rate above the top tier for metal-style
// materials. The client figure is display-only — the server recomputes at
// checkout — but the two must agree so the shown price equals the charge.

import { interpolateValue, flatTopTierTotal, flatUnitTotal } from './quote/interpolation'
import type { ThicknessOption } from './metalThicknessNotes'

export function totalFromTiers(
  tiers: { quantity: number; total_price: number }[],
  qty: number,
  flatAboveTop: boolean,
): number | null {
  if (tiers.length === 0 || qty <= 0) return null
  const exact = tiers.find((t) => t.quantity === qty)
  if (exact) return exact.total_price
  let lower: { quantity: number; total_price: number } | null = null
  let upper: { quantity: number; total_price: number } | null = null
  for (const t of tiers) {
    if (t.quantity < qty) lower = t
    else if (t.quantity > qty) { upper = t; break }
  }
  if (lower && upper) {
    return interpolateValue(lower.quantity, lower.total_price, upper.quantity, upper.total_price, qty)
  }
  if (flatAboveTop) return flatTopTierTotal(tiers, qty)
  return null
}

// Same shape over a finish-surcharge schedule; out of range → 0 (matching the
// server's treatment of an unpriceable surcharge).
export function surchargeFromTiers(
  surTiers: { quantity: number; surcharge: number }[],
  qty: number,
  flatAboveTop: boolean,
): number {
  if (surTiers.length === 0 || qty <= 0) return 0
  const exact = surTiers.find((t) => t.quantity === qty)
  if (exact) return exact.surcharge
  let lower: { quantity: number; surcharge: number } | null = null
  let upper: { quantity: number; surcharge: number } | null = null
  for (const t of surTiers) {
    if (t.quantity < qty) lower = t
    else if (t.quantity > qty) { upper = t; break }
  }
  if (lower && upper) {
    return interpolateValue(lower.quantity, lower.surcharge, upper.quantity, upper.surcharge, qty)
  }
  if (flatAboveTop) {
    const top = surTiers[surTiers.length - 1]
    if (top && qty > top.quantity) return flatUnitTotal(top.quantity, top.surcharge, qty)
  }
  return 0
}

// Match an open-spec variant ("300 micron" / "300µm") to its admin-editable
// thickness note row ("300µm — Slim, …") by the leading number. Null when the
// material has no notes (non-metal open-spec) — the card renders name-only.
export function thicknessNoteFor(notes: ThicknessOption[], variantName: string): ThicknessOption | null {
  const n = parseInt(variantName, 10)
  if (!Number.isFinite(n)) return null
  return notes.find((o) => parseInt(o.label, 10) === n) ?? null
}

// Chooser card shapes (open-spec orders), shared by both pay pages.
export interface SpecVariantChoice {
  id: string
  display_name: string
  tiers: { quantity: number; total_price: number }[]
}
export interface SpecFinishChoice {
  id: string
  code: string
  display_name: string
  is_base: boolean
  surTiers: { quantity: number; surcharge: number }[]
  // Visual, in preference order: the admin's studio photo of the finish
  // (material_options.photo_url, 000299), else the customer's own artwork
  // from that finish's proof tab, else a text-only card.
  photoUrl: string | null
  swatchUrl: string | null
  // Education line under the name (000303) — how preference-only finishes
  // (gloss/matte) explain themselves when no photo can tell the story.
  description: string | null
}
