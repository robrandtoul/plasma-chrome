// Unit tests for customerThreadText.ts — the note posted on the customer's
// Help Scout thread.
// Run with: npx tsx supabase/functions/_shared/customerThreadText.test.ts
//
// This is the designer's copy of what the customer asked for. It is read in an
// inbox, away from the proof, so its shape carries real weight: the pins are
// the specific instructions and the note is the framing, which is why the pins
// are listed FIRST. Reversing that concatenation is a one-character change and
// would read as a wall of prose followed by an orphaned list.
//
// The pin cases came out of an end-to-end run of the feature; the approve and
// variant cases are here so a change to the pin block can't quietly reshape
// notes that have nothing to do with pins.

import {
  buildCustomerThreadText,
  SHARED_APPROVAL_KEY,
  type IncomingPin,
} from './customerThreadText.ts'

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

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg)
}

function assertEqual(actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`expected ${e}, got ${a}`)
}

const pin = (side: 'front' | 'back' | null, body: string): IncomingPin => ({
  imageId: null,
  side,
  x: 0.3,
  y: 0.4,
  body,
})

// Fixed arguments for the request_changes shape, so each test varies one thing.
function changeNote(pins: IncomingPin[], comment = 'Two small things.') {
  return buildCustomerThreadText(
    'request_changes',
    'Nolan Bushnell',
    'Nolan Bushnell',
    comment,
    ['front.jpg', 'back.svg'],
    'https://proofs.example/p/abc',
    null,
    null,
    null,
    false,
    pins,
  )
}

// ── The ordering rule ────────────────────────────────────────────────

test('pins are listed ABOVE the customer message', () => {
  const text = changeNote([pin('front', 'Logo sits too low'), pin('back', 'Bolder tagline')])
  const firstPin = text.indexOf('Logo sits too low')
  const message = text.indexOf('Two small things.')
  assert(firstPin > -1, 'pin body missing from the note')
  assert(message > -1, 'customer message missing from the note')
  assert(firstPin < message, 'pins must come before the message, not after it')
})

test('the header still names who asked, above everything else', () => {
  const text = changeNote([pin('front', 'Logo sits too low')])
  assert(
    text.indexOf('Changes requested by Nolan Bushnell') === 0,
    'the note must open by naming the person',
  )
})

// ── Numbering and side labels ────────────────────────────────────────

test('pins are numbered from 1, in the order given', () => {
  const text = changeNote([
    pin('front', 'First thing'),
    pin('back', 'Second thing'),
    pin('front', 'Third thing'),
  ])
  assert(text.includes('1. (front) First thing'), 'pin 1 wrong')
  assert(text.includes('2. (back) Second thing'), 'pin 2 wrong')
  assert(text.includes('3. (front) Third thing'), 'pin 3 wrong')
  // The order in the text is the order in the array — this is the numbering
  // the designer's checklist and dots are matched against.
  assertEqual(
    text.match(/^\d+\. /gm)?.map((s) => s.trim()),
    ['1.', '2.', '3.'],
  )
})

test('a pin with no side degrades to a plain numbered line', () => {
  const text = changeNote([pin(null, 'Somewhere on the card')])
  assert(text.includes('1. Somewhere on the card'), 'unsided pin should carry no face label')
  assert(!text.includes('1. () '), 'must not emit an empty bracket')
})

// ── The no-pins path must not change ─────────────────────────────────

test('with no pins the note is byte-identical to the pre-pins shape', () => {
  const withPins = changeNote([])
  const withoutPinsArg = buildCustomerThreadText(
    'request_changes',
    'Nolan Bushnell',
    'Nolan Bushnell',
    'Two small things.',
    ['front.jpg', 'back.svg'],
    'https://proofs.example/p/abc',
    null,
    null,
    null,
    false,
  )
  assertEqual(withPins, withoutPinsArg)
  // And nothing that looks like a pin list leaked in.
  assert(!/^\d+\. /m.test(withPins), 'a note with no pins must have no numbered list')
})

test('approvals never carry a pin block even if pins are passed', () => {
  // The approve path does not offer pinning. Belt and braces: if a caller ever
  // passes pins on an approval, the confirmation wording must not change.
  const text = buildCustomerThreadText(
    'approve',
    'Nolan Bushnell',
    'Nolan Bushnell',
    null,
    ['front.jpg'],
    'https://proofs.example/p/abc',
    null,
    null,
    null,
    false,
    [pin('front', 'should not appear')],
  )
  assert(!text.includes('should not appear'), 'approval note must not render pins')
  assert(text.startsWith('Approved by Nolan Bushnell'), 'approval opening changed')
})

test('variant selections are unaffected by the pin argument', () => {
  const text = buildCustomerThreadText(
    'request_changes',
    'Nolan Bushnell',
    SHARED_APPROVAL_KEY,
    'This one please.',
    ['a.jpg'],
    'https://proofs.example/p/abc',
    null,
    null,
    'Direction B',
    false,
    [pin('front', 'should not appear')],
  )
  assert(text.startsWith('Nolan Bushnell chose: Direction B.'), 'variant opening changed')
  assert(!text.includes('should not appear'), 'variant note must not render pins')
})

// ── Recipient suffix behaviour around the pin block ──────────────────

test('the shared sentinel suppresses the "for <name>" suffix', () => {
  const text = buildCustomerThreadText(
    'request_changes',
    'Nolan Bushnell',
    SHARED_APPROVAL_KEY,
    'Please tweak.',
    ['a.jpg'],
    null,
    null,
    null,
    null,
    false,
    [pin('front', 'Move this')],
  )
  assert(text.startsWith('Changes requested by Nolan Bushnell.'), 'shared suffix leaked')
  assert(text.includes('1. (front) Move this'), 'pin block missing on the shared path')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
