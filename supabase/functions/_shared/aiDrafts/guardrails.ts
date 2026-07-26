// Hard gates that run on the rendered draft text — never on the model's
// self-report. A draft that fails any gate is blocked; the system stays
// silent rather than risk a wrong fact reaching a customer.
//
// MONEY GATE. Every money mention in the draft — symbol form (£305), ISO form
// (GBP 305 / 305 GBP), word form (305 pounds), or pence/cent shorthand
// (20p, 25c) — must reconcile against the allowed-figure set:
//   (a) a known figure standing alone (price tier, surcharge, prototyping
//       fee, house-rule charge, or a figure STAFF already stated in the
//       thread), or
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
// or mailto:/tel:/data: — must match the approved-links list (curated real
// site pages; no domain-wide prefix, so invented slugs block). Links marked
// echoOnly (customer proof pages) additionally must already appear in the
// inbound thread, so the model cannot fabricate a plausible proof URL.
//
// PHRASE GATE. Drafts must never reveal production arrangements: in-house
// phrasing and supplier names block outright.

import { APPROVED_LINKS } from './briefing/approvedLinks.ts'
import { HOUSE_RULES } from './briefing/houseRules.ts'
import type { GroundingSlice } from './grounding.ts'
import type { Currency, GroundingData, GuardrailVerdict, ThreadMessage } from './types.ts'
import { normaliseBody } from './htmlText.ts'

// Production arrangements are confidential (review item 9): in-house
// phrasing and partner/supplier names must never reach a customer.
const FORBIDDEN_PHRASES: { re: RegExp; label: string }[] = [
  { re: /\bin[- ]house\b/i, label: 'production-location phrasing ("in-house")' },
  { re: /solopress/i, label: 'supplier name' },
  { re: /metallic\s+elephant/i, label: 'supplier name' },
  { re: /\bqx\b/i, label: 'supplier name' },
  { re: /\bdermid\b/i, label: 'supplier name' },
]

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

// Canonicalise before matching: lowercase, force the www host (both forms of
// the site domain are equivalent), drop one trailing slash.
function canonicalUrl(url: string): string {
  return url
    .toLowerCase()
    .replace('://plasmadesign.co.uk', '://www.plasmadesign.co.uk')
    .replace(/\/$/, '')
}

export function isApprovedUrl(url: string): boolean {
  const candidate = canonicalUrl(url)
  return APPROVED_LINKS.some((l) => {
    const prefix = canonicalUrl(l.prefix)
    return l.match === 'exact' ? candidate === prefix : candidate.startsWith(prefix)
  })
}

