// Is this card safe to sell on its own yet?
//
// A bundle (proofs.proof_sets, 000311) is N separate proofs reviewed together
// on one link. Approval, though, is per card — so a customer can approve one
// and ask for changes on another, and the approved card lands in the Orders
// page's "Links to send" worklist as an ordinary row with nothing on it saying
// the other cards exist. Every bundle-aware surface built so far (the dashboard
// block/chip, the workspace, the whole-bundle chase in 000317) stops at the
// proofing stage; nothing in the ORDERING path had ever read proof_set_id.
//
// What that cost, 12 August 2026 — Michael A. Bogdan, two cards:
//
//   12:59:34  customer approves the Matte Black Metal card
//   13:01:05  customer reopens the bundle
//   13:02:05  customer requests changes on the Letterpress card
//   13:02:08  a pay link for the metal card is created and sent — 3s later
//
// Cancelled before the customer opened it, but it was the fifth time an order
// had been raised on a bundle whose siblings were still outstanding (Trevor Lee
// twice, Mohammed Ahmed, The Experience Auto Group), and the others were caught
// the same way: by hand, afterwards.
//
// Note the three seconds. A warning computed when the page loaded could not
// possibly have known about a change request that landed after it — which is
// why this module is a twin, and why create-order re-runs it at send time
// against the live table. Same shape as the duplicate-pay-link guard, built
// after two designers sent links 1.9s apart.
//
// It WARNS, it never blocks (Rob, 12 Aug 2026). Selling one card of a bundle is
// sometimes exactly right — the customer wants the approved one now, or the
// rest are months away — and it stays recoverable either way, since a sent link
// can still be pulled into a combined payment later. The point is that it
// becomes a decision somebody made, rather than one they didn't know they were
// making.
//
// Twin of supabase/functions/_shared/bundleOrderGuard.ts (Vite and Deno can't share a module
// cleanly — if you change one, change the other). bundleOrderGuard.test.ts
// imports BOTH copies and fails on any drift, because the page and the server
// disagreeing about what a bundle is would be worse than neither knowing.

/** One member card, straight from `proofs`. The three fields below are the
 *  whole membership rule — deliberately the same shape dashboardBundles.ts
 *  fetches, so both can read one query. */
export interface BundleCardRow {
  id: string
  proof_set_id: string | null
  set_discarded_at: string | null
  status: string
}

/**
 * Is this card still part of the bundle?
 *
 * Two exclusions, both already settled elsewhere and both meaning "somebody has
 * already decided about this card":
 *   * set-aside (`set_discarded_at`) — the customer said no to it;
 *   * abandoned — the designer dropped it (10 of 35 live members at the time
 *     dashboardBundles.ts was written).
 *
 * Neither is a reason to hold an order back, so neither counts as outstanding
 * NOR toward the "of N" the labels quote.
 */
export function isLiveBundleCard(c: BundleCardRow): boolean {
  return !!c.proof_set_id && !c.set_discarded_at && c.status !== 'abandoned'
}

/** A live sibling that hasn't been signed off. `id` is all this module knows —
 *  naming the card (material, "changes requested") is the caller's job, since
 *  the page and the edge function reach for different columns to do it. */
export interface OutstandingSibling {
  id: string
}

export interface BundleOrderState {
  setId: string
  /** Live cards in the bundle, including the one being ordered. Always >= 2. */
  size: number
  /** How many of those are approved. */
  approvedCount: number
  /** Live, not-yet-approved siblings. Never includes the card being ordered.
   *  Empty means the whole bundle is signed off — worth saying too, since that
   *  is the moment to combine the payments rather than send N links. */
  outstanding: OutstandingSibling[]
}

/**
 * The bundle context for one card, or null when there isn't one worth saying
 * anything about.
 *
 * Null in three cases, and the third is the interesting one:
 *   * the card is in no set at all;
 *   * the card itself is set-aside or abandoned (nothing to sell);
 *   * the set is down to fewer than 2 live cards. One card is not a bundle —
 *     the same call 000317 made when it stopped chasing a last-card-standing
 *     set as a bundle, and the same floor dashboardBundles.ts uses. A "bundle
 *     of 1" warning is noise, and noise is what gets warnings ignored.
 *
 * `members` may be the whole membership table unfiltered (it is on the Orders
 * page, mirroring the dashboard's fetch); rows from other sets are ignored.
 */
export function bundleOrderState(
  proofId: string,
  members: BundleCardRow[],
): BundleOrderState | null {
  const self = members.find((m) => m.id === proofId)
  if (!self || !isLiveBundleCard(self)) return null

  const setId = self.proof_set_id as string
  const live = members.filter((m) => m.proof_set_id === setId && isLiveBundleCard(m))
  if (live.length < 2) return null

  return {
    setId,
    size: live.length,
    approvedCount: live.filter((m) => m.status === 'approved').length,
    outstanding: live
      .filter((m) => m.id !== proofId && m.status !== 'approved')
      .map((m) => ({ id: m.id })),
  }
}

/** Shorthand for the one question both surfaces actually ask. */
export function hasOutstandingSiblings(state: BundleOrderState | null): boolean {
  return !!state && state.outstanding.length > 0
}

/** "1 of 2 approved" — the progress line, worded identically wherever it shows
 *  so the Orders page, the order builder and the proof page read as one system. */
export function bundleProgressLabel(state: BundleOrderState): string {
  return `${state.approvedCount} of ${state.size} approved`
}
