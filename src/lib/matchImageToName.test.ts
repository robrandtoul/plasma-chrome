// Unit tests for matchImageToName.ts
// Run with: npx tsx src/lib/matchImageToName.test.ts
//
// The failure that motivated the full-name fix: a Recipients proof
// with the roster ["Lee Bowtell", "Josh Wakeman"] and files named
// "Proof01_LeeBowtell_Bamboo.jpg" / "Proof02_JoshWakeman_Bamboo.jpg".
// The old whole-string match ("chip equals a token") never matched a
// two-word name, so both cards defaulted to shared/everyone and one
// reached the customer allocated to "shared" instead of the person.

import { matchImageToName } from './matchImageToName.ts'

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

function assertEqual<T>(actual: T, expected: T, label = '') {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`${label} expected ${e}, got ${a}`)
}

// ── The regression: full "First Last" roster names ─────────────────────────────

test('full name matches a filename containing both parts (the bug)', () => {
  const names = ['Lee Bowtell', 'Josh Wakeman']
  assertEqual(matchImageToName('Proof01_LeeBowtell_Bamboo.jpg', names), {
    associatedName: 'Lee Bowtell',
    side: null,
  })
  assertEqual(matchImageToName('Proof02_JoshWakeman_Bamboo.jpg', names), {
    associatedName: 'Josh Wakeman',
    side: null,
  })
})

test('full name with a side token', () => {
  const names = ['Lee Bowtell', 'Josh Wakeman']
  assertEqual(matchImageToName('JoshWakeman_Back.jpg', names), {
    associatedName: 'Josh Wakeman',
    side: 'back',
  })
})

test('space- and hyphen-delimited filenames match a full name', () => {
  const names = ['Josh Wakeman']
  assertEqual(matchImageToName('Josh Wakeman front.png', names), {
    associatedName: 'Josh Wakeman',
    side: 'front',
  })
  assertEqual(matchImageToName('josh-wakeman.png', names), {
    associatedName: 'Josh Wakeman',
    side: null,
  })
})

// ── Single first names still behave as before ──────────────────────────────────

test('single first-name roster (original behaviour preserved)', () => {
  const names = ['Martin', 'Kevin', 'Jeremy']
  assertEqual(matchImageToName('Proof01_KevinKnowles_Front.jpg', names), {
    associatedName: 'Kevin',
    side: 'front',
  })
  assertEqual(matchImageToName('MartinDoe.jpg', names), {
    associatedName: 'Martin',
    side: null,
  })
  assertEqual(matchImageToName('Proof02_JeremyB.jpg', names), {
    associatedName: 'Jeremy',
    side: null,
  })
})

// ── No false positives ─────────────────────────────────────────────────────────

test('partial name does not match (Mark vs Markus)', () => {
  assertEqual(matchImageToName('Markus.jpg', ['Mark']), {
    associatedName: null,
    side: null,
  })
})

test('only one part of a full name present does not match', () => {
  // "josh" present but "wakeman" absent → the full chip must not match.
  assertEqual(matchImageToName('Proof01_Josh_Bamboo.jpg', ['Josh Wakeman']), {
    associatedName: null,
    side: null,
  })
})

test('shared artwork (no name token) stays unallocated', () => {
  assertEqual(matchImageToName('SharedFront.jpg', ['Martin', 'Kevin']), {
    associatedName: null,
    side: 'front',
  })
})

// ── Specificity: most-specific chip wins ───────────────────────────────────────

test('most specific matching name wins, roster order breaks ties', () => {
  // Both "Josh" and "Josh Wakeman" match; the two-token name is more
  // specific and should win regardless of roster order.
  assertEqual(
    matchImageToName('JoshWakeman.jpg', ['Josh', 'Josh Wakeman']).associatedName,
    'Josh Wakeman',
  )
  assertEqual(
    matchImageToName('JoshWakeman.jpg', ['Josh Wakeman', 'Josh']).associatedName,
    'Josh Wakeman',
  )
  // A bare "Josh" file (no second token) falls back to the single-token chip.
  assertEqual(
    matchImageToName('Josh.jpg', ['Josh', 'Josh Wakeman']).associatedName,
    'Josh',
  )
})

// ── Summary ────────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
