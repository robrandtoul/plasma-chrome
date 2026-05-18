// Unit tests for qrCarryForward.ts
// Run with: npx tsx src/lib/qrCarryForward.test.ts
//
// Covers the two pure functions that drive the new-version form's
// QR auto-unkeep + re-verify notice + save-time filter. Both
// functions are deterministic, no DOM / network / React state, so
// the tests just exercise the rule matrix directly.

import {
  computeQrArtworkChangedSlots,
  isQrSlotFlagged,
  resolveQrEffectiveKeep,
  type QrCarryContext,
  type QrCarryV1Image,
  type QrCarryFreshEntry,
} from './qrCarryForward.ts'
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

function assertSetEquals(actual: Set<string>, expected: string[], label?: string) {
  const e = new Set(expected)
  if (actual.size !== e.size) {
    throw new Error(
      `${label ?? 'set'}: size mismatch — expected ${expected.length} (${[...e].join(',') || '∅'}), got ${actual.size} (${[...actual].join(',') || '∅'})`,
    )
  }
  for (const item of e) {
    if (!actual.has(item)) {
      throw new Error(`${label ?? 'set'}: missing expected member '${item}' (got: ${[...actual].join(',')})`)
    }
  }
}

// ── Fixture builders ──────────────────────────────────────────────────────────

function v1Image(
  v1RowId: string,
  associated_name: string | null,
  side: 'front' | 'back' | null = 'front',
): QrCarryV1Image {
  return { v1RowId, associated_name, side }
}

function v1CarryWith(
  names: string[],
  images: QrCarryV1Image[],
): QrCarryContext {
  return { names, images }
}

function freshEntry(associated_name: string | null): QrCarryFreshEntry {
  return { associated_name }
}

// ── computeQrArtworkChangedSlots ──────────────────────────────────────────────

console.log('\ncomputeQrArtworkChangedSlots')

test('null v1Carry returns empty set', () => {
  const result = computeQrArtworkChangedSlots(null, {}, {}, {}, [])
  assertSetEquals(result, [])
})

test('empty form state with v1Carry but no changes returns empty set', () => {
  const v1 = v1CarryWith(['Bob', 'Bill'], [
    v1Image('img-bob-front', 'Bob'),
    v1Image('img-bill-front', 'Bill'),
    v1Image('img-shared-front', null),
  ])
  const result = computeQrArtworkChangedSlots(v1, {}, {}, { '': [] }, ['Bob', 'Bill'])
  assertSetEquals(result, [], 'unchanged form should produce no flagged slots')
})

test('explicit keep=true on every v1 image matches the default (no flags)', () => {
  const v1 = v1CarryWith(['Bob', 'Bill'], [
    v1Image('img-bob-front', 'Bob'),
    v1Image('img-bill-front', 'Bill'),
  ])
  const result = computeQrArtworkChangedSlots(
    v1,
    { 'img-bob-front': true, 'img-bill-front': true },
    {},
    { '': [] },
    ['Bob', 'Bill'],
  )
  assertSetEquals(result, [])
})

test('unkept v1 image flags its slot', () => {
  const v1 = v1CarryWith(['Bob', 'Bill'], [
    v1Image('img-bob', 'Bob'),
    v1Image('img-bill', 'Bill'),
  ])
  const result = computeQrArtworkChangedSlots(
    v1,
    { 'img-bill': false },
    {},
    { '': [] },
    ['Bob', 'Bill'],
  )
  assertSetEquals(result, ['Bill'], "Bill's slot should be flagged, Bob's untouched")
})

test('replacement queued on a v1 image flags its slot', () => {
  const v1 = v1CarryWith(['Bob', 'Bill'], [
    v1Image('img-bob', 'Bob'),
    v1Image('img-bill', 'Bill'),
  ])
  const result = computeQrArtworkChangedSlots(
    v1,
    {},
    { 'img-bill': { file: 'placeholder', preview: 'blob:' } },
    { '': [] },
    ['Bob', 'Bill'],
  )
  assertSetEquals(result, ['Bill'])
})

