// Catch an old proof that still has the price panel on it, whichever way it
// arrived.
//
// THE FAILURE THIS EXISTS TO STOP, in the designer's words: "sometimes the
// designers forget the crop and we end up embedding old proofs in the customer
// facing page that show old pricing within the proof alongside new pricing on
// the page." The customer is then looking at two different prices for the same
// cards, one of them years out of date, on a page we asked them to approve.
//
// The crop engine already prevents this on the import path, because it does the
// cropping itself. A file dragged onto the drop zone bypasses it entirely — and
// dragging is how nearly every version is built. So the check has to sit at the
// point files ENTER, not at the point one particular feature creates them.
//
// TWO PLACES, DELIBERATELY:
//   1. As each file lands, so the designer can fix it in the moment they are
//      looking at it.
//   2. Again at save, because the whole problem is people FORGETTING. A notice
//      that can be ignored will be ignored by exactly the person this is for;
//      the save-time check is the one that actually stops it reaching a
//      customer.
//
// ⚠ NEITHER ONE BLOCKS, and neither crops on its own. Measured precision is
// 98.1% (3 false alarms in 213 real proofs), so roughly one in fifty flags is
// wrong — a hard block would stop legitimate work, and silent auto-cropping
// would eventually eat a card that never had a panel. Both surfaces state what
// was found and let the designer decide.

import { detectProofPanel, type PanelDetection } from './proofPanelCrop'

/** One file to check, keyed by whatever id the caller uses for its entries. */
export interface PanelCheckTarget {
  id: string
  file: File
}

/**
 * How many files to examine at once.
 *
 * Each is a decode plus a pass over a megapixel. A designer can drop forty at
 * once, and doing them all together locks the tab at the moment they want to
 * look at what landed.
 */
const CONCURRENCY = 4

/**
 * Look for a price panel in each file.
 *
 * Returns only the ones that HAVE a panel — a caller that stored a result per
 * file would have to remember that "checked and clean" and "not checked yet"
 * are different, and the whole point is that this runs quietly in the
 * background and decorates what it finds.
 *
 * Never throws. A file that cannot be read is simply not flagged: this is a
 * safety net over the normal flow, and it must never be the reason a designer
 * cannot add artwork.
 */
export async function findPanelsInFiles(
  targets: PanelCheckTarget[],
  opts?: { signal?: AbortSignal },
): Promise<Map<string, PanelDetection>> {
  const found = new Map<string, PanelDetection>()
  let next = 0

  const workers = Array.from({ length: Math.min(CONCURRENCY, targets.length) }, async () => {
    for (;;) {
      const i = next++
      if (i >= targets.length || opts?.signal?.aborted) return
      const t = targets[i]
      try {
        const detection = await detectProofPanel(t.file)
        if (detection.hasPanel) found.set(t.id, detection)
      } catch {
        // Deliberately silent — see the note above.
      }
    }
  })
  await Promise.all(workers)
  return found
}

/**
 * The sentence shown against a single flagged image.
 *
 * Names what the customer would see rather than what the software noticed. "Old
 * price panel detected" describes our machinery; "the customer would see these
 * prices next to the current ones" describes the consequence, which is the
 * thing that makes a busy designer stop.
 */
export function panelNoticeForImage(detection: PanelDetection): string {
  return detection.confidence === 'unsure'
    ? 'This might still have the old price panel on it — worth a look.'
    : 'This still has the old price panel on it. The customer would see those prices beside the current ones.'
}

/**
 * The save-time summary, or null when there is nothing to say.
 *
 * Deliberately counts rather than lists: at save the designer needs to know
 * whether to stop, and the per-image notices upstairs already say which ones.
 */
export function panelNoticeForSave(count: number): string | null {
  if (count <= 0) return null
  return count === 1
    ? 'One image still has the old price panel on it. The customer would see those prices beside the current price grid.'
    : `${count} images still have the old price panel on them. The customer would see those prices beside the current price grid.`
}
