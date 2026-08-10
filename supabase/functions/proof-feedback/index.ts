// Records "not ready to approve" feedback from the customer proof page: a
// face-saving reason (price / different direction / timing / going elsewhere /
// still thinking) plus an optional note and the recovery offer that was shown.
// Writes a proofs.proof_feedback row and posts an internal Help Scout note so the
// designer can follow up. This is NOT an approval state — the proof stays open
// and the customer can still approve later. See migration 000279 +
// docs/conversion analysis.
//
// set_discard mode (bundle orders Slice 3, migration 000311): the set review
// page (/set/:id) reuses this function for "decide against this card". Same
// feedback row and reasons, plus body.set_discard = true, which additionally
// stamps proofs.set_discarded_at so the card drops out of the set's active
// checklist. The Help Scout note is reworded, and the conversation is NOT
// moved to Customer Support — the customer is still actively reviewing the
// rest of the set, so it stays with Graphics.
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

// PATCH the conversation to active so the feedback surfaces in the team queue —
// a note alone never changes status, so it would sit unseen on a pending thread.
async function setConversationActive(token: string, conversationId: number | string): Promise<void> {
  const resp = await fetch(`https://api.helpscout.net/v2/conversations/${conversationId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ op: 'replace', path: '/status', value: 'active' }),
  })
  if (!resp.ok) throw new Error(`HS set-active (${resp.status}): ${await resp.text().catch(() => '')}`)
}

// Move the conversation to another mailbox (commercial feedback → Customer Support).
async function moveConversation(token: string, conversationId: number | string, mailboxId: number): Promise<void> {
  const resp = await fetch(`https://api.helpscout.net/v2/conversations/${conversationId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ op: 'move', path: '/mailboxId', value: mailboxId }),
  })
  if (!resp.ok) throw new Error(`HS move (${resp.status}): ${await resp.text().catch(() => '')}`)
}

const REASON_LABELS: Record<string, string> = {
  price_too_high: 'Price is more than budgeted',
  different_direction: 'Would like a different design direction',
  timing: 'Timing — not ready yet',
  going_elsewhere: 'Going a different route / no longer needed',
  still_thinking: 'Still thinking / needs to check with others',
}

