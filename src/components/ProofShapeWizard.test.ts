// Unit tests for the ProofShapeWizard pure helpers.
// Run with: npx tsx src/components/ProofShapeWizard.test.ts  (or pnpm test:wizard)
//
// Covers every resolution path through the decision tree — including the
// July 2026 customer-intent guard on different-material Selections (QS2) —
// plus the shape→form-state mapping, the DB shape strings, and the two
// reverse-derivation functions. The key regression under test: a persisted
// per-direction selection must reconstruct as a RESOLVED shape (via
// selectionIntent: 'pick'), or the edit/read-only views would sit
// unresolved and the new-version seed path would block saves.

import {
  EMPTY_ANSWERS,
  resolveShape,
  deriveFormState,
  dbShape,
  resolvedShapeLabel,
  isWizardResolved,
  deriveAnswersFromShape,
  deriveAnswersFromVersion,
  type WizardAnswers,
} from './ProofShapeWizard'

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
    throw new Error(message ?? `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

function assertDeepEqual(actual: unknown, expected: unknown, message?: string) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(message ?? `Expected ${e}, got ${a}`)
}

// Answer-building helper: EMPTY_ANSWERS plus overrides.
function answers(patch: Partial<WizardAnswers>): WizardAnswers {
  return { ...EMPTY_ANSWERS, ...patch }
}

// Default resolver opts: no material chosen yet.
const NO_MATERIAL = { materialChosen: false, materialSupportsPersonalisation: false }
const MATERIAL_WITH_P = { materialChosen: true, materialSupportsPersonalisation: true }
const MATERIAL_NO_P = { materialChosen: true, materialSupportsPersonalisation: false }

// ── resolveShape: Recipients / incomplete ───────────────────────────────────

test('nothing answered → unresolved', () => {
  assertEqual(resolveShape(EMPTY_ANSWERS, NO_MATERIAL), null)
})

test('recipients resolves in one answer', () => {
  assertDeepEqual(resolveShape(answers({ family: 'recipients' }), NO_MATERIAL), { kind: 'recipients' })
})

// ── resolveShape: Selection branch ──────────────────────────────────────────

test('selection, QS unanswered → unresolved', () => {
  assertEqual(resolveShape(answers({ family: 'selection' }), NO_MATERIAL), null)
})

test('selection, same material → resolved, not per-direction', () => {
  assertDeepEqual(
    resolveShape(answers({ family: 'selection', selectionMaterial: 'same' }), NO_MATERIAL),
    { kind: 'selection', perDirection: false },
  )
})

test('selection, different materials, intent unanswered → unresolved (QS2 gate)', () => {
  assertEqual(
    resolveShape(answers({ family: 'selection', selectionMaterial: 'different' }), NO_MATERIAL),
    null,
  )
})

test("selection, different materials, intent 'pick' → resolved per-direction", () => {
  assertDeepEqual(
    resolveShape(
      answers({ family: 'selection', selectionMaterial: 'different', selectionIntent: 'pick' }),
      NO_MATERIAL,
    ),
    { kind: 'selection', perDirection: true },
  )
})

test("selection, different materials, intent 'prices' → split guard (not saveable)", () => {
  const shape = resolveShape(
    answers({ family: 'selection', selectionMaterial: 'different', selectionIntent: 'prices' }),
    NO_MATERIAL,
  )
  assertDeepEqual(shape, { kind: 'split-guard' })
  assertEqual(isWizardResolved(shape), false)
  assertEqual(deriveFormState(shape), null)
  assertEqual(dbShape(shape), null)
})

test("selection, different materials, intent 'unsure' → split guard (not saveable)", () => {
  const shape = resolveShape(
    answers({ family: 'selection', selectionMaterial: 'different', selectionIntent: 'unsure' }),
    NO_MATERIAL,
  )
  assertDeepEqual(shape, { kind: 'split-guard' })
  assertEqual(isWizardResolved(shape), false)
})

test('selection, same material ignores a stale intent answer', () => {
  // Intent belongs to the different-materials path only; if answers ever
  // carry a stale intent alongside 'same', resolution must not change.
  assertDeepEqual(
    resolveShape(
      answers({ family: 'selection', selectionMaterial: 'same', selectionIntent: 'prices' }),
      NO_MATERIAL,
    ),
    { kind: 'selection', perDirection: false },
  )
})

// ── resolveShape: Set branch ────────────────────────────────────────────────

test('set, layouts unanswered → unresolved', () => {
  assertEqual(resolveShape(answers({ family: 'set' }), NO_MATERIAL), null)
})

test('set single, no material chosen → resolved, personalisation off', () => {
  assertDeepEqual(
    resolveShape(answers({ family: 'set', layouts: 'one' }), NO_MATERIAL),
    { kind: 'set-single', personalised: false },
  )
})

test('set single, material supports personalisation, unanswered → unresolved', () => {
  assertEqual(resolveShape(answers({ family: 'set', layouts: 'one' }), MATERIAL_WITH_P), null)
})

test('set single, personalised yes', () => {
  assertDeepEqual(
    resolveShape(answers({ family: 'set', layouts: 'one', personalised: 'yes' }), MATERIAL_WITH_P),
    { kind: 'set-single', personalised: true },
  )
})

test('set single, material without personalisation → resolved without asking', () => {
  assertDeepEqual(
    resolveShape(answers({ family: 'set', layouts: 'one' }), MATERIAL_NO_P),
    { kind: 'set-single', personalised: false },
  )
})

test('set collection, same material', () => {
  assertDeepEqual(
    resolveShape(
      answers({ family: 'set', layouts: 'several', sameMaterial: 'yes' }),
      MATERIAL_NO_P,
    ),
    { kind: 'set-collection', personalised: false, multiMaterial: false },
  )
})

test('set collection, different materials, guard unanswered → unresolved', () => {
  assertEqual(
    resolveShape(answers({ family: 'set', layouts: 'several', sameMaterial: 'no' }), MATERIAL_NO_P),
    null,
  )
})

test('set collection, different materials, split → split guard', () => {
  const shape = resolveShape(
    answers({ family: 'set', layouts: 'several', sameMaterial: 'no', multiMaterialChoice: 'split' }),
    MATERIAL_NO_P,
  )
  assertDeepEqual(shape, { kind: 'split-guard' })
  assertEqual(isWizardResolved(shape), false)
})

test('set collection, different materials, keep → multi-material collection (forces custom quote)', () => {
  const shape = resolveShape(
    answers({ family: 'set', layouts: 'several', sameMaterial: 'no', multiMaterialChoice: 'keep' }),
    MATERIAL_NO_P,
  )
  assertDeepEqual(shape, { kind: 'set-collection', personalised: false, multiMaterial: true })
  assertEqual(deriveFormState(shape)!.forceCustomQuote, true)
})

// ── deriveFormState / dbShape ───────────────────────────────────────────────

test('form state: recipients', () => {
  assertDeepEqual(deriveFormState({ kind: 'recipients' }), {
    isVariantRound: false, isPerDirectionPricing: false, cardType: 'business',
    hasPersonalisation: false, forceCustomQuote: false,
  })
})

test('form state: per-direction selection sets both variant flags', () => {
  assertDeepEqual(deriveFormState({ kind: 'selection', perDirection: true }), {
    isVariantRound: true, isPerDirectionPricing: true, cardType: 'business',
    hasPersonalisation: false, forceCustomQuote: false,
  })
})

test('db shapes', () => {
  assertEqual(dbShape({ kind: 'recipients' }), 'recipients')
  assertEqual(dbShape({ kind: 'set-single', personalised: false }), 'set_single')
  assertEqual(dbShape({ kind: 'set-collection', personalised: false, multiMaterial: false }), 'set_collection')
  assertEqual(dbShape({ kind: 'selection', perDirection: true }), 'selection')
  assertEqual(dbShape({ kind: 'split-guard' }), null)
  assertEqual(dbShape(null), null)
})

test('resolution labels unchanged', () => {
  assertEqual(resolvedShapeLabel({ kind: 'selection', perDirection: true }),
    'Alternative designs on different materials, customer chooses one')
  assertEqual(resolvedShapeLabel({ kind: 'selection', perDirection: false }),
    'Alternative designs for the customer to choose from')
  assertEqual(resolvedShapeLabel({ kind: 'split-guard' }), null)
})

// ── Reverse derivation (the seed paths) ─────────────────────────────────────

test('REGRESSION: per-direction version reconstructs as RESOLVED (deriveAnswersFromVersion)', () => {
  const a = deriveAnswersFromVersion({
    shape: 'selection', isVariantRound: true, isPerDirectionPricing: true,
    cardType: 'business', hasPersonalisation: false,
  })
  assertEqual(a.selectionIntent, 'pick')
  const shape = resolveShape(a, NO_MATERIAL)
  assertDeepEqual(shape, { kind: 'selection', perDirection: true })
  assertEqual(isWizardResolved(shape), true)
})

test('REGRESSION: per-direction flags reconstruct as RESOLVED (deriveAnswersFromShape fallback)', () => {
  const a = deriveAnswersFromShape({
    isVariantRound: true, isPerDirectionPricing: true,
    cardType: 'business', hasPersonalisation: false,
  })
  assertEqual(a.selectionIntent, 'pick')
  assertDeepEqual(resolveShape(a, NO_MATERIAL), { kind: 'selection', perDirection: true })
})

test('same-material selection reconstructs without an intent answer', () => {
  const a = deriveAnswersFromVersion({
    shape: 'selection', isVariantRound: true, isPerDirectionPricing: false,
    cardType: 'business', hasPersonalisation: false,
  })
  assertEqual(a.selectionIntent, null)
  assertDeepEqual(resolveShape(a, NO_MATERIAL), { kind: 'selection', perDirection: false })
})

test('recipients / set_single / set_collection versions reconstruct as resolved', () => {
  const base = { isVariantRound: false, isPerDirectionPricing: false, cardType: 'business' as const, hasPersonalisation: false }
  assertDeepEqual(
    resolveShape(deriveAnswersFromVersion({ ...base, shape: 'recipients' }), NO_MATERIAL),
    { kind: 'recipients' },
  )
  assertDeepEqual(
    resolveShape(
      deriveAnswersFromVersion({ ...base, shape: 'set_single', cardType: 'membership', hasPersonalisation: true }),
      MATERIAL_WITH_P,
    ),
    { kind: 'set-single', personalised: true },
  )
  assertDeepEqual(
    resolveShape(
      deriveAnswersFromVersion({ ...base, shape: 'set_collection', cardType: 'membership' }),
      MATERIAL_NO_P,
    ),
    { kind: 'set-collection', personalised: false, multiMaterial: false },
  )
})

test('null shape falls back to the flags-only mapping', () => {
  assertDeepEqual(
    resolveShape(
      deriveAnswersFromVersion({
        shape: null, isVariantRound: false, isPerDirectionPricing: false,
        cardType: 'business', hasPersonalisation: false,
      }),
      NO_MATERIAL,
    ),
    { kind: 'recipients' },
  )
})

test('EMPTY_ANSWERS carries the new key, unanswered', () => {
  assertEqual(EMPTY_ANSWERS.selectionIntent, null)
})

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
