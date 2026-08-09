// Unit tests for planDesk in reorderDesk.ts
// Run with: npx tsx src/lib/reorderDesk.test.ts
//
// planDesk is the Reorder desk's whole day in one pure function: which past
// customers get served, which wait, and which of yesterday's decisions the
// rest of the system has already made for us. The cases here pin the queue
// arithmetic (the daily BUDGET — every queued_on-today row spends a slot
// whatever state it has since moved to — stale-first re-serving, suppression
// windows, dedupe across the three merged fetches) and the contacted-row
// partitions (reply detection vs follow-up vs quiet close vs outcome sync),
// because a silent bug in any of them either over-contacts customers who
// asked for nothing or lets an opened-and-interested one go cold.
//
// ⚠ Import shim: reorderDesk.ts imports './supabase' (and './audit') at
// module top, and the client's env module reads import.meta.env — which only
// exists under Vite, so a plain static import crashes under tsx. planDesk
// itself never touches the client, so the hooks below stub those two
// specifiers with inert modules for THIS resolve only (keyed on the parent
// being reorderDesk.ts) and the module is pulled in via dynamic import after
// the hooks are registered. Same motivation as duplicateProof.test.ts
// importing the pure mapping sibling — this module just has no pure sibling
// to import instead.

import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((context.parentURL ?? '').endsWith('/src/lib/reorderDesk.ts')) {
      if (specifier === './supabase') {
        return { url: 'data:text/javascript,export const supabase = {}', shortCircuit: true }
      }
      if (specifier === './audit') {
        return {
          url: 'data:text/javascript,export async function logAudit() {}',
          shortCircuit: true,
        }
      }
    }
    return nextResolve(specifier, context)
  },
})

const { planDesk, todayIsoLocal } = await import('./reorderDesk.ts')
type ReorderProspect = import('./reorderDesk.ts').ReorderProspect
type OutreachProofFacts = import('./reorderDesk.ts').OutreachProofFacts

// ── Harness ─────────────────────────────────────────────────────────────────

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

function assert(cond: boolean, message: string) {
  if (!cond) throw new Error(message)
}

// ── Fixtures ────────────────────────────────────────────────────────────────

// Fixed dates so the maths is readable — planDesk compares ISO strings and
// does date-only arithmetic on them, so no clock is involved and nothing here
// can flake at midnight.
const TODAY = '2026-03-10'
const YESTERDAY = '2026-03-09'
const TOMORROW = '2026-03-11'
// The default follow-up window used throughout (mirrors the settings default).
const FOLLOWUP = 5

let seq = 0

function mk(overrides: Partial<ReorderProspect> = {}): ReorderProspect {
  seq += 1
  return {
    id: `rp-${seq}`,
    xero_contact_id: null,
    customer_name: `Customer ${seq}`,
    email: `customer${seq}@example.invalid`,
    currency: 'GBP',
    first_order_on: '2023-01-10',
    last_order_on: '2024-06-01',
    orders_count: 3,
    lifetime_value: 1200,
    avg_order_value: 400,
    cadence_days: 180,
    score: 50,
    score_reasons: ['3 orders', 'steady cadence'],
    state: 'pending',
    queued_on: null,
    contacted_at: null,
    follow_up_due_on: null,
    followed_up_at: null,
    proof_id: null,
    matched_contact_id: null,
    outcome_note: null,
    suppressed_until: null,
    ...overrides,
  }
}

function facts(
  entries: Array<[string, Partial<OutreachProofFacts>]>,
): Map<string, OutreachProofFacts> {
  return new Map(
    entries.map(([id, f]) => [id, { status: 'in_progress', opened: false, repliedAt: null, ...f }]),
  )
}

const ids = (list: ReorderProspect[]) => list.map((p) => p.id)

// ── Promotion arithmetic ─────────────────────────────────────────────────────

test('promotion tops the queue up to dailyLimit from pending, best score first', () => {
  const q1 = mk({ state: 'queued', queued_on: TODAY, score: 10 })
  const p90 = mk({ score: 90 })
  const p80 = mk({ score: 80 })
  const p70 = mk({ score: 70 })
  // Deliberately unsorted input — planDesk owns the ordering.
  const plan = planDesk([p70, q1, p90, p80], facts([]), TODAY, 3, FOLLOWUP)

  // Already-queued-today spends a budget slot: room for only 2 promotions.
  assertEqual(ids(plan.promote), [p90.id, p80.id], 'promote')
  // The day's queue is servings + promotions, best score first; p70 waits.
  assertEqual(ids(plan.queue), [p90.id, p80.id, q1.id], 'queue')
})

