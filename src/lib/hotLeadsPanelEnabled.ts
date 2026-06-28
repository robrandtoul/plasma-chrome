// Cached access to settings.hot_leads_panel_enabled — the admin switch for
// the "Hot leads to chase" card on the designer dashboard (migration 000280).
// DashboardPage reads this on mount and only renders HotLeadsCard when it's on.
//
// Mirrors orderingEnabled.ts:
//   * 60s TTL so the value refreshes without hammering the database.
//   * In-flight de-duplication so concurrent mounts share one fetch.
//
// Defaults to TRUE on any read failure — the panel ships shown, so a transient
// settings outage must not hide an existing feature (the opposite fail-safe to
// an unfinished-feature gate like orderingEnabled).
//
// invalidateHotLeadsPanelEnabled() lets the admin toggle save drop the cache so
// other open tabs pick up the change faster than the TTL.

import { supabase } from './supabase'

const TTL_MS = 60_000

let cache: { value: boolean; fetchedAt: number } | null = null
let inFlight: Promise<boolean> | null = null

const FAIL_SAFE_DEFAULT = true

export async function getHotLeadsPanelEnabled(): Promise<boolean> {
  if (cache && Date.now() - cache.fetchedAt < TTL_MS) return cache.value
  if (inFlight) return inFlight

  inFlight = (async () => {
    try {
      const { data, error } = await supabase
        .from('settings')
        .select('hot_leads_panel_enabled')
        .eq('id', 1)
        .single()
      const value = error || !data ? FAIL_SAFE_DEFAULT : !!data.hot_leads_panel_enabled
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
export function invalidateHotLeadsPanelEnabled(): void {
  cache = null
}
