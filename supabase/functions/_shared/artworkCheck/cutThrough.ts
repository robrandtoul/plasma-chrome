// Cut-through dropout detection — "will a piece of metal fall out?"
//
// On metal, customers often ask for words and shapes to be cut clean THROUGH
// the card. Cutting a letter with a closed counter ('O', 'e', 'P', '@', or any
// closed logo shape) frees the middle, so the studio leaves a small break in
// the cut path — a STRUT — tying that middle back to the card body. Forget one
// and the piece drops out at the supplier. That happened on Skyfall 403813:
// every swirl, bar and the crossbar of the '4' was strutted, and the bowl of
// the 'P' in "P4:13" was not.
//
// The framing that makes this decidable: we do NOT try to recognise letters or
// judge whether a strut "looks right". After cutting, the card is a 2D region;
// flood the metal inwards from the trim edge and anything the flood never
// reaches is, by definition, a piece that falls out. No letter list, no
// threshold to tune, and a correctly-strutted letter yields nothing at all.
// Same principle as qrDecode.ts: compute the answer, hand it to the model as
// evidence, rather than asking it to eyeball a 0.4 mm detail.
//
// Telling a cut from printed white is the other half. Both are CMYK 0,0,0,0 in
// the artwork, so colour alone fires on white QR codes and white phone numbers
// (measured: 3 of 20 real files). The discriminator is Rob's rule, confirmed
// against live files and stated by him as ALWAYS true: artwork cut through
// from the front necessarily reads mirrored on the back. So each white region
// is matched against the mirrored other side — matched means cut, unmatched
// means printed. Per-region rather than whole-page, because one face can carry
// both a cut logo and printed white text.
//
// Fail LOUD. Every path that cannot complete returns 'cannot_check' with a
// reason. A silent "no islands found" that really meant "couldn't read the
// file" is worse than no check at all — it reads as a clean bill of health.

export interface CutPoint {
  x: number
  y: number
}

export type SubPath = CutPoint[]

export interface FilledShape {
  /** Fill colour as a canonical string, e.g. 'cmyk:0,0,0,0'. Null if unset. */
  fill: string | null
  subpaths: SubPath[]
  /** True for f* (even-odd); false for f (nonzero winding). */
  evenOdd: boolean
}

