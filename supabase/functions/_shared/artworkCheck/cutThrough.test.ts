// Tests for the cut-through dropout detector — the pure geometry, with no
// files and no network. The real-artwork validation lives in the offline batch
// runner (pnpm check:cut-through) against actual order folders; this harness
// covers the decidable logic, and above all the two properties the whole thing
// rests on:
//
//   1. it FIRES when a piece of metal is left unattached, and
//   2. it stays SILENT when a strut holds that piece on — down to struts far
//      narrower than any the studio actually draws.
//
// Run: npx tsx supabase/functions/_shared/artworkCheck/cutThrough.test.ts
// (same hand-rolled harness convention as artworkCheck.test.ts — no test
// framework in this repo; exits 1 on any failure.)

import { deflateSync } from 'node:zlib'
import {
  analyseFace,
  analyseOrderArtwork,
  applyCutThroughFindings,
  buildCutThroughContext,
  boxOf,
  components,
  CUT_FILL,
  describeFace,
  MIN_ISLAND_PT2,
  pairPrintFiles,
  parseContentStream,
  rasterise,
  reachableFromBorder,
  readArtBox,
  sameCard,
  type ParsedFace,
  type SubPath,
} from './cutThrough.ts'

let passed = 0
let failed = 0

function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++
  } else {
    failed++
    console.error(`  FAIL: ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function eq<T>(name: string, actual: T, expected: T) {
  check(name, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`)
}

// ── helpers to build synthetic artwork ─────────────────────────────────────

const CARD_W = 252
const CARD_H = 144

function rect(x0: number, y0: number, x1: number, y1: number): SubPath {
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
    { x: x0, y: y0 },
  ]
}

function circle(cx: number, cy: number, r: number, clockwise = false, n = 120): SubPath {
  const pts: SubPath = []
  for (let i = 0; i <= n; i++) {
    const a = ((clockwise ? -1 : 1) * 2 * Math.PI * i) / n
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) })
  }
  return pts
}

/** A ring, optionally with a wedge of metal (`tieDeg`) left uncut. */
function ring(cx: number, cy: number, rOut: number, rIn: number, tieDeg = 0): SubPath[] {
  if (tieDeg <= 0) return [circle(cx, cy, rOut, false), circle(cx, cy, rIn, true)]
  const half = (tieDeg * Math.PI) / 180 / 2
  const a0 = half
  const a1 = 2 * Math.PI - half
  const n = 120
  const outer: SubPath = []
  const inner: SubPath = []
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n
    outer.push({ x: cx + rOut * Math.cos(a), y: cy + rOut * Math.sin(a) })
    inner.push({ x: cx + rIn * Math.cos(a), y: cy + rIn * Math.sin(a) })
  }
  return [[...outer, ...inner.reverse(), outer[0]]]
}

/** Build a parsed face: a full-bleed background plus some white cut paths. */
function face(cutPaths: SubPath[]): ParsedFace {
  return {
    shapes: [
      { fill: 'cmyk:0,0,0,1', subpaths: [rect(0, 0, CARD_W, CARD_H)], evenOdd: false },
      { fill: CUT_FILL, subpaths: cutPaths, evenOdd: false },
    ],
    artBox: { x0: 0, y0: 0, x1: CARD_W, y1: CARD_H },
    cutPaths,
    evenOdd: false,
    complete: true,
    strokeOnly: false,
  }
}

/** The same artwork as it appears on the other side: mirrored in x. */
function mirroredFace(cutPaths: SubPath[]): ParsedFace {
  const flip = (s: SubPath): SubPath => s.map((p) => ({ x: CARD_W - p.x, y: p.y }))
  return face(cutPaths.map(flip))
}

// ── content-stream parsing ─────────────────────────────────────────────────

{
  const shapes = parseContentStream('0 0 0 0 k 10 10 50 30 re f')
  eq('parses a filled rectangle', shapes.length, 1)
  eq('captures the CMYK white fill', shapes[0]?.fill, CUT_FILL)
  eq('rect becomes one subpath', shapes[0]?.subpaths.length, 1)

  const b = boxOf(shapes[0].subpaths[0])
  check('rect box is right', b.x0 === 10 && b.y0 === 10 && b.x1 === 60 && b.y1 === 40)
}

