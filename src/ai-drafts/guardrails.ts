// Hard gates that run on the rendered draft text — never on the model's
// self-report. A draft that fails any gate is blocked; the system stays
// silent rather than risk a wrong fact reaching a customer.
//
// Money gate: every £/€/$ figure in the draft must be (a) a known grounding
// figure, (b) a sum of two known figures (base + surcharge / personalisation),
// or (c) a VAT conversion (x1.2 or /1.2, GBP only, +/-1p) of an accepted
// figure. House-rule figures (e.g. the £180 one-off, £12.90 shipping) and
// figures the customer themselves quoted in the thread are part of the
// allowed set.
//
// URL gate: every URL must prefix-match the approved-links list.

import { APPROVED_LINKS } from './briefing/approvedLinks'
import { HOUSE_RULES } from './briefing/houseRules'
import type { Currency, GroundingData, GuardrailVerdict, ThreadMessage } from './types'
import { normaliseBody } from './htmlText'

const SYMBOL_TO_CURRENCY: Record<string, Currency> = { '£': 'GBP', '€': 'EUR', $: 'USD' }

const MONEY_RE = /([£€$])\s?(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/g

export interface MoneyFigure {
  currency: Currency
  pence: number
  raw: string
}

export function extractMoneyFigures(text: string): MoneyFigure[] {
  const figures: MoneyFigure[] = []
  for (const match of text.matchAll(MONEY_RE)) {
    const currency = SYMBOL_TO_CURRENCY[match[1]]
    const amount = Number.parseFloat(match[2].replace(/,/g, ''))
    if (!currency || !Number.isFinite(amount)) continue
    figures.push({ currency, pence: Math.round(amount * 100), raw: match[0] })
  }
  return figures
}

const URL_RE = /(?:https?:\/\/|www\.)[^\s<>"')\]]+/gi

export function extractUrls(text: string): string[] {
  const urls: string[] = []
  for (const match of text.matchAll(URL_RE)) {
    let url = match[0].replace(/[.,;:!?]+$/, '')
    if (url.toLowerCase().startsWith('www.')) url = `https://${url}`
    urls.push(url)
  }
  return urls
}

export function isApprovedUrl(url: string): boolean {
  const lower = url.toLowerCase()
  return APPROVED_LINKS.some((l) => lower.startsWith(l.prefix.toLowerCase()))
}

// ── Allowed-figure set ───────────────────────────────────────────────────────

export class AllowedFigures {
  private readonly byCurrency: Record<Currency, Set<number>> = {
    GBP: new Set(),
    EUR: new Set(),
    USD: new Set(),
  }

  add(currency: Currency, pence: number): void {
    if (pence > 0) this.byCurrency[currency].add(pence)
  }

  // Level 0: exact figure, or a sum of two known figures.
  private accept0(currency: Currency, pence: number): boolean {
    const set = this.byCurrency[currency]
    if (set.has(pence)) return true
    for (const b of set) {
      if (b < pence && set.has(pence - b)) return true
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
    if (this.accept0(currency, pence)) return true
    if (currency === 'GBP') {
      // VAT transforms: the draft figure may be inc-VAT of a known ex-VAT
      // figure or ex-VAT of a known inc-VAT figure. +/-1p for rounding.
      if (this.accept0Near('GBP', Math.round(pence * 1.2))) return true
      if (this.accept0Near('GBP', Math.round(pence / 1.2))) return true
    }
    return false
  }
}

export function buildAllowedFigures(
  grounding: GroundingData,
  inputThread: ThreadMessage[],
): AllowedFigures {
  const allowed = new AllowedFigures()
  for (const f of grounding.figures) {
    allowed.add(f.currency, Math.round(f.amount * 100))
  }
  // Figures stated in house rules are policy (one-off £180, shipping £12.90…).
  for (const rule of HOUSE_RULES) {
    for (const f of extractMoneyFigures(rule)) allowed.add(f.currency, f.pence)
  }
  // Figures already present in the conversation (customer quoting a previous
  // price, a staff note) are safe to echo — the human reviews regardless.
  for (const message of inputThread) {
    for (const f of extractMoneyFigures(normaliseBody(message.body))) {
      allowed.add(f.currency, f.pence)
    }
  }
  return allowed
}

// ── Verdict ──────────────────────────────────────────────────────────────────

export function runGuardrails(
  draftBody: string,
  allowed: AllowedFigures,
): GuardrailVerdict {
  const reasons: string[] = []

  for (const figure of extractMoneyFigures(draftBody)) {
    if (!allowed.accepts(figure.currency, figure.pence)) {
      reasons.push(
        `figure ${figure.raw} does not reconcile against the pricing data (not a known figure, sum of two, or VAT conversion)`,
      )
    }
  }

  for (const url of extractUrls(draftBody)) {
    if (!isApprovedUrl(url)) {
      reasons.push(`URL not on the approved list: ${url}`)
    }
  }

  return reasons.length === 0 ? { ok: true } : { ok: false, reasons }
}