export interface Box {
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface Island {
  /** Area of the free-floating piece. */
  areaPt2: number
  areaMm2: number
  /** Bounding box on the card, in points from the trim corner. */
  x: number
  y: number
  widthPt: number
  heightPt: number
}

export type FaceStatus =
  /** Cut-through artwork found and every piece stays attached. */
  | 'clean'
  /** One or more pieces would fall out. */
  | 'dropout'
  /** No cut-through artwork on this card — nothing to check. Not a problem. */
  | 'no_cut_artwork'
  /**
   * Pieces WOULD come loose if the white on this card is cut through, but
   * there is no opposite face to confirm that it is. Worth a human glance;
   * not the same claim as 'dropout'.
   */
  | 'possible_dropout'
  /** Something stopped us checking. NEVER conflate with clean. */
  | 'cannot_check'

export interface FaceResult {
  status: FaceStatus
  islands: Island[]
  /** Plain-English reason, always set for cannot_check. */
  reason?: string
  /** Diagnostics for the batch report / a human reading the result. */
  cutRegions: number
  printedWhiteRegions: number
  /** Share of all white AREA on this face that mirrored (0–1). */
  mirroredAreaShare: number
  cardWidthPt: number
  cardHeightPt: number
}

// The white paint is CMYK 0,0,0,0 — no ink. Every cut-through in the sample
// used exactly this, and it is also what a white PRINT uses, which is why the
// mirror match below is load-bearing rather than decorative.
export const CUT_FILL = 'cmyk:0,0,0,0'

// 8 px/pt ≈ 576 dpi. Real struts measured 0.4–1.2 mm (1.1–3.4 pt), so the
// narrowest genuine strut is ~9 px across — an order of magnitude above the
// single pixel at which a strut would vanish and cause a false alarm.
export const RASTER_SCALE = 8

// Below this, an "island" is rasteriser noise where two paths meet, not a
// piece of metal (a 0.02 pt² speck showed up on one real file). The smallest
// plausible real counter is comfortably larger.
export const MIN_ISLAND_PT2 = 0.5

// A white region counts as CUT when it and its mirrored counterpart cover
// EACH OTHER by at least this much. The match must be reciprocal: measuring
// only "how much of this region sits on back-white" lets any small shape that
// happens to land inside a bigger one on the other side score a perfect 1.0.
// That produced a real false alarm on a printed-white quotation card, where
// the 'o' of "develop" fell on a larger mirrored letter and its counter was
// reported as a dropout. A genuine cut matches near-exactly both ways —
// measured 0.88–0.98 on real cut-through pairs — so a reciprocal test costs
// no true positives and removes the coincidences.
export const MIRROR_MATCH_MIN = 0.6

// Reciprocal shape matching is still not enough on its own. In mirrored
// monospaced text an 'o' lands exactly on another 'o' — same shape, same size,
// so the match is genuinely reciprocal and yet the letter is printed, not cut
// (found on a NATO-alphabet card: 3 coincidental matches among 335 letters).
//
// What separates them is the NEIGHBOURHOOD. A real cut mirrors together with
// everything around it, because the whole cut layer is the same geometry on
// both faces. A coincidental glyph match sits among different letters, so the
// area immediately around it does not agree at all. So each candidate is
// re-tested over a window around itself, and must still agree there.
//
// Deliberately local rather than a whole-face rule: a card can legitimately
// carry a small cut logo alongside a lot of printed white type, and a global
// "most of the white must mirror" test would throw that real cut away.
export const LOCAL_AGREEMENT_MIN = 0.5

// How far around a region to look, as a multiple of its own size, with a floor
// so tiny regions still get a meaningful window (a 3 pt letter needs to see
// its neighbours, not just itself).
export const LOCAL_WINDOW_FACTOR = 1
export const LOCAL_WINDOW_MIN_PT = 6

const PT2_TO_MM2 = (25.4 / 72) * (25.4 / 72)

// ── PDF reading ────────────────────────────────────────────────────────────
// Every .ai the studio produces is really a PDF (Illustrator saves with PDF
// compatibility; printFiles.ts already relies on this). The page content is a
// single Flate stream of a few KB — the 800 KB file size is almost entirely
// Illustrator's own private round-trip data, which we ignore.

export interface Inflated {
  data: Uint8Array
  /** False when the stream ended early or failed its checksum. */
  complete: boolean
}

async function inflate(bytes: Uint8Array): Promise<Inflated | null> {
  // DecompressionStream is available in both Deno (edge runtime) and Node 18+,
  // so this same module can move into the edge function unchanged.
  //
  // Most streams in these files are NOT deflate (Illustrator's private data,
  // embedded images), so failure is the common path, not the exception. Both
  // the write side and the read side reject on bad data and BOTH must be
  // swallowed here — an unattached rejection on the writer takes the whole
  // process down rather than falling through to the next candidate.
  let best: Inflated | null = null
  for (const format of ['deflate', 'deflate-raw'] as const) {
    const chunks: Uint8Array[] = []
    let complete = false
    try {
      const ds = new DecompressionStream(format)
      const writer = ds.writable.getWriter()
      const pumped = writer
        .write(bytes as unknown as BufferSource)
        .then(() => writer.close())
        .catch(() => {})
      const reader = ds.readable.getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (value) chunks.push(value as Uint8Array)
        }
        complete = true
      } finally {
        await pumped
      }
    } catch {
      // A stream can end early or fail its checksum and STILL have yielded
      // most of its content. Observed on a real print file (403828) whose page
      // content inflated to 36 KB of perfectly good path data before erroring:
      // discarding that would have made a readable card look unreadable. Keep
      // what came out, and let the caller know it is partial.
    }
    let total = 0
    for (const c of chunks) total += c.length
    if (total === 0) continue
    const out = new Uint8Array(total)
    let at = 0
    for (const c of chunks) {
      out.set(c, at)
      at += c.length
    }
    const got: Inflated = { data: out, complete }
    if (complete) return got
    if (!best || out.length > best.data.length) best = got
  }
  return best
}

function indexOfSeq(hay: Uint8Array, needle: number[], from: number): number {
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer
    return i
  }
  return -1
}

const STREAM = [0x73, 0x74, 0x72, 0x65, 0x61, 0x6d] // "stream"
const ENDSTREAM = [0x65, 0x6e, 0x64, 0x73, 0x74, 0x72, 0x65, 0x61, 0x6d] // "endstream"

/**
 * Pull every inflatable stream out of the file.
 *
 * We deliberately do NOT pick "the longest stream that looks like paths" — an
 * embedded image inflates to megabytes that coincidentally contain the bytes
 * 'f', 're' and 'l', which is exactly how the prototype silently read a card
 * as having no artwork at all. The caller parses each candidate and keeps
 * whichever actually yields the most filled shapes.
 */
export async function extractStreams(bytes: Uint8Array, maxCandidates = 40): Promise<Inflated[]> {
  const out: Inflated[] = []
  let at = 0
  while (out.length < maxCandidates) {
    const s = indexOfSeq(bytes, STREAM, at)
    if (s < 0) break
    let start = s + STREAM.length
    if (bytes[start] === 0x0d) start++
    if (bytes[start] === 0x0a) start++
    const e = indexOfSeq(bytes, ENDSTREAM, start)
    if (e < 0) break
    let end = e
    while (end > start && (bytes[end - 1] === 0x0a || bytes[end - 1] === 0x0d)) end--
    const raw = bytes.subarray(start, end)
    // Skip the giant ones outright: page content on these files is < 200 KB,
    // and an 8 MB image stream is only ever a decode cost.
    if (raw.length > 0 && raw.length < 4_000_000) {
      const inf = await inflate(raw)
      if (inf) out.push(inf)
    }
    at = e + ENDSTREAM.length
  }
  return out
}

