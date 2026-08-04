// Unit tests for the delivery-postcode mismatch rules (pay-page gate +
// stripe-webhook backstop). Run with: pnpm test:ship-dest
//
// Imports BOTH twins — this Deno copy and the src/ copy the pay pages use —
// and runs every case through each, so any drift between the two files fails
// the suite rather than silently splitting the webhook's hold decision from
// the client gate. Same pattern as ukVatArea.test.ts.

import * as deno from './shipDestCheck.ts'
import * as web from '../../../src/lib/shipDestCheck.ts'

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

const d = (country: string, postcode: string) => ({ country, postcode })
const MATCH = { mismatch: false, repriceNeeded: false, coarse: false }

console.log('normalisePostcode')
test('uppercases and strips all whitespace', () => {
  assertBoth((m) => m.normalisePostcode('  sy14 7fb '), 'SY147FB')
  assertBoth((m) => m.normalisePostcode('tw13\t6bg'), 'TW136BG')
  assertBoth((m) => m.normalisePostcode(null), '')
  assertBoth((m) => m.normalisePostcode(undefined), '')
})

console.log('comparablePostcode')
test('US ZIP+4 collapses to the primary ZIP', () => {
  assertBoth((m) => m.comparablePostcode('60639-3803', 'US'), '60639')
  assertBoth((m) => m.comparablePostcode('60639 3803', 'US'), '60639')
  assertBoth((m) => m.comparablePostcode('60639', 'US'), '60639')
})
test('the ZIP collapse is US-only', () => {
  assertBoth((m) => m.comparablePostcode('60639-3803', 'DE'), '60639-3803')
  assertBoth((m) => m.comparablePostcode('SW1A 1AA', 'GB'), 'SW1A1AA')
})

console.log('shipBand')
test('GB splits mainland vs Northern Ireland', () => {
  assertBoth((m) => m.shipBand(d('GB', 'SW1A 1AA')), 'GB')
  assertBoth((m) => m.shipBand(d('GB', 'BT1 2AB')), 'GB-NI')
})
test('GB + a Crown-dependency postcode is that island, not GB', () => {
  assertBoth((m) => m.shipBand(d('GB', 'JE2 3AB')), 'JE')
  assertBoth((m) => m.shipBand(d('GB', 'GY1 1AA')), 'GG')
  assertBoth((m) => m.shipBand(d('GB', 'IM1 1AA')), 'IM')
})
test('everywhere else bands by country', () => {
  assertBoth((m) => m.shipBand(d('US', '60639')), 'US')
  assertBoth((m) => m.shipBand(d('DK', '5000')), 'DK')
})

console.log('compareShipDest — the comparison table')
test('the live bug: SY147FB rated, CM9 6UA entered → flag (coarse, same band)', () => {
  assertBoth((m) => m.compareShipDest(d('GB', 'SY147FB'), d('GB', 'CM9 6UA')), {
    mismatch: true, repriceNeeded: false, coarse: true,
  })
})
test('TW20 0YL vs G2 4BL → flag (coarse)', () => {
  assertBoth((m) => m.compareShipDest(d('GB', 'TW20 0YL'), d('GB', 'G2 4BL')), {
    mismatch: true, repriceNeeded: false, coarse: true,
  })
})
test('tw136bg vs TW13 6BL → flag after normalisation (same area → not coarse)', () => {
  assertBoth((m) => m.compareShipDest(d('GB', 'tw136bg'), d('GB', 'TW13 6BL')), {
    mismatch: true, repriceNeeded: false, coarse: false,
  })
})
test('SN13 9RS vs SN13 9RU → flag (same sector, still a different building)', () => {
  assertBoth((m) => m.compareShipDest(d('GB', 'SN13 9RS'), d('GB', 'SN13 9RU')), {
    mismatch: true, repriceNeeded: false, coarse: false,
  })
})
test('SY14 7FB vs sy147fb → match, no flag', () => {
  assertBoth((m) => m.compareShipDest(d('GB', 'SY14 7FB'), d('GB', 'sy147fb')), MATCH)
})
test('US 60639 vs 60639-3803 → match (ZIP+4 is the same ZIP)', () => {
  assertBoth((m) => m.compareShipDest(d('US', '60639'), d('US', '60639-3803')), MATCH)
})
test('blank entered postcode → no flag (AE 00000 vs empty)', () => {
  assertBoth((m) => m.compareShipDest(d('AE', '00000'), d('AE', '')), MATCH)
})
test('country change → always flag + re-rate', () => {
  assertBoth((m) => m.compareShipDest(d('GB', 'SW1A 1AA'), d('US', '10001')), {
    mismatch: true, repriceNeeded: true, coarse: true,
  })
})

