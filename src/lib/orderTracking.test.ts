// Unit tests for orderTracking.ts
// Run with: npx tsx src/lib/orderTracking.test.ts
//
// The thing worth pinning here is the STEP COUNT, not the copy.
//
// Migration 000370 made `delivered` reachable, but only for carriers whose
// delivery events Stock Control syncs. On live that is FedEx (65 of 70 shipped
// parcels stamped) and emphatically not DPD (0 of 122, ever) — and DPD carries
// roughly two thirds of the volume. A fixed four-step rail would therefore park
// most customers on "On its way" forever under a step that could never light
// up, which is a worse progress bar than the one that never had a fourth step
// at all. So the rail must shorten itself, and these tests are what stop a
// later refactor quietly restoring the fixed four.

import {
  STAGE_META,
  TRACKING_STAGES,
  formatDispatchDate,
  isTrackingStage,
  progressFraction,
  stageIndexIn,
  stageLabel,
  stageLine,
  stepsFor,
  type TrackingStage,
} from './orderTracking.ts'

let passed = 0
let failed = 0

function test(name: string, fn: () => void) {
  try { fn(); console.log(`  ✓ ${name}`); passed++ }
  catch (err) { console.log(`  ✗ ${name}`); console.log(`    ${(err as Error).message}`); failed++ }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message)
}

function assertEquals(actual: unknown, expected: unknown, message: string) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`${message}\n      expected: ${e}\n      actual:   ${a}`)
}

console.log('\nstepsFor — the rail only shows steps it can reach')

test('a delivery-reporting carrier gets the full four steps', () => {
  const steps = stepsFor(true, 'on_its_way')
  assertEquals(steps.map((s) => s.key), ['paid', 'in_production', 'on_its_way', 'delivered'],
    'a FedEx parcel can still reach Delivered, so the step must be there')
})

test('a carrier that never reports delivery gets three, ending somewhere reachable', () => {
  const steps = stepsFor(false, 'on_its_way')
  assertEquals(steps.map((s) => s.key), ['paid', 'in_production', 'on_its_way'],
    'a DPD parcel would sit under a Delivered step forever — drop it instead')
})

test('before dispatch the full journey is shown, because the carrier is unknown', () => {
  // delivery_tracked is absent until a parcel has a carrier. Guessing "short"
  // would shorten the bar for every FedEx order during production and then
  // grow it back, which reads as the goalposts moving.
  for (const unknown of [null, undefined]) {
    assertEquals(stepsFor(unknown, 'in_production').length, 4,
      'an unknown carrier must not shorten the journey')
  }
})

test('an already-delivered parcel always shows the Delivered step', () => {
  // Defensive: if the carrier allow-list and the delivery stamp ever disagree,
  // the stamp wins — it is evidence, the allow-list is a rule of thumb.
  const steps = stepsFor(false, 'delivered')
  assertEquals(steps.map((s) => s.key), ['paid', 'in_production', 'on_its_way', 'delivered'],
    'a delivered parcel cannot be shown a rail with no Delivered step')
})

console.log('\nstageIndexIn / progressFraction — where on the rail')

test('each stage lands on its own step', () => {
  const full = stepsFor(true, 'paid')
  TRACKING_STAGES.forEach((stage, i) => {
    assertEquals(stageIndexIn(full, stage), i, `${stage} should be step ${i + 1}`)
  })
})

test('the short rail completes at On its way', () => {
  const short = stepsFor(false, 'on_its_way')
  assertEquals(stageIndexIn(short, 'on_its_way'), 2, 'last step')
  assertEquals(progressFraction(short, 2), 1, 'a DPD parcel that has shipped reads as complete')
})

test('the long rail is three-quarters done at On its way', () => {
  const full = stepsFor(true, 'on_its_way')
  assertEquals(progressFraction(full, stageIndexIn(full, 'on_its_way')), 2 / 3,
    'still one step to go when delivery is trackable')
})

test('an unknown later stage reads as near-done, never as the start', () => {
  // If a future migration adds a stage after delivered, an unmatched lookup
  // returning -1 or 0 would slam a finished order back to the beginning.
  const short = stepsFor(false, 'on_its_way')
  assertEquals(stageIndexIn(short, 'delivered' as TrackingStage), 2,
    'a stage beyond the visible rail pins to its end, not its start')
})

test('progressFraction stays inside 0..1', () => {
  const full = stepsFor(true, 'paid')
  for (const i of [-5, 0, 1, 3, 99]) {
    const f = progressFraction(full, i)
    assert(f >= 0 && f <= 1, `fraction for index ${i} was ${f}`)
  }
})

console.log('\ncopy + guards')