/** Read the trim/art box straight out of the page dictionary (uncompressed). */
export function readArtBox(bytes: Uint8Array): Box | null {
  // Scan the whole file: on a large .ai the page dictionary sits well past any
  // fixed window (observed at 432 KB into an 851 KB file), and a missed trim
  // box silently downgrades us to guessing the card from the biggest shape.
  const head = new TextDecoder('latin1').decode(bytes)
  for (const key of ['ArtBox', 'TrimBox', 'MediaBox']) {
    const m = head.match(new RegExp('/' + key + '\\s*\\[\\s*([-\\d.]+)\\s+([-\\d.]+)\\s+([-\\d.]+)\\s+([-\\d.]+)'))
    if (!m) continue
    const x0 = parseFloat(m[1]), y0 = parseFloat(m[2]), x1 = parseFloat(m[3]), y1 = parseFloat(m[4])
    if (!isFinite(x0) || !isFinite(y0) || !isFinite(x1) || !isFinite(y1)) continue
    if (x1 - x0 < 10 || y1 - y0 < 10) continue
    return { x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) }
  }
  return null
}

// ── Content-stream parsing ─────────────────────────────────────────────────
// Only what these files actually use: the graphics state stack, the current
// transform, CMYK/gray/RGB fills, and path construction. All type is outlined,
// so there is no text to handle.

type Matrix = [number, number, number, number, number, number]

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

function mul(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ]
}

function applyM(m: Matrix, x: number, y: number): CutPoint {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] }
}

function bezier(p0: CutPoint, p1: CutPoint, p2: CutPoint, p3: CutPoint, n = 12): CutPoint[] {
  const out: CutPoint[] = []
  for (let i = 1; i <= n; i++) {
    const t = i / n
    const u = 1 - t
    out.push({
      x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
      y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
    })
  }
  return out
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000
}

/** Parse a content stream into filled shapes in device (page) coordinates. */
export function parseContentStream(src: Uint8Array | string): FilledShape[] {
  const text = typeof src === 'string' ? src : new TextDecoder('latin1').decode(src)
  const tokens = text.match(/(\/[^\s/[\]<>()]+|<<|>>|\[|\]|[-+]?[\d.]+|[A-Za-z'"*]+)/g) ?? []

  const shapes: FilledShape[] = []
  const stack: { ctm: Matrix; fill: string | null }[] = []
  let ctm: Matrix = IDENTITY
  let fill: string | null = null
  let operands: number[] = []
  let cur: SubPath = []
  let subs: SubPath[] = []
  let pos: CutPoint | null = null
  let startPt: CutPoint | null = null

  const flushSub = () => {
    if (cur.length > 1) subs.push(cur)
    cur = []
  }

  for (const tok of tokens) {
    const num = Number(tok)
    if (!Number.isNaN(num) && /^[-+.\d]/.test(tok)) {
      operands.push(num)
      continue
    }
    const n = operands.length
    switch (tok) {
      case 'q':
        stack.push({ ctm, fill })
        break
      case 'Q': {
        const s = stack.pop()
        if (s) {
          ctm = s.ctm
          fill = s.fill
        }
        break
      }
      case 'cm':
        if (n >= 6) ctm = mul(operands.slice(n - 6) as Matrix, ctm)
        break
      case 'k':
        if (n >= 4) fill = 'cmyk:' + operands.slice(n - 4).map(round4).join(',')
        break
      case 'g':
        if (n >= 1) fill = 'gray:' + round4(operands[n - 1])
        break
      case 'rg':
        if (n >= 3) fill = 'rgb:' + operands.slice(n - 3).map(round4).join(',')
        break
      case 'sc':
      case 'scn':
        // Spot / ICC colour — not the flat white we care about, but it must
        // clear the fill so a stale CMYK white cannot leak onto this shape.
        fill = 'other'
        break
      case 'm':
        if (n >= 2) {
          flushSub()
          pos = applyM(ctm, operands[n - 2], operands[n - 1])
          startPt = pos
          cur = [pos]
        }
        break
      case 'l':
        if (n >= 2 && cur.length) {
          pos = applyM(ctm, operands[n - 2], operands[n - 1])
          cur.push(pos)
        }
        break
      case 'c':
        if (n >= 6 && pos) {
          const p1 = applyM(ctm, operands[n - 6], operands[n - 5])
          const p2 = applyM(ctm, operands[n - 4], operands[n - 3])
          const p3 = applyM(ctm, operands[n - 2], operands[n - 1])
          cur.push(...bezier(pos, p1, p2, p3))
          pos = p3
        }
        break
      case 'v':
        if (n >= 4 && pos) {
          const p2 = applyM(ctm, operands[n - 4], operands[n - 3])
          const p3 = applyM(ctm, operands[n - 2], operands[n - 1])
          cur.push(...bezier(pos, pos, p2, p3))
          pos = p3
        }
        break
      case 'y':
        if (n >= 4 && pos) {
          const p1 = applyM(ctm, operands[n - 4], operands[n - 3])
          const p3 = applyM(ctm, operands[n - 2], operands[n - 1])
          cur.push(...bezier(pos, p1, p3, p3))
          pos = p3
        }
        break
      case 'h':
        if (cur.length && startPt) cur.push(startPt)
        break
      case 're':
        if (n >= 4) {
          const [x, y, w, h] = operands.slice(n - 4)
          flushSub()
          subs.push([
            applyM(ctm, x, y),
            applyM(ctm, x + w, y),
            applyM(ctm, x + w, y + h),
            applyM(ctm, x, y + h),
            applyM(ctm, x, y),
          ])
          pos = null
          startPt = null
        }
        break
      case 'f':
      case 'F':
      case 'f*':
      case 'b':
      case 'b*':
      case 'B':
      case 'B*':
        flushSub()
        if (subs.length) shapes.push({ fill, subpaths: subs, evenOdd: tok.endsWith('*') })
        subs = []
        pos = null
        startPt = null
        break
      case 'n':
      case 's':
      case 'S':
        flushSub()
        subs = []
        pos = null
        startPt = null
        break
      default:
        break
    }
    operands = []
  }
  return shapes
}

export function boxOf(pts: SubPath): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const p of pts) {
    if (p.x < x0) x0 = p.x
    if (p.x > x1) x1 = p.x
    if (p.y < y0) y0 = p.y
    if (p.y > y1) y1 = p.y
  }
  return { x0, y0, x1, y1 }
}

function boxArea(b: Box): number {
  return Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0)
}

