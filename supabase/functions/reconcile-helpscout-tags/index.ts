// Scheduled reconcile of proofs.helpscout_tags against Help Scout.
//
// Why this exists: the convo.tags webhook (helpscout-webhook) only mirrors a
// tag change onto a proof that ALREADY exists. But Graphics tags the
// conversation when it's pushed to Graphics — usually BEFORE the proof is
// created in proof-viewer — so that first tag event matches no proof and is
// lost, and nothing back-fills it. The result was ~64% of proofs missing their
// tags (audited 2026-06-27). This job closes that gap: it pulls the current tag
// list from Help Scout for proofs the webhook never synced (helpscout_tags_synced_at
// IS NULL — e.g. just-created proofs) and periodically refreshes still-active
// proofs, so the returning-customer analytics + the helpscout_follow_up_tag
// needs-attention rule stay correct regardless of WHEN tags change. The webhook
// keeps doing near-real-time sync for changes after a proof exists.
//
// Invoked by pg_cron ('proofs-reconcile-helpscout-tags', */15 * * * *) via
// net.http_post with the service-role key as Bearer (same pattern as
// send-nudges). verify_jwt = true (the platform validates the JWT); the handler
// additionally requires the bearer to be a service-role key, so neither anon nor
// designer JWTs can trigger a run.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (platform-provided),
//      HELPSCOUT_APP_ID, HELPSCOUT_APP_SECRET (same secrets send-nudges uses).
// Self-contained (only imports supabase-js and _shared/heartbeat.ts, itself a
// zero-import leaf module) so it neither bundles nor risks the widely-imported
// _shared/helpscout.ts.

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { pingHeartbeat } from '../_shared/heartbeat.ts'

// Distinct conversations fetched per run. The cron is frequent (every 15 min)
// and never-synced proofs are prioritised, so a small cap keeps each run quick
// and well within the Help Scout rate limit.
const BATCH = 60
// Active proofs are re-pulled if their tags haven't been refreshed in this long,
// as a backstop against any webhook delivery the live path missed.
const REFRESH_MS = 12 * 3_600_000

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// Role claim of an already-platform-verified JWT (verify_jwt = true). Lets a
// second legitimately-minted service-role key authenticate even if it isn't a
// byte match for the injected env key (mirrors send-nudges' gate).
function bearerRole(bearer: string): string | null {
  const parts = bearer.split('.')
  if (parts.length !== 3) return null
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')))
    return (payload?.role as string) ?? null
  } catch {
    return null
  }
}

// OAuth client-credentials token (same flow as _shared/helpscout.ts).
async function getAccessToken(appId: string, appSecret: string): Promise<string> {
  const resp = await fetch('https://api.helpscout.net/v2/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: appId, client_secret: appSecret }).toString(),
  })
  if (!resp.ok) throw new Error(`HS token error (${resp.status}): ${await resp.text().catch(() => '')}`)
  const data = await resp.json().catch(() => null)
  const token = (data as { access_token?: string } | null)?.access_token
  if (!token) throw new Error('HS token response missing access_token')
  return token
}

