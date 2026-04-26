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
//   { error: string }

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

async function getAccessToken(appId: string, appSecret: string): Promise<string> {
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
    const text = await resp.text()
    throw new Error(`Help Scout token error (${resp.status}): ${text}`)
  }
  const data = await resp.json()
  if (!data.access_token) throw new Error('Help Scout token response missing access_token')
  return data.access_token as string
}

interface SendReplyResult {
  thread_id: number
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
): Promise<SendReplyResult> {
  const resp = await fetch(
    `https://api.helpscout.net/v2/conversations/${conversationId}/reply`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        text,
        user: userId,
        // customer omitted: Help Scout uses the conversation's
        // primaryCustomer by default, which is what we want.
        draft: false,
      }),
    },
  )
  if (resp.status === 404) {
    throw new HsError(404, 'Help Scout conversation not found')
  }
  if (!resp.ok) {
    const text = await resp.text()
    throw new HsError(resp.status, `Help Scout reply error (${resp.status}): ${text}`)
  }
  // Parse thread id from Location header.
  const location = resp.headers.get('Location') ?? ''
  const match = location.match(/\/threads\/(\d+)$/)
  const threadId = match ? Number(match[1]) : NaN
  if (!Number.isFinite(threadId)) {
    // Reply succeeded but we could not extract the thread id. Not
    // fatal; the caller's audit log can still record a successful
    // send. Return 0 as a sentinel.
    return { thread_id: 0 }
  }
  return { thread_id: threadId }
}

class HsError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const check = await requireDesigner(req)
  if (check instanceof Response) return check
  const { admin } = check

  // Parse + validate body.
  let proofId: string | undefined
  let body: string | undefined
  try {
    const parsed = await req.json()
    proofId = typeof parsed?.proof_id === 'string' ? parsed.proof_id.trim() : undefined
    body = typeof parsed?.body === 'string' ? parsed.body : undefined
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }
  if (!proofId) return json({ error: 'proof_id is required' }, 400)
  if (body == null || body.trim() === '') {
    return json({ error: 'body is required' }, 400)
  }
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
    return json({ error: `Reply too long (${MAX_BODY_BYTES} byte cap). Trim and try again.` }, 400)
  }

  // Look up the proof's HS conversation id server-side. Service-role
  // client bypasses RLS so we can read the column directly.
  const { data: proofRow, error: proofErr } = await admin
    .from('proofs')
    .select('id, helpscout_conversation_id')
    .eq('id', proofId)
    .maybeSingle()
  if (proofErr) return json({ error: `Proof lookup failed: ${proofErr.message}` }, 500)
  if (!proofRow) return json({ error: 'Proof not found' }, 404)
  const conversationId = (proofRow as { helpscout_conversation_id: string | null }).helpscout_conversation_id
  if (!conversationId) {
    return json({ error: 'No Help Scout conversation linked to this proof' }, 400)
  }

  // Help Scout credentials + sender identity.
  const appId = Deno.env.get('HELPSCOUT_APP_ID')
  const appSecret = Deno.env.get('HELPSCOUT_APP_SECRET')
  const defaultUserId = Deno.env.get('HELPSCOUT_DEFAULT_USER_ID')
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
  if (!Number.isFinite(userIdNum)) {
    return json({ error: 'HELPSCOUT_DEFAULT_USER_ID must be a numeric Help Scout user id.' }, 500)
  }

  try {
    const token = await getAccessToken(appId, appSecret)
    const result = await postReply(token, conversationId, body, userIdNum)
    return json(result)
  } catch (err) {
    if (err instanceof HsError) {
      const upstream = err.status === 404 ? 404 : 502
      return json({ error: err.message }, upstream)
    }
    console.error('send-helpscout-reply error:', err)
    return json({ error: (err as Error).message ?? 'Unknown error' }, 502)
  }
})
