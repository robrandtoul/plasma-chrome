// Unit tests for approvalCarry.ts
// Run with: npx tsx src/lib/approvalCarry.test.ts
//
// The rule that decides whether a customer's sign-off survives into the next
// version. Getting this wrong in the permissive direction records someone as
// having approved artwork they never saw, so the cases below lean on the
// "must NOT carry" side as much as the happy path.
//
// The headline case is the last block: a one-recipient card gaining a
// colleague. That's the shape that sent a real proof (Renewafuel, v5→v6) to
// the dashboard flagged as "approved a non-current version" — the common
// front had to move from the sole recipient's slot into the shared slot, and
// the approval was dropped on the floor.

import {
  approvalCarriesForSlot,
  slotsNeedingReapproval,
  type CarrySlotImage,
} from './approvalCarry.ts'
import { SHARED_APPROVAL_KEY } from './types.ts'

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

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message)
}

function assertEquals(actual: string[], expected: string[], label: string) {
  const a = actual.join(',')
  const e = expected.join(',')
  if (a !== e) throw new Error(`${label}: expected [${e}], got [${a}]`)
}

// ── Fixture builder ───────────────────────────────────────────────────────────

function img(
  rowId: string,
  assoc: string | null,
  overrides: Partial<CarrySlotImage> = {},
): CarrySlotImage {
  return {
    rowId,
    assoc,
    kept: true,
    replaced: false,
    landsInValidSlot: true,
    ...overrides,
  }
}

// ── approvalCarriesForSlot ────────────────────────────────────────────────────

console.log('\napprovalCarriesForSlot')

test('carries when the slot is untouched', () => {
  const images = [img('front', 'Robert Bradley'), img('back', 'Robert Bradley')]
  assert(
    approvalCarriesForSlot('Robert Bradley', images, []),
    'an unchanged slot should carry',
  )
})

test('carries when a DIFFERENT person\'s artwork changed', () => {
  const images = [
    img('rob-back', 'Robert Bradley'),
    img('kelly-back', 'Kelly Wiltshire', { replaced: true }),
  ]
  assert(
    approvalCarriesForSlot('Robert Bradley', images, ['Kelly Wiltshire']),
    "Kelly's redraw must not cost Robert his approval",
  )
  assert(
    !approvalCarriesForSlot('Kelly Wiltshire', images, ['Kelly Wiltshire']),
    'Kelly herself must re-approve',
  )
})

test('does not carry when an image was replaced', () => {
  const images = [img('back', 'Robert Bradley', { replaced: true })]
  assert(
    !approvalCarriesForSlot('Robert Bradley', images, []),
    'replaced artwork must be re-approved',
  )
})

test('does not carry when the designer unticked Keep', () => {
  const images = [img('back', 'Robert Bradley', { kept: false })]
  assert(
    !approvalCarriesForSlot('Robert Bradley', images, []),
    'a dropped image must be re-approved',
  )
})

test('does not carry when an image is orphaned by a shape change', () => {
  const images = [img('back', 'Robert Bradley', { landsInValidSlot: false })]
  assert(
    !approvalCarriesForSlot('Robert Bradley', images, []),
    'an image with nowhere to land must be re-approved',
  )
})

test('does not carry when a fresh file lands in the slot', () => {
  const images = [img('back', 'Robert Bradley')]
  assert(
    !approvalCarriesForSlot('Robert Bradley', images, ['Robert Bradley']),
    'a new upload into the slot must be re-approved',
  )
})

test('a person with only unchanged shared artwork still carries', () => {
  assert(
    approvalCarriesForSlot('Kelly Wiltshire', [img('front', null)], []),
    'nothing they can see has changed',
  )
})

test('a slot with no images at all carries', () => {
  // Vacuously "all unchanged". Guards against a regression where .every()
  // on an empty list gets special-cased away.
  assert(
    approvalCarriesForSlot('Kelly Wiltshire', [], []),
    'an empty slot has nothing that could have changed',
  )
})

test('the shared sentinel is keyed on unassigned images', () => {
  const images = [img('front', null, { replaced: true }), img('back', 'Robert Bradley')]
  assert(
    !approvalCarriesForSlot(SHARED_APPROVAL_KEY, images, []),
    'a replaced shared image must be re-approved under the shared key',
  )
})

test('a fresh SHARED upload does not carry the shared slot', () => {
  assert(
    !approvalCarriesForSlot(SHARED_APPROVAL_KEY, [img('front', null)], [null]),
    'a new shared image must be re-approved under the shared key',
  )
})

// ── Shared artwork is part of what a recipient approved ───────────────────────
//
// The shared front prints on EVERY card, so changing it invalidates every
// recipient's approval — not just the shared sentinel's. Keying a named slot
// on that person's own images alone was a real hole: the front could be
// swapped for something else and everybody stayed marked as having
// approved it.

console.log('\nshared artwork counts toward every recipient')

