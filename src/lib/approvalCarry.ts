// Does a recipient's approval survive into the next version?
//
// When a new version is added, each person who already approved keeps that
// approval ONLY if what they signed off is still exactly what they'd see.
// The rule is deliberately conservative — it carries on row identity, never
// on a guess that two images "look the same" — because the cost of getting
// it wrong is a customer being recorded as having approved artwork they
// never saw, and that artwork then going to print.
//
// This lives here rather than inline in NewVersionPage so the SAVE path and
// the pre-save warning in the form ask the same question. They used to be
// the same code in one place and no place else — which meant the designer
// only discovered a lost approval after saving, via a red flag on the
// dashboard.
//
// The rule covers SHARED artwork as well as a recipient's own. That's the
// half that was missing: a named slot used to be keyed on that person's
// images alone, so replacing the shared front — the one that prints on
// everybody's card — left every recipient marked as having approved a
// design they had never seen. See slotCoversAssoc.
//
// NOT covered here: the QR re-confirmation rule (migration 000169). A slot
// whose QR set changed still carries its approval row, but with
// qr_confirmed_at nulled, so it won't count toward finalisation until the
// customer re-ticks. Callers must therefore treat a `false` from
// approvalCarriesForSlot as "definitely needs approving again" and a `true`
// as "not re-approved *because of the artwork*" — never as a guarantee that
// nothing else needs doing.

import { SHARED_APPROVAL_KEY } from './types'

/** One image from the version being carried FROM, plus the designer's
 *  decisions about it in the form. */
export interface CarrySlotImage {
  /** Row id on the previous version — only needs to be unique per set. */
  rowId: string
  /** associated_name as stored on the PREVIOUS version. null = shared. */
  assoc: string | null
  /** The "Keep" toggle on the carry card is still ticked. */
  kept: boolean
  /** The designer queued a replacement file over this carry. */
  replaced: boolean
  /**
   * The image still lands in a slot that exists in the NEW version's slot
   * universe. Computed by the caller, because the slot universe depends on
   * form state (sidedness, shared, names, option tabs).
   *
   * Note this is the slot the image EFFECTIVELY lands in, not the one it
   * came from: a carried image whose slot collapsed into Shared (the
   * one-recipient → two-recipient transition) still counts as landing
   * validly, because it is the same stored file and every recipient sees it.
   */
  landsInValidSlot: boolean
}

/**
 * Which images an approval slot actually covers — i.e. what that approval is
 * a statement ABOUT.
 *
 * A named recipient sees two things on their card: their own artwork, and the
 * shared artwork, which prints on everybody's card. So their approval covers
 * both, and changing the shared front invalidates it just as surely as
 * changing their own side does. Keying a named slot on `assoc === name`
 * alone was the bug this closes: the shared front could be swapped for
 * something else entirely and every recipient stayed marked as having
 * approved it.
 *
 * The shared sentinel is the mirror image and covers only the unassigned
 * images. It's the required slot on the no-names shapes (where every image
 * is shared anyway), so widening it would be meaningless at best.
 *
 * This is not a judgement call — it mirrors the filter the customer's own
 * approval panel uses to decide what to put in front of them:
 *
 *     img.associated_name == null || img.associated_name === actionPanel.name
 *     (CustomerProofPage.tsx)
 *
 * Keep the two in step. If that filter ever changes, this must change with
 * it, or the app will be carrying approvals for something other than what
 * the customer was actually shown.
 */
function slotCoversAssoc(slotKey: string, assoc: string | null): boolean {
  if (slotKey === SHARED_APPROVAL_KEY) return assoc === null
  return assoc === slotKey || assoc === null
}

/**
 * True when the approval recorded against `slotKey` on the previous version
 * should carry onto the new one.
 *
 * Two conditions, both about the images that approval covers:
 *   * every one of them is being carried across untouched — kept, not
 *     replaced, and still landing somewhere real; and
 *   * no NEW file has been uploaded into the slot, which would mean they'd
 *     be looking at something they've never seen.
 */
export function approvalCarriesForSlot(
  slotKey: string,
  previousImages: CarrySlotImage[],
  freshAssocs: (string | null)[],
): boolean {
  const covered = previousImages.filter((img) => slotCoversAssoc(slotKey, img.assoc))
  const allCarried = covered.every(
    (img) => img.kept && !img.replaced && img.landsInValidSlot,
  )
  if (!allCarried) return false
  return !freshAssocs.some((assoc) => slotCoversAssoc(slotKey, assoc))
}

/**
 * The approved slots that will NOT carry — i.e. the people who have to
 * approve again because their artwork changed.
 *
 * Returned in the order given, so the caller can render them in roster
 * order rather than whatever order the approval rows came back in.
 */
export function slotsNeedingReapproval(
  approvedSlotKeys: string[],
  previousImages: CarrySlotImage[],
  freshAssocs: (string | null)[],
): string[] {
  return approvedSlotKeys.filter(
    (slotKey) => !approvalCarriesForSlot(slotKey, previousImages, freshAssocs),
  )
}