{
  // The transform stack must apply, or every coordinate lands in the wrong place.
  const shapes = parseContentStream('q 1 0 0 1 100 50 cm 0 0 0 0 k 0 0 10 10 re f Q')
  const b = boxOf(shapes[0].subpaths[0])
  check('cm translation applies', b.x0 === 100 && b.y0 === 50, `${b.x0},${b.y0}`)

  const restored = parseContentStream('q 1 0 0 1 100 50 cm Q 0 0 0 0 k 0 0 10 10 re f')
  const b2 = boxOf(restored[0].subpaths[0])
  check('Q restores the transform', b2.x0 === 0 && b2.y0 === 0, `${b2.x0},${b2.y0}`)
}

{
  eq('f* is recorded as even-odd', parseContentStream('0 0 0 0 k 0 0 9 9 re f*')[0]?.evenOdd, true)
  eq('f is nonzero winding', parseContentStream('0 0 0 0 k 0 0 9 9 re f')[0]?.evenOdd, false)
  eq('n discards the path', parseContentStream('0 0 0 0 k 0 0 9 9 re n').length, 0)
  eq('a spot colour is not read as white', parseContentStream('/P1 cs 1 scn 0 0 9 9 re f')[0]?.fill, 'other')
  eq('grey is not white', parseContentStream('0.15 g 0 0 9 9 re f')[0]?.fill, 'gray:0.15')
}

{
  // Multiple subpaths under one fill — how the studio actually draws a cut
  // layer (six glyph outlines in a single `f`).
  const shapes = parseContentStream('0 0 0 0 k 0 0 5 5 re 20 20 5 5 re 40 40 5 5 re f')
  eq('one fill can carry many subpaths', shapes[0]?.subpaths.length, 3)
}

{
  const pdf = new TextEncoder().encode('%PDF-1.6\n/ArtBox[8.5 8.5 260.5 152.5]\n/MediaBox[0 0 269 161]')
  const box = readArtBox(pdf)
  check('reads the ArtBox', !!box && box.x0 === 8.5 && box.x1 === 260.5)
  eq('ArtBox width is the card', box ? Math.round(box.x1 - box.x0) : 0, 252)

  eq('no box present → null', readArtBox(new TextEncoder().encode('%PDF-1.6 nothing here')), null)
  // A degenerate box must not be accepted as a card.
  const tiny = readArtBox(new TextEncoder().encode('/ArtBox[0 0 3 3]/MediaBox[0 0 269 161]'))
  check('a tiny ArtBox falls through to MediaBox', !!tiny && tiny.x1 === 269)
}

// ── rasterising & topology ─────────────────────────────────────────────────

{
  const g = rasterise([rect(10, 10, 20, 20)], 30, 30, 1, 0, 0)
  let on = 0
  for (const v of g.data) on += v
  check('a 10x10 pt square fills ~100 px', on >= 90 && on <= 121, `got ${on}`)
}

{
  // A ring must leave its middle unpainted under nonzero winding — that hole
  // is the piece of metal the whole check is about.
  const g = rasterise(ring(50, 50, 20, 12), 100, 100, 1, 0, 0)
  eq('ring centre is not painted', g.data[50 * 100 + 50], 0)
  eq('ring wall is painted', g.data[50 * 100 + (50 + 16)], 1)
}

{
  const g = rasterise([rect(2, 2, 8, 8)], 10, 10, 1, 0, 0)
  const reach = reachableFromBorder(g, 0)
  eq('border metal is reachable', reach[0], 1)
  const comps = components(g, 1)
  eq('one painted component', comps.length, 1)
}

// ── the two properties that matter ─────────────────────────────────────────

{
  // An unbridged ring: the middle is loose and MUST be reported.
  const cut = ring(126, 72, 16, 10)
  const r = analyseFace(face(cut), mirroredFace(cut))
  eq('unstrutted ring → dropout', r.status, 'dropout')
  eq('one loose piece', r.islands.length, 1)
  check('loose piece is about the right size', r.islands[0].areaMm2 > 30 && r.islands[0].areaMm2 < 45,
    `${r.islands[0]?.areaMm2} mm²`)
  check('description names the problem', /fall out/.test(describeFace('Card', r)))
}

