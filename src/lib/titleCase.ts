// Light-touch title case for names + company names auto-populated
// from Help Scout. Help Scout customer data is inconsistently cased
// (ALL CAPS shouty companies, lowercase emails-turned-names) so the
// paste flow cleans it up before the designer sees the preview.
//
// Rules:
//   * Every whitespace-separated word gets its first letter upper
//     and the rest lower.
//   * Common connectors stay lowercase wherever they appear (even at
//     the start of the string, per Rob's "de souza → de Souza"
//     target behaviour).
//   * Apostrophes and hyphens are word boundaries: "o'brien" →
//     "O'Brien", "jean-luc" → "Jean-Luc".
//   * Doesn't try to handle "McDonald" / "MacLeod" specially; title
//     case produces "Mcdonald" / "Macleod" which the designer can
//     fix on the review step.
//
// Only ever called on values freshly arrived from Help Scout. Never
// re-applied to designer-typed input.

const CONNECTORS = new Set([
  'and', 'of', 'the',
  'de', 'van', 'von', 'der',
  'la', 'le',
])

export function titleCase(input: string): string {
  if (!input) return input
  // Split on whitespace but keep the separators so we can
  // reconstruct the original spacing.
  return input.split(/(\s+)/).map((token) => {
    if (/^\s+$/.test(token) || token === '') return token
    const lower = token.toLowerCase()
    if (CONNECTORS.has(lower)) return lower
    // \b\w matches the first letter after each word boundary, which
    // includes positions after apostrophes and hyphens. Lowercase
    // first so ALL-CAPS input collapses cleanly.
    return lower.replace(/\b\w/g, (c) => c.toUpperCase())
  }).join('')
}