// GET /v2/conversations/{id}; return its tag names (lowercased), [] if none, or
// null on 404 (deleted conversation). Throws with a `.status` of 401 on an
// auth failure so the caller can refresh the token and retry once.
async function fetchTagNames(token: string, id: string): Promise<string[] | null> {
  const resp = await fetch(`https://api.helpscout.net/v2/conversations/${id}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  if (resp.status === 404) return null
  if (!resp.ok) {
    const err = new Error(`HS conversation fetch (${resp.status})`) as Error & { status?: number }
    err.status = resp.status
    throw err
  }
  const conv = (await resp.json().catch(() => null)) as { tags?: Array<{ tag?: string } | string> } | null
  return (conv?.tags ?? [])
    .map((t) => (typeof t === 'string' ? t : (t?.tag ?? null)))
    .filter((t): t is string => typeof t === 'string' && t.trim() !== '')
    .map((t) => t.trim().toLowerCase())
}

async function handle(req: Request): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!serviceKey || !(timingSafeEqual(bearer, serviceKey) || bearerRole(bearer) === 'service_role')) {
    return json({ error: 'unauthorized' }, 401)
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const appId = Deno.env.get('HELPSCOUT_APP_ID')?.trim()
  const appSecret = Deno.env.get('HELPSCOUT_APP_SECRET')?.trim()
  if (!supabaseUrl || !appId || !appSecret) return json({ error: 'missing env' }, 500)

  const admin = createClient(supabaseUrl, serviceKey, {
    db: { schema: 'proofs' },
    auth: { persistSession: false, autoRefreshToken: false },
  })

  // Priority 1 — never-synced proofs (the creation-ordering gap the webhook
  // structurally misses). Priority 2 — active proofs not refreshed in 12h
  // (backstop for any missed change while a proof is live).
  const cutoff = new Date(Date.now() - REFRESH_MS).toISOString()
  const [neverSynced, staleActive] = await Promise.all([
    admin.from('proofs').select('id, helpscout_conversation_id')
      .not('helpscout_conversation_id', 'is', null)
      .is('helpscout_tags_synced_at', null)
      .limit(400),
    admin.from('proofs').select('id, helpscout_conversation_id')
      .not('helpscout_conversation_id', 'is', null)
      .in('status', ['in_progress', 'dormant'])
      .lt('helpscout_tags_synced_at', cutoff)
      .order('helpscout_tags_synced_at', { ascending: true })
      .limit(400),
  ])
  if (neverSynced.error) return json({ error: 'select failed', detail: neverSynced.error.message }, 500)
  if (staleActive.error) return json({ error: 'select failed', detail: staleActive.error.message }, 500)

  // Distinct conversations, never-synced first, capped at BATCH.
  const convIds: string[] = []
  const seen = new Set<string>()
  for (const r of [...(neverSynced.data ?? []), ...(staleActive.data ?? [])]) {
    const cid = String((r as { helpscout_conversation_id: string }).helpscout_conversation_id)
    if (seen.has(cid)) continue
    seen.add(cid)
    convIds.push(cid)
    if (convIds.length >= BATCH) break
  }
  if (convIds.length === 0) {
    // Nothing to reconcile IS a healthy run — every proof is already in sync.
    // The heartbeat has to fire here too, or a quiet period would look
    // identical to a dead job and page someone at 3am over nothing.
    await pingHeartbeat('BETTERSTACK_HEARTBEAT_RECONCILE_TAGS')
    return json({ ok: true, conversations: 0, reconciled: 0 })
  }

  let token = await getAccessToken(appId, appSecret)
  const nowIso = new Date().toISOString()
  let reconciled = 0
  let failed = 0
  const failures: string[] = []

  for (const cid of convIds) {
    try {
      let tags: string[] | null
      try {
        tags = await fetchTagNames(token, cid)
      } catch (e) {
        // One retry on 401 — the token can expire mid-batch.
        if ((e as { status?: number }).status === 401) {
          token = await getAccessToken(appId, appSecret)
          tags = await fetchTagNames(token, cid)
        } else {
          throw e
        }
      }
      // 404 → conversation deleted; store empty tags + stamp so we stop retrying.
      const tagNames = tags ?? []
      const { error: upErr } = await admin
        .from('proofs')
        .update({ helpscout_tags: tagNames, helpscout_tags_synced_at: nowIso })
        .eq('helpscout_conversation_id', cid)
      if (upErr) {
        failed++
        failures.push(`${cid}: ${upErr.message}`)
        continue
      }
      reconciled++
    } catch (e) {
      // Leave helpscout_tags_synced_at unchanged so this conversation is retried
      // next run rather than silently dropped.
      failed++
      failures.push(`${cid}: ${(e as Error).message}`)
    }
  }

  console.log('[reconcile-helpscout-tags]', { conversations: convIds.length, reconciled, failed })

  // Better Stack heartbeat — see the note on the early return above. Fires on
  // the success path only (a throw skips this line and lands in the handler's
  // catch), and per-conversation failures are deliberately NOT treated as a
  // dead run: this job is designed to leave those unstamped and retry them
  // next quarter-hour, so it did complete.
  await pingHeartbeat('BETTERSTACK_HEARTBEAT_RECONCILE_TAGS')

  return json({ ok: true, conversations: convIds.length, reconciled, failed, failures: failures.slice(0, 10) })
}

Deno.serve(async (req) => {
  try {
    return await handle(req)
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    console.error('[reconcile-helpscout-tags] crashed:', msg)
    return json({ error: 'crash', detail: msg }, 500)
  }
})
