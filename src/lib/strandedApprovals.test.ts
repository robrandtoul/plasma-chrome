// Unit tests for strandedApprovals.ts
// Run with: npx tsx src/lib/strandedApprovals.test.ts
//
// Covers the two Slice-1 guardrail checks (docs/bundle-orders-spec.md §12):
// findStrandedMaterialApprovals (order guard + admin report) and
// rostersAreDisjoint (new-version material-swap guard).

import {
  findStrandedMaterialApprovals,
  rostersAreDisjoint,
  type StrandedVersion,
  type StrandedApprovalRow,
} from './strandedApprovals'
import { SHARED_APPROVAL_KEY } from './types'

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

function assertEqual<T>(actual: T, expected: T, message?: string) {
  if (actual !== expected) {
    throw new Error(message ?? `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

function v(overrides: Partial<StrandedVersion> & { id: string }): StrandedVersion {
  return {
    version_number: 1,
    material_id: 'steel',
    material_display: 'Stainless Steel',
    is_current: false,
    ...overrides,
  }
}

function a(proof_version_id: string, name: string, state = 'approved'): StrandedApprovalRow {
  return { proof_version_id, name, state }
}

// ── findStrandedMaterialApprovals ──────────────────────────────────────────

test('the Novion case: steel v1 approved, letterpress v2 current → v1 stranded', () => {
  const versions = [
    v({ id: 'v1', version_number: 1, material_id: 'steel', material_display: 'Stainless Steel', is_current: false }),
    v({ id: 'v2', version_number: 2, material_id: 'letterpress', material_display: 'Letterpress', is_current: true }),
  ]
  const approvals = [a('v1', 'Bita Najafi'), a('v2', 'Hirok Poddar')]
  const stranded = findStrandedMaterialApprovals(versions, approvals)
  assertEqual(stranded.length, 1, 'exactly one stranded version')
  assertEqual(stranded[0].versionNumber, 1)
  assertEqual(stranded[0].material, 'Stainless Steel')
  assertEqual(stranded[0].names.join(','), 'Bita Najafi')
})

test('same-material superseded approval is a normal revision, not stranded', () => {
  const versions = [
    v({ id: 'v1', version_number: 1, material_id: 'steel', is_current: false }),
    v({ id: 'v2', version_number: 2, material_id: 'steel', is_current: true }),
  ]
  const approvals = [a('v1', 'Bita'), a('v2', 'Bita')]
  assertEqual(findStrandedMaterialApprovals(versions, approvals).length, 0)
})

test('recipient also approved on current is orderable → not stranded', () => {
  // Bita approved v1 (steel) then re-approved v2 (gold, current). Bita's card
  // is orderable as gold, so the old steel approval is not a stranded product.
  const versions = [
    v({ id: 'v1', version_number: 1, material_id: 'steel', is_current: false }),
    v({ id: 'v2', version_number: 2, material_id: 'gold', is_current: true }),
  ]
  const approvals = [a('v1', 'Bita'), a('v2', 'Bita')]
  assertEqual(findStrandedMaterialApprovals(versions, approvals).length, 0)
})

test('null current material (per-direction selection) flags nothing', () => {
  const versions = [
    v({ id: 'v1', version_number: 1, material_id: 'steel', is_current: false }),
    v({ id: 'v2', version_number: 2, material_id: null, is_current: true }),
  ]
  const approvals = [a('v1', 'Bita')]
  assertEqual(findStrandedMaterialApprovals(versions, approvals).length, 0)
})

test('changes_requested rows are ignored', () => {
  const versions = [
    v({ id: 'v1', version_number: 1, material_id: 'steel', is_current: false }),
    v({ id: 'v2', version_number: 2, material_id: 'letterpress', is_current: true }),
  ]
  const approvals = [a('v1', 'Bita', 'changes_requested')]
  assertEqual(findStrandedMaterialApprovals(versions, approvals).length, 0)
})

test('shared-artwork sentinel renders as a friendly label', () => {
  const versions = [
    v({ id: 'v1', version_number: 1, material_id: 'steel', material_display: 'Stainless Steel', is_current: false }),
    v({ id: 'v2', version_number: 2, material_id: 'letterpress', is_current: true }),
  ]
  const approvals = [a('v1', SHARED_APPROVAL_KEY)]
  const stranded = findStrandedMaterialApprovals(versions, approvals)
  assertEqual(stranded.length, 1)
  assertEqual(stranded[0].names.join(','), 'Shared artwork')
})

test('multiple names on one stranded version are collected, deduped', () => {
  const versions = [
    v({ id: 'v1', version_number: 1, material_id: 'steel', is_current: false }),
    v({ id: 'v2', version_number: 2, material_id: 'letterpress', is_current: true }),
  ]
  const approvals = [a('v1', 'Bita'), a('v1', 'Amir'), a('v1', 'Bita')]
  const stranded = findStrandedMaterialApprovals(versions, approvals)
  assertEqual(stranded.length, 1)
  assertEqual(stranded[0].names.length, 2, 'Bita + Amir, deduped')
})

test('no current version → nothing flagged', () => {
  const versions = [v({ id: 'v1', material_id: 'steel', is_current: false })]
  assertEqual(findStrandedMaterialApprovals(versions, [a('v1', 'Bita')]).length, 0)
})

// ── rostersAreDisjoint ─────────────────────────────────────────────────────

test('different people → disjoint', () => {
  assert(rostersAreDisjoint(['Bita'], ['Hirok']), 'Bita vs Hirok should be disjoint')
})

test('overlapping name → not disjoint (a genuine addition/revision)', () => {
  assert(!rostersAreDisjoint(['Bita'], ['Bita', 'Hirok']), 'shared name means not disjoint')
})

test('case and whitespace are ignored', () => {
  assert(!rostersAreDisjoint(['Bita'], ['  bita ']), 'same person, different casing')
})

test('empty on either side → not disjoint (stay quiet)', () => {
  assert(!rostersAreDisjoint([], ['Hirok']), 'empty previous')
  assert(!rostersAreDisjoint(['Bita'], []), 'empty next')
  assert(!rostersAreDisjoint([], []), 'both empty')
})

// ── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
