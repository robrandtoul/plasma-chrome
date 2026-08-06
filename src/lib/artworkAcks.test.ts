// Unit tests for advisory acknowledgements ("Mark as addressed").
// Run with: npx tsx src/lib/artworkAcks.test.ts
//
// Imports BOTH twins — this src/ copy the report view renders from and the
// Deno copy the artwork-check function writes with — and runs the shared
// surface (key derivation, target matching) through each, so drift between
// the two files fails the suite rather than silently landing ticks the UI
// can't match back to their items. The display derivations (progress,
// display verdict) are frontend-only and tested against the src copy alone.

import * as web from './artworkAcks.ts'
import * as deno from '../../supabase/functions/_shared/artworkCheck/acks.ts'

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

// A report shaped like the live fixture: one defect flag, one review flag,
// one unresolved defect correction, plus non-tickable rows (match /
// not_supplied / resolved correction).
function report(acks?: Record<string, web.AckEntry>) {
  return {
    verdict: 'defect',
    cards: [
      {
        label: 'Derrick Smith — front/back',
        findings: [
          { field: 'name', status: 'match', printed: 'Derrick Smith', severity: 'review' },
          { field: 'email', status: 'flag', printed: 'derick@plak8.com', severity: 'defect' },
          { field: 'job_title', status: 'not_supplied', printed: 'Operations Director', severity: 'review' },
          { field: 'website', status: 'flag', printed: 'plak8.co', severity: 'review' },
        ],
      },
    ],
    corrections: [
      { quote: 'mobile should be 07700 900456', resolved: false, severity: 'defect' },
      { quote: 'thanks, spelling fixed', resolved: true, severity: 'review' },
    ],
    ...(acks ? { acknowledgements: acks } : {}),
  }
}

const emailTarget = { kind: 'finding', card: 'Derrick Smith — front/back', field: 'email', printed: 'derick@plak8.com' } as const
const websiteTarget = { kind: 'finding', card: 'Derrick Smith — front/back', field: 'website', printed: 'plak8.co' } as const
const correctionTarget = { kind: 'correction', quote: 'mobile should be 07700 900456' } as const
const entry = (reason: web.AckReason): web.AckEntry => ({ reason, by: 'Donna Lambe', by_id: 'u1', at: '2026-08-05T10:00:00Z' })

console.log('ackKey — twins agree')
test('finding and correction keys match across twins and stay distinct', () => {
  for (const t of [emailTarget, websiteTarget, correctionTarget]) {
    assertEqual(web.ackKey(t), deno.ackKey(t))
  }
  const keys = [web.ackKey(emailTarget), web.ackKey(websiteTarget), web.ackKey(correctionTarget)]
  assertEqual(new Set(keys).size, 3)
})
test('printed disambiguates two flags of the same field on one card', () => {
  const a = { kind: 'finding', card: 'C', field: 'other', printed: 'one' } as const
  const b = { kind: 'finding', card: 'C', field: 'other', printed: 'two' } as const
  if (web.ackKey(a) === web.ackKey(b)) throw new Error('keys collided')
  assertEqual(web.ackKey(a), deno.ackKey(a))
})

console.log('parseAckTarget (server twin) mirrors what the client sends')
test('round-trips the client payload shapes', () => {
  assertEqual(deno.parseAckTarget({ ...emailTarget }), emailTarget)
  assertEqual(deno.parseAckTarget({ ...correctionTarget }), correctionTarget)
  // An empty printed value is a legitimate finding identity, not malformed.
  assertEqual(deno.parseAckTarget({ kind: 'finding', card: 'C', field: 'tel', printed: '' }), { kind: 'finding', card: 'C', field: 'tel', printed: '' })
})
test('refuses malformed targets', () => {
  assertEqual(deno.parseAckTarget(undefined), null)
  assertEqual(deno.parseAckTarget({}), null)
  assertEqual(deno.parseAckTarget({ kind: 'finding', card: 'C', field: 'tel' }), null)
  assertEqual(deno.parseAckTarget({ kind: 'correction', quote: '' }), null)
})

