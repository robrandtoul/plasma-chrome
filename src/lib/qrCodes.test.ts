// Unit tests for qrCodes.ts
// Run with: npx tsx src/lib/qrCodes.test.ts
//
// Covers the pure-string side of the QR utility: classifier,
// vCard parser, wifi parser, MeCard parser, shortened-URL check.
// decodeQrFromFile() needs the browser DOM (canvas, Image) so
// it's not unit-tested here; it's covered by the customer-page
// integration once that ships.

// Note: explicit .ts extension here so the test can run under
// `node --experimental-strip-types` as well as `npx tsx`. Vite's
// production build resolves the extension-less form anyway, so
// neither path is affected.
import {
  classifyQrData,
  parseVCard,
  parseWifi,
  parseMecard,
  isShortenedUrl,
} from './qrCodes.ts'

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

// ── classifyQrData ───────────────────────────────────────────────────

console.log('classifyQrData')
test('vCard 3.0 with leading whitespace', () => {
  assertEqual(classifyQrData('  BEGIN:VCARD\nVERSION:3.0\nEND:VCARD'), 'vcard')
})
test('MeCard', () => {
  assertEqual(classifyQrData('MECARD:N:Doe,John;TEL:+447700900123;;'), 'mecard')
})
test('Wifi config', () => {
  assertEqual(classifyQrData('WIFI:S:Plasma;T:WPA;P:secret;;'), 'wifi')
})
test('Mailto URL', () => {
  assertEqual(classifyQrData('mailto:rob@plasmadesign.co.uk'), 'email')
})
test('Tel URL', () => {
  assertEqual(classifyQrData('tel:+447700900123'), 'phone')
})
test('SMS URL', () => {
  assertEqual(classifyQrData('smsto:+447700900123:hello'), 'sms')
})
test('HTTPS URL', () => {
  assertEqual(classifyQrData('https://plasmadesign.co.uk/cards'), 'url')
})
test('HTTP URL (case-insensitive)', () => {
  assertEqual(classifyQrData('HTTP://example.com'), 'url')
})
test('Plain text fallback', () => {
  assertEqual(classifyQrData('Just some plain text'), 'text')
})

// ── parseVCard ───────────────────────────────────────────────────────

console.log('\nparseVCard')

test('Standard 3.0 vCard with FN, N, ORG, TITLE, TEL, EMAIL, URL, ADR, NOTE', () => {
  const raw = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    'FN:Sarah Jenkins',
    'N:Jenkins;Sarah;;;',
    'ORG:Plasma Design',
    'TITLE:Designer',
    'TEL;TYPE=CELL,VOICE:+447700900123',
    'TEL;TYPE=WORK:02071234567',
    'EMAIL;TYPE=WORK:sarah@plasmadesign.co.uk',
    'URL:https://plasmadesign.co.uk',
    'ADR:;;1 The High Street;London;;SW1A 1AA;UK',
    'NOTE:Verified by Rob',
    'END:VCARD',
  ].join('\n')

  const v = parseVCard(raw)
  assertEqual(v.formattedName, 'Sarah Jenkins')
  assertEqual(v.org, 'Plasma Design')
  assertEqual(v.title, 'Designer')
  assertEqual(v.tels.length, 2)
  assertEqual(v.tels[0].value, '+447700900123')
  assertDeepEqual(v.tels[0].types, ['CELL', 'VOICE'])
  assertEqual(v.tels[1].value, '02071234567')
  assertEqual(v.emails.length, 1)
  assertEqual(v.emails[0].value, 'sarah@plasmadesign.co.uk')
  assertDeepEqual(v.emails[0].types, ['WORK'])
  assertEqual(v.urls.length, 1)
  assertEqual(v.urls[0], 'https://plasmadesign.co.uk')
  assertEqual(v.addresses.length, 1)
  assertEqual(v.addresses[0], '1 The High Street, London, SW1A 1AA, UK')
  assertEqual(v.note, 'Verified by Rob')
})

test('vCard 2.1 short-form parameters (TEL;CELL:...)', () => {
  const raw = [
    'BEGIN:VCARD',
    'VERSION:2.1',
    'FN:Test',
    'TEL;CELL:+44123',
    'END:VCARD',
  ].join('\n')

  const v = parseVCard(raw)
  assertEqual(v.tels.length, 1)
  assertDeepEqual(v.tels[0].types, ['CELL'])
})

