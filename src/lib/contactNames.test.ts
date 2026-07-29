// Unit tests for contactNames.ts
// Run with: npx tsx src/lib/contactNames.test.ts
//
// Every fixture is real: the 15 live contacts found on 2026-07-29 stored with
// only a first name, their actual email addresses, and the name Help Scout
// held for each at the time of the audit. The property under test is the same
// one matchMaterial.test.ts guards — conservative. A wrong suggestion that a
// designer accepts puts a fabricated surname on a customer record, so "no
// suggestion" must always beat "a plausible guess".

import {
  isFirstNameOnly,
  nameTokens,
  normaliseName,
  suggestNameFromEmail,
  fullerNameFrom,
  suggestContactName,
} from './contactNames'

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

// ── Detecting a first-name-only contact ─────────────────────────────────────

console.log('\nisFirstNameOnly')

test('flags a bare first name', () => {
  assertEqual(isFirstNameOnly('Sam'), true)
  assertEqual(isFirstNameOnly('Gamaliel'), true)
})

test('leaves a full name alone', () => {
  assertEqual(isFirstNameOnly('Karen Law'), false)
  assertEqual(isFirstNameOnly('Andrea Egidio Marazzi'), false)
})

test('a hyphenated forename is still surname-less', () => {
  assertEqual(isFirstNameOnly('Jean-Pierre'), true)
})

test('stray whitespace does not fake a surname', () => {
  assertEqual(isFirstNameOnly('  Sam  '), true)
  assertEqual(isFirstNameOnly('Sam '), true, 'non-breaking space from pasted HTML')
  assertEqual(isFirstNameOnly('Karen  Law'), false)
})

test('punctuation is not a name token', () => {
  assertEqual(isFirstNameOnly('Karen .'), true)
  assertEqual(isFirstNameOnly('Sam -'), true)
})

test('an empty name is not flagged (required-field validation owns that)', () => {
  assertEqual(isFirstNameOnly(''), false)
  assertEqual(isFirstNameOnly('   '), false)
})

test('normaliseName and nameTokens agree on odd whitespace', () => {
  assertEqual(normaliseName(' Karen  Law '), 'Karen Law')
  assertEqual(nameTokens('Karen Law').join('|'), 'Karen|Law')
})

// ── Recovering a surname from the email address ─────────────────────────────

console.log('\nsuggestNameFromEmail — the live cases it should solve')

test('separated local part: karen.law', () => {
  assertEqual(suggestNameFromEmail('Karen', 'karen.law@limiai.co'), 'Karen Law')
})

test('separated local part: kane_adams', () => {
  assertEqual(suggestNameFromEmail('Kane', 'kane_adams@ymail.com'), 'Kane Adams')
})

test('concatenated local part: arnelburkic', () => {
  assertEqual(suggestNameFromEmail('Arnel', 'arnelburkic@gmail.com'), 'Arnel Burkic')
})

test('concatenated with trailing digits: calebhozan16', () => {
  assertEqual(suggestNameFromEmail('Caleb', 'calebhozan16@gmail.com'), 'Caleb Hozan')
})

test('concatenated: andreaegidio', () => {
  assertEqual(suggestNameFromEmail('Andrea', 'andreaegidio@beyond-group.it'), 'Andrea Egidio')
})

test('surname-first separated local part still resolves', () => {
  assertEqual(suggestNameFromEmail('Karen', 'law.karen@example.com'), 'Karen Law')
})

test('titleCase is applied to the recovered surname', () => {
  assertEqual(suggestNameFromEmail('Ruth', 'ruth.mcdonald@example.com'), 'Ruth McDonald')
})

test('a hyphen separates fields only when nothing else does', () => {
  // Hyphen as the separator — no dot or underscore present.
  assertEqual(suggestNameFromEmail('Ana', 'ana-souza@example.com'), 'Ana Souza')
  // Hyphen inside the surname, dot doing the separating. Kept whole rather
  // than split into three ambiguous parts.
  assertEqual(suggestNameFromEmail('Mary', 'mary.smith-jones@example.com'), 'Mary Smith-Jones')
  // A lone hyphenated surname belongs to nobody we can name.
  assertEqual(suggestNameFromEmail('Mary', 'smith-jones@example.com'), null)
})