test('promote contains only rows needing the DB write — never the already-queued-today ones', () => {
  const q1 = mk({ state: 'queued', queued_on: TODAY, score: 99 })
  const p1 = mk({ score: 40 })
  const plan = planDesk([q1, p1], facts([]), TODAY, 5, FOLLOWUP)
  assertEqual(ids(plan.promote), [p1.id], 'promote')
  assertEqual(ids(plan.queue), [q1.id, p1.id], 'queue')
})

test('yesterday’s stale queued rows are re-served before fresh pending, and appear in promote', () => {
  // The stale row was already surfaced once — it goes first even though its
  // score loses to the fresh name, and it needs the DB write to re-stamp
  // queued_on, so it must be in promote.
  const stale = mk({ state: 'queued', queued_on: YESTERDAY, score: 5 })
  const fresh = mk({ score: 95 })
  const plan = planDesk([fresh, stale], facts([]), TODAY, 1, FOLLOWUP)
  assertEqual(ids(plan.promote), [stale.id], 'promote')
  assertEqual(ids(plan.queue), [stale.id], 'queue')
})

test('several stale rows re-serve by score, still ahead of any pending', () => {
  const staleLow = mk({ state: 'queued', queued_on: YESTERDAY, score: 10 })
  const staleHigh = mk({ state: 'queued', queued_on: YESTERDAY, score: 20 })
  const fresh = mk({ score: 95 })
  const plan = planDesk([fresh, staleLow, staleHigh], facts([]), TODAY, 2, FOLLOWUP)
  assertEqual(ids(plan.promote), [staleHigh.id, staleLow.id], 'promote')
})

// ── The daily budget ────────────────────────────────────────────────────────

test('working a card does not refill the desk: queued_on-today rows spend budget in ANY state', () => {
  // One card was started (in_build) and one already contacted this morning —
  // both still carry today's queued_on, so with a limit of 3 only ONE fresh
  // promotion fits. This is the whole point of the budget model: progressing
  // through the day's cards must not keep topping the desk back up.
  const started = mk({ state: 'in_build', queued_on: TODAY, proof_id: 'pr-b' })
  const emailed = mk({
    state: 'contacted',
    queued_on: TODAY,
    contacted_at: '2026-03-10T09:00:00Z',
    proof_id: 'pr-c',
  })
  const p90 = mk({ score: 90 })
  const p80 = mk({ score: 80 })
  const plan = planDesk([started, emailed, p90, p80], facts([]), TODAY, 3, FOLLOWUP)
  assertEqual(ids(plan.promote), [p90.id], 'promote')
  assertEqual(ids(plan.queue), [p90.id], 'queue')
  assertEqual(ids(plan.inBuild), [started.id], 'inBuild')
})

test('a pending row already served today is not re-promoted, but still spends its slot', () => {
  // skipProspect keeps queued_on — a rested card must neither reappear the
  // same day nor free its slot for a fresh name.
  const skipped = mk({ state: 'pending', queued_on: TODAY, score: 99 })
  const fresh = mk({ score: 40 })
  const plan = planDesk([skipped, fresh], facts([]), TODAY, 2, FOLLOWUP)
  assertEqual(ids(plan.promote), [fresh.id], 'promote')
  assertEqual(ids(plan.queue), [fresh.id], 'queue')
})

test('duplicate rows from the merged fetches dedupe by id, first occurrence wins', () => {
  // fetchDeskData merges three queries, and a queued-today row legitimately
  // arrives twice (live-states read + served-today read). It must render
  // once, spend ONE budget slot, and the first copy's state must win.
  const q1 = mk({ state: 'queued', queued_on: TODAY, score: 60 })
  const dupe = { ...q1, state: 'pending' as const }
  const fresh = mk({ score: 40 })
  const plan = planDesk([q1, dupe, fresh], facts([]), TODAY, 2, FOLLOWUP)
  assertEqual(ids(plan.queue), [q1.id, fresh.id], 'queue')
  assertEqual(ids(plan.promote), [fresh.id], 'promote')
})

