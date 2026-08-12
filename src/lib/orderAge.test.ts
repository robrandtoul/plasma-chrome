// Unit tests for orderAge.ts
// Run with: npx tsx src/lib/orderAge.test.ts   (or pnpm test:order-age)
//
// This column decides the order people work in, so two things have to hold:
//
//   1. each stage measures from ITS OWN event. A Place row aged from approval
//      would read as weeks old the moment a customer took their time paying,
//      and oldest-first would put the wrong job top of the list every time.
//   2. a row with no clock never leads an oldest-first sort. An unknown age is
//      not evidence of urgency, and floating it to the top is the one way this
//      column could actively mislead.

import {
  orderAge, formatAge, ageTone, ageAnchor, ageMs, sortByAge,
  type OrderStage,
} from './orderAge'

let passed = 0
let failed = 0

function test(name: string, fn: () => void) {
  try { fn(); console.log(`  ✓ ${name}`); passed++ }
  catch (err) { console.log(`  ✗ ${name}`); console.log(`    ${(err as Error).message}`); failed++ }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m) }
function assertEqual<T>(a: T, e: T, m?: string) {
  if (a !== e) throw new Error(m ?? `Expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`)
}

const NOW = new Date('2026-08-12T12:00:00Z')
const ago = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString()

console.log('\norderAge')

// ── Each stage reads its own clock ──────────────────────────────────────────

test('every stage measures from its own event, not a shared one', () => {
  // One row carrying ALL four timestamps, deliberately far apart. If any stage
  // read the wrong field this comes out wrong in an obvious direction.
  const row = {
    approved_at:       ago(24 * 9),   // 9 days
    paid_at:           ago(24 * 2),   // 2 days
    supplier_reply_at: ago(5),        // 5 hours
    sent_at:           ago(24 * 4),   // 4 days
  }
  assertEqual(orderAge('send', row, NOW)!.label, '9d')
  assertEqual(orderAge('place', row, NOW)!.label, '2d')
  assertEqual(orderAge('check', row, NOW)!.label, '5h')
  assertEqual(orderAge('waiting', row, NOW)!.label, '4d')
})

test('the anchor field is the one documented for each stage', () => {
  const row = { approved_at: 'A', paid_at: 'P', supplier_reply_at: 'R', sent_at: 'S' }
  assertEqual(ageAnchor('send', row), 'A')
  assertEqual(ageAnchor('place', row), 'P')
  assertEqual(ageAnchor('check', row), 'R')
  assertEqual(ageAnchor('waiting', row), 'S')
})

// ── Thresholds differ by stage, on purpose ──────────────────────────────────

test('a day means different things in different sections', () => {
  // The whole reason thresholds aren't shared: one day of us not sending a link
  // is careless; one day of a customer not paying is completely normal.
  assertEqual(ageTone('check', 1), 'warn', 'a supplier reply unread for a day is late')
  assertEqual(ageTone('waiting', 1), 'calm', 'a customer not paying for a day is normal')
  assertEqual(ageTone('waiting', 10), 'urgent', 'ten days unpaid is not')
})

test('tones escalate calm → warn → urgent and never skip backwards', () => {
  for (const stage of ['send', 'place', 'check', 'waiting'] as OrderStage[]) {
    const rank = { calm: 0, warn: 1, urgent: 2 }
    let last = 0
    for (let d = 0; d <= 30; d++) {
      const r = rank[ageTone(stage, d)]
      assert(r >= last, `${stage} went backwards at ${d} days`)
      last = r
    }
    assertEqual(ageTone(stage, 0), 'calm', `${stage} should be calm on day zero`)
    assertEqual(ageTone(stage, 60), 'urgent', `${stage} should be urgent after two months`)
  }
})

// ── Labels ──────────────────────────────────────────────────────────────────

