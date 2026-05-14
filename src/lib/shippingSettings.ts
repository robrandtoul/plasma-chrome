// Cached access to the FedEx shipping settings — box tare weight in
// grams plus the international % adjustment applied at render time
// to FedEx-quoted totals.
//
// Mirrors src/lib/vatRateGbp.ts:
//   * 60s TTL so a flurry of compiler mounts doesn't hammer the DB.
//   * In-flight de-duplication so concurrent mounts share one fetch.
//   * Fail-safe defaults on any read error so the compiler keeps
//     rendering rather than blanking the shipping card during a
//     transient settings outage.
//
// invalidateShippingSettings() lets the admin save flow drop the
// cache so other open tabs / surfaces pick up new values faster than
// waiting for the TTL.

import { supabase } from './supabase'

const TTL_MS = 60_000

export interface ShippingSettings {
  boxWeightGrams: number
  intlAdjustPercent: number
  /** Flat DPD rate for UK mainland deliveries, GBP VAT-inclusive. */
  domesticMainlandRateGbp: number
  /** Flat DPD rate for Northern Ireland deliveries, GBP VAT-inclusive. */
  domesticNiRateGbp: number
}

let cache: { value: ShippingSettings; fetchedAt: number } | null = null
let inFlight: Promise<ShippingSettings> | null = null

// Same defaults that the migrations ship: 250g placeholder box,
// 0% adjustment, £12.90 / £18.90 domestic rates. Picking these as
// the fallback keeps the compiler rendering a plausible total
// during a transient settings outage — the worst case is the
// figure being off by the missing adjustment, not the card
// collapsing entirely.
const FAIL_SAFE_DEFAULT: ShippingSettings = {
  boxWeightGrams: 250,
  intlAdjustPercent: 0,
  domesticMainlandRateGbp: 12.90,
  domesticNiRateGbp: 18.90,
}

export async function getShippingSettings(): Promise<ShippingSettings> {
  if (cache && Date.now() - cache.fetchedAt < TTL_MS) return cache.value
  if (inFlight) return inFlight

  inFlight = (async () => {
    try {
      const { data, error } = await supabase
        .from('settings')
        .select('fedex_box_weight_grams, fedex_intl_adjust_percent, domestic_uk_mainland_rate_gbp, domestic_uk_ni_rate_gbp')
        .eq('id', 1)
        .single()
      if (error || !data) {
        cache = { value: FAIL_SAFE_DEFAULT, fetchedAt: Date.now() }
        return FAIL_SAFE_DEFAULT
      }
      // Defensive clamps mirror the DB CHECK constraints so a stale
      // open tab in the brief mid-update window can't surface an
      // out-of-range value.
      const boxRaw = typeof data.fedex_box_weight_grams === 'number'
        ? data.fedex_box_weight_grams
        : FAIL_SAFE_DEFAULT.boxWeightGrams
      const adjRaw = typeof data.fedex_intl_adjust_percent === 'number'
        ? data.fedex_intl_adjust_percent
        : FAIL_SAFE_DEFAULT.intlAdjustPercent
      const mainlandRaw = typeof data.domestic_uk_mainland_rate_gbp === 'number'
        ? data.domestic_uk_mainland_rate_gbp
        : FAIL_SAFE_DEFAULT.domesticMainlandRateGbp
      const niRaw = typeof data.domestic_uk_ni_rate_gbp === 'number'
        ? data.domestic_uk_ni_rate_gbp
        : FAIL_SAFE_DEFAULT.domesticNiRateGbp
      const value: ShippingSettings = {
        boxWeightGrams: Math.max(0, Math.round(boxRaw)),
        intlAdjustPercent: Math.max(-100, Math.min(100, adjRaw)),
        domesticMainlandRateGbp: Math.max(0, mainlandRaw),
        domesticNiRateGbp: Math.max(0, niRaw),
      }
      cache = { value, fetchedAt: Date.now() }
      return value
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

export function invalidateShippingSettings(): void {
  cache = null
}
