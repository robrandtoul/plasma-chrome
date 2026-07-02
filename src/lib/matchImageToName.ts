// Filename → (associated name, side) auto-matcher.
//
// Called when the designer picks image files on the new- or edit-
// version form. Pre-populates the per-image Name + Side dropdowns
// from the filename so common shapes don't need manual labelling.
//
// Rules:
//   1. Strip the extension.
//   2. Strip any leading `Proof\d+_?` prefix (case-insensitive).
//   3. Tokenise the remaining stem:
//        * Primary split on `_`, `-`, whitespace.
//        * Further split each primary token on CamelCase
//          boundaries (insert a break between a lowercase and a
//          following uppercase letter).
//   4. Name match: a chip matches when EVERY token of the chip is
//      present among the file's tokens (each compared as a whole
//      token, so "Mark" still doesn't match "Markus"). Full "First
//      Last" roster names therefore match "Proof02_JoshWakeman.jpg"
//      because both "josh" and "wakeman" appear. When several chips
//      match, the most specific one wins (most tokens matched), with
//      roster order breaking ties — so a roster of ["Josh", "Josh
//      Wakeman"] resolves "JoshWakeman.jpg" to "Josh Wakeman".
//   5. Side match:
//        * Full-word "front" / "back" in any token → that side.
//        * Single-letter "f" / "b" only if it's a standalone
//          primary token (delimited by `_`, `-`, or whitespace).
//          This stops "Proof02_JeremyB.jpg" from reading the
//          trailing "B" of "JeremyB" as a back-side marker.
//
// Verified by the inline cases below. Kept as comments rather
// than a test runner because this repo has no Vitest wiring yet —
// the algorithm is small enough that hand-walking is enough.
//
// Test cases (filename + names → { associatedName, side }):
//
//   Proof01_KevinKnowles_Front.jpg, [Martin, Kevin, Jeremy]
//     cleaned = "KevinKnowles_Front"
//     primary = ["KevinKnowles", "Front"]
//     all     = ["Kevin", "Knowles", "Front"]
//     → { associatedName: "Kevin", side: "front" }
//
//   SharedFront.jpg, [Martin, Kevin, Jeremy]
//     cleaned = "SharedFront"
//     primary = ["SharedFront"]
//     all     = ["Shared", "Front"]
//     → { associatedName: null, side: "front" }
//
//   MartinDoe.jpg, [Martin, Kevin, Jeremy]
//     cleaned = "MartinDoe"
//     primary = ["MartinDoe"]
//     all     = ["Martin", "Doe"]
//     → { associatedName: "Martin", side: null }
//
//   Proof02_JeremyB.jpg, [Martin, Kevin, Jeremy]
//     cleaned = "JeremyB"
//     primary = ["JeremyB"]
//     all     = ["Jeremy", "B"]
//     → { associatedName: "Jeremy", side: null }
//       (single-letter "B" is NOT a primary token here — it came
//        from CamelCase splitting, so it can't carry side.)
//
//   Proof02_JoshWakeman_Bamboo.jpg, [Lee Bowtell, Josh Wakeman]
//     cleaned = "JoshWakeman_Bamboo"
//     primary = ["JoshWakeman", "Bamboo"]
//     all     = ["Josh", "Wakeman", "Bamboo"]
//     name tokens: "Lee Bowtell" → [lee, bowtell] (not all present)
//                  "Josh Wakeman" → [josh, wakeman] (both present)
//     → { associatedName: "Josh Wakeman", side: null }
//       (the whole-string equality this replaced never matched a
//        full "First Last" name, so both cards defaulted to shared.)

export interface ImageMatchResult {
  associatedName: string | null
  side: 'front' | 'back' | null
}

// Tokenise a roster name the same way the filename stem is tokenised
// (primary split on `_`, `-`, whitespace, then CamelCase boundaries),
// lowercased. "Josh Wakeman" → ["josh", "wakeman"]; "Josh" → ["josh"].
function nameTokens(name: string): string[] {
  return name
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .flatMap((t) => t.split(/(?<=[a-z])(?=[A-Z])/))
    .filter(Boolean)
    .map((t) => t.toLowerCase())
}

export function matchImageToName(filename: string, names: string[]): ImageMatchResult {
  // 1. Strip extension.
  const stem = filename.replace(/\.[^.]*$/, '')

  // 2. Strip leading "Proof\d+_?" prefix, case-insensitive.
  const cleaned = stem.replace(/^proof\d+_?/i, '')

  // 3. Tokenise.
  const primaryTokens = cleaned.split(/[_\-\s]+/).filter(Boolean)
  const allTokens = primaryTokens
    .flatMap((t) => t.split(/(?<=[a-z])(?=[A-Z])/))
    .filter(Boolean)
  const lowerAll = allTokens.map((t) => t.toLowerCase())
  const lowerPrimary = primaryTokens.map((t) => t.toLowerCase())

  // 4. Name match: a chip matches when every one of its tokens is
  //    present among the file's tokens. This lets a full "First Last"
  //    roster name match a filename that contains both parts, while
  //    per-token equality keeps "Mark" from matching "Markus". The
  //    most specific matching chip wins (most tokens), roster order
  //    breaking ties, so "Josh Wakeman" beats a bare "Josh" chip.
  const fileTokens = new Set(lowerAll)
  let associatedName: string | null = null
  let bestTokenCount = 0
  for (const chip of names) {
    const chipTokens = nameTokens(chip)
    if (chipTokens.length === 0) continue
    const allPresent = chipTokens.every((t) => fileTokens.has(t))
    if (allPresent && chipTokens.length > bestTokenCount) {
      associatedName = chip
      bestTokenCount = chipTokens.length
    }
  }

  // 5. Side match: prefer full-word tokens; fall back to single-letter
  //    only when delimited (primary-token position).
  let side: 'front' | 'back' | null = null
  for (const t of lowerAll) {
    if (t === 'front') { side = 'front'; break }
    if (t === 'back')  { side = 'back'; break }
  }
  if (!side) {
    for (const t of lowerPrimary) {
      if (t === 'f') { side = 'front'; break }
      if (t === 'b') { side = 'back'; break }
    }
  }

  return { associatedName, side }
}
