// Unit tests for dashboardActivityFeed.ts
// Run with: npx tsx src/lib/dashboardActivityFeed.test.ts
//
// The thing worth pinning here is that the LIVE path and the POLLED path agree
// about what the feed contains.
//
// The card is rebuilt from the database every 45 seconds, and in between,
// realtime page views are folded in by hand. Any rule the two implement
// differently shows up as a row that appears, then changes or vanishes a few
// seconds later with nobody having done anything — which reads as a bug in the
// data, not in the merge. The two rules that carry all the risk:
//
//   1. dashboard_latest_events keeps ONE row per version per day, holding the
//      latest view of that day (000242). A customer refreshing five times is
//      one line whose clock moves, not five lines.
//   2. It cuts those days in UTC, because the database session runs at UTC.
//
// Everything else here is about not lying: never invent a row we can't name,
// never show a bot, never hand React a new array when nothing changed.

import {
  ACTIVITY_FEED_CAP,
  applyLiveView,
  viewDayKey,
  type LiveViewRow,
} from './dashboardActivityFeed.ts'
import type { DashboardLatestEvent, DashboardProject } from './dashboardGrouping.ts'

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

// ── Fixtures ────────────────────────────────────────────────────────────────

const VERSION_ID = '11111111-1111-1111-1111-111111111111'
const OLD_VERSION_ID = '22222222-2222-2222-2222-222222222222'
const PROOF_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

function project(over: Partial<DashboardProject> = {}): DashboardProject {
  return {
    proof_id: PROOF_ID,
    contact_name: 'Nolan Bushnell',
    company_name: 'Atari Corp',
    current_version_id: VERSION_ID,
    current_version_number: 3,
    ...over,
  } as DashboardProject
}

function view(over: Partial<LiveViewRow> = {}): LiveViewRow {
  return {
    id: 'view-new',
    proof_version_id: VERSION_ID,
    viewed_at: '2026-08-08T14:00:00.000Z',
    is_bot: false,
    ...over,
  }
}

function feedRow(over: Partial<DashboardLatestEvent> = {}): DashboardLatestEvent {
  return {
    id: 'view-old',
    created_at: '2026-08-08T09:00:00.000Z',
    event_type: 'view',
    actor_name: 'Nolan Bushnell',
    recipient_name: null,
    helpscout_thread_id: null,
    proof_version_id: VERSION_ID,
    proof_id: PROOF_ID,
    version_number: 3,
    contact_name: 'Nolan Bushnell',
    company_name: 'Atari Corp',
    ...over,
  }
}

// ── Day keys ────────────────────────────────────────────────────────────────

console.log('\nviewDayKey — the same days the database cuts')

test('a day is a UTC day, not a London one', () => {
  // 00:30 BST on 9 August is 23:30 UTC on the 8th. date_trunc on the live
  // database (session TimeZone = UTC) puts this view on the 8th, so this must
  // too — otherwise, every summer night between 23:00 and midnight UTC, a
  // repeat view opens a SECOND row that the next poll then merges away.
  assertEquals(viewDayKey('2026-08-08T23:30:00.000Z'), '2026-08-08', 'late-evening UTC stays on its own day')
  assertEquals(viewDayKey('2026-08-09T00:30:00.000Z'), '2026-08-09', 'past UTC midnight is the next day')
})

test('two views either side of UTC midnight are different days', () => {
  assert(viewDayKey('2026-08-08T23:59:59.000Z') !== viewDayKey('2026-08-09T00:00:01.000Z'),
    'a genuine day boundary must produce two rows, as the view does')
})

// ── Repeat views ────────────────────────────────────────────────────────────

console.log('\napplyLiveView — a refresh moves a row, it does not add one')

test('a second view of the same version on the same day updates in place', () => {
  const before = [feedRow()]
  const { events, needsRefresh } = applyLiveView(before, view(), [project()])
  assertEquals(events.length, 1, 'one row per version per day — this is the 000242 rule')
  assertEquals(events[0].created_at, '2026-08-08T14:00:00.000Z', 'the clock moves to the latest view')
  assertEquals(events[0].id, 'view-new', 'and the id follows, as distinct-on picks the latest row')
  assertEquals(events[0].company_name, 'Atari Corp', 'the joined display fields survive the update')
  assertEquals(needsRefresh, false, 'nothing had to be looked up')
})

test('a view that arrives out of order and is older changes nothing', () => {
  const before = [feedRow({ created_at: '2026-08-08T18:00:00.000Z', id: 'view-latest' })]
  const { events } = applyLiveView(before, view({ viewed_at: '2026-08-08T14:00:00.000Z' }), [project()])
  assert(events === before, 'an older view is not the latest of the day, so the array must be untouched')
})

test('a view the next day opens its own row', () => {
  const before = [feedRow()]
  const { events } = applyLiveView(before, view({ viewed_at: '2026-08-09T09:00:00.000Z' }), [project()])
  assertEquals(events.length, 2, 'a new day is a new row')
  assertEquals(events[0].created_at, '2026-08-09T09:00:00.000Z', 'newest first')
})

