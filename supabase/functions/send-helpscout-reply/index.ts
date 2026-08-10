// Post a reply to a Help Scout conversation on behalf of a designer.
// Ship 2 of intervention 3.
//
// Auth: requireDesigner (admin or designer role, active account).
// The conversation_id is read off the proofs row server-side so a
// tampered proof_id cannot be weaponised to post into arbitrary
// Help Scout threads. Defence in depth: the designer is gated by
// role, AND the conversation is sourced from the linked proof.
//
// Required secrets:
//   HELPSCOUT_APP_ID, HELPSCOUT_APP_SECRET — OAuth client credentials.
//   HELPSCOUT_DEFAULT_USER_ID — numeric Help Scout staff user id used
//   as the fallback `user` field on the reply when the designer's
//   profile row has no helpscout_user_id mapping.
//
// Per-designer attribution (added in migration 000123):
//   profiles.helpscout_user_id is a nullable integer. When non-null
//   for the calling designer, that value is used as the `user` field
//   instead of HELPSCOUT_DEFAULT_USER_ID. Designers without a mapping
//   silently fall through to the env var — the path that existed
//   before per-designer attribution shipped, so no regression.
//
// POST body:
//   { proof_id: string, version_id: string, body: string,
//     template_id?: string, hs_status?: 'pending' | 'closed' }
//
// template_id is the reply_templates id the editor was seeded from. It is
// a label only (the client renders and can freely edit the body), never
// proof of content. When it is a 'nudge_*' template, a proof_nudges ledger
// row is recorded after the send — see the block below the HS POST.
//
// hs_status is the state the Help Scout conversation is left in. It defaults
// to 'pending' (the historical, and still overwhelmingly common, behaviour:
// the designer is asking the customer to review a proof, so the thread belongs
// in the customer's queue). 'closed' exists for the project-abandoned notice,
// which ends the exchange rather than opening one — see postReply. Anything
// unrecognised falls back to 'pending', so the six existing call sites
// (MessageSendPanel, OrderBuilderModal, SendPayLinkModal, GroupOrdersModal,
// RecordOfflinePaymentModal, SetWorkspacePage) are untouched and NEITHER
// deploy order breaks. They are not quite symmetric, though: shipping the
// frontend first means an abandon notice posts with status 'pending' while
// the dialog says the conversation was closed — cosmetic and self-correcting
// on the redeploy, but redeploy this function promptly.
//
// Response (200):
//   { thread_id: number }
//
// Response (4xx/5xx):
//   { error: string, ...optional debug fields }
//
// ── Diagnostics ──────────────────────────────────────────────────────────────
//
// Every meaningful step logs a one-line breadcrumb via console.log so
// the Supabase function-runtime log viewer shows where a request got
// to. The outer try/catch serialises err.name + err.message + a stack
// snippet into the JSON body; if the Supabase platform converts a
// thrown response into EDGE_FUNCTION_ERROR before our handler can
// return, the breadcrumbs in the runtime log are the only signal.
// Keep this verbose until the send pipeline is proven stable.

import { requireDesigner } from '../_shared/admin.ts'
import {
  createStaffConversation,
  fetchConversation,
  getAccessToken,
  HsError,
  postStaffReply,
} from '../_shared/helpscout.ts'
import { messageBodyToHtml } from '../_shared/messageHtml.ts'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const MAX_BODY_BYTES = 10 * 1024  // 10KB sanity cap; rare to hit.

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

function debugFromError(err: unknown): { name: string; message: string; stack: string } {
  const e = err as Error
  return {
    name: e?.name ?? 'Error',
    message: e?.message ?? String(err),
    stack: (e?.stack ?? '').split('\n').slice(0, 6).join('\n'),
  }
}

interface SendReplyResult {
  thread_id: number
  /** Set only when the linked conversation was sealed for age and the message
   *  went out on a NEW one instead. The proof has been re-pointed at it; the
   *  caller may want to say so rather than silently swapping the link. */
  new_conversation_id?: string
}

