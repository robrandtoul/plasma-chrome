// Shared Help Scout client primitives. Extracted from per-function
// duplicates that had drifted in error message format and exception
// type across proof-action, send-helpscout-reply, lookup-helpscout-
// conversation, match-helpscout-conversation, and admin-test-helpscout.
//
// What lives here:
//   * HsError                       — single canonical exception type
//   * getAccessToken                — OAuth client_credentials flow against
//                                     HELPSCOUT_APP_ID + HELPSCOUT_APP_SECRET
//   * fetchConversation             — GET /v2/conversations/{id}, returns
//                                     null on 404, throws HsError otherwise
//   * fetchConversationOwnership    — convenience wrapper over fetchConversation
//                                     that returns { primaryCustomerId,
//                                     assigneeId } from a single GET. Use this
//                                     when a caller needs both ids for sender
//                                     resolution and customer attribution.
//   * postStaffReply                — POST /v2/conversations/{id}/reply with
//                                     optional `status` flip. Two callers:
//                                     send-helpscout-reply passes
//                                     status:'pending' (designer asking
//                                     customer for input); proof-action's
//                                     confirmation reply passes no status
//                                     (the conversation status doesn't
//                                     change on a system-generated
//                                     confirmation).
//   * fetchCustomer                 — GET /v2/customers/{id}, same null-on-404
//                                     shape
//
// What stays in callers (deliberately not extracted):
//   * POST /v2/conversations/{id}/customer  — proof-action only.
//   * POST /v2/conversations (create)       — contact-form-submit only;
//     no shared createConversation helper exists.
//   * Mailbox listing (/v2/mailboxes)       — match-helpscout-conversation,
//     admin-test-helpscout, and contact-form-submit each use it for
//     different purposes.
//   * Conversation search by email or number — single-caller utilities.
//
// The threads embed (?embed=threads) used to stay local to
// fetch-helpscout-conversation-context for single-caller reasons; send-nudges
// became the second caller (conversation status + recipient + newest-thread
// checks from one GET), so fetchConversationWithThreads now lives here as a
// separate function rather than a branching parameter on fetchConversation.

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
// is typed here so callers can navigate to it without a cast.
// fetchConversationOwnership below extracts the ids for sender
// resolution; fetchConversation itself returns the full block for
// callers that need first / last / email too.
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

// Convenience wrapper for the proof-action confirmation reply flow:
// fetch the conversation once and return only the two ids needed for
// sender resolution + customer attribution, dropping every other
// field. Returns null on 404 (same shape as fetchConversation), so a
// caller can skip the reply when the linked HS conversation has been
// deleted without separate try/catch.
//
// Each id is independently nullable:
//   * primaryCustomerId — null when the conversation has no primary
//     customer (rare; would need designer intervention in HS).
//     Callers writing to /v2/conversations/{id}/customer or /reply
//     should treat null as a hard skip.
//   * assigneeId        — null when the conversation isn't assigned
//     to a staff user in HS. Used as the second-tier sender fallback
//     after profiles.helpscout_user_id; null here means continue to
//     the third-tier (skip-and-warn) branch.
export async function fetchConversationOwnership(
  token: string,
  id: number | string,
): Promise<{ primaryCustomerId: number | null; assigneeId: number | null } | null> {
  const conv = await fetchConversation(token, id)
  if (!conv) return null
  return {
    primaryCustomerId: conv.primaryCustomer?.id ?? null,
    assigneeId: conv.assignee?.id ?? null,
  }
}

// A single thread from the ?embed=threads conversation shape. createdBy.type
// distinguishes staff ('user') from customer ('customer') authorship;
// createdAt orders the trail.
export interface HsThread {
  id: number
  type?: string
  body?: string
  createdAt?: string
  createdBy?: {
    id?: number
    type?: 'user' | 'customer' | string
    first?: string
    last?: string
    email?: string
  }
}

// fetchConversation's shape plus the embedded thread trail. Two callers:
// fetch-helpscout-conversation-context (the new-proof form's context
// preview) and send-nudges (status gate + recipient match + the
// newest-customer-thread belt-and-braces check, all from one GET).
export interface HsConversationWithThreads extends HsConversation {
  _embedded?: {
    threads?: HsThread[]
  }
}

