// Fitting oversized images for the model call.
//
// The Anthropic API hard-rejects any image with a dimension over 8000px —
// the WHOLE request 400s, so one oversized reference file takes down a run
// that had already read a dozen perfectly good proof images. That is exactly
// what happened to The Experience Auto Group (proof 455a1334) on 30 Jul and
// again on 7 Aug: a customer-supplied print-resolution logo PNG off the Help
// Scout thread, ~200KB on disk and enormous in pixels, killed both runs.
//
// Every size gate in this check counted BYTES (4MB per proof image, 5MB per
// attachment, pooled budgets). A flat-colour logo at print resolution is tiny
// in bytes and vast in pixels, so it sailed through all of them.
//
// So: measure pixels, and downscale what's too big rather than dropping it.
// Dropping was the cheaper fix, but on that order the logo IS the reference —
// it's the artwork the customer supplied to be matched against, so a check
// that skips it runs blind on the one thing it most needed to see.
//
// Three deliberate choices, each measured rather than assumed:
//
//   * Target 2576px on the long edge — the resolution the model actually
//     works at. The API downscales anything larger to this itself, so there
//     is no fidelity to lose, and doing it here shrinks the payload enough
//     that big images now FIT the byte budgets that used to skip them.
//
//   * Area-average (box) resampling, not nearest-neighbour. We only ever
//     downscale, and for that, averaging the source pixels covered by each
//     output pixel is the mathematically correct answer — it cannot ring or
//     overshoot. Nearest was measured against it on 1-4px strokes at a 4.7x
//     reduction: aggregate ink density looks fine (100% vs 99.8%) but the
//     worst individual pixel is off by 234/255 — a thin stroke that lands
//     between samples disappears completely. That is the failure mode this
//     check cannot afford, since small text is most of what it reads.
//     (ImageScript ships nearest-neighbour ONLY, hence resampling here and
//     using it purely as a codec.)
//
//   * Preserve the source format. Re-encoding a transparent-background PNG
//     as JPEG was measured returning rgba(0,0,0,255) — solid black. The file
//     that broke the live runs is a BLACK logo ("..._Horz_Black (Print).png"),
//     so flattening it would have handed the model a black rectangle and a
//     confidently wrong comparison. PNG in, PNG out; JPEG in, JPEG out. It
//     also keeps media_type correct with no rewiring downstream, and for
//     logo art PNG came out 5x SMALLER than the JPEG anyway (8KB vs 40KB).
//
// Fail-safe throughout: anything we cannot measure is passed through exactly
// as before (that path has worked for 310 of 312 recorded runs), and anything
// oversized we cannot resize is reported as a named skip rather than being
// sent to certainly-400 the run.

// What the model works at. Also, by construction, comfortably under the 8000px
// hard limit on every aspect ratio — scaling the LONG edge to this necessarily
// brings the short edge below it too.
export const MODEL_MAX_LONG_EDGE = 2576

// The API's hard reject. Never sent above this; asserted in the tests.
export const API_MAX_DIMENSION = 8000

// Above this we decline to decode and the caller records a named skip. An
// out-of-memory kill (WORKER_RESOURCE_LIMIT) takes down the whole run with NO
// report at all — strictly worse than a named skip, and this check gates order
// placement — so the ceiling has to be provably safe, not nominally safe.
//
// ⚠ The figure is MEASURED, not reasoned. A first pass counted copies in
// ImageScript's source, guessed ~8 bytes/pixel and set 24MP; measuring RSS
// across a real decode showed the true cost is **12-16 bytes per pixel**
// (Image.decode holds the wasm heap, the `u8.slice()` the codec returns, AND
// the Image bitmap it copies that into):
//
//     6MP -> 95MB      12MP -> 186MB      26MP -> 301MB
//
// So the original 24MP ceiling would have blown a **256MB** Edge Function cap
// (supabase.com/docs/guides/functions/limits) on its own — it was not guarding
// anything. At ~15 B/px, and leaving room for the runtime plus the print files
// and proof images already in flight, 12MP (~150-190MB) is the honest limit.
//
// Raising it needs the decode itself to get cheaper, not just a bigger number.
// Going via the codec directly (skipping Image.decode's extra copy) measured
// 8-12 B/px — a real saving, but only enough for ~12-20MP, so it does NOT
// rescue the print-resolution references that motivated this (the file that
// broke the live runs is 26.1MP, ~200MB even that way). Doing the resize
// OUTSIDE the isolate is the approach that actually scales.
export const MAX_DECODE_PIXELS = 12_000_000

