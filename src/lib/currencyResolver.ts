// The layered currency resolver behind the new-version suggestion + challenge.
//
// Given what we can gather about a customer, work out the most likely currency
// and say WHY. Four layers, strongest first — no single one covers everyone
// (the backtest of ~120 live proofs showed the stated country carries most,
// but resellers and returning customers who email free-text need the domain /
// payment / history layers), but together they leave almost nothing unresolved.
//
// The output feeds two things: a PRE-FILL of the currency field, and a
// CHALLENGE if the designer picks something else. It never blocks — a customer
// can legitimately be an exception (rare, but real), so the worst case is one
// dismissible prompt.

import type { Currency } from './types'
import { currencyForCountry, displayCountry } from './currencyForCountry'
import {
  countryFromThread,
  paymentCurrencyFromThread,
  currencyFromEmailDomain,
} from './currencySignals'

export type CurrencySignalSource =
  | 'thread-country'
  | 'payment-history'
  | 'proof-history'
  | 'email-domain'

export interface CurrencyReason {
  source: CurrencySignalSource
  currency: Currency
  /** Lowercase-leading clause, for composing "Looks like USD — <detail>." */
  detail: string
}

export interface CurrencySuggestion {
  currency: Currency
  /** high = a strong signal (or several agreeing); medium = domain-only or
   *  strong signals that conflict. The UI pre-fills on any suggestion but only
   *  challenges a diverging pick on high confidence. */
  confidence: 'high' | 'medium'
  /** Every firing signal, strongest first. */
  reasons: CurrencyReason[]
}

export interface CurrencyResolverInputs {
  /** The customer's own Help Scout messages, joined (newest first). */
  threadText?: string | null
  contactEmail?: string | null
  /** Currencies on the SAME customer's other proofs. */
  priorCurrencies?: (Currency | null | undefined)[] | null
}

const PRECEDENCE: CurrencySignalSource[] = [
  'thread-country',
  'payment-history',
  'proof-history',
  'email-domain',
]

export function resolveCurrency(
  inputs: CurrencyResolverInputs,
): CurrencySuggestion | null {
  const reasons: CurrencyReason[] = []

  // 1. The country stated in the enquiry — the customer's actual location.
  const countryCode = countryFromThread(inputs.threadText)
  const countryCurrency = countryCode ? currencyForCountry(countryCode) : null
  if (countryCurrency) {
    reasons.push({
      source: 'thread-country',
      currency: countryCurrency,
      detail: `their enquiry says they're based in ${displayCountry(countryCode)}`,
    })
  }

  // 2. A previous payment in the thread (returning customers).
  const payCurrency = paymentCurrencyFromThread(inputs.threadText)
  if (payCurrency) {
    reasons.push({
      source: 'payment-history',
      currency: payCurrency,
      detail: `a previous payment of theirs was in ${payCurrency}`,
    })
  }

  // 3. The same customer's other proofs — the direct fix for the two-projects,
  //    two-currencies slip.
  const priorList = (inputs.priorCurrencies ?? []).filter(
    (c): c is Currency => !!c,
  )
  const priorUnique = Array.from(new Set(priorList))
  if (priorUnique.length === 1) {
    reasons.push({
      source: 'proof-history',
      currency: priorUnique[0],
      detail:
        priorList.length > 1
          ? `their other ${priorList.length} projects are in ${priorUnique[0]}`
          : `their other project is in ${priorUnique[0]}`,
    })
  }

  // 4. A country-coded email domain (resellers / regulars who skip the form).
  const domainCurrency = currencyFromEmailDomain(inputs.contactEmail)
  if (domainCurrency) {
    reasons.push({
      source: 'email-domain',
      currency: domainCurrency,
      detail: `their email is a ${domainCurrency === 'GBP' ? 'UK' : 'European'} domain`,
    })
  }

  if (reasons.length === 0) return null

  reasons.sort(
    (a, b) => PRECEDENCE.indexOf(a.source) - PRECEDENCE.indexOf(b.source),
  )
  const primary = reasons[0]

  // Confidence: high when a strong (non-domain) signal fired and no two strong
  // signals disagree; medium when only the domain fired, or strong signals
  // conflict (e.g. a UK company with a US-based contact — worth a softer touch).
  const strong = reasons.filter((r) => r.source !== 'email-domain')
  const strongCurrencies = new Set(strong.map((r) => r.currency))
  const confidence: 'high' | 'medium' =
    strong.length === 0 || strongCurrencies.size > 1 ? 'medium' : 'high'

  return { currency: primary.currency, confidence, reasons }
}
