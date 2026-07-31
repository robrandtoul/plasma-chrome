import { quickQuantities } from './quickQuantities'
import { DEFAULT_DISPLAY_QUANTITIES } from './constants'

let failures = 0
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    console.log(`  ok   ${name}`)
  } else {
    failures++
    console.error(`  FAIL ${name}\n       expected ${e}\n       actual   ${a}`)
  }
}

console.log('quickQuantities')

// The live catalogue list for the metal family (Kaz's Matte White Metal), with
// that order's real bounds: min 25 (lowest listed tier), max 5000 (the online
// flat-pricing cap). Everything survives — and 250, the quantity he could not
// enter, is now one tap.
const METAL = [25, 50, 75, 100, 150, 200, 250, 500, 750, 1000]
check('metal list, order bounds 25..5000', quickQuantities(METAL, 25, 5000), METAL)
check('includes 250 (the reported case)', quickQuantities(METAL, 25, 5000).includes(250), true)

// A chip must never offer a quantity checkout would reject, or the customer
// taps it and the button silently stays disabled — the exact failure we are
// fixing, just with a nicer target.
check('clamps below min', quickQuantities(METAL, 100, 5000), [100, 150, 200, 250, 500, 750, 1000])
check('clamps above max', quickQuantities(METAL, 25, 250), [25, 50, 75, 100, 150, 200, 250])
check('clamps both ends', quickQuantities(METAL, 100, 250), [100, 150, 200, 250])

// Null bounds mean unbounded on that side (tiers not loaded yet, which is the
// state an open-thickness order is in before a thickness is picked).
check('null min', quickQuantities(METAL, null, 200), [25, 50, 75, 100, 150, 200])
check('null max', quickQuantities(METAL, 500, null), [500, 750, 1000])
check('both null', quickQuantities(METAL, null, null), METAL)

// Uncurated material falls back to the shared default set rather than
// rendering nothing.
check('null display_quantities → default set', quickQuantities(null, null, null), DEFAULT_DISPLAY_QUANTITIES)
check('empty display_quantities → default set', quickQuantities([], null, null), DEFAULT_DISPLAY_QUANTITIES)

// Degenerate input must not reach the customer as a "0 cards" chip.
check('drops zero / negative / NaN', quickQuantities([0, -50, Number.NaN, 100], null, null), [100])
check('dedupes', quickQuantities([100, 100, 250], null, null), [100, 250])
check('sorts ascending', quickQuantities([500, 100, 250], null, null), [100, 250, 500])

// No chip survives the clamp → caller renders type-in only, not an empty row.
check('impossible range → empty', quickQuantities(METAL, 2000, 3000), [])

// Paper/plastic start at 100, so a 25-card chip must never appear for them.
check('paper list stays paper', quickQuantities([100, 250, 500, 750, 1000], 100, 5000), [100, 250, 500, 750, 1000])

if (failures > 0) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nAll quickQuantities tests passed.')
