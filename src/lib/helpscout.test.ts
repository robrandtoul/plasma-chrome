// Unit tests for helpscout.ts
// Run with: npx tsx src/lib/helpscout.test.ts
//
// The property under test is that every URL shape a designer can
// actually produce is accepted, and that whatever is accepted always
// resolves to the CONVERSATION ID — never the short conversation
// number that shares the address-bar URL with it.
//
// The regression this file exists for: pasting a URL copied straight
// from the Help Scout address bar (…/conversation/<id>/<number>) into
// the Change-conversation modal was rejected as invalid, which left a
// duplicated project with no way to be linked to its thread.

import { parseHelpscoutUrl } from './helpscout'

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

// The real conversation from the bug report: id 3396475852, number 430667.
const ID = '3396475852'
const NUMBER = '430667'
const CANONICAL = `https://secure.helpscout.net/conversation/${ID}`

function accepts(raw: string, expectedId = ID) {
  const parsed = parseHelpscoutUrl(raw)
  if (!parsed) throw new Error(`Expected ${JSON.stringify(raw)} to be accepted, got null`)
  assertEqual(parsed.id, expectedId, `id: expected ${expectedId}, got ${parsed.id}`)
  assertEqual(
    parsed.url,
    `https://secure.helpscout.net/conversation/${expectedId}`,
    `url should always canonicalise to the single-segment form, got ${parsed.url}`,
  )
}

function rejects(raw: string) {
  const parsed = parseHelpscoutUrl(raw)
  if (parsed) throw new Error(`Expected ${JSON.stringify(raw)} to be rejected, got ${JSON.stringify(parsed)}`)
}

// ── The canonical form our own edge functions emit ──────────────────────────

console.log('\nCanonical form (emitted by match/lookup-helpscout-conversation)')

test('single segment', () => accepts(CANONICAL))
test('single segment with trailing slash', () => accepts(`${CANONICAL}/`))
test('surrounding whitespace is trimmed', () => accepts(`  ${CANONICAL}  `))

// ── The address-bar form — the regression ───────────────────────────────────

console.log('\nAddress-bar form (what a designer actually copies)')

test('id + number, the exact URL from the bug report', () =>
  accepts(`https://secure.helpscout.net/conversation/${ID}/${NUMBER}`))

test('id + number with trailing slash', () =>
  accepts(`https://secure.helpscout.net/conversation/${ID}/${NUMBER}/`))

test('id + number with a #fragment (deep link to a thread)', () =>
  accepts(`https://secure.helpscout.net/conversation/${ID}/${NUMBER}/#c9876543210`))

test('id + number with a ?query (folder context)', () =>
  accepts(`https://secure.helpscout.net/conversation/${ID}/${NUMBER}?folderId=123456`))

test('single segment with a #fragment', () => accepts(`${CANONICAL}#c9876543210`))

// The whole point of capturing group 1: the short number sits in the same
// URL and must never be mistaken for the id. Every linked proof on live
// stores a 10-digit id, so storing 430667 here would silently break the
// Help Scout link, the reply sender and the tag sync.
test('the captured id is the FIRST segment, never the conversation number', () => {
  const parsed = parseHelpscoutUrl(`https://secure.helpscout.net/conversation/${ID}/${NUMBER}`)
  assertEqual(parsed?.id, ID)
  if (parsed?.id === NUMBER) throw new Error('captured the conversation number instead of the id')
  if (parsed?.url.includes(NUMBER)) throw new Error('canonical URL leaked the conversation number')
})

// ── Things that must still be rejected ──────────────────────────────────────

console.log('\nStill rejected')

test('empty string', () => rejects(''))
test('whitespace only', () => rejects('   '))
test('a bare number is not a URL (the modal has no lookup, so it cannot resolve one)', () =>
  rejects(NUMBER))
test('no conversation id at all', () => rejects('https://secure.helpscout.net/conversation/'))
test('non-numeric id', () => rejects('https://secure.helpscout.net/conversation/abc123'))
test('a third path segment is not a shape Help Scout produces', () =>
  rejects(`https://secure.helpscout.net/conversation/${ID}/${NUMBER}/999`))
test('non-numeric second segment', () =>
  rejects(`https://secure.helpscout.net/conversation/${ID}/threads`))
test('http, not https', () => rejects(`http://secure.helpscout.net/conversation/${ID}`))
test('wrong host', () => rejects(`https://helpscout.net/conversation/${ID}`))
test('lookalike host — the dot in secure.helpscout must be literal', () =>
  rejects(`https://secureXhelpscout.net/conversation/${ID}`))
test('attacker-controlled host with the real one as a prefix path', () =>
  rejects(`https://evil.example.com/secure.helpscout.net/conversation/${ID}`))
test('a different Help Scout page', () =>
  rejects(`https://secure.helpscout.net/mailbox/${ID}`))

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
