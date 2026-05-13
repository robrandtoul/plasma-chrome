// Shared types for the quote compiler. Kept in src/lib/quote/ so
// future v2 work (persistence, URL params, "convert to proof") can
// reach for the same primitives without untangling page-local types.

export type MaterialCategory =
  | 'metal'
  | 'plastic'
  | 'paper'
  | 'carbon_fibre'
  | 'wood'
  | 'acrylic'

export type VariantType = 'thickness' | 'ink_count' | 'finish' | 'default'

export interface QuoteMaterial {
  id: string
  code: string
  display_name: string
  category: MaterialCategory
  variant_type: VariantType
  // Per-currency split-name tooling surcharges, applied per extra
  // name beyond the first. Null means "not configured for this
  // currency" — used by the split-name surcharge line in commit 5.
  split_name_surcharge_gbp: number | null
  split_name_surcharge_eur: number | null
  split_name_surcharge_usd: number | null
  // Singular section heading for the FinishToggle when the
  // material has option surcharges, e.g. "Finish" for Steel/Gold.
  // Null when the material has no option dimension at all (most
  // metals, paper, plastic, carbon fibre); the FinishToggle's
  // hide rule keeps it out of view in those cases.
  option_label: string | null
  // Migration 000172. Admin-toggled gate for the membership-card
  // personalisation add-on. The compiler shows the personalisation
  // checkbox (and hides the unique-names input) only on materials
  // where this is true.
  supports_personalisation: boolean
  // Migration 000175. Current production lead-time window in
  // business days. Both null when the admin hasn't recorded a
  // value; both populated otherwise. The Quote compiler renders
  // a panel beside the quantity input from these.
  lead_time_min_days: number | null
  lead_time_max_days: number | null
}

export interface QuoteVariant {
  id: string
  code: string
  display_name: string
  variant_type: VariantType
  sort_order: number
}

// One row from material_options. The compiler uses these for the
// optional finish toggle on Steel/Gold; the canonical schema also
// uses them for wood species and other spec dimensions, but those
// have no surcharge rows attached so the FinishToggle hide-rule
// keeps them invisible. See migrations 000020 / 000025.
export interface QuoteMaterialOption {
  id: string
  code: string
  display_name: string
  is_base: boolean
  sort_order: number
}

// Human-readable label for the family-grouped picker. Matches the
// public-site copy on plasmadesign.co.uk.
export const CATEGORY_LABEL: Record<MaterialCategory, string> = {
  metal: 'Metal',
  plastic: 'Plastic',
  paper: 'Paper',
  carbon_fibre: 'Carbon fibre',
  wood: 'Wood',
  acrylic: 'Acrylic',
}

// Sort order of the family rails on the picker. Mirrors the
// materials.sort_order banding already in the DB so the picker
// reads top-to-bottom in the same order the dashboard's pricing
// admin does.
export const CATEGORY_ORDER: MaterialCategory[] = [
  'metal',
  'paper',
  'plastic',
  'carbon_fibre',
  'wood',
  'acrylic',
]

// Human-readable label for the variant section heading. Default-
// variant materials (carbon fibre, wood, acrylic) suppress the
// section entirely; the label is only used for the other three.
export function variantSectionLabel(t: VariantType): string {
  switch (t) {
    case 'thickness': return 'Thickness'
    case 'ink_count': return 'Ink count'
    case 'finish':    return 'Finish'
    default:          return 'Variant'
  }
}