{
  // The same ring with a tie left in the cut path, at widths spanning and
  // going well below the 0.4–1.2 mm struts measured on real artwork.
  for (const deg of [24, 12, 6, 3, 1.5]) {
    const cut = ring(126, 72, 16, 10, deg)
    const r = analyseFace(face(cut), mirroredFace(cut))
    eq(`strutted ring (${deg}°) → clean`, r.status, 'clean')
  }
}

{
  // Two separate unstrutted shapes → two findings, biggest first.
  const cut = [...ring(70, 72, 16, 10), ...ring(180, 72, 24, 16)]
  const r = analyseFace(face(cut), mirroredFace(cut))
  eq('two loose pieces found', r.islands.length, 2)
  check('sorted biggest first', r.islands[0].areaPt2 > r.islands[1].areaPt2)
}

// ── the mirror gate: printed white must not be read as a hole ──────────────

{
  // White on the front only — a printed white QR or white type. Its enclosed
  // middles are ink, not holes, and must produce nothing.
  const printedWhite = ring(126, 72, 16, 10)
  const r = analyseFace(face(printedWhite), face([]))
  eq('white with no mirrored partner → not a cut', r.status, 'no_cut_artwork')
  eq('and no loose pieces claimed', r.islands.length, 0)
}

{
  // The mixed case that forces per-region matching rather than a whole-page
  // score: a genuine cut ring AND a separate printed-white ring on one face.
  const cutRing = ring(70, 72, 16, 10)
  const printedRing = ring(190, 72, 16, 10)
  const front = face([...cutRing, ...printedRing])
  const back = mirroredFace(cutRing) // only the cut one appears on the back
  const r = analyseFace(front, back)
  eq('mixed face still reports the cut one', r.status, 'dropout')
  eq('exactly one loose piece', r.islands.length, 1)
  eq('one region matched as cut', r.cutRegions, 1)
  eq('one region judged printed white', r.printedWhiteRegions, 1)
  check('the finding is the CUT ring, not the printed one', r.islands[0].x < CARD_W / 2,
    `x=${r.islands[0]?.x}`)
}

{
  // The coincidence that produced a real false alarm (carbon-fibre order
  // 403880): a card of PRINTED white text, where one small letter happened to
  // land inside a much larger mirrored letter on the other side. A one-way
  // "is this region sitting on back-white?" test scores that a perfect match
  // and reports the letter's counter as a dropout. The match must be
  // reciprocal — the counterpart has to look like this region too.
  const smallO = ring(60, 72, 5, 3)
  const bigBlock = [rect(30, 40, 100, 110)] // a fat mirrored shape swallowing it
  const front = face(smallO)
  const back: ParsedFace = {
    ...face(bigBlock),
    cutPaths: bigBlock.map((s) => s.map((p) => ({ x: CARD_W - p.x, y: p.y }))),
  }
  const r = analyseFace(front, back)
  check('a small shape inside a big one is NOT a cut', r.status !== 'dropout', `got ${r.status}`)
  eq('it is judged printed white', r.printedWhiteRegions, 1)
  eq('and no cut regions claimed', r.cutRegions, 0)
}

{
  // The converse must still hold: a true mirrored counterpart matches.
  const cut = ring(126, 72, 16, 10)
  const r = analyseFace(face(cut), mirroredFace(cut))
  eq('an exact mirror still counts as cut', r.cutRegions, 1)
  eq('and its loose middle is reported', r.islands.length, 1)
}

