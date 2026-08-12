// Find and remove the price panel from an old proof image.
//
// For over a decade Plasma's proofs were exported landscape with a panel down
// the left: the plasmadesign logo, the "Disclaimer - PLEASE READ CAREFULLY"
// block, and a PRICE GRID. Reusing one of those proofs today means cropping
// that panel off, which is currently a Photoshop action a designer runs by
// hand. This does the same job in the browser.
//
// ⚠ WHY A MISS MATTERS: the panel carries PRICES. A proof rebuilt from a 2017
// export still quotes 2017 money — in the wrong currency, on artwork we are
// asking a customer to approve today. So the failure that matters is not "we
// cropped badly", it is "we said there was no panel when there was". Every
// judgement below is biased accordingly: when the evidence is weak this reports
// `unsure` and lets a human look, and it never reports `clear` on a guess.
//
// TWO APPROACHES WERE MEASURED AND REJECTED. Both are the obvious ones, so they
// are recorded here to stop them being re-attempted:
//
//   1. "It is 16:9, therefore it has a panel."  Cheap, and right most of the
//      time, but it fails by WHOLE CATEGORIES rather than at random: of 19
//      acrylic/perspex proofs measured, 9 were not 16:9 and every one of those
//      9 carried a live price grid. The split was by date, not by chance —
//      acrylic proofs from September 2022 onward all break it. A letterpress
//      proof at a third ratio turned up carrying a full price grid too. Since
//      shape correlates with era and material rather than with the panel, a
//      shape test does not fail occasionally for the customers we care about;
//      it fails systematically.
//
//   2. "Find the dark gutter between the panel and the card."  This was written
//      and it produced FALSE NEGATIVES on real files, which is the dangerous
//      direction. Panels are not always on black: a bamboo proof sat on a blue
//      gradient and a steel one on green baize, and both were reported clean
//      while carrying a full disclaimer and a US-dollar price grid. On many
//      proofs there is no gutter at all — the panel text is overlaid directly
//      on the same background the card sits on, so there is no boundary to find.
//
// WHAT IS USED INSTEAD: the panel is TYPE. Not merely "detailed" — type, which
// is designed to be legible and so is built from high-contrast edges. Counting
// how many rows of each column contain a strong light/dark step finds it
// regardless of colour, brightness, or the image's shape.
//
// ⚠ Measuring AVERAGE detail per column instead is the near-miss, and it was
// tried: on a perspex proof shot on brown leather the average is flat right
// across the frame — the leather grain scores the same as the disclaimer — so
// there is no edge to find at all. Counting strong edges on that same image
// drops cleanly to zero at the panel's true edge. Two things follow, and both
// were measured rather than assumed:
//   · an AVERAGE is diluted by height. The disclaimer is wide and short and the
//     price grid is narrow and tall, so the columns holding only disclaimer
//     average out to nothing and the panel looks like it ends early — that is a
//     sliver of live price grid left on screen.
//   · texture is not type. Leather, fabric and paper grain all produce constant
//     small differences; only type produces large ones.
//
// The cut then lands just past where the type actually stops on THAT image
// rather than at a fixed fraction. Across 215 hand-labelled real proofs the
// true edge runs from 0.311 to 0.475 of the width, so a single fixed cut is
// wrong on most of them: 0.362 over-crops 98 and under-crops 60, in the worst
// case leaving 147 pixels of panel on screen.
//
// The pure functions take raw pixels so the exact code that runs in the browser
// can be run over that corpus in Node — see scripts/check-panel-crop.ts, which
// treats a missed panel as a hard failure.

/** How confident the detector is that it found the panel's true edge. */
export type PanelConfidence = 'clear' | 'unsure'

export interface PanelDetection {
  /** True when a price panel was found. False means "leave this image alone". */
  hasPanel: boolean
  /**
   * Column to cut at, in SOURCE pixels. Null when hasPanel is false.
   * Everything left of this is discarded.
   */
  cutX: number | null
  /** cutX as a fraction of width — the comparable figure across sizes. */
  cutFraction: number | null
  /**
   * 'clear'  — the panel's text, a quiet gap, and the card were all found
   *            cleanly, with room to spare on each.
   * 'unsure' — a panel is probably there but one of those was marginal. The
   *            crop is still offered; the UI must mark it for a closer look
   *            rather than letting it pass with the rest. A whole price grid is
   *            obvious at a glance, but a six-pixel sliver of one is not, which
   *            is exactly the case this flag exists for.
   */
  confidence: PanelConfidence
  /** Plain-English account of the decision, for the UI and for debugging. */
  reason: string
}

