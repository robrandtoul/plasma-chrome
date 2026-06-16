// Server-side shipping helpers for the checkout (Ordering & checkout).
// Faithful ports of the Quote-compiler's pure shipping maths so the
// figure a designer was quoted in /quote matches what the customer is
// charged at checkout. Two copies because Vite (src/) and Deno
// (functions/) can't share a module cleanly — if you change one, change
// the other:
//   * src/lib/quote/shipping.ts      — splitIntoBoxes, isNorthernIreland…,
//                                       resolveDomesticRate, applyIntlAdjustment
//   * src/lib/exchangeRates.ts       — getExchangeRates, gbpToCurrency
//
// FedEx invoices Plasma's account in GBP regardless of preferredCurrency,
// and the DPD flat rates are GBP, so every rate is computed in GBP and
// converted to the order currency at the end via the live ECB rate.

export type Currency = 'GBP' | 'EUR' | 'USD'

// Maximum gross weight FedEx accepts per FEDEX_BOX on International
// Priority before refusing the quote. Mirrors MAX_BOX_WEIGHT_GRAMS in
// src/lib/quote/shipping.ts.
export const MAX_BOX_WEIGHT_GRAMS = 15_000

// Split a shipment into N boxes (cards spread evenly, one box tare each),
// each capped at MAX_BOX_WEIGHT_GRAMS. Returns one weight (grams) per box.
// Null when the inputs can't yield a parcel (no weight / no quantity).
// Port of splitIntoBoxes in src/lib/quote/shipping.ts.
export function splitIntoBoxes(
  variantWeightGrams: number | null | undefined,
  quantity: number | null | undefined,
  boxTareGrams: number,
): number[] | null {
  if (variantWeightGrams == null || variantWeightGrams <= 0) return null
  if (quantity == null || quantity <= 0) return null
  const cardsWeight = variantWeightGrams * quantity
  const tare = Math.max(0, boxTareGrams)
  const maxCardsPerBox = Math.max(1, MAX_BOX_WEIGHT_GRAMS - tare)
  const boxCount = Math.max(1, Math.ceil(cardsWeight / maxCardsPerBox))
  const cardsPerBox = cardsWeight / boxCount

  const boxes: number[] = []
  let assignedCards = 0
  for (let i = 0; i < boxCount - 1; i++) {
    const cards = Math.round(cardsPerBox)
    boxes.push(cards + tare)
    assignedCards += cards
  }
  boxes.push(cardsWeight - assignedCards + tare)
  return boxes
}

// Northern Ireland detection — BT-prefix postcode followed by a digit
// (BT1–BT94). Port of isNorthernIrelandPostcode in src/lib/quote/shipping.ts.
export function isNorthernIrelandPostcode(postcode: string): boolean {
  return /^BT\d/.test(postcode.replace(/\s+/g, '').toUpperCase())
}

// Resolve the GBP DPD flat rate for a UK destination (mainland vs NI).
export function resolveDomesticGbp(
  postcode: string,
  mainlandRateGbp: number,
  niRateGbp: number,
): number {
  return isNorthernIrelandPostcode(postcode) ? niRateGbp : mainlandRateGbp
}

// Apply the admin international % adjustment (settings.fedex_intl_adjust_percent)
// to a FedEx GBP figure. Port of applyIntlAdjustment in src/lib/quote/shipping.ts.
export function applyIntlAdjustment(amountGbp: number, adjustPercent: number): number {
  return amountGbp * (1 + adjustPercent / 100)
}

export interface GbpRates {
  gbpToEur: number
  gbpToUsd: number
}

// Conservative fallbacks (mirror src/lib/exchangeRates.ts FAIL_SAFE_DEFAULT)
// so a transient Frankfurter outage doesn't block a payment — better to
// convert a couple of percent off than to fail the checkout.
const FAIL_SAFE_RATES: GbpRates = { gbpToEur: 1.17, gbpToUsd: 1.27 }

// Live GBP → EUR/USD reference rates from the ECB via Frankfurter. No
// auth, no rate limits in practice. Fail-safe on any error.
export async function fetchGbpRates(): Promise<GbpRates> {
  try {
    const resp = await fetch('https://api.frankfurter.app/latest?from=GBP&to=EUR,USD')
    if (!resp.ok) return FAIL_SAFE_RATES
    const data = (await resp.json()) as { rates?: { EUR?: number; USD?: number } }
    const eur = data.rates?.EUR
    const usd = data.rates?.USD
    if (typeof eur !== 'number' || typeof usd !== 'number') return FAIL_SAFE_RATES
    return { gbpToEur: eur, gbpToUsd: usd }
  } catch {
    return FAIL_SAFE_RATES
  }
}

// Multiplier to take a GBP figure into the target currency. Identity for
// GBP. Port of gbpToCurrency in src/lib/exchangeRates.ts.
export function gbpToCurrency(target: Currency, rates: GbpRates): number {
  if (target === 'GBP') return 1
  return target === 'EUR' ? rates.gbpToEur : rates.gbpToUsd
}
