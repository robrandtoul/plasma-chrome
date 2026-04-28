// Cached access to the public_settings() RPC. The customer-facing proof
// page is the main caller; in-flight requests are de-duplicated and
// completed fetches are cached for 60s so a surge of page loads doesn't
// hammer the database.

import { supabase } from './supabase'

export interface PublicSettings {
  disclaimer_text: string
  company_name: string
  reply_email: string
  // Phase 2 customer approval flow modal copy. Editable in admin
  // (000116); falls back to the spec defaults below if the RPC ever
  // returns null/empty so the modal still renders readable text.
  approve_confirmation_copy: string
  request_changes_confirmation_copy: string
}

const TTL_MS = 60_000

let cache: { value: PublicSettings; fetchedAt: number } | null = null
let inFlight: Promise<PublicSettings> | null = null

const APPROVE_COPY_DEFAULT =
  "By approving, you're confirming that you've reviewed the proof and we're cleared to print as shown. Approval is final and triggers production scheduling."
const REQUEST_CHANGES_COPY_DEFAULT =
  "We'll update your proof based on your feedback. The team will reply within one working day."

const DEFAULTS: PublicSettings = {
  disclaimer_text: '',
  company_name: 'PlasmaDesign Ltd',
  reply_email: '',
  approve_confirmation_copy: APPROVE_COPY_DEFAULT,
  request_changes_confirmation_copy: REQUEST_CHANGES_COPY_DEFAULT,
}

export async function getPublicSettings(): Promise<PublicSettings> {
  if (cache && Date.now() - cache.fetchedAt < TTL_MS) return cache.value
  if (inFlight) return inFlight

  inFlight = (async () => {
    try {
      const { data } = await supabase.rpc('public_settings')
      const approveCopy = data?.approve_confirmation_copy
      const rcCopy = data?.request_changes_confirmation_copy
      const value: PublicSettings = {
        disclaimer_text: (data?.disclaimer_text as string) ?? DEFAULTS.disclaimer_text,
        company_name:    (data?.company_name as string)    ?? DEFAULTS.company_name,
        reply_email:     (data?.reply_email as string)     ?? DEFAULTS.reply_email,
        approve_confirmation_copy:
          typeof approveCopy === 'string' && approveCopy.trim().length > 0
            ? approveCopy
            : DEFAULTS.approve_confirmation_copy,
        request_changes_confirmation_copy:
          typeof rcCopy === 'string' && rcCopy.trim().length > 0
            ? rcCopy
            : DEFAULTS.request_changes_confirmation_copy,
      }
      cache = { value, fetchedAt: Date.now() }
      return value
    } catch {
      // Transport-level failure (network drop, edge runtime crash).
      // Cache the spec defaults so the page still renders readable
      // copy and subsequent calls within the TTL don't re-throw.
      cache = { value: DEFAULTS, fetchedAt: Date.now() }
      return DEFAULTS
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
