// Extract currency signals from the raw material a designer has to hand when
// creating a version: the Help Scout enquiry text and the customer's email.
// Pure string functions — no network, no Supabase — so they're cheap to test
// against the real message shapes (see currencyResolver.test.ts).

import type { Currency } from './types'
import { matchLeadingCountry } from './currencyForCountry'

// The stated country in the enquiry. Covers the artwork-request form
// ("Based in: United States"), the support form ("Country: United States"),
// and the older form layout that puts the value on the next line
// ("Country⏎United Kingdom"). Returns the country's ISO code, or null.
// Scans every label occurrence and returns the first that resolves to a real
// country, so a "Country: not provided" line is skipped rather than trusted.
export function countryFromThread(text: string | null | undefined): string | null {
  if (!text) return null
  const re = /(?:based\s+in|country)\s*[:\-]?\s*/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const start = m.index + m[0].length
    const code = matchLeadingCountry(text.slice(start, start + 48))
    if (code) return code
  }
  return null
}

// A previous payment's currency, for returning customers whose thread carries a
// receipt ("You've paid $376.90 USD on your Visa"). Gated on the word "paid"
// so a stray "$" or a VAT number in a signature can't trigger it.
export function paymentCurrencyFromThread(
  text: string | null | undefined,
): Currency | null {
  if (!text) return null
  const explicit = text.match(/\bpaid\b[^\n]{0,40}?\b(GBP|USD|EUR)\b/i)
  if (explicit) return explicit[1].toUpperCase() as Currency
  const symbol = text.match(/\bpaid\b[^\n]{0,12}?([£$€])/i)
  if (symbol) return symbol[1] === '£' ? 'GBP' : symbol[1] === '€' ? 'EUR' : 'USD'
  return null
}

// A country-coded email domain. Deliberately conservative — only the
// unambiguous geographic top-level domains (.uk → GBP, European ccTLDs → EUR).
// Generic domains (.com, .co, .io, .ai, .me) resolve to null so the caller
// abstains rather than guessing.
const EUROPEAN_TLDS = new Set([
  'eu', 'de', 'fr', 'it', 'es', 'nl', 'be', 'pt', 'at', 'ch', 'se', 'dk', 'fi',
  'no', 'pl', 'gr', 'cz', 'hu', 'ro', 'sk', 'si', 'hr', 'lt', 'lv', 'ee', 'lu',
  'is', 'li', 'ie', 'mc', 'ad', 'sm',
])

export function currencyFromEmailDomain(
  email: string | null | undefined,
): Currency | null {
  const domain = (email ?? '').trim().toLowerCase().split('@')[1]
  if (!domain) return null
  const tld = domain.split('.').pop() ?? ''
  if (tld === 'uk') return 'GBP'
  if (EUROPEAN_TLDS.has(tld)) return 'EUR'
  return null
}
