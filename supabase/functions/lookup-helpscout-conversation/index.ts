// Fetch a specific Help Scout conversation plus its primary customer's
// full contact details, so the new-proof form can auto-populate a
// whole record from a single URL or conversation-number paste.
//
// Expects Supabase auth; returns 401 if unauthenticated. Requires
// HELPSCOUT_APP_ID, HELPSCOUT_APP_SECRET secrets.
//
// POST body (exactly one of):
//   { conversationId: string }      -- the big numeric id (e.g. 3289110044)
//   { conversationNumber: string }  -- the short UI number (e.g. 420859)
//
// Response:
//   { id, number, url, subject, customer: { id, firstName, lastName, email, organization } }
//
// Shape decisions:
//   * Both lookup paths end up calling GET /v2/conversations/{id},
//     because the number path first resolves to an id via search.
//   * Customer organization is NOT embedded on the conversation's
//     primaryCustomer — we fetch GET /v2/customers/{id} to get it.
//   * If the conversation has no primaryCustomer, the response's
//     `customer` is null and the client surfaces a dedicated error.

import { createClient } from 'jsr:@supabase/supabase-js@2'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

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

// Resolve a short conversation number (the one in the HS UI) to the
// big numeric id the API uses. Returns null if no match or if the
// search returns an ambiguous result.
async function resolveNumberToId(token: string, conversationNumber: string): Promise<number | null> {
  const params = new URLSearchParams({
    query: `(number:${conversationNumber})`,
    status: 'all',
  })
  const url = `https://api.helpscout.net/v2/conversations?${params.toString()}`
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`Help Scout search error (${resp.status}): ${text}`)
  }
  const data = await resp.json()
  const convs = (data?._embedded?.conversations ?? []) as Array<{ id: number }>
  if (convs.length === 0) return null
  // Number can in theory collide across long timespans; pick the
  // first match. If multiple legitimately exist we'd need a newer
  // disambiguation UI, which we don't want to build here.
  return convs[0].id
}

interface HsConversation {
  id: number
  number: number
  subject?: string | null
  primaryCustomer?: {
    id: number
    first?: string | null
    last?: string | null
    email?: string | null
  } | null
}

async function fetchConversation(token: string, id: number): Promise<HsConversation | null> {
  const resp = await fetch(`https://api.helpscout.net/v2/conversations/${id}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  if (resp.status === 404) return null
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`Help Scout conversation fetch (${resp.status}): ${text}`)
  }
  return await resp.json() as HsConversation
}

interface HsCustomer {
  id: number
  firstName?: string | null
  lastName?: string | null
  organization?: string | null
  createdAt?: string | null
  emails?: Array<{ value: string; type?: string }>
}

async function fetchCustomer(token: string, id: number): Promise<HsCustomer | null> {
  const resp = await fetch(`https://api.helpscout.net/v2/customers/${id}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  if (resp.status === 404) return null
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`Help Scout customer fetch (${resp.status}): ${text}`)
  }
  return await resp.json() as HsCustomer
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  // Authenticate the caller via their Supabase JWT.
  const authHeader = req.headers.get('Authorization') ?? ''
  if (!authHeader.toLowerCase().startsWith('bearer ')) {
    return json({ error: 'Unauthorized', reason: 'missing_bearer' }, 401)
  }
  const jwt = authHeader.replace(/^[Bb]earer\s+/, '').trim()

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
  )
  const { data: userData, error: userError } = await supabase.auth.getUser(jwt)
  if (userError || !userData?.user) {
    return json({ error: 'Unauthorized', reason: 'invalid_token', detail: userError?.message }, 401)
  }

  let conversationId: string | undefined
  let conversationNumber: string | undefined
  try {
    const body = await req.json()
    conversationId     = typeof body?.conversationId === 'string' ? body.conversationId.trim() : undefined
    conversationNumber = typeof body?.conversationNumber === 'string' ? body.conversationNumber.trim() : undefined
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }
  if (!conversationId && !conversationNumber) {
    return json({ error: 'Provide either conversationId or conversationNumber' }, 400)
  }

  const appId = Deno.env.get('HELPSCOUT_APP_ID')
  const appSecret = Deno.env.get('HELPSCOUT_APP_SECRET')
  if (!appId || !appSecret) {
    return json({ error: 'Help Scout credentials not configured' }, 500)
  }

  try {
    const token = await getAccessToken(appId, appSecret)

    // Resolve to a big-id if given a short number.
    let id: number | null = null
    if (conversationId) {
      const parsed = parseInt(conversationId, 10)
      if (!Number.isFinite(parsed)) {
        return json({ error: 'conversationId is not a valid numeric id' }, 400)
      }
      id = parsed
    } else if (conversationNumber) {
      id = await resolveNumberToId(token, conversationNumber)
      if (id == null) {
        return json({ error: `No Help Scout conversation found with number ${conversationNumber}.` }, 404)
      }
    }

    const conversation = await fetchConversation(token, id!)
    if (!conversation) {
      return json({ error: `Help Scout conversation ${id} not found.` }, 404)
    }

    let customer: HsCustomer | null = null
    if (conversation.primaryCustomer?.id) {
      customer = await fetchCustomer(token, conversation.primaryCustomer.id)
    }

    return json({
      id: conversation.id,
      number: conversation.number,
      url: `https://secure.helpscout.net/conversation/${conversation.id}`,
      subject: conversation.subject ?? null,
      customer: conversation.primaryCustomer ? {
        id: conversation.primaryCustomer.id,
        firstName: customer?.firstName ?? conversation.primaryCustomer.first ?? '',
        lastName:  customer?.lastName  ?? conversation.primaryCustomer.last  ?? '',
        email:     customer?.emails?.[0]?.value ?? conversation.primaryCustomer.email ?? '',
        organization: customer?.organization ?? null,
        // ISO timestamp from Help Scout's customer resource. Used by
        // the new-proof form to render a "Customer since YYYY"
        // subtitle under the staged company. Null when HS returns
        // no createdAt (rare but possible on legacy records).
        createdAt: customer?.createdAt ?? null,
      } : null,
    })
  } catch (err) {
    console.error('lookup-helpscout-conversation error:', err)
    return json({ error: (err as Error).message ?? 'Unknown error' }, 502)
  }
})
