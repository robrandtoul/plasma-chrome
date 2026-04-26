// Fetch the Help Scout conversation linked to a proof and return its
// recent thread history in a frontend-friendly shape. Powers the
// "customer's last message" and "your last reply" panel on the
// designer message editor (Ship 2 of intervention 3).
//
// Auth: requireDesigner (admin or designer role, active account).
//
// POST body:
//   { proof_id: string }
//
// Response (200):
//   {
//     conversation_id: number,
//     url: string,
//     threads: Array<{
//       id: number,
//       type: string,                 // 'customer' | 'reply' | 'note' | ...
//       authorName: string,
//       authorType: 'customer' | 'user' | 'unknown',
//       bodyText: string,             // HTML stripped to plain text
//       createdAt: string,            // ISO timestamp
//     }>
//   }
//
// HTML is stripped to plain text via a simple tag-removal regex
// rather than a full sanitiser. Works for Ship 2's read-only
// preview (no rich rendering, no link clicks). Open the original
// in Help Scout for the full HTML view if needed.
//
// Response (404):
//   { error: 'Proof not found' } | { error: 'No Help Scout conversation linked to this proof' }
//
// Response (502):
//   { error: 'Help Scout fetch failed: ...' }

import { requireDesigner } from '../_shared/admin.ts'

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

interface HsThread {
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

interface HsConversationWithThreads {
  id: number
  number?: number
  subject?: string | null
  _embedded?: {
    threads?: HsThread[]
  }
}

async function fetchConversationWithThreads(
  token: string,
  conversationId: string,
): Promise<HsConversationWithThreads | null> {
  const resp = await fetch(
    `https://api.helpscout.net/v2/conversations/${conversationId}?embed=threads`,
    {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    },
  )
  if (resp.status === 404) return null
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`Help Scout conversation fetch (${resp.status}): ${text}`)
  }
  return await resp.json() as HsConversationWithThreads
}

// Plain-text projection of an HTML body. Strips tags, decodes the
// few common entities Help Scout emits, collapses whitespace. Good
// enough for the read-only preview pane; not a sanitiser.
function htmlToPlainText(html: string | undefined | null): string {
  if (!html) return ''
  return html
    // Convert <br> and block boundaries to newlines so paragraphs survive.
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    // Strip every other tag.
    .replace(/<[^>]+>/g, '')
    // Decode the common entities.
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    // Collapse runs of blank lines.
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function authorNameFor(t: HsThread): string {
  const first = t.createdBy?.first ?? ''
  const last = t.createdBy?.last ?? ''
  const composite = `${first} ${last}`.trim()
  if (composite) return composite
  if (t.createdBy?.email) return t.createdBy.email
  return 'Unknown'
}

function authorTypeFor(t: HsThread): 'customer' | 'user' | 'unknown' {
  const ct = t.createdBy?.type
  if (ct === 'customer' || ct === 'user') return ct
  return 'unknown'
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const check = await requireDesigner(req)
  if (check instanceof Response) return check
  const { admin } = check

  // Parse + validate body.
  let proofId: string | undefined
  try {
    const parsed = await req.json()
    proofId = typeof parsed?.proof_id === 'string' ? parsed.proof_id.trim() : undefined
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }
  if (!proofId) return json({ error: 'proof_id is required' }, 400)

  // Look up the conversation id server-side.
  const { data: proofRow, error: proofErr } = await admin
    .from('proofs')
    .select('id, helpscout_conversation_id')
    .eq('id', proofId)
    .maybeSingle()
  if (proofErr) return json({ error: `Proof lookup failed: ${proofErr.message}` }, 500)
  if (!proofRow) return json({ error: 'Proof not found' }, 404)
  const conversationId = (proofRow as { helpscout_conversation_id: string | null }).helpscout_conversation_id
  if (!conversationId) {
    return json({ error: 'No Help Scout conversation linked to this proof' }, 404)
  }

  const appId = Deno.env.get('HELPSCOUT_APP_ID')
  const appSecret = Deno.env.get('HELPSCOUT_APP_SECRET')
  if (!appId || !appSecret) {
    return json({ error: 'Help Scout credentials not configured' }, 500)
  }

  try {
    const token = await getAccessToken(appId, appSecret)
    const conversation = await fetchConversationWithThreads(token, conversationId)
    if (!conversation) {
      return json({ error: `Help Scout conversation ${conversationId} not found.` }, 404)
    }
    const rawThreads = conversation._embedded?.threads ?? []
    // Help Scout returns threads in reverse-chronological order
    // (newest first) but be defensive: sort by createdAt desc so the
    // frontend's "first" / "find" calls always pick the latest.
    const sorted = [...rawThreads].sort((a, b) =>
      (b.createdAt ?? '').localeCompare(a.createdAt ?? ''),
    )
    const threads = sorted.map((t) => ({
      id: t.id,
      type: t.type ?? 'unknown',
      authorName: authorNameFor(t),
      authorType: authorTypeFor(t),
      bodyText: htmlToPlainText(t.body),
      createdAt: t.createdAt ?? '',
    }))

    return json({
      conversation_id: conversation.id,
      url: `https://secure.helpscout.net/conversation/${conversation.id}`,
      threads,
    })
  } catch (err) {
    console.error('fetch-helpscout-conversation-context error:', err)
    return json({ error: (err as Error).message ?? 'Unknown error' }, 502)
  }
})
