// Inbound Help Scout webhook: records reply activity on a linked conversation
// so proof-viewer can quiet the Needs-attention flag for a grace window when a
// chase (or a customer reply) happens — including chases done directly in Help
// Scout, which proof-viewer would otherwise never see. See
// docs/helpscout-webhook-spec.md.
//
// Subscribed events (configured in Help Scout):
//   * convo.agent.reply.created    → stamps proofs.helpscout_last_reply_at
//   * convo.customer.reply.created → stamps proofs.helpscout_last_customer_reply_at
// Both timestamps suppress the four chase rules (the suppression guard in
// proofs_needing_attention uses greatest() of the two), so direction only
// affects the dashboard chip wording, never whether the flag is quieted.
//
// Auth: this endpoint is public (verify_jwt = false — Help Scout sends no JWT).
// The only gate is the HMAC-SHA1 signature check against HELPSCOUT_WEBHOOK_SECRET
// over the raw request body, so that verification must run before any work.
//
// Env:
//   HELPSCOUT_WEBHOOK_SECRET            — the webhook's signing secret.
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — service-role client (RLS bypass,
//                                         writes scoped to helpscout_* columns).

import { createClient } from 'jsr:@supabase/supabase-js@2'

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  })
}

// Base64 of a byte array (btoa works on a binary string).
function bytesToBase64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

// Constant-time string compare so a bad signature can't be timed out byte by
// byte. Length mismatch returns false immediately (length isn't secret).
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// Help Scout signs webhooks with base64(HMAC-SHA1(rawBody, secret)) in the
// X-HelpScout-Signature header.
async function verifySignature(rawBody: string, signature: string | null, secret: string): Promise<boolean> {
  if (!signature) return false
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody))
  return timingSafeEqual(bytesToBase64(new Uint8Array(mac)), signature)
}

// Direction of the reply: 'customer' or 'staff'. Best-effort — both suppress, so
// an ambiguous event safely falls back to 'staff' (only the chip wording is
// affected). Prefers the event header; falls back to the newest embedded
// thread's author type.
function replyDirection(eventHeader: string | null, payload: Record<string, unknown>): 'customer' | 'staff' {
  const ev = (eventHeader ?? '').toLowerCase()
  if (ev.includes('customer.reply')) return 'customer'
  if (ev.includes('agent.reply')) return 'staff'

  const threads = (payload?._embedded as { threads?: Array<Record<string, unknown>> } | undefined)?.threads
  if (Array.isArray(threads) && threads.length > 0) {
    const newest = [...threads].sort((a, b) =>
      String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')),
    )[0]
    const t = (newest?.createdBy as { type?: string } | undefined)?.type
    if (t === 'customer') return 'customer'
    if (t === 'user') return 'staff'
  }
  return 'staff'
}

async function handle(req: Request): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const secret = Deno.env.get('HELPSCOUT_WEBHOOK_SECRET')
  if (!secret) {
    console.error('[helpscout-webhook] HELPSCOUT_WEBHOOK_SECRET not set')
    return json({ error: 'HELPSCOUT_WEBHOOK_SECRET not set' }, 500)
  }

  // Read the raw body once — needed verbatim for the HMAC, then parsed.
  const rawBody = await req.text()
  const signature = req.headers.get('x-helpscout-signature')
  if (!(await verifySignature(rawBody, signature, secret))) {
    return json({ error: 'invalid signature', hadSignatureHeader: signature != null }, 401)
  }

  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return json({ error: 'invalid JSON' }, 400)
  }

  // Conversation id — the webhook body is the conversation resource.
  const conversationId =
    (payload?.id as number | string | undefined) ??
    ((payload?.conversation as { id?: number | string } | undefined)?.id)
  if (conversationId == null) {
    // Nothing to map; ack so Help Scout doesn't retry.
    return json({ ok: true, ignored: 'no conversation id' })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  if (!supabaseUrl || !serviceKey) {
    console.error('[helpscout-webhook] missing supabase env')
    return json({ error: 'missing supabase env' }, 500)
  }
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const direction = replyDirection(req.headers.get('x-helpscout-event'), payload)
  const column = direction === 'customer'
    ? 'helpscout_last_customer_reply_at'
    : 'helpscout_last_reply_at'
  const nowIso = new Date().toISOString()

  // Update every proof linked to this conversation (normally one).
  const { data, error } = await admin
    .from('proofs')
    .update({ [column]: nowIso })
    .eq('helpscout_conversation_id', String(conversationId))
    .select('id')

  if (error) {
    console.error('[helpscout-webhook] update failed:', error.message)
    // Return the DB message so it's visible in the Help Scout delivery log.
    return json({ error: 'update failed', detail: error.message }, 500)
  }

  // 200 whether or not a proof matched (most HS conversations aren't proofs);
  // a matched-but-empty result is a normal no-op, not an error.
  return json({ ok: true, matched: data?.length ?? 0, direction })
}

Deno.serve(async (req) => {
  try {
    return await handle(req)
  } catch (err) {
    // Never let an unexpected throw become an opaque EDGE_FUNCTION_ERROR — log
    // it and surface the message in the response body + a header so it's
    // readable from the Help Scout delivery log or the Supabase request log.
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    console.error('[helpscout-webhook] crashed:', msg, err instanceof Error ? err.stack : '')
    return json({ error: 'crash', detail: msg }, 500, { 'x-debug-error': msg.slice(0, 180) })
  }
})