// ── Rasterising ────────────────────────────────────────────────────────────

export interface Grid {
  w: number
  h: number
  /** 1 where the subpaths cover the pixel. */
  data: Uint8Array
}

/**
 * Scanline fill of a set of closed subpaths, honouring the winding rule.
 * Hard-thresholded (no antialiasing) on purpose: a soft edge is exactly what
 * would let a counter "leak" into the body and hide a real dropout.
 */
export function rasterise(
  subpaths: SubPath[],
  w: number,
  h: number,
  scale: number,
  ox: number,
  oy: number,
  evenOdd = false,
): Grid {
  const data = new Uint8Array(w * h)
  const ex: number[] = []
  const ey: number[] = []
  const ex2: number[] = []
  const ey2: number[] = []
  for (const s of subpaths) {
    if (s.length < 2) continue
    const pts = s[0].x === s[s.length - 1].x && s[0].y === s[s.length - 1].y ? s : [...s, s[0]]
    for (let i = 0; i < pts.length - 1; i++) {
      const ax = (pts[i].x - ox) * scale
      const ay = (pts[i].y - oy) * scale
      const bx = (pts[i + 1].x - ox) * scale
      const by = (pts[i + 1].y - oy) * scale
      if (ay === by) continue
      ex.push(ax); ey.push(ay); ex2.push(bx); ey2.push(by)
    }
  }
  const xs: number[] = []
  const dirs: number[] = []
  for (let py = 0; py < h; py++) {
    const yc = py + 0.5
    xs.length = 0
    dirs.length = 0
    for (let i = 0; i < ex.length; i++) {
      const y1 = ey[i], y2 = ey2[i]
      if ((y1 <= yc && yc < y2) || (y2 <= yc && yc < y1)) {
        const t = (yc - y1) / (y2 - y1)
        xs.push(ex[i] + t * (ex2[i] - ex[i]))
        dirs.push(y2 > y1 ? 1 : -1)
      }
    }
    if (!xs.length) continue
    const order = xs.map((_, i) => i).sort((a, b) => xs[a] - xs[b])
    let wind = 0
    let spanStart = 0
    for (let k = 0; k < order.length; k++) {
      const i = order[k]
      const prevInside = evenOdd ? (wind & 1) !== 0 : wind !== 0
      wind += evenOdd ? 1 : dirs[i]
      const nowInside = evenOdd ? (wind & 1) !== 0 : wind !== 0
      if (!prevInside && nowInside) spanStart = xs[i]
      else if (prevInside && !nowInside) {
        const a = Math.max(0, Math.floor(spanStart))
        const b = Math.min(w, Math.floor(xs[i]) + 1)
        const row = py * w
        for (let px = a; px < b; px++) data[row + px] = 1
      }
    }
  }
  return { w, h, data }
}

