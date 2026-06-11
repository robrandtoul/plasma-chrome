// AI draft worker (Phase 2 of docs/ai-draft-pipeline-spec.md).
//
// Triggered by helpscout-webhook (fire-and-forget, service-role auth) when a
// conversation is created in / moved to Customer Support, or a customer
// replies there. Runs the same pipeline the backtest proved:
// classify → ground in live pricing → draft + working note → hard guardrails.
//
// Modes (proofs.settings.ai_drafts_mode):
//   off    — no-op (default).
//   shadow — full pipeline, results land ONLY in the proofs.ai_drafts ledger.
//   live   — additionally creates the Help Scout draft reply (draft: true —
//            never emailed until a human sends it), the internal note with
//            the working, and the ai-draft tag.
//
// Concurrency/dedupe: claim-first — a ledger row is inserted under a unique
// dedupe key (conversation + newest customer thread) BEFORE any AI work, so
// Help Scout webhook retries are no-ops while a new customer message
// legitimately re-triggers (stale-draft regeneration).
//
// Auth: service-role only — same gate as send-nudges (exact injected key, or
// a platform-verified JWT carrying the service_role claim).

import { createClient } from 'jsr:@supabase/supabase-js@2'
import {
  addConversationTag,
  createDraftReply,
  createNote,
  fetchConversationWithThreads,
  getAccessToken,
} from '../_shared/helpscout.ts'
import { fetchGrounding } from '../_shared/aiDrafts/grounding.ts'
import { runPipeline } from '../_shared/aiDrafts/pipeline.ts'
import { latestCustomerThreadId, mapThreads } from '../_shared/aiDrafts/hsMap.ts'
import { modelId } from '../_shared/aiDrafts/anthropic.ts'

