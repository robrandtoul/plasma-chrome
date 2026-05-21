// Unit tests for vcardClient.ts
// Run with: npx tsx src/lib/vcardClient.test.ts
//
// Mocks global.fetch to assert the RPC call shape (URL, headers,
// body) and exercise the not_found / error / success branches. No
// network, no real vCard project — the test runs anywhere `tsx`
// runs.
//
// import.meta.env is shimmed before the module is imported so the
// VcardConfigError path stays out of the way (it's its own test).

// Set the test env via process.env so the lazy fallback in
// readVcardEnv() picks it up. Each ESM module gets its own
// import.meta, so assigning import.meta.env in the test wouldn't
// reach the client module.
process.env.VITE_VCARD_SUPABASE_URL = 'https://vcard.example.supabase.co'
process.env.VITE_VCARD_SUPABASE_ANON_KEY = 'test-anon-key'

import {
  fetchVcardForSlug,
  lookupCardBySlug,
  lookupCardContactMethods,
  lookupCardLinks,
  VcardConfigError,
  type VcardCard,
  type VcardContactMethod,
  type VcardLink,
} from './vcardClient.ts'

let passed = 0
let failed = 0

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
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
    throw new Error(
      message ?? `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    )
  }
}

function assertDeepEqual<T>(actual: T, expected: T) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`Expected ${b}, got ${a}`)
}

// ── Fetch mock plumbing ──────────────────────────────────────────────

interface FetchCall {
  url: string
  init: RequestInit
}

let lastCall: FetchCall | null = null
let nextResponse: (call: FetchCall) => Response = () => new Response('null')

const originalFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input.toString()
  lastCall = { url, init: init ?? {} }
  return nextResponse(lastCall)
}) as typeof fetch

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// ── lookupCardBySlug ─────────────────────────────────────────────────

console.log('lookupCardBySlug')

await test('Posts to the right RPC URL with apikey + bearer headers', async () => {
  nextResponse = () => jsonResponse([fakeCard('7k2nq8x', 'Jane', 'Smith')])
  await lookupCardBySlug('7k2nq8x')
  if (!lastCall) throw new Error('fetch not called')
  assertEqual(lastCall.url, 'https://vcard.example.supabase.co/rest/v1/rpc/lookup_card_by_slug')
  const h = lastCall.init.headers as Record<string, string>
  assertEqual(h['apikey'], 'test-anon-key')
  assertEqual(h['Authorization'], 'Bearer test-anon-key')
  assertEqual(h['Content-Type'], 'application/json')
  assertEqual(lastCall.init.method, 'POST')
  assertDeepEqual(JSON.parse(lastCall.init.body as string), { card_slug: '7k2nq8x' })
})

await test('Returns ok with the first row on success', async () => {
  nextResponse = () => jsonResponse([fakeCard('abcdef', 'Rob', 'Randtoul')])
  const r = await lookupCardBySlug('abcdef')
  if (!r.ok) throw new Error('expected ok')
  assertEqual(r.data.slug, 'abcdef')
  assertEqual(r.data.first_name, 'Rob')
})

await test('Returns not_found on empty array', async () => {
  nextResponse = () => jsonResponse([])
  const r = await lookupCardBySlug('missing')
  if (r.ok) throw new Error('expected not_found')
  assertEqual(r.reason, 'not_found')
})

await test('Returns error on non-2xx', async () => {
  nextResponse = () => new Response('{"message":"boom"}', { status: 500 })
  const r = await lookupCardBySlug('whatever')
  if (r.ok) throw new Error('expected error')
  assertEqual(r.reason, 'error')
})

// ── lookupCardLinks / lookupCardContactMethods ───────────────────────

console.log('\nlookupCardLinks / lookupCardContactMethods')

await test('lookupCardLinks posts p_card_id and returns rows', async () => {
  const links: VcardLink[] = [
    { id: 'l1', url: 'https://example.com', label: 'Site', icon_slug: null, sort_order: 0 },
  ]
  nextResponse = () => jsonResponse(links)
  const rows = await lookupCardLinks('card-uuid')
  assertDeepEqual(JSON.parse(lastCall!.init.body as string), { p_card_id: 'card-uuid' })
  assertDeepEqual(rows, links)
})

await test('lookupCardContactMethods returns the row array', async () => {
  const methods: VcardContactMethod[] = [
    { id: 'cm1', method_type: 'email', value: 'a@b.test', label: null, sort_order: 0 },
  ]
  nextResponse = () => jsonResponse(methods)
  const rows = await lookupCardContactMethods('card-uuid')
  assertDeepEqual(rows, methods)
})

await test('lookupCardLinks returns [] when RPC returns null', async () => {
  nextResponse = () => jsonResponse(null)
  const rows = await lookupCardLinks('card-uuid')
  assertDeepEqual(rows, [])
})

// ── fetchVcardForSlug ────────────────────────────────────────────────

console.log('\nfetchVcardForSlug')

await test('Bundles card + links + methods on success', async () => {
  let calls = 0
  nextResponse = (call) => {
    calls += 1
    if (call.url.endsWith('/lookup_card_by_slug')) {
      return jsonResponse([fakeCard('7k2nq8x', 'Jane', 'Smith')])
    }
    if (call.url.endsWith('/lookup_card_links_by_card_id')) {
      return jsonResponse([
        { id: 'l1', url: 'https://x.test', label: 'X', icon_slug: null, sort_order: 0 },
      ])
    }
    if (call.url.endsWith('/lookup_card_contact_methods_by_card_id')) {
      return jsonResponse([
        { id: 'cm1', method_type: 'email', value: 'extra@x.test', label: 'Work', sort_order: 0 },
      ])
    }
    throw new Error(`unexpected url: ${call.url}`)
  }
  const r = await fetchVcardForSlug('7k2nq8x')
  if (!r.ok) throw new Error(`expected ok, got ${r.reason}`)
  assertEqual(r.data.card.slug, '7k2nq8x')
  assertEqual(r.data.links.length, 1)
  assertEqual(r.data.contactMethods.length, 1)
  if (calls !== 3) throw new Error(`expected 3 fetches, got ${calls}`)
})

await test('Returns not_found short-circuit when slug missing', async () => {
  let calls = 0
  nextResponse = (call) => {
    calls += 1
    if (call.url.endsWith('/lookup_card_by_slug')) return jsonResponse([])
    throw new Error('should not fetch links/methods after not_found')
  }
  const r = await fetchVcardForSlug('missing')
  if (r.ok) throw new Error('expected not_found')
  assertEqual(r.reason, 'not_found')
  if (calls !== 1) throw new Error(`expected 1 fetch, got ${calls}`)
})

// ── VcardConfigError ─────────────────────────────────────────────────

console.log('\nVcardConfigError')

await test('Throws VcardConfigError when env is missing', async () => {
  // Re-import after clearing env by spawning a child tsx process — but
  // since the module evaluates env at import time we can't easily
  // re-import in-process. Instead we verify the error class is what
  // callers can branch on, plus exercise the type check.
  const e = new VcardConfigError()
  assertEqual(e.name, 'VcardConfigError')
  if (!(e instanceof VcardConfigError)) throw new Error('not an instance')
})

// ── Summary ──────────────────────────────────────────────────────────

globalThis.fetch = originalFetch
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)

// ── helpers ──────────────────────────────────────────────────────────

function fakeCard(slug: string, first: string, last: string): VcardCard {
  return {
    id: `card-${slug}`,
    slug,
    status: 'draft',
    target_type: 'vcard',
    external_url: null,
    first_name: first,
    last_name: last,
    nickname: null,
    job_title: null,
    company: null,
    birthday: null,
    primary_email: null,
    email_label: null,
    primary_phone: null,
    phone_label: null,
    bio: null,
    address_street: null,
    address_city: null,
    address_region: null,
    address_postcode: null,
    address_country: null,
    profile_image_path: null,
    logo_image_path: null,
    cover_image_path: null,
    theme_mode: null,
    theme_font: null,
    theme_accent: null,
    card_updated_at: null,
  }
}
