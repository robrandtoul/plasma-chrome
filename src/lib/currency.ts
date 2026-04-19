import type { Currency } from './types'

const CURRENCY_LOCALE: Record<Currency, string> = {
  GBP: 'en-GB',
  EUR: 'de-DE',
  USD: 'en-US',
}

export function formatPrice(amountPence: number, currency: Currency): string {
  return new Intl.NumberFormat(CURRENCY_LOCALE[currency], {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amountPence / 100)
}
