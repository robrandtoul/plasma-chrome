// Redraw a QR code crisply, so a customer can scan it off the screen.
//
// Customers scan the QR on the proof page to see how it behaves on
// their own phone, so the image we show has to actually scan. A crop
// taken straight from a proof often won't: many proof images are
// photographs of physical cards shot at an angle, and a small skewed
// photo of a dense code is exactly what a phone camera struggles
// with. Measured on real proofs, crops scanned ~82% of the time.
//
// ── Two approaches were measured and rejected ────────────────────────
//
// 1. Re-encode the decoded TEXT into a fresh QR. Pinning the version
//    and error-correction the decoder reports and searching all eight
//    mask patterns still matched the printed code module-for-module
//    only 53% of the time (38/72), because encoders split text into
//    chunks differently. And there is no "close": when it missed, the
//    median difference was 38% of all modules. Half the time we'd
//    have shown the customer a code that looks nothing like theirs.
//
// 2. Sample the module grid out of the artwork ourselves — projective
//    homography from the decoder's corner points, Otsu threshold,
//    finder-pattern gate. This worked, but only on ~54% of codes: a
//    grid stretched between four fuzzy outer corners drifts badly
//    across a steeply-angled photo, and no amount of re-thresholding
//    fixes misaligned geometry.
//
// ── What we do instead ───────────────────────────────────────────────
//
// zxing-cpp already solves this internally — it has to, or it
// couldn't decode at all. It locates the finder patterns precisely,
// uses the alignment patterns as extra anchors inside the symbol, and
// produces a straightened module grid. And it hands that grid back on
// every successful decode.
//
// Measured: present on 100% of decodes, exactly (4 × version + 17)
// square every time, and 96% of grids re-decode correctly once
// rendered — including cards photographed at an angle in someone's
// hand, which approach 2 gave up on entirely.
//
// So we render the decoder's own grid as clean black squares. Every
// module still comes from the printed card, so a quirk in the print
// is preserved rather than idealised away, but the result is crisp at
// any size. Always black-on-white even where the card prints
// white-on-black — it scans far better off a screen and it's the same
// code.
//
// The guarantee is the round trip, not the grid: every rebuild is
// decoded again and only used if it reads back byte-for-byte
// identical. A rebuild that came out wrong — including one caused by
// a future change to the experimental `symbol` field — can't reach a
// customer, because it can't survive being re-read. Anything unproven
// falls back to the plain crop, which is what the designer would have
// had anyway.

import { decodeAllQrs, type QrSymbol } from './qrCodes'

// Quiet zone, in modules. The spec asks for 4; scanners rely on it,
// and a code butted against the edge of an image is a classic reason
// a phone won't pick it up.
const QUIET_ZONE_MODULES = 4

// Target size of the redrawn image. Big enough to scan from a screen
// at any sensible display size, small enough to stay a trivial upload.
const TARGET_PX = 800
const MIN_MODULE_PX = 3

// A module reads dark below this. zxing-cpp returns a one-channel
// image, so a simple midpoint is right — this is already binarised,
// not a photograph.
const DARK_THRESHOLD = 128

/**
 * Draw the decoder's module grid as clean black squares on white,
 * with a quiet zone.
 */
function renderSymbol(symbol: QrSymbol): Promise<Blob | null> {
  const total = symbol.width + QUIET_ZONE_MODULES * 2
  const scale = Math.max(MIN_MODULE_PX, Math.floor(TARGET_PX / total))
  const px = total * scale

  const canvas = document.createElement('canvas')
  canvas.width = px
  canvas.height = px
  const ctx = canvas.getContext('2d')
  if (!ctx) return Promise.resolve(null)

  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, px, px)
  ctx.fillStyle = '#000000'
  for (let r = 0; r < symbol.height; r++) {
    for (let c = 0; c < symbol.width; c++) {
      if (symbol.data[r * symbol.width + c] < DARK_THRESHOLD) {
        ctx.fillRect(
          (c + QUIET_ZONE_MODULES) * scale,
          (r + QUIET_ZONE_MODULES) * scale,
          scale,
          scale,
        )
      }
    }
  }
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'))
}

/**
 * Rebuild a crisp, scannable image of a QR from the decoder's own
 * straightened module grid. Returns null whenever we can't do it
 * provably — the caller falls back to the plain crop.
 *
 * `expectedPayload` is the guarantee: the rebuild is decoded and only
 * returned if it reads back byte-for-byte identical.
 */
export async function rebuildQrImage(
  symbol: QrSymbol | null,
  version: number | null,
  expectedPayload: string,
): Promise<Blob | null> {
  if (!symbol || symbol.width < 21 || symbol.width !== symbol.height) return null
  if (symbol.data.length < symbol.width * symbol.height) return null

  // Sanity-check the grid really is one pixel per module. This is the
  // guard against the experimental `symbol` field changing shape — if
  // a future version returns something scaled or padded, we bail to
  // the crop rather than rendering nonsense.
  if (version !== null && symbol.width !== 4 * version + 17) return null

  let blob: Blob | null
  try {
    blob = await renderSymbol(symbol)
  } catch {
    return null
  }
  if (!blob) return null

  // Prove the rebuild is the same code before letting it stand in for
  // the real one.
  try {
    const readBack = await decodeAllQrs(blob, 1)
    if (readBack.length === 1 && readBack[0].data === expectedPayload) return blob
  } catch {
    return null
  }

  return null
}
