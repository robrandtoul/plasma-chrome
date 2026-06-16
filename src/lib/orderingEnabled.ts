// Cached access to settings.ordering_enabled — the master switch for
// the Ordering & checkout feature (migration 000228). Designer-facing
// surfaces (the ProofDetailPage "Create order" button) read this on
// mount and only reveal the order builder when it's on.
//
// Mirrors repliesEnabled.ts exactly:
//   * 60s TTL so the value refreshes without hammering the database.
//   * In-flight de-duplication so concurrent mounts share one fetch.
//   * Defaults to false on any read failure — fail-safe for a feature
//     gate (a transient settings outage must not reveal an unfinished
//     feature).
//
// invalidateOrderingEnabled() lets the admin toggle save drop the
// cache so other open tabs pick up the change faster than the TTL.

import { supabase } from './supabase'

const TTL_MS = 60_000

let cache: { value: boolean; fetchedAt: number } | null = null
let inFlight: Promise<boolean> | null = null

const FAIL_SAFE_DEFAULT = false

export async function getOrderingEnabled(): Promise<boolean> {
  if (cache && Date.now() - cache.fetchedAt < TTL_MS) return cache.value
  if (inFlight) return inFlight

  inFlight = (async () => {
    try {
      const { data, error } = await supabase
        .from('settings')
        .select('ordering_enabled')
        .eq('id', 1)
        .single()
      const value = error || !data ? FAIL_SAFE_DEFAULT : !!data.ordering_enabled
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

/** Invalidate the cache. Called by the admin toggle save so a designer
 *  in another tab picks up the change faster than the 60-second TTL. */
export function invalidateOrderingEnabled(): void {
  cache = null
}