test('a short first name is fine when a separator proves the boundary', () => {
  assertEqual(suggestNameFromEmail('Jo', 'jo.smith@example.com'), 'Jo Smith')
})

console.log('\nsuggestNameFromEmail — the live cases it must stay quiet on')

test('local part is just the first name: celia, karan, robert, neeka', () => {
  assertEqual(suggestNameFromEmail('Celia', 'celia@venezia-alliance.asia'), null)
  assertEqual(suggestNameFromEmail('Karan', 'karan@servicewing.com'), null)
  assertEqual(suggestNameFromEmail('Robert', 'robert@physicalrehabservices.com'), null)
  assertEqual(suggestNameFromEmail('Neeka', 'neeka@dralexphoon.com'), null)
})

test('an initial is not a surname: ryxn.j123', () => {
  assertEqual(suggestNameFromEmail('Ryan', 'ryxn.j123@gmail.com'), null)
})

test('one letter left over is not a surname: sami69 for "Sam"', () => {
  assertEqual(suggestNameFromEmail('Sam', 'sami69@mac.com'), null)
})

test('local part unrelated to the first name: shamwi97, jtahrens1975', () => {
  assertEqual(suggestNameFromEmail('Saba', 'shamwi97@gmail.com'), null)
  assertEqual(suggestNameFromEmail('Jason', 'jtahrens1975@gmail.com'), null)
})

test('a shared mailbox donates nothing: post@luftperspektiv.no', () => {
  assertEqual(suggestNameFromEmail('Gamaliel', 'post@luftperspektiv.no'), null)
  assertEqual(suggestNameFromEmail('Post', 'post@luftperspektiv.no'), null, 'even if the name matches')
  assertEqual(suggestNameFromEmail('Info', 'info@example.com'), null)
})

test('a role word is not a surname wherever it sits in the address', () => {
  // Shape A is the shape trusted most, so a role word reaching it is the
  // worst case: "John Sales" reads like a real name.
  assertEqual(suggestNameFromEmail('John', 'john.sales@example.com'), null)
  assertEqual(suggestNameFromEmail('John', 'john_accounts@example.com'), null)
  assertEqual(suggestNameFromEmail('Ruth', 'support.ruth@example.com'), null)
  // Shape B too.
  assertEqual(suggestNameFromEmail('Ann', 'annorders@example.com'), null)
})

test('plus-addressing is a routing tag, not a surname', () => {
  assertEqual(suggestNameFromEmail('Karen', 'karen+cards@example.com'), null)
})

test('three or more parts are ambiguous', () => {
  assertEqual(suggestNameFromEmail('Mary', 'mary.jane.smith@example.com'), null)
})

test('nothing to suggest when the name already has a surname', () => {
  assertEqual(suggestNameFromEmail('Karen Law', 'karen.law@limiai.co'), null)
})

test('a malformed or empty email is handled', () => {
  assertEqual(suggestNameFromEmail('Karen', ''), null)
  assertEqual(suggestNameFromEmail('Karen', 'not-an-email'), null)
  assertEqual(suggestNameFromEmail('Karen', '@example.com'), null)
})

test('KNOWN FALSE POSITIVE 1: the address continues the forename', () => {
  // The customer is really Sialyse Ducaine (per their LinkedIn on the Help
  // Scout record). No string rule can tell this apart from arnelburkic →
  // Arnel Burkic. Asserted so the limit is visible and deliberate: the UI must
  // therefore always present shape B as a question, never apply it silently.
  // This is the dangerous class — the output reads as a plausible name.
  assertEqual(suggestNameFromEmail('Sia', 'sialyse@hotmail.com'), 'Sia Lyse')
})

test('KNOWN FALSE POSITIVE 2: the stored name is a diminutive', () => {
  // Same root cause, but these fail loudly — no designer clicks "Sam Antha".
  // Asserted so a future change that makes them fail QUIETLY (by producing
  // something name-shaped) is caught here rather than by a customer.
  assertEqual(suggestNameFromEmail('Sam', 'samantha@example.com'), 'Sam Antha')
  assertEqual(suggestNameFromEmail('Dan', 'danielsmith@example.com'), 'Dan Ielsmith')
})

