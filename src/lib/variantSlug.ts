// Slug derivation for proof_round_variants.code (migration 000138).
//
// The DB enforces UNIQUE(proof_version_id, code). Codes are derived
// from display_name on first save; rename does not change the code
// (write-once by application convention) so proof_events.round_variant_id
// FK references stay stable across designer renames.
//
// slugify lower-cases, swaps any run of non-alphanumeric characters
// for a single hyphen, trims leading/trailing hyphens, and caps at 64
// chars. Empty / pure-symbol inputs return the literal 'variant' so
// the unique-suffix walk in deriveCodes can still produce stable
// values like 'variant', 'variant-2', 'variant-3'.
//
// deriveCodes walks an array of variant rows and assigns a unique
// code per row within the version. Collisions from two rows that
// slug to the same base (e.g. "Direction 1" + "Direction 1!") get a
// `-2`, `-3`, … suffix. The form's UI auto-suffixes via this helper
// so the designer never sees the raw 23505 unique-violation error.

export function slugify(name: string): string {
  const normalized = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return normalized.length > 0 ? normalized : 'variant'
}

export function deriveCodes(
  rows: ReadonlyArray<{ display_name: string }>,
): string[] {
  const seen = new Map<string, number>()
  return rows.map((row) => {
    const base = slugify(row.display_name)
    const count = (seen.get(base) ?? 0) + 1
    seen.set(base, count)
    return count === 1 ? base : `${base}-${count}`
  })
}
