// Cached access to live GBP → EUR / USD exchange rates.
//
// FedEx invoices Plasma's account in GBP regardless of the
// preferredCurrency we pass on the rate request, so the figures the
// Quote compiler renders for EUR / USD customers need a real-time
// conversion from the GBP base. We fetch from the European Central
// Bank via the public Frankfurter API (https://www.frankfurter.app) —
// free, no auth, no rate limits in practice, daily-updated reference
// rates sourced from the ECB.
//
// Pattern matches vatRateGbp.ts:
//   * 1h TTL — exchange rates don't move fast enough to need finer.
//     ECB publishes once a working day, so anything tighter is just
//     wasted requests.
//   * In-flight de-duplication so concurrent mounts share one fetch.
//   * Fail-safe defaults on any read error so the compiler keeps
//     rendering rather than blanking the shipping card. The
//     fallback rate is documented as exactly that — better to quote
//     in the wrong target currency by a percent or two than to
//     leave the designer staring at a missing total mid-call.
//
// rateDate is the ECB's published date for the rate, separate from
// fetchedAt which is when we got it. The card surfaces rateDate in
// the "Converted at today's rate" footnote so the designer knows
// whether they're reading a fresh or stale rate.

const TTL_MS = 60 * 60 * 1000

export interface ExchangeRates {
  gbpToEur: number
  gbpToUsd: number
  /** ISO date the ECB published the rate, e.g. "2026-05-13". */
  rateDate: string
}

let cache: { value: ExchangeRates; fetchedAt: number } | null = null
let inFlight: Promise<ExchangeRates> | null = null

// Conservative mid-2025 averages — kept generous either way so a
// transient outage doesn't quote a 30% bogus figure.
const FAIL_SAFE_DEFAULT: ExchangeRates = {
  gbpToEur: 1.17,
  gbpToUsd: 1.27,
  rateDate: '',
}

export async function getExchangeRates(): Promise<ExchangeRates> {
  if (cache && Date.now() - cache.fetchedAt < TTL_MS) return cache.value
  if (inFlight) return inFlight

  inFlight = (async () => {
    try {
      const resp = await fetch('https://api.frankfurter.app/latest?from=GBP&to=EUR,USD')
      if (!resp.ok) {
        cache = { value: FAIL_SAFE_DEFAULT, fetchedAt: Date.now() }
        return FAIL_SAFE_DEFAULT
      }
      const data = await resp.json() as {
        date?: string
        rates?: { EUR?: number; USD?: number }
      }
      const eur = data.rates?.EUR
      const usd = data.rates?.USD
      const date = data.date
      if (typeof eur !== 'number' || typeof usd !== 'number' || typeof date !== 'string') {
        cache = { value: FAIL_SAFE_DEFAULT, fetchedAt: Date.now() }
        return FAIL_SAFE_DEFAULT
      }
      const value: ExchangeRates = { gbpToEur: eur, gbpToUsd: usd, rateDate: date }
      cache = { value, fetchedAt: Date.now() }
      return value
    } catch {
      cache = { value: FAIL_SAFE_DEFAULT, fetchedAt: Date.now() }
      return FAIL_SAFE_DEFAULT
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

// Look up the multiplier to take a GBP figure into the target
// currency. GBP → GBP is the identity. Returns 1 when rates are
// null (fail-safe path) so the caller doesn't have to special-case
// a missing rate — the GBP figures pass through unchanged.
export function gbpToCurrency(target: 'GBP' | 'EUR' | 'USD', rates: ExchangeRates | null): number {
  if (target === 'GBP') return 1
  if (!rates) return 1
  return target === 'EUR' ? rates.gbpToEur : rates.gbpToUsd
}

// Convert a figure in `currency` back to GBP — the inverse of gbpToCurrency.
// EUR / USD divide by the GBP→target rate; GBP is the identity. Returns the
// amount unchanged when rates are null or zero (fail-safe path) so a transient
// outage doesn't blank or zero an aggregated total — better off by a percent
// or two than showing nothing.
export function currencyToGbp(amount: number, currency: 'GBP' | 'EUR' | 'USD', rates: ExchangeRates | null): number {
  const rate = gbpToCurrency(currency, rates)
  return rate ? amount / rate : amount
}

export function invalidateExchangeRates(): void {
  cache = null
}
