// Unit tests for adminSearch.ts
// Run with: npx tsx src/lib/adminSearch.test.ts
//
// The point of the feature is "you don't need the exact name", so the cases
// here are deliberately imperfect queries — partial words, subsequences, typos,
// and plain-English synonyms — each asserting which destination should top the
// results. Also guards the AND-semantics (every query word must match) and the
// derived sidebar nav.

import {
  ADMIN_DESTINATIONS,
  ADMIN_NAV_GROUPS,
  ADMIN_SIDEBAR_GROUPS,
  searchAdminDestinations,
} from './adminSearch'

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

function assertEqual<T>(actual: T, expected: T, message?: string) {
  if (actual !== expected) {
    throw new Error(message ?? `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

function assert(cond: boolean, message: string) {
  if (!cond) throw new Error(message)
}

/** Top-ranked destination id for a query (or null when nothing matches). */
function topId(query: string): string | null {
  return searchAdminDestinations(query)[0]?.destination.id ?? null
}

// ── Exact / partial names ────────────────────────────────────────────────────

test('exact and prefix names resolve to their page', () => {
  assertEqual(topId('analytics'), 'analytics')
  assertEqual(topId('customers'), 'customers')
  assertEqual(topId('cust'), 'customers')          // partial word
  assertEqual(topId('material'), 'materials')       // singular of plural label
  assertEqual(topId('users'), 'users')
})

// ── Subsequence / abbreviation ───────────────────────────────────────────────

test('subsequence and squashed queries still find the page', () => {
  assertEqual(topId('leadt'), 'catalogue-lead-times')   // "lead t(imes)"
  assertEqual(topId('cardweights'), 'catalogue-card-weights')
  assertEqual(topId('custmers'), 'customers')           // dropped a letter
})

// ── Typo tolerance ───────────────────────────────────────────────────────────

test('typos within edit-distance tolerance resolve', () => {
  assertEqual(topId('analitics'), 'analytics')   // i for y
  assertEqual(topId('shiping'), 'shipping')      // missing p
  assertEqual(topId('pricng'), 'pricing')        // missing i
  assertEqual(topId('outsorcing'), 'outsourcing')
})

// ── Plain-English synonyms (the "don't know the exact name" case) ─────────────

test('synonyms find the feature without its real name', () => {
  assertEqual(topId('email templates'), 'content-messages')
  assertEqual(topId('reminders'), 'follow-ups')
  assertEqual(topId('audit log'), 'activity')
  assertEqual(topId('turnaround'), 'catalogue-lead-times')
  assertEqual(topId('suppliers'), 'outsourcing')
  assertEqual(topId('companies'), 'customers')
})

// ── Settings deep-links (hash paths) ─────────────────────────────────────────

test('settings sub-features deep-link into their section', () => {
  assertEqual(topId('stripe'), 'settings-ordering-checkout')
  assertEqual(searchAdminDestinations('stripe')[0].destination.path, '/admin/settings#ordering-checkout')
  assertEqual(topId('push notifications'), 'settings-push')
  assertEqual(topId('help scout'), 'settings-help-scout')
  assertEqual(topId('us tariff'), 'settings-us-tariff')
  assertEqual(topId('hot leads panel'), 'settings-hot-leads')
})

// ── AND semantics + no-match ─────────────────────────────────────────────────

test('every query word must match somewhere (AND semantics)', () => {
  // "order tracking" must not fall through to a page that only knows "order".
  assertEqual(topId('order tracking'), 'settings-order-tracking')
  const r = searchAdminDestinations('order tracking')
  assert(r.every((x) => x.destination.id !== 'orders'), 'Order log should not match "order tracking"')
})

test('gibberish returns no results', () => {
  assertEqual(searchAdminDestinations('zxqwph').length, 0)
  assertEqual(topId('qqqqqq'), null)
})

// ── Blank query = browsable directory ────────────────────────────────────────

test('blank query returns the whole registry in order', () => {
  const all = searchAdminDestinations('')
  assertEqual(all.length, ADMIN_DESTINATIONS.length)
  assertEqual(all[0].destination.id, ADMIN_DESTINATIONS[0].id)
  assertEqual(all.every((r) => r.score === 0), true)
})

// ── Derived sidebar nav ──────────────────────────────────────────────────────

test('sidebar nav is derived from the registry', () => {
  // Group order + labels match the pre-refactor sidebar exactly.
  assertEqual(
    ADMIN_NAV_GROUPS.map((g) => g.label).join(' | '),
    'Performance | Customers & orders | Messaging & automation | Catalogue | System',
  )
  // Every sidebar tab comes from a sidebar:true destination, and nothing else.
  const navPaths = ADMIN_NAV_GROUPS.flatMap((g) => g.tabs.map((t) => t.to)).sort()
  const flagged = ADMIN_DESTINATIONS.filter((d) => d.sidebar).map((d) => d.path).sort()
  assertEqual(navPaths.join(','), flagged.join(','))
  assertEqual(navPaths.length, 14)
})

test('sidebar groups carry the full destinations (for the home hub cards)', () => {
  // Same shape/order as the nav groups, but the full objects so the Admin
  // home page can render each card's description.
  assertEqual(
    ADMIN_SIDEBAR_GROUPS.map((g) => g.label).join(','),
    ADMIN_NAV_GROUPS.map((g) => g.label).join(','),
  )
  const items = ADMIN_SIDEBAR_GROUPS.flatMap((g) => g.items)
  assertEqual(items.length, 14)
  assertEqual(items.every((d) => d.sidebar === true && !!d.description), true)
})

test('every destination has a unique id and a path', () => {
  const seen = new Set<string>()
  for (const d of ADMIN_DESTINATIONS) {
    assert(!seen.has(d.id), `duplicate id ${d.id}`)
    seen.add(d.id)
    assert(d.path.startsWith('/admin'), `${d.id} path should be under /admin`)
  }
})

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
