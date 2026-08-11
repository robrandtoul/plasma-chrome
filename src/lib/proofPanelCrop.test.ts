// Unit tests for proofPanelCrop.ts
// Run with: npx tsx src/lib/proofPanelCrop.test.ts
//
// These are the SHAPE tests — synthetic detail profiles standing for the cases
// the detector has to tell apart, so a regression in the decision logic is
// caught in a second without a network or a corpus.
//
// They are not the whole story and must not be mistaken for it. The claim that
// actually matters — "this finds the panel on real proofs, including the
// coloured-background ones that defeated the previous attempt" — can only be
// made against real files. That is scripts/check-panel-crop.ts, which runs the
// SAME functions over a hand-labelled corpus of real proof JPEGs and prints an
// honest confusion matrix. Keep both: this one guards the logic, that one
// guards the claim.

import { columnProfiles, detectPanelFromProfiles, type ColumnProfiles } from './proofPanelCrop'

// ── Harness ─────────────────────────────────────────────────────────────────

let passed = 0
let failed = 0

function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (err) {
    console.log(`  ✗ ${name}`)
    console.log(`    ${(err as Error).message}`)
    failed++
  }
}

function assertEqual<T>(actual: T, expected: T, message?: string) {
  if (actual !== expected) {
    throw new Error(message ?? `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

function assertBetween(actual: number, lo: number, hi: number, message?: string) {
  if (!(actual >= lo && actual <= hi)) {
    throw new Error(message ?? `expected ${actual} to be within ${lo}..${hi}`)
  }
}

// ── Profile builders ────────────────────────────────────────────────────────
// A span's `level` is the share of rows carrying a type-sized step: well above
// zero means type, zero means a smooth fill, texture or photograph. `tone` is
// uniform unless a test is about a divider bar.

const W = 480

function build(
  spans: { from: number; to: number; level: number }[],
  width = W,
  tone?: { from: number; to: number; level: number }[],
): ColumnProfiles {
  const edge = new Array<number>(width).fill(0)
  const toneArr = new Array<number>(width).fill(30)
  for (const s of spans) {
    for (let x = Math.round(s.from * width); x < Math.round(s.to * width); x++) {
      if (x >= 0 && x < width) edge[x] = s.level
    }
  }
  for (const t of tone ?? []) {
    for (let x = Math.round(t.from * width); x < Math.round(t.to * width); x++) {
      if (x >= 0 && x < width) toneArr[x] = t.level
    }
  }
  return { edge, tone: toneArr }
}

/** The classic: panel type 2%→33%, a margin, then the card. */
const panelled = () =>
  build([
    { from: 0.02, to: 0.33, level: 0.05 },
    { from: 0.38, to: 0.97, level: 0.02 },
  ])

// ── Finding the panel ───────────────────────────────────────────────────────

test('finds a classic panelled proof and cuts inside the margin', () => {
  const d = detectPanelFromProfiles(panelled(), W)
  assertEqual(d.hasPanel, true)
  // Must land after the text ends and before the card starts.
  assertBetween(d.cutFraction!, 0.33, 0.38)
  assertEqual(d.confidence, 'clear')
})

test('cut is biased toward the panel, never into the card', () => {
  const d = detectPanelFromProfiles(panelled(), W)
  // The gap is 0.33→0.38; a panel-biased cut sits in its first half.
  assertBetween(d.cutFraction!, 0.33, 0.355)
})

test('reports the cut in the same units it was given', () => {
  const d = detectPanelFromProfiles(panelled(), W)
  assertEqual(d.cutX, Math.round(d.cutFraction! * W))
})

// ── The cases that must NOT be cropped ──────────────────────────────────────

test('an already-cropped proof is left alone', () => {
  // Card fills the frame: detail starts immediately and never stops for a margin.
  const d = detectPanelFromProfiles(build([{ from: 0.01, to: 0.99, level: 0.03 }]), W)
  assertEqual(d.hasPanel, false)
})

test('artwork that only gets busy later is not read as a panel', () => {
  // Quiet left margin then a card — the inverse of a panel, and the shape a
  // naive "find a gap" rule would happily cut in the wrong place.
  const d = detectPanelFromProfiles(build([{ from: 0.3, to: 0.95, level: 0.03 }]), W)
  assertEqual(d.hasPanel, false)
})

test('a letterhead is not cropped down to nothing', () => {
  // Text block on the left, nothing to the right. Cropping here would discard
  // the document and keep blank paper.
  const d = detectPanelFromProfiles(build([{ from: 0.02, to: 0.3, level: 0.05 }]), W)
  assertEqual(d.hasPanel, false)
})

test('a blank or near-blank image is left alone', () => {
  assertEqual(detectPanelFromProfiles(build([]), W).hasPanel, false)
})

test('a thin strip of detail at the left edge is not a panel', () => {
  // e.g. the very edge of a card clipped into frame.
  const d = detectPanelFromProfiles(
    build([
      { from: 0.0, to: 0.03, level: 0.05 },
      { from: 0.4, to: 0.95, level: 0.03 },
    ]),
    W,
  )
  assertEqual(d.hasPanel, false)
})

test('patchy left-hand detail is refused rather than guessed', () => {
  // Two thin bars with a lot of nothing between them: not a solid text block.
  const d = detectPanelFromProfiles(
    build([
      { from: 0.02, to: 0.05, level: 0.05 },
      { from: 0.28, to: 0.31, level: 0.05 },
      { from: 0.4, to: 0.95, level: 0.03 },
    ]),
    W,
  )
  assertEqual(d.hasPanel, false)
})

test('a tiny image is refused rather than assessed', () => {
  assertEqual(detectPanelFromProfiles(build([], 3), 3).hasPanel, false)
})

// ── Background-independence: the bug this replaces ──────────────────────────

test('a panel on a bright background is found', () => {
  // The previous detector looked for a DARK gutter and returned a false
  // negative on a bamboo proof over a blue gradient and a steel proof over
  // green baize — both carrying live price grids. Type is counted, not
  // brightness, so how light the margin is does not matter: what matters is
  // that it is SMOOTH, and a bright smooth margin carries as little type as a
  // black one.
  const p = build([
    { from: 0.02, to: 0.33, level: 0.05 },
    { from: 0.38, to: 0.97, level: 0.02 },
  ])
  for (let x = Math.round(0.33 * W); x < Math.round(0.38 * W); x++) p.tone[x] = 235
  const d = detectPanelFromProfiles(p, W)
  assertEqual(d.hasPanel, true)
  assertBetween(d.cutFraction!, 0.33, 0.38)
})

test('the decision does not depend on the image being 16:9', () => {
  // Shape is never consulted — the acrylic proofs from Sept 2022 onward carry
  // price grids at a non-16:9 ratio, which is what made a shape test fail by
  // whole categories. Same profile, three widths, same verdict.
  for (const w of [320, 480, 1280]) {
    const d = detectPanelFromProfiles(
      build(
        [
          { from: 0.02, to: 0.33, level: 0.05 },
          { from: 0.38, to: 0.97, level: 0.02 },
        ],
        w,
      ),
      w,
    )
    assertEqual(d.hasPanel, true, `width ${w} should still find the panel`)
    assertBetween(d.cutFraction!, 0.33, 0.38, `width ${w} cut fraction`)
  }
})

// ── Panel width varies: no fixed fraction ───────────────────────────────────

test('follows the panel edge rather than assuming 36.2%', () => {
  // The measured range across real proofs runs roughly 0.30–0.39. A fixed cut
  // leaves a stripe at one end and eats the card at the other, which is why
  // the edge is found per image.
  for (const end of [0.3, 0.34, 0.386]) {
    const d = detectPanelFromProfiles(
      build([
        { from: 0.02, to: end, level: 0.05 },
        { from: end + 0.04, to: 0.97, level: 0.02 },
      ]),
      W,
    )
    assertEqual(d.hasPanel, true, `panel ending at ${end}`)
    assertBetween(d.cutFraction!, end - 0.005, end + 0.04, `cut for panel ending at ${end}`)
  }
})

test('a narrow margin is flagged unsure rather than passed silently', () => {
  // A six-pixel sliver of price grid is not obvious at a glance, so the case
  // where the detector is least certain is exactly the one a human must see.
  const d = detectPanelFromProfiles(
    build([
      { from: 0.02, to: 0.33, level: 0.05 },
      { from: 0.343, to: 0.97, level: 0.02 },
    ]),
    W,
  )
  assertEqual(d.hasPanel, true)
  assertEqual(d.confidence, 'unsure')
})

// ── Two failures the real corpus found ──────────────────────────────────────

test('a card with barely any type of its own is still found', () => {
  // A frosted translucent card photographed on a hand carries only soft,
  // low-contrast lettering — almost nothing the type test would count. It is
  // recognised anyway because the card's own boundary against the background is
  // itself a type-sized step. Six real black-background proofs turned on this,
  // and each would have shipped its price grid had the card gone unrecognised.
  const p = build([
    { from: 0.02, to: 0.33, level: 0.05 },
    { from: 0.38, to: 0.97, level: 0.008 }, // just its edges, no readable text
  ])
  const d = detectPanelFromProfiles(p, W)
  assertEqual(d.hasPanel, true)
  assertBetween(d.cutFraction!, 0.33, 0.38)
})

test('cuts past a solid divider bar left of the card', () => {
  // Three real proofs carry a yellow bar between the panel and the card, and
  // one a white bar. A bar is a single flat colour, so it has no vertical
  // variation and both other profiles read it as empty margin — cutting at the
  // type left a bright stripe down the edge of the crop. Only its colour gives
  // it away.
  const p = build(
    [
      { from: 0.02, to: 0.33, level: 0.05 },
      { from: 0.45, to: 0.97, level: 0.02 },
    ],
    W,
    [{ from: 0.36, to: 0.4, level: 220 }], // the bar: bright, against tone 30
  )
  const d = detectPanelFromProfiles(p, W)
  assertEqual(d.hasPanel, true)
  // Must clear the bar's right-hand edge at 0.40, not stop at the type.
  assertBetween(d.cutFraction!, 0.4, 0.45)
})

// ── The profile itself ──────────────────────────────────────────────────────

test('a gradient carries no type; alternating rows are all type', () => {
  const w = 4
  const h = 40
  const rgba = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      // Columns 0–1: a smooth vertical gradient (a background). Each step is
      // ~6 levels — real change, but nothing like type.
      // Columns 2–3: alternating black/white rows, i.e. maximum-contrast type.
      const v = x < 2 ? Math.round((y / h) * 255) : y % 2 === 0 ? 0 : 255
      rgba[i] = rgba[i + 1] = rgba[i + 2] = v
      rgba[i + 3] = 255
    }
  }
  const { edge } = columnProfiles(rgba, w, h)
  assertEqual(edge[0], 0, `a gradient must register no type, got ${edge[0]}`)
  if (!(edge[2] > 0.9)) throw new Error(`type column should be near 1, got ${edge[2]}`)
})

test('a steep gradient still carries no type', () => {
  // The guard that matters for photographs: a hard vignette or a dramatic sky
  // changes fast, but it changes SMOOTHLY. Full black to full white down the
  // column in 40 rows is ~6 levels a row and must still score zero, or every
  // photographic background would start reading as panel.
  const w = 1
  const h = 40
  const rgba = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    const v = Math.round((y / (h - 1)) * 255)
    rgba[y * 4] = rgba[y * 4 + 1] = rgba[y * 4 + 2] = v
    rgba[y * 4 + 3] = 255
  }
  assertEqual(columnProfiles(rgba, w, h).edge[0], 0)
})

test('colour does not change the profile, only luminance structure does', () => {
  // A saturated flat fill must read as quiet — the blue and green panels are
  // the whole reason this is measured rather than thresholded on darkness.
  const w = 2
  const h = 20
  const rgba = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = 20
    rgba[i * 4 + 1] = 40
    rgba[i * 4 + 2] = 220
    rgba[i * 4 + 3] = 255
  }
  const p = columnProfiles(rgba, w, h).edge
  assertEqual(Math.round(p[0]), 0)
})

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