test('name dropped from v2 roster flags the dropped slot', () => {
  const v1 = v1CarryWith(['Bob', 'Bill'], [
    v1Image('img-bob', 'Bob'),
    v1Image('img-bill', 'Bill'),
  ])
  // Bill removed from v2 names.
  const result = computeQrArtworkChangedSlots(v1, {}, {}, { '': [] }, ['Bob'])
  assertSetEquals(result, ['Bill'])
})

test('fresh image added to a slot flags that slot', () => {
  const v1 = v1CarryWith(['Bob'], [v1Image('img-bob', 'Bob')])
  const result = computeQrArtworkChangedSlots(
    v1,
    {},
    {},
    { '': [freshEntry('Bob')] },
    ['Bob'],
  )
  assertSetEquals(result, ['Bob'])
})

test('fresh image on a new (v2-only) name still flags the slot', () => {
  const v1 = v1CarryWith(['Bob'], [v1Image('img-bob', 'Bob')])
  // Bill is added in v2 — wasn't on v1. Bill's fresh image flags Bill.
  const result = computeQrArtworkChangedSlots(
    v1,
    {},
    {},
    { '': [freshEntry('Bill')] },
    ['Bob', 'Bill'],
  )
  assertSetEquals(result, ['Bill'])
})

test('unkept shared v1 image flags SHARED_APPROVAL_KEY', () => {
  const v1 = v1CarryWith(['Bob', 'Bill'], [
    v1Image('img-bob', 'Bob'),
    v1Image('img-shared', null),
  ])
  const result = computeQrArtworkChangedSlots(
    v1,
    { 'img-shared': false },
    {},
    { '': [] },
    ['Bob', 'Bill'],
  )
  assertSetEquals(
    result,
    [SHARED_APPROVAL_KEY],
    'shared sentinel, not Bob or Bill, should be flagged',
  )
})

test('fresh shared (assoc_name=null) image flags SHARED_APPROVAL_KEY', () => {
  const v1 = v1CarryWith(['Bob'], [v1Image('img-bob', 'Bob')])
  const result = computeQrArtworkChangedSlots(
    v1,
    {},
    {},
    { '': [freshEntry(null)] },
    ['Bob'],
  )
  assertSetEquals(result, [SHARED_APPROVAL_KEY])
})

test('multi-slot change tracked independently', () => {
  const v1 = v1CarryWith(['Bob', 'Bill', 'Carol'], [
    v1Image('img-bob', 'Bob'),
    v1Image('img-bill', 'Bill'),
    v1Image('img-carol', 'Carol'),
  ])
  const result = computeQrArtworkChangedSlots(
    v1,
    { 'img-bill': false },
    { 'img-carol': { file: 'x', preview: 'blob:y' } },
    { '': [] },
    ['Bob', 'Bill', 'Carol'],
  )
  assertSetEquals(result, ['Bill', 'Carol'], "Bob's slot should remain unflagged")
})

test('Bill named slot change adds only Bill to the changed-slot set', () => {
  // computeQrArtworkChangedSlots is the slot-level signal; it adds
  // exactly the slots whose underlying images moved. The per-QR
  // expansion (a shared QR is impacted by a named-slot change
  // because it sits on every card) lives in isQrSlotFlagged, tested
  // below.
  const v1 = v1CarryWith(['Bob', 'Bill'], [
    v1Image('img-bill', 'Bill'),
    v1Image('img-shared', null),
  ])
  const result = computeQrArtworkChangedSlots(
    v1,
    { 'img-bill': false },
    {},
    { '': [] },
    ['Bob', 'Bill'],
  )
  assert(
    !result.has(SHARED_APPROVAL_KEY),
    'set should not include the shared sentinel when only Bill changes',
  )
  assert(result.has('Bill'), 'Bill slot should be flagged')
})

test('shared slot change adds only the shared sentinel to the changed-slot set', () => {
  // Same separation as above. The set carries which slot moved; the
  // per-QR expansion (a named QR is impacted by a shared-slot
  // change because the shared artwork prints on its card) lives in
  // isQrSlotFlagged.
  const v1 = v1CarryWith(['Bob', 'Bill'], [
    v1Image('img-bob', 'Bob'),
    v1Image('img-shared', null),
  ])
  const result = computeQrArtworkChangedSlots(
    v1,
    { 'img-shared': false },
    {},
    { '': [] },
    ['Bob', 'Bill'],
  )
  assert(
    result.has(SHARED_APPROVAL_KEY),
    'shared sentinel should be flagged',
  )
  assert(!result.has('Bob'), "Bob's slot should not be flagged at the set level")
  assert(!result.has('Bill'), "Bill's slot should not be flagged at the set level")
})

