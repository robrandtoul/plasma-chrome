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
//   * convo.tags                   → mirrors the conversation's tags into
//                                    proofs.helpscout_tags (Phase 2b tag sync) so
//                                    the "follow up" needs-attention rule fires and
//                                    the nudge sender stands down for human-claimed
//                                    chases. Requires the convo.tags event to be
//                                    ticked on the webhook subscription in HS.
//   * convo.merged                 → re-points any proof linked to the now-deleted
//                                    source conversation onto the surviving target,
//                                    so reminders/replies keep working after a merge.
//                                    The merge line-items are NOT in the webhook
//                                    payload, so the handler fetches the target's
//                                    threads from the Help Scout API (OAuth) to find
//                                    the merged-in source ids. See
//                                    docs/helpscout-merge-repoint-spec.md.
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
import { getAccessToken } from '../_shared/helpscout.ts'

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined

// Events that mean "a reply happened" (stamp timestamps) vs events forwarded
// to the ai-draft worker. The worker drafts on created/moved/customer-reply
// and captures sent-vs-draft feedback on agent-reply — it routes on the event.
const REPLY_EVENT_RE = /reply/i
const DRAFT_TRIGGER_RE = /^convo\.(created|moved|customer\.reply\.created|agent\.reply\.created)$/i
// A merge deletes the source conversation and moves its threads into the
// surviving target; any proof still holding the source id must be re-pointed.
// Matched loosely (any event whose name contains "merge") so a naming variant
// still routes here — none of the other subscribed events contain "merge".
const MERGE_EVENT_RE = /merge/i
// Tag changes (convo.tags) — Phase 2b tag sync. Mirrors the conversation's
// tag list into proofs.helpscout_tags so the helpscout_follow_up_tag
// needs-attention rule (000154) finally has data, and so the nudge sender
// can stand down when a human has tagged the conversation "follow up".
// Matched loosely on "tags" — no other subscribed event contains it.
const TAGS_EVENT_RE = /tags/i

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

// GET /v2/conversations/{id}/threads and pull the merged-in source conversation
// ids from the `merged` line-items. Help Scout records a merge on the surviving
// (target) conversation; each thread moved in from a deleted source keeps a
// line-item whose action.associatedEntities.originalConversation names that
// source. We FETCH these rather than read them off the webhook payload because
// the convo.merged payload does NOT embed the merge line-items (confirmed live —
// the old embedded-threads path silently found nothing and never re-pointed).
//
// Threads come back newest-first, so the line-items from a just-fired merge are
// on page 1; no pagination needed for a fresh merge. Best-effort: a non-2xx
// response returns an empty set plus the status, which the caller records in the
// diagnostic row. Dedupe — one merge moves several threads, all naming the same
// source.
async function fetchMergeSourceIds(
  token: string,
  targetId: string,
): Promise<{ sourceIds: string[]; threadCount: number; status: number }> {
  const resp = await fetch(
    `https://api.helpscout.net/v2/conversations/${targetId}/threads`,
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
  )
  if (!resp.ok) return { sourceIds: [], threadCount: 0, status: resp.status }
  const data = (await resp.json().catch(() => null)) as
    | { _embedded?: { threads?: Array<Record<string, unknown>> } }
    | null
  const threads = data?._embedded?.threads ?? []
  const ids = new Set<string>()
  for (const t of threads) {
    const action = t?.action as
      | { type?: string; associatedEntities?: { originalConversation?: number | string } }
      | undefined
    if (action?.type === 'merged') {
      const oc = action.associatedEntities?.originalConversation
      if (oc != null) {
        const s = String(oc)
        if (s && s !== targetId) ids.add(s)
      }
    }
  }
  return { sourceIds: [...ids], threadCount: threads.length, status: resp.status }
}

// Handle a merge event. Re-point every proof still linked to a now-deleted source
// conversation onto the surviving target (id + url), so reminders/replies keep
// working. Matching proofs by the conversation column (not proof id) moves every
// proof sharing a dead id together; idempotent — re-points only fire for source
// ids that still match a proof, so a redelivered event is a no-op.
//
// Source ids come from a fast payload check first (in case Help Scout ever embeds
// the merge line-items), then authoritatively from the Help Scout API.
// See docs/helpscout-merge-repoint-spec.md.
async function handleMerge(
  admin: SupabaseClient,
  targetConversationId: number | string,
  payload: Record<string, unknown>,
): Promise<Response> {
  const targetId = String(targetConversationId)

  // Fast path: use embedded merge line-items if the payload ever carries them.
  const embeddedThreads =
    (payload?._embedded as { threads?: Array<Record<string, unknown>> } | undefined)?.threads
  const sourceIds = new Set<string>()
  if (Array.isArray(embeddedThreads)) {
    for (const t of embeddedThreads) {
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
  // Authoritative path: fetch the target's threads from the Help Scout API.
  if (sourceIds.size === 0) {
    const appId = Deno.env.get('HELPSCOUT_APP_ID')?.trim()
    const appSecret = Deno.env.get('HELPSCOUT_APP_SECRET')?.trim()
    if (!appId || !appSecret) {
      console.error('[helpscout-webhook] merge: HELPSCOUT_APP_ID/SECRET not set; cannot fetch threads')
    } else {
      try {
        const token = await getAccessToken(appId, appSecret)
        const fetched = await fetchMergeSourceIds(token, targetId)
        for (const s of fetched.sourceIds) sourceIds.add(s)
      } catch (err) {
        console.error('[helpscout-webhook] merge thread fetch failed', (err as Error).message)
      }
    }
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

  // Most merges involve no linked proof (repointed: 0) — that's a normal no-op,
  // not an error. A console line keeps it visible in the function runtime log
  // without writing an audit row per merge.
  console.log('[helpscout-webhook] merge processed', {
    targetId,
    sources: sourceIds.size,
    repointed,
  })

  return json({ ok: true, merged: true, repointed, source_ids: [...sourceIds] })
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

  // Tag sync (convo.tags): replace the linked proofs' helpscout_tags with
  // the conversation's current tag list. The payload is the conversation
  // resource; tags arrive as [{ id, color, tag }] (defensively also accepting
  // bare strings). REPLACE, not merge — a cleared tag must clear the rule.
  // Not a reply: never stamps the reply timestamps, never triggers drafting.
  if (TAGS_EVENT_RE.test(eventHeader)) {
    const rawTags = (payload?.tags as unknown[] | undefined) ?? []
    const tagNames = rawTags
      .map((t) =>
        typeof t === 'string' ? t : ((t as { tag?: unknown } | null)?.tag ?? null))
      .filter((t): t is string => typeof t === 'string' && t.trim() !== '')
      .map((t) => t.trim().toLowerCase())
    const { data, error } = await admin
      .from('proofs')
      .update({ helpscout_tags: tagNames })
      .eq('helpscout_conversation_id', String(conversationId))
      .select('id')
    if (error) {
      console.error('[helpscout-webhook] tag sync failed:', error.message)
      return json({ error: 'tag sync failed', detail: error.message }, 500)
    }
    console.log('[helpscout-webhook] tags synced', {
      conversationId,
      tags: tagNames,
      matched: data?.length ?? 0,
    })
    return json({ ok: true, tags: tagNames, matched: data?.length ?? 0 })
  }

  // AI draft worker: created / moved / customer-reply → drafting;
  // agent-reply → sent-vs-draft feedback capture. The worker gates on
  // mailbox + mode + dedupe (drafting) or an unmatched draft (feedback).
  // agent-reply also falls through to the reply-stamping below.
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
