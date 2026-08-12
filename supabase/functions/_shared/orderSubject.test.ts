// Unit tests for orderSubject.ts
// Run with: npx tsx supabase/functions/_shared/orderSubject.test.ts
//
// The point of this module is that place-order used to compute the order subject
// TWICE, differently, and only the in-house one matched the Dropbox folder. These
// tests pin the shape and the fallbacks so the two routes can't drift again.

import { orderFolderSubject } from './orderSubject.ts'

let passed = 0
let failed = 0

function test(name: string, fn: () => void) {
  try { fn(); console.log(`  ✓ ${name}`); passed++ }
  catch (err) { console.log(`  ✗ ${name}`); console.log(`    ${(err as Error).message}`); failed++ }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message)
}

function assertEqual<T>(actual: T, expected: T, message?: string) {
  if (actual !== expected) {
    throw new Error(message ?? `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

console.log('\norderSubject')

test('matches the Dropbox order folder name', () => {
  // The shape everything keys off — folder, thread and Stock Control job all
  // reading the same thing is the whole point.
  assertEqual(orderFolderSubject('402910', 'Capital Piling', 'Acme Ltd'), 'Order 402910 - Capital Piling')
})

test('the PROJECT name wins over the customer name', () => {
  // This is the bug the module exists to prevent: the supplier route used the
  // customer name, which differs from the folder on half of live's orders.
  assertEqual(orderFolderSubject('403958', 'Capital Piling', 'Acme Ltd'), 'Order 403958 - Capital Piling')
  assert(
    !orderFolderSubject('403958', 'Capital Piling', 'Acme Ltd').includes('Acme'),
    'the customer name must not appear when a project name is set',
  )
})

test('falls back to the customer name when no folder is linked yet', () => {
  assertEqual(orderFolderSubject('402910', null, 'Acme Ltd'), 'Order 402910 - Acme Ltd')
  assertEqual(orderFolderSubject('402910', undefined, 'Acme Ltd'), 'Order 402910 - Acme Ltd')
})

test('a blank project name counts as absent, not as a name', () => {
  // `?? ` alone lets '' through and yields "Order 402910 - ", i.e. a subject
  // naming nobody — worse than the fallback it skipped. Nothing on live has a
  // blank one today; this is the guard that keeps it that way.
  for (const blank of ['', '   ', '\t']) {
    assertEqual(orderFolderSubject('402910', blank, 'Acme Ltd'), 'Order 402910 - Acme Ltd', `blank ${JSON.stringify(blank)}`)
  }
})

test('never leaves a dangling separator', () => {
  // "Order 402910 - " reads as broken; "Order 402910" reads as terse.
  for (const [project, customer] of [[null, null], ['', ''], ['  ', '  '], [null, '   ']] as const) {
    const s = orderFolderSubject('402910', project, customer)
    assertEqual(s, 'Order 402910', `got ${JSON.stringify(s)}`)
    assert(!s.trimEnd().endsWith('-'), 'dangling separator')
  }
})

test('trims stray whitespace around both parts', () => {
  assertEqual(orderFolderSubject('  402910  ', '  Capital Piling  ', 'Acme'), 'Order 402910 - Capital Piling')
})

test('accepts a numeric stock number as well as a string', () => {
  // place-order reads it off a jsonb-ish row, so it can arrive either way.
  assertEqual(orderFolderSubject(402910, 'Capital Piling', null), 'Order 402910 - Capital Piling')
})

test('degrades rather than producing "Order undefined"', () => {
  // A subject is cosmetic; a subject reading "Order null - " is a support call.
  assertEqual(orderFolderSubject(null, 'Capital Piling', null), 'Order - Capital Piling')
  assertEqual(orderFolderSubject(null, null, null), 'Order')
  for (const s of [
    orderFolderSubject(null, 'Capital Piling', null),
    orderFolderSubject(undefined, null, 'Acme'),
    orderFolderSubject(null, null, null),
  ]) {
    assert(!/undefined|null|NaN/.test(s), `leaked a placeholder: ${s}`)
  }
})

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
