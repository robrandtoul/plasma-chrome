// Unit tests for the health-endpoint grading logic.
// Run with: npx tsx supabase/functions/_shared/health.test.ts
//
// The cases that matter most here are the ones a monitor gets wrong quietly:
// the weekend gap in the cron schedule (a naive freshness rule is red every
// Saturday), and the exact serialisation the Better Stack keyword monitors
// match against.

import {
  buildHealthBody,
  CRON_GRACE_MS,
  gradeCrons,
  gradeStripe,
  keyKind,
  KEYWORD_ASSERTIONS,
  mostRecentExpectedRun,
  serialiseHealthBody,
  stripeKeyConsistent,
  type HealthChecks,
} from './health.ts'

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

function assertTrue(value: boolean, message: string) {
  if (!value) throw new Error(message)
}

// Anchors taken from the live `proofs.nudge_runs` ledger, which has rows on
// 2026-07-27 … 2026-07-31 inclusive and none between — five consecutive days
// under `0 9,15 * * 1-5`, so 27 Jul is a Monday and 31 Jul a Friday.
const FRI_1500 = new Date('2026-07-31T15:00:00Z')
const FRI_0900 = new Date('2026-07-31T09:00:00Z')
const SAT = (t: string) => new Date(`2026-08-01T${t}Z`)
const SUN = (t: string) => new Date(`2026-08-02T${t}Z`)
const MON = (t: string) => new Date(`2026-08-03T${t}Z`)

console.log('keyKind')
test('classifies a Stripe key by its infix without revealing it', () => {
  assertEqual(keyKind('sk_test_abc123'), 'test')
  assertEqual(keyKind('sk_live_abc123'), 'live')
  assertEqual(keyKind('rk_live_abc123'), 'live') // restricted keys carry the same infix
  assertEqual(keyKind('something_else'), 'unknown')
  assertEqual(keyKind(''), 'absent')
  assertEqual(keyKind(undefined), 'absent')
  assertEqual(keyKind(null), 'absent')
})

console.log('stripeKeyConsistent')
test('live mode demands a genuinely live key', () => {
  assertEqual(stripeKeyConsistent('live', 'live'), true)
  assertEqual(stripeKeyConsistent('live', 'test'), false)
  assertEqual(stripeKeyConsistent('live', 'unknown'), false)
  assertEqual(stripeKeyConsistent('live', 'absent'), false)
})
test('test mode tolerates an unclassifiable key but not a live one', () => {
  assertEqual(stripeKeyConsistent('test', 'test'), true)
  assertEqual(stripeKeyConsistent('test', 'unknown'), true)
  assertEqual(stripeKeyConsistent('test', 'live'), false)
  assertEqual(stripeKeyConsistent('test', 'absent'), false)
})

console.log('gradeStripe')
test('a mode/key mismatch is misconfigured even when the API answers', () => {
  assertEqual(gradeStripe('live', 'test', true), 'misconfigured')
  assertEqual(gradeStripe('test', 'live', true), 'misconfigured')
  assertEqual(gradeStripe('live', 'absent', null), 'misconfigured')
})
test('a consistent key that the API rejects is a failure, not a misconfiguration', () => {
  // This is the revoked-key case: the config is right, Stripe says no.
  assertEqual(gradeStripe('live', 'live', false), 'fail')
})
test('consistent config plus a reachable API is ok', () => {
  assertEqual(gradeStripe('live', 'live', true), 'ok')
  assertEqual(gradeStripe('test', 'test', true), 'ok')
})

console.log('mostRecentExpectedRun')
test('on a weekend it looks back to Friday afternoon, not to yesterday', () => {
  // The case a naive "stale after 24h" rule gets wrong every single week.
  assertEqual(mostRecentExpectedRun(SAT('10:00:00'))?.toISOString(), FRI_1500.toISOString())
  assertEqual(mostRecentExpectedRun(SUN('23:00:00'))?.toISOString(), FRI_1500.toISOString())
})
test('early Monday still expects nothing newer than Friday 15:00', () => {
  assertEqual(mostRecentExpectedRun(MON('08:00:00'))?.toISOString(), FRI_1500.toISOString())
})
test('a slot only counts as due once the grace window has passed', () => {
  // 09:20 with a 30-minute grace: the 09:00 slot is not late yet.
  assertEqual(mostRecentExpectedRun(MON('09:20:00'))?.toISOString(), FRI_1500.toISOString())
  // 09:45 is past 09:00 + 30m, so the morning run is now expected.
  assertEqual(
    mostRecentExpectedRun(MON('09:45:00'))?.toISOString(),
    new Date('2026-08-03T09:00:00Z').toISOString(),
  )
})
test('mid-afternoon on a weekday expects that day\'s 15:00 run', () => {
  assertEqual(
    mostRecentExpectedRun(new Date('2026-07-31T16:00:00Z'))?.toISOString(),
    FRI_1500.toISOString(),
  )
})
test('between the two weekday slots it expects the morning run', () => {
  assertEqual(
    mostRecentExpectedRun(new Date('2026-07-31T13:00:00Z'))?.toISOString(),
    FRI_0900.toISOString(),
  )
})