const CUSTOMER_SUPPORT_MAILBOX_ID = Number(
  Deno.env.get('CUSTOMER_SUPPORT_MAILBOX_ID') ?? '33103',
)

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// Role claim from a JWT payload without signature verification — safe here
// because the platform has already verified the JWT (verify_jwt = true).
function bearerRole(token: string): string | null {
  try {
    const payload = token.split('.')[1]
    const decoded = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')))
    return typeof decoded?.role === 'string' ? decoded.role : null
  } catch {
    return null
  }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  if (!serviceKey || !supabaseUrl) return json({ error: 'missing supabase env' }, 500)

  const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  const authorised = bearer !== '' &&
    (timingSafeEqual(bearer, serviceKey) || bearerRole(bearer) === 'service_role')
  if (!authorised) return json({ error: 'forbidden' }, 403)

  const admin = createClient(supabaseUrl, serviceKey, {
    db: { schema: 'proofs' },
    auth: { persistSession: false, autoRefreshToken: false },
  })

  let ledgerId: string | null = null
  try {
    const { conversationId, event } = await req.json() as {
      conversationId?: number | string
      event?: string
    }
    if (conversationId == null) return json({ error: 'conversationId required' }, 400)

    // Mode gate first — 'off' must cost nothing.
    const { data: settings, error: settingsError } = await admin
      .from('settings')
      .select('ai_drafts_mode')
      .limit(1)
      .single()
    if (settingsError) return json({ error: `settings read failed: ${settingsError.message}` }, 500)
    const mode = (settings?.ai_drafts_mode ?? 'off') as 'off' | 'shadow' | 'live'
    if (mode === 'off') return json({ ok: true, skipped: 'ai_drafts_mode off' })

    // Fetch the conversation (needed for the dedupe anchor and everything else).
    const hsAppId = Deno.env.get('HELPSCOUT_APP_ID') ?? ''
    const hsAppSecret = Deno.env.get('HELPSCOUT_APP_SECRET') ?? ''
    if (!hsAppId || !hsAppSecret) return json({ error: 'missing Help Scout env' }, 500)
    const token = await getAccessToken(hsAppId, hsAppSecret)
    const conversation = await fetchConversationWithThreads(token, conversationId)
    if (!conversation) return json({ ok: true, skipped: 'conversation not found' })

    const conv = conversation as typeof conversation & {
      mailboxId?: number
      status?: string
      subject?: string
      tags?: { tag?: string }[]
      primaryCustomer?: { id?: number; first?: string }
    }
    if (conv.mailboxId !== CUSTOMER_SUPPORT_MAILBOX_ID) {
      return json({ ok: true, skipped: 'not customer support mailbox' })
    }
    if (conv.status === 'closed' || conv.status === 'spam') {
      return json({ ok: true, skipped: `status ${conv.status}` })
    }

    const hsThreads = conv._embedded?.threads ?? []
    const thread = mapThreads(hsThreads)
    const anchorId = latestCustomerThreadId(hsThreads)
    if (!thread.some((m) => m.role === 'customer') || anchorId == null) {
      return json({ ok: true, skipped: 'no customer message' })
    }

    // Claim-first dedupe: one attempt per (conversation, newest customer thread).
    const dedupeKey = `${conversationId}:${anchorId}`
    const { data: claimed, error: claimError } = await admin
      .from('ai_drafts')
      .insert({
        helpscout_conversation_id: String(conversationId),
        trigger_event: event ?? 'unknown',
        trigger_thread_id: String(anchorId),
        dedupe_key: dedupeKey,
        state: 'processing',
        mode,
        model: modelId(),
      })
      .select('id')
      .single()
    if (claimError) {
      if (claimError.code === '23505') {
        return json({ ok: true, skipped: 'duplicate (already claimed)' })
      }
      return json({ error: `claim failed: ${claimError.message}` }, 500)
    }
    ledgerId = claimed.id

    // The pipeline proper.
    const grounding = await fetchGrounding()
    const result = await runPipeline(
      {
        conversationId,
        subject: conv.subject ?? '(no subject)',
        customerFirstName: conv.primaryCustomer?.first ?? '',
        thread,
      },
      grounding,
    )

    // Live mode: create the Help Scout artefacts for passed drafts; notes for
    // action-note abstentions too (that triage signal is the point).
    let hsDraftThreadId: string | null = null
    let hsNoteThreadId: string | null = null
    if (mode === 'live') {
      const userId = Number(Deno.env.get('HELPSCOUT_DEFAULT_USER_ID') ?? '0')
      const customerId = conv.primaryCustomer?.id
      if (result.outcome === 'drafted' && result.draft?.draft_body && userId && customerId) {
        hsDraftThreadId = await createDraftReply(
          token, conversationId, customerId, userId, result.draft.draft_body,
        )
      }
      const noteText = result.draft?.note_body
      if (noteText && userId && (result.outcome === 'drafted' || result.outcome === 'abstained')) {
        hsNoteThreadId = await createNote(token, conversationId, userId, `AI draft pipeline\n\n${noteText}`)
      }
      if (result.outcome === 'drafted') {
        const existingTags = (conv.tags ?? []).map((t) => t.tag ?? '').filter(Boolean)
        await addConversationTag(token, conversationId, existingTags, 'ai-draft').catch((err) => {
          console.error('[ai-draft] tag add failed (cosmetic):', err?.message)
        })
      }
    }

    const { error: updateError } = await admin
      .from('ai_drafts')
      .update({
        state: mode === 'shadow' ? 'shadow' : result.outcome,
        category: result.classification.category,
        confidence: result.classification.confidence,
        summary: result.classification.summary,
        draft_body: result.draft?.draft_body ?? null,
        note_body: result.draft?.note_body ?? null,
        abstain_or_block_reason: result.abstainOrBlockReason,
        note_warnings: result.noteWarnings,
        usage_input: result.usage.inputTokens,
        usage_output: result.usage.outputTokens,
        hs_draft_thread_id: hsDraftThreadId,
        hs_note_thread_id: hsNoteThreadId,
        completed_at: new Date().toISOString(),
      })
      .eq('id', ledgerId)
    if (updateError) {
      console.error('[ai-draft] ledger update failed:', updateError.message)
    }

    return json({ ok: true, outcome: result.outcome, mode, ledgerId })
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    console.error('[ai-draft] crashed:', msg, err instanceof Error ? err.stack : '')
    if (ledgerId) {
      await admin
        .from('ai_drafts')
        .update({ state: 'failed', error: msg.slice(0, 1000), completed_at: new Date().toISOString() })
        .eq('id', ledgerId)
    }
    return json({ error: 'crash', detail: msg }, 500)
  }
})
