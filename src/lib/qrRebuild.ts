// Redraw a QR code crisply from the artwork's OWN pixels.
//
// Customers scan the QR off the screen to see how it behaves on their
// own phone, so the image we show them has to actually scan. A crop
// taken from a proof often won't: many proof images are photographs
// of physical cards shot at an angle, and a small skewed photo of a
// dense code is exactly what a phone camera struggles with. Measured
// on 72 real codes, a crop at typical on-screen size scanned 94% of
// the time — and that figure is optimistic, because the codes too
// skewed to measure are the ones most likely to fail.
//
// The obvious fix — re-encode the decoded text into a fresh QR — was
// measured and rejected. Pinning the version and error-correction the
// decoder reports and searching all eight mask patterns produced a
// module-for-module match only 53% of the time (38/72), because
// encoders split text into chunks differently. And there is no such
// thing as "close": when it missed, the median difference was 38% of
// all modules. Half the time we'd have shown the customer a code that
// looks nothing like the one on their card.
//
// So instead of re-encoding the text, we read the actual black-and-
// white grid off the printed artwork and redraw it as clean squares.
// Every module comes from the card, so a quirk in the print is
// preserved rather than idealised away — but the result is perfectly
// crisp at any size. Every rebuild produced in testing scanned at
// on-screen size: 40 out of 40, across two runs.
//
// Only about half the codes can be rebuilt (18/35 and 22/41 in those
// runs). Locking a sampling grid onto a small, steeply-angled
// photograph often isn't possible, and that's the binding constraint
// — not thresholding. The rest fall back to the plain crop, which is
// what the designer would have had anyway and which scans ~82% of
// the time. Net effect measured end to end: roughly 82% → 91% of
// codes scannable from the screen.
//
// The guarantee is the round trip, not the sampling: every rebuild is
// decoded again and only used if it reads back as the exact same
// payload. That's what lets us try several sampling strategies and
// relax the finder-pattern gate — a bad sample can't reach a customer
// because it can't survive being re-read.

import { decodeAllQrs, type QrPosition } from './qrCodes'

/** A module grid read off the artwork. 1 = dark. */
type Matrix = number[][]

interface Point {
  x: number
  y: number
}

// Guard against absurd inputs — sampling needs the full-resolution
// pixel buffer, and a 40MP artwork would cost ~160MB to read.
const MAX_SAMPLE_PIXELS = 40_000_000

// Quiet zone, in modules. The spec asks for 4; scanners rely on it,
// and a code butted against the edge of an image is a classic reason
// a phone won't pick it up.
const QUIET_ZONE_MODULES = 4

// Target size of the redrawn image. Big enough that the customer can
// scan it from a screen at any sensible display size, small enough to
// stay a trivial upload.
const TARGET_PX = 800
const MIN_MODULE_PX = 3

// Canonical finder pattern — the three big squares in the corners.
// Used to prove the sampling grid actually landed on the code rather
// than being silently off by a module, which would produce a
// confident-looking but wrong rebuild.
const FINDER = [
  [1, 1, 1, 1, 1, 1, 1],
  [1, 0, 0, 0, 0, 0, 1],
  [1, 0, 1, 1, 1, 0, 1],
  [1, 0, 1, 1, 1, 0, 1],
  [1, 0, 1, 1, 1, 0, 1],
  [1, 0, 0, 0, 0, 0, 1],
  [1, 1, 1, 1, 1, 1, 1],
]
// Deliberately loose. This is a cheap early-out to avoid rendering
// and decoding obvious rubbish, NOT the correctness check — that's
// the round-trip decode in rebuildQrImage. Set tight (0.9) it threw
// away plenty of samples that would have verified fine.
const MIN_FINDER_AGREEMENT = 0.75

/**
 * Sampling strategies, tried in order until one produces a rebuild
 * that decodes back to the right payload.
 *
 * `offsets` are sub-module sample points: a 3×3 cluster averages out
 * print texture and JPEG noise, while a single centre pixel does
 * better on small codes where a wide cluster bleeds into its
 * neighbours.
 *
 * Kept to two on purpose. Midpoint-threshold and wider-cluster
 * variants were measured and recovered nothing — when a rebuild
 * fails it's because the sampling grid doesn't line up with the
 * printed code (a steeply-angled photo), and no amount of
 * re-thresholding fixes a misaligned grid. Each extra strategy costs
 * a render and a decode on every failure, so they earned their
 * removal.
 */
const STRATEGIES: { offsets: number[]; threshold: 'otsu' }[] = [
  { offsets: [-0.18, 0, 0.18], threshold: 'otsu' },
  { offsets: [0], threshold: 'otsu' },
]

/**
 * Projective map from the unit square onto the code's quadrilateral.
 *
 * A bilinear interpolation is not good enough here: a card
 * photographed at an angle has genuine perspective, and the module
 * grid drifts badly across the code if you ignore it.
 */
function homography(p0: Point, p1: Point, p2: Point, p3: Point) {
  const dx1 = p1.x - p2.x
  const dx2 = p3.x - p2.x
  const dx3 = p0.x - p1.x + p2.x - p3.x
  const dy1 = p1.y - p2.y
  const dy2 = p3.y - p2.y
  const dy3 = p0.y - p1.y + p2.y - p3.y

  let a: number, b: number, c: number, d: number, e: number, f: number
  let g: number, h: number

  if (Math.abs(dx3) < 1e-9 && Math.abs(dy3) < 1e-9) {
    // No perspective component — an affine map is exact.
    a = p1.x - p0.x
    b = p2.x - p1.x
    c = p0.x
    d = p1.y - p0.y
    e = p2.y - p1.y
    f = p0.y
    g = 0
    h = 0
  } else {
    const den = dx1 * dy2 - dx2 * dy1
    if (Math.abs(den) < 1e-9) return null
    g = (dx3 * dy2 - dx2 * dy3) / den
    h = (dx1 * dy3 - dx3 * dy1) / den
    a = p1.x - p0.x + g * p1.x
    b = p3.x - p0.x + h * p3.x
    c = p0.x
    d = p1.y - p0.y + g * p1.y
    e = p3.y - p0.y + h * p3.y
    f = p0.y
  }

  return (u: number, v: number): Point => {
    const w = g * u + h * v + 1
    return { x: (a * u + b * v + c) / w, y: (d * u + e * v + f) / w }
  }
}

