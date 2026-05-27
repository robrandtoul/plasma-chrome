import { type HTMLAttributes } from 'react'

export type Currency = 'GBP' | 'EUR' | 'USD'

interface CurrencyAmountProps extends HTMLAttributes<HTMLSpanElement> {
  amount: number
  currency?: Currency
  size?: 'sm' | 'md' | 'lg' | 'xl'
}

const SYMBOL: Record<Currency, string> = { GBP: '£', EUR: '€', USD: '$' }

// 18 / 22 / 28 / 56 px. Tabular numerals on, semibold (xl is 600),
// slight negative tracking. Locale en-GB for the thousands separator.
// Whole-pound amounts render without a decimal; pass an amount with
// a fractional component (e.g. 12.5) to opt in to .50 / .05 / .55.
const SIZE_PX: Record<NonNullable<CurrencyAmountProps['size']>, number> = {
  sm: 18,
  md: 22,
  lg: 28,
  xl: 56,
}

export function CurrencyAmount({ amount, currency = 'GBP', size = 'md', className = '', ...rest }: CurrencyAmountProps) {
  const symbol = SYMBOL[currency]
  const formatter = new Intl.NumberFormat('en-GB', {
    minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    maximumFractionDigits: 2,
  })
  const fs = SIZE_PX[size]
  const cls = ['num font-mono font-semibold text-ink', className].filter(Boolean).join(' ')
  return (
    <span
      className={cls}
      style={{ fontSize: fs, letterSpacing: '-0.01em', lineHeight: 1 }}
      {...rest}
    >
      {symbol}
      {formatter.format(amount)}
    </span>
  )
}

export default CurrencyAmount
