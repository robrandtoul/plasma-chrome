// Find QR codes that are already in the proof artwork, so the
// designer doesn't have to upload a separate cropped copy of a code
// that's plainly visible in the images they just dropped.
//
// Why this exists, beyond saving a step: the uploaded copy and the
// artwork are two independent artefacts, and nothing has ever forced
// them to agree. A benchmark over 123 live QR rows found one proof
// where the card's printed QR pointed at a completely different host
// from the copy the customer was shown and asked to approve. Reading
// the code out of the artwork closes that gap by construction — what
// the customer verifies is what's in the proof.
//
// The same benchmark sets expectations honestly: with the zxing-wasm
// decoder this finds ~95% of the QRs that are really there (near
// 100% for short URLs, lower for very dense vCards on dark cards).
// So this ASSISTS the existing flow rather than replacing it — every
// find is a suggestion the designer confirms, and the manual upload
// path stays exactly as it was for the cases we miss.

import { decodeAllQrs, type QrKind, type QrPosition } from './qrCodes'
import { rebuildQrImage } from './qrRebuild'

/** One artwork image to search, as the version forms already hold it. */
export interface ArtworkSource {
  /** Stable id — the form entry's localId or the saved row id. */
  id: string
  /**
   * Blob URL (freshly-dropped file) or signed URL (already-saved
   * image). Both fetch the same way, which is why the two version
   * forms can share one interface despite holding different shapes.
   */
  url: string
  /** Recipient this artwork belongs to. Null = shared across all cards. */
  associatedName: string | null
  side: 'front' | 'back' | null
  /** For a human-readable original_filename on the created row. */
  filename?: string | null
}

export interface ArtworkQrFind {
  /** Stable id for React keys and accept/dismiss bookkeeping. */
  id: string
  sourceId: string
  associatedName: string | null
  side: 'front' | 'back' | null
  decodedData: string
  kind: QrKind
  /** Image of just the QR, ready to become a row. */
  cropFile: File
  /** Object URL of cropFile for the preview thumbnail. Caller revokes. */
  cropPreviewUrl: string
  /**
   * False when the decoder didn't report corner points, so cropFile
   * is the whole artwork image rather than the code alone. Rare;
   * the UI flags it so the designer knows to check before accepting.
   */
  cropped: boolean
  /**
   * How cropFile was produced.
   *
   * 'rebuilt' — the code's module grid was read off the artwork and
   *   redrawn as clean black squares, then decoded again to prove it
   *   is byte-for-byte the same code. Crisp at any size, so the
   *   customer can scan it off their screen to test it on their own
   *   phone. Measured at ~90% of finds.
   * 'photo'   — the plain crop from the artwork. Used whenever a
   *   rebuild couldn't be proven correct, so we never show an
   *   idealised code we can't stand behind.
   */
  rendering: 'rebuilt' | 'photo'
}

// Scanning is ~250ms per image. A version with a big per-recipient
// roster can carry a lot of artwork, and scanning all of it would
// stall the form for no benefit — the codes repeat across cards.
const MAX_IMAGES_SCANNED = 24

// Quiet zone. A QR needs ~4 clear modules around it to stay
// readable, and a crop tight to the finder patterns looks wrong
// next to the customer-uploaded codes. 12% of the code's size is a
// generous equivalent at any resolution.
const CROP_PADDING_RATIO = 0.12
const CROP_PADDING_MIN_PX = 6

function boundingBox(pos: QrPosition) {
  const xs = [pos.topLeft.x, pos.topRight.x, pos.bottomLeft.x, pos.bottomRight.x]
  const ys = [pos.topLeft.y, pos.topRight.y, pos.bottomLeft.y, pos.bottomRight.y]
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  }
}

/**
 * Cut the QR out of its artwork. Deliberately crops from the source
 * pixels rather than synthesising a clean white border — the stored
 * image should show the code as it actually prints, including the
 * card's own background, because that's what the customer is being
 * asked to verify.
 */