/** Label 4-connected components of pixels equal to `value`. */
export function components(grid: Grid, value: 0 | 1): { pixels: number[] }[] {
  const { w, h, data } = grid
  const seen = new Uint8Array(w * h)
  const out: { pixels: number[] }[] = []
  const stack: number[] = []
  for (let i = 0; i < data.length; i++) {
    if (seen[i] || data[i] !== value) continue
    const comp: number[] = []
    stack.length = 0
    stack.push(i)
    seen[i] = 1
    while (stack.length) {
      const k = stack.pop() as number
      comp.push(k)
      const x = k % w
      const y = (k / w) | 0
      if (x > 0) { const j = k - 1; if (!seen[j] && data[j] === value) { seen[j] = 1; stack.push(j) } }
      if (x < w - 1) { const j = k + 1; if (!seen[j] && data[j] === value) { seen[j] = 1; stack.push(j) } }
      if (y > 0) { const j = k - w; if (!seen[j] && data[j] === value) { seen[j] = 1; stack.push(j) } }
      if (y < h - 1) { const j = k + w; if (!seen[j] && data[j] === value) { seen[j] = 1; stack.push(j) } }
    }
    out.push({ pixels: comp })
  }
  return out
}

/** Mark every pixel of `value` reachable from the grid border. */
export function reachableFromBorder(grid: Grid, value: 0 | 1): Uint8Array {
  const { w, h, data } = grid
  const seen = new Uint8Array(w * h)
  const stack: number[] = []
  const push = (i: number) => {
    if (!seen[i] && data[i] === value) {
      seen[i] = 1
      stack.push(i)
    }
  }
  for (let x = 0; x < w; x++) {
    push(x)
    push((h - 1) * w + x)
  }
  for (let y = 0; y < h; y++) {
    push(y * w)
    push(y * w + w - 1)
  }
  while (stack.length) {
    const k = stack.pop() as number
    const x = k % w
    const y = (k / w) | 0
    if (x > 0) push(k - 1)
    if (x < w - 1) push(k + 1)
    if (y > 0) push(k - w)
    if (y < h - 1) push(k + w)
  }
  return seen
}

// ── The check ──────────────────────────────────────────────────────────────

export interface ParsedFace {
  shapes: FilledShape[]
  artBox: Box | null
  /** The white (0,0,0,0) subpaths, flattened across shapes. */
  cutPaths: SubPath[]
  evenOdd: boolean
  /**
   * False when the page content stream had to be recovered partially. The
   * missing tail could hold either a cut or the strut that ties it on, so a
   * quiet result from a truncated face is never reported as clean.
   */
  complete: boolean
  /** True when the file draws only strokes — a die/cutter outline, not print artwork. */
  strokeOnly: boolean
}

/** Read one print file into the shape we can reason about. */
export async function parseFace(bytes: Uint8Array): Promise<ParsedFace | null> {
  const streams = await extractStreams(bytes)
  let best: FilledShape[] | null = null
  let bestComplete = true
  let sawContent = false
  for (const s of streams) {
    const shapes = parseContentStream(s.data)
    // A page content stream is recognisable by its path operators; an inflated
    // image or metadata blob yields nothing. Track whether we saw ANY content
    // so a stroke-only die file is not mistaken for an unreadable one.
    if (/\b(re|m|l|c)\b/.test(new TextDecoder('latin1').decode(s.data.subarray(0, 2048)))) {
      sawContent = true
    }
    if (!best || shapes.length > best.length) {
      best = shapes
      bestComplete = s.complete
    }
  }
  if (!best || best.length === 0) {
    if (!sawContent) return null
    // Content was readable but nothing is FILLED — a cutter/die outline drawn
    // with strokes only (403845 BERTHA.ai). Nothing to check, not a failure.
    return {
      shapes: [], artBox: readArtBox(bytes), cutPaths: [], evenOdd: false,
      complete: true, strokeOnly: true,
    }
  }
  const cutShapes = best.filter((s) => s.fill === CUT_FILL)
  return {
    shapes: best,
    artBox: readArtBox(bytes),
    cutPaths: cutShapes.flatMap((s) => s.subpaths),
    evenOdd: cutShapes.some((s) => s.evenOdd),
    complete: bestComplete,
    strokeOnly: false,
  }
}

/** The card area to flood from: the trim box, or the biggest painted shape. */
export function cardBox(face: ParsedFace): Box | null {
  if (face.artBox) return face.artBox
  let best: Box | null = null
  for (const s of face.shapes) {
    for (const sp of s.subpaths) {
      const b = boxOf(sp)
      if (!best || boxArea(b) > boxArea(best)) best = b
    }
  }
  return best
}

/**
 * Does this face have a background covering the card? Without one the border
 * pixels are not metal, so "connected to the card body" is meaningless — the
 * shaped-plate products (a die-cut logo rather than a rectangular card) land
 * here and must be reported as uncheckable, not clean.
 */
export function hasCardBackground(face: ParsedFace, card: Box): boolean {
  const target = boxArea(card) * 0.9
  for (const s of face.shapes) {
    for (const sp of s.subpaths) {
      if (boxArea(boxOf(sp)) >= target) return true
    }
  }
  return false
}

/**
 * Flood the metal in from the trim edge and return every piece the flood never
 * reaches — the pieces that would fall out.
 */
