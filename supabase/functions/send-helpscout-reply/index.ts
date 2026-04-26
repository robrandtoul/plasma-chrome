// Post a reply to a Help Scout conversation on behalf of a designer.
// Ship 2 of intervention 3.
//
// Auth: requireDesigner (admin or designer role, active account).
// The conversation_id is read off the proofs row server-side so a
// tampered proof_id cannot be weaponised to post into arbitrary
// Help Scout threads. Defence in depth: the designer is gated by
// role, AND the conversation is sourced from the linked proof.
//
// Required secrets:
//   HELPSCOUT_APP_ID, HELPSCOUT_APP_SECRET — OAuth client credentials.
//   HELPSCOUT_DEFAULT_USER_ID — numeric Help Scout staff user id used
//   as the `user` field on the reply. Required because Help Scout's
//   reply endpoint demands a real staff user; today there is no per-
//   designer mapping. Future ships can add per-designer attribution
//   by extending profiles with helpscout_user_id and falling back to
//   this default when null.
//
// POST body:
//   { proof_id: string, body: string }
//
// Response (200):
//   { thread_id: number }
//
// Response (4xx/5xx):
//   { error: string, ...optional debug fields }
//
// ── Diagnostics ──────────────────────────────────────────────────────────────
//
// Every meaningful step logs a one-line breadcrumb via console.log so
// the Supabase function-runtime log viewer shows where a request got
// to. The outer try/catch serialises err.name + err.message + a stack
// snippet into the JSON body; if the Supabase platform converts a
// thrown response into EDGE_FUNCTION_ERROR before our handler can
// return, the breadcrumbs in the runtime log are the only signal.
// Keep this verbose until the send pipeline is proven stable.

import { requireDesigner } from '../_shared/admin.ts'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const MAX_BODY_BYTES = 10 * 1024  // 10KB sanity cap; rare to hit.

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

function debugFromError(err: unknown): { name: string; message: string; stack: string } {
  const e = err as Error
  return {
    name: e?.name ?? 'Error',
    message: e?.message ?? String(err),
    stack: (e?.stack ?? '').split('\n').slice(0, 6).join('\n'),
  }
}

class HsError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'HsError'
  }
}

async function getAccessToken(appId: string, appSecret: string): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: appId,
    client_secret: appSecret,
  })
  console.log('[send-helpscout-reply] requesting access token')
  const resp = await fetch('https://api.helpscout.net/v2/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '<body read failed>')
    throw new HsError(resp.status, `Help Scout token error (${resp.status}): ${text}`)
  }
  const data = await resp.json()
  if (!data.access_token) {
    throw new HsError(500, 'Help Scout token response missing access_token')
  }
  console.log('[send-helpscout-reply] got access token')
  return data.access_token as string
}

interface SendReplyResult {
  thread_id: number
}

// Help Scout's reply endpoint requires customer.id explicitly,
// despite earlier docs suggesting it falls back to primaryCustomer
// when omitted. A 400 with `path: "customer", message: "must not be
// null"` is the symptom when missing. Resolve the conversation's
// primary customer id with a quick GET first, then include it in
// the reply body. Throws HsError when the conversation is missing
// (404), the GET fails for any other reason (passes status), or
// the conversation has no primary customer to attribute the reply
// to (502 — unusual; would need designer intervention in HS).
async function fetchPrimaryCustomerId(
  token: string,
  conversationId: string,
): Promise<number> {
  console.log('[send-helpscout-reply] GET conversation for primary customer')
  const resp = await fetch(
    `https://api.helpscout.net/v2/conversations/${conversationId}`,
    {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    },
  )
  if (resp.status === 404) {
    throw new HsError(404, 'Help Scout conversation not found')
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => '<body read failed>')
    throw new HsError(resp.status, `Help Scout conversation fetch error (${resp.status}): ${text}`)
  }
  const data = await resp.json().catch(() => null)
  const customerId = (data as { primaryCustomer?: { id?: number } } | null)?.primaryCustomer?.id
  if (!customerId || typeof customerId !== 'number') {
    throw new HsError(
      502,
      'Help Scout conversation has no primary customer; cannot attribute reply.',
    )
  }
  console.log('[send-helpscout-reply] fetched primary customer', { id: customerId })
  return customerId
}

