// Unit tests for qrRecipients.ts
// Run with: npx tsx src/lib/qrRecipients.test.ts
//
// The rule that stops a personal QR code being printed on everybody's
// card. Two directions matter and they pull against each other: too
// permissive and the TKO shape ships again; too strict and a designer
// is blocked out of a legitimate shared code, or — worse — blocked by
// a requirement whose control isn't on screen. The deadlock cases
// (roster shrinking below two names) are as load-bearing as the
// headline one.

import {
  allSharedQrWarning,
  needsRecipientChoice,
  recipientChoiceApplies,
  unchosenQrEntries,
  type QrRecipientEntry,
} from './qrRecipients.ts'

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

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message)
}

const THREE = ['Guy Forster', 'Harry Forster', 'Jake Morris']

function qr(over: Partial<QrRecipientEntry> = {}): QrRecipientEntry {
  return {
    associatedName: null,
    decodedData: `https://example.test/${Math.random()}`,
    ...over,
  }
}

console.log('\nrecipientChoiceApplies')

test('needs a choice with two or more recipients', () => {
  assert(recipientChoiceApplies(THREE), 'three names should ask')
  assert(recipientChoiceApplies(['A', 'B']), 'two names should ask')
})

test('does not apply to one recipient or none', () => {
  assert(!recipientChoiceApplies(['Solo']), 'one name should not ask')
  assert(!recipientChoiceApplies([]), 'no names should not ask')
})

test('ignores blank roster entries', () => {
  // The forms pass raw name inputs; a half-typed second recipient is
  // an empty string, and it must not switch the picker on.
  assert(!recipientChoiceApplies(['Solo', '   ']), 'blank name should not count')
})

console.log('\nneedsRecipientChoice — the blocker')

test('blocks while a fresh QR has no owner', () => {
  const entries = [qr({ recipientChosen: false })]
  assert(needsRecipientChoice(entries, THREE), 'unchosen entry should block')
  assert(unchosenQrEntries(entries, THREE).length === 1, 'should report the entry')
})

test('clears once every fresh QR has been assigned', () => {
  const entries = [
    qr({ recipientChosen: true, associatedName: 'Guy Forster' }),
    qr({ recipientChosen: true, associatedName: 'Harry Forster' }),
  ]
  assert(!needsRecipientChoice(entries, THREE), 'assigned entries should not block')
})

test('picking "shared" deliberately is a valid answer', () => {
  // The point of the rule is that shared is chosen, not inherited.
  const entries = [qr({ recipientChosen: true, associatedName: null })]
  assert(!needsRecipientChoice(entries, THREE), 'deliberate shared should not block')
})

test('carried-forward entries are never blocked on', () => {
  // recipientChosen undefined = "not asked". Demanding an answer for
  // every carried QR would put a decision in front of the designer on
  // every single new version, for rows that were settled once already.
  const entries = [qr(), qr({ associatedName: 'Guy Forster' })]
  assert(!needsRecipientChoice(entries, THREE), 'undefined should read as chosen')
})

test('a dropped QR does not block the save', () => {
  // keep === false means the entry is being left behind on v(N-1);
  // blocking on artwork that isn't being saved would be unfixable
  // without un-dropping it.
  const entries = [qr({ recipientChosen: false, keep: false })]
  assert(!needsRecipientChoice(entries, THREE), 'dropped entry should not block')
})

test('the requirement evaporates when the roster drops below two', () => {
  // The deadlock case. The picker only renders with 2+ recipients, so
  // an outstanding choice on a version cut back to one name would
  // block Save with no control on screen to satisfy it.
  const entries = [qr({ recipientChosen: false })]
  assert(needsRecipientChoice(entries, THREE), 'blocks with three names')
  assert(!needsRecipientChoice(entries, ['Guy Forster']), 'clears at one name')
  assert(!needsRecipientChoice(entries, []), 'clears at no names')
})

console.log('\nallSharedQrWarning — the nudge')

test('fires on the TKO shape', () => {
  const entries = [
    qr({ decodedData: 'https://www.linkedin.com/in/guy-forster-7382/' }),
    qr({ decodedData: 'https://www.linkedin.com/in/harry-forster-2b9606235/' }),
    qr({ decodedData: 'https://www.linkedin.com/in/jacobmorrisuk/' }),
  ]
  const msg = allSharedQrWarning(entries, THREE)
  assert(msg !== null, 'three shared distinct codes on three names should warn')
  assert(msg!.includes('3 QR codes'), `message should name the count: ${msg}`)
})

test('stays quiet on one shared code across a team', () => {
  // The ordinary case: one company website on everybody's card.
  const entries = [qr({ decodedData: 'https://plasmadesign.co.uk' })]
  assert(allSharedQrWarning(entries, THREE) === null, 'single shared code should be silent')
})

test('stays quiet once any code is assigned', () => {
  const entries = [
    qr({ associatedName: 'Guy Forster' }),
    qr(),
    qr(),
  ]
  assert(allSharedQrWarning(entries, THREE) === null, 'partial assignment should be silent')
})

test('stays quiet when the same code was uploaded once per person', () => {
  // A real mistake, but a different one — the copy would misdescribe
  // it, and the fix is to delete two rows rather than assign three.
  const same = 'https://plasmadesign.co.uk'
  const entries = [
    qr({ decodedData: same }),
    qr({ decodedData: same }),
    qr({ decodedData: same }),
  ]
  assert(allSharedQrWarning(entries, THREE) === null, 'duplicate payloads should be silent')
})

test('stays quiet when the counts do not line up', () => {
  const entries = [qr(), qr()]
  assert(allSharedQrWarning(entries, THREE) === null, 'two codes, three names: silent')
  assert(
    allSharedQrWarning([qr(), qr(), qr(), qr()], THREE) === null,
    'four codes, three names: silent',
  )
})

test('counts only the codes actually being saved', () => {
  // Dropping one of four carried codes leaves three — which is the
  // shape worth warning about, and the shape a naive count misses.
  const entries = [qr(), qr(), qr(), qr({ keep: false })]
  assert(allSharedQrWarning(entries, THREE) !== null, 'kept codes should line up')
})

test('never fires on a single-recipient version', () => {
  assert(allSharedQrWarning([qr()], ['Solo']) === null, 'one name should be silent')
  assert(allSharedQrWarning([qr()], []) === null, 'no names should be silent')
})

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
