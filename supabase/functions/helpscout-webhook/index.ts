// Inbound Help Scout webhook: records reply activity on a linked conversation
// so proof-viewer can quiet the Needs-attention flag for a grace window when a
// chase (or a customer reply) happens — including chases done directly in Help
// Scout, which proof-viewer would otherwise never see. See
// docs/helpscout-webhook-spec.md.
//
// Subscribed events (configured in Help Scout):
//   * convo.agent.reply.created    → stamps proofs.helpscout_last_reply_at
//   * convo.customer.reply.created → stamps proofs.helpscout_last_customer_reply_at,
//                                    and triggers the AI draft pipeline
//   * convo.created                → triggers the AI draft pipeline
//   * convo.moved                  → triggers the AI draft pipeline (catches
//                                    Graphics → Customer Support handoffs)
//   * convo.merged                 → re-points any proof linked to the now-deleted
//                                    source conversation onto the surviving target,
//                                    so reminders/replies keep working after a merge.
//                                    See docs/helpscout-merge-repoint-spec.md.
// Reply-timestamp stamping runs ONLY for reply events — a created/moved
// conversation must never fake a staff touch, or it would wrongly quiet the
// needs-attention chase rules. The AI draft trigger is fire-and-forget
// (EdgeRuntime.waitUntil) so webhook acking stays fast; the ai-draft
// function does its own mailbox/mode/dedupe gating.
// Both timestamps suppress the four chase rules (the suppression guard in
// proofs_needing_attention uses greatest() of the two), so direction only
// affects the dashboard chip wording, never whether the flag is quieted.
//
// Auth: this endpoint is public (verify_jwt = false — Help Scout sends no JWT).
// The only gate is the HMAC-SHA1 signature check against PROOFS_HELPSCOUT_WEBHOOK_SECRET
// over the raw request body, so that verification must run before any work.
//
// Env:
//   PROOFS_HELPSCOUT_WEBHOOK_SECRET     — the proofs webhook's signing secret.
//     Renamed from HELPSCOUT_WEBHOOK_SECRET for the merged stock project: the
//     stock-control app's own Help Scout order-webhook receivers already use
//     HELPSCOUT_WEBHOOK_SECRET with a different secret, so proofs needs its own
//     env var to avoid a collision (one project, two distinct webhooks).
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — service-role client (RLS bypass,
//                                         writes scoped to helpscout_* columns).

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { logAudit } from '../_shared/audit.ts'

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined

// Events that mean "a reply happened" (stamp timestamps) vs events that only
// trigger drafting.
const REPLY_EVENT_RE = /reply/i
const DRAFT_TRIGGER_RE = /^convo\.(created|moved|customer\.reply\.created)$/i
// A merge deletes the source conversation and moves its threads into the
// surviving target; any proof still holding the source id must be re-pointed.
const MERGE_EVENT_RE = /^convo\.merged$/i

// Fire-and-forget trigger of the ai-draft worker. Failures are logged, never
// surfaced — drafting is an enhancement, the webhook's stamping contract
// must not depend on it.
async function triggerAiDraft(
  supabaseUrl: string,
  serviceKey: string,
  conversationId: number | string,
  event: string,
): Promise<void> {
  try {
    const resp = await fetch(`${supabaseUrl}/functions/v1/ai-draft`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({ conversationId, event }),
    })
    if (!resp.ok) {
      console.error('[helpscout-webhook] ai-draft trigger failed:', resp.status, await resp.text())
    }
  } catch (err) {
    console.error('[helpscout-webhook] ai-draft trigger crashed:', (err as Error).message)
  }
}

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

