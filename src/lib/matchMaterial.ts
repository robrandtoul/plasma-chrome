// Match a free-text variant-round direction label (e.g. "900gsm Letterpress
// with a textured surface.") to a catalogue material.
//
// Why this exists: a proof that offers the customer a choice between materials
// is stored as a per-direction-pricing variant round whose directions are just
// free-text labels — proof_versions.material_id is NULL (migrations 000142 /
// 000144). When the designer continues one direction as the next version, the
// new version needs a real material to be priced. This maps the chosen
// direction's label back to a catalogue material so it can be pre-filled.
//
// Conservative by design: it returns null whenever the label is ambiguous
// (e.g. "Copper Steel" names two metals) or matches nothing confidently. A
// wrong guess would silently mis-price the proof; a null just asks the
// designer to pick. So the rule is "exactly one candidate material, or null".

export interface MaterialLike {
  id: string
  code: string
  display_name: string
}

// Split a label into lowercase word tokens. Digits and punctuation become
// spaces, so "900gsm Letterpress, textured." -> ["gsm","letterpress","textured"]
// and "Wood (Bamboo)" -> ["wood","bamboo"]. Stray tokens like "gsm" are
// harmless — no material rule matches on them.
export function tokeniseLabel(label: string): Set<string> {
  return new Set(
    label
      .toLowerCase()
      .replace(/[^a-z]+/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean),
  )
}

// A per-material match rule, keyed by material code.
// - `all`: every group must contribute at least one token (AND of ORs). This
//   is how a material declares its distinguishing word(s).
// - `none`: any of these tokens disqualifies the material — used to keep a
//   base material and its richer sibling apart (e.g. Letterpress vs Letterpress
//   with Gilding, Carbon Fibre vs Carbon Fibre with CNC, Translucent vs Tinted).
//
// Codes with no rule here are never auto-suggested (a new material stays safe
// until someone adds a rule), which keeps the matcher conservative as the
// catalogue grows.
interface MatchRule {
  all: string[][]
  none?: string[]
}

const RULES: Record<string, MatchRule> = {
  acrylic:                  { all: [['acrylic', 'perspex']] },
  carbon_fibre:             { all: [['carbon']], none: ['cnc'] },
  carbon_fibre_cnc:         { all: [['carbon'], ['cnc']] },
  metal_copper:             { all: [['copper']] },
  metal_gold:               { all: [['gold']] },
  metal_gun_metal:          { all: [['gun']] },
  metal_matte_black:        { all: [['matte', 'matt'], ['black']] },
  metal_matte_white:        { all: [['matte', 'matt'], ['white']] },
  metal_mini_steel:         { all: [['mini']] },
  // Steel is disqualified only by `mini` (that's Mini Stainless Steel). A
  // label with a second metal noun — "Copper Steel" / "Gold Steel" — leaves
  // BOTH that metal and steel as candidates, so the two-candidate rule below
  // resolves it to null rather than guessing. (Don't list copper/gold here:
  // that would disqualify steel and let the other metal win outright.)
  metal_steel:              { all: [['steel']], none: ['mini'] },
  metal_titanium:           { all: [['titanium']] },
  paper_letterpress:        { all: [['letterpress']], none: ['gilded', 'gilding', 'gild'] },
  paper_letterpress_gilded: { all: [['letterpress'], ['gilded', 'gilding', 'gild']] },
  paper_standard:           { all: [['standard']] },
  plastic_full_colour:      { all: [['full']] },
  plastic_satin:            { all: [['satin']] },
  plastic_tinted:           { all: [['tinted']] },
  plastic_translucent:      { all: [['translucent']], none: ['tinted'] },
  wood:                     { all: [['wood', 'bamboo', 'walnut', 'birch', 'maple', 'cherry', 'oak']] },
}

function ruleMatches(rule: MatchRule, tokens: Set<string>): boolean {
  if (rule.none && rule.none.some((t) => tokens.has(t))) return false
  return rule.all.every((group) => group.some((t) => tokens.has(t)))
}

// Return the single catalogue material the label confidently names, or null
// when zero or more than one material qualifies. Only materials present in
// `materials` can be returned, so an unpublished material (not offered in the
// picker) is never suggested even if its name appears in the label.
export function matchMaterialByLabel(
  label: string,
  materials: readonly MaterialLike[],
): MaterialLike | null {
  const tokens = tokeniseLabel(label)
  if (tokens.size === 0) return null

  const candidates = materials.filter((m) => {
    const rule = RULES[m.code]
    return rule ? ruleMatches(rule, tokens) : false
  })

  // De-dupe by id so a duplicate row can't masquerade as ambiguity.
  const unique = new Map(candidates.map((m) => [m.id, m]))
  return unique.size === 1 ? [...unique.values()][0] : null
}