// Help Scout's reply endpoint requires customer.id explicitly,
// despite earlier docs suggesting it falls back to primaryCustomer
// when omitted. A 400 with `path: "customer", message: "must not be
// null"` is the symptom when missing. Resolve the conversation's
// primary customer id with a quick GET first, then include it in
// the reply body. Throws HsError when the conversation is missing
// (404), the GET fails for any other reason (passes status), or
// the conversation has no primary customer to attribute the reply
// to (502 — unusual; would need designer intervention in HS).
async function fetchConversationContext(
  token: string,
  conversationId: string,
): Promise<{ customerId: number; mailboxId: number | null; subject: string | null }> {
  console.log('[send-helpscout-reply] GET conversation for primary customer')
  const conv = await fetchConversation(token, conversationId)
  if (!conv) {
    throw new HsError(404, 'Help Scout conversation not found')
  }
  const customerId = conv.primaryCustomer?.id
  if (!customerId || typeof customerId !== 'number') {
    throw new HsError(
      502,
      'Help Scout conversation has no primary customer; cannot attribute reply.',
    )
  }
  console.log('[send-helpscout-reply] fetched primary customer', { id: customerId })
  // Mailbox and subject are only needed if the reply turns out to be
  // impossible and we have to open a fresh conversation instead (see
  // isLockedForAge). Reading them here costs nothing — it is the same GET.
  return { customerId, mailboxId: conv.mailboxId ?? null, subject: conv.subject ?? null }
}

/**
 * Help Scout refuses to update a conversation once it is older than the
 * account's retention policy: 412 Precondition Failed, "Conversation locked -
 * conversation is older than company policy allows and cannot be updated
 * further."
 *
 * ⚠ This is NOT an edge case for us, it is the normal state of a re-engagement.
 * The Reorder desk exists to contact customers who last bought years ago, and
 * the new-proof form helpfully links their old thread — which is exactly the
 * thread Help Scout has since sealed. It hit on the very first desk send.
 * supabase/functions/request-reorder already reasons this way for the customer
 * side ("a reorder months or years later cannot reuse the original"); this is
 * the same fact reaching the designer side.
 *
 * Matched on the documented error slug as well as the prose, so a reworded
 * message doesn't silently turn this back into a dead end.
 */
function isLockedForAge(err: unknown): boolean {
  if (!(err instanceof HsError) || err.status !== 412) return false
  const m = err.message.toLowerCase()
  return m.includes('conversation-locked-age') || m.includes('conversation locked')
}