// GET /v2/conversations/{id}?embed=threads. Same null-on-404 contract as
// fetchConversation.
export async function fetchConversationWithThreads(
  token: string,
  id: number | string,
): Promise<HsConversationWithThreads | null> {
  const resp = await fetch(`https://api.helpscout.net/v2/conversations/${id}?embed=threads`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  if (resp.status === 404) return null
  if (!resp.ok) {
    const text = await resp.text().catch(() => '<body read failed>')
    throw new HsError(resp.status, `Help Scout conversation fetch (${resp.status}): ${text}`)
  }
  return await resp.json() as HsConversationWithThreads
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

// POST /v2/conversations/{id}/reply.
//
// Help Scout's reply endpoint requires customer.id explicitly (a 400
// with `path:"customer", message:"must not be null"` is the symptom
// when missing). The earlier "omit and HS uses primaryCustomer by
// default" claim from the docs turned out to be false. Callers
// resolve customer.id via fetchConversationOwnership / fetchConversation
// before this call.
//
// Returns the new thread id parsed from the Location header
// (`/threads/{id}` at the end), or 0 if the header is missing or
// unparseable. The HS API responds 201 with no body on success.
//
// Two callers with slightly different status semantics:
//   * send-helpscout-reply  — passes status:'pending'. The designer
//     is asking the customer to review a proof, so the conversation
//     belongs in the customer's queue, not the team's.
//   * proof-action's confirmation reply — omits status. The reply is
//     a system-generated confirmation of the customer's just-recorded
//     action; the conversation status reflects whatever HS already
//     decided in response to the customer-thread post that fired
//     immediately before, which is correct as-is.
export async function postStaffReply(
  token: string,
  conversationId: string,
  body: {
    text: string
    userId: number
    customerId: number
    status?: 'pending'
  },
): Promise<number> {
  const requestBody: Record<string, unknown> = {
    text: body.text,
    user: body.userId,
    customer: { id: body.customerId },
    draft: false,
  }
  if (body.status) requestBody.status = body.status

  const resp = await fetch(
    `https://api.helpscout.net/v2/conversations/${conversationId}/reply`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(requestBody),
    },
  )
  if (resp.status === 404) {
    throw new HsError(404, 'Help Scout conversation not found')
  }
  if (!resp.ok) {
    const upstream = await resp.text().catch(() => '<body read failed>')
    throw new HsError(resp.status, `Help Scout reply error (${resp.status}): ${upstream}`)
  }
  // Both-header parser: prefer Resource-Id (the documented canonical
  // header for newly-created subresources), fall back to Location's
  // /threads/{id} suffix. /reply currently emits the new thread id in
  // Location, but /customer ships it in Resource-Id (per the
  // proof_viewer_helpscout_customer_endpoint memory note); writing
  // the both-header shape here matches the hardened parser already
  // in proof-action's hsPostCustomerThread and is defence in depth
  // against Help Scout swapping which header carries the id on the
  // /reply endpoint in a future API change.
  const resourceId = resp.headers.get('Resource-Id') ?? ''
  const directId = resourceId.match(/^\d+$/)?.[0]
  const location = resp.headers.get('Location') ?? ''
  const locationId = location.match(/\/threads\/(\d+)$/)?.[1]
  const threadIdRaw = directId ?? locationId
  const threadId = threadIdRaw ? Number(threadIdRaw) : NaN
  return Number.isFinite(threadId) ? threadId : 0
}

// PATCH /v2/conversations/{id}/threads/{threadId} — hide ("collapse") a
// thread. Help Scout's `hidden` state drops the thread from the
// customer-facing / published view and shows it collapsed in the agent
// view, while keeping it in the trail. Per the API docs the target
// "must be a non-draft customer or reply thread", so this is valid for
// the staff confirmation reply (a reply thread) but not for notes.
//
// Timing note for the proof-action confirmation flow: Help Scout sends
// the outbound email for a reply at reply-creation time, so hiding the
// thread *after* postStaffReply returns does NOT unsend the email the
// customer already received — it only tidies the designer's view of the
// conversation. Always create the reply first, then hide it.
//
// HS responds 204 No Content on success.
export async function hideThread(
  token: string,
  conversationId: string,
  threadId: number,
): Promise<void> {
  const resp = await fetch(
    `https://api.helpscout.net/v2/conversations/${conversationId}/threads/${threadId}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ op: 'replace', path: '/hidden', value: true }),
    },
  )
  if (!resp.ok) {
    const upstream = await resp.text().catch(() => '<body read failed>')
    throw new HsError(resp.status, `Help Scout hide-thread error (${resp.status}): ${upstream}`)
  }
}

// ── AI draft pipeline additions (Phase 2) ────────────────────────────────────

// Create a DRAFT reply: visible to the team in the conversation's reply
// editor, never emailed until a human sends it. Returns the new thread id
// from the Resource-ID header when Help Scout provides it.
export async function createDraftReply(
  token: string,
  conversationId: number | string,
  customerId: number,
  userId: number,
  text: string,
): Promise<string | null> {
  const resp = await fetch(`https://api.helpscout.net/v2/conversations/${conversationId}/reply`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ customer: { id: customerId }, user: userId, text, draft: true }),
  })
  if (!resp.ok) {
    const body = await resp.text().catch(() => '<body read failed>')
    throw new HsError(resp.status, `Help Scout draft create (${resp.status}): ${body}`)
  }
  return resp.headers.get('Resource-ID')
}

// Create an internal note (never customer-visible).
export async function createNote(
  token: string,
  conversationId: number | string,
  userId: number,
  text: string,
): Promise<string | null> {
  const resp = await fetch(`https://api.helpscout.net/v2/conversations/${conversationId}/notes`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ user: userId, text }),
  })
  if (!resp.ok) {
    const body = await resp.text().catch(() => '<body read failed>')
    throw new HsError(resp.status, `Help Scout note create (${resp.status}): ${body}`)
  }
  return resp.headers.get('Resource-ID')
}

// Add a tag, preserving existing tags (the PUT endpoint replaces the set).
export async function addConversationTag(
  token: string,
  conversationId: number | string,
  existingTags: string[],
  newTag: string,
): Promise<void> {
  if (existingTags.includes(newTag)) return
  const resp = await fetch(`https://api.helpscout.net/v2/conversations/${conversationId}/tags`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ tags: [...existingTags, newTag] }),
  })
  if (!resp.ok) {
    const body = await resp.text().catch(() => '<body read failed>')
    throw new HsError(resp.status, `Help Scout tag update (${resp.status}): ${body}`)
  }
}