export interface ImageSize {
  width: number
  height: number
}

// ── header probes ───────────────────────────────────────────────────────────
// Dimensions from the file header only — no decode, so the overwhelmingly
// common in-limit case costs a few bytes of reading and never loads the codec.
// Covers the four types the pickers admit (jpeg/png/gif/webp). Returns null
// for anything unrecognised, which the caller treats as "leave it alone".

function u16be(b: Uint8Array, i: number): number {
  return (b[i] << 8) | b[i + 1]
}
function u32be(b: Uint8Array, i: number): number {
  return ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0
}
function u16le(b: Uint8Array, i: number): number {
  return b[i] | (b[i + 1] << 8)
}

function pngSize(b: Uint8Array): ImageSize | null {
  // 8-byte signature, then the IHDR chunk: [len:4][type:4][width:4][height:4]
  if (b.length < 24) return null
  if (b[0] !== 0x89 || b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47) return null
  if (b[12] !== 0x49 || b[13] !== 0x48 || b[14] !== 0x44 || b[15] !== 0x52) return null // "IHDR"
  return { width: u32be(b, 16), height: u32be(b, 20) }
}

function gifSize(b: Uint8Array): ImageSize | null {
  // "GIF87a" / "GIF89a", then the logical screen descriptor (little-endian).
  if (b.length < 10) return null
  if (b[0] !== 0x47 || b[1] !== 0x49 || b[2] !== 0x46) return null
  return { width: u16le(b, 6), height: u16le(b, 8) }
}

function jpegSize(b: Uint8Array): ImageSize | null {
  // Walk the marker segments to a Start-Of-Frame, which carries the
  // dimensions: [FF][SOFn][len:2][precision:1][height:2][width:2].
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null
  let i = 2
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) { i++; continue } // resync over padding
    let marker = b[i + 1]
    while (marker === 0xff && i + 2 < b.length) { i++; marker = b[i + 1] } // fill bytes
    // Standalone markers carry no length field.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue }
    const len = u16be(b, i + 2)
    if (len < 2) return null
    // SOF0-3, SOF5-7, SOF9-11, SOF13-15 hold the frame size. C4 (DHT), C8
    // (JPG) and CC (DAC) sit in the same range and do not.
    const isSof = marker >= 0xc0 && marker <= 0xcf &&
      marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      if (i + 9 >= b.length) return null
      return { height: u16be(b, i + 5), width: u16be(b, i + 7) }
    }
    i += 2 + len
  }
  return null
}

function webpSize(b: Uint8Array): ImageSize | null {
  // RIFF container: "RIFF"[size:4]"WEBP", then a codec chunk.
  if (b.length < 30) return null
  if (b[0] !== 0x52 || b[1] !== 0x49 || b[2] !== 0x46 || b[3] !== 0x46) return null // "RIFF"
  if (b[8] !== 0x57 || b[9] !== 0x45 || b[10] !== 0x42 || b[11] !== 0x50) return null // "WEBP"
  const fourcc = String.fromCharCode(b[12], b[13], b[14], b[15])
  if (fourcc === 'VP8X') {
    // Extended: 24-bit little-endian canvas width-1 / height-1.
    const w = (b[24] | (b[25] << 8) | (b[26] << 16)) + 1
    const h = (b[27] | (b[28] << 8) | (b[29] << 16)) + 1
    return { width: w, height: h }
  }
  if (fourcc === 'VP8 ') {
    // Lossy: keyframe start code 9D 01 2A, then 14-bit dimensions.
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null
    return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff }
  }
  if (fourcc === 'VP8L') {
    // Lossless: signature 0x2F, then 14 bits width-1, 14 bits height-1.
    if (b[20] !== 0x2f) return null
    const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
  }
  return null
}