console.log('ackTargetExists (server twin) — exact match, open items only')
test('finds open advisories, refuses everything else', () => {
  const r = report()
  assertEqual(deno.ackTargetExists(r, emailTarget), true)
  assertEqual(deno.ackTargetExists(r, correctionTarget), true)
  // A match row is not tickable even with matching identity.
  assertEqual(deno.ackTargetExists(r, { kind: 'finding', card: 'Derrick Smith — front/back', field: 'name', printed: 'Derrick Smith' }), false)
  // A resolved correction is not tickable.
  assertEqual(deno.ackTargetExists(r, { kind: 'correction', quote: 'thanks, spelling fixed' }), false)
  // Reworded card label = a different report — no tolerant matching here.
  assertEqual(deno.ackTargetExists(r, { ...emailTarget, card: 'Derrick Smith — front/back (02_Front.ai)' }), false)
})

console.log('ackProgress')
test('counts every advisory once, nothing else', () => {
  assertEqual(web.ackProgress(report()), { total: 3, addressed: 0, open: 3, openDefects: 2 })
})
test('a tick moves an item from open to addressed; defect icon tracks what is LEFT', () => {
  const one = web.ackProgress(report({ [web.ackKey(emailTarget)]: entry('fixed') }))
  assertEqual(one, { total: 3, addressed: 1, open: 2, openDefects: 1 })
  const defectsDone = web.ackProgress(report({
    [web.ackKey(emailTarget)]: entry('fixed'),
    [web.ackKey(correctionTarget)]: entry('intentional'),
  }))
  assertEqual(defectsDone, { total: 3, addressed: 2, open: 1, openDefects: 0 })
})
test('an orphan ack key never inflates the addressed count', () => {
  const r = web.ackProgress(report({ 'f:Nobody::email::x': entry('fixed') }))
  assertEqual(r, { total: 3, addressed: 0, open: 3, openDefects: 2 })
})

console.log('artworkDisplayVerdict — the two greens stay apart')
test('machine states pass through untouched', () => {
  assertEqual(web.artworkDisplayVerdict({ verdict: 'clear', cards: [], corrections: [] }), 'clear')
  assertEqual(web.artworkDisplayVerdict({ verdict: 'error', cards: [], corrections: [] }), 'error')
  assertEqual(web.artworkDisplayVerdict(report()), 'defect')
})
test('partially ticked reads by the severity of what remains', () => {
  const emailDone = report({ [web.ackKey(emailTarget)]: entry('fixed') })
  assertEqual(web.artworkDisplayVerdict(emailDone), 'defect') // correction defect still open
  const defectsDone = report({
    [web.ackKey(emailTarget)]: entry('fixed'),
    [web.ackKey(correctionTarget)]: entry('intentional'),
  })
  assertEqual(web.artworkDisplayVerdict(defectsDone), 'flagged') // only the review flag left
})
test('every advisory ticked = addressed, never clear', () => {
  const all = report({
    [web.ackKey(emailTarget)]: entry('fixed'),
    [web.ackKey(websiteTarget)]: entry('incorrect'),
    [web.ackKey(correctionTarget)]: entry('intentional'),
  })
  assertEqual(web.artworkDisplayVerdict(all), 'addressed')
})
test('a clear report with stray acks stays clear (nothing to address)', () => {
  assertEqual(web.artworkDisplayVerdict({ verdict: 'clear', cards: [], corrections: [], acknowledgements: { x: entry('fixed') } }), 'clear')
})

console.log('hasFixedAcks')
test('true only when a live advisory is ticked as fixed', () => {
  assertEqual(web.hasFixedAcks(report()), false)
  assertEqual(web.hasFixedAcks(report({ [web.ackKey(emailTarget)]: entry('intentional') })), false)
  assertEqual(web.hasFixedAcks(report({ [web.ackKey(emailTarget)]: entry('fixed') })), true)
  // An orphan 'fixed' ack doesn't nudge a re-run of a report it isn't on.
  assertEqual(web.hasFixedAcks(report({ 'f:Nobody::email::x': entry('fixed') })), false)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
