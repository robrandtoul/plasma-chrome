// Cached access to the public_settings() RPC. The customer-facing proof
// page is the main caller; in-flight requests are de-duplicated and
// completed fetches are cached for 60s so a surge of page loads doesn't
// hammer the database.

import { supabase } from './supabase'

export interface PublicSettings {
  disclaimer_text: string
  company_name: string
  reply_email: string
}

const TTL_MS = 60_000

let cache: { value: PublicSettings; fetchedAt: number } | null = null
let inFlight: Promise<PublicSettings> | null = null

const DEFAULTS: PublicSettings = {
  disclaimer_text: '',
  company_name: 'PlasmaDesign Ltd',
  reply_email: '',
}

export async function getPublicSettings(): Promise<PublicSettings> {
  if (cache && Date.now() - cache.fetchedAt < TTL_MS) return cache.value
  if (inFlight) return inFlight

  inFlight = (async () => {
    try {
      const { data } = await supabase.rpc('public_settings')
      const value: PublicSettings = {
        disclaimer_text: (data?.disclaimer_text as string) ?? DEFAULTS.disclaimer_text,
        company_name:    (data?.company_name as string)    ?? DEFAULTS.company_name,
        reply_email:     (data?.reply_email as string)     ?? DEFAULTS.reply_email,
      }
      cache = { value, fetchedAt: Date.now() }
      return value
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

/** Invalidate the cache — the admin settings page calls this after saves
 *  so a quick preview in another tab picks up the change faster than the
 *  60-second TTL. */
export function invalidatePublicSettings(): void {
  cache = null
}
