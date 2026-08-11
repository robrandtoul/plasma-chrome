// Unit tests for the QR destination helpers.
// Run with: npx tsx src/lib/qrDestination.test.ts
//
// Imports BOTH twins — this src/ copy and the Deno copy the artwork
// check loads — and runs every case through each, so drift between the
// two files fails the suite rather than silently splitting what the
// customer is shown from what the check is told. Also asserts the two
// files are byte-identical, since they have no imports and therefore
// no legitimate reason to differ.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import * as web from './qrDestination.ts'
import * as deno from '../../supabase/functions/_shared/qrDestination.ts'

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

// Assert both twins give the same answer AND that answer is the expected one.
function assertBoth<T>(fn: (m: typeof web) => T, expected: T) {
  assertEqual(fn(web), expected)
  assertEqual(fn(deno as unknown as typeof web), expected)
}

// The live destination behind qcrd.uk/dgceFH7 (Skywalker Septic, the job
// that prompted this feature), with the long opaque token VALUES abridged
// so the file stays readable. Every parameter NAME is the real one, and
// the meaningful part — the search term — is verbatim. The real thing is
// 1,009 characters.
const SKYWALKER_DESTINATION =
  'https://www.google.com/search?sca_esv=31d0bfb7a33f7a8b&biw=384&bih=693' +
  '&sxsrf=APpeQnvWuG-OjUZStUELXXk1nudR_HOXxg%3A1786157850107' +
  '&q=skywalkersepticllc+com+reviews' +
  '&uds=AJ5uw1-KIEBMDzKttSTPo005nyq2YFY' +
  '&si=APenkKm7iecQ4G6P-TsbSMFKIQtv3EFIqRAFw' +
  '&sa=X&ved=2ahUKEwjWhqzBhJCWAxUFSjABHYuWNzsQk8gLegQIGxAB' +
  '&ictx=1&stq=1&cs=1&lei=Gpt2ataRBoWUwbkPi63e2QM#ebo=1'

console.log('parseShortLink')

test('recognises a Plasma qcrd.uk short link and extracts the slug', () => {
  assertBoth((m) => m.parseShortLink('https://qcrd.uk/dgceFH7'), {
    kind: 'plasma',
    host: 'qcrd.uk',
    slug: 'dgceFH7',
    url: 'https://qcrd.uk/dgceFH7',
  })
})

test('slug case is preserved — the lookup matches case-sensitively', () => {
  // dgceFH7 arriving as dgcefh7 would resolve to nothing.
  assertBoth((m) => m.parseShortLink('https://qcrd.uk/dgceFH7')?.slug, 'dgceFH7')
  assertBoth((m) => m.parseShortLink('https://qcrd.uk/CxDBe7h')?.slug, 'CxDBe7h')
})

test('tolerates www. and http, and a trailing slash', () => {
  assertBoth((m) => m.parseShortLink('http://www.qcrd.uk/dgceFH7/')?.slug, 'dgceFH7')
})

test('recognises third-party shorteners, which have no slug space of ours', () => {
  assertBoth((m) => m.parseShortLink('https://bit.ly/abc123')?.kind, 'third_party')
  assertBoth((m) => m.parseShortLink('https://t.co/xyz')?.kind, 'third_party')
})

test('an ordinary URL is not a short link', () => {
  assertBoth((m) => m.parseShortLink(SKYWALKER_DESTINATION), null)
  assertBoth((m) => m.parseShortLink('https://plasmadesign.co.uk/anything'), null)
})

test('a vCard payload, junk, and empty input are all not short links', () => {
  assertBoth((m) => m.parseShortLink('BEGIN:VCARD\nFN:Jane\nEND:VCARD'), null)
  assertBoth((m) => m.parseShortLink('hello world'), null)
  assertBoth((m) => m.parseShortLink(''), null)
})

test('non-http schemes are refused outright, never resolved or shown', () => {
  // A QR can encode anything. `javascript:` is not a destination.
  assertBoth((m) => m.parseShortLink('javascript:alert(1)'), null)
  assertBoth((m) => m.parseShortLink('data:text/html,<script>'), null)
  assertBoth((m) => m.parseShortLink('file:///etc/passwd'), null)
})

test('a host with no plausible slug yields kind but no slug, so nothing is guessed', () => {
  // Bare host, nested path, and a .vcf suffix (the vCard app serves those
  // on the same host) must not be mistaken for a slug to look up.
  assertBoth((m) => m.parseShortLink('https://qcrd.uk/')?.slug, null)
  assertBoth((m) => m.parseShortLink('https://qcrd.uk/a/b')?.slug, null)
  assertBoth((m) => m.parseShortLink('https://qcrd.uk/dgceFH7.vcf')?.slug, null)
  assertBoth((m) => m.parseShortLink('https://qcrd.uk/ab')?.slug, null) // under 3 chars
})

test('a host with no slug is still reported as a short link', () => {
  assertBoth((m) => m.parseShortLink('https://qcrd.uk/a/b')?.kind, 'plasma')
  assertBoth((m) => m.isShortLink('https://qcrd.uk/a/b'), true)
})