{
  // The harder coincidence, from a real NATO-alphabet card (403874): in
  // mirrored monospaced text an 'o' lands exactly on ANOTHER 'o'. The shapes
  // are identical, so the reciprocal test above passes honestly — but the
  // letters either side differ, so the neighbourhood does not agree.
  const matched = ring(126, 72, 6, 3.5)          // the letter that lines up
  const frontNeighbours = [...ring(108, 72, 6, 3.5), ...ring(144, 72, 6, 3.5)]
  const backNeighbours = [...ring(117, 72, 6, 3.5), ...ring(135, 72, 6, 3.5)]
  const front = face([...matched, ...frontNeighbours])
  const backPaths = [...matched, ...backNeighbours].map((s) =>
    s.map((p) => ({ x: CARD_W - p.x, y: p.y })),
  )
  const back: ParsedFace = { ...face(backPaths), cutPaths: backPaths }
  const r = analyseFace(front, back)
  check('a lone glyph coincidence is not a cut', r.status !== 'dropout', `got ${r.status}`)
  eq('nothing is claimed as cut', r.cutRegions, 0)
}

{
  // ...and the same geometry WITH its neighbourhood mirroring is a real cut,
  // so the neighbourhood test cannot simply be suppressing small shapes.
  const cut = [...ring(126, 72, 6, 3.5), ...ring(108, 72, 6, 3.5), ...ring(144, 72, 6, 3.5)]
  const r = analyseFace(face(cut), mirroredFace(cut))
  eq('a fully mirrored group IS a cut', r.cutRegions, 3)
  eq('and its loose middles are reported', r.islands.length, 3)
}

{
  // The case a global "most of the white must mirror" rule would break: a
  // genuine cut logo on a card that is mostly printed white type. The cut is
  // a small share of the white area, but its own surroundings mirror.
  const logo = ring(40, 110, 14, 9)
  const type: SubPath[] = []
  for (let i = 0; i < 12; i++) type.push(...ring(60 + i * 14, 30, 5, 2.5))
  const front = face([...logo, ...type])
  const backPaths = [
    ...logo.map((s) => s.map((p) => ({ x: CARD_W - p.x, y: p.y }))),
    // The back carries its own printed type on a DIFFERENT line, so none of it
    // corresponds to the front's — only the logo genuinely mirrors.
    ...Array.from({ length: 12 }, (_, i) => ring(60 + i * 14, 55, 5, 2.5)).flat(),
  ]
  const back: ParsedFace = { ...face(backPaths), cutPaths: backPaths }
  const r = analyseFace(front, back)
  eq('the cut logo survives among printed type', r.cutRegions, 1)
  eq('its loose middle is reported', r.islands.length, 1)
  check('and it is only a small share of the white area', r.mirroredAreaShare < 0.5,
    `share=${r.mirroredAreaShare}`)
}

{
  // A cut shape whose back copy is drawn slightly differently must still
  // match — the two faces are separately drawn artwork, not one file.
  const cut = ring(126, 72, 16, 10)
  const slightlyOff = ring(126.6, 72.4, 16.2, 10.1)
  const back: ParsedFace = {
    ...face(slightlyOff),
    cutPaths: slightlyOff.map((s) => s.map((p) => ({ x: CARD_W - p.x, y: p.y }))),
  }
  const r = analyseFace(face(cut), back)
  eq('small drawing differences still match', r.cutRegions, 1)
  eq('dropout still reported', r.status, 'dropout')
}

// ── failing loud ───────────────────────────────────────────────────────────

{
  // One-sided card, and the white WOULD free a piece if it is cut. We cannot
  // confirm it is a cut, so this is a conditional warning — not the flat
  // claim 'dropout' makes, and not a silent shrug either.
  const cut = ring(126, 72, 16, 10)
  const r = analyseFace(face(cut), null)
  eq('one side + something loose → possible_dropout', r.status, 'possible_dropout')
  check('and says why', /other side/i.test(r.reason ?? ''), r.reason)
  eq('the piece at stake is named', r.islands.length, 1)
  check('worded as a conditional', /IF it is cut through/.test(describeFace('Card', r)))
}

{
  // The common one-sided case: nothing would come loose even on the most
  // pessimistic reading, so the missing side simply does not matter. Five of
  // six real one-sided cards land here.
  const strutted = ring(126, 72, 16, 10, 12)
  const r = analyseFace(face(strutted), null)
  eq('one side + nothing loose → clean', r.status, 'clean')
  check('and explains that the other side was not needed',
    /nothing would come loose/i.test(r.reason ?? ''), r.reason)
  eq('no findings invented', r.islands.length, 0)
}

