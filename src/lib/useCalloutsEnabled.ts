// Is the designer-notes surface switched on? (settings.proof_callouts_enabled,
// migration 000347.)
//
// A hook rather than a copy-pasted query because more than one surface offers
// note authoring — the post-save preview gate, which is where the flow actually
// wants it, and the proof page for adding one later or ticking off customer
// pins. Two hand-rolled reads would drift.
//
// Always starts false and stays false on any error: an ungated authoring button
// on a customer-visible feature is the wrong way to fail.

import { useEffect, useState } from 'react'
import { supabase } from './supabase'

let cached: boolean | null = null

export function useCalloutsEnabled(): boolean {
  const [enabled, setEnabled] = useState(cached ?? false)

  useEffect(() => {
    if (cached !== null) {
      setEnabled(cached)
      return
    }
    let cancelled = false
    void supabase
      .from('settings')
      .select('proof_callouts_enabled')
      .eq('id', 1)
      .single()
      .then(({ data, error }) => {
        if (error) {
          console.warn('[annotations] could not read the callout gate', error)
          return
        }
        cached = data?.proof_callouts_enabled === true
        if (!cancelled) setEnabled(cached)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return enabled
}

/** Drop the cache — for an admin toggling the gate without a reload. */
export function clearCalloutsEnabledCache() {
  cached = null
}