test('multiple option tabs combine into one flag set', () => {
  const v1 = v1CarryWith(['Bob'], [v1Image('img-bob', 'Bob')])
  // Fresh entry on a different material_option tab still flags
  // the slot — material_option dimension is orthogonal to the
  // slot dimension for this purpose.
  const result = computeQrArtworkChangedSlots(
    v1,
    {},
    {},
    { mirror: [freshEntry('Bob')], natural: [] },
    ['Bob'],
  )
  assertSetEquals(result, ['Bob'])
})

test('whitespace name in v2 roster still flags the v1 name', () => {
  // Sanity: caller trims + filters before calling, but if a stray
  // whitespace name slipped through, the v2NameSet contains it
  // verbatim. A v1 name 'Bill' wouldn't match '  Bill  ', so Bill
  // would correctly be flagged as dropped. Pre-call trimming
  // (NewVersionPage already does .map(n=>n.trim()).filter(Boolean))
  // is the intended contract; this just documents the lib's behaviour
  // when called with raw input.
  const v1 = v1CarryWith(['Bill'], [v1Image('img-bill', 'Bill')])
  const result = computeQrArtworkChangedSlots(v1, {}, {}, { '': [] }, ['  Bill  '])
  assertSetEquals(result, ['Bill'])
})

test('invalidV1RowIds flags the slot of an option-universe-dropped image', () => {
  // Page-level guard (PV-2026W21-084): a v1 image whose
  // material_option no longer maps to v2's selected tabs is
  // effectively dropped on save, so the QR auto-unkeep + amber
  // notice should fire for its slot.
  const v1 = v1CarryWith(['Bob', 'Bill'], [
    v1Image('img-bob', 'Bob'),
    v1Image('img-bill', 'Bill'),
  ])
  const result = computeQrArtworkChangedSlots(
    v1,
    {},
    {},
    { '': [] },
    ['Bob', 'Bill'],
    new Set(['img-bill']),
  )
  assertSetEquals(result, ['Bill'], "Bill's option dropped, slot flagged")
})

test('invalidV1RowIds undefined leaves the result unchanged', () => {
  // Backwards-compat sanity: callers that don't pass the optional
  // sixth parameter behave exactly like before.
  const v1 = v1CarryWith(['Bob'], [v1Image('img-bob', 'Bob')])
  const result = computeQrArtworkChangedSlots(v1, {}, {}, { '': [] }, ['Bob'])
  assertSetEquals(result, [])
})

// ── isQrSlotFlagged ───────────────────────────────────────────────────────────

console.log('\nisQrSlotFlagged')

test('empty changed set → never flagged (named)', () => {
  assert(!isQrSlotFlagged('Bill', new Set()), 'named QR with no changes')
})

test('empty changed set → never flagged (shared)', () => {
  assert(!isQrSlotFlagged(null, new Set()), 'shared QR with no changes')
})

test("named QR flags when its own named slot is in the set", () => {
  assert(isQrSlotFlagged('Bill', new Set(['Bill'])), 'Bill QR + Bill change')
})

test("named QR does NOT flag when only an unrelated named slot changed", () => {
  assert(!isQrSlotFlagged('Bill', new Set(['Bob'])), "Bill's QR + Bob's change")
})

test('named QR flags when only the SHARED sentinel changed (shared artwork prints on its card)', () => {
  // Bill's card carries both Bill's own artwork AND the shared
  // artwork printed across every card. A shared-artwork change is
  // a change to the surface Bill's QR appears on.
  assert(
    isQrSlotFlagged('Bill', new Set([SHARED_APPROVAL_KEY])),
    "Bill's QR should flag on shared-slot change",
  )
})

test('named QR flags when both its named slot AND shared changed', () => {
  assert(
    isQrSlotFlagged('Bill', new Set(['Bill', SHARED_APPROVAL_KEY])),
    'Bill QR + (Bill + shared) changes should flag',
  )
})

