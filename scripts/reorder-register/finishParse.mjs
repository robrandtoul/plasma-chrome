// Reading the FINISH a past customer chose, out of a Xero invoice line.
//
// The register knows what material and thickness someone last bought, but not
// the finish — the seeding job read the Xero item name ("Gold metal cards
// (500 micron)") rather than the line description ("Gold metal business cards
// (500 micron with brushed finish)"). Finish is half of what a designer hunts
// through legacy systems for when building a repeat order, so this is the gap
// worth closing. Part A of docs/reorder-register-rescrape-spec.md.
//
// ⚠ THE GOVERNING RULE: every step here can only produce a finish or NULL. None
// of them may guess. This value ends up on the customer's own proof page,
// badging a column in their price grid as "your last order" — so a wrong
// finish is a confident false claim about their own history AND points at the
// wrong price, since Mirror and Brushed carry a surcharge Natural does not.
// Silence must stay silence. We have already shipped one defect of exactly this
// shape (see migration 000406).
//
// Pure and dependency-free so it can be tested without a database or a network.

/**
 * Item codes that are not a card we made. Lifted from the spec, which derived
 * them from the original scrape.
 *
 * ⚠ This set decides which invoices count as "unambiguously one product", which
 * decides which customers get a finish at all. Getting it wrong doesn't error —
 * it silently changes the population.
 *   020 = Extra tooling · 050 = International shipping
 *   052 = Domestic shipping · 910 = US Customs Handling Service
 * A line with NO inventory item is the summary-line fallback ("Order ORD-…"),
 * which is also not a product line.
 */
export const NON_PRODUCT_ITEM_CODES = new Set(['020', '050', '052', '910'])

export function isProductLine(line) {
  if (!line) return false
  const code = (line.item_code ?? '').trim()
  if (!code) return false // summary-line fallback
  return !NON_PRODUCT_ITEM_CODES.has(code)
}

/**
 * The only two synonym pairs we accept. Deliberately tiny: every additional
 * synonym is a chance to read a word that meant something else.
 *
 * ⚠ "matt"/"matte" is the dangerous one. Two of our MATERIALS are called Matte
 * Black Metal and Matte White Metal, so an unscoped search for /matt/ reads the
 * material's own name as a finish. The guard is structural rather than textual:
 * we only ever match against the options belonging to the material we already
 * resolved, and those materials have no options at all.
 */
const SYNONYMS = new Map([
  ['glossy', 'gloss'],
  ['matt', 'matte'],
])

