// Material behaviour traits that hang off the material code.
//
// finishIsPreferenceOnly: true when the material's option dimension is a
// pure production preference rather than an artwork-visible choice. Metal
// finishes (Natural / Brushed / Mirror) change what the artwork looks
// like, so a proof shows them as separate option tabs and the checkout
// only offers finishes the customer saw proofed. Full Colour Plastic's
// gloss / matte coating changes nothing about the artwork and nothing
// about the price — so:
//   * the version form treats the material as having NO option dimension
//     (proofs never grow gloss/matte tabs; images stay untabbed),
//   * the order builder can default the finish to "customer chooses at
//     checkout" from the catalogue alone (no 2-proofed-tabs requirement),
//   * the pay page offers every catalogue option, educated by
//     material_options.description (migration 000303) instead of per-tab
//     artwork.
// Hardcoded by code, matching the repo's conservative-helper pattern
// (matchMaterial, hasThicknessGuide) — promote to a materials flag if a
// second preference-only material ever appears.
export function finishIsPreferenceOnly(materialCode: string | null | undefined): boolean {
  return materialCode === 'plastic_full_colour'
}
