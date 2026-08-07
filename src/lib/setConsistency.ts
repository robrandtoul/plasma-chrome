// Does this set of cards hang together?
//
// A Recipients version is a set: one card per named person, each with
// the same sides as everyone else's. Nothing checked that, so a set
// could go to the customer half-built in ways the designer wouldn't
// spot in a grid of thumbnails but the customer sees immediately —
// their colleague's card has a back and theirs doesn't, or their name
// sits over two different designs.
//
// Three real ones, all found on live proofs in August 2026:
//
//   The Sourdough Company (approved, ordered) — a shared front with
//   each person's own back, except James Gunns' image carried no side
//   at all. His two colleagues' cards read FRONT / BACK; his read
//   FRONT / nothing. He approved it that way.
//
//   F&D Tech Solutions and Motion Private Chauffeur — the same
//   unlabelled-side shape, caught before sending.
//
//   MKC Wealth (approved, ordered) — Jed Wilson's slot held two
//   fronts, his own card and an alternative colourway. Charles Follis
//   had one. "Jed Wilson approved" records nothing about which of the
//   two he meant, because the approval model has one slot per person.
//
// Where the unlabelled sides come from: matchImageToName returns
// side: null whenever the filename carries no front/back token, and
// the edit-version form stores that as-is (the new-version form
// coerces it to 'front' at save). So a designer hand-tags the ones
// they notice and one slips through.
//
// Everything here is advisory. The preview gate that shows it is
// explicitly "a check, not a punishment", and each of these has a
// legitimate shape behind it often enough that blocking would be
// wrong — a set really can have one person on a different card, and
// two images in a slot really can be a deliberate detail shot. The
// designer is told; the designer decides.
//
// Tests: pnpm test:set-consistency

export interface SetImage {
  associatedName: string | null
  side: 'front' | 'back' | null
  /** Option tab this image belongs to. Null = shown on every tab. */
  materialOption?: string | null
}

export interface SetFinding {
  kind: 'unlabelled-side' | 'missing-side' | 'doubled-slot'
  /** One plain sentence, ready to render. */
  message: string
}

export interface SetReviewInput {
  names: string[]
  images: SetImage[]
  /** Selection rounds price per direction and have their own slot model. */
  isVariantRound?: boolean
  /** 'set_collection' keys slots on layouts, not names. */
  shape?: string | null
}

function roster(names: string[]): string[] {
  return names.map((n) => n.trim()).filter((n) => n.length > 0)
}

/** "A, B and C" — the list reads as a sentence, not a dump. */
function joinNames(list: string[]): string {
  if (list.length <= 1) return list[0] ?? ''
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`
}

/**
 * The option tabs to check independently. Each tab is its own complete
 * set on the customer page, and an image with no tab shows on all of
 * them — so coverage has to be judged per tab, or a proof whose
 * Brushed tab is complete would paper over a half-built Natural one.
 */
function tabsOf(images: SetImage[]): (string | null)[] {
  const named = Array.from(
    new Set(images.map((i) => i.materialOption).filter((o): o is string => !!o)),
  )
  return named.length > 0 ? named : [null]
}

function inTab(images: SetImage[], tab: string | null): SetImage[] {
  if (tab === null) return images
  return images.filter((i) => i.materialOption === tab || i.materialOption == null)
}

/**
 * Review one version's artwork as a set. Returns findings in the order
 * they should be read, or [] when everything lines up (and for the
 * shapes this rule doesn't model).
 */
export function reviewSet(input: SetReviewInput): SetFinding[] {
  const { images, isVariantRound, shape } = input
  if (isVariantRound || shape === 'set_collection') return []

  const people = roster(input.names)
  if (people.length === 0 || images.length === 0) return []

  const findings: SetFinding[] = []

  // ── 1. Sides nobody recorded ────────────────────────────────────
  // Only worth raising once the version HAS a back: on a one-sided
  // card an unlabelled image is unambiguous, and both the customer
  // page and the artwork hand-off already read it as the front.
  const twoSided = images.some((i) => i.side === 'back')
  const unlabelled = twoSided ? images.filter((i) => i.side == null) : []
  const unlabelledPeople = new Set(
    unlabelled.map((i) => i.associatedName).filter((n): n is string => !!n),
  )

  if (unlabelled.length > 0) {
    const whose = Array.from(unlabelledPeople)
    findings.push({
      kind: 'unlabelled-side',
      message:
        whose.length > 0
          ? `${joinNames(whose)}${whose.length === 1 ? ' has' : ' have'} artwork that doesn’t say whether it’s the front or the back, so the customer sees it with no label while everyone else’s says Front or Back.`
          : 'Some shared artwork doesn’t say whether it’s the front or the back, so the customer sees it with no label while the rest say Front or Back.',
    })
  }

  // ── 2. Somebody short a side ────────────────────────────────────
  // Per tab, per side: a person is covered by their own image or by a
  // shared one, exactly as the customer page resolves it.
  if (twoSided) {
    const missing = new Map<string, Set<'front' | 'back'>>()
    for (const tab of tabsOf(images)) {
      const scoped = inTab(images, tab)
      const sidesHere = (['front', 'back'] as const).filter((s) =>
        scoped.some((i) => i.side === s),
      )
      for (const side of sidesHere) {
        const sharedHas = scoped.some((i) => i.associatedName == null && i.side === side)
        if (sharedHas) continue
        for (const person of people) {
          // Their unlabelled image is already reported above; naming
          // them twice for one mistake reads as two problems.
          if (unlabelledPeople.has(person)) continue
          const has = scoped.some((i) => i.associatedName === person && i.side === side)
          if (!has) {
            const set = missing.get(person) ?? new Set()
            set.add(side)
            missing.set(person, set)
          }
        }
      }
    }
    for (const side of ['front', 'back'] as const) {
      const who = people.filter((p) => missing.get(p)?.has(side))
      if (who.length === 0) continue
      findings.push({
        kind: 'missing-side',
        message: `This is a two-sided set, but ${joinNames(who)} ${
          who.length === 1 ? 'has' : 'have'
        } no ${side}.`,
      })
    }
  }

  // ── 3. Two designs under one name ───────────────────────────────
  // Named slots only. A shared slot holding several images is an
  // ordinary way to show a common design, but a recipient's slot is
  // what their approval points at — and it can only point at one
  // thing, so two designs there record no decision at all.
  const slots = new Map<string, { person: string; side: string | null; count: number }>()
  for (const img of images) {
    if (!img.associatedName) continue
    const key = `${img.associatedName}|${img.side ?? '?'}|${img.materialOption ?? ''}`
    const cur = slots.get(key)
    if (cur) cur.count += 1
    else slots.set(key, { person: img.associatedName, side: img.side, count: 1 })
  }
  for (const slot of slots.values()) {
    if (slot.count < 2) continue
    const where = slot.side ? `${slot.side}` : 'card'
    findings.push({
      kind: 'doubled-slot',
      message: `${slot.person}’s ${where} has ${slot.count} images. Approving names the person, not the image, so their sign-off won’t record which one they meant.`,
    })
  }

  return findings
}
