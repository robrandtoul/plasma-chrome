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
//   { proof_id: string, version_id: string, body: string, template_id?: string }
//
// template_id is the reply_templates id the editor was seeded from. It is
// a label only (the client renders and can freely edit the body), never
// proof of content. When it is a 'nudge_*' template, a proof_nudges ledger
// row is recorded after the send — see the block below the HS POST.
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
import { fetchConversation, getAccessToken, HsError, postStaffReply } from '../_shared/helpscout.ts'
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
async function fetchPrimaryCustomerId(
  token: string,
  conversationId: string,
): Promise<number> {
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
  return customerId
}

// Wrapper around the shared postStaffReply helper. Adds the
// diagnostic console.log breadcrumbs this file relies on (see the
// header docstring) and shapes the result as { thread_id } for the
// existing call site. Status flips to 'pending' here — the designer
// is asking the customer to review a proof, so the conversation
// belongs in the customer's queue.
async function postReply(
  token: string,
  conversationId: string,
  text: string,
  userId: number,
  customerId: number,
): Promise<SendReplyResult> {
  console.log('[send-helpscout-reply] POST reply', { conversationId, userId, bodyLen: text.length })
  let threadId = 0
  try {
    threadId = await postStaffReply(token, conversationId, {
      text,
      userId,
      customerId,
      status: 'pending',
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
      const customerId = await fetchPrimaryCustomerId(token, conversationId)
      // Hand Help Scout finished HTML (escaped, URLs wrapped in <a> tags,
      // newlines as <br>) rather than a plain-text body. Help Scout's own
      // nl2br + auto-linking runs in an order that folds a "<br><br>…"
      // following a bare URL into the link's href — the iPhone-404 bug on
      // the first-proof / revision templates, whose copy sits after {url}.
      // See _shared/messageHtml.ts.
      result = await postReply(token, conversationId, messageBodyToHtml(body), userIdNum, customerId)
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
    // template_id is client-supplied, so it is gated to the four known nudge
    // ids (free text must not invent rule_codes in the ledger), and the
    // version must actually belong to the proof before the row is keyed to
    // it — the cap maths trusts that pairing.
    const NUDGE_RULES: Record<string, string> = {
      nudge_sent_never_viewed: 'sent_never_viewed',
      nudge_viewed_not_actioned: 'viewed_not_actioned',
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
