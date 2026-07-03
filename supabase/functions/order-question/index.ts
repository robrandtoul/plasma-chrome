// order-question — the pay page's "Not sure? Ask us" escape hatch (000298,
// docs/metal-spec-at-checkout-spec.md §5.3.6). A customer hesitating over the
// thickness/finish chooser (or anything else pre-payment) submits a short
// question; we stamp orders.help_requested_at (the Orders page shows an amber
// "asked for help" chip) and post an internal Help Scout note + mark the
// conversation active so the team replies by email. Hesitation becomes a
// tracked conversation instead of a silently closed tab.
//
// Anonymous, token-scoped: the order id + secret pay-page token are validated
// against proofs.orders exactly like public_get_order / create-checkout-session.
// Modelled on proof-feedback (the anon customer-write house pattern); the Help
// Scout sync is deferred so it never adds latency or fails the submit.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, HELPSCOUT_APP_ID,
//      HELPSCOUT_APP_SECRET, HELPSCOUT_DEFAULT_USER_ID.

import { createClient } from 'jsr:@supabase/supabase-js@2'

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined

// Inlined Help Scout helpers (same shape as _shared/helpscout.ts / the
// proof-feedback siblings) so this function deploys as a single file.
async function getAccessToken(appId: string, appSecret: string): Promise<string> {
  const resp = await fetch('https://api.helpscout.net/v2/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: appId, client_secret: appSecret }).toString(),
  })
  if (!resp.ok) throw new Error(`HS token error (${resp.status})`)
  const token = (await resp.json().catch(() => null) as { access_token?: string } | null)?.access_token
  if (!token) throw new Error('HS token response missing access_token')
  return token
}

async function createNote(token: string, conversationId: number | string, userId: number, text: string): Promise<void> {
  const resp = await fetch(`https://api.helpscout.net/v2/conversations/${conversationId}/notes`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: userId, text }),
  })
  if (!resp.ok) throw new Error(`HS note create (${resp.status}): ${await resp.text().catch(() => '')}`)
}

// A note alone never changes conversation status, so it would sit unseen on a
// pending thread — mark active so the question surfaces in the team queue.
async function setConversationActive(token: string, conversationId: number | string): Promise<void> {
  const resp = await fetch(`https://api.helpscout.net/v2/conversations/${conversationId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ op: 'replace', path: '/status', value: 'active' }),
  })
  if (!resp.ok) throw new Error(`HS set-active (${resp.status}): ${await resp.text().catch(() => '')}`)
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS } })
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json({ error: 'invalid JSON' }, 400)
  }

  const orderId = String(body.order_id ?? '')
  const token = typeof body.token === 'string' ? body.token : ''
  const question = typeof body.question === 'string' ? body.question.trim().slice(0, 2000) : ''
  if (!UUID_RE.test(orderId)) return json({ error: 'invalid order_id' }, 400)
  if (!token) return json({ error: 'missing token' }, 400)
  if (!question) return json({ error: 'missing question' }, 400)

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  if (!supabaseUrl || !serviceKey) return json({ error: 'missing supabase env' }, 500)

  const admin = createClient(supabaseUrl, serviceKey, {
    db: { schema: 'proofs' },
    auth: { persistSession: false, autoRefreshToken: false },
  })

  // Token-scoped order lookup — the same trust model as the pay page's reads.
  // Deliberately NOT gated on 'sent' / unexpired: a question from an expired or
  // just-paid link is still worth landing in the team's queue.
  const { data: order, error: orderErr } = await admin
    .from('orders')
    .select('id, proof_id, payment_reference, status, thickness_open, finish_open')
    .eq('id', orderId)
    .eq('token', token)
    .maybeSingle()
  if (orderErr) return json({ error: 'lookup failed' }, 500)
  if (!order) return json({ error: 'order not found' }, 404)

  // Stamp the ask (most recent wins) so the Orders page chip surfaces it even
  // if the Help Scout sync below fails.
  const { error: stampErr } = await admin
    .from('orders')
    .update({ help_requested_at: new Date().toISOString() })
    .eq('id', order.id)
  if (stampErr) return json({ error: 'could not record the question' }, 500)

  // Best-effort Help Scout note + reactivation, deferred off the request path.
  const { data: proof } = await admin
    .from('proofs')
    .select('helpscout_conversation_id')
    .eq('id', order.proof_id)
    .maybeSingle()
  const conversationId = (proof as { helpscout_conversation_id: string | null } | null)?.helpscout_conversation_id
  if (conversationId) {
    const syncHs = async () => {
      const appId = Deno.env.get('HELPSCOUT_APP_ID')?.trim()
      const appSecret = Deno.env.get('HELPSCOUT_APP_SECRET')?.trim()
      if (!appId || !appSecret) return
      let hsToken: string
      try {
        hsToken = await getAccessToken(appId, appSecret)
      } catch (err) {
        console.error('[order-question] HS token failed:', (err as Error).message)
        return
      }
      const userId = Number(Deno.env.get('HELPSCOUT_DEFAULT_USER_ID') ?? '')
      if (Number.isFinite(userId)) {
        try {
          const choosing =
            order.thickness_open === true || order.finish_open === true
              ? '\n\nThey were choosing their thickness/finish on the pay page — worth a quick reply so the order isn’t lost.'
              : '\n\nAsked from the order pay page — worth a quick reply.'
          await createNote(
            hsToken,
            conversationId,
            userId,
            `🔔 Question from the pay page (order ${order.payment_reference ?? order.id}).\n“${question}”${choosing}`,
          )
        } catch (err) {
          console.error('[order-question] HS note failed:', (err as Error).message)
        }
      }
      try {
        await setConversationActive(hsToken, conversationId)
      } catch (err) {
        console.error('[order-question] HS set-active failed:', (err as Error).message)
      }
    }
    if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(syncHs())
    else await syncHs()
  }

  return json({ status: 'ok' })
}

Deno.serve(async (req) => {
  try {
    return await handle(req)
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    console.error('[order-question] crashed:', msg)
    return json({ error: 'crash', detail: msg }, 500)
  }
})