async function cropToBlob(
  bitmap: ImageBitmap,
  pos: QrPosition,
): Promise<Blob | null> {
  const { minX, maxX, minY, maxY } = boundingBox(pos)
  const w = maxX - minX
  const h = maxY - minY
  if (!(w > 0) || !(h > 0)) return null

  const pad = Math.max(CROP_PADDING_MIN_PX, Math.round(Math.max(w, h) * CROP_PADDING_RATIO))
  const x = Math.max(0, Math.round(minX) - pad)
  const y = Math.max(0, Math.round(minY) - pad)
  const right = Math.min(bitmap.width, Math.round(maxX) + pad)
  const bottom = Math.min(bitmap.height, Math.round(maxY) + pad)
  const cw = right - x
  const ch = bottom - y
  if (cw < 8 || ch < 8) return null

  const canvas = document.createElement('canvas')
  canvas.width = cw
  canvas.height = ch
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(bitmap, x, y, cw, ch, 0, 0, cw, ch)
  return await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((b) => resolve(b), 'image/png'),
  )
}

function safeSlug(input: string | null): string {
  const base = (input ?? 'shared').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return base || 'shared'
}

/**
 * Scan artwork for QR codes. Never throws for an individual image —
 * a file that won't fetch or decode is simply skipped, because this
 * runs in the background of a form the designer is still filling in
 * and must never block or alarm them.
 *
 * Results are deduplicated on decoded payload: the same code printed
 * on six recipients' cards is one suggestion, not six.
 */
export async function scanArtworkForQrs(
  sources: ArtworkSource[],
  opts: { signal?: AbortSignal } = {},
): Promise<ArtworkQrFind[]> {
  const finds: ArtworkQrFind[] = []
  const seenPayloads = new Set<string>()

  for (const source of sources.slice(0, MAX_IMAGES_SCANNED)) {
    if (opts.signal?.aborted) break

    let blob: Blob
    try {
      const res = await fetch(source.url)
      if (!res.ok) continue
      blob = await res.blob()
    } catch {
      continue
    }
    if (opts.signal?.aborted) break

    let hits: Awaited<ReturnType<typeof decodeAllQrs>>
    try {
      hits = await decodeAllQrs(blob)
    } catch {
      // Decoder unavailable or the image is unreadable. Silent by
      // design — the manual upload path still works.
      continue
    }
    if (hits.length === 0) continue

    let bitmap: ImageBitmap | null = null
    try {
      bitmap = await createImageBitmap(blob)
    } catch {
      bitmap = null
    }

    // Full-resolution pixels, read once and shared by every code on
    // this image — the rebuild samples the printed module grid out of
    // them and needs the detail, so this can't be a downscale.
    let pixels: ImageData | null = null
    if (bitmap) {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = bitmap.width
        canvas.height = bitmap.height
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        if (ctx) {
          ctx.drawImage(bitmap, 0, 0)
          pixels = ctx.getImageData(0, 0, bitmap.width, bitmap.height)
        }
      } catch {
        pixels = null
      }
    }

    for (const hit of hits) {
      if (seenPayloads.has(hit.data)) continue
      seenPayloads.add(hit.data)

      // Prefer a rebuild — it's the same code drawn crisply, so the
      // customer can scan it off the screen. rebuildQrImage returns
      // null unless it decoded back to this exact payload, so a
      // silent sampling error can never reach the customer.
      let rebuilt: Blob | null = null
      if (pixels && hit.position) {
        try {
          rebuilt = await rebuildQrImage(pixels, hit.position, hit.version, hit.data)
        } catch {
          rebuilt = null
        }
      }

      let cropBlob: Blob | null = null
      if (!rebuilt && bitmap && hit.position) {
        try {
          cropBlob = await cropToBlob(bitmap, hit.position)
        } catch {
          cropBlob = null
        }
      }

      const finalBlob = rebuilt ?? cropBlob ?? blob
      const cropped = rebuilt !== null || cropBlob !== null
      const name = `qr-${safeSlug(source.associatedName)}-${safeSlug(source.side)}.png`
      const cropFile = new File([finalBlob], name, {
        type: finalBlob.type || 'image/png',
      })

      finds.push({
        id: `${source.id}:${hit.data.slice(0, 32)}`,
        sourceId: source.id,
        associatedName: source.associatedName,
        side: source.side,
        decodedData: hit.data,
        kind: hit.kind,
        cropFile,
        cropPreviewUrl: URL.createObjectURL(cropFile),
        cropped,
        rendering: rebuilt ? 'rebuilt' : 'photo',
      })
    }

    bitmap?.close?.()
  }

  return finds
}
