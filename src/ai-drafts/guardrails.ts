// Hard gates that run on the rendered draft text — never on the model's
// self-report. A draft that fails any gate is blocked; the system stays
// silent rather than risk a wrong fact reaching a customer.
//
// MONEY GATE. Every money mention in the draft — symbol form (£305), ISO form
// (GBP 305 / 305 GBP), word form (305 pounds), or pence/cent shorthand
// (20p, 25c) — must reconcile against the allowed-figure set:
//   (a) a known figure standing alone (price tier, surcharge, house-rule
//       charge, or a figure STAFF already stated in the thread), or
//   (b) a tier + ONE add-on (an option surcharge for the same material and
//       quantity, or a house-rule charge like personalisation/shipping) —
//       never tier+tier or addon+addon, which would make the acceptance set
//       dense enough for hallucinated figures to pass, or
//   (c) a GBP VAT conversion (x1.2 or /1.2, ±1p) of an accepted figure.
// Amount parsing handles UK and continental separators, space/apostrophe
// grouping, and k/m suffixes; anything ambiguous parses to a sentinel that
// can never reconcile (fail closed). Customer-authored figures are NOT added
// to the allowed set — a customer cannot seed a price.
//
// URL GATE. Every URL — with scheme, www-prefixed, bare autolinkable domain,
// or mailto:/tel:/data: — must prefix-match the approved-links list. Links
// marked echoOnly (customer proof pages) additionally must already appear in
// the inbound thread, so the model cannot fabricate a plausible proof URL.

import { APPROVED_LINKS } from './briefing/approvedLinks'
import { HOUSE_RULES } from './briefing/houseRules'
import type { Currency, GroundingData, GuardrailVerdict, ThreadMessage } from './types'
import { normaliseBody } from './htmlText'

const SYMBOL_TO_CURRENCY: Record<string, Currency> = { '£': 'GBP', '€': 'EUR', $: 'USD' }
const WORD_TO_CURRENCY: Record<string, Currency> = {
  gbp: 'GBP',
  pound: 'GBP',
  pounds: 'GBP',
  quid: 'GBP',
  eur: 'EUR',
  euro: 'EUR',
  euros: 'EUR',
  usd: 'USD',
  dollar: 'USD',
  dollars: 'USD',
}

// An amount token: digits with optional grouping (comma, dot, space, NBSP,
// narrow NBSP, apostrophes) and an optional 1-2 digit decimal part in either
// convention. Grouping groups are exactly 3 digits.
const AMOUNT = String.raw`\d{1,3}(?:[.,'’   ]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?`
// Optional thousand/million magnitude suffix: £300k, $1.5m.
const MAGNITUDE = String.raw`(?:\s?([kKmM])(?![A-Za-z]))?`

const SYMBOL_MONEY_RE = new RegExp(String.raw`([£€$])\s*(${AMOUNT})${MAGNITUDE}`, 'g')
const ISO_PREFIX_RE = new RegExp(String.raw`\b(GBP|EUR|USD)\s*(${AMOUNT})${MAGNITUDE}`, 'gi')
const WORD_SUFFIX_RE = new RegExp(
  String.raw`\b(${AMOUNT})${MAGNITUDE}\s*(GBP|EUR|USD|pounds?|euros?|dollars?|quid)\b`,
  'gi',
)
const PENCE_RE = new RegExp(String.raw`(?<![\w£€$.,])(\d{1,3}(?:\.\d{1,2})?)\s?(?:p|pence)\b`, 'gi')
const CENT_RE = new RegExp(String.raw`(?<![\w£€$.,])(\d{1,3}(?:\.\d{1,2})?)\s?(?:c|cents?)\b`, 'gi')