{
  // A shaped plate with no full-card background: "connected to the body" has
  // no meaning, so this must not be reported as clean.
  const cut = ring(126, 72, 16, 10)
  const shaped: ParsedFace = {
    shapes: [{ fill: CUT_FILL, subpaths: cut, evenOdd: false }],
    artBox: { x0: 0, y0: 0, x1: CARD_W, y1: CARD_H },
    cutPaths: cut,
    evenOdd: false,
    complete: true,
    strokeOnly: false,
  }
  const r = analyseFace(shaped, mirroredFace(cut))
  eq('no card background → cannot_check', r.status, 'cannot_check')
  check('and says why', /shaped|background/i.test(r.reason ?? ''))
}

{
  const r = analyseFace(face([]), face([]))
  eq('no white at all → nothing to check', r.status, 'no_cut_artwork')
  check('described plainly', /nothing cut/i.test(describeFace('Card', r)))
}

{
  // Rasteriser noise must not be dressed up as a defect.
  const speck = ring(126, 72, 0.35, 0.2)
  const r = analyseFace(face(speck), mirroredFace(speck))
  check('sub-threshold specks are ignored', r.islands.length === 0, `got ${r.islands.length}`)
  check('the floor is small enough for real counters', MIN_ISLAND_PT2 < 1)
}

// ── card geometry ──────────────────────────────────────────────────────────

{
  const cut = ring(126, 72, 16, 10)
  const r = analyseFace(face(cut), mirroredFace(cut))
  eq('card width reported', Math.round(r.cardWidthPt), CARD_W)
  eq('card height reported', Math.round(r.cardHeightPt), CARD_H)
  const i = r.islands[0]
  check('island sits where it was drawn', Math.abs(i.x + i.widthPt / 2 - 126) < 2, `x=${i.x} w=${i.widthPt}`)
}

// ── pairing the two sides ──────────────────────────────────────────────────
// Every filename shape below was taken from a real order folder.

{
  // Skyfall 403813: a shared front plus a per-recipient back.
  const pairs = pairPrintFiles(['02_Front_BM.ai', '02_GianpaoloFrigo_BM.ai'])
  eq('both faces are checked', pairs.length, 2)
  const named = pairs.find((p) => p.face === '02_GianpaoloFrigo_BM.ai')
  eq('named back mirrors the shared front', named?.opposite, '02_Front_BM.ai')
  const front = pairs.find((p) => p.face === '02_Front_BM.ai')
  eq('shared front mirrors the named back', front?.opposite, '02_GianpaoloFrigo_BM.ai')
}

{
  // Hurst 403895: the leading numbers DIFFER between sides — they must not be
  // treated as a pairing key, and must not stop the sides being matched.
  const pairs = pairPrintFiles([
    '11_LoyaltyCard_Steel_Front.ai',
    '10_LoyaltyCard_Steel_Back.ai',
  ])
  eq('mismatched version numbers still pair', pairs.length, 2)
  eq(
    'front finds its back',
    pairs.find((p) => /Front/.test(p.face))?.opposite,
    '10_LoyaltyCard_Steel_Back.ai',
  )
  check('the same-card key ignores leading numbers',
    sameCard('11_LoyaltyCard_Steel_Front.ai', '10_LoyaltyCard_Steel_Back.ai'))
}

{
  // Recovery Village 403884: several recipients against one shared front, with
  // non-artwork files in the same folder.
  const pairs = pairPrintFiles([
    '07_LongestName_Front.ai',
    '07_Back.ai',
    'names.csv',
    'OpenSans-Regular.ttf',
    'Proof07_JoshGold_Back.jpg',
  ])
  eq('only print files are considered', pairs.length, 2)
  check('no csv or font sneaks in', pairs.every((p) => /\.ai$/.test(p.face)))
}

{
  // Proof mockups must never be mistaken for print artwork, even as PDFs.
  const pairs = pairPrintFiles(['Proof02_Front.pdf', '02_Front.ai', '02_Back.ai'])
  check('proof files are excluded', pairs.every((p) => !/proof/i.test(p.face)))
  eq('leaving the real pair', pairs.length, 2)
}

