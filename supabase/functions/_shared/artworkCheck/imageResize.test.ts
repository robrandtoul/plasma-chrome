// Tests for imageResize.ts — the fix for the 8000px hard reject that killed
// two live artwork-check runs on The Experience Auto Group.
//
// Covers the pure logic (header probes, target maths, resampler) AND the real
// codec round-trip, since ImageScript is a repo dependency the Node harness
// can import bare — the same dual-runtime arrangement attachments.ts uses for
// SheetJS. The version here is pinned to the one the npm: specifier names, so
// what this harness verifies is what the edge runtime actually runs.
//
// Run: npx tsx supabase/functions/_shared/artworkCheck/imageResize.test.ts
// (hand-rolled harness convention, as artworkCheck.test.ts; exits 1 on failure.)

import { Image } from 'imagescript'
import {
  API_MAX_DIMENSION,
  areaAverage,
  fitImageForModel,
  MAX_DECODE_PIXELS,
  MODEL_MAX_LONG_EDGE,
  readImageSize,
  targetSize,
} from './imageResize.ts'

let failures = 0
let passes = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passes++; console.log(`  ok  ${name}`) } else {
    failures++
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
function eq<T>(name: string, actual: T, expected: T) {
  check(name, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`)
}

// ── header probes ────────────────────────────────────────────────────────────

console.log('\nheader probes')
{
  const png = await new Image(321, 123).encode(1)
  const size = readImageSize(png)
  eq('PNG width', size?.width, 321)
  eq('PNG height', size?.height, 123)

  const jpeg = await new Image(640, 480).encodeJPEG(80)
  const jsize = readImageSize(jpeg)
  eq('JPEG width', jsize?.width, 640)
  eq('JPEG height', jsize?.height, 480)

  // GIF logical screen descriptor, little-endian.
  const gif = new Uint8Array(12)
  gif.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0) // "GIF89a"
  gif[6] = 0x20; gif[7] = 0x03 // 800
  gif[8] = 0x58; gif[9] = 0x02 // 600
  const gsize = readImageSize(gif)
  eq('GIF width', gsize?.width, 800)
  eq('GIF height', gsize?.height, 600)

  // WebP VP8X: 24-bit little-endian canvas dimensions, stored minus one.
  const webp = new Uint8Array(32)
  webp.set([0x52, 0x49, 0x46, 0x46], 0) // "RIFF"
  webp.set([0x57, 0x45, 0x42, 0x50], 8) // "WEBP"
  webp.set([0x56, 0x50, 0x38, 0x58], 12) // "VP8X"
  webp[24] = 0x0f; webp[25] = 0x27; webp[26] = 0x00 // 9999 -> 10000
  webp[27] = 0xe7; webp[28] = 0x03; webp[29] = 0x00 // 999  -> 1000
  const wsize = readImageSize(webp)
  eq('WebP VP8X width', wsize?.width, 10000)
  eq('WebP VP8X height', wsize?.height, 1000)

  check('unrecognised bytes measure as null', readImageSize(new Uint8Array([1, 2, 3, 4, 5])) === null)
  check('empty bytes measure as null', readImageSize(new Uint8Array(0)) === null)
}

// ── target maths ─────────────────────────────────────────────────────────────

console.log('\ntarget maths')
{
  check('in-limit image needs no resize', targetSize({ width: 2000, height: 1000 }) === null)
  check('exactly at the limit needs no resize', targetSize({ width: MODEL_MAX_LONG_EDGE, height: 10 }) === null)

  const wide = targetSize({ width: 12000, height: 3000 })
  eq('wide image scales by its long edge', wide?.width, MODEL_MAX_LONG_EDGE)
  eq('wide image keeps aspect ratio', wide?.height, Math.round(3000 * (MODEL_MAX_LONG_EDGE / 12000)))

  const tall = targetSize({ width: 2500, height: 9000 })
  eq('tall image scales by its long edge', tall?.height, MODEL_MAX_LONG_EDGE)

  // The invariant the whole fix rests on: whatever we send is under the API's
  // hard reject, at any aspect ratio, including degenerate ones.
  const shapes = [
    { width: 40000, height: 1 }, { width: 1, height: 40000 },
    { width: 9000, height: 9000 }, { width: 8001, height: 8001 },
    { width: 20000, height: 3 }, { width: 12000, height: 3000 },
  ]
  let allSafe = true
  for (const s of shapes) {
    const t = targetSize(s) ?? s
    if (t.width > API_MAX_DIMENSION || t.height > API_MAX_DIMENSION) allSafe = false
    if (t.width < 1 || t.height < 1) allSafe = false
  }
  check('every shape lands under the API hard limit, and stays >= 1px', allSafe)
}

// ── resampler ────────────────────────────────────────────────────────────────

console.log('\nresampler')
{
  // 2x2 red channel [0, 100 / 200, 100] -> one pixel averaging exactly 100.
  const src = new Uint8ClampedArray(2 * 2 * 4)
  const setPx = (b: Uint8ClampedArray, i: number, v: number) => {
    b[i * 4] = v; b[i * 4 + 1] = v; b[i * 4 + 2] = v; b[i * 4 + 3] = 255
  }
  setPx(src, 0, 0); setPx(src, 1, 100); setPx(src, 2, 200); setPx(src, 3, 100)
  const one = areaAverage(src, 2, 2, 1, 1)
  eq('area average of 0/100/200/100 is 100', one[0], 100)
  eq('alpha averages too', one[3], 255)

  // A solid field must not drift — every output pixel is the input colour.
  const solid = new Uint8ClampedArray(8 * 8 * 4).fill(77)
  const half = areaAverage(solid, 8, 8, 4, 4)
  check('solid colour survives downscaling unchanged', half.every((v) => v === 77))

  // Ink is conserved: a half-black / half-white field averages to mid grey
  // rather than snapping to one side (the nearest-neighbour failure).
  const split = new Uint8ClampedArray(4 * 1 * 4)
  for (let i = 0; i < 4; i++) setPx(split, i, i < 2 ? 0 : 255)
  const merged = areaAverage(split, 4, 1, 1, 1)
  check('half-black/half-white averages to mid grey', merged[0] >= 126 && merged[0] <= 129, `got ${merged[0]}`)
}

// ── fitImageForModel: the real round trip ────────────────────────────────────

console.log('\nfitting real images')
{
  // In-limit images come back byte-identical and untouched.
  const small = await new Image(800, 600).encode(1)
  const smallFit = await fitImageForModel(small, 'image/png')
  check('in-limit image is passed through', smallFit.ok === true && smallFit.bytes === small)
  check('in-limit image reports no resize', smallFit.ok === true && smallFit.resizedFrom === null)

  // Reaching a working codec at all proves the candidate chain falls through:
  // under Node the npm: and https: specifiers cannot resolve, so every
  // real-image assertion below is also evidence the third candidate was tried
  // and probed. In the edge runtime the same mechanism picks whichever of the
  // three actually decodes there.
  const chainWorks = await fitImageForModel(await new Image(4000, 100).encode(1), 'image/png')
  check('the codec candidate chain reaches a working codec', chainWorks.ok === true && chainWorks.resizedFrom !== null)

  // Oversized JPEG: comes back within limits and still decodable.
  const bigJpeg = await new Image(9000, 300).encodeJPEG(85)
  check('the oversized JPEG really is over the limit', (readImageSize(bigJpeg)?.width ?? 0) > MODEL_MAX_LONG_EDGE)
  const jpegFit = await fitImageForModel(bigJpeg, 'image/jpeg')
  check('oversized JPEG is fitted', jpegFit.ok === true)
  if (jpegFit.ok) {
    eq('fitted JPEG long edge', jpegFit.size?.width, MODEL_MAX_LONG_EDGE)
    eq('fitted JPEG records its original size', jpegFit.resizedFrom?.width, 9000)
    const back = await Image.decode(jpegFit.bytes)
    eq('fitted JPEG re-decodes at the new width', back.width, MODEL_MAX_LONG_EDGE)
    check('fitted JPEG is under the API hard limit', back.width <= API_MAX_DIMENSION && back.height <= API_MAX_DIMENSION)
  }

  // THE load-bearing case: a black logo on a transparent background — the
  // shape of the file that broke both live runs. Re-encoding to JPEG turns
  // transparent pixels solid black, which would hand the model a black
  // rectangle and a confidently wrong comparison. PNG in must mean PNG out.
  const logo = new Image(9000, 1200)
  logo.fill(0x00000000)
  for (let x = 400; x < 3000; x++) for (let y = 300; y < 900; y++) logo.setPixelAt(x + 1, y + 1, 0x000000ff)
  const logoBytes = await logo.encode(1)
  const logoFit = await fitImageForModel(logoBytes, 'image/png')
  check('oversized transparent PNG is fitted', logoFit.ok === true)
  if (logoFit.ok) {
    const back = await Image.decode(logoFit.bytes)
    eq('fitted logo long edge', back.width, MODEL_MAX_LONG_EDGE)
    // A corner that was transparent in the source must still be transparent.
    const cornerAlpha = back.bitmap[((5 * back.width) + (back.width - 5)) * 4 + 3]
    eq('transparency survives the resize (not flattened to black)', cornerAlpha, 0)
    // And the ink is still there — the logo did not vanish.
    let opaque = 0
    for (let i = 3; i < back.bitmap.length; i += 4) if (back.bitmap[i] > 200) opaque++
    check('the logo artwork survives', opaque > 0, `${opaque} opaque pixels`)
  }

  // Beyond the decode ceiling: declined by header alone, nothing allocated.
  const hugeHeader = new Uint8Array(32)
  hugeHeader.set([0x89, 0x50, 0x4e, 0x47], 0)
  hugeHeader.set([0x49, 0x48, 0x44, 0x52], 12) // "IHDR"
  const putU32 = (b: Uint8Array, i: number, v: number) => {
    b[i] = (v >>> 24) & 255; b[i + 1] = (v >>> 16) & 255; b[i + 2] = (v >>> 8) & 255; b[i + 3] = v & 255
  }
  putU32(hugeHeader, 16, 20000)
  putU32(hugeHeader, 20, 20000) // 400MP — far past the ceiling
  check('a 400MP image measures', (readImageSize(hugeHeader)?.width ?? 0) === 20000)
  check('decode ceiling is below it', 20000 * 20000 > MAX_DECODE_PIXELS)

  // The ceiling is a memory budget, not a taste. Measured cost of a decode is
  // 12-16 bytes/pixel (RSS across a real decode; Image.decode holds the wasm
  // heap, the codec's returned slice, AND the Image bitmap). Edge Functions cap
  // at 256MB total, so the decode itself must leave room for the runtime and
  // for the print files / proof images already in flight. This guards the
  // number against creeping back up without the arithmetic being redone —
  // an earlier 24MP would have needed ~360MB and could not have held.
  const WORST_BYTES_PER_PIXEL = 15
  const RUNTIME_AND_INFLIGHT_MB = 60
  const EDGE_FUNCTION_CAP_MB = 256
  const decodeMb = (MAX_DECODE_PIXELS * WORST_BYTES_PER_PIXEL) / 1024 / 1024
  check(
    'decode ceiling fits the 256MB Edge Function cap with headroom',
    decodeMb + RUNTIME_AND_INFLIGHT_MB < EDGE_FUNCTION_CAP_MB,
    `${decodeMb.toFixed(0)}MB decode + ${RUNTIME_AND_INFLIGHT_MB}MB in flight >= ${EDGE_FUNCTION_CAP_MB}MB`,
  )
  check(
    'decode ceiling is still worth having (not so low nothing resizes)',
    MAX_DECODE_PIXELS >= 8_000_000,
  )
  const hugeFit = await fitImageForModel(hugeHeader, 'image/png')
  check('past the decode ceiling is a named skip, not a crash', hugeFit.ok === false)
  check('and the skip reason names the size', hugeFit.ok === false && hugeFit.reason.includes('20000x20000'))

  // Oversized but unresizable format: named skip rather than a certain 400.
  const bigWebp = new Uint8Array(32)
  bigWebp.set([0x52, 0x49, 0x46, 0x46], 0)
  bigWebp.set([0x57, 0x45, 0x42, 0x50], 8)
  bigWebp.set([0x56, 0x50, 0x38, 0x58], 12)
  bigWebp[24] = 0x0f; bigWebp[25] = 0x27; bigWebp[26] = 0x00 // 10000 wide
  bigWebp[27] = 0xe7; bigWebp[28] = 0x03; bigWebp[29] = 0x00 // 1000 tall
  const webpFit = await fitImageForModel(bigWebp, 'image/webp')
  check('oversized non-resizable format is a named skip', webpFit.ok === false)

  // Unmeasurable bytes keep today's behaviour exactly: passed straight through.
  const junk = new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9])
  const junkFit = await fitImageForModel(junk, 'image/png')
  check('unmeasurable bytes pass through untouched', junkFit.ok === true && junkFit.bytes === junk)
}

// ── summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passes} passed, ${failures} failed`)
if (failures > 0) process.exit(1)
