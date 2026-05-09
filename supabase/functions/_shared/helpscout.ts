// Shared Help Scout client primitives. Extracted from per-function
// duplicates that had drifted in error message format and exception
// type across proof-action, send-helpscout-reply, lookup-helpscout-
// conversation, match-helpscout-conversation, and admin-test-helpscout.
//
// What lives here:
//   * HsError                — single canonical exception type
//   * getAccessToken         — OAuth client_credentials flow against
//                              HELPSCOUT_APP_ID + HELPSCOUT_APP_SECRET
//   * fetchConversation      — GET /v2/conversations/{id}, returns
//                              null on 404, throws HsError otherwise
//   * fetchCustomer          — GET /v2/customers/{id}, same null-on-404
//                              shape
//
// What stays in callers (deliberately not extracted):
//   * POST /v2/conversations/{id}/customer  — proof-action only, will
//     gain a sibling caller in commit 5 of the proof-action confirmation
//     work; revisit extraction at that point.
//   * POST /v2/conversations/{id}/reply     — send-helpscout-reply only.
//   * Mailbox listing (/v2/mailboxes)       — match-helpscout-conversation
//     and admin-test-helpscout each use it for different purposes.
//   * Conversation search by email or number — single-caller utilities.
//   * Threads embed (?embed=threads)        — fetch-helpscout-conversation-
//     context's richer shape; pulling it in would force a branching
//     parameter on this module's fetchConversation. Stays local.

// Single canonical error type. Every shared helper throws this on any
// non-success path so callers can branch on `err instanceof HsError`
// and read `err.status` to categorise. The previous per-function
// HsError classes (proof-action used `hsStatus`, send-helpscout-reply
// used `status`) are replaced by this one; both callers' catch blocks
// were already reading the property so swapping types is invisible at
// the boundary.
export class HsError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'HsError'
  }
}

// OAuth client-credentials flow. Returns a bearer token string the
// other helpers (and the per-caller POST helpers in proof-action /
// send-helpscout-reply) use as Authorization.
//
// Failure modes encoded as HsError so callers can categorise without
// regex on the message:
//   * Non-2xx response          → HsError(resp.status, 'Help Scout
//                                  token error (...): ...')
//   * 200 with no access_token  → HsError(500, 'Help Scout token
//                                  response missing access_token')
export async function getAccessToken(appId: string, appSecret: string): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: appId,
    client_secret: appSecret,
  })
  const resp = await fetch('https://api.helpscout.net/v2/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '<body read failed>')
    throw new HsError(resp.status, `Help Scout token error (${resp.status}): ${text}`)
  }
  const data = await resp.json().catch(() => null)
  const token = (data as { access_token?: string } | null)?.access_token
  if (!token || typeof token !== 'string') {
    throw new HsError(500, 'Help Scout token response missing access_token')
  }
  return token
}

// Subset of the Help Scout conversation resource the project currently
// reads. Wider than what proof-action / send-helpscout-reply use today
// so the shape is honest about what the API actually returns; their
// existing call sites only read primaryCustomer.id and ignore the
// rest. lookup-helpscout-conversation reads first / last / email off
// primaryCustomer to populate the new-proof form. The assignee block
// is typed here so callers can navigate to it without a cast — but
// no helper extracts assignee.id yet (that lands in commit 4 of the
// proof-action confirmation work).
export interface HsConversation {
  id: number
  number: number
  subject?: string | null
  status?: string | null
  mailboxId?: number | null
  primaryCustomer?: {
    id: number
    first?: string | null
    last?: string | null
    email?: string | null
  } | null
  assignee?: {
    id: number
    first?: string | null
    last?: string | null
    email?: string | null
  } | null
}

// GET /v2/conversations/{id}. Returns null on 404 so callers can
// distinguish "the linked conversation has been deleted" from a
// transport / auth error without try-catching for a status code.
// Other non-2xx responses throw HsError carrying the upstream status.
export async function fetchConversation(
  token: string,
  id: number | string,
): Promise<HsConversation | null> {
  const resp = await fetch(`https://api.helpscout.net/v2/conversations/${id}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  if (resp.status === 404) return null
  if (!resp.ok) {
    const text = await resp.text().catch(() => '<body read failed>')
    throw new HsError(resp.status, `Help Scout conversation fetch (${resp.status}): ${text}`)
  }
  return await resp.json() as HsConversation
}

// Subset of the Help Scout customer resource the project currently
// reads. Used by lookup-helpscout-conversation to populate the new-
// proof form's company / customer fields from a single paste of a
// conversation URL or number.
export interface HsCustomer {
  id: number
  firstName?: string | null
  lastName?: string | null
  organization?: string | null
  createdAt?: string | null
  emails?: Array<{ value: string; type?: string }>
}

// GET /v2/customers/{id}. Same null-on-404 shape as fetchConversation.
export async function fetchCustomer(
  token: string,
  id: number | string,
): Promise<HsCustomer | null> {
  const resp = await fetch(`https://api.helpscout.net/v2/customers/${id}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  if (resp.status === 404) return null
  if (!resp.ok) {
    const text = await resp.text().catch(() => '<body read failed>')
    throw new HsError(resp.status, `Help Scout customer fetch (${resp.status}): ${text}`)
  }
  return await resp.json() as HsCustomer
}
