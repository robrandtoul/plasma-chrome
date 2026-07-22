// Currency by country — the single rule behind the new-version currency
// suggestion.
//
// House rule (Rob, 2026-07): the UK is GBP, ANY European country is EUR
// (including non-euro Europe — Norway, Switzerland, Sweden), and everywhere
// else is USD. The Crown dependencies (Jersey, Guernsey, Isle of Man) and
// Gibraltar use sterling, so they map to GBP for CURRENCY purposes — a
// separate question from the VAT treatment in ukVatArea.ts, which is why this
// doesn't reuse that module.
//
// Input may be a country NAME ("United States", "Germany") as it appears in a
// Help Scout enquiry, or an ISO 3166-1 alpha-2 CODE ("US", "DE") as it appears
// on an order. Unrecognised or blank input returns null so the caller abstains
// rather than guessing (names are a trap — a customer's nationality is not
// their location, so we only ever read a stated country, never a surname).

import type { Currency } from './types'
import { SHIP_COUNTRY_CODES } from './shipCountries'

// Sterling economies (by currency, not VAT area): the UK plus the Crown
// dependencies / Gibraltar that use the pound.
const GBP_CODES = new Set(['GB', 'JE', 'GG', 'IM', 'GI'])

// Geographic Europe that prices in EUR — the EU 27 plus the non-EU European
// countries we sell to (Norway, Switzerland, Iceland, the Balkans, the
// microstates, Ukraine, Moldova). The UK is deliberately absent (GBP above).
// Turkey and the Caucasus are treated as rest-of-world (USD).
const EUR_CODES = new Set([
  // EU 27
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU',
  'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
  // non-EU Europe
  'NO', 'CH', 'IS', 'LI', 'MC', 'SM', 'AD', 'VA', 'AL', 'BA', 'RS', 'ME', 'MK',
  'XK', 'MD', 'UA',
])

// The union of every code we can name. USD is the default bucket, so this need
// not be exhaustive — any recognised country outside GBP/EUR resolves to USD.
const ALL_CODES = Array.from(
  new Set([...SHIP_COUNTRY_CODES, ...GBP_CODES, ...EUR_CODES]),
)
const KNOWN_CODES = new Set(ALL_CODES.map((c) => c.toUpperCase()))

const REGION_NAMES =
  typeof Intl !== 'undefined' && 'DisplayNames' in Intl
    ? new Intl.DisplayNames(['en'], { type: 'region' })
    : null

function displayName(code: string): string | null {
  try {
    const n = REGION_NAMES?.of(code)
    return n && n !== code ? n : null
  } catch {
    return null
  }
}

// The ways customers write countries that Intl's canonical names don't cover.
const ALIASES: Record<string, string> = {
  usa: 'US', 'u.s.a.': 'US', 'u.s.': 'US', us: 'US',
  'united states of america': 'US', america: 'US',
  uk: 'GB', 'u.k.': 'GB', 'united kingdom': 'GB', 'great britain': 'GB',
  britain: 'GB', england: 'GB', scotland: 'GB', wales: 'GB',
  'northern ireland': 'GB', gb: 'GB',
  uae: 'AE', 'u.a.e.': 'AE', 'united arab emirates': 'AE',
  holland: 'NL', 'the netherlands': 'NL',
  'republic of ireland': 'IE',
  czechia: 'CZ', 'czech republic': 'CZ',
  'south korea': 'KR', 'republic of korea': 'KR',
}

// Lowercased name → ISO code, longest name first so leading-substring matching
// prefers "united states of america" over "united states" over any short alias.
const NAME_ENTRIES: { name: string; code: string }[] = (() => {
  const map = new Map<string, string>()
  for (const [name, code] of Object.entries(ALIASES)) map.set(name, code)
  for (const code of ALL_CODES) {
    const n = displayName(code)
    if (n) map.set(n.toLowerCase(), code)
  }
  return Array.from(map, ([name, code]) => ({ name, code })).sort(
    (a, b) => b.name.length - a.name.length,
  )
})()

// Normalise a country name or code to its ISO alpha-2 code, or null if we can't
// recognise it.
export function normaliseCountryToCode(
  input: string | null | undefined,
): string | null {
  const raw = (input ?? '').trim()
  if (!raw) return null
  const upper = raw.toUpperCase()
  if (/^[A-Z]{2}$/.test(upper) && KNOWN_CODES.has(upper)) return upper
  const lower = raw.toLowerCase()
  if (ALIASES[lower]) return ALIASES[lower]
  const hit = NAME_ENTRIES.find((e) => e.name === lower)
  return hit ? hit.code : null
}

// The rule. Returns null (abstain) for anything we can't confidently classify.
export function currencyForCountry(
  input: string | null | undefined,
): Currency | null {
  const code = normaliseCountryToCode(input)
  if (!code) return null
  if (GBP_CODES.has(code)) return 'GBP'
  if (EUR_CODES.has(code)) return 'EUR'
  return 'USD'
}

// Find a country named at the START of `text` — used to read the value after a
// "Based in:" / "Country:" label. Boundary-checked so "United States REFERENCE"
// matches but "use this account" does not. Returns the ISO code, or null.
export function matchLeadingCountry(text: string): string | null {
  const t = text.trim().toLowerCase()
  if (!t) return null
  for (const { name, code } of NAME_ENTRIES) {
    if (t.startsWith(name)) {
      const next = t.charAt(name.length)
      if (next === '' || !/[a-z]/i.test(next)) return code
    }
  }
  return null
}

// Human-readable country name for a code (for the suggestion's explanation).
export function displayCountry(code: string | null | undefined): string {
  const c = (code ?? '').trim().toUpperCase()
  return displayName(c) ?? c
}
