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
//   4. Name match: the first chip whose lowercased value equals
//      any lowercased token wins. Full-token equality only, so
//      "Mark" doesn't match "Markus".
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

export interface ImageMatchResult {
  associatedName: string | null
  side: 'front' | 'back' | null
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

  // 4. Name match: first chip that equals any token (case-insensitive).
  let associatedName: string | null = null
  for (const chip of names) {
    if (lowerAll.includes(chip.toLowerCase())) {
      associatedName = chip
      break
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