// ── format sniffing ─────────────────────────────────────────────────────────
// What the bytes ARE, whatever the filename claims.
//
// Every picker in this check derives an image's media type from its file
// EXTENSION, and the API validates the bytes against the media_type we send.
// So one mislabelled file 400s the ENTIRE request, taking down a run that had
// already read a dozen perfectly good images — the same all-or-nothing
// failure mode as the oversized image this module was written for.
//
// That is what happened to KT Pumps (proof 171161fc) on 10-11 Aug: a customer
// attachment on the Help Scout thread named "image.png" whose bytes are a
// JPEG. It failed all three versions of the pre-send proof check, at three
// different block positions, and would have failed every re-run forever —
// there is nothing wrong with the file, so nothing about it was going to
// change. Renaming and re-saving images is ordinary in a mail thread, so the
// filename is a hint and the header is the fact.
//
// Signatures only — deliberately independent of the size probes above, so a
// file whose dimensions we cannot parse still gets labelled correctly (that
// unmeasurable passthrough is exactly where the KT Pumps attachment went).
export function sniffImageMediaType(b: Uint8Array): string | null {
  if (
    b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
  ) return 'image/png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  // "GIF8" covers both 87a and 89a.
  if (b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif'
  if (
    b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && // "RIFF"
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 // "WEBP"
  ) return 'image/webp'
  return null
}

// Dimensions without decoding. Null = unrecognised header.
export function readImageSize(bytes: Uint8Array): ImageSize | null {
  const size = pngSize(bytes) ?? jpegSize(bytes) ?? gifSize(bytes) ?? webpSize(bytes)
  if (!size) return null
  if (!Number.isFinite(size.width) || !Number.isFinite(size.height)) return null
  if (size.width <= 0 || size.height <= 0) return null
  return size
}

// Target dimensions for an image, or null when it is already small enough.
// Scaling by the long edge keeps the aspect ratio and drags the short edge
// down with it, so one comparison covers both.
export function targetSize(size: ImageSize, maxLongEdge = MODEL_MAX_LONG_EDGE): ImageSize | null {
  const longEdge = Math.max(size.width, size.height)
  if (longEdge <= maxLongEdge) return null
  const scale = maxLongEdge / longEdge
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  }
}

// ── resampling ──────────────────────────────────────────────────────────────

// Area average over the source rectangle each destination pixel covers.
// Downscale only — callers never ask for an enlargement, and the loop bounds
// assume it (each destination pixel maps to at least one source pixel).
export function areaAverage(
  src: Uint8ClampedArray | Uint8Array,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(dw * dh * 4)
  const xRatio = sw / dw
  const yRatio = sh / dh
  for (let dy = 0; dy < dh; dy++) {
    const y0 = Math.floor(dy * yRatio)
    const y1 = Math.min(sh, Math.max(y0 + 1, Math.ceil((dy + 1) * yRatio)))
    for (let dx = 0; dx < dw; dx++) {
      const x0 = Math.floor(dx * xRatio)
      const x1 = Math.min(sw, Math.max(x0 + 1, Math.ceil((dx + 1) * xRatio)))
      let r = 0, g = 0, b = 0, a = 0, n = 0
      for (let y = y0; y < y1; y++) {
        let i = (y * sw + x0) * 4
        for (let x = x0; x < x1; x++, i += 4) {
          r += src[i]; g += src[i + 1]; b += src[i + 2]; a += src[i + 3]; n++
        }
      }
      const o = (dy * dw + dx) * 4
      out[o] = r / n
      out[o + 1] = g / n
      out[o + 2] = b / n
      out[o + 3] = a / n
    }
  }
  return out
}

// ── codec ───────────────────────────────────────────────────────────────────
// ImageScript loads per-runtime, like SheetJS in attachments.ts — but with one
// extra step, because importing it is NOT proof that it works here.
//
// Unlike zxing-wasm (which fetches its wasm over HTTP), ImageScript reads its
// codec wasm off disk with node:fs relative to its own package directory. That
// resolves under Node and under Deno's npm cache, but whether the edge runtime
// materialises a package's non-JS assets is not something to assume — and the
// failure would land at DECODE time, long after a successful import, so an
// import-only fallback chain would never fire.
//
// So each candidate is proved with a 1x1 decode before being accepted, and we
// fall through to the next on any failure. Whichever mechanism actually works
// in this runtime is the one that gets used; if none do, every oversized image
// becomes a named skip and the run still completes.
// Literal specifiers inside thunks so bundlers can still see them.

interface ImageLike {
  width: number
  height: number
  bitmap: Uint8ClampedArray
  encodeJPEG: (quality?: number) => Promise<Uint8Array>
  encode: (compression?: number) => Promise<Uint8Array>
}
interface ImageScriptLike {
  Image: {
    new (width: number, height: number): ImageLike
    decode: (data: Uint8Array) => Promise<ImageLike>
  }
}

// A 1x1 RGBA PNG, hand-built with no metadata chunks. Decoding it exercises
// the full path that matters: module resolution AND the wasm actually loading.
const PROBE_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01,
  0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
  0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00,
  0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4,
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
])