// Commercial reasons are routed to the Customer Support mailbox (id 33103, the
// verified CS inbox); 'different_direction' is a design revision so it stays in
// Graphics and is only marked active.
const COMMERCIAL_REASONS = new Set(['price_too_high', 'timing', 'going_elsewhere', 'still_thinking'])
const CUSTOMER_SUPPORT_MAILBOX_ID = 33103

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
  // Set review page's "decide against this card" (Slice 3) — see header.
  const setDiscard = body.set_discard === true

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
    .select('id, helpscout_conversation_id, proof_set_id, status, reengagement_context')
    .eq('id', proofId)
    .maybeSingle()
  if (proofErr) return json({ error: 'lookup failed', detail: proofErr.message }, 500)
  if (!proof) return json({ error: 'proof not found' }, 404)

  // A set discard only makes sense for a card that IS in a set and is not
  // already approved (nothing approved is lost — spec §7.4). Reject early so
  // the feedback row and the stamp can't disagree.
  const proofSetId = (proof as { proof_set_id: string | null }).proof_set_id
  if (setDiscard) {
    if (!proofSetId) return json({ error: 'proof is not part of a set' }, 400)
    if ((proof as { status: string }).status === 'approved') {
      return json({ error: 'approved cards cannot be set aside' }, 400)
    }
  }

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

  // Set discard: stamp the card as set aside so the review page's checklist
  // drops it. NOT best-effort — the front door's "removed" state depends on
  // it, so a failure surfaces to the customer as a retryable error (the extra
  // feedback row a retry leaves behind is harmless append-only history).
  if (setDiscard) {
    const { error: discardErr } = await admin
      .from('proofs')
      .update({ set_discarded_at: new Date().toISOString() })
      .eq('id', proofId)
      .is('set_discarded_at', null)
    if (discardErr) return json({ error: 'discard failed', detail: discardErr.message }, 500)
  }

  // Terminal reason → stop automated follow-up nudges for this proof. Reuses the
  // existing per-proof opt-out the nudge pipeline already honours
  // (compute_nudge_candidates exposes auto_nudge_disabled → nudgeDecision returns
  // 'skipped_opted_out'), so no change to the nudge automation. Only set when not
  // already opted out, so an existing opt-out timestamp isn't moved. Best-effort:
  // the feedback is already recorded; a failure here is logged, not fatal.
  if (reasonCode === 'going_elsewhere') {
    const { error: stopErr } = await admin
      .from('proofs')
      .update({ auto_nudge_disabled_at: new Date().toISOString() })
      .eq('id', proofId)
      .is('auto_nudge_disabled_at', null)
    if (stopErr) console.error('[proof-feedback] stop-nudges failed:', stopErr.message)
  }

  // ── Tell the Reorder desk to stand down ──────────────────────────────────
  //
  // Re-engagement outreach only (000392): this proof exists because WE
  // approached a past customer, and the desk chases silence. Saying "not right
  // now" is the opposite of silence — but nothing else records it. The Help
  // Scout write below is an internal NOTE, which fires no reply event and so
  // stamps nothing (verified live: the one existing proof_feedback row's proof
  // carries no matching reply stamp, while proof-action's customer-thread posts
  // stamp within seconds). Without this the desk reads the decline as silence
  // and either chases them again or quiet-closes the project — setting it
  // `abandoned`, which turns the page they just used into "This proof is
  // closed".
  //
  // src/lib/reorderDesk.ts customerRepliedSinceContact() reads exactly this
  // column, so the row moves to `replied` and the desk steps back — reversibly
  // and visibly, rather than writing a terminal outcome. ⚠ Deliberately NOT a
  // write to reorder_prospects: that row is keyed on the past CUSTOMER, not
  // this proof, and /p/:id is handed around by team sharing — so one click by
  // anyone holding the link would permanently foreclose all future outreach to
  // them. Every anon write reachable from this page is additive and
  // human-reviewed; recording the terminal outcome stays a designer's job.
  //
  // Awaited, not `void`: a bare PostgREST builder never sends (CLAUDE.md,
  // "supabase-js queries are lazy"). Best-effort — a stamp failure must not
  // cost the customer their feedback.
  if ((proof as { reengagement_context: unknown }).reengagement_context != null) {
    const stampIso = new Date().toISOString()
    const { error: stampErr } = await admin
      .from('proofs')
      .update({ helpscout_last_customer_reply_at: stampIso })
      .eq('id', proofId)
      // The same GREATEST guard helpscout-webhook uses: a genuine later email
      // reply must never be regressed by this.
      .or(`helpscout_last_customer_reply_at.is.null,helpscout_last_customer_reply_at.lt.${stampIso}`)
    if (stampErr) console.error('[proof-feedback] reply stamp failed:', stampErr.message)
  }

  // Best-effort Help Scout note so the designer sees the reason and can follow
  // up. Deferred so it never adds latency or fails the customer's submit.
  const conversationId = (proof as { helpscout_conversation_id: string | null }).helpscout_conversation_id
  if (conversationId) {
    const syncHs = async () => {
      const appId = Deno.env.get('HELPSCOUT_APP_ID')?.trim()
      const appSecret = Deno.env.get('HELPSCOUT_APP_SECRET')?.trim()
      if (!appId || !appSecret) return
      let token: string
      try {
        token = await getAccessToken(appId, appSecret)
      } catch (err) {
        console.error('[proof-feedback] HS token failed:', (err as Error).message)
        return
      }
      // 1. Internal note alerting the designer (needs a staff user id).
      const userId = Number(Deno.env.get('HELPSCOUT_DEFAULT_USER_ID') ?? '')
      if (Number.isFinite(userId)) {
        try {
          const base = (Deno.env.get('PROOF_VIEWER_BASE_URL') ?? '').replace(/\/$/, '')
          const link = base ? `\nProof: ${base}/proofs/${proofId}` : ''
          const who = actorName ? ` from ${actorName}` : ''
          const noteText = setDiscard
            ? `🔔 Bundle review${who} — a card was set aside.\n` +
              `Reason: ${REASON_LABELS[reasonCode]}.` +
              (note ? `\n“${note}”` : '') +
              `\n\nThe rest of the bundle is unaffected — the card can be restored from the bundle workspace.` +
              (reasonCode === 'going_elsewhere' ? '\nAutomated reminders for this card have been stopped.' : '') +
              link
            : `🔔 Customer feedback${who} — not ready to approve.\n` +
              `Reason: ${REASON_LABELS[reasonCode]}.` +
              (note ? `\n“${note}”` : '') +
              offerSummary(recoveryOffer, currency) +
              `\n\n${reasonCode === 'going_elsewhere' ? 'Automated reminders for this proof have been stopped.' : 'Worth a personal follow-up.'}${link}`
          await createNote(token, conversationId, userId, noteText)
        } catch (err) {
          console.error('[proof-feedback] HS note failed:', (err as Error).message)
        }
      }
      // 2. Mark active so it surfaces in the team queue (a note never reactivates).
      try {
        await setConversationActive(token, conversationId)
      } catch (err) {
        console.error('[proof-feedback] HS set-active failed:', (err as Error).message)
      }
      // 3. Commercial feedback → Customer Support; 'different_direction' stays in
      //    Graphics as a design revision. Set discards NEVER move the
      //    conversation — the customer is still actively reviewing the rest
      //    of the set, so it stays with Graphics whatever the reason.
      if (COMMERCIAL_REASONS.has(reasonCode) && !setDiscard) {
        try {
          await moveConversation(token, conversationId, CUSTOMER_SUPPORT_MAILBOX_ID)
        } catch (err) {
          console.error('[proof-feedback] HS move failed:', (err as Error).message)
        }
      }
    }
    if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(syncHs())
    else await syncHs()
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
