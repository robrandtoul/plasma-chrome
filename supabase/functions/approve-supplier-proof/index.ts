// approve-supplier-proof — designer-only. Signs off the internal proof a supplier
// returned for a placed order: posts the approval onto the supplier's own Help
// Scout thread and stamps it on the order, which clears the card out of the
// Orders page's CHECK section and into the archive. Migration 000409;
// docs/supplier-proof-holding-pen-spec.md.
//
// ── Why this exists rather than reusing send-helpscout-reply ─────────────────
// send-helpscout-reply hard-requires proof_id + version_id and reads the
// conversation off the PROOF row. A supplier order's thread is a different
// conversation entirely — created by place-order with the supplier as its
// customer, recorded on orders.supplier_helpscout_conversation_id — so that
// function cannot address it at all.
//
// ── Ordering: send FIRST, stamp only on success ─────────────────────────────
// The opposite of the 000366 abandon notice, deliberately. There, the status flip
// was its own durable record and the worse failure was telling a customer we had
// closed something we hadn't. Here the approval IS the message: if we stamped
// first and the send failed, the card would vanish off the page while the
// supplier sat waiting for a go-ahead that never came — and nobody would know
// until the cards didn't ship, which is the exact hole this feature closes. A
// failed send leaves the order in CHECK with the error shown, honest and
// retryable. Same order place-order uses for supplier_email_sent_at.
//
// Imports the shared helpers rather than inlining copies (the pattern
// place-order uses — the CLI resolves _shared on deploy). Inlined copies were
// the first cut and were WRONG in a way worth recording: a hand-rolled
// renderTemplate left an unknown {typo} visible in the message, where the shared
// one blanks it, so the same template would have rendered differently here than
// on every other message the system sends.

