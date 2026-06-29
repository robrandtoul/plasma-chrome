// flag-helpscout-context: when a project is flagged onto the board, pull the
// customer's most recent Help Scout message (the one that immediately preceded
// the flag — usually the complaint that prompted it) into the card's thread.
//
// Called fire-and-forget by FlagProjectModal (a manual flag) and by the
// helpscout-webhook's complaint auto-flag, both with { watchItemId }. Best-effort
// throughout: any failure is logged and returns ok — the card already exists.
//
// Deliberately SELF-CONTAINED (no ../_shared imports) so the deploy is a single
// file. Writes via the service-role client, so the ingested row is created_by
// NULL with a supplied display name and renders as a "Help Scout · customer"
// entry (same shape the webhook's reply ingest produces).
//
// Auth: verify_jwt = false so the browser's CORS preflight isn't blocked at the
// gateway (the FlagProjectModal calls this directly). Low-risk: it only writes a
// customer message — which staff can already see — onto an existing card, deduped.
// The webhook auto-flag path calls it with the service-role key.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, HELPSCOUT_APP_ID, HELPSCOUT_APP_SECRET.

import { createClient } from 'jsr:@supabase/supabase-js@2'

// CORS so the browser (FlagProjectModal) can call this directly. Matches the
// pattern used by the other browser-invoked functions (e.g. dashboard-thumbnails);
// paired with verify_jwt = false so the gateway lets the OPTIONS preflight through.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  })
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    // Tidy whitespace: trim each line (kills Outlook's empty spacer paragraphs,
    // which arrive as a lone-space line), then allow at most one blank line
    // between paragraphs — otherwise the message renders with huge gaps.
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function getToken(appId: string, appSecret: string): Promise<string> {
  const resp = await fetch('https://api.helpscout.net/v2/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: appId,
      client_secret: appSecret,
    }).toString(),
  })
  if (!resp.ok) throw new Error(`Help Scout token error ${resp.status}`)
  const data = (await resp.json().catch(() => null)) as { access_token?: string } | null
  if (!data?.access_token) throw new Error('Help Scout token response missing access_token')
  return data.access_token
}

interface HsThread {
  id?: number
  body?: string
  createdAt?: string
  createdBy?: { type?: string; first?: string; last?: string; email?: string }
}

async function fetchThreads(token: string, conversationId: string): Promise<HsThread[] | null> {
  const resp = await fetch(
    `https://api.helpscout.net/v2/conversations/${conversationId}?embed=threads`,
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
  )
  if (!resp.ok) return null
  const data = (await resp.json().catch(() => null)) as
    | { _embedded?: { threads?: HsThread[] } }
    | null
  return data?._embedded?.threads ?? null
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  try {
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

    const { watchItemId } = (await req.json().catch(() => ({}))) as { watchItemId?: string }
    if (!watchItemId) return json({ error: 'watchItemId required' }, 400)

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    if (!supabaseUrl || !serviceKey) return json({ error: 'missing supabase env' }, 500)
    const appId = Deno.env.get('HELPSCOUT_APP_ID')?.trim() ?? ''
    const appSecret = Deno.env.get('HELPSCOUT_APP_SECRET')?.trim() ?? ''

    const admin = createClient(supabaseUrl, serviceKey, {
      db: { schema: 'proofs' },
      auth: { persistSession: false, autoRefreshToken: false },
    })

    const { data: item } = await admin
      .from('watch_items')
      .select('proof_id, created_at')
      .eq('id', watchItemId)
      .single()
    if (!item) return json({ ok: true, skipped: 'no watch item' })

    const { data: proof } = await admin
      .from('proofs')
      .select('helpscout_conversation_id')
      .eq('id', (item as { proof_id: string }).proof_id)
      .single()
    const convId = (proof as { helpscout_conversation_id?: string } | null)?.helpscout_conversation_id
    if (!convId) return json({ ok: true, skipped: 'no conversation' })

    if (!appId || !appSecret) return json({ ok: true, skipped: 'no helpscout creds' })

    const token = await getToken(appId, appSecret)
    const threads = await fetchThreads(token, String(convId))
    if (!threads) return json({ ok: true, skipped: 'no threads' })

    // The customer's most recent message at/before the flag (60s skew grace).
    const flaggedMs = Date.parse((item as { created_at: string }).created_at)
    const latest = threads
      .filter((t) => t.createdBy?.type === 'customer')
      .filter((t) => {
        const ms = Date.parse(String(t.createdAt ?? ''))
        return Number.isFinite(ms) && (!Number.isFinite(flaggedMs) || ms <= flaggedMs + 60000)
      })
      .sort((a, b) => Date.parse(String(b.createdAt ?? '')) - Date.parse(String(a.createdAt ?? '')))[0]
    if (!latest?.id) return json({ ok: true, ingested: 0 })

    const cb = latest.createdBy
    const author = [cb?.first, cb?.last].filter(Boolean).join(' ').trim() || cb?.email || 'Customer'
    const body =
      stripHtml(typeof latest.body === 'string' ? latest.body : '').slice(0, 800) ||
      '(customer message — open the thread to read)'

    // created_at = the message's real time, so it sits in the right place in the
    // thread (before the flag note). Deduped by the (watch_item, thread) index.
    const { error } = await admin.from('watch_updates').insert({
      watch_item_id: watchItemId,
      kind: 'helpscout_customer',
      body,
      created_by: null,
      created_by_name: author,
      helpscout_thread_id: String(latest.id),
      created_at: latest.createdAt ?? undefined,
    })
    if (error && error.code !== '23505') {
      console.error('[flag-helpscout-context] insert failed', error.message)
      return json({ error: 'insert failed', detail: error.message }, 500)
    }
    return json({ ok: true, ingested: error ? 0 : 1 })
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    console.error('[flag-helpscout-context] crashed:', msg)
    return json({ error: 'crash', detail: msg }, 500)
  }
})