test('a view of a DIFFERENT version does not collapse into an existing row', () => {
  const before = [feedRow()]
  const other = '33333333-3333-3333-3333-333333333333'
  const { events, needsRefresh } = applyLiveView(
    before,
    view({ proof_version_id: other }),
    [project(), project({ proof_id: 'bbbb', current_version_id: other, current_version_number: 1 })],
  )
  assertEquals(events.length, 2, 'the dedup key is (version, day) — a different version is a different row')
  assertEquals(needsRefresh, false, 'it was placeable from the loaded projects')
})

// ── New rows ────────────────────────────────────────────────────────────────

console.log('\napplyLiveView — a new row is only added when it can be named')

test('a first view is added, enriched from the loaded project', () => {
  const { events, needsRefresh } = applyLiveView([], view(), [project()])
  assertEquals(events.length, 1, 'the row is added')
  assertEquals(events[0].event_type, 'view', 'as a view')
  assertEquals(events[0].proof_id, PROOF_ID, 'pointing at the proof, so the row navigates')
  assertEquals(events[0].version_number, 3, 'carrying the version number the card prints')
  assertEquals(events[0].actor_name, 'Nolan Bushnell', 'and the contact, as the view would')
  assertEquals(needsRefresh, false, 'no refetch needed')
})

test('a proof with no contact still reads as somebody, matching the view', () => {
  // dashboard_latest_events uses coalesce(c.full_name, 'Customer'). A blank
  // name would render "opened v3" with nothing in front of it.
  const { events } = applyLiveView([], view(), [project({ contact_name: null })])
  assertEquals(events[0].actor_name, 'Customer', 'the view falls back to Customer, so this does too')
})

test('a view of a SUPERSEDED version asks for a refetch instead of guessing', () => {
  // The loaded projects only know each proof's current version, so there is no
  // honest version number for this row. Inventing one would print "opened v3"
  // about a customer who opened v1.
  const { events, needsRefresh } = applyLiveView([], view({ proof_version_id: OLD_VERSION_ID }), [project()])
  assertEquals(events.length, 0, 'nothing invented')
  assertEquals(needsRefresh, true, 'the poll is asked to fetch it properly')
})

test('a view of a proof outside the loaded set asks for a refetch', () => {
  const { events, needsRefresh } = applyLiveView([], view(), [])
  assertEquals(events.length, 0, 'no row')
  assertEquals(needsRefresh, true, 'but not silently dropped either')
})

test('a bot view never reaches the card, and never triggers a refetch', () => {
  // The view filters bots server-side, so a bot row shown live would be taken
  // away again by the next poll — and asking for a refetch on one would let a
  // crawler drive the dashboard.
  const { events, needsRefresh } = applyLiveView([], view({ is_bot: true }), [project()])
  assertEquals(events.length, 0, 'no row')
  assertEquals(needsRefresh, false, 'and no work')
})

// ── The cap ─────────────────────────────────────────────────────────────────

console.log('\napplyLiveView — the live path holds the same 20-row cap as the poll')

test('a full feed stays at the cap when a newer row arrives', () => {
  const full = Array.from({ length: ACTIVITY_FEED_CAP }, (_, i) =>
    feedRow({
      id: `row-${i}`,
      // Descending, all on a different day and version from the incoming row so
      // nothing merges.
      proof_version_id: `v-${i}`,
      created_at: `2026-07-${String(20 - i).padStart(2, '0')}T12:00:00.000Z`,
    }),
  )
  const { events } = applyLiveView(full, view(), [project()])
  assertEquals(events.length, ACTIVITY_FEED_CAP, 'the card never grows past what a poll would show')
  assertEquals(events[0].id, 'view-new', 'and the new row is at the top')
})

test('a row that sorts off the end of a full feed leaves the array alone', () => {
  const full = Array.from({ length: ACTIVITY_FEED_CAP }, (_, i) =>
    feedRow({
      id: `row-${i}`,
      proof_version_id: `v-${i}`,
      created_at: `2026-08-${String(20 - i).padStart(2, '0')}T12:00:00.000Z`,
    }),
  )
  const { events } = applyLiveView(full, view({ viewed_at: '2026-01-01T00:00:00.000Z' }), [project()])
  assert(events === full, 'nothing on screen changed, so React must not be handed a new array')
})

// ── Synthetic rows ──────────────────────────────────────────────────────────

console.log('\napplyLiveView — synthetic rows are left strictly alone')

test('a pay-link or reply row is never mistaken for a view row', () => {
  // Synthetic rows carry no proof_version_id. If the lookup matched on
  // undefined it would overwrite an email reply with a page view.
  const before = [
    { ...feedRow({ id: 'hs-customer-x', event_type: 'customer_reply' }), proof_version_id: undefined },
  ]
  const { events } = applyLiveView(before, view(), [project()])
  assertEquals(events.length, 2, 'the reply row survives and the view is added beside it')
  assertEquals(events.filter((e) => e.event_type === 'customer_reply').length, 1, 'the reply is untouched')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
