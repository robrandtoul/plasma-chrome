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
//   * Apostrophes and hyphens count as word boundaries for
//     capitalisation: "o'brien" → "O'Brien", "jean-luc" → "Jean-Luc".
//   * Periods do NOT count. Domain-style tails like "theluckygoat
//     .co.uk" stay as "Theluckygoat.co.uk" rather than becoming
//     "Theluckygoat.Co.Uk". Trailing periods on abbreviations (Ltd.)
//     are preserved as-is.
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

// Matches a letter that should be capitalised: either at token
// start, or immediately after a hyphen or apostrophe. Deliberately
// does NOT include `.` so domain tails and abbreviation periods
// don't trigger a capitalise.
const CAPITALISE_RE = /(^|[-'])(\p{L})/gu

export function titleCase(input: string): string {
  if (!input) return input
  // Split on whitespace but keep the separators so we can
  // reconstruct the original spacing.
  return input.split(/(\s+)/).map((token) => {
    if (/^\s+$/.test(token) || token === '') return token
    const lower = token.toLowerCase()
    if (CONNECTORS.has(lower)) return lower
    return lower.replace(CAPITALISE_RE, (_m, boundary: string, letter: string) =>
      boundary + letter.toUpperCase(),
    )
  }).join('')
}
