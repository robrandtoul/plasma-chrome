// Unit tests for the UK VAT area helpers (Channel Islands VAT relief).
// Run with: npx tsx supabase/functions/_shared/ukVatArea.test.ts
//
// Imports BOTH twins — this Deno copy and the src/ copy the pay page uses —
// and runs every case through each, so any drift between the two files
// fails the suite rather than silently splitting the server charge from
// the client mirror.

import * as deno from './ukVatArea.ts'
import * as web from '../../../src/lib/ukVatArea.ts'

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

function assertEqual(actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`expected ${e}, got ${a}`)
}

// Assert both twins give the same answer AND that answer is the expected one.
function assertBoth<T>(fn: (m: typeof deno) => T, expected: T) {
  assertEqual(fn(deno), expected)
  assertEqual(fn(web as unknown as typeof deno), expected)
}

console.log('isVatFreeGbpDestination')
test('anywhere outside the UK VAT area is a VAT-free (export) destination', () => {
  assertBoth((m) => m.isVatFreeGbpDestination('JE'), true) // Channel Islands
  assertBoth((m) => m.isVatFreeGbpDestination('GG'), true)
  assertBoth((m) => m.isVatFreeGbpDestination(' je '), true)
  assertBoth((m) => m.isVatFreeGbpDestination('FR'), true) // EU export
  assertBoth((m) => m.isVatFreeGbpDestination('US'), true) // rest-of-world export
  assertBoth((m) => m.isVatFreeGbpDestination('AU'), true)
})
test('GB, the Isle of Man and an unknown destination are not', () => {
  assertBoth((m) => m.isVatFreeGbpDestination('GB'), false)
  assertBoth((m) => m.isVatFreeGbpDestination('IM'), false)
  assertBoth((m) => m.isVatFreeGbpDestination(''), false)
  assertBoth((m) => m.isVatFreeGbpDestination(null), false)
  assertBoth((m) => m.isVatFreeGbpDestination(undefined), false)
})

console.log('isGbpOrderVatFree')
test("'auto' (or null) defers to the destination", () => {
  assertBoth((m) => m.isGbpOrderVatFree('auto', 'FR'), true)
  assertBoth((m) => m.isGbpOrderVatFree('auto', 'GB'), false)
  assertBoth((m) => m.isGbpOrderVatFree(null, 'US'), true)
  assertBoth((m) => m.isGbpOrderVatFree(undefined, 'GB'), false)
  assertBoth((m) => m.isGbpOrderVatFree('auto', ''), false)
})
test("'export' forces VAT-free even on a domestic / unknown destination", () => {
  assertBoth((m) => m.isGbpOrderVatFree('export', 'GB'), true)
  assertBoth((m) => m.isGbpOrderVatFree('export', ''), true)
  assertBoth((m) => m.isGbpOrderVatFree('export', null), true)
  assertBoth((m) => m.isGbpOrderVatFree(' Export ', 'GB'), true)
})
test("'standard' forces VAT even on a foreign destination", () => {
  assertBoth((m) => m.isGbpOrderVatFree('standard', 'FR'), false)
  assertBoth((m) => m.isGbpOrderVatFree('standard', 'JE'), false)
  assertBoth((m) => m.isGbpOrderVatFree('STANDARD', 'US'), false)
})

console.log('isUkVatAreaCountry')
test('GB and the Isle of Man are inside the UK VAT area', () => {
  assertBoth((m) => m.isUkVatAreaCountry('GB'), true)
  assertBoth((m) => m.isUkVatAreaCountry('IM'), true)
})
test('the Channel Islands and everywhere else are outside it', () => {
  assertBoth((m) => m.isUkVatAreaCountry('JE'), false)
  assertBoth((m) => m.isUkVatAreaCountry('GG'), false)
  assertBoth((m) => m.isUkVatAreaCountry('FR'), false)
  assertBoth((m) => m.isUkVatAreaCountry(null), false)
})

console.log('normaliseShipDestination')
test('GB + a Jersey postcode → JE', () => {
  assertBoth((m) => m.normaliseShipDestination('GB', 'JE2 4WD'), 'JE')
  assertBoth((m) => m.normaliseShipDestination('gb', 'je2 4wd'), 'JE')
  assertBoth((m) => m.normaliseShipDestination('GB', ' JE1 1AA '), 'JE')
})
test('GB + a Guernsey (incl. Alderney/Sark) postcode → GG', () => {
  assertBoth((m) => m.normaliseShipDestination('GB', 'GY1 1WR'), 'GG')
  assertBoth((m) => m.normaliseShipDestination('GB', 'GY9 3AA'), 'GG')
  assertBoth((m) => m.normaliseShipDestination('GB', 'GY10 1SD'), 'GG')
})
test('GB + an Isle of Man postcode → IM', () => {
  assertBoth((m) => m.normaliseShipDestination('GB', 'IM1 1LB'), 'IM')
})
test('GB with a mainland or NI postcode stays GB', () => {
  assertBoth((m) => m.normaliseShipDestination('GB', 'EC1A 1BB'), 'GB')
  assertBoth((m) => m.normaliseShipDestination('GB', 'BT1 5GS'), 'GB')
  assertBoth((m) => m.normaliseShipDestination('GB', ''), 'GB')
  assertBoth((m) => m.normaliseShipDestination('GB', null), 'GB')
})
test('non-GB countries pass through untouched (postcode ignored)', () => {
  assertBoth((m) => m.normaliseShipDestination('JE', 'JE2 4WD'), 'JE')
  assertBoth((m) => m.normaliseShipDestination('US', '10001'), 'US')
  assertBoth((m) => m.normaliseShipDestination('FR', 'JE2 4WD'), 'FR')
  assertBoth((m) => m.normaliseShipDestination('', 'JE2 4WD'), '')
  assertBoth((m) => m.normaliseShipDestination(null, null), '')
})
test('lookalike prefixes without a digit do not remap', () => {
  // A postcode has a digit after the area letters; junk like "JERSEY" must
  // not flip the country.
  assertBoth((m) => m.normaliseShipDestination('GB', 'JERSEY'), 'GB')
  assertBoth((m) => m.normaliseShipDestination('GB', 'GYM'), 'GB')
})

console.log('exVat')
test('strips 20% VAT from clean price-list figures', () => {
  assertBoth((m) => m.exVat(468), 390)
  assertBoth((m) => m.exVat(39), 32.5)
  assertBoth((m) => m.exVat(120), 100)
  assertBoth((m) => m.exVat(0), 0)
})
test('rounds to the penny at the strip point', () => {
  assertBoth((m) => m.exVat(25), 20.83)
  assertBoth((m) => m.exVat(299), 249.17)
  assertBoth((m) => m.exVat(0.2), 0.17)
  assertBoth((m) => m.exVat(50), 41.67)
})
test('UK_VAT_RATE matches across the twins', () => {
  assertEqual(deno.UK_VAT_RATE, 0.2)
  assertEqual(web.UK_VAT_RATE, 0.2)
})

console.log('')
console.log(`${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
