// Help Scout conversation URL shape.
//
// The match-helpscout-conversation edge function emits the canonical
// single-segment form (…/conversation/<id>), but that is NOT what the
// Help Scout web app puts in the address bar. Open a conversation there
// and you get TWO segments:
//
//   https://secure.helpscout.net/conversation/3396475852/430667
//                                             ^^^^^^^^^^ ^^^^^^
//                                             id         number
//
// The first is the API conversation id (always ~10 digits — all 370
// linked proofs on live carry a 10-digit id); the second is the short
// human-readable conversation number shown in the HS UI. The address
// bar may also carry a trailing slash, a ?query, or a #fragment.
//
// Anchoring on the first segment alone rejected every address-bar
// paste, which is what a designer actually copies. That was invisible
// on the new-proof form — its own "Start from Help Scout" parser
// (parsePasteInput in NewProofPage) is unanchored and has always
// accepted the two-segment shape — so only the Change-conversation
// modal failed, and only for URLs copied the obvious way.
//
// The captured id is always the FIRST segment, so a two-segment paste
// can never store the short number by mistake, and the returned
// canonical URL is always the single-segment form regardless of what
// was pasted (PV-2026W20-002 added the trailing slash; this widens it
// to the full address-bar shape).
export const HELPSCOUT_URL_REGEX =
  /^https:\/\/secure\.helpscout\.net\/conversation\/(\d+)(?:\/\d+)?\/?(?:[?#].*)?$/

/** If the URL matches the expected Help Scout shape, return the
 *  numeric conversation id + canonical URL. Returns null for anything
 *  else — caller decides how to surface the validation error. */
export function parseHelpscoutUrl(raw: string): { id: string; url: string } | null {
  const match = HELPSCOUT_URL_REGEX.exec(raw.trim())
  if (!match) return null
  const id = match[1]
  return { id, url: `https://secure.helpscout.net/conversation/${id}` }
}

// Minimum length of the "why isn't this linked to Help Scout?"
// override reason. Enforced client-side so we can iterate without a
// migration; the DB check constraint only enforces that *some* reason
// exists, not its length.
export const MIN_OVERRIDE_REASON_LENGTH = 10