// Help Scout's reply endpoint returns 201 Created with no body and a
// Location header pointing at the new thread:
//   Location: https://api.helpscout.net/v2/conversations/{conv}/threads/{thread}
// Parse the trailing thread id off the Location header so the caller
// can store provenance.
async function postReply(
  token: string,
  conversationId: string,
  text: string,
  userId: number,
  customerId: number,
): Promise<SendReplyResult> {
  const requestBody = JSON.stringify({
    text,
    user: userId,
    // customer.id is required by Help Scout's reply endpoint; the
    // earlier "omit and HS uses primaryCustomer by default" claim
    // turned out to be false (HS returns 400 with path:"customer",
    // message:"must not be null"). fetchPrimaryCustomerId resolves
    // it from a quick GET before this call.
    customer: { id: customerId },
    draft: false,
  })
  console.log('[send-helpscout-reply] POST reply', { conversationId, userId, bodyLen: text.length })
  const resp = await fetch(
    `https://api.helpscout.net/v2/conversations/${conversationId}/reply`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: requestBody,
    },
  )
  console.log('[send-helpscout-reply] HS responded', { status: resp.status, ok: resp.ok })
  if (resp.status === 404) {
    throw new HsError(404, 'Help Scout conversation not found')
  }
  if (!resp.ok) {
    const upstream = await resp.text().catch(() => '<body read failed>')
    throw new HsError(resp.status, `Help Scout reply error (${resp.status}): ${upstream}`)
  }
  // Parse thread id from Location header.
  const location = resp.headers.get('Location') ?? ''
  const match = location.match(/\/threads\/(\d+)$/)
  const threadId = match ? Number(match[1]) : NaN
  console.log('[send-helpscout-reply] parsed thread id', { location, threadId })
  if (!Number.isFinite(threadId)) {
    return { thread_id: 0 }
  }
  return { thread_id: threadId }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  // Wrap the entire handler so any uncaught throw inside requireDesigner
  // or the supabase client surfaces as a structured 502 with
  // diagnostics, instead of EDGE_FUNCTION_ERROR with no body.
  try {
    console.log('[send-helpscout-reply] start')

    const check = await requireDesigner(req)
    if (check instanceof Response) return check
    const { admin } = check
    console.log('[send-helpscout-reply] auth ok')

    // Parse + validate body.
    let proofId: string | undefined
    let body: string | undefined
    try {
      const parsed = await req.json()
      proofId = typeof parsed?.proof_id === 'string' ? parsed.proof_id.trim() : undefined
      body = typeof parsed?.body === 'string' ? parsed.body : undefined
    } catch (parseErr) {
      console.error('[send-helpscout-reply] body parse failed', parseErr)
      return json({ error: 'Invalid JSON body', debug: debugFromError(parseErr) }, 400)
    }
    if (!proofId) return json({ error: 'proof_id is required' }, 400)
    if (body == null || body.trim() === '') {
      return json({ error: 'body is required' }, 400)
    }
    if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
      return json({ error: `Reply too long (${MAX_BODY_BYTES} byte cap). Trim and try again.` }, 400)
    }
    console.log('[send-helpscout-reply] body validated', { proofId, bodyLen: body.length })

    // Look up the proof's HS conversation id server-side. Service-role
    // client bypasses RLS so we can read the column directly.
    const { data: proofRow, error: proofErr } = await admin
      .from('proofs')
      .select('id, helpscout_conversation_id')
      .eq('id', proofId)
      .maybeSingle()
    if (proofErr) {
      console.error('[send-helpscout-reply] proof lookup error', proofErr)
      return json({ error: `Proof lookup failed: ${proofErr.message}` }, 500)
    }
    if (!proofRow) return json({ error: 'Proof not found' }, 404)
    const conversationId = (proofRow as { helpscout_conversation_id: string | null }).helpscout_conversation_id
    if (!conversationId) {
      return json({ error: 'No Help Scout conversation linked to this proof' }, 400)
    }
    console.log('[send-helpscout-reply] conversation linked', { conversationId })

    // Help Scout credentials + sender identity. Trim defensively in
    // case a secret was set with surrounding whitespace.
    const appId = Deno.env.get('HELPSCOUT_APP_ID')?.trim()
    const appSecret = Deno.env.get('HELPSCOUT_APP_SECRET')?.trim()
    const defaultUserId = Deno.env.get('HELPSCOUT_DEFAULT_USER_ID')?.trim()
    if (!appId || !appSecret) {
      return json({ error: 'Help Scout credentials not configured' }, 500)
    }
    if (!defaultUserId) {
      return json(
        { error: 'HELPSCOUT_DEFAULT_USER_ID secret is not set. An admin must configure a default Help Scout user before replies can be sent.' },
        500,
      )
    }
    const userIdNum = Number(defaultUserId)
    if (!Number.isFinite(userIdNum) || !Number.isInteger(userIdNum)) {
      return json({ error: `HELPSCOUT_DEFAULT_USER_ID must be a numeric Help Scout user id (got ${JSON.stringify(defaultUserId)}).` }, 500)
    }
    console.log('[send-helpscout-reply] secrets ok', { userIdNum })

    // The HS API call path. Errors surface as HsError (from
    // getAccessToken, fetchPrimaryCustomerId, or postReply); other
    // throws fall through to the outer catch.
    let result: SendReplyResult
    try {
      const token = await getAccessToken(appId, appSecret)
      const customerId = await fetchPrimaryCustomerId(token, conversationId)
      result = await postReply(token, conversationId, body, userIdNum, customerId)
    } catch (hsErr) {
      if (hsErr instanceof HsError) {
        const upstream = hsErr.status === 404 ? 404 : 502
        console.error('[send-helpscout-reply] HS error', { status: hsErr.status, message: hsErr.message })
        return json({ error: hsErr.message }, upstream)
      }
      console.error('[send-helpscout-reply] HS unexpected error', hsErr)
      return json(
        {
          error: `Help Scout call failed: ${(hsErr as Error)?.message ?? 'unknown'}`,
          debug: debugFromError(hsErr),
        },
        502,
      )
    }

    console.log('[send-helpscout-reply] success', result)
    return json(result)
  } catch (outerErr) {
    console.error('[send-helpscout-reply] uncaught error', outerErr)
    return json(
      {
        error: `Server error: ${(outerErr as Error)?.message ?? 'unknown'}`,
        debug: debugFromError(outerErr),
      },
      500,
    )
  }
})
