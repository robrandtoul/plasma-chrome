// Material-code allow-list for the letterpress layered-construction
// feature (migrations 000133 / 000135).
//
// A material in this set surfaces the three layer-colour pickers
// (front / core / back) on the designer Add and Edit forms, and the
// LayeredConstructionPanel on the customer page when all three are
// populated. Materials outside the set never write colour ids to
// proof_versions (the form-save paths null them defensively) and
// never render the construction band on the customer page.
//
// Today the set has a single entry. The gilded sibling
// (paper_letterpress_gilded, migration 000098) hides the layered
// edge behind the gilding so it gets none of this UI. Future
// materials that want the layer treatment can opt in by adding
// their code here — the form-save, customer-render, and admin paths
// all read through this constant.
export const LAYER_COLOUR_MATERIAL_CODES: ReadonlySet<string> = new Set([
  'paper_letterpress',
])