test('an unservable queued-today row drops from the queue display but still spends budget', () => {
  // Another dashboard rested this card AFTER it was promoted: it must not
  // render, and its slot must not be resold to a fresh name.
  const restedAfterServe = mk({
    state: 'queued',
    queued_on: TODAY,
    suppressed_until: TOMORROW,
    score: 70,
  })
  const fresh = mk({ score: 95 })
  const plan = planDesk([restedAfterServe, fresh], facts([]), TODAY, 1, FOLLOWUP)
  assertEqual(ids(plan.queue), [], 'queue')
  assertEqual(ids(plan.promote), [], 'promote')
})

// ── Suppression windows ─────────────────────────────────────────────────────

test('suppressed_until in the future keeps a pending row out of promotion entirely', () => {
  const rested = mk({ score: 99, suppressed_until: TOMORROW })
  const plain = mk({ score: 10 })
  const plan = planDesk([rested, plain], facts([]), TODAY, 5, FOLLOWUP)
  assertEqual(ids(plan.promote), [plain.id], 'promote')
  assertEqual(ids(plan.queue), [plain.id], 'queue')
})

test('suppressed_until today or earlier no longer suppresses', () => {
  const dueToday = mk({ score: 60, suppressed_until: TODAY })
  const lapsed = mk({ score: 50, suppressed_until: YESTERDAY })
  const plan = planDesk([dueToday, lapsed], facts([]), TODAY, 5, FOLLOWUP)
  assertEqual(ids(plan.promote), [dueToday.id, lapsed.id], 'promote')
})

test('a stale queued row inside its suppression window is not re-served either', () => {
  const stale = mk({ state: 'queued', queued_on: YESTERDAY, score: 80, suppressed_until: TOMORROW })
  const plan = planDesk([stale], facts([]), TODAY, 5, FOLLOWUP)
  assertEqual(ids(plan.queue), [], 'queue')
  assertEqual(ids(plan.promote), [], 'promote')
})

// ── In build ────────────────────────────────────────────────────────────────

test('in_build rows land in inBuild regardless of the limit, never in the queue', () => {
  const building = mk({ state: 'in_build', proof_id: 'pr-1', score: 100 })
  const zero = planDesk([building], facts([]), TODAY, 0, FOLLOWUP)
  assertEqual(ids(zero.inBuild), [building.id], 'inBuild at limit 0')
  assertEqual(ids(zero.queue), [], 'queue at limit 0')

  const five = planDesk([building], facts([]), TODAY, 5, FOLLOWUP)
  assertEqual(ids(five.inBuild), [building.id], 'inBuild at limit 5')
  assertEqual(ids(five.queue), [], 'queue at limit 5')
})

// ── dailyLimit 0 ────────────────────────────────────────────────────────────

test('dailyLimit 0 serves nothing and promotes nothing', () => {
  const stale = mk({ state: 'queued', queued_on: YESTERDAY, score: 80 })
  const pending = mk({ score: 90 })
  const plan = planDesk([stale, pending], facts([]), TODAY, 0, FOLLOWUP)
  assertEqual(ids(plan.queue), [], 'queue')
  assertEqual(ids(plan.promote), [], 'promote')
})

// ── Contacted: follow-up vs quiet close ─────────────────────────────────────

function contacted(overrides: Partial<ReorderProspect> = {}): ReorderProspect {
  return mk({
    state: 'contacted',
    contacted_at: '2026-03-03T09:00:00Z',
    follow_up_due_on: YESTERDAY,
    proof_id: `pr-${seq + 1}`, // mk bumps seq before spreading overrides
    ...overrides,
  })
}

test('contacted + due + opened → followUps; not opened → quietCloses', () => {
  const opened = contacted({ proof_id: 'pr-open' })
  const unopened = contacted({ proof_id: 'pr-quiet' })
  const plan = planDesk(
    [opened, unopened],
    facts([
      ['pr-open', { opened: true }],
      ['pr-quiet', { opened: false }],
    ]),
    TODAY,
    5,
    FOLLOWUP,
  )
  assertEqual(ids(plan.followUps), [opened.id], 'followUps')
  assertEqual(ids(plan.quietCloses), [unopened.id], 'quietCloses')
})