{
  // Autto 403893 / ARNE 403896: a single print file. There is no opposite
  // side, so the checker must be told so rather than handed a wrong partner.
  const pairs = pairPrintFiles(['01_AnthonyDumas.ai'])
  eq('single file still checked', pairs.length, 1)
  eq('with no opposite side', pairs[0].opposite, null)
}

{
  // Two un-worded files: the only sensible reading is that they are the two
  // sides of one card.
  const pairs = pairPrintFiles(['04Front.ai', '03GianpaoloFrigo.ai'])
  eq('two files pair both ways', pairs.length, 2)
  check('each points at the other',
    pairs[0].opposite === pairs[1].face && pairs[1].opposite === pairs[0].face)
}

{
  const pairs = pairPrintFiles(['notes.txt', 'Proof01.jpg'])
  eq('a folder with no artwork yields nothing', pairs.length, 0)
}

{
  // A single-file order must reach a conditional verdict end to end, never a
  // silent pass.
  const pairs = pairPrintFiles(['01_Solo.ai'])
  eq('the lone file has no opposite', pairs[0].opposite, null)
  const cut = ring(126, 72, 16, 10)
  const r = analyseFace(face(cut), pairs[0].opposite ? face([]) : null)
  eq('unpaired file with a loose piece warns', r.status, 'possible_dropout')
  check('never silently clean', r.status !== 'clean' || r.islands.length === 0)
}

// ── damaged and stroke-only files ─────────────────────────────────────────

{
  // A partly-recovered file must never read as clean: the missing tail could
  // hold the loose piece, or the strut that holds it on (403828 01_Front.ai
  // inflated to 36 KB of good paths and then stopped).
  const cut = ring(126, 72, 16, 10, 12)   // strutted, so nothing would be found
  const damaged: ParsedFace = { ...face(cut), complete: false }
  const r = analyseFace(damaged, mirroredFace(cut))
  eq('a quiet result on damaged artwork is not clean', r.status, 'cannot_check')
  check('and says the file is damaged', /damaged|partly/i.test(r.reason ?? ''))
}

{
  // ...but a loose piece found in what WAS readable is still worth saying.
  const cut = ring(126, 72, 16, 10)
  const damaged: ParsedFace = { ...face(cut), complete: false }
  const r = analyseFace(damaged, mirroredFace(cut))
  eq('a dropout on damaged artwork is still reported', r.status, 'dropout')
}

{
  // A die/cutter outline drawn in strokes only (403845 BERTHA.ai) has no
  // printed artwork at all — nothing to check, and NOT a read failure.
  const dieLine: ParsedFace = {
    shapes: [], artBox: { x0: 0, y0: 0, x1: CARD_W, y1: CARD_H },
    cutPaths: [], evenOdd: false, complete: true, strokeOnly: true,
  }
  const r = analyseFace(dieLine, null)
  eq('a stroke-only die file has nothing to check', r.status, 'no_cut_artwork')
}

{
  // "No other side exists" and "the other side would not read" need different
  // action, so the caller can say which.
  const cut = ring(126, 72, 16, 10)
  const plain = analyseFace(face(cut), null)
  check('default reason is about there being no other side',
    /no artwork for the other side/i.test(plain.reason ?? ''), plain.reason)
  const told = analyseFace(face(cut), null, { oppositeMissingReason: 'the other side (X.ai) could not be read' })
  check('caller can say the file was unreadable instead',
    /could not be read/i.test(told.reason ?? ''), told.reason)
}

// ── end to end over real PDF bytes ────────────────────────────────────────
// Builds a genuine (tiny) PDF so extractStreams, the content-stream parser and
// readArtBox are all exercised on real bytes rather than hand-fed shapes.

function buildPdf(content: string): Uint8Array {
  const body = deflateSync(Buffer.from(content, 'latin1'))
  const head = Buffer.from(
    '%PDF-1.6\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
      `2 0 obj<</Type/Page/ArtBox[0 0 ${CARD_W} ${CARD_H}]/MediaBox[0 0 ${CARD_W} ${CARD_H}]>>endobj\n` +
      `3 0 obj<</Filter/FlateDecode/Length ${body.length}>>stream\n`,
    'latin1',
  )
  const tail = Buffer.from('\nendstream endobj\n%%EOF\n', 'latin1')
  return new Uint8Array(Buffer.concat([head, body, tail]))
}