// Handle a `convo.merged` event. Help Scout records a merge on the surviving
// (target) conversation: each thread moved in from the deleted source keeps a
// `merged` line-item whose action.associatedEntities.originalConversation names
// that source. We read those source ids out of the payload's embedded threads
// and re-point every proof still linked to a source onto this target — the link
// the proof holds is now a dead id that 404s on every reminder/reply.
//
// Defensive: a single merge moves several threads, so the same source id appears
// on multiple line-items — dedupe. Matching proofs by the conversation column
// (not proof id) moves every proof sharing the dead id together. The whole thing
// is idempotent: re-points only fire for source ids that still match a proof, so
// a redelivered event (or old merge line-items in the thread list) is a no-op.
//
// If the payload carries no merge line-items (e.g. Help Scout's merge payload
// turns out to represent the source, or omits embedded threads), we log the
// shape and ack — no guessing. Confirm the real payload with a test merge during
// rollout; see docs/helpscout-merge-repoint-spec.md.
async function handleMerge(
  admin: SupabaseClient,
  targetConversationId: number | string,
  payload: Record<string, unknown>,
): Promise<Response> {
  const targetId = String(targetConversationId)
  const threads =
    (payload?._embedded as { threads?: Array<Record<string, unknown>> } | undefined)?.threads

  const sourceIds = new Set<string>()
  if (Array.isArray(threads)) {
    for (const t of threads) {
      const action = t?.action as
        | { type?: string; associatedEntities?: { originalConversation?: number | string } }
        | undefined
      if (action?.type === 'merged') {
        const oc = action.associatedEntities?.originalConversation
        if (oc != null) {
          const s = String(oc)
          if (s && s !== targetId) sourceIds.add(s)
        }
      }
    }
  }

  if (sourceIds.size === 0) {
    console.log('[helpscout-webhook] merge event with no embedded source ids', {
      targetId,
      hasEmbeddedThreads: Array.isArray(threads),
      threadCount: Array.isArray(threads) ? threads.length : 0,
    })
    return json({ ok: true, merged: true, repointed: 0, note: 'no source ids in payload' })
  }

  const targetUrl = `https://secure.helpscout.net/conversation/${targetId}`
  let repointed = 0
  for (const sourceId of sourceIds) {
    const { data, error } = await admin
      .from('proofs')
      .update({
        helpscout_conversation_id: targetId,
        helpscout_conversation_url: targetUrl,
      })
      .eq('helpscout_conversation_id', sourceId)
      .select('id')
    if (error) {
      console.error('[helpscout-webhook] merge re-point failed', {
        sourceId,
        targetId,
        error: error.message,
      })
      continue
    }
    const rows = (data ?? []) as Array<{ id: string }>
    for (const row of rows) {
      repointed++
      await logAudit(admin, {
        actorLabel: 'Help Scout (merge sync)',
        action: 'proof.helpscout_link_remapped',
        targetType: 'proof',
        targetId: row.id,
        beforeValue: { helpscout_conversation_id: sourceId },
        afterValue: { helpscout_conversation_id: targetId, helpscout_conversation_url: targetUrl },
        metadata: { reason: 'helpscout_conversation_merged', event: 'convo.merged' },
      })
    }
    if (rows.length > 0) {
      console.log('[helpscout-webhook] merge re-pointed proofs', {
        sourceId,
        targetId,
        count: rows.length,
      })
    }
  }

  return json({ ok: true, merged: true, repointed })
}

async function handle(req: Request): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const secret = Deno.env.get('PROOFS_HELPSCOUT_WEBHOOK_SECRET')
  if (!secret) {
    console.error('[helpscout-webhook] PROOFS_HELPSCOUT_WEBHOOK_SECRET not set')
    return json({ error: 'PROOFS_HELPSCOUT_WEBHOOK_SECRET not set' }, 500)
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
    // Proof data lives in the `proofs` schema of the shared stock project;
    // table names collide with stock's public schema under one PostgREST.
    db: { schema: 'proofs' },
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const eventHeader = req.headers.get('x-helpscout-event') ?? ''

  // Merge re-point: stands on its own (not a reply, must not trigger drafting).
  // Heals proofs whose linked conversation was merged away before they 404.
  if (MERGE_EVENT_RE.test(eventHeader)) {
    return await handleMerge(admin, conversationId, payload)
  }

  // AI draft trigger: created / moved / customer-reply conversations go to
  // the drafting worker, which gates on mailbox + mode + dedupe itself.
  if (DRAFT_TRIGGER_RE.test(eventHeader)) {
    const trigger = triggerAiDraft(supabaseUrl, serviceKey, conversationId, eventHeader)
    if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(trigger)
  }

  // Stamping below is the reply-activity contract: reply events only.
  if (!REPLY_EVENT_RE.test(eventHeader)) {
    return json({ ok: true, stamped: false, event: eventHeader })
  }

  const direction = replyDirection(eventHeader, payload)
  const column = direction === 'customer'
    ? 'helpscout_last_customer_reply_at'
    : 'helpscout_last_reply_at'

  // Stamp from the event's own thread time where the payload carries it —
  // Help Scout retries deliver late, and now() on a day-old retry would
  // claim activity that never happened. Falls back to now() when no thread
  // timestamp is embedded.
  const embeddedThreads =
    (payload?._embedded as { threads?: Array<Record<string, unknown>> } | undefined)?.threads
  const newestThreadMs = Array.isArray(embeddedThreads)
    ? embeddedThreads
      .map((t) => Date.parse(String(t.createdAt ?? '')))
      .filter(Number.isFinite)
      .reduce((a, b) => Math.max(a, b), -Infinity)
    : -Infinity
  const stampIso = newestThreadMs > -Infinity
    ? new Date(newestThreadMs).toISOString()
    : new Date().toISOString()

  // Update every proof linked to this conversation (normally one). The .or
  // filter is a GREATEST guard: a late retry can never regress a stamp that
  // a fresher delivery already advanced.
  const { data, error } = await admin
    .from('proofs')
    .update({ [column]: stampIso })
    .eq('helpscout_conversation_id', String(conversationId))
    .or(`${column}.is.null,${column}.lt.${stampIso}`)
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
