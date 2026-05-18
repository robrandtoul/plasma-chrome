// Match a customer's email to active Help Scout conversations so the
// designer can auto-link (or pick from) a thread when creating a new
// project in the proof viewer.
//
// Designer or admin only — uses the requireDesigner helper from
// _shared/admin.ts which validates the JWT, checks profiles.role
// is in ('admin', 'designer'), and rejects deactivated accounts.
// Closes audit finding H3.
// Requires these secrets: HELPSCOUT_APP_ID, HELPSCOUT_APP_SECRET.
//
// POST body: { email: string }
// Response: { matches: Array<{ id, subject, status, modifiedAt, url }> }

import { requireDesigner } from '../_shared/admin.ts'
import { getAccessToken, HsError } from '../_shared/helpscout.ts'

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
  mailboxId?: number | null
}

interface Match {
  id: number
  subject: string | null
  status: string | null
  modifiedAt: string | null
  url: string
  mailboxId: number | null
  mailboxName: string | null
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

async function fetchMailboxes(token: string): Promise<Map<number, string>> {
  const resp = await fetch('https://api.helpscout.net/v2/mailboxes', {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  if (!resp.ok) return new Map()
  const data = await resp.json()
  const boxes = (data?._embedded?.mailboxes ?? []) as Array<{ id: number; name: string }>
  return new Map(boxes.map((b) => [b.id, b.name]))
}

async function searchByEmailAndStatus(
  token: string,
  email: string,
  status: 'active' | 'pending',
): Promise<HelpScoutConversation[]> {
  const safeEmail = email.replace(/"/g, '\\"')
  const params = new URLSearchParams({
    query: `(email:"${safeEmail}")`,
    status,
    sortField: 'modifiedAt',
    sortOrder: 'desc',
  })
  const url = `https://api.helpscout.net/v2/conversations?${params.toString()}`
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  if (!resp.ok) {
    const text = await resp.text()
    throw new HsError(resp.status, `Help Scout conversations error (${resp.status}) status=${status}: ${text}`)
  }
  const data = await resp.json()
  return (data?._embedded?.conversations ?? []) as HelpScoutConversation[]
}

async function fetchConversations(token: string, email: string): Promise<HelpScoutConversation[]> {
  // Help Scout's /conversations search DSL appears to implicitly filter to
  // `status=active` when no status is given, which misses pending threads.
  // Run two explicit status-scoped searches and combine the results.
  const [active, pending] = await Promise.all([
    searchByEmailAndStatus(token, email, 'active'),
    searchByEmailAndStatus(token, email, 'pending'),
  ])
  console.log(
    `Help Scout search for ${email}: active=${active.length}, pending=${pending.length}`,
    { active: active.map((c) => ({ id: c.id, subject: c.subject })),
      pending: pending.map((c) => ({ id: c.id, subject: c.subject })) },
  )
  const byId = new Map<number, HelpScoutConversation>()
  for (const c of [...active, ...pending]) if (!byId.has(c.id)) byId.set(c.id, c)
  const combined = [...byId.values()]
  combined.sort((a, b) => (b.modifiedAt ?? '').localeCompare(a.modifiedAt ?? ''))
  return combined
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  // Designer or admin role required — closes audit finding H3.
  // Pre-shipment, this endpoint accepted any authenticated user;
  // a non-staff role would have been able to consume the
  // project's Help Scout API quota and enumerate customer data.
  const check = await requireDesigner(req)
  if (check instanceof Response) return check

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
    const [conversations, mailboxMap] = await Promise.all([
      fetchConversations(token, email),
      fetchMailboxes(token),
    ])
    const matches: Match[] = conversations.map((c) => ({
      id: c.id,
      subject: c.subject ?? null,
      status: c.status ?? null,
      modifiedAt: c.modifiedAt ?? null,
      url: `https://secure.helpscout.net/conversation/${c.id}`,
      mailboxId: c.mailboxId ?? null,
      mailboxName: c.mailboxId != null ? (mailboxMap.get(c.mailboxId) ?? null) : null,
    }))
    return json({ matches })
  } catch (err) {
    if (err instanceof HsError) {
      console.error('match-helpscout-conversation: HsError', err.status, err.message)
      return json({ error: err.message }, err.status >= 400 && err.status < 600 ? err.status : 502)
    }
    console.error('match-helpscout-conversation: unexpected error', err)
    return json({ error: (err as Error).message ?? 'Unknown error' }, 502)
  }
})