/**
 * How big a light/dark step counts as type rather than texture.
 *
 * Type is drawn to be read, so its edges are large steps — commonly the full
 * range between ink and paper. Leather grain, fabric, paper texture, film noise
 * and soft photographic gradients all sit far below this. 40 (of 255) leaves a
 * wide margin on both sides; the measured gap between the two populations is
 * much larger than the precision of this number, so it does not want tuning.
 */
const STRONG_DELTA = 40

/** How big a jump in column brightness marks the edge of a solid bar. */
const BAR_STEP = 25
/** How far past the type a divider bar may sit, and how wide it may be. */
const BAR_REACH_FRAC = 0.1

/** Both profiles for one image, computed in a single pass over the pixels. */
export interface ColumnProfiles {
  /** Per column: fraction of rows containing a type-sized light/dark step. */
  edge: number[]
  /**
   * Per column: mean brightness. Used only to find a solid divider BAR sitting
   * between the panel's type and the card.
   *
   * ⚠ Such a bar is invisible to both other profiles — it is one flat colour,
   * so it has no vertical variation at all and reads as empty margin. On four
   * real proofs (three with a yellow bar, one white) that left a bright stripe
   * down the left edge of the crop. It is still the panel, so it still has to
   * go, and the only thing that gives it away is that its colour differs
   * sharply from what sits either side.
   */
  tone: number[]
}

/**
 * Measure both column profiles.
 *
 * Comparing each pixel with the one ABOVE it is what makes this independent of
 * background: a fill or gradient changes little from row to row however dark,
 * bright or saturated it is, while type flips between ink and background every
 * few rows. That is why this works on the blue and green panels that defeated
 * the brightness-based attempt.
 *
 * Takes RGBA so the browser (canvas getImageData) and Node (imagescript) feed
 * it the identical buffer and get the identical answer.
 */
export function columnProfiles(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): ColumnProfiles {
  const edge = new Array<number>(width).fill(0)
  const tone = new Array<number>(width).fill(0)
  if (width < 2 || height < 2) return { edge, tone }

  // Rec. 601 luma with integer weights, so browser and Node agree exactly — a
  // float-rounding difference between them would make the corpus validation a
  // test of something other than what ships.
  const lum = new Float64Array(width * height)
  for (let i = 0, p = 0; i < width * height; i++, p += 4) {
    lum[i] = (rgba[p] * 299 + rgba[p + 1] * 587 + rgba[p + 2] * 114) / 1000
  }

  for (let x = 0; x < width; x++) {
    let strong = 0
    let level = lum[x]
    for (let y = 1; y < height; y++) {
      const v = lum[y * width + x]
      if (Math.abs(v - lum[(y - 1) * width + x]) > STRONG_DELTA) strong++
      level += v
    }
    edge[x] = strong / (height - 1)
    tone[x] = level / height
  }
  return { edge, tone }
}

// A column carries type when this share of its rows hold a type-sized step.
// One line of text crossing a column already gives two rows, so a real panel
// column clears this many times over; it exists to ignore the odd isolated
// step that JPEG ringing can manufacture beside a hard edge.
const TYPE_AT = 0.006
// A "panel" past half the width would be a different kind of document; the
// widest real one in the corpus sits at 0.475.
const MAX_PANEL_FRAC = 0.5
// Below this the block on the left is too narrow to be our disclaimer-and-
// price-grid; the narrowest real one measured is 0.311.
const MIN_PANEL_FRAC = 0.12
// The panel's type must begin near the left edge. Artwork that only starts
// carrying type further in is a card, not a panel.
const MAX_FIRST_INK_FRAC = 0.1
// Share of a candidate panel's columns that must carry type for it to be a
// solid block rather than a stray graphic.
const MIN_PANEL_DENSITY = 0.45
// The quiet run between the panel's last type and the card, as a fraction of
// width. Deliberately small: on proofs with no gutter this is only the panel's
// own right margin, and a narrow one still has to be found — it is flagged
// `unsure` rather than missed.
const MIN_GAP_FRAC = 0.008
const CLEAR_GAP_FRAC = 0.02
// How far past the panel's last type to cut, as a fraction of width. A small
// FIXED margin, not a share of the gap: the gap's length depends on where the
// card happens to sit, so scaling to it overshot by up to 12% of the width on
// proofs with a distant card, cutting into the artwork.
const CUT_MARGIN_FRAC = 0.006