export function findLoose(
  cut: Grid,
  w: number,
  h: number,
  scale: number,
  minIslandPt2: number,
): Island[] {
  const reach = reachableFromBorder(cut, 0)
  const loose: Grid = { w, h, data: new Uint8Array(w * h) }
  for (let i = 0; i < loose.data.length; i++) {
    if (cut.data[i] === 0 && !reach[i]) loose.data[i] = 1
  }
  const out: Island[] = []
  const px2 = 1 / (scale * scale)
  for (const comp of components(loose, 1)) {
    const areaPt2 = comp.pixels.length * px2
    if (areaPt2 < minIslandPt2) continue
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const i of comp.pixels) {
      const x = i % w
      const y = (i / w) | 0
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
    out.push({
      areaPt2: Math.round(areaPt2 * 100) / 100,
      areaMm2: Math.round(areaPt2 * PT2_TO_MM2 * 1000) / 1000,
      x: Math.round((minX / scale) * 10) / 10,
      y: Math.round((minY / scale) * 10) / 10,
      widthPt: Math.round(((maxX - minX) / scale) * 10) / 10,
      heightPt: Math.round(((maxY - minY) / scale) * 10) / 10,
    })
  }
  return out.sort((a, b) => b.areaPt2 - a.areaPt2)
}

export interface AnalyseOptions {
  scale?: number
  minIslandPt2?: number
  mirrorMatchMin?: number
  localAgreementMin?: number
  /**
   * Why there is no opposite face, when the caller knows better than "there
   * isn't one" — e.g. the file exists but could not be read. Conflating those
   * two tells the reviewer the wrong thing to go and fix.
   */
  oppositeMissingReason?: string
}

/**
 * How well the white layer agrees with the mirrored other side over a window
 * around one region — intersection over union, so both extra and missing white
 * count against it. High for a genuine cut (the whole neighbourhood is the
 * same geometry); low for a letter that merely happens to mirror.
 */
export function localAgreement(
  pixels: number[],
  front: Uint8Array,
  mirrored: Uint8Array,
  w: number,
  h: number,
  scale: number,
): number {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const i of pixels) {
    const x = i % w
    const y = (i / w) | 0
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  const floor = LOCAL_WINDOW_MIN_PT * scale
  const padX = Math.max((maxX - minX) * LOCAL_WINDOW_FACTOR, floor)
  const padY = Math.max((maxY - minY) * LOCAL_WINDOW_FACTOR, floor)
  const x0 = Math.max(0, Math.floor(minX - padX))
  const x1 = Math.min(w - 1, Math.ceil(maxX + padX))
  const y0 = Math.max(0, Math.floor(minY - padY))
  const y1 = Math.min(h - 1, Math.ceil(maxY + padY))

  let inter = 0
  let union = 0
  for (let y = y0; y <= y1; y++) {
    const row = y * w
    for (let x = x0; x <= x1; x++) {
      const a = front[row + x]
      const b = mirrored[row + x]
      if (a || b) {
        union++
        if (a && b) inter++
      }
    }
  }
  return union === 0 ? 0 : inter / union
}

/**
 * Compare one face against its opposite face and report any piece of metal
 * that would fall out.
 *
 * `back` is the OTHER side's parsed file. It is required: without it we cannot
 * tell a cut from printed white, and guessing in either direction is worse
 * than saying so.
 */
