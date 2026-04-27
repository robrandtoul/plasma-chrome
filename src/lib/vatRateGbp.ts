// Cached access to settings.vat_rate_gbp — the UK VAT rate used
// to derive the ex-VAT figure on the quote compiler's GBP headline
// price. Migration 000115 adds the column with default 0.20 (20%).
//
// Mirrors the repliesEnabled.ts shape (which itself mirrors
// publicSettings.ts):
//   * 60s TTL so the value is refreshed without hammering the
//     database from a flurry of page loads.
//   * In-flight de-duplication so concurrent mounts share one
//     fetch.
//   * Defaults to 0.20 (current UK standard rate) on any read
//     failure. Picking a wrong-rate fallback over a no-rate
//     fallback keeps the ex-VAT line rendering during transient
//     settings outages — matches the pricing-rule philosophy that
//     showing an approximate figure is better than blanking the
//     line a designer is reading aloud.
//
// invalidateVatRateGbp() lets the admin save flow drop the cache
// so other open tabs / surfaces pick up the new value faster than
// waiting for the TTL.

import { supabase } from './supabase'

const TTL_MS = 60_000

let cache: { value: number; fetchedAt: number } | null = null
let inFlight: Promise<number> | null = null

const FAIL_SAFE_DEFAULT = 0.20

export async function getVatRateGbp(): Promise<number> {
  if (cache && Date.now() - cache.fetchedAt < TTL_MS) return cache.value
  if (inFlight) return inFlight

  inFlight = (async () => {
    try {
      const { data, error } = await supabase
        .from('settings')
        .select('vat_rate_gbp')
        .eq('id', 1)
        .single()
      if (error || !data || typeof data.vat_rate_gbp !== 'number') {
        const fallback = FAIL_SAFE_DEFAULT
        cache = { value: fallback, fetchedAt: Date.now() }
        return fallback
      }
      // Defensive clamp — the DB has a CHECK 0..1 but a stale
      // open tab could theoretically read a value mid-update;
      // clamp here so consumers never see something outside the
      // sane range.
      const clamped = Math.max(0, Math.min(1, data.vat_rate_gbp))
      cache = { value: clamped, fetchedAt: Date.now() }
      return clamped
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

/** Invalidate the cache. Called by the admin save so a designer
 *  in another tab picks up the change faster than the 60-second
 *  TTL on next mount. */
export function invalidateVatRateGbp(): void {
  cache = null
}