function normalise(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

/** Every distinct micron figure named in the text, e.g. "800 micron" → 800. */
function micronsIn(text) {
  const out = new Set()
  for (const m of text.matchAll(/(\d{2,4})\s*(?:micron|microns|um|µm)\b/g)) {
    out.add(Number(m[1]))
  }
  return out
}

/**
 * Phrases that identify a DIFFERENT catalogue family. Used only to spot a
 * description that contradicts the item it is attached to — never to identify
 * the material, which comes from the item code.
 *
 * ⚠ TUNED AGAINST 637 REAL DESCRIPTIONS, and the tuning is the whole substance
 * of this list. A first cut matched bare colour words and refused 21 lines that
 * were perfectly good, because on a Plasma invoice those words are usually
 * describing something other than the card:
 *
 *   "Gold metal business cards (500 micron) with matt black polymer INFILL
 *    (NATURAL FINISH)"                  — matt black is the infill, not the card
 *   "Full colour plastic (760 micron) - GLOSS - metallic gold FOILING"
 *                                        — gold is the foil, not the card
 *   "Full colour plastic (760 micron with matte finish and gold FOILED border"
 *
 * So: matte/matt black and white are gone entirely (they are infill and plating
 * colours in practice, and the materials of those names carry their own item
 * codes with no options, so guard 1 catches them anyway); and `gold` and `steel`
 * must appear in a PRODUCT-shaped phrase rather than bare. Real contradictions
 * still refuse — "Gun metal business cards" on a gold item, "Copper metal cards"
 * on a rose gold item, "Gold metal business cards" on a steel item all still do.
 */
const MATERIAL_WORDS = [
  'stainless steel', 'gun metal', 'gunmetal', 'rose gold',
  'gold metal', 'gold card', 'steel card',
  'carbon fibre', 'carbon fiber', 'letterpress',
  'translucent', 'satin', 'tinted', 'acrylic', 'perspex', 'wood', 'bamboo',
  'copper', 'titanium',
]

/**
 * Read the finish off one invoice line.
 *
 * @param {object} input
 * @param {string} input.description   the Xero line description (free text)
 * @param {string} [input.itemName]    the catalogue item name, for contradiction checks
 * @param {number} [input.itemMicrons] thickness the ITEM says, if known
 * @param {string} input.materialCode  the material we already resolved, e.g. 'metal_steel'
 * @param {Array<{id: string, code: string, display_name: string}>} input.options
 *        that material's OWN options — empty for materials with no choice
 * @returns {{option: object|null, reason: string}}
 *          `reason` always explains a null, so a shadow run can be counted by
 *          cause rather than just "didn't work".
 */
export function parseFinish({ description, itemName, itemMicrons, materialCode, options }) {
  const opts = options ?? []

  // 1. No choice existed. This single guard disposes of every false positive
  //    the research found — "lava orange", "black infill", "full colour logo",
  //    "CMYK print", and the sharp one, "Matte black metal", where matte is
  //    part of the material's own name.
  if (opts.length === 0) return { option: null, reason: 'material_has_no_options' }

  const text = normalise(description)
  if (!text) return { option: null, reason: 'no_description' }

  // 2. Reject the prototype marker BEFORE the em-dash rule below can read
  //    "prototype sample" as a finish name. invoiceBuild.ts uses the same
  //    separator for both, and such an invoice already exists on live.
  if (/[—–-]\s*prototype sample\s*$/.test(text)) {
    return { option: null, reason: 'prototype_sample' }
  }

  // 3. Refuse on contradiction. A description naming a different thickness or a
  //    different material than the item record means the two disagree about
  //    what was sold, and we do not get to pick a winner. Real cases: INV-25013
  //    says copper on a gun-metal item; INV-23471 says 1500 micron on an 800.
  if (itemMicrons) {
    const said = micronsIn(text)
    if (said.size > 0 && !said.has(itemMicrons)) {
      return { option: null, reason: 'thickness_contradiction' }
    }
  }
  if (itemName) {
    const itemText = normalise(itemName)

    // ⚠ MINI IS A DIFFERENT PRODUCT, and this one was found by the hand check
    // rather than by reasoning. Mini Steel is 65 x 35mm with its own item codes
    // (0191/0192/0193) and — crucially — NO finish options in the catalogue.
    // Twelve invoices describe a Mini card while carrying a full-size steel
    // item code, e.g. "Mini Stainless steel business cards (500 micron -
    // 65mm x 35mm) - MIRROR FINISH". Either the code is a bookkeeping slip and
    // the customer really bought Mini Steel (which offers no finish at all), or
    // the wording is loose. We cannot tell, so we do not say — otherwise the
    // register asserts a finish for a product that has none, and badges the
    // wrong material's price column on the customer's own page.
    if (/\bmini\b/.test(text) && !/\bmini\b/.test(itemText)) {
      return { option: null, reason: 'mini_variant_contradiction' }
    }
    const inDesc = MATERIAL_WORDS.filter((w) => text.includes(w))
    const inItem = MATERIAL_WORDS.filter((w) => itemText.includes(w))
    // A word that appears in the description but belongs to no family named on
    // the item is a contradiction — unless it is a substring of one that does
    // ("gold" inside "rose gold", "steel" inside "stainless steel").
    const strayMaterials = inDesc.filter(
      (w) => !inItem.some((iw) => iw.includes(w) || w.includes(iw)),
    )
    if (strayMaterials.length > 0) {
      return { option: null, reason: `material_contradiction:${strayMaterials[0]}` }
    }
    // 4. Two materials of the SAME family in one line. INV-23456 reads "Gold
    //    metal cards (800 micron with mirror finish) / 50 in traditional gold /
    //    50 in rose gold" — one product line, genuinely two materials.
    if (inItem.includes('gold metal') && text.includes('rose gold') && !itemText.includes('rose gold')) {
      return { option: null, reason: 'two_materials_in_one_line' }
    }
  }

  // 5. Match ONLY against this material's own options, in exactly two shapes.
  const hits = new Map()
  for (const o of opts) {
    const name = normalise(o.display_name)
    const spellings = new Set([name])
    for (const [syn, canonical] of SYNONYMS) {
      if (canonical === name) spellings.add(syn)
    }
    for (const sp of spellings) {
      const esc = sp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      // (a) "<option> finish" — every hand-keyed form observed: "with natural
      //     finish", "- Natural finish", "(760 micron - matt finish)".
      const asFinish = new RegExp(`\\b${esc}\\s+finish\\b`)
      // (b) "— <exact display name>" at the end — the app-era format.
      const asSuffix = new RegExp(`[—–-]\\s*${esc}\\s*$`)
      if (asFinish.test(text) || asSuffix.test(text)) hits.set(o.id, o)
    }
  }

  // 6. Never rank, never take the first. Two options of the same material both
  //    named means we do not know which was bought.
  if (hits.size > 1) return { option: null, reason: 'two_options_named' }
  if (hits.size === 1) return { option: [...hits.values()][0], reason: 'matched' }

  // 7. Never infer from silence. No finish word means NULL — never the base
  //    option, even though Natural is the commonest steel finish by far. The
  //    unnamed lines are precisely the ones a default gets wrong.
  return { option: null, reason: 'not_named' }
}

/**
 * Wood is the one material whose choice never needed the description: the
 * catalogue item name carries the species, and the seeding job stored that name
 * verbatim in `last_spec` ("100 wood cards (3mm thick) - Bamboo").
 *
 * ⚠ "Mixed" is a real value on 41 rows and maps to nothing. It is an order of
 * several species, not a species — refusing is the honest answer.
 */
export function parseWoodSpecies(lastSpec, options) {
  const text = normalise(lastSpec)
  if (!text) return { option: null, reason: 'no_spec' }
  const tail = text.split(/\s[-—–]\s/).pop() ?? ''
  if (!tail || tail === text) return { option: null, reason: 'no_species_suffix' }
  if (tail === 'mixed') return { option: null, reason: 'mixed_species' }

  const hits = (options ?? []).filter((o) => {
    const name = normalise(o.display_name)
    // The invoice drops the nationality on two of the six ("Maple" for
    // Canadian Maple), so match the last word as well as the whole name.
    const lastWord = name.split(' ').pop()
    return tail === name || tail === lastWord
  })
  if (hits.length > 1) return { option: null, reason: 'ambiguous_species' }
  if (hits.length === 1) return { option: hits[0], reason: 'matched' }
  return { option: null, reason: `unknown_species:${tail}` }
}
