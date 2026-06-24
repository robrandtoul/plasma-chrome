// order-lifecycle — designer-only. Two order-side state changes for the order
// cancel & revision flows (docs/order-cancel-and-revision-spec.md §3a):
//
//   action 'cancel' : sent | revision  -> cancelled   (posts order_cancelled)
//   action 'revise' : paid | fulfilled -> revision     (posts order_revision)
//
// Both are conditional updates (.in('status', allowedFrom)) so the function can
// never act on a wrong-status order — a double-cancel, or cancelling a paid
// order, matches zero rows and returns 409. The status flip lands FIRST, then
// the audit, then a best-effort customer-visible Help Scout reply: a notify
// failure (no linked conversation, HS down, no primary customer) logs and still
// returns ok, because the state change is the important thing.
//
// Auth: the function self-authenticates via requireDesigner (reads the bearer
// JWT, confirms an active admin/designer). Deployed with verify_jwt = true to
// match the live place-order sibling (same requireDesigner pattern, also deployed
// via MCP) — the designer frontend always sends a fresh session JWT, so the
// platform check passes and requireDesigner is the role gate on top. Attribution
// is the verified caller (callerId from the JWT).

import { json, requireDesigner, CORS_HEADERS } from '../_shared/admin.ts'
import { logAudit } from '../_shared/audit.ts'
import { fetchConversation, getAccessToken, HsError, postStaffReply } from '../_shared/helpscout.ts'
import { renderTemplate, ORDER_LIFECYCLE_DEFAULT_BODIES, type TemplateContext } from '../_shared/replyTemplates.ts'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const check = await requireDesigner(req)
  if (check instanceof Response) return check
  const { admin, callerId, callerEmail, callerLabel } = check

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }

  const orderId = typeof body.order_id === 'string' ? body.order_id.trim() : ''
  const action = body.action === 'cancel' || body.action === 'revise' ? body.action : null
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '' // 'abort' | 'reopen'
  const notify = body.notify === true
  if (!orderId) return json({ error: 'order_id is required' }, 400)
  if (!action) return json({ error: "action must be 'cancel' or 'revise'" }, 400)

  // Load the order for the proof link + the before-status audit value.
  const { data: order, error: orderErr } = await admin
    .from('orders')
    .select('id, proof_id, status, payment_reference')
    .eq('id', orderId)
    .maybeSingle()
  if (orderErr) return json({ error: `Order lookup failed: ${orderErr.message}` }, 500)
  if (!order) return json({ error: 'Order not found' }, 404)
  const beforeStatus = order.status as string

  // Map the action to its target status, allowed source states, template + audit.
  const plan = action === 'cancel'
    ? { newStatus: 'cancelled', allowedFrom: ['sent', 'revision'], templateId: 'order_cancelled', auditAction: 'order.cancelled' }
    : { newStatus: 'revision', allowedFrom: ['paid', 'fulfilled'], templateId: 'order_revision', auditAction: 'order.revision_started' }

  // ── Conditional state flip (guards against acting on a wrong-status order) ──
  const patch: Record<string, unknown> = { status: plan.newStatus, updated_at: new Date().toISOString() }
  if (action === 'revise') patch.revised_at = new Date().toISOString()
  const { data: updated, error: updErr } = await admin
    .from('orders')
    .update(patch)
    .eq('id', orderId)
    .in('status', plan.allowedFrom)
    .select('id')
    .maybeSingle()
  if (updErr) return json({ error: `Order update failed: ${updErr.message}` }, 500)
  if (!updated) {
    return json({ error: `Order is '${beforeStatus}', cannot ${action} it.` }, 409)
  }

  // ── Audit (caller-attributed; before.status carries paid-vs-placed) ──
  await logAudit(admin, {
    actorId: callerId,
    actorEmail: callerEmail,
    actorLabel: callerLabel,
    action: plan.auditAction,
    targetType: 'order',
    targetId: orderId,
    targetLabel: `Order ${order.payment_reference ?? orderId}`,
    beforeValue: { status: beforeStatus },
    afterValue: { status: plan.newStatus, ...(reason ? { reason } : {}) },
  })

  // ── Best-effort customer-visible Help Scout reply ──
  let hsThreadId: number | null = null
  let hsNote: string | undefined
  if (notify) {
    try {
      const { data: proofRow } = await admin
        .from('proofs')
        .select('id, helpscout_conversation_id, contact_id')
        .eq('id', order.proof_id)
        .maybeSingle()
      const conversationId = (proofRow?.helpscout_conversation_id as string | null) ?? null
      if (!conversationId) {
        hsNote = 'no Help Scout conversation linked; customer not notified'
      } else {
        // Contact first name + company for the template context.
        let firstName = ''
        let company: string | null = null
        if (proofRow?.contact_id) {
          const { data: contact } = await admin
            .from('contacts')
            .select('full_name, company_id')
            .eq('id', proofRow.contact_id as string)
            .maybeSingle()
          firstName = ((contact?.full_name as string | null) ?? '').trim().split(/\s+/)[0] || ''
          if (contact?.company_id) {
            const { data: co } = await admin
              .from('companies')
              .select('name')
              .eq('id', contact.company_id as string)
              .maybeSingle()
            company = (co?.name as string | null) ?? null
          }
        }

        // Template body: DB row first, seeded fallback second.
        let tplBody = ORDER_LIFECYCLE_DEFAULT_BODIES[plan.templateId]
        const { data: tpl } = await admin
          .from('reply_templates')
          .select('body')
          .eq('id', plan.templateId)
          .maybeSingle()
        if (typeof tpl?.body === 'string' && tpl.body.trim() !== '') tplBody = tpl.body as string

        const appId = Deno.env.get('HELPSCOUT_APP_ID')?.trim()
        const appSecret = Deno.env.get('HELPSCOUT_APP_SECRET')?.trim()
        const defaultUserId = Number(Deno.env.get('HELPSCOUT_DEFAULT_USER_ID')?.trim() ?? '')
        if (!appId || !appSecret) {
          hsNote = 'Help Scout credentials not configured; customer not notified'
        } else {
          const token = await getAccessToken(appId, appSecret)
          const conv = await fetchConversation(token, conversationId)
          if (!conv) {
            hsNote = 'Help Scout conversation missing; customer not notified'
          } else {
            const customerId = conv.primaryCustomer?.id ?? null
            if (!customerId) {
              hsNote = 'conversation has no primary customer; customer not notified'
            } else {
              // Sender: per-designer HS id -> conversation assignee -> default.
              let senderId: number | null = null
              const { data: prof } = await admin
                .from('profiles')
                .select('helpscout_user_id')
                .eq('id', callerId)
                .maybeSingle()
              const pid = (prof?.helpscout_user_id as number | null) ?? null
              if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0) {
                senderId = pid
              } else {
                senderId = conv.assignee?.id ?? (Number.isInteger(defaultUserId) && defaultUserId > 0 ? defaultUserId : null)
              }
              if (!senderId) {
                hsNote = 'no Help Scout sender identity; customer not notified'
              } else {
                const fallbackFirst = (conv.primaryCustomer?.first ?? '').trim() || firstName
                const ctx: TemplateContext = { first_name: fallbackFirst, company }
                const rendered = renderTemplate(tplBody, ctx)
                // No status flip — an order cancel/revision notice is informational,
                // not a request for the customer to act (matches proof-action's
                // confirmation-reply stance).
                hsThreadId = await postStaffReply(token, conversationId, {
                  text: rendered,
                  userId: senderId,
                  customerId,
                })
              }
            }
          }
        }
      }
    } catch (err) {
      const detail = err instanceof HsError ? `hs_${err.status}: ${err.message}` : (err as Error)?.message ?? 'unknown'
      console.error('[order-lifecycle] notify failed', detail)
      hsNote = `customer notify failed: ${detail}`
    }
  }

  return json({ ok: true, status: plan.newStatus, helpscout_thread_id: hsThreadId, note: hsNote })
})