test('follow_up_due_on today counts as due (inclusive)', () => {
  const dueToday = contacted({ proof_id: 'pr-t', follow_up_due_on: TODAY })
  const plan = planDesk([dueToday], facts([['pr-t', { opened: true }]]), TODAY, 5, FOLLOWUP)
  assertEqual(ids(plan.followUps), [dueToday.id], 'followUps')
})

test('a follow-up not yet due lands in neither bucket', () => {
  const early = contacted({ proof_id: 'pr-e', follow_up_due_on: TOMORROW })
  const plan = planDesk([early], facts([['pr-e', { opened: true }]]), TODAY, 5, FOLLOWUP)
  assertEqual(ids(plan.followUps), [], 'followUps')
  assertEqual(ids(plan.quietCloses), [], 'quietCloses')
})

test('missing proof facts (null proof_id, or a proof the map doesn’t know) reads as not-opened', () => {
  // The quiet-close path must not be dodged by a data gap: no facts means no
  // evidence anyone opened the page, and silence is handled as silence.
  const noProof = contacted({ proof_id: null })
  const unknownProof = contacted({ proof_id: 'pr-unknown' })
  const plan = planDesk([noProof, unknownProof], facts([]), TODAY, 5, FOLLOWUP)
  assertEqual(ids(plan.quietCloses), [noProof.id, unknownProof.id], 'quietCloses')
  assertEqual(ids(plan.followUps), [], 'followUps')
})

// ── Post-follow-up close ────────────────────────────────────────────────────

test('a sent follow-up closes quietly once its window passes (boundary day inclusive)', () => {
  // followed_up 2026-03-05 + 5 days = 2026-03-10 = today → the window has
  // passed in silence and the desk closes the loop.
  const windowPassed = contacted({
    proof_id: 'pr-fp',
    followed_up_at: '2026-03-05T10:00:00Z',
  })
  const plan = planDesk([windowPassed], facts([['pr-fp', { opened: true }]]), TODAY, 5, FOLLOWUP)
  assertEqual(ids(plan.quietCloses), [windowPassed.id], 'quietCloses')
  assertEqual(ids(plan.followUps), [], 'followUps')
})

test('a sent follow-up still inside its window lands in neither bucket', () => {
  // followed_up 2026-03-06 + 5 days = 2026-03-11 > today → still waiting.
  const waiting = contacted({
    proof_id: 'pr-fw',
    followed_up_at: '2026-03-06T10:00:00Z',
  })
  const plan = planDesk([waiting], facts([['pr-fw', { opened: true }]]), TODAY, 5, FOLLOWUP)
  assertEqual(ids(plan.followUps), [], 'followUps')
  assertEqual(ids(plan.quietCloses), [], 'quietCloses')
})

// ── Replies (toReply) ───────────────────────────────────────────────────────

test('a customer reply after the outreach lands in toReply — even unopened, even mid-window', () => {
  // The outreach note invites replying WITHOUT opening the page, so a reply
  // is engagement in its own right: no follow-up, no quiet close — the desk
  // steps back and the conversation continues in Help Scout.
  const replier = contacted({ proof_id: 'pr-r' })
  const plan = planDesk(
    [replier],
    facts([['pr-r', { opened: false, repliedAt: '2026-03-05T08:00:00Z' }]]),
    TODAY,
    5,
    FOLLOWUP,
  )
  assertEqual(ids(plan.toReply), [replier.id], 'toReply')
  assertEqual(ids(plan.followUps), [], 'followUps')
  assertEqual(ids(plan.quietCloses), [], 'quietCloses')
})

test('a reply from BEFORE the outreach (old thread) is ignored', () => {
  // These customers often have years-old Help Scout threads — a reply that
  // predates contacted_at is history, not engagement, and the normal
  // partition applies.
  const oldThread = contacted({ proof_id: 'pr-old' })
  const plan = planDesk(
    [oldThread],
    facts([['pr-old', { opened: true, repliedAt: '2026-03-01T08:00:00Z' }]]),
    TODAY,
    5,
    FOLLOWUP,
  )
  assertEqual(ids(plan.toReply), [], 'toReply')
  assertEqual(ids(plan.followUps), [oldThread.id], 'followUps')
})