// ── Taking a fuller name from Help Scout ────────────────────────────────────

console.log('\nfullerNameFrom')

test('the live Karen case: HS gained "Law" after the contact was created', () => {
  assertEqual(fullerNameFrom('Karen', 'Karen Law'), 'Karen Law')
})

test('company cruft is passed through verbatim for the designer to judge', () => {
  assertEqual(
    fullerNameFrom('Andrea', 'Andrea Egidio Marazzi - Beyond Group'),
    'Andrea Egidio Marazzi - Beyond Group',
  )
})

test('a different person cannot rename the contact', () => {
  assertEqual(fullerNameFrom('Karen', 'Susan Law'), null)
})

test('no improvement offered when the name is already full', () => {
  assertEqual(fullerNameFrom('Karen Law', 'Karen Law Smith'), null)
})

test('an equally bare incoming name is not an improvement', () => {
  assertEqual(fullerNameFrom('Karen', 'Karen'), null)
  assertEqual(fullerNameFrom('Karen', '  Karen '), null)
})

test('case differences alone do not count as an improvement', () => {
  assertEqual(fullerNameFrom('Karen', 'karen'), null)
})

test('matching is case-insensitive on the first token', () => {
  assertEqual(fullerNameFrom('arnel', 'Arnel Burkic'), 'Arnel Burkic')
})

// ── The combined proposal used by the UI ────────────────────────────────────

// This is the function ContactNameNudge actually calls, so these assertions
// cover the behaviour that reaches a customer record. Keep it that way — if the
// component ever re-derives this preference order inline again, everything
// below stops guarding the shipped path.

console.log('\nsuggestContactName')

test('Help Scout wins over the email guess when both are available', () => {
  const karen = suggestContactName('Karen', 'karen.law@limiai.co', 'Karen Law')
  assertEqual(karen?.name, 'Karen Law')
  assertEqual(karen?.source, 'helpscout', 'a recorded fact must beat a reading of an address')

  const andrea = suggestContactName('Andrea', 'andreaegidio@beyond-group.it', 'Andrea Egidio Marazzi')
  assertEqual(andrea?.name, 'Andrea Egidio Marazzi', 'HS is richer than the email guess "Andrea Egidio"')
  assertEqual(andrea?.source, 'helpscout')
})

test('falls back to the email when Help Scout has no surname either', () => {
  const arnel = suggestContactName('Arnel', 'arnelburkic@gmail.com', 'Arnel')
  assertEqual(arnel?.name, 'Arnel Burkic')
  assertEqual(arnel?.source, 'email', 'drives the "this can be wrong" caveat in the UI')

  const caleb = suggestContactName('Caleb', 'calebhozan16@gmail.com', null)
  assertEqual(caleb?.name, 'Caleb Hozan')
  assertEqual(caleb?.source, 'email')
})

test('silent when the contact already has a surname', () => {
  assertEqual(suggestContactName('Karen Law', 'karen.law@limiai.co', 'Karen Law'), null)
})

test('silent when nothing can improve the name — the 9 live cases with no answer', () => {
  // These still WARN in the UI (the designer may know the surname from the Help
  // Scout thread) — they just carry no suggestion to click.
  const hopeless: Array<[string, string]> = [
    ['Celia', 'celia@venezia-alliance.asia'],
    ['Karan', 'karan@servicewing.com'],
    ['Robert', 'robert@physicalrehabservices.com'],
    ['Neeka', 'neeka@dralexphoon.com'],
    ['Gamaliel', 'post@luftperspektiv.no'],
    ['Ryan', 'ryxn.j123@gmail.com'],
    ['Sam', 'sami69@mac.com'],
    ['Saba', 'shamwi97@gmail.com'],
    ['Jason', 'jtahrens1975@gmail.com'],
  ]
  for (const [name, email] of hopeless) {
    assertEqual(suggestContactName(name, email, name), null, `${name} <${email}> should stay silent`)
  }
})

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passed}/${passed + failed} passed${failed > 0 ? `, ${failed} failed` : ''}`)
process.exit(failed > 0 ? 1 : 0)