console.log('compareShipDest — band changes inside one picked country')
test('GB mainland rated, NI address → re-rate (different DPD rate)', () => {
  assertBoth((m) => m.compareShipDest(d('GB', 'SW1A 1AA'), d('GB', 'BT1 2AB')), {
    mismatch: true, repriceNeeded: true, coarse: true,
  })
})
test('GB mainland rated, Jersey postcode under GB → re-rate (VAT + FedEx)', () => {
  assertBoth((m) => m.compareShipDest(d('GB', 'SW1A 1AA'), d('GB', 'JE2 3AB')), {
    mismatch: true, repriceNeeded: true, coarse: true,
  })
})
test('two US ZIPs, same first digit → mismatch, same band, not coarse', () => {
  assertBoth((m) => m.compareShipDest(d('US', '10001'), d('US', '10999')), {
    mismatch: true, repriceNeeded: false, coarse: false,
  })
})

console.log('compareShipDest — the free/manual-shipping limitation')
test('no rated postcode (designer country hint only): a postcode-level error is invisible BY DESIGN', () => {
  // Free/manual orders carry only the designer's country hint — there is no
  // rated postcode to disagree with, so this branch can only ever catch a
  // country change. Kept as a tested limitation rather than a quiet no-op.
  assertBoth((m) => m.compareShipDest(d('GB', ''), d('GB', 'CM9 6UA')), MATCH)
})
test('…but a country change on a free/manual order is still caught', () => {
  assertBoth((m) => m.compareShipDest(d('GB', ''), d('US', '60639')), {
    mismatch: true, repriceNeeded: true, coarse: true,
  })
})
test('unknown countries → no comparison at all', () => {
  assertBoth((m) => m.compareShipDest(d('', 'SW1A 1AA'), d('GB', 'SW1A 1AA')), MATCH)
  assertBoth((m) => m.compareShipDest(d('GB', 'SW1A 1AA'), d('', 'SW1A 1AA')), MATCH)
})

console.log('isCoarseMismatch')
test('Rob’s coarse set', () => {
  assertBoth((m) => m.isCoarseMismatch(d('GB', 'TW13 6BG'), d('GB', 'TW13 6BL')), false)
  assertBoth((m) => m.isCoarseMismatch(d('GB', 'SY14 7FB'), d('GB', 'CM9 6UA')), true)
  assertBoth((m) => m.isCoarseMismatch(d('GB', 'TW20 0YL'), d('GB', 'G2 4BL')), true)
  assertBoth((m) => m.isCoarseMismatch(d('US', '10001'), d('US', '33308')), true)
  assertBoth((m) => m.isCoarseMismatch(d('DK', '5000'), d('DK', '5270')), false)
  assertBoth((m) => m.isCoarseMismatch(d('GB', 'SW1A 1AA'), d('DK', '5000')), true)
})
test('single- vs double-letter GB areas compare by area, not by length', () => {
  assertBoth((m) => m.isCoarseMismatch(d('GB', 'G2 4BL'), d('GB', 'GL2 4BL')), true)
  assertBoth((m) => m.isCoarseMismatch(d('GB', 'HA0 9PY'), d('GB', 'HA9 0PQ')), false)
})
test('an unparseable GB value in a real mismatch counts as coarse (fail towards the hold)', () => {
  assertBoth((m) => m.isCoarseMismatch(d('GB', '12345'), d('GB', 'CM9 6UA')), true)
})
test('identical values are never coarse', () => {
  assertBoth((m) => m.isCoarseMismatch(d('GB', 'SY14 7FB'), d('GB', 'sy147fb')), false)
})

