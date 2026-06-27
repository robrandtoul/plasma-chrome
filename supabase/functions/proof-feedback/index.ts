// Records "not ready to approve" feedback from the customer proof page: a
// face-saving reason (price / different direction / timing / going elsewhere /
// still thinking) plus an optional note and the recovery offer that was shown.
// Writes a proofs.proof_feedback row and posts an internal Help Scout note so the
// designer can follow up. This is NOT an approval state — the proof stays open
// and the customer can still approve later. See migration 000279 +
// docs/conversion analysis.
//
// Deliberately separate from proof-action (the critical approve / request-changes
// path) to keep that function untouched. Anon (verify_jwt = false) — the customer
// page is unauthenticated, same trust model as proof-action: anyone with the
// proof link can submit feedback, which is low-stakes.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, HELPSCOUT_APP_ID,
//      HELPSCOUT_APP_SECRET, HELPSCOUT_DEFAULT_USER_ID, PROOF_VIEWER_BASE_URL.

import { createClient } from 'jsr:@supabase/supabase-js@2'

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined

// Inlined Help Scout helpers (same shape as _shared/helpscout.ts) so this
// function is self-contained and deploys as a single file.
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

const REASON_LABELS: Record<string, string> = {
  price_too_high: 'Price is more than budgeted',
  different_direction: 'Would like a different design direction',
  timing: 'Timing — not ready yet',
  going_elsewhere: 'Going a different route / no longer needed',
  still_thinking: 'Still thinking / needs to check with others',
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

interface RecoveryOffer {
  lower_quantity?: { quantity: number; total: number } | null
  cheaper_materials?: Array<{ display_name: string; from_total: number }> | null
  discount_percent?: number | null
}

function offerSummary(offer: RecoveryOffer | null, currency: string | null): string {
  if (!offer) return ''
  const ccy = currency ?? ''
  const parts: string[] = []
  if (offer.lower_quantity) parts.push(`lower qty ${offer.lower_quantity.quantity} (${ccy} ${offer.lower_quantity.total})`)
  if (offer.cheaper_materials && offer.cheaper_materials.length > 0) {
    parts.push(`cheaper materials shown: ${offer.cheaper_materials.map((m) => m.display_name).join(', ')}`)
  }
  if (offer.discount_percent && offer.discount_percent > 0) parts.push(`${offer.discount_percent}% discount offered`)
  return parts.length ? `\nRecovery shown: ${parts.join('; ')}.` : ''
}

async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json({ error: 'invalid JSON' }, 400)
  }

  const proofId = String(body.proof_id ?? '')
  const proofVersionId = body.proof_version_id ? String(body.proof_version_id) : null
  const reasonCode = String(body.reason_code ?? '')
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 2000) : null
  const actorName = typeof body.actor_name === 'string' ? body.actor_name.trim().slice(0, 200) : null
  const recoveryOffer = (body.recovery_offer as RecoveryOffer | undefined) ?? null

  if (!UUID_RE.test(proofId)) return json({ error: 'invalid proof_id' }, 400)
  if (proofVersionId && !UUID_RE.test(proofVersionId)) return json({ error: 'invalid proof_version_id' }, 400)
  if (!REASON_LABELS[reasonCode]) return json({ error: 'invalid reason_code' }, 400)

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  if (!supabaseUrl || !serviceKey) return json({ error: 'missing supabase env' }, 500)

  const admin = createClient(supabaseUrl, serviceKey, {
    db: { schema: 'proofs' },
    auth: { persistSession: false, autoRefreshToken: false },
  })

  // Resolve the proof: confirm it exists, get its HS conversation + current
  // version currency. A bad proof_id is rejected so we don't store orphan rows.
  const { data: proof, error: proofErr } = await admin
    .from('proofs')
    .select('id, helpscout_conversation_id')
    .eq('id', proofId)
    .maybeSingle()
  if (proofErr) return json({ error: 'lookup failed', detail: proofErr.message }, 500)
  if (!proof) return json({ error: 'proof not found' }, 404)

  let currency: string | null = null
  if (proofVersionId) {
    const { data: ver } = await admin
      .from('proof_versions')
      .select('currency')
      .eq('id', proofVersionId)
      .maybeSingle()
    currency = (ver?.currency as string | undefined) ?? null
  }

  const fromIp = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || null
  const fromUa = req.headers.get('user-agent') ?? null

  const { data: inserted, error: insErr } = await admin
    .from('proof_feedback')
    .insert({
      proof_id: proofId,
      proof_version_id: proofVersionId,
      reason_code: reasonCode,
      note,
      recovery_offer: recoveryOffer,
      actor_name: actorName,
      currency,
      from_ip: fromIp,
      from_ua: fromUa,
    })
    .select('id')
    .single()
  if (insErr) return json({ error: 'insert failed', detail: insErr.message }, 500)

  // Best-effort Help Scout note so the designer sees the reason and can follow
  // up. Deferred so it never adds latency or fails the customer's submit.
  const conversationId = (proof as { helpscout_conversation_id: string | null }).helpscout_conversation_id
  if (conversationId) {
    const postNote = async () => {
      try {
        const appId = Deno.env.get('HELPSCOUT_APP_ID')?.trim()
        const appSecret = Deno.env.get('HELPSCOUT_APP_SECRET')?.trim()
        const userId = Number(Deno.env.get('HELPSCOUT_DEFAULT_USER_ID') ?? '')
        if (!appId || !appSecret || !Number.isFinite(userId)) return
        const token = await getAccessToken(appId, appSecret)
        const base = (Deno.env.get('PROOF_VIEWER_BASE_URL') ?? '').replace(/\/$/, '')
        const link = base ? `\nProof: ${base}/proofs/${proofId}` : ''
        const who = actorName ? ` from ${actorName}` : ''
        const noteText =
          `🔔 Customer feedback${who} — not ready to approve.\n` +
          `Reason: ${REASON_LABELS[reasonCode]}.` +
          (note ? `\n“${note}”` : '') +
          offerSummary(recoveryOffer, currency) +
          `\n\nWorth a personal follow-up.${link}`
        await createNote(token, conversationId, userId, noteText)
      } catch (err) {
        console.error('[proof-feedback] HS note failed:', (err as Error).message)
      }
    }
    if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(postNote())
    else await postNote()
  }

  return json({ status: 'ok', id: (inserted as { id: string }).id })
}

Deno.serve(async (req) => {
  try {
    return await handle(req)
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    console.error('[proof-feedback] crashed:', msg)
    return json({ error: 'crash', detail: msg }, 500)
  }
})
