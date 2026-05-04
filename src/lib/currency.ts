import type { Currency } from './types'

const CURRENCY_LOCALE: Record<Currency, string> = {
  GBP: 'en-GB',
  EUR: 'de-DE',
  USD: 'en-US',
}

// Prices in the DB and snapshots are in major currency units (e.g. 279.00 = £279).
//
// `decimals` defaults to 0 — most price tier values are clean integers
// (£279, €280, $299) and rendering "£279.00" everywhere adds noise. The
// caveat is that integer-default rounding silently swallows half-pound
// surcharges: formatPrice(1.5) → "£2", which the customer-render path
// can't distinguish from a true £2 surcharge. To avoid that without
// forcing every caller to pass `decimals=2`, we auto-detect: if the
// caller didn't pass `decimals` AND the amount has fractional pence,
// promote to 2 decimals. Explicitly passing decimals (including 0)
// always wins, so the price-tier callers that know their data is
// integer don't pay any cost.
export function formatPrice(amount: number, currency: Currency, decimals?: number): string {
  const resolved = decimals !== undefined
    ? decimals
    : Number.isInteger(amount) ? 0 : 2
  return new Intl.NumberFormat(CURRENCY_LOCALE[currency], {
    style: 'currency',
    currency,
    minimumFractionDigits: resolved,
    maximumFractionDigits: resolved,
  }).format(amount)
}