console.log('backstopHoldDecision — the hold matrix')
const FINE_RATED = d('GB', 'TW13 6BG')
const FINE_ENTERED = d('GB', 'TW13 6BL')
const FINE_ACK = {
  rated_country: 'GB', rated_postcode: 'TW13 6BG',
  entered_country: 'GB', entered_postcode: 'TW13 6BL',
}
test('no mismatch → never held', () => {
  assertBoth((m) => m.backstopHoldDecision({ rated: d('GB', 'SY14 7FB'), entered: d('GB', 'sy147fb'), ack: null }).hold, false)
})
test('mismatch, no ack → held (either coarseness)', () => {
  assertBoth((m) => m.backstopHoldDecision({ rated: FINE_RATED, entered: FINE_ENTERED, ack: null }), {
    mismatch: true, coarse: false, ackCoversEntered: false, hold: true,
  })
  assertBoth((m) => m.backstopHoldDecision({ rated: d('GB', 'SY14 7FB'), entered: d('GB', 'CM9 6UA'), ack: null }).hold, true)
})
test('fine-grained mismatch with a matching ack → not held', () => {
  assertBoth((m) => m.backstopHoldDecision({ rated: FINE_RATED, entered: FINE_ENTERED, ack: FINE_ACK }), {
    mismatch: true, coarse: false, ackCoversEntered: true, hold: false,
  })
})
test('COARSE mismatch is held even with a matching ack', () => {
  const ack = {
    rated_country: 'GB', rated_postcode: 'SY14 7FB',
    entered_country: 'GB', entered_postcode: 'CM9 6UA',
  }
  assertBoth((m) => m.backstopHoldDecision({ rated: d('GB', 'SY14 7FB'), entered: d('GB', 'CM9 6UA'), ack }), {
    mismatch: true, coarse: true, ackCoversEntered: true, hold: true,
  })
})
test('an ack for a DIFFERENT entered postcode covers nothing → held', () => {
  const stale = { ...FINE_ACK, entered_postcode: 'TW13 9ZZ' }
  assertBoth((m) => m.backstopHoldDecision({ rated: FINE_RATED, entered: FINE_ENTERED, ack: stale }), {
    mismatch: true, coarse: false, ackCoversEntered: false, hold: true,
  })
})
test('an ack for a DIFFERENT rated postcode (re-rated since) covers nothing → held', () => {
  const stale = { ...FINE_ACK, rated_postcode: 'TW20 0YL' }
  assertBoth((m) => m.backstopHoldDecision({ rated: FINE_RATED, entered: FINE_ENTERED, ack: stale }).hold, true)
})
test('formatting differences in the ack still cover (normalised compare)', () => {
  const scruffy = {
    rated_country: 'GB', rated_postcode: 'tw136bg',
    entered_country: 'GB', entered_postcode: ' TW13 6BL ',
  }
  assertBoth((m) => m.backstopHoldDecision({ rated: FINE_RATED, entered: FINE_ENTERED, ack: scruffy }), {
    mismatch: true, coarse: false, ackCoversEntered: true, hold: false,
  })
})
test('a malformed ack (wrong jsonb shape) covers nothing → held', () => {
  assertBoth((m) => m.backstopHoldDecision({ rated: FINE_RATED, entered: FINE_ENTERED, ack: 'yes' }).hold, true)
  assertBoth((m) => m.backstopHoldDecision({ rated: FINE_RATED, entered: FINE_ENTERED, ack: [] }).hold, true)
  assertBoth((m) => m.backstopHoldDecision({ rated: FINE_RATED, entered: FINE_ENTERED, ack: 7 }).hold, true)
})

console.log('')
console.log(`${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
