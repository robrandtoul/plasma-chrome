// Per-material "public tier" lists — the round-number quantities the
// public pricing pages on plasmadesign.co.uk actually advertise. The
// quote compiler's AdjacentTiers strip uses these to surface
// neighbour cells that read meaningfully in a phone-call context
// ("you save £X going from 250 to 500") rather than the variant's
// raw 25-step neighbours ("you save 7p going from 250 to 275"),
// which were noise more than help.
//
// The lists are extracted from pricing-audit/{gbp,eur,usd}-snapshot
// .json — the CommonNinja widget snapshots taken during the
// 2026-04-26 site-vs-DB audit. Carbon fibre with CNC and gilded
// letterpress don't have their own widgets (both materials were
// split off from a parent in migration 000098); they inherit the
// parent material's list, which mirrors how Rob will eventually
// surface them on the public pricing pages.
//
// Lookups fall through to an empty array for unknown material codes
// — AdjacentTiers handles the empty case by suppressing the strip.

export const PUBLIC_TIERS_BY_MATERIAL: Record<string, readonly number[]> = {
  metal_steel:              [50, 100, 150, 200, 250, 500, 750, 1000],
  metal_mini_steel:         [50, 100, 150, 200, 250, 500, 750, 1000],
  metal_gold:               [50, 100, 150, 200, 250, 500, 750, 1000],
  metal_matte_black:        [50, 100, 150, 200, 250, 500, 750, 1000],
  metal_matte_white:        [50, 100, 150, 200, 250, 500, 750, 1000],
  metal_copper:             [50, 100, 150, 200, 250, 500, 750, 1000],
  metal_gun_metal:          [50, 100, 150, 200, 250, 500, 750, 1000],
  wood:                     [50, 75, 100, 125, 150, 175, 200, 250, 300, 400, 500, 750, 1000],
  acrylic:                  [50, 75, 100, 150, 200, 250, 500, 750, 1000],
  carbon_fibre:             [50, 100, 150, 200, 250, 500, 750, 1000],
  carbon_fibre_cnc:         [50, 100, 150, 200, 250, 500, 750, 1000],
  paper_letterpress:        [100, 250, 500, 750, 1000, 1500, 2000],
  paper_letterpress_gilded: [100, 250, 500, 750, 1000, 1500, 2000],
  plastic_translucent:      [100, 250, 500, 750, 1000, 1500, 2000, 3000, 5000],
  plastic_tinted:           [100, 250, 500, 750, 1000, 1500, 2000, 3000, 5000],
  plastic_satin:            [100, 250, 500, 750, 1000, 1500, 2000, 3000, 5000],
  plastic_full_colour:      [100, 250, 500, 750, 1000, 1500, 2000, 3000, 5000, 10000],
  paper_standard:           [250, 500, 1000, 2000, 3000, 5000, 10000],
} as const

/** Per-material public tier list, or an empty array for unknown
 *  material codes. AdjacentTiers suppresses itself on empty so
 *  unmapped materials degrade silently rather than crashing. */
export function getPublicTiers(materialCode: string): readonly number[] {
  return PUBLIC_TIERS_BY_MATERIAL[materialCode] ?? []
}
