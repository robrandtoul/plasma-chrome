// Tests for the annotation coordinate maths (migration 000347).
//
// This is the load-bearing part of the feature: get it wrong and a customer's
// pin points at the wrong bit of their card, which is worse than having no pin
// at all. The maths is deliberately in a Supabase-free module so it can be
// checked headlessly.

import assert from 'node:assert/strict'
import {
  calloutStripLabel,
  clampUnit,
  cropStyle,
  groupByImage,
  markerPosition,
  numberCustomerPins,
  pinsForEvent,
  pinsOnImage,
  pointToFraction,
  unresolvedCount,
  type ProofAnnotation,
} from './proofAnnotationGeometry'

let passed = 0
function test(name: string, fn: () => void) {
  fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

/** Stand-in for an <img>: only getBoundingClientRect is consulted. */
function elementAt(left: number, top: number, width: number, height: number) {
  return {
    getBoundingClientRect: () => ({ left, top, width, height }),
  } as unknown as HTMLElement
}

console.log('proofAnnotationGeometry')

// ── clampUnit ────────────────────────────────────────────────────────────────

test('clampUnit keeps in-range values untouched', () => {
  assert.equal(clampUnit(0), 0)
  assert.equal(clampUnit(0.42), 0.42)
  assert.equal(clampUnit(1), 1)
})

test('clampUnit pins out-of-range values to the unit interval', () => {
  assert.equal(clampUnit(-3), 0)
  assert.equal(clampUnit(9), 1)
})

test('clampUnit sends NaN to zero but clamps infinities to the near edge', () => {
  // A NaN would reach the DB as a failed numeric cast, or worse render a marker
  // at "NaN%" — silently invisible. Fail to a corner instead.
  assert.equal(clampUnit(Number.NaN), 0)
  assert.equal(clampUnit(Number.POSITIVE_INFINITY), 1)
})

// ── pointToFraction ──────────────────────────────────────────────────────────

test('pointToFraction maps a centre click to the middle', () => {
  const el = elementAt(100, 50, 400, 200)
  const { x, y } = pointToFraction(el, 300, 150)
  assert.equal(x, 0.5)
  assert.equal(y, 0.5)
})

test('pointToFraction maps the corners to 0 and 1', () => {
  const el = elementAt(100, 50, 400, 200)
  assert.deepEqual(pointToFraction(el, 100, 50), { x: 0, y: 0 })
  assert.deepEqual(pointToFraction(el, 500, 250), { x: 1, y: 1 })
})

test('pointToFraction is invariant to zoom, because the rect is post-transform', () => {
  // The whole reason no naturalWidth maths is needed: getBoundingClientRect()
  // already includes the CSS transform, so a 2x-zoomed image reports a 2x rect
  // and the same physical point on the artwork yields the same fraction.
  const unzoomed = elementAt(0, 0, 400, 200)
  const zoomed = elementAt(-200, -100, 800, 400) // same centre, scaled 2x
  assert.deepEqual(pointToFraction(unzoomed, 100, 50), pointToFraction(zoomed, 0, 0))
})

test('pointToFraction clamps a drag beyond the edge instead of storing >1', () => {
  const el = elementAt(0, 0, 400, 200)
  assert.deepEqual(pointToFraction(el, 900, -40), { x: 1, y: 0 })
})

test('pointToFraction falls back to the centre on a zero-sized element', () => {
  // Happens if the image has not laid out yet; dividing by zero would give
  // Infinity, and a pin at a corner would be a lie about where they tapped.
  assert.deepEqual(pointToFraction(elementAt(0, 0, 0, 0), 10, 10), { x: 0.5, y: 0.5 })
})

// ── cropStyle ────────────────────────────────────────────────────────────────

test('cropStyle scales the image up and positions it by percentage', () => {
  const s = cropStyle('https://example.test/a.jpg', 0.25, 0.75, 3)
  assert.equal(s.backgroundImage, 'url("https://example.test/a.jpg")')
  assert.equal(s.backgroundSize, '300%')
  assert.equal(s.backgroundPosition, '25.00% 75.00%')
  assert.equal(s.backgroundRepeat, 'no-repeat')
})

test('cropStyle clamps its position, so an edge note shows the edge', () => {
  const s = cropStyle('u', -1, 4)
  assert.equal(s.backgroundPosition, '0.00% 100.00%')
})

// ── markerPosition ───────────────────────────────────────────────────────────

test('markerPosition draws exactly on the anchor, never displaced', () => {
  // A displaced dot points at nothing precisely, and in the authoring view it
  // lands away from the designer's own click — so they aim off-target and store
  // a coordinate that means the wrong thing. Reported from live use.
  const p = markerPosition(0.2, 0.3)
  assert.equal(p.left, '20.00%')
  assert.equal(p.top, '30.00%')
})

test('markerPosition does not displace near an edge either', () => {
  assert.deepEqual(markerPosition(0.9, 0.95), { left: '90.00%', top: '95.00%' })
  assert.deepEqual(markerPosition(0, 1), { left: '0.00%', top: '100.00%' })
})

test('a click round-trips to a marker on the same spot', () => {
  // What "the pin lands under my cursor" means, end to end: the fraction taken
  // from a click must render back to the same percentage of the image.
  const el = elementAt(0, 0, 400, 250)
  const { x, y } = pointToFraction(el, 100, 200)   // a quarter across, 4/5 down
  const marker = markerPosition(x, y)
  assert.equal(marker.left, '25.00%')
  assert.equal(marker.top, '80.00%')
})

// ── calloutStripLabel ────────────────────────────────────────────────────────

test('calloutStripLabel names a single designer', () => {
  assert.equal(calloutStripLabel([{ author_name: 'Rob' }]), 'A note from Rob')
})

test('calloutStripLabel pluralises and keeps one shared name', () => {
  assert.equal(
    calloutStripLabel([{ author_name: 'Rob' }, { author_name: 'Rob' }]),
    '2 notes from Rob',
  )
})

test('calloutStripLabel drops the name when two designers contributed', () => {
  // "2 notes from Rob" would be wrong if Chris wrote one of them, and listing
  // both names makes the strip read like a committee.
  assert.equal(
    calloutStripLabel([{ author_name: 'Rob' }, { author_name: 'Chris' }]),
    '2 notes',
  )
})

test('calloutStripLabel copes with a missing author name', () => {
  assert.equal(calloutStripLabel([{ author_name: null }]), 'A note')
  assert.equal(calloutStripLabel([{ author_name: '  ' }]), 'A note')
})

test('calloutStripLabel is empty with no callouts, so nothing renders', () => {
  assert.equal(calloutStripLabel([]), '')
})

// ── groupByImage ─────────────────────────────────────────────────────────────

test('groupByImage buckets by image and preserves order within a bucket', () => {
  const grouped = groupByImage([
    { proof_version_image_id: 'a', n: 1 },
    { proof_version_image_id: 'b', n: 2 },
    { proof_version_image_id: 'a', n: 3 },
  ])
  assert.deepEqual(grouped.get('a')?.map((r) => r.n), [1, 3])
  assert.deepEqual(grouped.get('b')?.map((r) => r.n), [2])
})

test('groupByImage keeps unanchored notes under a null key', () => {
  const grouped = groupByImage([{ proof_version_image_id: null, n: 1 }])
  assert.deepEqual(grouped.get(null)?.map((r) => r.n), [1])
})

// ── Pin numbering ────────────────────────────────────────────────────────────
//
// The numbering is what lets the strip, the thumbnail marker and the editor
// checklist refer to the same pin. These tests pin that agreement.

/** Minimal annotation row; only the fields the numbering reads are meaningful. */
function ann(over: Partial<ProofAnnotation>): ProofAnnotation {
  return {
    id: 'id',
    proof_version_id: 'v1',
    proof_version_image_id: null,
    side: null,
    associated_name: null,
    x: 0.5,
    y: 0.5,
    body: 'note',
    author_kind: 'customer',
    created_by: null,
    author_name: 'Dean',
    proof_event_id: null,
    resolved_at: null,
    resolved_by: null,
    created_at: '2026-07-28T10:09:20.000Z',
    ...over,
  }
}

test('numberCustomerPins ignores designer callouts when numbering', () => {
  // A designer note sitting between two pins must not consume a number, or the
  // strip and the editor checklist drift apart the moment anyone writes one.
  const numbered = numberCustomerPins([
    ann({ id: 'p1' }),
    ann({ id: 'd1', author_kind: 'designer' }),
    ann({ id: 'p2' }),
  ])
  assert.deepEqual(
    numbered.map((n) => [n.pin.id, n.number]),
    [
      ['p1', 1],
      ['p2', 2],
    ],
  )
})

test('numberCustomerPins keeps numbering across change requests', () => {
  // Second request continues at 3 rather than restarting — see the module note.
  const numbered = numberCustomerPins([
    ann({ id: 'p1', proof_event_id: 'e1' }),
    ann({ id: 'p2', proof_event_id: 'e1' }),
    ann({ id: 'p3', proof_event_id: 'e2' }),
  ])
  assert.deepEqual(pinsForEvent(numbered, 'e2').map((n) => n.number), [3])
})

test('pinsForEvent returns nothing for a request that carried no pins', () => {
  const numbered = numberCustomerPins([ann({ id: 'p1', proof_event_id: 'e1' })])
  assert.deepEqual(pinsForEvent(numbered, 'e2'), [])
  assert.deepEqual(pinsForEvent(numbered, null), [])
})

test('pinsOnImage matches on image id', () => {
  const numbered = numberCustomerPins([
    ann({ id: 'p1', proof_version_image_id: 'img-back', side: 'back' }),
    ann({ id: 'p2', proof_version_image_id: 'img-front', side: 'front' }),
  ])
  assert.deepEqual(
    pinsOnImage(numbered, { id: 'img-back', side: 'back' }).map((n) => n.pin.id),
    ['p1'],
  )
})

test('pinsOnImage falls back to side when a pin lost its image anchor', () => {
  // proof_version_image_id is ON DELETE SET NULL, so re-uploading artwork
  // orphans the anchor. The pin must still show on the face it was placed on.
  const numbered = numberCustomerPins([ann({ id: 'p1', proof_version_image_id: null, side: 'back' })])
  assert.deepEqual(
    pinsOnImage(numbered, { id: 'img-back', side: 'back' }).map((n) => n.pin.id),
    ['p1'],
  )
  assert.deepEqual(pinsOnImage(numbered, { id: 'img-front', side: 'front' }), [])
})

test('pinsOnImage drops a pin with neither an image id nor a side', () => {
  // Nowhere honest to draw it. The strip still lists it.
  const numbered = numberCustomerPins([ann({ id: 'p1', proof_version_image_id: null, side: null })])
  assert.deepEqual(pinsOnImage(numbered, { id: 'img-front', side: 'front' }), [])
})

test('unresolvedCount counts only pins not yet ticked off', () => {
  const numbered = numberCustomerPins([
    ann({ id: 'p1' }),
    ann({ id: 'p2', resolved_at: '2026-07-28T11:00:00.000Z' }),
  ])
  assert.equal(unresolvedCount(numbered), 1)
})

console.log(`\n${passed} passed`)
