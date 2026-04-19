// Heuristic singular → plural for material option labels driven by
// materials.option_label. Covers the current shape ("Finish" → "Finishes",
// "Species" → "Species"). Extend only if a new material needs something
// irregular.
export function pluralLabel(label: string): string {
  if (label.endsWith('s')) return label
  if (label.endsWith('sh') || label.endsWith('ch') || label.endsWith('x')) return label + 'es'
  return label + 's'
}
