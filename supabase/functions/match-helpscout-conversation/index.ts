// Match a customer's email to active Help Scout conversations so the
// designer can auto-link (or pick from) a thread when creating a new
// project in the proof viewer.
//
// Expects Supabase auth; returns 401 if unauthenticated. Requires these
// secrets set on the project: HELPSCOUT_APP_ID, HELPSCOUT_APP_SECRET.
//
// POST body: { email: string }
// Response: { matches: Array<{ id, subject, status, modifiedAt, url }> }

import { createClient } from 'jsr:@supabase/supabase-js@2'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

interface HelpScoutConversation {
  id: number
  subject?: string | null
  status?: string | null
  modifiedAt?: string | null
}

interface Match {
  id: number
  subject: string | null
  status: string | null
  modifiedAt: string | null
  url: string
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

async function fetchConversations(token: string, email: string): Promise<HelpScoutConversation[]> {
  // Help Scout v2's /conversations endpoint ignores a bare `email=` param.
  // Use the documented mailbox query DSL instead — double-quote the email
  // and escape internal quotes defensively. Then filter to active+pending
  // client-side (the `status` param only accepts a single value).
  const safeEmail = email.replace(/"/g, '\\"')
  const params = new URLSearchParams({
    query: `(email:"${safeEmail}")`,
    sortField: 'modifiedAt',
    sortOrder: 'desc',
  })
  const url = `https://api.helpscout.net/v2/conversations?${params.toString()}`
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`Help Scout conversations error (${resp.status}): ${text}`)
  }
  const data = await resp.json()
  const all = (data?._embedded?.conversations ?? []) as HelpScoutConversation[]
  return all.filter((c) => c.status === 'active' || c.status === 'pending')
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  // Authenticate the caller via their Supabase JWT. We pass the token
  // explicitly to getUser() so we validate the caller's token rather
  // than any session the client may have cached.
  const authHeader = req.headers.get('Authorization') ?? ''
  console.log('auth header present:', authHeader ? authHeader.slice(0, 12) + '…' : '(none)')
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
    console.log('getUser failed:', userError?.message, 'userData:', JSON.stringify(userData))
    return json({ error: 'Unauthorized', reason: 'invalid_token', detail: userError?.message }, 401)
  }

  // Parse input.
  let email = ''
  try {
    const body = await req.json()
    email = typeof body?.email === 'string' ? body.email.trim() : ''
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }
  if (!email) return json({ error: 'email is required' }, 400)

  // Help Scout credentials.
  const appId = Deno.env.get('HELPSCOUT_APP_ID')
  const appSecret = Deno.env.get('HELPSCOUT_APP_SECRET')
  if (!appId || !appSecret) {
    return json({ error: 'Help Scout credentials not configured' }, 500)
  }

  try {
    const token = await getAccessToken(appId, appSecret)
    const conversations = await fetchConversations(token, email)
    const matches: Match[] = conversations.map((c) => ({
      id: c.id,
      subject: c.subject ?? null,
      status: c.status ?? null,
      modifiedAt: c.modifiedAt ?? null,
      url: `https://secure.helpscout.net/conversation/${c.id}`,
    }))
    return json({ matches })
  } catch (err) {
    console.error('match-helpscout-conversation error:', err)
    return json({ error: (err as Error).message ?? 'Unknown error' }, 502)
  }
})