test('replied-and-approved → toReply wins (checked before the outcome buckets)', () => {
  const both = contacted({ proof_id: 'pr-ra' })
  const plan = planDesk(
    [both],
    facts([['pr-ra', { status: 'approved', opened: true, repliedAt: '2026-03-05T08:00:00Z' }]]),
    TODAY,
    5,
    FOLLOWUP,
  )
  assertEqual(ids(plan.toReply), [both.id], 'toReply')
  assertEqual(ids(plan.toConvert), [], 'toConvert')
})

test('a reply also beats the post-follow-up quiet close', () => {
  // Follow-up sent, window passed — but they answered by email in between.
  // Closing them quietly now would ghost a live conversation.
  const answered = contacted({
    proof_id: 'pr-aw',
    followed_up_at: '2026-03-04T10:00:00Z',
  })
  const plan = planDesk(
    [answered],
    facts([['pr-aw', { opened: false, repliedAt: '2026-03-06T08:00:00Z' }]]),
    TODAY,
    5,
    FOLLOWUP,
  )
  assertEqual(ids(plan.toReply), [answered.id], 'toReply')
  assertEqual(ids(plan.quietCloses), [], 'quietCloses')
})

// ── Outcome sync ────────────────────────────────────────────────────────────

test('a contacted prospect whose proof got approved goes to toConvert, not followUps — even when due', () => {
  const won = contacted({ proof_id: 'pr-won' })
  const plan = planDesk(
    [won],
    facts([['pr-won', { status: 'approved', opened: true }]]),
    TODAY,
    5,
    FOLLOWUP,
  )
  assertEqual(ids(plan.toConvert), [won.id], 'toConvert')
  assertEqual(ids(plan.followUps), [], 'followUps')
  assertEqual(ids(plan.quietCloses), [], 'quietCloses')
})

test('a contacted prospect whose proof was abandoned elsewhere goes to toClose', () => {
  const lost = contacted({ proof_id: 'pr-lost' })
  const plan = planDesk(
    [lost],
    facts([['pr-lost', { status: 'abandoned' }]]),
    TODAY,
    5,
    FOLLOWUP,
  )
  assertEqual(ids(plan.toClose), [lost.id], 'toClose')
  assertEqual(ids(plan.quietCloses), [], 'quietCloses')
})

test('replied rows sync outcomes but never enter the follow-up or reply buckets', () => {
  // Once a row IS 'replied' the desk has already stepped back — a fresh reply
  // stamp must not re-emit it into toReply, and the follow-up machinery
  // stays off it; only the win/loss outcomes still sync.
  const repliedWon = mk({
    state: 'replied',
    proof_id: 'pr-rw',
    contacted_at: '2026-03-03T09:00:00Z',
  })
  const repliedOpen = mk({
    state: 'replied',
    proof_id: 'pr-ro',
    contacted_at: '2026-03-03T09:00:00Z',
    follow_up_due_on: YESTERDAY,
  })
  const plan = planDesk(
    [repliedWon, repliedOpen],
    facts([
      ['pr-rw', { status: 'approved', opened: true, repliedAt: '2026-03-05T08:00:00Z' }],
      ['pr-ro', { opened: true, repliedAt: '2026-03-05T08:00:00Z' }],
    ]),
    TODAY,
    5,
    FOLLOWUP,
  )
  assertEqual(ids(plan.toConvert), [repliedWon.id], 'toConvert')
  assertEqual(ids(plan.toReply), [], 'toReply')
  assertEqual(ids(plan.followUps), [], 'followUps')
  assertEqual(ids(plan.quietCloses), [], 'quietCloses')
  assertEqual(ids(plan.toClose), [], 'toClose')
})

// ── todayIsoLocal ───────────────────────────────────────────────────────────

test('todayIsoLocal is a local-clock YYYY-MM-DD (what queued_on is compared against)', () => {
  const iso = todayIsoLocal()
  assert(/^\d{4}-\d{2}-\d{2}$/.test(iso), `not an ISO date: ${iso}`)
  const d = new Date()
  assertEqual(iso.slice(0, 4), String(d.getFullYear()), 'year')
  assertEqual(Number(iso.slice(5, 7)), d.getMonth() + 1, 'month')
  assertEqual(Number(iso.slice(8, 10)), d.getDate(), 'day')
})

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