console.log('\nisVolatileParam')

test('campaign and click-id parameters are noise', () => {
  assertBoth((m) => m.isVolatileParam('utm_source'), true)
  assertBoth((m) => m.isVolatileParam('utm_anything_new'), true)
  assertBoth((m) => m.isVolatileParam('gclid'), true)
  assertBoth((m) => m.isVolatileParam('fbclid'), true)
})

test('search-session tokens are noise', () => {
  for (const p of ['ved', 'lei', 'sxsrf', 'sca_esv', 'biw', 'bih', 'ictx']) {
    assertBoth((m) => m.isVolatileParam(p), true)
  }
})

test('case is ignored', () => {
  assertBoth((m) => m.isVolatileParam('UTM_Source'), true)
  assertBoth((m) => m.isVolatileParam('VED'), true)
})

test('anything that might carry meaning is left in', () => {
  // Under-dropping is the safe direction: a difference a human can see
  // beats a difference silently hidden. These are deliberately absent.
  for (const p of ['q', 'id', 'hl', 'ref', 'source', 'placeid', 'lrd']) {
    assertBoth((m) => m.isVolatileParam(p), false)
  }
})

console.log('\nsummariseDestination')

test('reduces the 1,009-character live destination to its meaningful part', () => {
  assertBoth(
    (m) => m.summariseDestination(SKYWALKER_DESTINATION).label,
    'google.com/search#ebo=1 — q=skywalkersepticllc com reviews',
  )
})

test('counts the tracking parameters it left out rather than hiding them', () => {
  assertBoth((m) => m.summariseDestination(SKYWALKER_DESTINATION).droppedVolatile, 12)
})

test('always keeps the full URL verbatim — the label is never the fact', () => {
  assertBoth((m) => m.summariseDestination(SKYWALKER_DESTINATION).full, SKYWALKER_DESTINATION)
})

test('strips www and a trailing slash from the host and path', () => {
  assertBoth((m) => m.summariseDestination('https://www.plasmadesign.co.uk/').label, 'plasmadesign.co.uk')
  assertBoth((m) => m.summariseDestination('https://plasmadesign.co.uk/cards/').label, 'plasmadesign.co.uk/cards')
})

test('decodes a + as a space so a search term reads as the customer typed it', () => {
  assertBoth(
    (m) => m.summariseDestination('https://example.com/s?q=septic+tank+reviews').label,
    'example.com/s — q=septic tank reviews',
  )
})

test('caps the number of parameters shown so a long URL cannot flood the label', () => {
  const many = 'https://example.com/p?a=1&b=2&c=3&d=4&e=5'
  assertBoth((m) => m.summariseDestination(many).label, 'example.com/p — a=1, b=2, c=3')
  assertBoth((m) => m.summariseDestination(many).droppedVolatile, 0)
})

test('an unparseable payload comes back as itself, not as an error', () => {
  // The job is to display what was found, not to validate the customer's link.
  assertBoth((m) => m.summariseDestination('not a url').label, 'not a url')
  assertBoth((m) => m.summariseDestination('not a url').host, null)
})

test('a real LinkedIn share URL loses its share tracking', () => {
  const linkedin =
    'https://www.linkedin.com/in/lukeryan?utm_source=share_via&utm_content=profile&utm_medium=member_ios'
  assertBoth((m) => m.summariseDestination(linkedin).label, 'linkedin.com/in/lukeryan')
  assertBoth((m) => m.summariseDestination(linkedin).droppedVolatile, 3)
})

console.log('\ndescribeDestination')

test('states the noise count so the label never reads as the whole story', () => {
  assertBoth(
    (m) => m.describeDestination(m.summariseDestination(SKYWALKER_DESTINATION)),
    'google.com/search#ebo=1 — q=skywalkersepticllc com reviews (plus 12 tracking parameters)',
  )
})

test('says nothing about tracking when there is none, and singularises one', () => {
  assertBoth(
    (m) => m.describeDestination(m.summariseDestination('https://plasmadesign.co.uk/')),
    'plasmadesign.co.uk',
  )
  assertBoth(
    (m) => m.describeDestination(m.summariseDestination('https://example.com/x?gclid=1')),
    'example.com/x (plus 1 tracking parameter)',
  )
})

test('an empty destination is stated, not rendered as a blank', () => {
  assertBoth((m) => m.describeDestination(m.summariseDestination('')), 'no destination recorded')
})

console.log('\ntwin integrity')

test('the two copies are byte-identical', () => {
  const here = fileURLToPath(new URL('.', import.meta.url))
  const a = readFileSync(`${here}qrDestination.ts`, 'utf8')
  const b = readFileSync(`${here}../../supabase/functions/_shared/qrDestination.ts`, 'utf8')
  if (a !== b) {
    throw new Error(
      'src/lib/qrDestination.ts and supabase/functions/_shared/qrDestination.ts differ. ' +
        'They have no imports, so there is no legitimate reason for them to. Copy one over the other.',
    )
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