// npm first (pinned to the version the test harness verifies), then the
// Deno-native build which fetches its wasm over HTTPS like zxing-wasm does,
// then the bare package for the Node test harness.
const CODEC_CANDIDATES: Array<[string, () => Promise<unknown>]> = [
  ['npm:imagescript@1.3.0', () => import('npm:imagescript@1.3.0')],
  ['deno.land/x/imagescript@1.2.17', () => import('https://deno.land/x/imagescript@1.2.17/mod.ts')],
  ['imagescript', () => import('imagescript')],
]

let codecModule: ImageScriptLike | null | undefined
async function loadCodec(): Promise<ImageScriptLike | null> {
  if (codecModule !== undefined) return codecModule
  for (const [label, load] of CODEC_CANDIDATES) {
    try {
      const mod = (await load()) as unknown as ImageScriptLike
      const probe = await mod.Image.decode(PROBE_PNG)
      if (probe.width !== 1 || probe.height !== 1) continue
      codecModule = mod
      return codecModule
    } catch (err) {
      console.log(`[artwork-check] image codec ${label} unusable here: ${(err as Error)?.message}`)
    }
  }
  codecModule = null
  console.error('[artwork-check] no image codec available — oversized images will be skipped')
  return codecModule
}

// ImageScript decodes PNG, JPEG and TIFF. GIF and WebP are measurable (so we
// can decline to send them) but not resizable here; they are vanishingly rare
// as oversized print references, and the caller names the skip.
function isResizableType(mediaType: string): boolean {
  return mediaType === 'image/png' || mediaType === 'image/jpeg'
}

export type FitResult =
  | {
    ok: true
    bytes: Uint8Array
    // The media_type the caller must send. Sniffed from the bytes, so it can
    // differ from the one passed in — see sniffImageMediaType.
    mediaType: string
    resizedFrom: ImageSize | null
    size: ImageSize | null
  }
  | { ok: false; reason: string }

// Make one image safe to send. Returns the original bytes untouched unless a
// downscale is genuinely needed.
//
// This is the single choke point every image block in the check passes
// through, which is why the media-type correction lives here rather than in
// each of the four pickers that guess a type from a file extension. Callers
// must label the block with the returned `mediaType`, not the one they passed.
export async function fitImageForModel(bytes: Uint8Array, mediaType: string): Promise<FitResult> {
  // The filename lied if these disagree, and the bytes win. Everything below
  // follows what the file actually is: the resizable-format gate, the format
  // it is re-encoded to, and the media_type the caller sends.
  const realType = sniffImageMediaType(bytes) ?? mediaType
  const size = readImageSize(bytes)

  // Unmeasurable: pass through exactly as before. We have no evidence it's a
  // problem, and this is the path 310 of 312 recorded runs took successfully.
  if (!size) return { ok: true, bytes, mediaType: realType, resizedFrom: null, size: null }

  const target = targetSize(size)
  if (!target) return { ok: true, bytes, mediaType: realType, resizedFrom: null, size }

  const dimensions = `${size.width}x${size.height}px`

  if (!isResizableType(realType)) {
    return { ok: false, reason: `too large to send (${dimensions}) and not a resizable format` }
  }
  if (size.width * size.height > MAX_DECODE_PIXELS) {
    return { ok: false, reason: `too large to process (${dimensions})` }
  }

  const codec = await loadCodec()
  if (!codec) return { ok: false, reason: `too large to send (${dimensions})` }

  try {
    const decoded = await codec.Image.decode(bytes)
    // Trust the codec's dimensions over the header for the actual resample —
    // a header that disagrees with the pixels would otherwise corrupt the
    // output. Re-derive the target from what we really got.
    const realSize = { width: decoded.width, height: decoded.height }
    const realTarget = targetSize(realSize)
    if (!realTarget) return { ok: true, bytes, mediaType: realType, resizedFrom: null, size: realSize }

    const resampled = areaAverage(
      decoded.bitmap,
      realSize.width,
      realSize.height,
      realTarget.width,
      realTarget.height,
    )
    const out = new codec.Image(realTarget.width, realTarget.height)
    out.bitmap.set(resampled)
    // Same format in, same format out — see the transparency note at the top.
    // Keyed on the SNIFFED type, so a JPEG named .png is re-encoded as a JPEG
    // and labelled as one, rather than being handed to the PNG encoder on the
    // strength of its filename.
    const encoded = realType === 'image/png' ? await out.encode(1) : await out.encodeJPEG(88)
    return { ok: true, bytes: encoded, mediaType: realType, resizedFrom: realSize, size: realTarget }
  } catch (err) {
    console.error('[artwork-check] resize failed:', (err as Error)?.message)
    return { ok: false, reason: `too large to send (${dimensions})` }
  }
}
