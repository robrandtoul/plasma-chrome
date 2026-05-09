// Fetch a specific Help Scout conversation plus its primary customer's
// full contact details, so the new-proof form can auto-populate a
// whole record from a single URL or conversation-number paste.
//
// Designer or admin only — uses the requireDesigner helper from
// _shared/admin.ts which validates the JWT, checks profiles.role
// is in ('admin', 'designer'), and rejects deactivated accounts.
// Closes audit finding H3.
// Requires HELPSCOUT_APP_ID, HELPSCOUT_APP_SECRET secrets.
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

import { requireDesigner } from '../_shared/admin.ts'
import {
  fetchConversation,
  fetchCustomer,
  getAccessToken,
  type HsCustomer,
} from '../_shared/helpscout.ts'

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  // Designer or admin role required — closes audit finding H3.
  // Pre-shipment, this endpoint accepted any authenticated user;
  // a non-staff role would have been able to fetch full customer
  // details for any conversation by id, leaking HS customer data.
  const check = await requireDesigner(req)
  if (check instanceof Response) return check

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