console.log('gradeCrons')
test('a Friday-15:00 run is healthy all weekend', () => {
  const v = gradeCrons(FRI_1500, 0, SAT('11:00:00'))
  assertEqual(v.status, 'ok')
  assertEqual(v.openRuns, 0)
  assertEqual(v.lastRunAgeMinutes, 20 * 60) // 20h
})
test('that same run is stale once Monday morning has come and gone', () => {
  assertEqual(gradeCrons(FRI_1500, 0, MON('10:00:00')).status, 'stale')
})
test('an unfinished run is a failure — it also pauses live sending', () => {
  // send-nudges demotes every later run to dry_run while any row is open, so
  // reminders have silently stopped even though the ledger looks recent.
  const v = gradeCrons(MON('09:00:00'), 1, MON('09:40:00'))
  assertEqual(v.status, 'fail')
  assertEqual(v.openRuns, 1)
})
test('no run ever recorded is a failure, not a pass', () => {
  const v = gradeCrons(null, 0, MON('10:00:00'))
  assertEqual(v.status, 'fail')
  assertEqual(v.lastRunAgeMinutes, null)
})
test('age never reads negative when a run row is a moment ahead of the clock', () => {
  assertEqual(gradeCrons(MON('09:00:30'), 0, MON('09:00:00')).lastRunAgeMinutes, 0)
})
test('the grace window is overridable for testing without touching the default', () => {
  assertEqual(CRON_GRACE_MS, 30 * 60 * 1000)
  assertEqual(gradeCrons(FRI_1500, 0, MON('09:05:00'), 0).status, 'stale')
  assertEqual(gradeCrons(FRI_1500, 0, MON('09:05:00'), CRON_GRACE_MS).status, 'ok')
})

console.log('buildHealthBody')
const allOk: HealthChecks = { db: 'ok', rpc: 'ok', stripe: 'ok', xero: 'ok', crons: 'ok' }
const NOW = MON('12:00:00')

test('everything healthy is a 200 that is neither down nor degraded', () => {
  const { body, status } = buildHealthBody(allOk, {}, NOW)
  assertEqual(status, 200)
  assertEqual(body.ok, true)
  assertEqual(body.degraded, false)
  assertEqual(body.checkedAt, NOW.toISOString())
})
test('a soft dependency failing stays 200 but flags degraded', () => {
  // Xero being dead means paid orders will not invoice — serious, but it is
  // not "the site is down", and it must not page the same way.
  for (const soft of ['stripe', 'xero', 'crons'] as const) {
    const { body, status } = buildHealthBody({ ...allOk, [soft]: 'fail' }, {}, NOW)
    assertEqual(status, 200)
    assertEqual(body.ok, true)
    assertEqual(body.degraded, true)
  }
})
test('either hard dependency failing is a 503', () => {
  for (const hard of ['db', 'rpc'] as const) {
    const { body, status } = buildHealthBody({ ...allOk, [hard]: 'fail' }, {}, NOW)
    assertEqual(status, 503)
    assertEqual(body.ok, false)
  }
})

console.log('serialiseHealthBody')
test('the serialised body carries the exact substrings the monitors match', () => {
  // LOAD-BEARING. Pretty-printing this body would insert a space after every
  // colon and turn every keyword monitor red against a healthy stack.
  const { body } = buildHealthBody(allOk, { xeroConnected: true }, NOW)
  const wire = serialiseHealthBody(body)
  for (const [name, needle] of Object.entries(KEYWORD_ASSERTIONS)) {
    assertTrue(wire.includes(needle), `expected ${name} assertion ${needle} in ${wire}`)
  }
})
test('an unhealthy check stops matching its keyword', () => {
  const { body } = buildHealthBody({ ...allOk, xero: 'disconnected' }, {}, NOW)
  const wire = serialiseHealthBody(body)
  assertTrue(!wire.includes(KEYWORD_ASSERTIONS.xero), 'xero keyword should not match')
  assertTrue(wire.includes(KEYWORD_ASSERTIONS.stripe), 'stripe keyword should still match')
})
test('the body is compact — no whitespace after any colon', () => {
  const { body } = buildHealthBody(allOk, { note: 'x' }, NOW)
  const wire = serialiseHealthBody(body)
  assertTrue(!/:\s/.test(wire), `body must not be pretty-printed: ${wire}`)
})
test('detail is carried through untouched', () => {
  const { body } = buildHealthBody(allOk, { lastRunAgeMinutes: 42, xeroConnected: true }, NOW)
  assertEqual(body.detail.lastRunAgeMinutes, 42)
  assertEqual(body.detail.xeroConnected, true)
})

console.log('')
console.log(`${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