test('PHOTO field stripped from formatted view and raw lines', () => {
  const raw = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    'FN:Rob',
    'PHOTO;ENCODING=BASE64;TYPE=JPEG:/9j/AAQSkZ...',
    'END:VCARD',
  ].join('\n')

  const v = parseVCard(raw)
  assertEqual(v.formattedName, 'Rob')
  assertEqual(
    v.rawOtherLines.length,
    0,
    'PHOTO must not survive into rawOtherLines either',
  )
})

test('FN falls back to N when missing', () => {
  const raw = ['BEGIN:VCARD', 'VERSION:3.0', 'N:Doe;John;;Mr;', 'END:VCARD'].join('\n')
  const v = parseVCard(raw)
  assertEqual(v.formattedName, 'Mr John Doe')
})

test('Folded continuation line is unfolded', () => {
  // RFC 6350 §3.2: fold is CRLF + one whitespace. Unfolding
  // consumes the newline and that single whitespace; any further
  // whitespace at the start of the continuation is content.
  // Here the encoder folded with a single space marker, so the
  // continuation joins cleanly.
  const raw = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    'FN:Long Name That Wraps',
    'NOTE:This is a really long note that the encoder folded ',
    ' across multiple physical lines per RFC 6350.',
    'END:VCARD',
  ].join('\n')
  const v = parseVCard(raw)
  assertEqual(
    v.note,
    'This is a really long note that the encoder folded across multiple physical lines per RFC 6350.',
  )
})

test('Backslash-escaped commas and newlines in value', () => {
  const raw = ['BEGIN:VCARD', 'VERSION:4.0', 'FN:Rob', 'NOTE:Line one\\nLine two\\, with comma', 'END:VCARD'].join('\n')
  const v = parseVCard(raw)
  assertEqual(v.note, 'Line one\nLine two, with comma')
})

// ── parseWifi ────────────────────────────────────────────────────────

console.log('\nparseWifi')

test('WPA wifi with all fields', () => {
  const w = parseWifi('WIFI:S:Plasma;T:WPA;P:secret123;H:false;;')
  assertEqual(w.ssid, 'Plasma')
  assertEqual(w.security, 'WPA')
  assertEqual(w.password, 'secret123')
  assertEqual(w.hidden, false)
})

test('Hidden network with H:true', () => {
  const w = parseWifi('WIFI:S:Hidden;T:WPA;P:p;H:true;')
  assertEqual(w.hidden, true)
})

test('Open network (nopass)', () => {
  const w = parseWifi('WIFI:S:Guest;T:nopass;;')
  assertEqual(w.security, 'nopass')
  assertEqual(w.password, null)
})

test('Escaped semicolon and colon in password', () => {
  const w = parseWifi('WIFI:S:Plasma;T:WPA;P:weird\\;pwd\\:here;;')
  assertEqual(w.password, 'weird;pwd:here')
})

// ── parseMecard ──────────────────────────────────────────────────────

console.log('\nparseMecard')

test('Standard MeCard', () => {
  const m = parseMecard('MECARD:N:Doe,John;TEL:+447700900123;EMAIL:j@d.com;URL:https://x.test;;')
  assertEqual(m.name, 'John Doe')
  assertEqual(m.tel, '+447700900123')
  assertEqual(m.email, 'j@d.com')
  assertEqual(m.url, 'https://x.test')
})

test('MeCard without comma in name', () => {
  const m = parseMecard('MECARD:N:Rob Randtoul;TEL:+44;;')
  assertEqual(m.name, 'Rob Randtoul')
})

// ── isShortenedUrl ───────────────────────────────────────────────────

console.log('\nisShortenedUrl')

test('bit.ly is shortened', () => {
  if (!isShortenedUrl('https://bit.ly/abc123')) throw new Error('expected true')
})
test('Custom domain is not shortened', () => {
  if (isShortenedUrl('https://plasmadesign.co.uk/x')) throw new Error('expected false')
})
test('Mixed-case host', () => {
  if (!isShortenedUrl('https://T.CO/x')) throw new Error('expected true')
})
test('Not a URL returns false', () => {
  if (isShortenedUrl('hello world')) throw new Error('expected false')
})

// ── Summary ──────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
