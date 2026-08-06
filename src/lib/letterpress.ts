// The letterpress layer colours (migrations 000133 / 000135), and the
// two DIFFERENT questions the codebase asks about them.
//
// A letterpress card is three bonded layers of Colorplan paper. The
// front/core/back trio is therefore not decoration — it names the
// physical stock. The direct Stock Control hand-off builds its whole
// material line from it (`create_order_handoff` emits
// `{front, core, back, quantity}` instead of a material_id, and
// `_resolve_letterpress_combo` turns that into the tracked material
// the job allocates against). No trio, no paper.
//
// Hence two gates, deliberately separate:
//
//   LAYER_COLOUR_MATERIAL_CODES  — which materials CAPTURE the trio.
//     Drives the three pickers on the designer Add/Edit forms and the
//     defensive nulling on their save paths. Both letterpress codes,
//     because both are made of layered Colorplan.
//
//   showsLayeredConstruction()   — which materials SHOW the customer
//     the layered cross-section (LayeredConstructionPanel). Un-gilded
//     only: gilding covers the edge, so the customer would be shown a
//     detail their card doesn't have.
//
// ⚠ Do not collapse these back into one set. They were one set until
// 2026-08-06, and the single value had to be wrong for one of the two
// jobs: it was set to un-gilded (right for the customer page), which
// left a gilded version's colour ids null, so a gilded in-house order
// hit `letterpress_colours_missing` at Confirm with no way to fix it
// from the app — the version modal locks editing once a proof is
// approved. Live case: order 403976 (Ayla Advisory) needed a direct
// database update. The customer-page behaviour is unchanged by the
// split; only the form gate moved.
//
// Note the panel gate is belt-and-braces rather than the sole guard:
// the panel also requires all three colour NAMES to be present, which
// is what used to keep gilded versions out of it by accident. Now that
// gilded versions carry real colours, that accident no longer holds
// and the material code has to say so explicitly.
export const LAYER_COLOUR_MATERIAL_CODES: ReadonlySet<string> = new Set([
  'paper_letterpress',
  'paper_letterpress_gilded',
])

// Materials whose customer page renders the layered cross-section.
// A subset of LAYER_COLOUR_MATERIAL_CODES — a material can only show
// construction it captured, but capturing it doesn't mean showing it.
const LAYERED_CONSTRUCTION_MATERIAL_CODES: ReadonlySet<string> = new Set([
  'paper_letterpress',
])

/**
 * Should the customer see the layered-construction cross-section for
 * this material? Un-gilded letterpress only — the gilded sibling
 * captures the same colours for production but hides the edge behind
 * the gilding, so showing the panel would describe a card the
 * customer isn't getting.
 *
 * Null-safe: a per-direction-pricing version stores no material at
 * all (000142 / 000144), so `material_code` is legitimately null.
 */
export function showsLayeredConstruction(materialCode: string | null | undefined): boolean {
  return !!materialCode && LAYERED_CONSTRUCTION_MATERIAL_CODES.has(materialCode)
}
