// Leg C — approved proof vs print file (docs/artwork-check-spec.md Phase 2b).
// The approved proof images are what the customer SIGNED OFF; the print files
// are what will PRINT. Feeding both lets the model catch post-approval drift —
// the Hurst class of error (an agreed gold-letter arrangement quietly wrong in
// one print file) — systematically rather than only when two print files
// happen to disagree with each other.
//
// This module is the pure pick logic: which of the version's image rows to
// download, in what order, under what caps. Byte-budget enforcement happens at
// download time in the edge function (image rows carry no size column).

export interface ApprovedImageRow {
  image_path: string | null
  original_filename: string | null
  associated_name: string | null
  side: string | null
  is_qr_code?: boolean | null
}

export interface ApprovedImagePick {
  path: string
  // "Derrick Smith — back" / "Shared — front": mirrors the review-page gallery
  // captions so findings can name the card the same way everywhere.
  label: string
  mediaType: string
}

export const APPROVED_IMAGES_MAX_COUNT = 12
export const APPROVED_IMAGE_MAX_BYTES = 4 * 1024 * 1024
// Approved proofs take whatever the prints + attachments left of the shared
// ~24 MB raw pool, capped at 6 MB — proof JPEGs are a few hundred KB each, so
// this only bites on outliers.
export function approvedImageBudget(printsRawBytes: number, attachmentsRawBytes: number): number {
  return Math.max(0, Math.min(6 * 1024 * 1024, 24 * 1024 * 1024 - printsRawBytes - attachmentsRawBytes))
}
// Pre-send proof check: the version images ARE the card side (there are no
// print files), so they lead the byte pool — up to 18 MB of the ~24 MB
// request budget, leaving headroom for attachments (whose picker is then
// sized around what the images actually used, same as the order path).
export const PROOF_IMAGES_TOTAL_MAX_BYTES = 18 * 1024 * 1024

const IMAGE_MEDIA: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}

export function pickApprovedImages(
  rows: ApprovedImageRow[],
): { picks: ApprovedImagePick[]; skipped: { name: string; reason: string }[] } {
  const picks: ApprovedImagePick[] = []
  const skipped: { name: string; reason: string }[] = []

  const candidates = rows.filter((r) => r.is_qr_code !== true && (r.image_path ?? '').trim() !== '')
  // Shared artwork first, then recipients alphabetically, front before back —
  // the review-page gallery order, so the model reads the set the same way a
  // human does.
  candidates.sort((a, b) => {
    const an = a.associated_name == null ? 0 : 1
    const bn = b.associated_name == null ? 0 : 1
    if (an !== bn) return an - bn
    const nameCmp = (a.associated_name ?? '').localeCompare(b.associated_name ?? '')
    if (nameCmp !== 0) return nameCmp
    const as = (a.side ?? 'front') === 'front' ? 0 : 1
    const bs = (b.side ?? 'front') === 'front' ? 0 : 1
    return as - bs
  })

  for (const r of candidates) {
    const path = (r.image_path ?? '').trim()
    const displayName = r.original_filename ?? path.split('/').pop() ?? path
    const ext = path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? ''
    const mediaType = IMAGE_MEDIA[ext]
    if (!mediaType) {
      // Hosted-vCard QR SVGs are excluded by is_qr_code already; anything else
      // non-raster (unexpected) is named rather than silently dropped.
      skipped.push({ name: displayName, reason: 'not a readable image type' })
      continue
    }
    if (picks.length >= APPROVED_IMAGES_MAX_COUNT) {
      skipped.push({ name: displayName, reason: 'approved-image limit reached' })
      continue
    }
    picks.push({
      path,
      label: `${r.associated_name ?? 'Shared'} — ${r.side === 'back' ? 'back' : 'front'}`,
      mediaType,
    })
  }
  return { picks, skipped }
}
