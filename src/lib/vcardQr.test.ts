// Unit tests for vcardQr.ts
// Run with: npx tsx src/lib/vcardQr.test.ts
//
// Covers the slug parser plus the golden-fixture byte-identity
// check on the generated QR. The destination of a hosted-vCard QR
// is the URL it encodes, so the cross-app identity guarantee is
// "same URL in, same QR out". The fixture is what asserts that
// promise: if generation drifts from the committed SVG, the
// proof-vs-print QR will diverge in production too.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// Explicit .ts extension so the test runs under
// `node --experimental-strip-types` as well as `npx tsx`. Same
// pattern as qrCodes.test.ts.
import {
  VCARD_BASE_URL,
  generateVcardQrSvg,
  parseVcardSlugInput,
  vcardUrlForSlug,
} from './vcardQr.ts'

let passed = 0
let failed = 0

function test(name: string, fn: () => void | Promise<void>) {
  const result = (async () => {
    try {
      await fn()
      console.log(`  ✓ ${name}`)
      passed++
    } catch (err) {
      console.log(`  ✗ ${name}`)
      console.log(`    ${(err as Error).message}`)
      failed++
    }
  })()
  return result
}

function assertEqual<T>(actual: T, expected: T, message?: string) {
  if (actual !== expected) {
    throw new Error(
      message ?? `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    )
  }
}

const tests: Array<Promise<void> | void> = []

// ── parseVcardSlugInput ──────────────────────────────────────────────

console.log('parseVcardSlugInput')
tests.push(test('Bare slug passes through', () => {
  assertEqual(parseVcardSlugInput('7k2nq8x'), '7k2nq8x')
}))
tests.push(test('https URL is reduced to slug', () => {
  assertEqual(parseVcardSlugInput('https://qcrd.uk/7k2nq8x'), '7k2nq8x')
}))
tests.push(test('http URL is reduced to slug', () => {
  assertEqual(parseVcardSlugInput('http://qcrd.uk/abc123'), 'abc123')
}))
tests.push(test('Protocol-less host is reduced to slug', () => {
  assertEqual(parseVcardSlugInput('qcrd.uk/jane-smith'), 'jane-smith')
}))
tests.push(test('Trailing slash is tolerated', () => {
  assertEqual(parseVcardSlugInput('https://qcrd.uk/abcdef/'), 'abcdef')
}))
tests.push(test('Leading whitespace is trimmed', () => {
  assertEqual(parseVcardSlugInput('   abcdef  '), 'abcdef')
}))
tests.push(test('Mixed-case slug is lowercased', () => {
  assertEqual(parseVcardSlugInput('https://qcrd.uk/ABCDEF'), 'abcdef')
}))
tests.push(test('Query string is stripped', () => {
  assertEqual(parseVcardSlugInput('https://qcrd.uk/abcdef?utm=foo'), 'abcdef')
}))
tests.push(test('Fragment is stripped', () => {
  assertEqual(parseVcardSlugInput('https://qcrd.uk/abcdef#section'), 'abcdef')
}))
tests.push(test('Rejects extra path segment', () => {
  assertEqual(parseVcardSlugInput('https://qcrd.uk/abcdef/extra'), null)
}))
tests.push(test('Rejects too-short slug', () => {
  assertEqual(parseVcardSlugInput('abc'), null)
}))
tests.push(test('Rejects underscored slug', () => {
  assertEqual(parseVcardSlugInput('abc_def'), null)
}))
tests.push(test('Rejects empty input', () => {
  assertEqual(parseVcardSlugInput(''), null)
}))
tests.push(test('Rejects whitespace-only input', () => {
  assertEqual(parseVcardSlugInput('   '), null)
}))

// ── vcardUrlForSlug ──────────────────────────────────────────────────

console.log('\nvcardUrlForSlug')
tests.push(test('Concatenates base + slug', () => {
  assertEqual(vcardUrlForSlug('7k2nq8x'), 'https://qcrd.uk/7k2nq8x')
}))
tests.push(test('Base URL is the canonical host', () => {
  assertEqual(VCARD_BASE_URL, 'https://qcrd.uk')
}))

// ── generateVcardQrSvg — byte-identity golden fixture ────────────────
//
// The fixture is the SVG `qrcode@1.5.4` produces for
// https://qcrd.uk/7k2nq8x with the locked options. Asserting against
// it three ways:
//   1. byte-equal to the committed file
//   2. md5 matches fe395e7fcf5063a2d7f82b2c9a26faab (the value
//      called out in the build brief — independent reproducibility
//      anchor)
//   3. exact length 1161 bytes
// If any of these break, EITHER the qrcode dep has shifted or the
// options have drifted. Don't update the fixture without first
// checking what changed and whether the vCard app's QrPanel.tsx
// needs the matching change to keep print + proof byte-identical.

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const fixturePath = join(__dirname, '__fixtures__', 'vcard-qr-7k2nq8x.svg')
const fixtureBytes = readFileSync(fixturePath)

console.log('\ngenerateVcardQrSvg (golden fixture)')
tests.push(test('SVG bytes match committed fixture', async () => {
  const svg = await generateVcardQrSvg('7k2nq8x')
  const bytes = Buffer.from(svg, 'utf-8')
  if (!bytes.equals(fixtureBytes)) {
    throw new Error(
      `Generated SVG differs from fixture. Generated ${bytes.length} bytes, fixture ${fixtureBytes.length} bytes.`,
    )
  }
}))
tests.push(test('md5 matches build-brief anchor', async () => {
  const svg = await generateVcardQrSvg('7k2nq8x')
  const md5 = createHash('md5').update(svg).digest('hex')
  assertEqual(md5, 'fe395e7fcf5063a2d7f82b2c9a26faab')
}))
tests.push(test('Byte length is exactly 1161', async () => {
  const svg = await generateVcardQrSvg('7k2nq8x')
  assertEqual(Buffer.byteLength(svg, 'utf-8'), 1161)
}))

// ── Summary ──────────────────────────────────────────────────────────

await Promise.all(tests)
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