/**
 * Decide whether an image's column profiles show a price panel, and where it
 * ends.
 *
 * The shape being looked for is three parts in order: a solid block of type
 * starting near the left edge, a quiet run, then the card. All three must be
 * present. An already-cropped proof fails at the first — its card starts
 * immediately, so there is no block of type before the quiet.
 */
export function detectPanelFromProfiles(profiles: ColumnProfiles, width: number): PanelDetection {
  const { edge, tone } = profiles
  const none = (reason: string): PanelDetection => ({
    hasPanel: false,
    cutX: null,
    cutFraction: null,
    confidence: 'clear',
    reason,
  })

  if (edge.length < 20 || width < 20) return none('Image too small to assess.')

  // A column counts as type when a small but real share of its rows carry a
  // type-sized step. One line of text crossing a column already gives two, so
  // this only has to clear image noise — JPEG ringing beside a hard edge can
  // manufacture the odd isolated one.
  const isType = (x: number) => edge[x] > TYPE_AT

  // The panel's type must START near the left edge.
  let first = -1
  for (let x = 0; x < width; x++) {
    if (isType(x)) {
      first = x
      break
    }
  }
  if (first < 0) return none('No type anywhere on the left — already cropped, or not a panelled proof.')
  if (first > width * MAX_FIRST_INK_FRAC) {
    return none('Left side carries no type — reads as artwork, not a panel.')
  }

  // Collect every quiet run long enough to be a margin, and try each as the
  // panel's right-hand edge in turn.
  //
  // Taking the FIRST such run is not enough on its own: a panel can have a
  // column of clear space inside it, which would end the panel far too early.
  // Nor can the last type in some fixed left-hand window be used — the card
  // usually starts well inside it and carries type of its own. So candidates
  // are tried in order and the first that yields a plausible panel with a real
  // card beyond it wins; a too-narrow candidate is skipped, not refused.
  const minGap = Math.max(2, Math.round(width * MIN_GAP_FRAC))
  const candidates: { end: number; gapStart: number; gapLen: number }[] = []
  let runStart = -1
  for (let x = first; x <= width; x++) {
    const quietHere = x === width ? true : !isType(x)
    if (quietHere) {
      if (runStart < 0) runStart = x
    } else if (runStart >= 0) {
      if (x - runStart >= minGap) candidates.push({ end: runStart - 1, gapStart: runStart, gapLen: x - runStart })
      runStart = -1
    }
  }
  if (runStart >= 0 && width - runStart >= minGap) {
    candidates.push({ end: runStart - 1, gapStart: runStart, gapLen: width - runStart })
  }

  let skipped = ''
  for (const c of candidates) {
    const panelFrac = (c.end + 1) / width
    if (panelFrac < MIN_PANEL_FRAC) {
      skipped = 'narrow'
      continue // A sliver at the edge, or a gap inside the panel. Keep looking.
    }
    if (panelFrac > MAX_PANEL_FRAC) break // Past anything that could be our panel.

    // Density: the panel is type from top to bottom of the image, so most of
    // its columns carry some. A clipped graphic gives a few and a lot of
    // nothing.
    let typeCols = 0
    for (let x = first; x <= c.end; x++) if (isType(x)) typeCols++
    const span = Math.max(1, c.end - first + 1)
    if (typeCols / span < MIN_PANEL_DENSITY) {
      skipped = 'patchy'
      continue
    }

    // The card must actually be there, or a left-aligned block of type on an
    // otherwise empty page — a letterhead — would be cropped to blank paper.
    //
    // Asking for type is enough, and that is worth stating because it looks too
    // strict: a card's artwork might carry no readable text at all. But a card
    // is a physical object against a background, and its own boundary is a
    // type-sized step, so it registers either way. Checked against the corpus —
    // a version that additionally accepted "livelier than the margin beside it"
    // classified all 213 images identically, so the extra clause was carrying
    // nothing and is not here.
    const cardStart = c.gapStart + c.gapLen
    let cardType = false
    for (let x = cardStart; x < width; x++) {
      if (isType(x)) {
        cardType = true
        break
      }
    }
    if (cardStart >= width || !cardType) {
      skipped = 'nocard'
      continue
    }

    // Cut just past where the type stops — a small FIXED margin, not a share of
    // the gap. The gap's length depends on the artwork behind it, so scaling
    // the cut to it overshot by up to 12% of the width on proofs whose card
    // sits far from the panel, eating into the card.
    const margin = Math.max(2, Math.round(width * CUT_MARGIN_FRAC))
    let cutX = Math.min(cardStart - 1, c.end + margin)

    // Step past a solid divider bar if one sits just beyond the type. Its own
    // colour makes it invisible to the other two profiles, so it is found by
    // the sharp change in column brightness at its far side. Bounded hard —
    // only just past the type, only a short way — so this can never wander
    // into the artwork looking for a jump that is really the card's edge.
    const reach = Math.min(cardStart - 1, c.end + Math.round(width * BAR_REACH_FRAC))
    for (let x = reach - 1; x > c.end; x--) {
      if (Math.abs(tone[x] - tone[x + 1]) > BAR_STEP) {
        cutX = Math.min(cardStart - 1, x + 1 + margin)
        break
      }
    }
    const clear = c.gapLen >= Math.round(width * CLEAR_GAP_FRAC) && typeCols / span >= 0.6
    return {
      hasPanel: true,
      cutX,
      cutFraction: cutX / width,
      confidence: clear ? 'clear' : 'unsure',
      reason: clear
        ? `Panel type from ${Math.round((first / width) * 100)}% to ${Math.round(panelFrac * 100)}%, then a clear margin before the card.`
        : `Panel type found to ${Math.round(panelFrac * 100)}%, but the margin before the card is narrow — worth a closer look.`,
    }
  }

  if (candidates.length === 0) {
    return none('The left-hand type runs straight into the artwork with no margin — reads as one image.')
  }
  return none(
    skipped === 'nocard'
      ? 'Nothing substantial to the right of the gap — no card to keep.'
      : skipped === 'patchy'
        ? 'Type on the left is patchy — not a solid block of panel text.'
        : 'The block on the left is too narrow to be the price panel.',
  )
}

