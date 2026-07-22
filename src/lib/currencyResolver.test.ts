// Unit tests for the currency suggestion pipeline.
// Run with: pnpm test:currency  (npx tsx src/lib/currencyResolver.test.ts)
//
// Fixtures are the REAL Help Scout message shapes pulled during the 2026-07
// backtest of ~120 live proofs — including the traps that motivated the
// feature: a customer with an Italian surname based in Australia (→ USD), the
// older "Country⏎United Kingdom" form layout, and returning customers whose
// currency is only in a prior payment receipt.

import {
  currencyForCountry,
  normaliseCountryToCode,
  matchLeadingCountry,
} from './currencyForCountry'
import {
  countryFromThread,
  paymentCurrencyFromThread,
  currencyFromEmailDomain,
} from './currencySignals'
import { resolveCurrency } from './currencyResolver'

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
    throw new Error(
      message ?? `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    )
  }
}

// ── currencyForCountry ──────────────────────────────────────────────────────

console.log('currencyForCountry: names')
for (const [name, expected] of [
  ['United States', 'USD'], ['United Kingdom', 'GBP'], ['Germany', 'EUR'],
  ['Italy', 'EUR'], ['Australia', 'USD'], ['India', 'USD'], ['Belgium', 'EUR'],
  ['Luxembourg', 'EUR'], ['Norway', 'EUR'], ['Switzerland', 'EUR'],
  ['Sweden', 'EUR'], ['Canada', 'USD'], ['United Arab Emirates', 'USD'],
  ['Greece', 'EUR'], ['France', 'EUR'], ['Jersey', 'GBP'], ['Guernsey', 'GBP'],
  ['Isle of Man', 'GBP'], ['USA', 'USD'], ['UK', 'GBP'], ['England', 'GBP'],
  ['UAE', 'USD'], ['Netherlands', 'EUR'], ['Ireland', 'EUR'],
] as const) {
  test(`${name} → ${expected}`, () =>
    assertEqual(currencyForCountry(name), expected))
}

console.log('currencyForCountry: ISO codes')
for (const [code, expected] of [
  ['US', 'USD'], ['GB', 'GBP'], ['DE', 'EUR'], ['CA', 'USD'], ['JE', 'GBP'],
  ['IM', 'GBP'], ['NO', 'EUR'], ['GR', 'EUR'], ['FR', 'EUR'], ['AE', 'USD'],
] as const) {
  test(`${code} → ${expected}`, () =>
    assertEqual(currencyForCountry(code), expected))
}

console.log('currencyForCountry: abstains on the unknown')
test('empty → null', () => assertEqual(currencyForCountry(''), null))
test('null → null', () => assertEqual(currencyForCountry(null), null))
test('"not provided" → null', () =>
  assertEqual(currencyForCountry('not provided'), null))
test('gibberish → null', () => assertEqual(currencyForCountry('Freedonia'), null))

console.log('normaliseCountryToCode')
test('name → code', () => assertEqual(normaliseCountryToCode('Germany'), 'DE'))
test('alias → code', () => assertEqual(normaliseCountryToCode('USA'), 'US'))
test('code passthrough', () => assertEqual(normaliseCountryToCode('gb'), 'GB'))

// ── matchLeadingCountry ─────────────────────────────────────────────────────

console.log('matchLeadingCountry')
test('country then a stop word', () =>
  assertEqual(matchLeadingCountry('United States REFERENCE Submission'), 'US'))
test('country then a newline', () =>
  assertEqual(matchLeadingCountry('United Kingdom\n\nCard Specifications'), 'GB'))
test('single word country', () =>
  assertEqual(matchLeadingCountry('Australia REFERENCE'), 'AU'))
test('non-country → null', () =>
  assertEqual(matchLeadingCountry('not provided'), null))

// ── countryFromThread (real message shapes) ─────────────────────────────────

console.log('countryFromThread')
test('artwork form "Based in:"', () =>
  assertEqual(
    countryFromThread(
      'SEND THE PROOF TO Name: Desmond Singh Email: x Phone: 8042219347 ' +
        'Company: Desmond Construction Based in: United States REFERENCE ' +
        'Submission 9AA326C3, logged to Supabase.',
    ),
    'US',
  ))
test('the Australia trap', () =>
  assertEqual(
    countryFromThread('Company: not provided Based in: Australia REFERENCE'),
    'AU',
  ))
test('EUR country in form', () =>
  assertEqual(countryFromThread('Based in: Belgium REFERENCE Submission'), 'BE'))
test('older "Country⏎value" layout', () =>
  assertEqual(
    countryFromThread('Country\n\nUnited Kingdom\n\nCard Specifications\n\nMaterial: Metal'),
    'GB',
  ))
test('support form "Country:"', () =>
  assertEqual(
    countryFromThread(
      'Phone: 19177821284 Country: United States Submitted via the support form.',
    ),
    'US',
  ))
test('skips "Country: not provided", finds the real one', () =>
  assertEqual(
    countryFromThread('Country: not provided ... Based in: Italy REFERENCE'),
    'IT',
  ))
test('no country stated → null', () =>
  assertEqual(
    countryFromThread('Hi Chris, please can you quote me for x500. Thanks Paul'),
    null,
  ))

// ── paymentCurrencyFromThread (real receipts) ───────────────────────────────

console.log('paymentCurrencyFromThread')
test('USD receipt', () =>
  assertEqual(
    paymentCurrencyFromThread("You've paid $376.90 USD on your Visa credit card."),
    'USD',
  ))
test('GBP receipt', () =>
  assertEqual(
    paymentCurrencyFromThread("You've paid £207.90 GBP on your MasterCard debit card."),
    'GBP',
  ))
test('EUR receipt', () =>
  assertEqual(
    paymentCurrencyFromThread("You've paid €777.90 EUR on your MasterCard credit card."),
    'EUR',
  ))
test('large USD amount with comma', () =>
  assertEqual(paymentCurrencyFromThread("You've paid $3,546.90 USD"), 'USD'))
test('no payment → null', () =>
  assertEqual(paymentCurrencyFromThread('THE JOB A metal business card.'), null))

// ── currencyFromEmailDomain ─────────────────────────────────────────────────

console.log('currencyFromEmailDomain')
test('.co.uk → GBP', () =>
  assertEqual(currencyFromEmailDomain('paul@fluidesign.co.uk'), 'GBP'))
test('.uk → GBP', () =>
  assertEqual(currencyFromEmailDomain('x@apex-training.uk'), 'GBP'))
test('.de → EUR', () =>
  assertEqual(currencyFromEmailDomain('info@block-link.de'), 'EUR'))
test('.it → EUR', () =>
  assertEqual(currencyFromEmailDomain('andrea@beyond-group.it'), 'EUR'))
test('.eu → EUR', () => assertEqual(currencyFromEmailDomain('x@firm.eu'), 'EUR'))
test('.com → null (generic)', () =>
  assertEqual(currencyFromEmailDomain('info@toptiersecurity.com'), null))
test('.ai → null (generic)', () =>
  assertEqual(currencyFromEmailDomain('mike@aeromynde.ai'), null))
test('gmail → null', () =>
  assertEqual(currencyFromEmailDomain('someone@gmail.com'), null))

// ── resolveCurrency (end to end) ────────────────────────────────────────────

console.log('resolveCurrency')
test('stated country → high confidence', () => {
  const r = resolveCurrency({ threadText: 'Based in: United States REFERENCE' })
  assertEqual(r?.currency, 'USD')
  assertEqual(r?.confidence, 'high')
  assertEqual(r?.reasons[0].source, 'thread-country')
})
test('the Australia name-trap resolves to USD', () => {
  const r = resolveCurrency({
    threadText: 'Name: Samuele Gasparini Based in: Australia REFERENCE',
    contactEmail: 'sammy@gr2concrete.com',
  })
  assertEqual(r?.currency, 'USD')
  assertEqual(r?.confidence, 'high')
})
test('returning customer via prior payment', () => {
  const r = resolveCurrency({ threadText: "You've paid £207.90 GBP on your MasterCard" })
  assertEqual(r?.currency, 'GBP')
  assertEqual(r?.confidence, 'high')
})
test('domain only → medium confidence', () => {
  const r = resolveCurrency({ contactEmail: 'x@firm.co.uk' })
  assertEqual(r?.currency, 'GBP')
  assertEqual(r?.confidence, 'medium')
})
test('proof history only', () => {
  const r = resolveCurrency({ priorCurrencies: ['USD', 'USD'] })
  assertEqual(r?.currency, 'USD')
  assertEqual(r?.confidence, 'high')
  assertEqual(r?.reasons[0].source, 'proof-history')
})
test('conflicting strong signals → medium, thread wins primary', () => {
  const r = resolveCurrency({
    threadText: 'Based in: United States REFERENCE',
    priorCurrencies: ['GBP'],
  })
  assertEqual(r?.currency, 'USD') // thread-country outranks proof-history
  assertEqual(r?.confidence, 'medium') // but the conflict softens it
  assertEqual(r?.reasons.length, 2)
})
test('agreeing signals stay high', () => {
  const r = resolveCurrency({
    threadText: 'Based in: United Kingdom REFERENCE',
    contactEmail: 'x@firm.co.uk',
    priorCurrencies: ['GBP'],
  })
  assertEqual(r?.currency, 'GBP')
  assertEqual(r?.confidence, 'high')
})
test('no signal → null (stay silent)', () => {
  assertEqual(resolveCurrency({ threadText: 'thanks!', contactEmail: 'x@gmail.com' }), null)
})

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