test('a replaced SHARED front costs every recipient their approval', () => {
  const images = [
    img('front', null, { replaced: true }),
    img('rob-back', 'Robert Bradley'),
    img('kelly-back', 'Kelly Wiltshire'),
  ]
  assert(
    !approvalCarriesForSlot('Robert Bradley', images, []),
    'Robert sees the shared front, so a redraw of it must be re-approved',
  )
  assert(
    !approvalCarriesForSlot('Kelly Wiltshire', images, []),
    'and so does Kelly',
  )
})

test('a dropped SHARED front costs every recipient their approval', () => {
  const images = [img('front', null, { kept: false }), img('rob-back', 'Robert Bradley')]
  assert(
    !approvalCarriesForSlot('Robert Bradley', images, []),
    'removing the shared front changes what Robert approved',
  )
})

test('a SHARED front orphaned by a shape change costs every recipient', () => {
  // Turning Shared off leaves the shared front with nowhere to land; each
  // recipient needs a per-name front instead, which is artwork they have
  // not seen.
  const images = [
    img('front', null, { landsInValidSlot: false }),
    img('rob-back', 'Robert Bradley'),
  ]
  assert(
    !approvalCarriesForSlot('Robert Bradley', images, []),
    'an orphaned shared front must be re-approved',
  )
})

test('a fresh SHARED upload costs every recipient their approval', () => {
  const images = [img('rob-back', 'Robert Bradley'), img('kelly-back', 'Kelly Wiltshire')]
  assert(
    !approvalCarriesForSlot('Robert Bradley', images, [null]),
    'a new shared image is something Robert has not seen',
  )
  assert(
    !approvalCarriesForSlot('Kelly Wiltshire', images, [null]),
    'and Kelly has not seen it either',
  )
})

test('the shared sentinel is NOT disturbed by one recipient\'s artwork changing', () => {
  // The mirror of the rule above — widening it in both directions would
  // make a recipient's private back-of-card invalidate the shared slot,
  // which is not something the shared approval was ever a statement about.
  const images = [img('front', null), img('rob-back', 'Robert Bradley', { replaced: true })]
  assert(
    approvalCarriesForSlot(SHARED_APPROVAL_KEY, images, ['Robert Bradley']),
    "the shared artwork is unchanged by Robert's redraw",
  )
})

// ── slotsNeedingReapproval ────────────────────────────────────────────────────

console.log('\nslotsNeedingReapproval')

test('returns only the slots that lost their approval, in roster order', () => {
  const images = [
    img('rob-back', 'Robert Bradley'),
    img('kelly-back', 'Kelly Wiltshire', { replaced: true }),
    img('sue-back', 'Sue Baker'),
  ]
  assertEquals(
    slotsNeedingReapproval(
      ['Robert Bradley', 'Kelly Wiltshire', 'Sue Baker'],
      images,
      [],
    ),
    ['Kelly Wiltshire'],
    'only Kelly',
  )
})

test('returns nothing when every approval carries', () => {
  const images = [img('rob-back', 'Robert Bradley')]
  assertEquals(slotsNeedingReapproval(['Robert Bradley'], images, []), [], 'none')
})

test('only considers slots that were actually approved', () => {
  // Kelly never approved, so she is not "losing" anything and must not be
  // named in a warning about lost approvals.
  const images = [img('kelly-back', 'Kelly Wiltshire', { replaced: true })]
  assertEquals(slotsNeedingReapproval([], images, []), [], 'nobody approved')
})

// ── The headline case: one recipient gains a colleague ────────────────────────

console.log('\none-recipient card gains a colleague (Renewafuel v5 → v6)')

test('the sole recipient keeps their approval when the shared front moves slots', () => {
  // v5 had one name, so there was no shared slot and the common front hung
  // off Robert's name. v6 adds Kelly, the shared slot comes back, and the
  // front collapses into it — same stored file, so it still counts as
  // landing validly and Robert has seen everything on his card.
  const images = [
    img('front', 'Robert Bradley'), // collapses to shared on v6
    img('rob-back', 'Robert Bradley'),
  ]
  assert(
    approvalCarriesForSlot('Robert Bradley', images, ['Kelly Wiltshire']),
    'adding a colleague must not cost the first recipient their approval',
  )
})

test('...but a genuinely re-uploaded front still costs them it', () => {
  // The pre-fix behaviour, and still the correct answer when the front is a
  // NEW file rather than the same one moving slots.
  const images = [
    img('front', 'Robert Bradley', { replaced: true }),
    img('rob-back', 'Robert Bradley'),
  ]
  assert(
    !approvalCarriesForSlot('Robert Bradley', images, ['Kelly Wiltshire']),
    'a redrawn front must be re-approved',
  )
})

test('the incoming colleague is never treated as already approved', () => {
  const images = [img('front', 'Robert Bradley'), img('rob-back', 'Robert Bradley')]
  assertEquals(
    slotsNeedingReapproval(['Robert Bradley'], images, ['Kelly Wiltshire']),
    [],
    'Robert carries; Kelly was never approved so is not listed',
  )
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
