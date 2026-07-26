// Pure annotation types, constants and coordinate maths — no Supabase client,
// so this module is unit-testable headlessly (see proofAnnotations.test.ts).
// Data access lives in proofAnnotations.ts, which re-exports everything here.
//
// See docs/proof-annotation-proposal.md for the product reasoning; the header of
// proofAnnotations.ts carries the presentation rule this all serves.

export type AnnotationSide = 'front' | 'back'
export type AnnotationAuthorKind = 'designer' | 'customer'

/** A note as stored. Coordinates are fractions of the image box — see below. */
export interface ProofAnnotation {
  id: string
  proof_version_id: string
  proof_version_image_id: string | null
  side: AnnotationSide | null
  associated_name: string | null
  x: number
  y: number
  body: string
  author_kind: AnnotationAuthorKind
  created_by: string | null
  author_name: string | null
  proof_event_id: string | null
  resolved_at: string | null
  resolved_by: string | null
  created_at: string
}

/** The trimmed shape the anon RPC returns to the customer page. */
export interface CustomerCallout {
  id: string
  proof_version_image_id: string | null
  side: AnnotationSide | null
  associated_name: string | null
  x: number
  y: number
  body: string
  author_name: string | null
  created_at: string
}

/** A pin the customer has placed but not yet submitted. */
export interface DraftPin {
  /** Client-only id so React keys and removal work before the row exists. */
  localId: string
  imageId: string | null
  side: AnnotationSide | null
  associatedName: string | null
  x: number
  y: number
  body: string
}

export const MAX_PINS_PER_REQUEST = 8
export const MAX_ANNOTATION_BODY = 600

// ── Coordinates ──────────────────────────────────────────────────────────────
//
// Positions are normalised 0–1 fractions of the image's own box, never pixels.
//
// This works — with no naturalWidth/naturalHeight maths and no stored image
// dimensions — because of how proof images are styled. In the zoom view the
// <img> is `max-h-full max-w-full object-contain` with width and height both
// auto; in the grid it is `w-full object-contain` with height auto. In both
// cases a replaced element with auto dimensions fits inside its max constraints
// preserving aspect ratio, so the element box *is* the painted image and
// object-contain letterboxes nothing.
//
// getBoundingClientRect() also reports the POST-transform rect, so the same
// division holds at any pinch-zoom or pan without inverting the transform.
//
// If anyone ever restyles a proof image to `w-full h-full object-contain`, both
// of those properties break at once and real letterboxing appears. That is the
// one change that would invalidate this function.

/**
 * Clamp to the unit interval so a drag past the edge still stores a valid point.
 *
 * NaN is special-cased to 0 because it has no position at all, and letting it
 * through would render a marker at "NaN%" — silently invisible — or fail the
 * numeric cast on insert. ±Infinity needs no special case: min/max clamp it to
 * the near edge, which is what "miles off to the left" should mean.
 */
export function clampUnit(n: number): number {
  if (Number.isNaN(n)) return 0
  return Math.min(1, Math.max(0, n))
}

/** Convert a pointer position over an image element into 0–1 fractions. */
export function pointToFraction(
  el: HTMLElement,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const r = el.getBoundingClientRect()
  if (r.width <= 0 || r.height <= 0) return { x: 0.5, y: 0.5 }
  return {
    x: clampUnit((clientX - r.left) / r.width),
    y: clampUnit((clientY - r.top) / r.height),
  }
}

/**
 * CSS for a cropped detail thumbnail centred on a note's anchor.
 *
 * The crop is the same image scaled up, positioned by percentage — no canvas,
 * no second file, nothing stored. Percentage background-position aligns the
 * X% point of the image with the X% point of the box, which also clamps
 * sensibly at the edges (a note near a corner shows the corner rather than
 * empty space) without any special-casing.
 */
export function cropStyle(
  url: string,
  x: number,
  y: number,
  zoom = 3.3,
): { backgroundImage: string; backgroundSize: string; backgroundPosition: string; backgroundRepeat: string } {
  return {
    backgroundImage: `url("${url}")`,
    backgroundSize: `${Math.round(zoom * 100)}%`,
    backgroundPosition: `${(clampUnit(x) * 100).toFixed(2)}% ${(clampUnit(y) * 100).toFixed(2)}%`,
    backgroundRepeat: 'no-repeat',
  }
}

/**
 * Where to draw a marker for an anchor: exactly on it.
 *
 * This deliberately does NOT displace the dot. An earlier version nudged it 4%
 * away so it could not cover the detail it pointed at, and that was a mistake in
 * two ways. In the authoring view the dot landed away from the designer's own
 * click, so they would compensate by aiming off-target and store a coordinate
 * that pointed at the wrong thing. And a displaced dot points at nothing
 * precisely, which is the whole job.
 *
 * The problem it was solving is real but belongs to whoever places the pin: put
 * it beside the detail, not on top of it. If covering ever becomes a genuine
 * complaint the answer is a translucent or smaller dot, not moving it.
 *
 * Callers pair this with translate(-50%, -50%) so the dot is centred on the
 * point rather than hanging off its corner.
 */
export function markerPosition(x: number, y: number): { left: string; top: string } {
  return {
    left: `${(clampUnit(x) * 100).toFixed(2)}%`,
    top: `${(clampUnit(y) * 100).toFixed(2)}%`,
  }
}

// ── Presentation helpers ─────────────────────────────────────────────────────

/**
 * The customer-facing strip label.
 *
 * Names the designer rather than saying "your designer": a named person who
 * made something reads as craft, where an anonymous system note reads as a
 * caveat. The name arrives denormalised on the row, so this needs no join.
 */
export function calloutStripLabel(callouts: Pick<CustomerCallout, 'author_name'>[]): string {
  if (callouts.length === 0) return ''
  const names = Array.from(
    new Set(callouts.map((c) => (c.author_name ?? '').trim()).filter(Boolean)),
  )
  const who = names.length === 1 ? ` from ${names[0]}` : ''
  return callouts.length === 1 ? `A note${who}` : `${callouts.length} notes${who}`
}

/** Group annotations by the image they sit on, preserving order. */
export function groupByImage<T extends { proof_version_image_id: string | null }>(
  items: T[],
): Map<string | null, T[]> {
  const out = new Map<string | null, T[]>()
  for (const item of items) {
    const key = item.proof_version_image_id
    const list = out.get(key)
    if (list) list.push(item)
    else out.set(key, [item])
  }
  return out
}
