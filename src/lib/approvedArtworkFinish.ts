// Which of a version's approved images belong to the finish an ORDER was
// actually bought against.
//
// A metal proof is normally shown with a finish tab per option (Natural /
// Brushed / Mirror), and every image is stamped with the tab it was uploaded
// on (`proof_version_images.material_option`). The customer then picks ONE
// finish — at checkout on an open-spec order, or the designer picks it in the
// builder — and that pick is stored on the order as `material_option_id`.
//
// Every production hand-off therefore has to narrow the version's images to
// that one finish. Skipping the narrowing lists the whole matrix: a one-name
// two-sided metal proof with three finishes hands production SIX files where
// the customer bought TWO, with nothing on the page saying which four to
// ignore (found on order ORD-58ABA7BB54, Gold Metal / Natural).
//
// The rule mirrors the customer page's own image filter
// (CustomerProofPage, "Filter images for the active option"): when the version
// has option tabs, every legitimate image carries one of them, so a null
// `material_option` is an orphan carry-forward the customer never saw and is
// not part of the approved set. Verified against live data — the split is
// exactly bimodal, 110 versions with tabs carry 349 tagged images and zero
// nulls, 326 without tabs carry 735 nulls and zero tagged — so scoping can
// never silently drop a file production needs.
//
// The two "can't narrow" outcomes deliberately fall back to the FULL set
// rather than an empty one, and are flagged so the caller can say so. Handing
// a reviewer nothing (or worse, a silent subset chosen by a code that matched
// nothing) is a worse failure than handing them everything with a warning.

export type FinishScopeOutcome =
  // The version never offered a finish choice, so every image is the set. The
  // normal path for non-metal work, and for preference-only finishes like
  // Full Colour Plastic's gloss/matte (migration 000303), where the order
  // carries a finish but the artwork is identical across it.
  | 'no-tabs'
  // Narrowed to the finish the order was placed for.
  | 'scoped'
  // The version has tabs but the order records no finish — a legacy order
  // predating `material_option_id`, or an offline/manual one the designer
  // never set a finish on.
  | 'finish-unknown'
  // The order names a finish that matches no image on this version — e.g. the
  // finish was retired from the proof after the order was placed, or the order
  // belongs to a different material's version.
  | 'finish-missing'

export interface FinishScopeResult<T> {
  images: T[]
  outcome: FinishScopeOutcome
}

// True when the caller should warn rather than present the list as definitive.
export function finishScopeIsUncertain(outcome: FinishScopeOutcome): boolean {
  return outcome === 'finish-unknown' || outcome === 'finish-missing'
}

export function scopeToOrderedFinish<T extends { material_option?: string | null }>(
  images: T[],
  versionOptionCodes: readonly (string | null | undefined)[] | null | undefined,
  orderedFinishCode: string | null | undefined,
): FinishScopeResult<T> {
  const tabs = (versionOptionCodes ?? []).filter(
    (c): c is string => typeof c === 'string' && c.trim() !== '',
  )
  if (tabs.length === 0) return { images, outcome: 'no-tabs' }

  const code = orderedFinishCode?.trim() ? orderedFinishCode.trim() : null
  if (!code) return { images, outcome: 'finish-unknown' }

  const scoped = images.filter((i) => i.material_option === code)
  if (scoped.length === 0) return { images, outcome: 'finish-missing' }

  return { images: scoped, outcome: 'scoped' }
}