export function analyseFace(
  front: ParsedFace,
  back: ParsedFace | null,
  opts: AnalyseOptions = {},
): FaceResult {
  const scale = opts.scale ?? RASTER_SCALE
  const minIsland = opts.minIslandPt2 ?? MIN_ISLAND_PT2
  const matchMin = opts.mirrorMatchMin ?? MIRROR_MATCH_MIN
  const localMin = opts.localAgreementMin ?? LOCAL_AGREEMENT_MIN

  const base: Omit<FaceResult, 'status'> = {
    islands: [],
    cutRegions: 0,
    printedWhiteRegions: 0,
    mirroredAreaShare: 0,
    cardWidthPt: 0,
    cardHeightPt: 0,
  }

  const card = cardBox(front)
  if (!card) return { ...base, status: 'cannot_check', reason: 'could not work out the card size from the file' }
  const cw = card.x1 - card.x0
  const ch = card.y1 - card.y0
  base.cardWidthPt = cw
  base.cardHeightPt = ch

  if (front.strokeOnly) {
    // A die/cutter outline drawn with strokes only — no printed artwork to
    // check, and not a failure to read the file.
    return { ...base, status: 'no_cut_artwork' }
  }
  if (front.cutPaths.length === 0) {
    // No white at all. If the file only came back partially, the missing tail
    // could have held the cut, so we must not call that clean.
    if (!front.complete) {
      return {
        ...base,
        status: 'cannot_check',
        reason: 'the artwork file is damaged and only partly readable',
      }
    }
    return { ...base, status: 'no_cut_artwork' }
  }
  if (!hasCardBackground(front, card)) {
    return {
      ...base,
      status: 'cannot_check',
      reason: 'no full-card background — a shaped or die-cut piece rather than a rectangular card',
    }
  }
  const w = Math.round(cw * scale) + 2
  const h = Math.round(ch * scale) + 2
  const whiteFront = rasterise(front.cutPaths, w, h, scale, card.x0, card.y0, front.evenOdd)

  if (!back) {
    // No opposite face, so we cannot tell a cut from printed white. But that
    // only MATTERS if the answer would change: take the pessimistic reading —
    // assume every white region is cut — and see whether anything comes loose.
    // On a real batch this settled 5 of 6 one-sided cards outright, because
    // nothing would drop out either way. Only when the pessimistic reading
    // does free a piece is the missing side worth raising.
    const wouldBeLoose = findLoose(whiteFront, w, h, scale, minIsland)
    base.cutRegions = 0
    base.printedWhiteRegions = components(whiteFront, 1).length
    if (wouldBeLoose.length === 0) {
      return {
        ...base,
        status: 'clean',
        reason: 'only one side supplied; nothing would come loose even if all the white is cut through',
      }
    }
    return {
      ...base,
      status: 'possible_dropout',
      islands: wouldBeLoose,
      reason: opts.oppositeMissingReason ??
        'there is no artwork for the other side, so we cannot tell whether this white is cut through or printed',
    }
  }

  // The other side, mirrored back onto this one. Its own card box is used so
  // the two align on the trim, not on wherever the artwork happens to sit.
  const backCard = cardBox(back) ?? card
  const whiteBackRaw = rasterise(
    back.cutPaths,
    w,
    h,
    scale,
    backCard.x0,
    backCard.y0,
    back.evenOdd,
  )
  const mirrored = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) mirrored[row + x] = whiteBackRaw.data[row + (w - 1 - x)]
  }

  // Keep only the white regions that have a mirrored counterpart: those are
  // cut through. The rest is printed white (a white QR, white type) and must
  // not be treated as a hole.
  //
  // The comparison is region-to-region and reciprocal. Each white region on
  // this face is matched to the mirrored back region it overlaps most, and
  // BOTH must cover each other — otherwise a small shape sitting inside a
  // bigger one on the other side counts as a perfect match by accident.
  const mirroredGrid: Grid = { w, h, data: mirrored }
  const backLabel = new Int32Array(w * h).fill(-1)
  const backSize: number[] = []
  for (const comp of components(mirroredGrid, 1)) {
    const id = backSize.length
    backSize.push(comp.pixels.length)
    for (const i of comp.pixels) backLabel[i] = id
  }

  const cutOnly: Grid = { w, h, data: new Uint8Array(w * h) }
  let cutRegions = 0
  let printedRegions = 0
  let cutArea = 0
  let whiteArea = 0
  for (const comp of components(whiteFront, 1)) {
    whiteArea += comp.pixels.length
    // How much of this region lands on each back region.
    const overlap = new Map<number, number>()
    for (const i of comp.pixels) {
      const id = backLabel[i]
      if (id >= 0) overlap.set(id, (overlap.get(id) ?? 0) + 1)
    }
    let bestId = -1
    let bestHit = 0
    for (const [id, n] of overlap) {
      if (n > bestHit) {
        bestHit = n
        bestId = id
      }
    }
    const coversFront = bestHit / comp.pixels.length
    const coversBack = bestId >= 0 ? bestHit / backSize[bestId] : 0
    const localOk =
      coversFront >= matchMin && coversBack >= matchMin &&
      localAgreement(comp.pixels, whiteFront.data, mirrored, w, h, scale) >= localMin
    if (coversFront >= matchMin && coversBack >= matchMin && localOk) {
      cutRegions++
      cutArea += comp.pixels.length
      for (const i of comp.pixels) cutOnly.data[i] = 1
    } else {
      printedRegions++
    }
  }
  base.cutRegions = cutRegions
  base.printedWhiteRegions = printedRegions
  base.mirroredAreaShare = whiteArea > 0 ? Math.round((cutArea / whiteArea) * 1000) / 1000 : 0

  if (cutRegions === 0) {
    // White is present but none of it mirrors — printed white only.
    return { ...base, status: 'no_cut_artwork' }
  }

  const islands = findLoose(cutOnly, w, h, scale, minIsland)

  if (islands.length === 0 && (!front.complete || !back.complete)) {
    // Nothing found, but we did not see all of the artwork. The missing part
    // could contain either a loose piece or the strut holding one on, so this
    // is an unknown, not a pass.
    return {
      ...base,
      status: 'cannot_check',
      reason: 'the artwork file is damaged and only partly readable',
    }
  }

  return {
    ...base,
    status: islands.length ? 'dropout' : 'clean',
    islands,
  }
}

