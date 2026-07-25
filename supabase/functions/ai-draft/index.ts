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
import { fetchBriefing } from '../_shared/aiDrafts/briefing.ts'
import { runPipeline } from '../_shared/aiDrafts/pipeline.ts'
import { latestCustomerThreadId, mapThreads } from '../_shared/aiDrafts/hsMap.ts'
import { modelId } from '../_shared/aiDrafts/anthropic.ts'
import { classifyEdit } from '../_shared/aiDrafts/feedback.ts'
import { composeNote, shouldPostNote } from '../_shared/aiDrafts/composeNote.ts'
import { normaliseBody } from '../_shared/aiDrafts/htmlText.ts'

type AdminClient = ReturnType<typeof createClient>

// Feedback loop (Phase 3): on a staff reply, compare the sent reply against
// the AI draft we'd produced for that conversation and record how much it was
// edited. Runs regardless of mode — in shadow it measures how close the
// would-have-sent draft was to what the human actually sent; in live it
// measures how much our draft was changed before sending. Fail-safe: any
// ambiguity → no row written, never a wrong one.
async function captureFeedback(admin: AdminClient, conversationId: number | string): Promise<Response> {
  const { data: row, error } = await admin
    .from('ai_drafts')
    .select('id, draft_body, created_at')
    .eq('helpscout_conversation_id', String(conversationId))
    .not('draft_body', 'is', null)
    .is('feedback_matched_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) return json({ error: `feedback lookup failed: ${error.message}` }, 500)
  if (!row) return json({ ok: true, feedback: 'no unmatched draft' })

  const hsAppId = Deno.env.get('HELPSCOUT_APP_ID') ?? ''
  const hsAppSecret = Deno.env.get('HELPSCOUT_APP_SECRET') ?? ''
  if (!hsAppId || !hsAppSecret) return json({ error: 'missing Help Scout env' }, 500)
  const token = await getAccessToken(hsAppId, hsAppSecret)
  const conversation = await fetchConversationWithThreads(token, conversationId)
  if (!conversation) return json({ ok: true, feedback: 'conversation not found' })

  const threads = conversation._embedded?.threads ?? []
  const draftCreatedMs = Date.parse((row.created_at as string) ?? '0')
  // Newest PUBLISHED staff reply sent at/after our draft was created. The
  // state guard excludes our own unsent draft; the time guard excludes any
  // older staff reply that predates the draft.
  const sent = threads
    .filter((t) =>
      t.createdBy?.type === 'user' &&
      t.state !== 'draft' &&
      (t.type === 'message' || t.type === 'reply') &&
      (t.body ?? '').trim() !== '' &&
      Date.parse(t.createdAt ?? '0') >= draftCreatedMs)
    .sort((a, b) => Date.parse(b.createdAt ?? '0') - Date.parse(a.createdAt ?? '0'))[0]
  if (!sent) return json({ ok: true, feedback: 'no sent staff reply yet' })

  const sentText = normaliseBody(sent.body ?? '')
  const { similarity, editClass } = classifyEdit(row.draft_body as string, sentText)
  const { error: updErr } = await admin
    .from('ai_drafts')
    .update({
      sent_body: sentText.slice(0, 8000),
      sent_at: sent.createdAt ?? new Date().toISOString(),
      edit_similarity: similarity,
      edit_class: editClass,
      feedback_matched_at: new Date().toISOString(),
    })
    .eq('id', row.id)
    .is('feedback_matched_at', null) // race guard: first writer wins
  if (updErr) return json({ error: `feedback update failed: ${updErr.message}` }, 500)
  return json({ ok: true, feedback: editClass, similarity })
}

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

    // Feedback branch: a staff reply event captures sent-vs-draft, regardless
    // of mode and without the drafting path. Returns early.
    if (event && /agent\.reply/i.test(event)) {
      return await captureFeedback(admin, conversationId)
    }

    // Mode gate first — 'off' must cost nothing.
    const { data: settings, error: settingsError } = await admin
      .from('settings')
      .select('ai_drafts_mode, ai_drafts_triage_model, ai_drafts_model')
      .limit(1)
      .single()
    if (settingsError) return json({ error: `settings read failed: ${settingsError.message}` }, 500)
    const mode = (settings?.ai_drafts_mode ?? 'off') as 'off' | 'shadow' | 'live'
    if (mode === 'off') return json({ ok: true, skipped: 'ai_drafts_mode off' })
    // Admin-set draft model; empty/null → env AI_DRAFT_MODEL → compiled default.
    const draftModel = ((settings?.ai_drafts_model as string | null) ?? '').trim() || undefined
    // Admin-set triage model (cost lever). The raw setting is what we store on
    // the ledger (null = "same as the draft model"); the RESOLVED value is what
    // the call uses, and it must fall back to the draft model rather than to
    // modelId(), or picking a draft model while leaving triage on "Default"
    // would silently run triage on a different model than the label promises.
    const triageModelSetting = ((settings?.ai_drafts_triage_model as string | null) ?? '').trim() || null
    const triageModel = triageModelSetting ?? draftModel

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
      primaryCustomer?: { id?: number; first?: string; email?: string }
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
        model: draftModel ?? modelId(),
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

    // The pipeline proper. Briefing (house rules + exemplars) comes from the
    // admin-editable DB tables via the service-role client, falling back to the
    // compiled constants on any error (briefing.ts). Grounding (live pricing)
    // stays on the anon RPC path.
    const grounding = await fetchGrounding()
    const briefing = await fetchBriefing(admin)
    const result = await runPipeline(
      {
        conversationId,
        subject: conv.subject ?? '(no subject)',
        customerFirstName: conv.primaryCustomer?.first ?? '',
        senderEmail: conv.primaryCustomer?.email,
        thread,
      },
      grounding,
      briefing,
      triageModel,
      draftModel,
    )

    // Compose the structured internal note once (text for the ledger, HTML
    // for Help Scout where newlines collapse).
    const noteInput = {
      classification: result.classification,
      draft: result.draft,
      outcome: result.outcome,
      abstainOrBlockReason: result.abstainOrBlockReason,
      guardrails: result.guardrails,
    }
    const note = composeNote(noteInput)
    // Only post a Help Scout note when it earns its place — a clean draft (no
    // before-you-send check, no easily-missed context) gets none; the draft and
    // the ai-draft tag are the signal. Blocks always note; abstentions only with
    // a handoff action or context. (The full working still lands in the ledger
    // text below for the admin panel, whether or not a note is posted.)
    const postNote = shouldPostNote(noteInput)

    // Live mode: create the Help Scout artefacts for passed drafts; notes for
    // action-note abstentions too (that triage signal is the point).
    // Order matters: Help Scout sorts threads by creation time (newest last),
    // so the NOTE is created first and the DRAFT second — that way the draft is
    // the most recent thing in the thread, sitting right where the reviewer
    // picks up to read and send.
    let hsDraftThreadId: string | null = null
    let hsNoteThreadId: string | null = null
    if (mode === 'live') {
      const userId = Number(Deno.env.get('HELPSCOUT_DEFAULT_USER_ID') ?? '0')
      const customerId = conv.primaryCustomer?.id
      if (postNote && note.html && userId) {
        hsNoteThreadId = await createNote(token, conversationId, userId, note.html)
      }
      if (result.outcome === 'drafted' && result.draft?.draft_body && userId && customerId) {
        hsDraftThreadId = await createDraftReply(
          token, conversationId, customerId, userId, result.draft.draft_body,
        )
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
        // For a skipped (non-customer) email, record WHICH kind it was so the
        // panel can show proper spam separately from suppliers/notifications.
        // Null for everything the drafter actually engaged with.
        skip_kind: result.outcome === 'skipped' ? result.classification.non_customer_kind : null,
        summary: result.classification.summary,
        draft_body: result.draft?.draft_body ?? null,
        // Keep the full working in the ledger for the admin panel even when no
        // Help Scout note was posted (clean drafts) — only genuine skips have none.
        note_body: result.outcome === 'skipped' ? null : note.text,
        abstain_or_block_reason: result.abstainOrBlockReason,
        note_warnings: result.noteWarnings,
        usage_input: result.usage.inputTokens,
        usage_output: result.usage.outputTokens,
        usage_cache_write: result.usage.cacheWriteTokens,
        usage_cache_read: result.usage.cacheReadTokens,
        // Per-call cost split: the triage call's own usage + the model it ran on
        // (the setting, or null = same as the draft model). Lets the panel price
        // triage at its own rate so a cheaper triage model shows the real saving.
        usage_triage_input: result.triageUsage?.inputTokens ?? null,
        usage_triage_output: result.triageUsage?.outputTokens ?? null,
        usage_triage_cache_write: result.triageUsage?.cacheWriteTokens ?? null,
        usage_triage_cache_read: result.triageUsage?.cacheReadTokens ?? null,
        triage_model: triageModelSetting,
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
