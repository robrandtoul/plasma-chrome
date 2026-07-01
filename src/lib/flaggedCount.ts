// Count of open items on the Flagged board — the source the header's Flagged
// nav-pill badge reads. "Open" mirrors the dashboard's Flagged tile exactly:
// every watch_items row whose status isn't 'resolved' (see DashboardPage's
// flaggedCountPromise). Kept here as a shared helper, mirroring
// approvedNoOrder.ts: a short TTL cache + in-flight de-dup so the badge doesn't
// re-query on every navigation, and a fail-safe 0 (a missing badge is the safe
// default — the chrome must never break on a transient read failure).

import { supabase } from './supabase'

const TTL_MS = 60_000
let cache: { value: number; fetchedAt: number } | null = null
let inFlight: Promise<number> | null = null

export async function getFlaggedCount(): Promise<number> {
  if (cache && Date.now() - cache.fetchedAt < TTL_MS) return cache.value
  if (inFlight) return inFlight

  inFlight = (async () => {
    try {
      // head + count: the row data never transfers, only the count.
      const { count } = await supabase
        .from('watch_items')
        .select('id', { count: 'exact', head: true })
        .neq('status', 'resolved')
      const value = count ?? 0
      cache = { value, fetchedAt: Date.now() }
      return value
    } catch {
      // Fail-safe: show no badge rather than break the header chrome.
      cache = { value: 0, fetchedAt: Date.now() }
      return 0
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}