// ── Pairing the two sides ──────────────────────────────────────────────────
// Which file is the other side of which? The studio's naming is not
// consistent, and the leading version number is NOT a pairing key — observed
// in live order folders:
//   02_Front_BM.ai          + 02_GianpaoloFrigo_BM.ai   shared front, named back
//   11_..._Front.ai         + 10_..._Back.ai            numbers DIFFER per side
//   07_LongestName_Front.ai + 07_Back.ai
//   01_AnthonyDumas.ai                                  single file, no partner
// so we go on the front/back words, and treat un-worded files as the
// per-recipient opposite of a shared front. Every face gets checked, each
// against the other side; anything unpairable keeps a null partner and is
// reported as uncheckable rather than guessed at.

export interface FacePair {
  /** The file being checked. */
  face: string
  /** The opposite side to mirror against, or null when there isn't one. */
  opposite: string | null
}

const FRONT_WORD = /front/i
const BACK_WORD = /back|reverse/i

function baseName(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut < 0 ? path : path.slice(cut + 1)
}

/** True when two filenames name the same card from opposite sides. */
export function sameCard(a: string, b: string): boolean {
  const key = (s: string) =>
    baseName(s)
      .replace(/\.(ai|pdf)$/i, '')
      .replace(FRONT_WORD, '')
      .replace(BACK_WORD, '')
      // Leading version numbers differ between sides, so they carry no
      // pairing signal and must not defeat an otherwise-exact name match.
      .replace(/^[\W_]*\d+[\W_]*/, '')
      .replace(/[^a-z0-9]/gi, '')
      .toLowerCase()
  const ka = key(a)
  return ka.length > 0 && ka === key(b)
}

/** Group one order folder's print files into faces plus their opposite side. */
export function pairPrintFiles(paths: string[]): FacePair[] {
  const print = paths.filter((p) => /\.(ai|pdf)$/i.test(p) && !/proof/i.test(baseName(p)))
  const fronts = print.filter((p) => FRONT_WORD.test(baseName(p)))
  const backs = print.filter((p) => BACK_WORD.test(baseName(p)) && !FRONT_WORD.test(baseName(p)))
  const rest = print.filter((p) => !FRONT_WORD.test(baseName(p)) && !BACK_WORD.test(baseName(p)))

  const out: FacePair[] = []
  const partner = (f: string, pool: string[]): string | null =>
    pool.length ? (pool.find((c) => sameCard(f, c)) ?? pool[0]) : null

  if (fronts.length && backs.length) {
    for (const f of fronts) out.push({ face: f, opposite: partner(f, backs) })
    for (const b of backs) out.push({ face: b, opposite: partner(b, fronts) })
    for (const r of rest) out.push({ face: r, opposite: fronts[0] })
  } else if (fronts.length && rest.length) {
    for (const r of rest) out.push({ face: r, opposite: fronts[0] })
    for (const f of fronts) out.push({ face: f, opposite: rest[0] })
  } else if (backs.length && rest.length) {
    for (const r of rest) out.push({ face: r, opposite: backs[0] })
    for (const b of backs) out.push({ face: b, opposite: rest[0] })
  } else if (print.length === 2) {
    out.push({ face: print[0], opposite: print[1] })
    out.push({ face: print[1], opposite: print[0] })
  } else {
    for (const p of print) out.push({ face: p, opposite: null })
  }
  return out
}

// ── Reporting ──────────────────────────────────────────────────────────────

export interface CardCheck {
  label: string
  result: FaceResult
}

/**
 * One plain-English line per card, for the model's context and for a human
 * reading the batch report. Deliberately describes the thing itself — a piece
 * that falls out — rather than the machinery that found it.
 */
export function describeFace(label: string, r: FaceResult): string {
  switch (r.status) {
    case 'dropout': {
      const parts = r.islands
        .slice(0, 6)
        .map((i) => `${i.areaMm2} mm² at (${i.x}, ${i.y}) pt`)
      const more = r.islands.length > 6 ? `, and ${r.islands.length - 6} more` : ''
      return `${label}: ${r.islands.length} piece${r.islands.length === 1 ? '' : 's'} of metal would fall out — ${parts.join('; ')}${more}. A supporting strut looks to be missing.`
    }
    case 'possible_dropout': {
      const parts = r.islands.slice(0, 6).map((i) => `${i.areaMm2} mm² at (${i.x}, ${i.y})`)
      return `${label}: only one side of this card was supplied, so we cannot tell whether the white is cut through or printed. IF it is cut through, ${r.islands.length} piece${r.islands.length === 1 ? '' : 's'} would fall out — ${parts.join('; ')}. Worth a look.`
    }
    case 'clean':
      if (r.cutRegions === 0 && r.reason) return `${label}: ${r.reason}.`
      return `${label}: cut-through artwork checked (${r.cutRegions} cut region${r.cutRegions === 1 ? '' : 's'}) — every piece stays attached.`
    case 'no_cut_artwork':
      return `${label}: nothing cut through the card.`
    case 'cannot_check':
      return `${label}: could not check for loose pieces — ${r.reason ?? 'unknown reason'}.`
  }
}