/** Draw a background plus a ring, in PDF operators. `tie` leaves a gap. */
function pdfArtwork(cx: number, tie: boolean): string {
  const out: string[] = [`0 0 0 1 k 0 0 ${CARD_W} ${CARD_H} re f`, '0 0 0 0 k']
  const rings = ring(cx, 72, 16, 10, tie ? 24 : 0)
  for (const sp of rings) {
    out.push(`${sp[0].x.toFixed(3)} ${sp[0].y.toFixed(3)} m`)
    for (const p of sp.slice(1)) out.push(`${p.x.toFixed(3)} ${p.y.toFixed(3)} l`)
    out.push('h')
  }
  out.push('f')
  return out.join('\n')
}

{
  const cx = 126
  // Front and back carry the same ring; mirrored, that is x -> CARD_W - x,
  // and a ring centred on the card mirrors onto itself.
  const unstrutted = buildPdf(pdfArtwork(cx, false))
  const faces = await analyseOrderArtwork([
    { name: '01_Front.ai', bytes: unstrutted },
    { name: '01_Back.ai', bytes: unstrutted },
  ])
  eq('both faces checked from real PDF bytes', faces.length, 2)
  eq('the unstrutted ring is caught end to end', faces[0].result.status, 'dropout')
  check('context block states it as measured',
    /measured from the print files/i.test(buildCutThroughContext(faces)))
  check('context tells the model not to re-measure',
    /do NOT re-measure/i.test(buildCutThroughContext(faces)))
}

{
  const strutted = buildPdf(pdfArtwork(126, true))
  const faces = await analyseOrderArtwork([
    { name: '01_Front.ai', bytes: strutted },
    { name: '01_Back.ai', bytes: strutted },
  ])
  eq('a strutted ring is clean end to end', faces[0].result.status, 'clean')
  const ctx = buildCutThroughContext(faces)
  check('and the block says nothing alarming', !/fall out/i.test(ctx), ctx)
}

{
  // Unreadable bytes must degrade to an honest "could not check", never throw
  // and never take the whole artwork check down with them.
  const faces = await analyseOrderArtwork([
    { name: 'a.ai', bytes: new Uint8Array([1, 2, 3, 4]) },
    { name: 'b.ai', bytes: new Uint8Array([5, 6, 7, 8]) },
  ])
  eq('rubbish bytes do not throw', faces.length, 2)
  eq('they report as uncheckable', faces[0].result.status, 'cannot_check')
  eq('no findings invented', faces[0].result.islands.length, 0)
}

{
  eq('no files -> no context block', buildCutThroughContext([]), '')
}

// ── merging into the report ───────────────────────────────────────────────

type TestReport = {
  summary: string
  cards: { label: string; findings: { field: string; supplied: string; printed: string; status: string; severity?: string; note: string }[] }[]
  corrections: { quote: string; resolved: boolean; severity?: string; note: string }[]
  notes: string[]
  reference_gaps: string[]
}
const emptyReport = (): TestReport =>
  ({ summary: '', cards: [], corrections: [], notes: [], reference_gaps: [] })

const faceResult = (over: Partial<import('./cutThrough.ts').FaceResult>) => ({
  status: 'clean' as const, islands: [], cutRegions: 1, printedWhiteRegions: 0,
  mirroredAreaShare: 1, cardWidthPt: CARD_W, cardHeightPt: CARD_H, ...over,
})

{
  // A measured dropout must reach the report even if the model said nothing,
  // because the verdict is derived from findings in code.
  const rep = emptyReport()
  applyCutThroughFindings(rep, [{
    label: '01_Front.ai',
    result: faceResult({ status: 'dropout', islands: [{ areaPt2: 17.6, areaMm2: 2.19, x: 26.9, y: 30, widthPt: 4.5, heightPt: 3.9 }] }),
  }])
  eq('a card is added for it', rep.cards.length, 1)
  const f = rep.cards[0].findings[0]
  eq('it is a flag', f.status, 'flag')
  eq('at the red tier', f.severity, 'defect')
  check('naming the size', /2\.19 mm²/.test(f.printed), f.printed)
  check('and explaining it in plain words', /fall out/i.test(f.note), f.note)
}

