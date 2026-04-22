import { useEffect, useRef } from 'react'
import { supabase } from './supabase'

// Shape of a realtime-delivered proof_version_views row. Matches
// the table columns we care about at the indicator layer.
export interface LiveProofViewRow {
  id: string
  proof_version_id: string
  viewed_at: string
  user_agent: string | null
  is_bot: boolean
}

interface UseLiveProofViewsArgs {
  proofId: string | undefined
  // Version IDs for this proof. The realtime filter uses
  // proof_version_id=in.(...) server-side to avoid flooding the
  // client with other proofs' events. When the array is empty
  // (e.g. pre-load), the subscription is skipped.
  versionIds: string[]
  // Fired once per non-bot INSERT that arrives via realtime.
  // Bot rows are filtered client-side and never reach this
  // callback — same signal the designer indicator already uses
  // on its load-time fetch. Consumer should append to whatever
  // state backs the indicator (usually viewsByVersion).
  onView: (row: LiveProofViewRow) => void
}

// Live subscription for proof_version_views INSERTs scoped to a
// single proof. Feeds the designer-side viewed indicator so a
// customer opening the public URL shows up without a refresh.
//
// Rendered once per ProofDetailPage mount; unsubscribes on
// unmount or when proof.id / version list changes. Supabase
// client handles automatic reconnect on network blips —
// connection drops fall back gracefully to refresh-on-next-load
// (the load-time fetch still runs independently on every page
// navigation).
export function useLiveProofViews({ proofId, versionIds, onView }: UseLiveProofViewsArgs) {
  // Stable ref to onView so the effect's dep array can stay
  // narrow (proofId + versionIds key). Without this, every
  // parent re-render that creates a new onView closure would
  // tear down and re-establish the channel — expensive and
  // surprises anyone watching the Realtime dashboard.
  const onViewRef = useRef(onView)
  useEffect(() => {
    onViewRef.current = onView
  })

  // Flatten versionIds into a stable key so the effect doesn't
  // fire on array-identity changes that don't actually change
  // the set. Sort for determinism; versionIds order is whatever
  // the parent's query returned.
  const versionKey = [...versionIds].sort().join(',')

  useEffect(() => {
    if (!proofId) return
    if (versionIds.length === 0) return

    // Server-side filter via postgres_changes filter syntax. The
    // value is a PostgREST-flavoured filter string; in.(...) with
    // UUIDs works without quoting.
    const filter = `proof_version_id=in.(${versionIds.join(',')})`

    const channel = supabase
      .channel(`proof-views-${proofId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'proof_version_views',
          filter,
        },
        (payload) => {
          const row = payload.new as LiveProofViewRow
          // Client-side bot filter — matches the load-time
          // fetch's .eq('is_bot', false) condition so the live
          // path and the refresh path surface the same set of
          // rows. Server-side filter syntax doesn't mix well
          // with in.(...), so the bot drop happens here.
          if (row.is_bot) return
          onViewRef.current(row)
        },
      )
      .subscribe()

    return () => {
      void supabase.removeChannel(channel)
    }
    // versionKey is the stable identity for the filter; onView
    // lives in a ref. proofId alone isn't sufficient because two
    // proofs could theoretically share a proof_version_id if the
    // parent's version list is stale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proofId, versionKey])
}