function matchesEchoOnlyPrefix(url: string): boolean {
  const candidate = canonicalUrl(url)
  return APPROVED_LINKS.some(
    (l) => l.echoOnly && candidate.startsWith(canonicalUrl(l.prefix)),
  )
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
  // Between-tier interpolation bands [lo, hi] for materials under discussion.
  private readonly bands: Record<Currency, [number, number][]> = { GBP: [], EUR: [], USD: [] }
  // Discount multipliers a staff note in the thread explicitly approved.
  private discountPercents: number[] = []

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

  addBand(currency: Currency, loPence: number, hiPence: number): void {
    if (loPence > 0 && hiPence > loPence) this.bands[currency].push([loPence, hiPence])
  }

  setDiscountPercents(percents: number[]): void {
    this.discountPercents = percents.filter((p) => p > 0 && p < 100)
  }

  private inBand(currency: Currency, pence: number): boolean {
    return this.bands[currency].some(([lo, hi]) => pence >= lo && pence <= hi)
  }

  // Level 0: standalone figure, interpolation band, or a semantically valid
  // tier+addon sum (the tier part may itself be an in-band interpolation).
  private accept0(currency: Currency, pence: number): boolean {
    if (this.tiers[currency].has(pence) || this.houseAddons[currency].has(pence)) return true
    if (this.inBand(currency, pence)) return true
    for (const set of this.surchargesByKey[currency].values()) {
      if (set.has(pence)) return true
    }
    for (const addon of this.houseAddons[currency]) {
      if (addon >= pence) continue
      if (this.tiers[currency].has(pence - addon) || this.inBand(currency, pence - addon)) return true
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

  // Core = level 0, or a staff-note-approved discount of a level-0 figure.
  private acceptCore(currency: Currency, pence: number): boolean {
    if (this.accept0(currency, pence)) return true
    for (const p of this.discountPercents) {
      const original = Math.round(pence / (1 - p / 100))
      if (this.accept0Near(currency, original)) return true
    }
    return false
  }

  private acceptCoreNear(currency: Currency, pence: number): boolean {
    return (
      this.acceptCore(currency, pence) ||
      this.acceptCore(currency, pence - 1) ||
      this.acceptCore(currency, pence + 1)
    )
  }

  accepts(currency: Currency, pence: number): boolean {
    if (pence < 0) return false
    if (this.acceptCore(currency, pence)) return true
    if (currency === 'GBP') {
      // VAT transforms: the draft figure may be inc-VAT of a known ex-VAT
      // figure or ex-VAT of a known inc-VAT figure (including discounted
      // ones). ±1p only on the transformed value, to absorb rounding.
      if (this.acceptCoreNear('GBP', Math.round(pence * 1.2))) return true
      if (this.acceptCoreNear('GBP', Math.round(pence / 1.2))) return true
    }
    return false
  }

  acceptsAny(currencies: Currency[], pence: number): boolean {
    return currencies.some((c) => this.accepts(c, pence))
  }
}

const NOTE_PERCENT_RE = /(\d{1,2})\s?%/g

export function buildAllowedFigures(
  grounding: GroundingData,
  inputThread: ThreadMessage[],
  slice?: GroundingSlice,
  // The SAME house rules the prompt was built from (DB briefing on the live
  // path, constants in the backtest). If the prompt reads a freshly-approved
  // rule introducing a figure but this allow-set reads the stale constant, the
  // model quotes the figure and the guardrail then blocks the draft — every
  // such draft silently fails. The two MUST read the one array. Defaults to the
  // constants so existing callers/tests are unaffected.
  houseRules: string[] = HOUSE_RULES,
): AllowedFigures {
  const allowed = new AllowedFigures()
  for (const f of grounding.figures) {
    const pence = Math.round(f.amount * 100)
    const key = f.matKey && f.quantity != null ? `${f.matKey}|${f.quantity}` : undefined
    if (f.kind === 'tier') allowed.addTier(f.currency, pence, key)
    else if (key) allowed.addSurcharge(f.currency, pence, key)
    else allowed.addHouseAddon(f.currency, pence)
  }
  // Prototyping-service fees (£179 metal, £59 wood…). These are POLICY prices,
  // not price-grid tiers, so they go in as house add-ons — standalone-quotable
  // and combinable with one tier, exactly how personalisation behaves.
  //
  // This loop is load-bearing, not tidying. Until migration 000352 these
  // figures only reached the allow-set as a side effect: the old "£180" was
  // typed into house rule 12 and scraped back out by the extractMoneyFigures
  // pass below. Now that the numbers live in grounding instead of in prose,
  // that accident no longer happens — without this, a draft quoting the CORRECT
  // £59 wood prototype would be blocked as an unreconciled figure.
  for (const p of grounding.prototypePrices ?? []) {
    const pence = Math.round(p.amount * 100)
    if (pence > 0) allowed.addHouseAddon(p.currency, pence)
  }
  // Figures stated in house rules are policy add-ons (shipping £12.90,
  // personalisation £0.20/£50…).
  for (const rule of houseRules) {
    for (const f of extractMoneyFigures(rule)) {
      if (f.pence <= 0) continue
      for (const c of f.currencies) allowed.addHouseAddon(c, f.pence)
    }
  }
  // Figures STAFF already stated in the conversation (a previous quote, an
  // internal note) are safe to repeat, and a percentage a staff note states
  // ("10%?" ... "yep") unlocks exactly that discount multiplier. Customer
  // messages are untrusted input and must never write the allow-set —
  // a customer cannot seed a price or a discount.
  const percents: number[] = []
  for (const message of inputThread) {
    if (message.role === 'customer') continue
    const body = normaliseBody(message.body)
    for (const f of extractMoneyFigures(body)) {
      if (f.pence <= 0) continue
      for (const c of f.currencies) allowed.addTier(c, f.pence)
    }
    for (const m of body.matchAll(NOTE_PERCENT_RE)) {
      percents.push(Number.parseInt(m[1], 10))
    }
  }
  allowed.setDiscountPercents(percents)
  // Between-tier interpolation bands for the materials under discussion
  // (review item 4): any figure between two adjacent tier prices of a slice
  // material is an acceptable interpolated quote.
  if (slice) {
    for (const material of slice.materials) {
      for (const variant of material.variants) {
        const sorted = [...variant.tiers].sort((a, b) => a.quantity - b.quantity)
        for (let i = 0; i + 1 < sorted.length; i++) {
          const lo = Math.round(Math.min(sorted[i].total_price, sorted[i + 1].total_price) * 100)
          const hi = Math.round(Math.max(sorted[i].total_price, sorted[i + 1].total_price) * 100)
          allowed.addBand(slice.currency, lo, hi)
        }
      }
    }
  }
  return allowed
}

// Normalise a URL to the form stored in the thread-URL set — lowercase, no
// trailing slash. threadUrlSet() and the echo checks in runGuardrails() MUST
// use this same key, or an echoed URL won't match.
function threadKey(url: string): string {
  return url.toLowerCase().replace(/\/$/, '')
}

export function threadUrlSet(inputThread: ThreadMessage[]): Set<string> {
  const urls = new Set<string>()
  for (const message of inputThread) {
    for (const url of extractUrls(normaliseBody(message.body))) {
      urls.add(threadKey(url))
    }
  }
  return urls
}

// ── Verdict ──────────────────────────────────────────────────────────────────

export function runGuardrails(
  draftBody: string,
  allowed: AllowedFigures,
  threadUrls: Set<string> = new Set(),
  customerUrls: Set<string> = new Set(),
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

  for (const { re, label } of FORBIDDEN_PHRASES) {
    const m = draftBody.match(re)
    if (m) reasons.push(`draft reveals production arrangements (${label}: "${m[0]}")`)
  }

  for (const url of extractUrls(draftBody)) {
    if (!isApprovedUrl(url)) {
      // Echo exception: an http(s) URL the CUSTOMER themselves put in the
      // thread is their own content (e.g. a website to print on their cards),
      // echoed back — not an AI-invented or un-vetted link, so it is safe.
      // Two deliberate scopes:
      //   • customerUrls only — URLs from the customer's OWN messages, never
      //     staff replies or internal notes (which hold supplier / internal /
      //     tracking links the FORBIDDEN_PHRASES gate exists to keep hidden).
      //   • http(s) only — never echo a mailto:/tel:/data:/javascript: URI even
      //     if present in the thread (a prompt-injected scheme must not slip
      //     through). Bare domains and www. are already normalised to https://.
      // An invented / off-list URL not in the customer's own message still blocks.
      if (/^https?:\/\//i.test(url) && customerUrls.has(threadKey(url))) continue
      reasons.push(`URL not on the approved list: ${url}`)
      continue
    }
    if (matchesEchoOnlyPrefix(url) && !threadUrls.has(threadKey(url))) {
      reasons.push(`proof URL not present in the thread (cannot be fabricated): ${url}`)
    }
  }

  return reasons.length === 0 ? { ok: true } : { ok: false, reasons }
}