{
  // The one-sided conditional stays amber and is worded as a conditional.
  const rep = emptyReport()
  applyCutThroughFindings(rep, [{
    label: '02.ai',
    result: faceResult({ status: 'possible_dropout', cutRegions: 0, printedWhiteRegions: 4, islands: [{ areaPt2: 390, areaMm2: 48.28, x: 21, y: 100.8, widthPt: 60, heightPt: 60 }] }),
  }])
  const f = rep.cards[0].findings[0]
  eq('conditional stays amber', f.severity, 'review')
  check('worded as an IF', /IF this white is cut through/i.test(f.printed), f.printed)
}

{
  const rep = emptyReport()
  applyCutThroughFindings(rep, [
    { label: 'a.ai', result: faceResult({ status: 'clean' }) },
    { label: 'b.ai', result: faceResult({ status: 'no_cut_artwork' }) },
  ])
  eq('a clean result adds nothing', rep.cards.length, 0)
  eq('and no gaps', rep.reference_gaps.length, 0)
}

{
  const rep = emptyReport()
  applyCutThroughFindings(rep, [{
    label: 'c.ai',
    result: faceResult({ status: 'cannot_check', reason: 'the artwork file is damaged and only partly readable' }),
  }])
  eq('uncheckable is a reference gap, not a flag', rep.cards.length, 0)
  eq('recorded once', rep.reference_gaps.length, 1)
  check('naming the file and the reason', /c\.ai.*damaged/i.test(rep.reference_gaps[0]), rep.reference_gaps[0])
}

{
  // Attach to the model's own card entry when it has one, and never duplicate
  // a finding the model already made about the same thing.
  const rep = emptyReport()
  rep.cards.push({
    label: 'Derrick Smith — 01_Front (front/back)',
    findings: [{ field: 'other', supplied: '', printed: 'the O has no strut', status: 'flag', severity: 'review', note: 'a piece would fall out' }],
  })
  applyCutThroughFindings(rep, [{
    label: '01_Front.ai',
    result: faceResult({ status: 'dropout', islands: [{ areaPt2: 17.6, areaMm2: 2.19, x: 1, y: 1, widthPt: 4, heightPt: 4 }] }),
  }])
  eq('no second card invented', rep.cards.length, 1)
  eq('and no duplicate finding', rep.cards[0].findings.length, 1)
}

{
  // The point of merging into the report rather than only telling the model:
  // the verdict is derived from findings in CODE, so a measured dropout must
  // move the order's verdict on its own.
  const { deriveVerdict } = await import('./report.ts')
  const rep = emptyReport()
  eq('an empty report is clear', deriveVerdict(rep as never), 'clear')
  applyCutThroughFindings(rep, [{
    label: '01_Front.ai',
    result: faceResult({ status: 'dropout', islands: [{ areaPt2: 17.6, areaMm2: 2.19, x: 1, y: 1, widthPt: 4, heightPt: 4 }] }),
  }])
  eq('a loose piece makes the order a defect', deriveVerdict(rep as never), 'defect')

  const rep2 = emptyReport()
  applyCutThroughFindings(rep2, [{
    label: '02.ai',
    result: faceResult({ status: 'possible_dropout', islands: [{ areaPt2: 390, areaMm2: 48.3, x: 1, y: 1, widthPt: 60, heightPt: 60 }] }),
  }])
  eq('the one-sided conditional only flags', deriveVerdict(rep2 as never), 'flagged')

  const rep3 = emptyReport()
  applyCutThroughFindings(rep3, [{ label: 'x.ai', result: faceResult({ status: 'clean' }) }])
  eq('a clean cut-through leaves the verdict alone', deriveVerdict(rep3 as never), 'clear')
}

console.log(`\ncutThrough: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