import { type SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { requireDesigner } from '../_shared/admin.ts'
import { logAudit } from '../_shared/audit.ts'
import { renderTemplate } from '../_shared/replyTemplates.ts'
import { messageBodyToHtml } from '../_shared/messageHtml.ts'
import { supplierClearedNote } from '../_shared/supplierNote.ts'
import {
  getAccessToken,
  postStaffReply,
  fetchConversationOwnership,
  createNote,
  HsError,
} from '../_shared/helpscout.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

/** Resolve the authoring Help Scout staff id: caller's own mapping, else the
 *  configured default — so the approval reads as coming from the person who
 *  actually clicked it wherever their mapping exists. */
async function resolveUserId(admin: SupabaseClient, callerId: string): Promise<number | null> {
  const { data: pr } = await admin.from('profiles').select('helpscout_user_id').eq('id', callerId).single()
  const v = (pr as { helpscout_user_id: number | null } | null)?.helpscout_user_id ?? null
  if (typeof v === 'number' && Number.isInteger(v) && v > 0) return v
  const parsed = Number(Deno.env.get('HELPSCOUT_DEFAULT_USER_ID') ?? '')
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

// Last-resort body if the template row is missing or blank. Mirrors
// DEFAULT_BODIES.supplier_proof_approval in src/lib/replyTemplates.ts.
const APPROVAL_DEFAULT =
  'Hi,\n\nThanks — the proof is approved. Please go ahead and produce the order.\n\nMany thanks.'

/**
 * The approval message, most-specific template first:
 *   supplier_proof_approval:<supplier_id>  →  supplier_proof_approval  →  constant
 * Exactly the resolution order `supplier_order_email` already uses (three live
 * per-supplier rows). The RENDERED output is what's guarded, not the stored body:
 * a template of nothing but conditional blocks passes a trim() check and still
 * renders empty, which would reply to the supplier with nothing at all.
 */
async function renderApproval(
  admin: SupabaseClient,
  supplierId: string | null,
  vars: Record<string, string>,
): Promise<string> {
  const ids = supplierId
    ? [`supplier_proof_approval:${supplierId}`, 'supplier_proof_approval']
    : ['supplier_proof_approval']
  let body = APPROVAL_DEFAULT
  try {
    const { data } = await admin.from('reply_templates').select('id, body').in('id', ids)
    const byId = new Map((data ?? []).map((r: { id: string; body: string }) => [r.id, r.body]))
    for (const id of ids) {
      const b = byId.get(id)
      if (typeof b === 'string' && b.trim()) { body = b; break }
    }
  } catch { /* fall back to the constant */ }
  const rendered = renderTemplate(body, vars)
  return rendered.trim() ? rendered : renderTemplate(APPROVAL_DEFAULT, vars)
}

interface OrderRow {
  id: string
  status: string
  payment_reference: string | null
  supplier_id: string | null
  supplier_name: string | null
  supplier_helpscout_conversation_id: string | null
  supplier_email_sent_at: string | null
  supplier_reply_at: string | null
  supplier_proof_approved_at: string | null
  proof_id: string | null
  proofs: {
    // The CUSTOMER's proof thread — a different conversation from the supplier's.
    // Carries the paired status notes (see postClearedNote).
    helpscout_conversation_id: string | null
    contacts: { full_name: string | null; companies: { name: string | null } | null } | null
  } | null
}

/** Customer label for {customer}: company first (it's what a supplier sees on
 *  the artwork), falling back to the contact's own name. */
function customerLabel(o: OrderRow): string {
  const c = o.proofs?.contacts
  return (c?.companies?.name ?? '').trim() || (c?.full_name ?? '').trim() || 'this customer'
}

async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405)

  const auth = await requireDesigner(req)
  if (auth instanceof Response) return auth
  const { admin, callerId, callerEmail, callerLabel } = auth

  let body: Record<string, unknown>
  try {
    body = await req.json() as Record<string, unknown>
  } catch {
    return json({ ok: false, error: 'Invalid JSON body' }, 400)
  }
  const orderId = typeof body.order_id === 'string' ? body.order_id.trim() : ''
  if (!orderId) return json({ ok: false, error: 'order_id is required' }, 400)
  // 'preview' renders the message for the compose box without sending anything,
  // so template resolution lives in exactly one place rather than being mirrored
  // into the frontend.
  const preview = body.mode === 'preview'
  // Stamp the approval without replying. The escape hatch for an approval
  // already sent by hand in Help Scout (which will happen constantly during
  // rollout), and for a supplier whose reply was an acknowledgement rather than
  // a proof — replying "the proof is approved" to those would read oddly.
  const skipReply = body.skip_reply === true
  const note = typeof body.note === 'string' ? body.note.trim() : ''
  // An edited body from the compose box. When absent we render the template
  // ourselves, so a bare Approve still works.
  const customBody = typeof body.body === 'string' ? body.body.trim() : ''

  const { data: orderData, error: orderErr } = await admin
    .from('orders')
    .select(
      'id, status, payment_reference, supplier_id, supplier_name, supplier_helpscout_conversation_id, ' +
      'supplier_email_sent_at, supplier_reply_at, supplier_proof_approved_at, proof_id, ' +
      'proofs(helpscout_conversation_id, contacts(full_name, companies(name)))',
    )
    .eq('id', orderId)
    .maybeSingle()
  if (orderErr) return json({ ok: false, error: `Could not load the order: ${orderErr.message}` }, 500)
  if (!orderData) return json({ ok: false, error: 'Order not found' }, 404)
  const order = orderData as unknown as OrderRow

  // Membership check mirrors src/lib/supplierProof.ts inPen(): keyed off the
  // supplier EMAIL, not the material route, so a blanks-sourced order (000382)
  // — supplier material, deliberately no supplier email — can never be
  // "approved" against a thread that doesn't exist.
  if (order.status !== 'fulfilled') {
    return json({ ok: false, code: 'not_placed', error: 'This order hasn’t been placed with a supplier yet.' }, 409)
  }
  if (!order.supplier_email_sent_at || !order.supplier_helpscout_conversation_id) {
    return json({ ok: false, code: 'no_supplier_thread', error: 'This order has no supplier conversation — there’s no proof to approve.' }, 409)
  }

  const vars: Record<string, string> = {
    customer: customerLabel(order),
    order_number: order.payment_reference ?? '',
    note,
  }

  if (preview) {
    return json({
      ok: true,
      body: await renderApproval(admin, order.supplier_id, vars),
      supplier_name: order.supplier_name,
      conversation_id: order.supplier_helpscout_conversation_id,
    })
  }

  // Idempotency. Two people on the CHECK list, or one double-click, must not
  // email the supplier twice. Compares the same way the page does: an approval
  // at or after the newest reply means there is nothing outstanding.
  const replyMs = order.supplier_reply_at ? Date.parse(order.supplier_reply_at) : null
  const approvedMs = order.supplier_proof_approved_at ? Date.parse(order.supplier_proof_approved_at) : null
  if (approvedMs != null && (replyMs == null || replyMs <= approvedMs)) {
    return json({ ok: false, code: 'already_approved', error: 'This proof has already been approved.' }, 409)
  }

  const nowIso = new Date().toISOString()
  let threadId: number | null = null
  // Reused by the customer-thread note below, so the happy path fetches a token
  // once rather than twice. Left null on the skip-reply path and resolved there
  // if the note needs them.
  let hsToken: string | null = null
  let hsUserId: number | null = null

  if (!skipReply) {
    const appId = Deno.env.get('HELPSCOUT_APP_ID')?.trim()
    const appSecret = Deno.env.get('HELPSCOUT_APP_SECRET')?.trim()
    if (!appId || !appSecret) {
      return json({ ok: false, error: 'Help Scout isn’t configured (HELPSCOUT_APP_ID / HELPSCOUT_APP_SECRET).' }, 500)
    }
    const userId = await resolveUserId(admin, callerId)
    if (userId == null) {
      return json({ ok: false, error: 'No Help Scout author id available (set HELPSCOUT_DEFAULT_USER_ID).' }, 500)
    }
    hsUserId = userId
    const text = customBody || await renderApproval(admin, order.supplier_id, vars)
    if (!text.trim()) return json({ ok: false, error: 'The approval message is empty.' }, 400)

    try {
      const token = await getAccessToken(appId, appSecret)
      hsToken = token
      const own = await fetchConversationOwnership(token, order.supplier_helpscout_conversation_id)
      const customerId = own?.primaryCustomerId ?? null
      if (customerId == null) {
        return json({
          ok: false,
          code: 'no_primary_customer',
          error: 'That Help Scout conversation has no primary customer, so a reply can’t be attributed. Approve it in Help Scout and use “Clear without replying”.',
        }, 502)
      }
      threadId = await postStaffReply(token, order.supplier_helpscout_conversation_id, {
        text: messageBodyToHtml(text),
        userId,
        customerId,
      })
    } catch (err) {
      const e = err as HsError
      // Nothing is stamped, so the card stays in CHECK with this message on it.
      return json({ ok: false, code: 'send_failed', error: `Couldn’t send the approval to the supplier: ${e.message}` }, 502)
    }
  }

  // Send succeeded (or was deliberately skipped) — now record it. Conditional on
  // the approval still being unset-or-older, so two concurrent clicks can't both
  // claim the stamp.
  const { data: stamped, error: stampErr } = await admin
    .from('orders')
    .update({ supplier_proof_approved_at: nowIso, supplier_proof_approved_by: callerId })
    .eq('id', orderId)
    .select('id')
  if (stampErr || !stamped?.length) {
    // The supplier HAS been told. Say so loudly rather than let a retry send a
    // second approval — the same "sent but not recorded" shape place-order uses.
    return json({
      ok: false,
      code: skipReply ? 'not_recorded' : 'sent_not_recorded',
      error: skipReply
        ? `Couldn’t record the approval (${stampErr?.message ?? 'no row updated'}).`
        : `The approval was sent to ${order.supplier_name ?? 'the supplier'}, but it couldn’t be recorded (${stampErr?.message ?? 'no row updated'}). Do NOT send it again — mark it approved manually.`,
    }, 500)
  }

  // Pair to the "AWAITING RESPONSE FROM <supplier>" note place-order files on the
  // same thread at placement (000409). Posted on the CUSTOMER's proof thread, not
  // the supplier's, so whoever opens the project in Help Scout can see where the
  // order has got to without going near the Orders page. Help Scout notes are
  // staff-only — never emailed or shown to the customer.
  //
  // ⚠ Best-effort, and AFTER the stamp: the approval is the thing that matters,
  // and a Help Scout wobble must never cost someone their sign-off or invite a
  // retry that emails the supplier twice. Skipped silently when the proof has no
  // linked conversation (a supplier order can be placed without one).
  //
  try {
    const convId = order.proofs?.helpscout_conversation_id
    if (convId) {
      if (!hsToken || hsUserId == null) {
        const appId = Deno.env.get('HELPSCOUT_APP_ID')?.trim()
        const appSecret = Deno.env.get('HELPSCOUT_APP_SECRET')?.trim()
        if (appId && appSecret) {
          hsUserId = hsUserId ?? await resolveUserId(admin, callerId)
          if (hsUserId != null) hsToken = hsToken ?? await getAccessToken(appId, appSecret)
        }
      }
      if (hsToken && hsUserId != null) {
        await createNote(
          hsToken,
          convId,
          hsUserId,
          supplierClearedNote(order.supplier_name, callerLabel, !skipReply),
        )
      }
    }
  } catch (err) {
    console.error('[approve-supplier-proof] customer-thread note failed:', (err as Error).message)
  }

  await logAudit(admin, {
    actorId: callerId,
    actorEmail: callerEmail,
    actorLabel: callerLabel,
    action: 'order.supplier_proof_approved',
    targetType: 'order',
    targetId: orderId,
    targetLabel: order.payment_reference,
    afterValue: { supplier_proof_approved_at: nowIso },
    metadata: {
      supplier_id: order.supplier_id,
      supplier_name: order.supplier_name,
      // The part of the decision that can't be reconstructed from the row later
      // (000366's lesson): whether the supplier was actually told, and where.
      replied: !skipReply,
      helpscout_thread_id: threadId,
      helpscout_conversation_id: order.supplier_helpscout_conversation_id,
      edited: !skipReply && customBody.length > 0,
    },
  })

  return json({ ok: true, replied: !skipReply, thread_id: threadId, approved_at: nowIso })
}

Deno.serve(async (req) => {
  try {
    return await handle(req)
  } catch (err) {
    console.error('[approve-supplier-proof] unhandled', (err as Error).message)
    return json({ ok: false, error: (err as Error).message }, 500)
  }
})
