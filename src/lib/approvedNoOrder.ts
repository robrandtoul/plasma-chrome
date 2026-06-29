// The "approved proof with no order link sent yet" set — the source both the
// Orders page "Links to send" worklist and the Orders nav-pill count badge read,
// so the badge can never drift from the list.
//
// Only the FILTER predicate lives here (keepApprovedNoOrder); the worklist owns
// its own richer per-row mapping. The count helper mirrors orderingEnabled.ts:
// a short TTL cache + in-flight de-dup so the badge doesn't re-query on every
// page navigation, and a fail-safe 0 (a missing badge is the safe default).

import { supabase } from './supabase'

interface OrderXref {
  proof_id: string
  created_at: string | null
}

// Ordering go-live = the first order ever created. Approvals from before the
// payment system existed were billed the old way and will never become an
// in-app order, so they're excluded. An empty orders table → Infinity → nothing
// qualifies, which is correct (the system isn't live yet).
function goLiveMsOf(orderRows: OrderXref[]): number {
  return orderRows.reduce((min, r) => {
    const t = r.created_at ? new Date(r.created_at).getTime() : NaN
    return Number.isFinite(t) && t < min ? t : min
  }, Infinity)
}

// Keep only approved proofs with NO order of any status, approved on/after
// ordering go-live. Generic so callers can pass either a light
// { proof_id, approved_at } row (the nav-badge count) or the full dashboard row
// (the worklist) — extra fields pass through untouched. This is the single
// predicate both surfaces share, so the badge count equals the worklist length.
export function keepApprovedNoOrder<T extends { proof_id: string; approved_at: string | null }>(
  approvedRows: T[],
  orderRows: OrderXref[],
): T[] {
  const withOrder = new Set(orderRows.map((r) => r.proof_id))
  const goLiveMs = goLiveMsOf(orderRows)
  return approvedRows.filter(
    (r) =>
      !!r.approved_at &&
      !withOrder.has(r.proof_id) &&
      new Date(r.approved_at).getTime() >= goLiveMs,
  )
}

// Cached count of approved-no-order proofs for the nav badge.
const TTL_MS = 60_000
let cache: { value: number; fetchedAt: number } | null = null
let inFlight: Promise<number> | null = null

// Drop the cache so the badge refreshes promptly (e.g. right after an order link
// is created). The next getApprovedNoOrderCount() re-queries.
export function invalidateApprovedNoOrderCount(): void {
  cache = null
}

export async function getApprovedNoOrderCount(): Promise<number> {
  if (cache && Date.now() - cache.fetchedAt < TTL_MS) return cache.value
  if (inFlight) return inFlight

  inFlight = (async () => {
    try {
      const [{ data: approvedRows }, { data: orderRows }] = await Promise.all([
        supabase.from('public_dashboard_projects').select('proof_id, approved_at').eq('status', 'approved'),
        supabase.from('orders').select('proof_id, created_at'),
      ])
      const value = keepApprovedNoOrder(
        (approvedRows ?? []) as { proof_id: string; approved_at: string | null }[],
        (orderRows ?? []) as OrderXref[],
      ).length
      cache = { value, fetchedAt: Date.now() }
      return value
    } catch {
      // Fail-safe: a transient read failure must not throw in the header — show
      // no badge rather than break the chrome.
      cache = { value: 0, fetchedAt: Date.now() }
      return 0
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}