// ── Browser layer ───────────────────────────────────────────────────────────
// Thin on purpose: everything above is decided from a number array, so the
// corpus validation exercises the real logic rather than a re-implementation.

/**
 * Width the profiles are computed at, as a cap rather than a target.
 *
 * ⚠ Do NOT lower this to speed things up. Type is found by the SIZE of the
 * light/dark step across a row boundary, and downsampling blends ink with
 * background: shrink a 1280-wide proof to 480 and the disclaimer's crisp black-
 * on-white steps average into greys that fall under the threshold, so the panel
 * stops looking like type. Most proofs are 1280 wide and are read at their own
 * resolution; the cap only bites on the occasional 1700–1800px export, which
 * still leaves type far above the threshold. A megapixel of arithmetic is a few
 * milliseconds and runs once per dropped image.
 */
const WORK_WIDTH = 1400

async function loadBitmap(blob: Blob): Promise<ImageBitmap | null> {
  try {
    return await createImageBitmap(blob)
  } catch {
    return null
  }
}

/** Detect the panel in an image. Returns a no-panel result on any failure. */
export async function detectProofPanel(blob: Blob): Promise<PanelDetection> {
  const bitmap = await loadBitmap(blob)
  if (!bitmap) {
    return {
      hasPanel: false,
      cutX: null,
      cutFraction: null,
      confidence: 'unsure',
      // Deliberately 'unsure' rather than 'clear': we did not establish that
      // there is no panel, we failed to look. Reporting a confident "no panel"
      // for an image we never read is precisely how a price grid reaches a
      // customer.
      reason: "Could not read that image, so it has not been checked for a panel.",
    }
  }
  const w = Math.min(WORK_WIDTH, bitmap.width)
  const h = Math.max(1, Math.round((bitmap.height / bitmap.width) * w))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) {
    bitmap.close?.()
    return { hasPanel: false, cutX: null, cutFraction: null, confidence: 'unsure', reason: 'Could not read that image.' }
  }
  ctx.drawImage(bitmap, 0, 0, w, h)
  const { data } = ctx.getImageData(0, 0, w, h)
  const detection = detectPanelFromProfiles(columnProfiles(data, w, h), w)
  const full = bitmap.width
  bitmap.close?.()
  // Scale the cut back up to source pixels — the crop is applied to the
  // original, never to the downscaled copy.
  return detection.cutFraction == null
    ? detection
    : { ...detection, cutX: Math.round(detection.cutFraction * full) }
}