// Disambiguate grouping vs decimal separators. Money never has 3+ decimal
// places, so a final 3-digit group is grouping ("£1,799" and "€1.799" are
// both 1799). Returns null for malformed tokens — the caller emits a
// fail-closed sentinel figure so the draft is blocked, not waved through.
export function parseAmountToken(token: string): number | null {
  const stripped = token.replace(/['’   ]/g, '')
  const lastDot = stripped.lastIndexOf('.')
  const lastComma = stripped.lastIndexOf(',')
  const lastSep = Math.max(lastDot, lastComma)
  if (lastSep === -1) {
    const value = Number.parseInt(stripped, 10)
    return Number.isFinite(value) ? value : null
  }
  const tail = stripped.length - lastSep - 1
  let intPart: string
  let decPart: string
  if (tail === 3) {
    // Final group of exactly 3 digits → grouping.
    intPart = stripped.replace(/[.,]/g, '')
    decPart = ''
  } else if (tail === 1 || tail === 2) {
    intPart = stripped.slice(0, lastSep).replace(/[.,]/g, '')
    decPart = stripped.slice(lastSep + 1)
  } else {
    return null
  }
  if (!/^\d+$/.test(intPart) || (decPart && !/^\d+$/.test(decPart))) return null
  const value = Number.parseFloat(decPart ? `${intPart}.${decPart}` : intPart)
  return Number.isFinite(value) ? value : null
}

export interface MoneyFigure {
  // Usually one currency; two for ambiguous cent shorthand ("25c" → EUR/USD).
  // The gate passes a figure if ANY of its currencies accepts it.
  currencies: Currency[]
  // Pence/cents as an integer; -1 = unparseable token (never reconciles).
  pence: number
  raw: string
}

function magnitudeMultiplier(suffix: string | undefined): number {
  if (!suffix) return 1
  return suffix.toLowerCase() === 'k' ? 1_000 : 1_000_000
}

export function extractMoneyFigures(text: string): MoneyFigure[] {
  const figures: MoneyFigure[] = []
  // Symbol and ISO/word passes run over a copy with prior matches blanked so
  // the same characters are never counted twice ("£305 GBP" is one figure).
  let remaining = text

  const consume = (re: RegExp, getCurrencies: (m: RegExpMatchArray) => Currency[], amountIx: number, magIx: number) => {
    remaining = remaining.replace(re, (...args) => {
      const m = args as unknown as RegExpMatchArray
      const currencies = getCurrencies(m)
      const amount = parseAmountToken(String(m[amountIx]))
      const pence =
        amount === null ? -1 : Math.round(amount * 100 * magnitudeMultiplier(m[magIx] as string | undefined))
      figures.push({ currencies, pence, raw: String(m[0]).trim() })
      return ' '.repeat(String(m[0]).length)
    })
  }

  consume(SYMBOL_MONEY_RE, (m) => [SYMBOL_TO_CURRENCY[m[1]]], 2, 3)
  consume(ISO_PREFIX_RE, (m) => [WORD_TO_CURRENCY[m[1].toLowerCase()]], 2, 3)
  consume(WORD_SUFFIX_RE, (m) => [WORD_TO_CURRENCY[m[3].toLowerCase()]], 1, 2)

  // Pence/cent shorthand: the amount IS the minor unit (20p = 20 pence).
  remaining = remaining.replace(PENCE_RE, (...args) => {
    const m = args as unknown as RegExpMatchArray
    const value = Number.parseFloat(String(m[1]))
    figures.push({
      currencies: ['GBP'],
      pence: Number.isFinite(value) ? Math.round(value) : -1,
      raw: String(m[0]).trim(),
    })
    return ' '.repeat(String(m[0]).length)
  })
  remaining.replace(CENT_RE, (...args) => {
    const m = args as unknown as RegExpMatchArray
    const value = Number.parseFloat(String(m[1]))
    figures.push({
      currencies: ['EUR', 'USD'],
      pence: Number.isFinite(value) ? Math.round(value) : -1,
      raw: String(m[0]).trim(),
    })
    return ''
  })

  return figures.filter((f) => f.currencies.every(Boolean))
}

// ── URL extraction ───────────────────────────────────────────────────────────

const URL_RE = /(?:https?:\/\/|www\.)[^\s<>"')\]]+/gi
const SPECIAL_URI_RE = /\b(?:mailto|tel|data|javascript):[^\s<>"')\]]+/gi
// Bare domains a mail client will autolink ("plasmadesign.co.uk/promo").
// Lookbehind skips emails (x@dom.com), path segments (/a.com), www. forms,
// and already-consumed scheme URLs.
const AUTOLINK_TLDS = new Set([
  'com', 'net', 'org', 'uk', 'co', 'io', 'me', 'app', 'dev', 'eu', 'us',
  'de', 'fr', 'es', 'it', 'nl', 'ie', 'info', 'biz', 'ly', 'link',
])
const BARE_DOMAIN_RE = /(?<![\w@./-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+([a-z]{2,})(?:\/[^\s<>"')\]]*)?/gi

function trimUrl(url: string): string {
  return url.replace(/[.,;:!?]+$/, '')
}

export function extractUrls(text: string): string[] {
  const urls: string[] = []
  let remaining = text
  remaining = remaining.replace(URL_RE, (whole) => {
    let url = trimUrl(whole)
    if (url.toLowerCase().startsWith('www.')) url = `https://${url}`
    urls.push(url)
    return ' '.repeat(whole.length)
  })
  remaining = remaining.replace(SPECIAL_URI_RE, (whole) => {
    urls.push(trimUrl(whole))
    return ' '.repeat(whole.length)
  })
  for (const match of remaining.matchAll(BARE_DOMAIN_RE)) {
    const tld = match[1].toLowerCase()
    if (!AUTOLINK_TLDS.has(tld)) continue
    const candidate = trimUrl(match[0])
    // Normalise with a path so prefix entries ending in '/' can match.
    urls.push(`https://${candidate}${candidate.includes('/') ? '' : '/'}`)
  }
  return urls
}

export function isApprovedUrl(url: string): boolean {
  const lower = url.toLowerCase()
  return APPROVED_LINKS.some((l) => lower.startsWith(l.prefix.toLowerCase()))
}

function matchesEchoOnlyPrefix(url: string): boolean {
  const lower = url.toLowerCase()
  return APPROVED_LINKS.some((l) => l.echoOnly && lower.startsWith(l.prefix.toLowerCase()))
}

// ── Allowed-figure set ───────────────────────────────────────────────────────

export class AllowedFigures {
  // Standalone-acceptable figures (tiers + staff echoes), per currency.
  private readonly tiers: Record<Currency, Set<number>> = { GBP: new Set(), EUR: new Set(), USD: new Set() }
  // Tier figures keyed by material|quantity, for same-row surcharge sums.
  private readonly tiersByKey: Record<Currency, Map<string, Set<number>>> = {
    GBP: new Map(),
    EUR: new Map(),
    USD: new Map(),
  }
  // House-rule add-ons (personalisation, shipping, split-name…): may combine
  // with any tier. Also standalone-acceptable.
  private readonly houseAddons: Record<Currency, Set<number>> = { GBP: new Set(), EUR: new Set(), USD: new Set() }
  // Option surcharges keyed by material|quantity: combine only with the
  // matching tier row. Also standalone-acceptable.
  private readonly surchargesByKey: Record<Currency, Map<string, Set<number>>> = {
    GBP: new Map(),
    EUR: new Map(),
    USD: new Map(),
  }

  addTier(currency: Currency, pence: number, key?: string): void {
    if (pence <= 0) return
    this.tiers[currency].add(pence)
    if (key) {
      const map = this.tiersByKey[currency]
      if (!map.has(key)) map.set(key, new Set())
      map.get(key)!.add(pence)
    }
  }

  addHouseAddon(currency: Currency, pence: number): void {
    if (pence > 0) this.houseAddons[currency].add(pence)
  }

  addSurcharge(currency: Currency, pence: number, key: string): void {
    if (pence <= 0) return
    const map = this.surchargesByKey[currency]
    if (!map.has(key)) map.set(key, new Set())
    map.get(key)!.add(pence)
  }

  // Level 0: standalone figure, or a semantically valid tier+addon sum.
  private accept0(currency: Currency, pence: number): boolean {
    if (this.tiers[currency].has(pence) || this.houseAddons[currency].has(pence)) return true
    for (const set of this.surchargesByKey[currency].values()) {
      if (set.has(pence)) return true
    }
    for (const addon of this.houseAddons[currency]) {
      if (addon < pence && this.tiers[currency].has(pence - addon)) return true
    }
    for (const [key, set] of this.surchargesByKey[currency]) {
      const rowTiers = this.tiersByKey[currency].get(key)
      if (!rowTiers) continue
      for (const s of set) {
        if (s < pence && rowTiers.has(pence - s)) return true
      }
    }
    return false
  }

  private accept0Near(currency: Currency, pence: number): boolean {
    return (
      this.accept0(currency, pence) ||
      this.accept0(currency, pence - 1) ||
      this.accept0(currency, pence + 1)
    )
  }

  accepts(currency: Currency, pence: number): boolean {
    if (pence < 0) return false
    if (this.accept0(currency, pence)) return true
    if (currency === 'GBP') {
      // VAT transforms: the draft figure may be inc-VAT of a known ex-VAT
      // figure or ex-VAT of a known inc-VAT figure. ±1p only on the
      // transformed value, to absorb rounding.
      if (this.accept0Near('GBP', Math.round(pence * 1.2))) return true
      if (this.accept0Near('GBP', Math.round(pence / 1.2))) return true
    }
    return false
  }

  acceptsAny(currencies: Currency[], pence: number): boolean {
    return currencies.some((c) => this.accepts(c, pence))
  }
}

export function buildAllowedFigures(
  grounding: GroundingData,
  inputThread: ThreadMessage[],
): AllowedFigures {
  const allowed = new AllowedFigures()
  for (const f of grounding.figures) {
    const pence = Math.round(f.amount * 100)
    const key = f.matKey && f.quantity != null ? `${f.matKey}|${f.quantity}` : undefined
    if (f.kind === 'tier') allowed.addTier(f.currency, pence, key)
    else if (key) allowed.addSurcharge(f.currency, pence, key)
    else allowed.addHouseAddon(f.currency, pence)
  }
  // Figures stated in house rules are policy add-ons (one-off £180, shipping
  // £12.90, personalisation £0.20/£50…).
  for (const rule of HOUSE_RULES) {
    for (const f of extractMoneyFigures(rule)) {
      if (f.pence <= 0) continue
      for (const c of f.currencies) allowed.addHouseAddon(c, f.pence)
    }
  }
  // Figures STAFF already stated in the conversation (a previous quote, an
  // internal note) are safe to repeat. Customer messages are untrusted input
  // and must never write the allow-set — a customer cannot seed a price.
  for (const message of inputThread) {
    if (message.role === 'customer') continue
    for (const f of extractMoneyFigures(normaliseBody(message.body))) {
      if (f.pence <= 0) continue
      for (const c of f.currencies) allowed.addTier(c, f.pence)
    }
  }
  return allowed
}

export function threadUrlSet(inputThread: ThreadMessage[]): Set<string> {
  const urls = new Set<string>()
  for (const message of inputThread) {
    for (const url of extractUrls(normaliseBody(message.body))) {
      urls.add(url.toLowerCase().replace(/\/$/, ''))
    }
  }
  return urls
}

// ── Verdict ──────────────────────────────────────────────────────────────────

export function runGuardrails(
  draftBody: string,
  allowed: AllowedFigures,
  threadUrls: Set<string> = new Set(),
): GuardrailVerdict {
  const reasons: string[] = []

  for (const figure of extractMoneyFigures(draftBody)) {
    if (figure.pence === 0) continue // "£0 extra" cannot misquote a price
    if (figure.pence < 0) {
      reasons.push(`money figure could not be parsed unambiguously: "${figure.raw}"`)
      continue
    }
    if (!allowed.acceptsAny(figure.currencies, figure.pence)) {
      reasons.push(
        `figure ${figure.raw} does not reconcile against the pricing data (not a known figure, tier+add-on sum, or VAT conversion)`,
      )
    }
  }

  for (const url of extractUrls(draftBody)) {
    if (!isApprovedUrl(url)) {
      reasons.push(`URL not on the approved list: ${url}`)
      continue
    }
    if (matchesEchoOnlyPrefix(url) && !threadUrls.has(url.toLowerCase().replace(/\/$/, ''))) {
      reasons.push(`proof URL not present in the thread (cannot be fabricated): ${url}`)
    }
  }

  return reasons.length === 0 ? { ok: true } : { ok: false, reasons }
}
