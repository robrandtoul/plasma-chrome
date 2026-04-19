import type { Currency } from './types'

const CURRENCY_LOCALE: Record<Currency, string> = {
  GBP: 'en-GB',
  EUR: 'de-DE',
  USD: 'en-US',
}

// Prices in the DB and snapshots are in major currency units (e.g. 279.00 = £279).
export function formatPrice(amount: number, currency: Currency, decimals = 0): string {
  return new Intl.NumberFormat(CURRENCY_LOCALE[currency], {
    style: 'currency',
    currency,
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(amount)
}
