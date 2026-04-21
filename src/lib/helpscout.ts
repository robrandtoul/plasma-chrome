// Help Scout conversation URL shape. The match-helpscout-conversation
// edge function emits this exact format (see its index.ts); any
// manually-pasted URL must match before we accept it on a proof.
export const HELPSCOUT_URL_REGEX = /^https:\/\/secure\.helpscout\.net\/conversation\/(\d+)$/

/** If the URL matches the expected Help Scout shape, return the
 *  numeric conversation id + canonical URL. Returns null for anything
 *  else — caller decides how to surface the validation error. */
export function parseHelpscoutUrl(raw: string): { id: string; url: string } | null {
  const match = HELPSCOUT_URL_REGEX.exec(raw.trim())
  if (!match) return null
  return { id: match[1], url: match[0] }
}

// Minimum length of the "why isn't this linked to Help Scout?"
// override reason. Enforced client-side so we can iterate without a
// migration; the DB check constraint only enforces that *some* reason
// exists, not its length.
export const MIN_OVERRIDE_REASON_LENGTH = 10