function finderAgreement(m: Matrix, row0: number, col0: number): number {
  let ok = 0
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 7; c++) {
      if (m[row0 + r][col0 + c] === FINDER[r][c]) ok++
    }
  }
  return ok / 49
}

/** Otsu's method over the sampled module brightnesses. */
function otsuThreshold(values: number[]): number | null {
  const min = Math.min(...values)
  const max = Math.max(...values)
  // Too little contrast to call light from dark honestly.
  if (max - min < 12) return null

  let best = min
  let bestScore = -1
  const step = (max - min) / 64
  for (let t = min; t <= max; t += step) {
    let loSum = 0
    let loN = 0
    let hiSum = 0
    let hiN = 0
    for (const v of values) {
      if (v <= t) {
        loSum += v
        loN++
      } else {
        hiSum += v
        hiN++
      }
    }
    if (loN === 0 || hiN === 0) continue
    const score = loN * hiN * (loSum / loN - hiSum / hiN) ** 2
    if (score > bestScore) {
      bestScore = score
      best = t
    }
  }
  return best
}

/**
 * Read the module grid out of the artwork pixels. Returns null when
 * the grid can't be trusted — too little contrast, sampling that fell
 * outside the image, or finder patterns that don't line up.
 */
function sampleModules(
  image: ImageData,
  position: QrPosition,
  version: number,
  strategy: { offsets: number[] },
): Matrix | null {
  const size = 4 * version + 17
  const map = homography(
    position.topLeft,
    position.topRight,
    position.bottomRight,
    position.bottomLeft,
  )
  if (!map) return null

  const luminanceAt = (x: number, y: number): number | null => {
    const xi = Math.round(x)
    const yi = Math.round(y)
    if (xi < 0 || yi < 0 || xi >= image.width || yi >= image.height) return null
    const i = (yi * image.width + xi) * 4
    return (
      image.data[i] * 0.299 + image.data[i + 1] * 0.587 + image.data[i + 2] * 0.114
    )
  }

  const brightness: number[][] = []
  for (let r = 0; r < size; r++) {
    const row: number[] = []
    for (let c = 0; c < size; c++) {
      let sum = 0
      let n = 0
      for (const du of strategy.offsets) {
        for (const dv of strategy.offsets) {
          const p = map((c + 0.5 + du) / size, (r + 0.5 + dv) / size)
          const l = luminanceAt(p.x, p.y)
          if (l !== null) {
            sum += l
            n++
          }
        }
      }
      if (n === 0) return null
      row.push(sum / n)
    }
    brightness.push(row)
  }

  const threshold = otsuThreshold(brightness.flat())
  if (threshold === null) return null
  const matrix = brightness.map((row) => row.map((v) => (v <= threshold ? 1 : 0)))

  // Sanity gate. A grid that's off by a module still produces a
  // plausible-looking matrix, and the finder patterns are the cheapest
  // way to prove it isn't.
  const agreement = Math.min(
    finderAgreement(matrix, 0, 0),
    finderAgreement(matrix, 0, size - 7),
    finderAgreement(matrix, size - 7, 0),
  )
  if (agreement < MIN_FINDER_AGREEMENT) return null

  return matrix
}

/**
 * Draw the module grid as clean black squares on white, with a quiet
 * zone. Always black-on-white regardless of how the card prints it —
 * a white-on-black etched metal card scans far more reliably off a
 * screen this way, and it's the same code either way.
 */
function renderMatrix(matrix: Matrix): Promise<Blob | null> {
  const size = matrix.length
  const total = size + QUIET_ZONE_MODULES * 2
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
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (matrix[r][c]) {
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
 * Rebuild a crisp, scannable image of a QR from the artwork it was
 * found in. Returns null whenever we can't do it provably — the
 * caller falls back to the plain crop.
 *
 * `expectedPayload` is the guarantee: the rebuild is decoded and only
 * returned if it reads back byte-for-byte identical. A rebuild that
 * sampled slightly wrong is silently discarded rather than shown to a
 * customer as if it were their code.
 */
export async function rebuildQrImage(
  image: ImageData,
  position: QrPosition,
  version: number | null,
  expectedPayload: string,
): Promise<Blob | null> {
  if (!version) return null
  if (image.width * image.height > MAX_SAMPLE_PIXELS) return null

  for (const strategy of STRATEGIES) {
    let matrix: Matrix | null
    try {
      matrix = sampleModules(image, position, version, strategy)
    } catch {
      continue
    }
    if (!matrix) continue

    let blob: Blob | null
    try {
      blob = await renderMatrix(matrix)
    } catch {
      continue
    }
    if (!blob) continue

    // The whole safety of this feature is here: prove the rebuild is
    // the same code before letting it stand in for the real one. A
    // strategy that sampled slightly wrong fails this and we move on
    // to the next rather than showing the customer a plausible-
    // looking code that isn't theirs.
    try {
      const readBack = await decodeAllQrs(blob, 1)
      if (readBack.length === 1 && readBack[0].data === expectedPayload) return blob
    } catch {
      // fall through to the next strategy
    }
  }

  return null
}
