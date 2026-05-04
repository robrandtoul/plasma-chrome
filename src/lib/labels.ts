// Heuristic singular to plural for material option labels driven by
// materials.option_label. Covers the current shape (Finish to Finishes,
// Species stays Species). Extend the irregulars map below if a new
// material needs something exotic.

const IRREGULAR: Record<string, string> = {
  species: 'species',
  series: 'series',
  // Sibilant-ending singulars whose plural needs -es (the -sh/-ch/-x
  // rule below catches the obvious ones; this map handles the
  // remainder — "class" → "classes", "glass" → "glasses").
  class: 'classes',
  glass: 'glasses',
  boss: 'bosses',
  process: 'processes',
}

export function pluralLabel(label: string): string {
  if (!label) return label
  const lower = label.toLowerCase()
  if (IRREGULAR[lower]) {
    // Preserve the caller's casing on the first letter so
    // "Species" stays "Species" rather than collapsing to lower.
    return label[0] + IRREGULAR[lower].slice(1)
  }
  if (lower.endsWith('sh') || lower.endsWith('ch') || lower.endsWith('x') || lower.endsWith('z')) {
    return label + 'es'
  }
  // Consonant + y → ies (City → Cities). Vowel + y → s (Day → Days).
  if (/[^aeiou]y$/i.test(label)) {
    return label.slice(0, -1) + 'ies'
  }
  if (lower.endsWith('s')) return label
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