/**
 * Quality the crop is re-encoded at.
 *
 * High, because the QR scanner reads these same images afterwards and
 * generational JPEG artefacts are what stop a dense code decoding. At 0.95 on a
 * pure crop — no resize, no resample — the difference is negligible.
 */
const JPEG_QUALITY = 0.95

/**
 * Hand back an image the artwork drop zone will accept.
 *
 * A JPEG passes through untouched — the overwhelmingly common case, and
 * re-encoding it would cost a generation for nothing. Anything else is
 * converted, because the drop zone takes `image/jpeg` only and would otherwise
 * refuse it. The archive is nearly all JPEG, but the shortlist accepts .png
 * too, so this is the difference between a rare file importing and it silently
 * failing.
 */
export async function asAcceptableImage(blob: Blob, filename: string): Promise<File | null> {
  const name = filename.replace(/\.(jpe?g|png|webp)$/i, '')
  if (blob.type === 'image/jpeg') return new File([blob], `${name}.jpg`, { type: 'image/jpeg' })

  const bitmap = await loadBitmap(blob)
  if (!bitmap) return null
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    bitmap.close?.()
    return null
  }
  // White behind it: a transparent PNG flattened onto the default transparent
  // canvas comes out BLACK in a JPEG, which would look like ruined artwork
  // rather than a format conversion.
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close?.()
  const out = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((b) => resolve(b), 'image/jpeg', JPEG_QUALITY),
  )
  return out ? new File([out], `${name}.jpg`, { type: 'image/jpeg' }) : null
}

/**
 * Crop everything left of `cutX` (source pixels) and return it as a File.
 *
 * ⚠ JPEG, and it must stay JPEG. The version form's artwork drop zone accepts
 * `image/jpeg` ONLY (ACCEPTED_TYPES in NewVersionPage), so a PNG here is
 * silently refused with "Only image files can be added" and the import appears
 * to do nothing — which is exactly what it did on its first real use. That
 * restriction is deliberate rather than an oversight: migration 000335 widened
 * the storage bucket to PNG for the QR scanner's few-KB code images, and the
 * drop zones were left JPEG-only so full-size artwork could not arrive as a
 * multi-megabyte PNG on the customer's proof page.
 *
 * The re-encode costs one JPEG generation, and it is worth being precise about
 * why that is acceptable: these images arrive from Dropbox already JPEG-
 * compressed, so this is generation one to two, not zero to one, and every
 * other proof image on the customer page has the same history.
 */
export async function cropProofPanel(blob: Blob, cutX: number, filename = 'proof.jpg'): Promise<File | null> {
  const bitmap = await loadBitmap(blob)
  if (!bitmap) return null
  const x = Math.max(0, Math.min(bitmap.width - 1, Math.round(cutX)))
  const w = bitmap.width - x
  const h = bitmap.height
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    bitmap.close?.()
    return null
  }
  ctx.drawImage(bitmap, x, 0, w, h, 0, 0, w, h)
  bitmap.close?.()
  const out = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((b) => resolve(b), 'image/jpeg', JPEG_QUALITY),
  )
  if (!out) return null
  const name = filename.replace(/\.(jpe?g|png|webp)$/i, '') + '.jpg'
  return new File([out], name, { type: 'image/jpeg' })
}
