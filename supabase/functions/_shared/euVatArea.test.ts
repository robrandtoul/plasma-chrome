// Unit tests for the EU VAT-area classification behind the Xero "0% EU" /
// "0% ROW" invoice tax rates.
// Run with: npx tsx supabase/functions/_shared/euVatArea.test.ts

import { isEuVatCountry, zeroRatedRegion, EU_VAT_COUNTRIES } from './euVatArea.ts'

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

console.log('isEuVatCountry')
test('member states are EU', () => {
  assertEqual(isEuVatCountry('DE'), true)
  assertEqual(isEuVatCountry('FR'), true)
  assertEqual(isEuVatCountry('IE'), true)
  assertEqual(isEuVatCountry('GR'), true) // Greece is GR, not EL
  assertEqual(isEuVatCountry(' de '), true)
})
test('Monaco counts as EU (French VAT territory)', () => {
  assertEqual(isEuVatCountry('MC'), true)
})
test('non-members are not EU', () => {
  assertEqual(isEuVatCountry('GB'), false)
  assertEqual(isEuVatCountry('CH'), false) // Switzerland
  assertEqual(isEuVatCountry('NO'), false) // Norway
  assertEqual(isEuVatCountry('US'), false)
  assertEqual(isEuVatCountry('JE'), false) // Channel Islands are outside the EU too
  assertEqual(isEuVatCountry('GG'), false)
  assertEqual(isEuVatCountry(''), false)
  assertEqual(isEuVatCountry(null), false)
  assertEqual(isEuVatCountry(undefined), false)
})
test('the member list has the 27 states + Monaco', () => {
  assertEqual(EU_VAT_COUNTRIES.size, 28)
})

console.log('zeroRatedRegion')
test('EU destinations book to the EU rate regardless of currency', () => {
  assertEqual(zeroRatedRegion('DE', 'EUR'), 'eu')
  assertEqual(zeroRatedRegion('FR', 'EUR'), 'eu')
  assertEqual(zeroRatedRegion('IE', 'USD'), 'eu')
  assertEqual(zeroRatedRegion('MC', 'EUR'), 'eu')
})
test('non-EU destinations book to the ROW rate regardless of currency', () => {
  assertEqual(zeroRatedRegion('US', 'USD'), 'row')
  assertEqual(zeroRatedRegion('CH', 'EUR'), 'row') // EUR order to Switzerland is still ROW
  assertEqual(zeroRatedRegion('AE', 'USD'), 'row')
  assertEqual(zeroRatedRegion('CA', 'USD'), 'row')
  assertEqual(zeroRatedRegion('AU', 'GBP'), 'row')
})
test('the Channel Islands are ROW (outside UK and EU VAT areas)', () => {
  assertEqual(zeroRatedRegion('JE', 'GBP'), 'row')
  assertEqual(zeroRatedRegion('GG', 'GBP'), 'row')
})
test('UK VAT-area destinations never re-label (stay No VAT if ever VAT-free)', () => {
  assertEqual(zeroRatedRegion('GB', 'EUR'), null)
  assertEqual(zeroRatedRegion('IM', 'USD'), null)
})
test('unknown destination falls back on the currency', () => {
  assertEqual(zeroRatedRegion(null, 'EUR'), 'eu')
  assertEqual(zeroRatedRegion('', 'EUR'), 'eu')
  assertEqual(zeroRatedRegion(undefined, 'USD'), 'row')
  assertEqual(zeroRatedRegion(null, 'GBP'), null)
  assertEqual(zeroRatedRegion(null, ''), null)
})
test('inputs are case/whitespace tolerant', () => {
  assertEqual(zeroRatedRegion(' ch ', 'eur'), 'row')
  assertEqual(zeroRatedRegion(' nl', ' usd '), 'eu')
})

console.log('')
console.log(`${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
