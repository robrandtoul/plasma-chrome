// Heuristic singular to plural for material option labels driven by
// materials.option_label. Covers the current shape (Finish to Finishes,
// Species stays Species). Extend only if a new material needs something
// irregular.
export function pluralLabel(label: string): string {
  if (label.endsWith('s')) return label
  if (label.endsWith('sh') || label.endsWith('ch') || label.endsWith('x')) return label + 'es'
  return label + 's'
}

// Human-readable label for a material_variants.variant_type value. Used
// on the Add and Edit version forms to label the variant-picker section.
// Falls back to a generic "Variant" for any unrecognised value so a
// forgotten new enum entry still renders legibly.
export function variantLabel(variantType?: string): string {
  switch (variantType) {
    case 'thickness': return 'Thickness'
    case 'ink_count': return 'Ink count'
    case 'finish':    return 'Finish'
    default:          return 'Variant'
  }
}
