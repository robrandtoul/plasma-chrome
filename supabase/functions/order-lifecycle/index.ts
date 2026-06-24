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
// platform check passes and requireDesigner is the role gate on top.
//
// Self-contained for the MCP deploy (HS helpers + auth + renderer + default
// bodies inlined), the same pattern place-order uses — keeps the deploy to a
// single file. The default bodies stay byte-identical to src/lib/replyTemplates.ts
// DEFAULT_BODIES and the 000260 seed.

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

class HsError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'HsError'
  }
}

// ── Help Scout helpers (inline; self-contained for the MCP deploy) ──────────
async function getAccessToken(appId: string, appSecret: string): Promise<string> {
  const resp = await fetch('https://api.helpscout.net/v2/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: appId, client_secret: appSecret }).toString(),
  })
  if (!resp.ok) {
    const b = await resp.text().catch(() => '')
    throw new HsError(resp.status, `Help Scout token error (${resp.status}): ${b.slice(0, 200)}`)
  }
  const tok = (await resp.json().catch(() => null) as { access_token?: string } | null)?.access_token
  if (!tok) throw new HsError(500, 'Help Scout token response missing access_token')
  return tok
}

interface HsConversation {
  id: number
  primaryCustomer?: { id: number; first?: string | null } | null
  assignee?: { id: number } | null
}

// GET /v2/conversations/{id}. null on 404 so a deleted conversation skips notify
// rather than erroring.
async function fetchConversation(token: string, id: string | number): Promise<HsConversation | null> {
  const resp = await fetch(`https://api.helpscout.net/v2/conversations/${id}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  if (resp.status === 404) return null
  if (!resp.ok) {
    const b = await resp.text().catch(() => '')
    throw new HsError(resp.status, `Help Scout conversation fetch (${resp.status}): ${b.slice(0, 200)}`)
  }
  return await resp.json() as HsConversation
}

// POST /v2/conversations/{id}/reply — a customer-visible staff reply. customer.id
// is required by Help Scout. No status flip: an order cancel/revision notice is
// informational, not a request for the customer to act.
async function postStaffReply(
  token: string,
  conversationId: string,
  body: { text: string; userId: number; customerId: number },
): Promise<number> {
  const resp = await fetch(`https://api.helpscout.net/v2/conversations/${conversationId}/reply`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ text: body.text, user: body.userId, customer: { id: body.customerId }, draft: false }),
  })
  if (resp.status === 404) throw new HsError(404, 'Help Scout conversation not found')
  if (!resp.ok) {
    const b = await resp.text().catch(() => '')
    throw new HsError(resp.status, `Help Scout reply error (${resp.status}): ${b.slice(0, 200)}`)
  }
  const resourceId = resp.headers.get('Resource-Id') ?? ''
  const directId = resourceId.match(/^\d+$/)?.[0]
  const location = resp.headers.get('Location') ?? ''
  const locationId = location.match(/\/threads\/(\d+)$/)?.[1]
  const raw = directId ?? locationId
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) ? n : 0
}

// ── Template renderer (inline mirror of _shared/replyTemplates.ts) ──────────
// {var} substitution + {? var}body{/?} conditional blocks (block renders iff the
// ctx value is non-empty after trim).
type Ctx = Record<string, string | null | undefined>
function substitute(text: string, ctx: Ctx): string {
  return text.replace(/\{(\w+)\}/g, (_m, v: string) => {
    const val = ctx[v]
    return val == null ? '' : String(val)
  })
}
function renderTemplate(template: string, ctx: Ctx): string {
  let s = template.replace(/\{\?\s*(\w+)\s*\}([\s\S]*?)\{\/\?\}/g, (_m, name: string, inner: string) => {
    const v = ctx[name]
    const empty = v == null || (typeof v === 'string' && v.trim() === '')
    return empty ? '' : substitute(inner, ctx)
  })
  return substitute(s, ctx)
}

// Fallback bodies — byte-identical to src/lib/replyTemplates.ts DEFAULT_BODIES
// and the 000260 seed. No sign-off (Help Scout auto-appends the signature).
const ORDER_LIFECYCLE_DEFAULT_BODIES: Record<string, string> = {
  order_cancelled:
    `Hi {first_name},\n\nWe've cancelled the order and payment link for your cards{? company} for {company}{/?}. No payment has been taken.\n\nIf you'd like to go ahead after all, just reply and we'll send a fresh link.`,
  order_revision:
    `Hi {first_name},\n\nWe're updating your cards{? company} for {company}{/?} — a fresh proof will follow shortly for you to approve before we go ahead.\n\nIf you have any questions in the meantime, just reply to this email.`,
}

// ── Auth: active admin/designer; returns the proofs-schema service client +
// caller attribution (inline mirror of _shared/admin.ts requireDesigner) ────
async function requireDesigner(
  req: Request,
): Promise<{ admin: SupabaseClient; callerId: string; callerEmail: string; callerLabel: string } | Response> {
  const authHeader = req.headers.get('Authorization') ?? ''
  if (!authHeader.toLowerCase().startsWith('bearer ')) return json({ error: 'Unauthorized' }, 401)
  const jwt = authHeader.replace(/^[Bb]earer\s+/, '').trim()
  const url = Deno.env.get('SUPABASE_URL') ?? ''
  const anon = createClient(url, Deno.env.get('SUPABASE_ANON_KEY') ?? '')
  const { data: userData, error: userErr } = await anon.auth.getUser(jwt)
  if (userErr || !userData?.user) return json({ error: 'Unauthorized' }, 401)
  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', {
    db: { schema: 'proofs' },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: profile } = await admin
    .from('profiles')
    .select('role, deactivated_at, full_name')
    .eq('id', userData.user.id)
    .single()
  if (!profile || profile.deactivated_at) return json({ error: 'Forbidden' }, 403)
  if (profile.role !== 'admin' && profile.role !== 'designer') return json({ error: 'Forbidden' }, 403)
  return {
    admin,
    callerId: userData.user.id,
    callerEmail: userData.user.email ?? '',
    callerLabel: (profile.full_name as string | null) ?? (userData.user.email ?? ''),
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
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
  await admin.from('audit_log').insert({
    actor_id: callerId,
    actor_email: callerEmail,
    actor_label: callerLabel,
    action: plan.auditAction,
    target_type: 'order',
    target_id: orderId,
    target_label: `Order ${order.payment_reference ?? orderId}`,
    before_value: { status: beforeStatus },
    after_value: { status: plan.newStatus, ...(reason ? { reason } : {}) },
  }).then(undefined, () => {})

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
                const rendered = renderTemplate(tplBody, { first_name: fallbackFirst, company })
                hsThreadId = await postStaffReply(token, conversationId, { text: rendered, userId: senderId, customerId })
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
