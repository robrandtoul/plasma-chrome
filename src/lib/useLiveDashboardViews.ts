import { useEffect, useId, useRef } from 'react'
import { supabase } from './supabase'
import type { LiveViewRow } from './dashboardActivityFeed'

interface UseLiveDashboardViewsArgs {
  // Skipped entirely while false. The dashboard waits for its first load, so a
  // row can't arrive before there are any projects to place it against.
  enabled: boolean
  // Fired once per non-bot INSERT. Bot rows are dropped here so the live path
  // and the polled path surface the same set (the view filters them in SQL).
  onView: (row: LiveViewRow) => void
  // Fired when the channel comes back after a drop — never on the first
  // connect, which happens alongside the page's own load.
  //
  // This is the iOS rule from CLAUDE.md: an installed PWA that has been in a
  // pocket keeps the page in memory and kills the socket, so React never
  // remounts and everything that happened while it was away is simply missing,
  // with no gap marker to show for it. The consumer must refetch here rather
  // than assume the feed carried on where it left off.
  onReconnect: () => void
}

/**
 * Live `proofs.proof_version_views` INSERTs for the whole dashboard — the
 * "a customer is reading it right now" signal on the Latest activity card.
 *
 * Sibling of useLiveProofViews, which does the same job scoped to one proof for
 * the detail page's viewed indicator. Kept separate rather than generalised:
 * that hook is filtered to a version list and this one deliberately isn't, and
 * it feeds a page where a missed row would be a missing dot rather than a
 * missing line in a feed.
 *
 * Realtime is a bonus here, never the source of truth — the card polls its six
 * sources on a timer regardless, so a firewalled socket costs freshness in
 * seconds, not correctness.
 */
export function useLiveDashboardViews({ enabled, onView, onReconnect }: UseLiveDashboardViewsArgs) {
  // Stable refs so the effect's deps can stay narrow. Without them, every
  // parent re-render would tear down and re-establish the channel.
  const onViewRef = useRef(onView)
  const onReconnectRef = useRef(onReconnect)
  useEffect(() => {
    onViewRef.current = onView
    onReconnectRef.current = onReconnect
  })

  // Per-mount channel suffix. Without it, two simultaneous mounts (StrictMode's
  // double-mount in dev, fast HMR, back/forward cache replay) would ask for the
  // same channel name, get the same channel back, and the first cleanup would
  // remove the one the second mount is still using — silently dead until a hard
  // refresh. Same reasoning as useLiveProofViews.
  const channelSuffix = useId()

  useEffect(() => {
    if (!enabled) return

    // Deliberately unfiltered, unlike useLiveProofViews: this feed spans every
    // proof. On live that's about 66 view rows a day across the whole company,
    // so there is nothing worth narrowing and a filter could only lose rows.
    let everSubscribed = false

    const channel = supabase
      .channel(`dashboard-views-${channelSuffix}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          // proof_version_views lives in the `proofs` schema after the
          // consolidation. Targeting 'public' matches nothing and fails
          // silently — the bug useLiveProofViews shipped with once already.
          schema: 'proofs',
          table: 'proof_version_views',
        },
        (payload) => {
          const row = payload.new as LiveViewRow
          if (row.is_bot) return
          onViewRef.current(row)
        },
      )
      .subscribe((status, err) => {
        if (status === 'SUBSCRIBED') {
          // Only a RE-subscribe means a gap. The first one lands beside the
          // page's own load, which has just fetched everything there is.
          if (everSubscribed) onReconnectRef.current()
          everSubscribed = true
          return
        }
        // Surface the failure statuses so a dead socket (firewall, expired
        // session) doesn't pretend everything is fine. Diagnostic only — the
        // poll keeps the card correct either way.
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          if (err) console.warn('[useLiveDashboardViews]', status, err)
        }
      })

    return () => {
      void supabase.removeChannel(channel)
    }
  }, [enabled, channelSuffix])
}