test('every stage has a label and a sentence', () => {
  for (const stage of TRACKING_STAGES) {
    assert(STAGE_META[stage].label.length > 0, `${stage} needs a label`)
    assert(STAGE_META[stage].line.length > 10, `${stage} needs a real sentence, not a label twice`)
  }
})

test('isTrackingStage rejects anything unexpected', () => {
  for (const good of TRACKING_STAGES) assert(isTrackingStage(good), `${good} is a stage`)
  for (const bad of [null, undefined, 42, '', 'shipped', 'DELIVERED', {}, []]) {
    assert(!isTrackingStage(bad), `${JSON.stringify(bad)} must not pass as a stage`)
  }
})


console.log('\ndispatch is an ending, not a waypoint (000375)')

// Rob, 31 Jul: "The current text is always present tense. But this really needs
// to be past tense when we reach the point where the reorder system kicks in."
// A DPD parcel stops at `on_its_way` forever — the carrier has never once
// confirmed a delivery — so "Your cards are on their way" is what a customer
// reads weeks after the cards landed on their desk, and often at the exact
// moment they have come back to order more.

const SHIPPED = '2026-06-24T09:15:00Z'

test('a parcel whose carrier never confirms delivery speaks in the past, with a date', () => {
  assertEquals(stageLabel('on_its_way', false), 'Shipped', 'label')
  assertEquals(
    stageLine('on_its_way', { deliveryTracked: false, shippedAt: SHIPPED }),
    'Your cards were shipped on 24 June 2026.',
    'line',
  )
})

test('a parcel still genuinely in transit is untouched', () => {
  // FedEx confirms delivery, so `on_its_way` really is a waypoint and the
  // Delivered step is coming. Dating it would answer a question nobody asked.
  assertEquals(stageLabel('on_its_way', true), 'On its way', 'label')
  assertEquals(
    stageLine('on_its_way', { deliveryTracked: true, shippedAt: SHIPPED }),
    STAGE_META.on_its_way.line,
    'line must be the unchanged present tense',
  )
  // Not dispatched yet = we do not know the carrier, and unknown must not
  // silently read as "terminal".
  assertEquals(stageLine('on_its_way', { deliveryTracked: null, shippedAt: null }),
    STAGE_META.on_its_way.line, 'unknown carrier keeps the present tense')
})

test('no stamp means no date, never a borrowed one', () => {
  // 000375 refuses to fall back to in-house `completed_at`, which means MADE,
  // not posted. Past tense survives; the invented precision does not.
  assertEquals(
    stageLine('on_its_way', { deliveryTracked: false, shippedAt: null }),
    'Your cards have been sent.',
    'dateless past tense',
  )
  assertEquals(
    stageLine('on_its_way', { deliveryTracked: false, shippedAt: 'not-a-date' }),
    'Your cards have been sent.',
    'an unparseable stamp must not reach a customer as "Invalid Date"',
  )
})

test('a delivered parcel always wins, whatever the carrier allow-list says', () => {
  // The stamp is evidence; the allow-list is a rule of thumb. Same rule
  // stepsFor already follows.
  assertEquals(stageLabel('delivered', false), 'Delivered', 'label')
  assertEquals(stageLine('delivered', { deliveryTracked: false, shippedAt: SHIPPED }),
    STAGE_META.delivered.line, 'line')
  assertEquals(stepsFor(false, 'delivered').length, 4, 'and keeps the long rail')
})

test('the earlier stages never change', () => {
  for (const stage of ['paid', 'in_production'] as TrackingStage[]) {
    for (const tracked of [true, false, null]) {
      assertEquals(stageLabel(stage, tracked), STAGE_META[stage].label, `${stage} label`)
      assertEquals(stageLine(stage, { deliveryTracked: tracked, shippedAt: SHIPPED }),
        STAGE_META[stage].line, `${stage} line`)
    }
  }
})

test('the shortened rail names its last step for what it is', () => {
  const short = stepsFor(false, 'on_its_way')
  assertEquals(short.length, 3, 'three steps')
  assertEquals(short[2].label, 'Shipped', 'the terminal step is an ending')
  assertEquals(short[2].key, 'on_its_way', 'but it is still the same stage underneath')
  // The long rail keeps the travelling language, because it travels.
  assertEquals(stepsFor(true, 'on_its_way')[2].label, 'On its way', 'long rail unchanged')
})

test('the date reads as a person would write it, and matches the card above', () => {
  // The approved card prints "Signed off 24 June 2026" directly above this.
  assertEquals(formatDispatchDate(SHIPPED), '24 June 2026', 'long en-GB form')
  for (const bad of [null, undefined, '', 'yesterday']) {
    assertEquals(formatDispatchDate(bad), null, `${JSON.stringify(bad)} must yield no date`)
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
