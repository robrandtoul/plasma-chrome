// What switching a version to the Selection shape destroys.
//
// Selection (`is_variant_round`) is a WHOLE-VERSION shape, not an additive
// one. Its save path in NewVersionPage forces `names: []` and writes only the
// per-direction artwork, so the recipient roster and every carried or
// uploaded per-person image are dropped the moment the version saves.
//
// Nothing warned about that. Worse, the Recipients → Selection flip doesn't
// even trip the existing card-type confirm, because both shapes derive
// `cardType: 'business'` (see deriveFormState in ProofShapeWizard) — so the
// whole set vanished in silence.
//
// That reached a customer. An 8-name carbon-fibre proof was rebuilt as a
// 2-direction "pick one" holding a single person's card; the other seven were
// gone from the current version, the bundle page showed the card with no
// recipients at all, and the proof could no longer finalise (variant rounds
// bail out of the approval finaliser, migration 000141) while its paid order
// sat in `revision`.
//
// The rule lives here rather than inline in the form so the warning and the
// save path can be reasoned about — and tested — together, the same reason
// approvalCarry.ts was extracted.

export interface SelectionLossInput {
  /** Recipient roster on the version being built. The save path empties it. */
  names: string[]
  /** Images carried forward from the previous version. */
  carriedImageCount: number
  /** Images the designer has uploaded into this version so far. */
  uploadedImageCount: number
}

export interface SelectionLoss {
  /** True when the switch would destroy work the designer can see. */
  destructive: boolean
  nameCount: number
  /** Carried + uploaded. Every one of these is dropped by the save path. */
  imageCount: number
  /** Confirm body to show, or null when there is nothing to lose. */
  message: string | null
}

/**
 * Decide whether switching to Selection is destructive, and describe the loss.
 *
 * Returns `destructive: false` for the legitimate path — a fresh proof, or a
 * continuation carrying neither names nor artwork — so the confirm never nags
 * a designer who is simply starting a Selection from scratch.
 */
export function selectionShapeLoss(input: SelectionLossInput): SelectionLoss {
  const nameCount = input.names.length
  // Both buckets die together: the variant-round branch reads neither
  // v1Carry.images nor imagesByOption, it writes variantRows only.
  const imageCount = input.carriedImageCount + input.uploadedImageCount

  if (nameCount === 0 && imageCount === 0) {
    return { destructive: false, nameCount, imageCount, message: null }
  }

  // Name the losses concretely. "This will discard your work" is the kind of
  // warning people click through; "will drop the 8-name set and 16 images" is
  // the kind they stop and read.
  const losses: string[] = []
  if (nameCount > 0) {
    losses.push(nameCount === 1 ? 'the 1-name set' : `the ${nameCount}-name set`)
  }
  if (imageCount > 0) {
    losses.push(imageCount === 1 ? '1 image' : `${imageCount} images`)
  }

  return {
    destructive: true,
    nameCount,
    imageCount,
    message:
      `Switching to Selection will drop ${losses.join(' and ')} from this version.\n\n` +
      'Selection asks the customer to pick one direction, so the version keeps only the ' +
      "directions you set up below — the per-person cards don't carry over.\n\n" +
      'Continue?',
  }
}