test('shared QR flags on any named-slot change (regression for the single-recipient bug)', () => {
  // Repro of the live bug: single-recipient proof, QR stored at
  // assoc=null (because the recipient dropdown is suppressed for
  // single-recipient versions), designer replaces the recipient's
  // artwork. The named slot moves; the shared sentinel doesn't.
  // Under the corrected surface-membership rule the shared QR
  // still flags because its surface (every card, including this
  // one) has changed.
  assert(
    isQrSlotFlagged(null, new Set(['Rob'])),
    'shared QR + named-slot change should flag',
  )
})

test('shared QR flags on a shared-slot change', () => {
  assert(
    isQrSlotFlagged(null, new Set([SHARED_APPROVAL_KEY])),
    'shared QR + shared-slot change should flag',
  )
})

test('shared QR flags when any combination of slots changed', () => {
  assert(
    isQrSlotFlagged(null, new Set(['Bob', SHARED_APPROVAL_KEY])),
    'shared QR + (Bob + shared) changes should flag',
  )
  assert(
    isQrSlotFlagged(null, new Set(['Alice', 'Bob', 'Carol'])),
    'shared QR + three named-slot changes should flag',
  )
})

// ── resolveQrEffectiveKeep ────────────────────────────────────────────────────

console.log('\nresolveQrEffectiveKeep')

test('unchanged slot, no override → keep=true', () => {
  const r = resolveQrEffectiveKeep('e1', 'Bob', {}, new Set())
  assert(r === true, `expected true, got ${r}`)
})

test('changed slot, no override → keep=false (auto-unkeep)', () => {
  const r = resolveQrEffectiveKeep('e1', 'Bill', {}, new Set(['Bill']))
  assert(r === false, `expected false, got ${r}`)
})

test('changed slot, override=true → keep=true (designer keep)', () => {
  const r = resolveQrEffectiveKeep('e1', 'Bill', { e1: true }, new Set(['Bill']))
  assert(r === true, `expected true, got ${r}`)
})

test('unchanged slot, override=false → keep=false (designer drop)', () => {
  const r = resolveQrEffectiveKeep('e1', 'Bob', { e1: false }, new Set())
  assert(r === false, `expected false, got ${r}`)
})

test('null associatedName resolves to SHARED_APPROVAL_KEY', () => {
  const r = resolveQrEffectiveKeep('e1', null, {}, new Set([SHARED_APPROVAL_KEY]))
  assert(r === false, 'shared QR with shared-slot changed should auto-unkeep')
})

test('null associatedName, named slot changed → keep=false (shared QR on every card)', () => {
  // Bill's change DOES drag the shared QR with it, because the
  // shared QR sits on every printed card including Bill's. This
  // is the live bug-fix: previously the rule only matched the QR's
  // own slot key, leaving null-assoc QRs unflagged on named-slot
  // changes (including the single-recipient case, where the
  // recipient dropdown is suppressed and QR assoc stays at null).
  const r = resolveQrEffectiveKeep('e1', null, {}, new Set(['Bill']))
  assert(r === false, 'shared QR should auto-unkeep on a named-slot change')
})

test('named QR, only shared slot changed → keep=false', () => {
  // Symmetric to the above. Bill's card carries the shared
  // artwork, so a shared-slot change is a change to Bill's
  // surface; his named QR auto-unkeeps.
  const r = resolveQrEffectiveKeep('e1', 'Bill', {}, new Set([SHARED_APPROVAL_KEY]))
  assert(r === false, "named QR should auto-unkeep on shared-slot change")
})

test('named QR, unrelated named slot changed → keep=true', () => {
  // Bob's slot change doesn't touch Bill's card.
  const r = resolveQrEffectiveKeep('e1', 'Bill', {}, new Set(['Bob']))
  assert(r === true, 'Bill QR should stay kept when only Bob changes')
})

test('override key isolates by entry id', () => {
  // Two entries on the same slot, one override only.
  const overrides = { 'e1': false }
  const slots = new Set<string>()
  assert(
    resolveQrEffectiveKeep('e1', 'Bob', overrides, slots) === false,
    'e1 has override=false, expected keep=false',
  )
  assert(
    resolveQrEffectiveKeep('e2', 'Bob', overrides, slots) === true,
    'e2 has no override, expected default keep=true on unchanged slot',
  )
})

// ── Summary ───────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