// Wrapper around the shared postStaffReply helper. Adds the
// diagnostic console.log breadcrumbs this file relies on (see the
// header docstring) and shapes the result as { thread_id } for the
// existing call site.
//
// Status defaults to 'pending' — nearly every send here is the designer
// asking the customer to review a proof, so the conversation belongs in the
// customer's queue. The one exception is the abandon notice, which passes
// 'closed': that message ENDS the exchange, and leaving a closed-off project
// sitting in Pending would put it straight back in the chase queue the
// designer just took it out of. Help Scout reopens the conversation on its own
// if the customer replies.
async function postReply(
  token: string,
  conversationId: string,
  text: string,
  userId: number,
  customerId: number,
  hsStatus: 'pending' | 'closed',
): Promise<SendReplyResult> {
  console.log('[send-helpscout-reply] POST reply', { conversationId, userId, bodyLen: text.length, hsStatus })
  let threadId = 0
  try {
    threadId = await postStaffReply(token, conversationId, {
      text,
      userId,
      customerId,
      status: hsStatus,
    })
  } catch (err) {
    // Surface the HS response details in the breadcrumb stream
    // before re-throwing, matching the pre-extraction "HS responded"
    // / "parsed thread id" log granularity. The outer handler's
    // catch will format the error response for the client.
    if (err instanceof HsError) {
      console.log('[send-helpscout-reply] HS responded', { status: err.status, ok: false })
    }
    throw err
  }
  console.log('[send-helpscout-reply] HS responded', { status: 201, ok: true })
  console.log('[send-helpscout-reply] parsed thread id', { threadId })
  return { thread_id: threadId }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  // Wrap the entire handler so any uncaught throw inside requireDesigner
  // or the supabase client surfaces as a structured 502 with
  // diagnostics, instead of EDGE_FUNCTION_ERROR with no body.
  try {
    console.log('[send-helpscout-reply] start')

    const check = await requireDesigner(req)
    if (check instanceof Response) return check
    const { admin, callerId } = check
    console.log('[send-helpscout-reply] auth ok', { callerId })

    // Global on/off switch (migration 000104). When replies_enabled
    // is false, the function rejects with 503 before doing any HS
    // work. Used as a trial-week safety surface (default off in the
    // migration) and a kill switch. The frontend's UI disable on
    // MessageSendPanel and the proof detail page Customer reply
    // section is the courtesy layer; this edge-function check is the
    // actual safety surface that stops a stray request from sending
    // a reply when the feature is paused.
    const { data: settingsRow, error: settingsErr } = await admin
      .from('settings')
      .select('replies_enabled')
      .eq('id', 1)
      .single()
    if (settingsErr) {
      console.error('[send-helpscout-reply] settings lookup failed', settingsErr)
      return json({ error: `Settings lookup failed: ${settingsErr.message}` }, 500)
    }
    if (!settingsRow?.replies_enabled) {
      console.log('[send-helpscout-reply] rejected: replies disabled')
      return json({ error: 'Customer replies are currently paused by an admin.' }, 503)
    }
    console.log('[send-helpscout-reply] replies enabled, proceeding')

    // Parse + validate body.
    let proofId: string | undefined
    let versionId: string | undefined
    let body: string | undefined
    let templateId: string | undefined
    // Which state the Help Scout conversation should be left in. Anything
    // other than an explicit 'closed' — absent, misspelt, a stale caller
    // predating this field — falls back to the historical 'pending', so
    // deploying this ahead of any frontend is a no-op for every existing
    // caller.
    let hsStatus: 'pending' | 'closed' = 'pending'
    try {
      const parsed = await req.json()
      proofId = typeof parsed?.proof_id === 'string' ? parsed.proof_id.trim() : undefined
      versionId = typeof parsed?.version_id === 'string' ? parsed.version_id.trim() : undefined
      body = typeof parsed?.body === 'string' ? parsed.body : undefined
      // Optional template label (e.g. 'first_proof', 'nudge_sent_never_viewed').
      // Absent / non-string / blank all collapse to undefined.
      templateId = typeof parsed?.template_id === 'string'
        ? parsed.template_id.trim() || undefined
        : undefined
      if (parsed?.hs_status === 'closed') hsStatus = 'closed'
    } catch (parseErr) {
      console.error('[send-helpscout-reply] body parse failed', parseErr)
      return json({ error: 'Invalid JSON body', debug: debugFromError(parseErr) }, 400)
    }
    if (!proofId) return json({ error: 'proof_id is required' }, 400)
    if (!versionId) return json({ error: 'version_id is required' }, 400)
    if (body == null || body.trim() === '') {
      return json({ error: 'body is required' }, 400)
    }
    if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
      return json({ error: `Reply too long (${MAX_BODY_BYTES} byte cap). Trim and try again.` }, 400)
    }
    console.log('[send-helpscout-reply] body validated', { proofId, versionId, bodyLen: body.length })

    // Look up the proof's HS conversation id server-side. Service-role
    // client bypasses RLS so we can read the column directly.
    const { data: proofRow, error: proofErr } = await admin
      .from('proofs')
      .select('id, helpscout_conversation_id')
      .eq('id', proofId)
      .maybeSingle()
    if (proofErr) {
      console.error('[send-helpscout-reply] proof lookup error', proofErr)
      return json({ error: `Proof lookup failed: ${proofErr.message}` }, 500)
    }
    if (!proofRow) return json({ error: 'Proof not found' }, 404)
    const conversationId = (proofRow as { helpscout_conversation_id: string | null }).helpscout_conversation_id
    if (!conversationId) {
      return json({ error: 'No Help Scout conversation linked to this proof' }, 400)
    }
    console.log('[send-helpscout-reply] conversation linked', { conversationId })

    // Help Scout credentials + sender identity. Trim defensively in
    // case a secret was set with surrounding whitespace.
    const appId = Deno.env.get('HELPSCOUT_APP_ID')?.trim()
    const appSecret = Deno.env.get('HELPSCOUT_APP_SECRET')?.trim()
    const defaultUserId = Deno.env.get('HELPSCOUT_DEFAULT_USER_ID')?.trim()
    if (!appId || !appSecret) {
      return json({ error: 'Help Scout credentials not configured' }, 500)
    }

    // Per-designer attribution (migration 000123). Look up the
    // calling designer's helpscout_user_id off profiles. If non-null,
    // use it as the `user` field on the HS reply; otherwise fall
    // through to HELPSCOUT_DEFAULT_USER_ID. Lookup failure is treated
    // as null — the env-var fallback is the safety net, so a transient
    // DB hiccup on this single field shouldn't block the reply.
    let perDesignerHsId: number | null = null
    {
      const { data: profileRow, error: profileErr } = await admin
        .from('profiles')
        .select('helpscout_user_id')
        .eq('id', callerId)
        .single()
      if (profileErr) {
        console.warn('[send-helpscout-reply] profile lookup failed, falling back to default', profileErr.message)
      } else {
        const v = (profileRow as { helpscout_user_id: number | null } | null)?.helpscout_user_id ?? null
        if (typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v > 0) {
          perDesignerHsId = v
        }
      }
    }

    let userIdNum: number
    if (perDesignerHsId != null) {
      userIdNum = perDesignerHsId
      console.log('[send-helpscout-reply] using per-designer HS id', { userIdNum })
    } else {
      if (!defaultUserId) {
        return json(
          { error: 'HELPSCOUT_DEFAULT_USER_ID secret is not set. An admin must configure a default Help Scout user before replies can be sent.' },
          500,
        )
      }
      const parsed = Number(defaultUserId)
      if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
        return json({ error: `HELPSCOUT_DEFAULT_USER_ID must be a numeric Help Scout user id (got ${JSON.stringify(defaultUserId)}).` }, 500)
      }
      userIdNum = parsed
      console.log('[send-helpscout-reply] using default HS id', { userIdNum })
    }

    // The HS API call path. Errors surface as HsError (from
    // getAccessToken, fetchPrimaryCustomerId, or postReply); other
    // throws fall through to the outer catch.
    let result: SendReplyResult
    try {
      console.log('[send-helpscout-reply] requesting access token')
      const token = await getAccessToken(appId, appSecret)
      console.log('[send-helpscout-reply] got access token')
      const convo = await fetchConversationContext(token, conversationId)
      // Hand Help Scout finished HTML (escaped, URLs wrapped in <a> tags,
      // newlines as <br>) rather than a plain-text body. Help Scout's own
      // nl2br + auto-linking runs in an order that folds a "<br><br>…"
      // following a bare URL into the link's href — the iPhone-404 bug on
      // the first-proof / revision templates, whose copy sits after {url}.
      // See _shared/messageHtml.ts.
      const html = messageBodyToHtml(body)
      try {
        result = await postReply(token, conversationId, html, userIdNum, convo.customerId, hsStatus)
      } catch (replyErr) {
        if (!isLockedForAge(replyErr)) throw replyErr

        // ── The thread is sealed. Start a new one rather than dead-end. ────
        //
        // Failing here leaves the designer holding a message they cannot send
        // and a project the customer never hears about — and on the Reorder
        // desk that is the DEFAULT outcome, not a rare one, because every
        // customer it serves last bought years ago.
        //
        // ⚠ The proof is RE-POINTED at the new conversation. That is the
        // load-bearing half: helpscout-webhook stamps reply activity by
        // matching helpscout_conversation_id, and the desk decides whether a
        // customer has answered from those stamps. Leaving the proof pointed at
        // the sealed thread would send the message and then treat the reply as
        // silence — chasing someone who had already written back, and
        // eventually quiet-closing them.
        if (!convo.mailboxId) {
          throw new HsError(
            502,
            'That Help Scout conversation is locked for age and carries no mailbox, so a new one cannot be opened. Send this one by hand from Help Scout.',
          )
        }
        console.log('[send-helpscout-reply] conversation locked for age; opening a new one', {
          oldConversationId: conversationId,
          mailboxId: convo.mailboxId,
        })
        const newId = await createStaffConversation(token, {
          mailboxId: convo.mailboxId,
          // The old subject keeps continuity for the customer — it is still
          // about their cards. Only a conversation with no subject at all
          // falls back to a generic one.
          subject: convo.subject?.trim() || 'Your Plasma Design business cards',
          customerId: convo.customerId,
          userId: userIdNum,
          text: html,
          status: hsStatus,
        })
        if (!newId) {
          // Help Scout accepted it but told us nothing. The customer HAS the
          // message, so this must not read as a failure — but we cannot
          // re-point the proof, so say exactly that.
          console.error('[send-helpscout-reply] new conversation created but no id returned')
          result = { thread_id: 0 }
        } else {
          const { error: repointErr } = await admin
            .from('proofs')
            .update({
              helpscout_conversation_id: newId,
              helpscout_conversation_url: `https://secure.helpscout.net/conversation/${newId}`,
            })
            .eq('id', proofId)
          if (repointErr) {
            // The message went out; only the link is stale. Log loudly rather
            // than fail the send — a designer re-sending because they think it
            // failed would email the customer twice.
            console.error('[send-helpscout-reply] re-point failed', repointErr.message)
          }
          console.log('[send-helpscout-reply] new conversation opened', { newId })
          result = { thread_id: 0, new_conversation_id: newId }
        }
      }
    } catch (hsErr) {
      if (hsErr instanceof HsError) {
        const upstream = hsErr.status === 404 ? 404 : 502
        console.error('[send-helpscout-reply] HS error', { status: hsErr.status, message: hsErr.message })
        return json({ error: hsErr.message }, upstream)
      }
      console.error('[send-helpscout-reply] HS unexpected error', hsErr)
      return json(
        {
          error: `Help Scout call failed: ${(hsErr as Error)?.message ?? 'unknown'}`,
          debug: debugFromError(hsErr),
        },
        502,
      )
    }

    // Manual nudge ledger row (migration 000214). When the editor was
    // seeded from a 'nudge_*' template, record the send in proof_nudges
    // with source 'manual' so the automation's cap and cooldown maths
    // count human touches — the spec keeps a single ledger for both
    // channels. Failure to insert is logged but never fails the request:
    // the reply has already landed in HS (same stance as the
    // last_reply_sent_at write below).
    //
    // template_id is client-supplied, so it is gated to the known nudge
    // ids (free text must not invent rule_codes in the ledger), and the
    // version must actually belong to the proof before the row is keyed to
    // it — the cap maths trusts that pairing.
    const NUDGE_RULES: Record<string, string> = {
      nudge_sent_never_viewed: 'sent_never_viewed',
      nudge_viewed_not_actioned: 'viewed_not_actioned',
      // Return-tone variant (000380) — same rule, same cap.
      nudge_viewed_not_actioned_return: 'viewed_not_actioned',
      nudge_approaching_dormant: 'approaching_dormant',
      nudge_stuck_in_progress: 'stuck_in_progress',
    }
    if (templateId && NUDGE_RULES[templateId]) {
      try {
        const { data: versionRow } = await admin
          .from('proof_versions')
          .select('id')
          .eq('id', versionId)
          .eq('proof_id', proofId)
          .maybeSingle()
        if (!versionRow) {
          console.error('[send-helpscout-reply] nudge ledger skipped: version does not belong to proof', { proofId, versionId })
        } else {
          const { error: nudgeErr } = await admin
            .from('proof_nudges')
            .insert({
              proof_id: proofId,
              proof_version_id: versionId,
              rule_code: NUDGE_RULES[templateId],
              template_id: templateId,
              source: 'manual',
              state: 'sent',
              outcome: 'sent',
              helpscout_conversation_id: conversationId,
              helpscout_thread_id: result.thread_id || null,
              sent_by: callerId,
              rendered_body: body,
            })
          if (nudgeErr) {
            console.error('[send-helpscout-reply] proof_nudges insert failed', nudgeErr)
          } else {
            console.log('[send-helpscout-reply] manual nudge recorded', { templateId })
          }
        }
      } catch (nudgeThrow) {
        console.error('[send-helpscout-reply] proof_nudges insert threw', nudgeThrow)
      }
    }

    // Denormalised hot-path indicator for the proof detail page's
    // Customer reply section. Updated after a successful HS POST so
    // designers see send state without querying audit_log (admin-only
    // via RLS). Failure to write the column is logged but not
    // surfaced as an error: the actual reply has already landed in HS,
    // so the column being stale is mildly degraded but not broken.
    // Audit log under action='proof.reply_sent' remains the canonical
    // per-send history. The proof_id guard stops a mismatched
    // version_id stamping a version that belongs to another proof.
    try {
      const { error: updateErr } = await admin
        .from('proof_versions')
        .update({
          last_reply_sent_at: new Date().toISOString(),
          // Who sent it (migration 000215) — the Activity timeline's
          // "<designer> sent a reply for vN" attribution.
          last_reply_sent_by: callerId,
        })
        .eq('id', versionId)
        .eq('proof_id', proofId)
      if (updateErr) {
        console.error('[send-helpscout-reply] last_reply_sent_at update failed', updateErr)
      } else {
        console.log('[send-helpscout-reply] last_reply_sent_at updated', { versionId })
      }
    } catch (updateThrow) {
      console.error('[send-helpscout-reply] last_reply_sent_at update threw', updateThrow)
    }

    console.log('[send-helpscout-reply] success', result)
    return json(result)
  } catch (outerErr) {
    console.error('[send-helpscout-reply] uncaught error', outerErr)
    return json(
      {
        error: `Server error: ${(outerErr as Error)?.message ?? 'unknown'}`,
        debug: debugFromError(outerErr),
      },
      500,
    )
  }
})