test('labels are coarse: hours, then days, then weeks', () => {
  assertEqual(formatAge(ago(0.4), NOW).label, 'now')
  assertEqual(formatAge(ago(5), NOW).label, '5h')
  assertEqual(formatAge(ago(23), NOW).label, '23h')
  assertEqual(formatAge(ago(24), NOW).label, '1d')
  assertEqual(formatAge(ago(24 * 13), NOW).label, '13d')
  assertEqual(formatAge(ago(24 * 21), NOW).label, '3w')
})

test('a future timestamp reads as "now", never as negative', () => {
  // Clock skew between Stripe/Help Scout and us is real; "-1h" on a worklist
  // reads as a bug and undermines the column.
  const future = new Date(NOW.getTime() + 90 * 60_000).toISOString()
  assertEqual(formatAge(future, NOW).label, 'now')
  assertEqual(formatAge(future, NOW).days, 0)
  assert(ageMs('place', { paid_at: future }, NOW) >= 0, 'sort weight must not go negative')
})

// ── No clock ────────────────────────────────────────────────────────────────

test('a row with no clock returns null rather than a zero', () => {
  // A Place row whose payment webhook hasn't landed genuinely has no age.
  // Rendering "0d" would claim it arrived this instant.
  assertEqual(orderAge('place', { paid_at: null }, NOW), null)
  assertEqual(orderAge('send', {}, NOW), null)
})

test('a row with no clock sinks to the BOTTOM of an oldest-first list', () => {
  // The one way this column could actively mislead: an unknown age floating to
  // the top of the list people work down.
  const rows = [
    { id: 'no-clock', paid_at: null },
    { id: 'old', paid_at: ago(24 * 6) },
    { id: 'new', paid_at: ago(2) },
  ]
  const oldest = sortByAge(rows, 'place', (r) => r, 'oldest', NOW).map((r) => r.id)
  assertEqual(oldest.join(','), 'old,new,no-clock')

  // …and stays at the bottom when the sort is flipped, rather than swapping ends.
  const newest = sortByAge(rows, 'place', (r) => r, 'newest', NOW).map((r) => r.id)
  assertEqual(newest.join(','), 'new,old,no-clock')
})

test('sorting does not mutate the caller’s array', () => {
  const rows = [{ id: 'a', paid_at: ago(1) }, { id: 'b', paid_at: ago(50) }]
  const before = rows.map((r) => r.id).join(',')
  sortByAge(rows, 'place', (r) => r, 'oldest', NOW)
  assertEqual(rows.map((r) => r.id).join(','), before, 'input order changed')
})

test('oldest-first really is oldest first', () => {
  const rows = [
    { id: 'd1', paid_at: ago(24) },
    { id: 'd9', paid_at: ago(24 * 9) },
    { id: 'h3', paid_at: ago(3) },
  ]
  assertEqual(sortByAge(rows, 'place', (r) => r, 'oldest', NOW).map((r) => r.id).join(','), 'd9,d1,h3')
  assertEqual(sortByAge(rows, 'place', (r) => r, 'newest', NOW).map((r) => r.id).join(','), 'h3,d1,d9')
})

// ── Accessibility ───────────────────────────────────────────────────────────

test('the spoken form is words, not an abbreviation', () => {
  // "2d" read aloud is not a duration. The column has a title/label for that.
  const a = orderAge('place', { paid_at: ago(48) }, NOW)!
  assert(a.title.includes('waiting'), 'title should say what the number means')
  // The abbreviation must NOT be the accessible name: "waiting 5 d" is noise.
  assert(!/\d[hdw]\b/.test(a.title), `title still carries the abbreviation: ${a.title}`)
  assertEqual(a.title, 'waiting 2 days')
  assertEqual(orderAge('place', { paid_at: ago(0.2) }, NOW)!.title, 'waiting less than an hour')
  assertEqual(orderAge('place', { paid_at: ago(1) }, NOW)!.title, 'waiting 1 hour', 'singular, not "1 hours"')
  assertEqual(orderAge('place', { paid_at: ago(24) }, NOW)!.title, 'waiting 1 day')
  assertEqual(orderAge('place', { paid_at: ago(24 * 21) }, NOW)!.title, 'waiting 3 weeks')
})

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
