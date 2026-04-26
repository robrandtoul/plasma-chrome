// Cached access to settings.replies_enabled — the global on/off
// switch for the send-helpscout-reply edge function (migration
// 000104). Designer-facing surfaces (MessageSendPanel, the
// ProofDetailPage Customer reply section, the TrialModeBanner)
// read this flag on mount to render disabled UI states when
// replies are paused.
//
// Mirrors the publicSettings.ts shape:
//   * 60s TTL so the value is refreshed without hammering the
//     database from a flurry of page loads.
//   * In-flight de-duplication so concurrent mounts share one
//     fetch.
//   * Defaults to false on any read failure — fail-safe for a
//     trial-mode or kill-switch use case.
//
// invalidateRepliesEnabled() lets the admin save flow drop the
// cache so other open tabs / surfaces pick up the new value
// faster than waiting for the TTL.

import { supabase } from './supabase'

const TTL_MS = 60_000

let cache: { value: boolean; fetchedAt: number } | null = null
let inFlight: Promise<boolean> | null = null

const FAIL_SAFE_DEFAULT = false

export async function getRepliesEnabled(): Promise<boolean> {
  if (cache && Date.now() - cache.fetchedAt < TTL_MS) return cache.value
  if (inFlight) return inFlight

  inFlight = (async () => {
    try {
      const { data, error } = await supabase
        .from('settings')
        .select('replies_enabled')
        .eq('id', 1)
        .single()
      // Treat any read failure as the safe default (off). Trial-
      // mode and kill-switch use cases both prefer false-on-error
      // to true-on-error: a transient settings outage shouldn't
      // accidentally enable a feature that's meant to be paused.
      const value = error || !data ? FAIL_SAFE_DEFAULT : !!data.replies_enabled
      cache = { value, fetchedAt: Date.now() }
      return value
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

/** Invalidate the cache. Called by the admin toggle save so a
 *  designer in another tab picks up the change faster than the
 *  60-second TTL on next mount. */
export function invalidateRepliesEnabled(): void {
  cache = null
}
