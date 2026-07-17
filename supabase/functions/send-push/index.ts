// send-push: the single fan-out point for staff push notifications.
//
// Called server-to-server (never from a browser) by the proof_events / proofs
// database triggers (via pg_net), and reusable by edge functions later. The
// trigger fires after the customer's action is durable, so a push failure can
// never slow or break the customer's action.
//
// Deploy with verify_jwt = false. The caller authenticates with EITHER the
// service-role key OR the DB-stored internal secret (settings.push_internal_secret)
// — both server-only.
//
// Responsibilities:
//   0. master kill switch (settings.push_enabled) + test-mode gate for money
//      events.
//   1. resolve the project owners + company label for copy.
//   2. compute recipients = every active staffer whose prefs/watches say yes.
//   3. drop the actor.
//   4. dedup via notification_outbox (unique index) so retries are no-ops.
//   5. send to each of a recipient's devices; prune dead subscriptions (404/410).
//
// Required secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and the namespaced
// PROOFS_VAPID_* keys (read in _shared/push.ts — kept separate from Stock
// Control's project-wide VAPID_* secrets).

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { sendPush, interpolate, clip, type PushPayload } from '../_shared/push.ts'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

// Event classification. Proof events resolve recipients from role defaults +
// ownership; fulfilment events resolve from settings.fulfilment_user_ids.
const PROOF_EVENTS = new Set([
  'customer_requests_changes',
  'proof_approve_per_recipient',
  'project_reaches_approved_status',
  'customer_replies_by_email',
  'project_flagged',
])
const FULFILMENT_EVENTS = new Set([
  'order_paid',
  'pay_link_opened',
  'project_reaches_to_order_status',
])

type PrefValue = 'on' | 'off' | 'own_projects'

interface Body {
  event_code: string
  proof_id?: string | null
  proof_version_id?: string | null
  order_id?: string | null
  source_kind: 'proof_event' | 'order' | 'proof_finalize' | 'condition' | 'chat'
  source_event_id: string
  actor_user_id?: string | null
  // Explicit recipients for team_chat_mention (the @mentioned users). Other
  // event codes resolve recipients from ownership + prefs instead.
  recipient_user_ids?: string[] | null
  vars?: Record<string, string | null | undefined>
}

interface Profile {
  id: string
  role: 'admin' | 'designer'
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  if (!supabaseUrl || !serviceKey) return json({ error: 'server misconfigured' }, 500)

  const admin = createClient(supabaseUrl, serviceKey, {
    db: { schema: 'proofs' },
    auth: { persistSession: false, autoRefreshToken: false },
  })

  // ── 0. Settings + auth + master gate ──
  const { data: settings } = await admin
    .from('settings')
    .select(
      'push_enabled, push_internal_secret, payment_mode, ordering_enabled, notification_role_defaults, fulfilment_user_ids, notification_copy',
    )
    .eq('id', 1)
    .maybeSingle()

  // Internal auth: the caller presents EITHER the service-role key (an edge-to-
  // edge caller) OR the DB-stored internal secret (the proof_events / proofs
  // triggers fire via pg_net and can't read the service-role key, but can read
  // this column). Both are server-only secrets that never reach a browser.
  const authHeader = req.headers.get('Authorization') ?? ''
  const bearer = authHeader.replace(/^[Bb]earer\s+/, '').trim()
  const internalSecret =
    (settings as { push_internal_secret?: string | null } | null)?.push_internal_secret ?? null
  if (bearer !== serviceKey && (!internalSecret || bearer !== internalSecret)) {
    return json({ error: 'Unauthorized' }, 401)
  }

  if (!settings?.push_enabled) {
    return json({ status: 'skipped', reason: 'killswitch' })
  }

  let body: Body
  try {
    body = await req.json()
  } catch {
    return json({ error: 'invalid JSON' }, 400)
  }
  const eventCode = body.event_code
  if (!eventCode) return json({ error: 'event_code required' }, 400)
  const roleDefaults =
    (settings.notification_role_defaults as Record<string, Record<string, PrefValue>> | null) ?? {}
  const fulfilmentIds = new Set((settings.fulfilment_user_ids as string[] | null) ?? [])
  const copyMap = (settings.notification_copy as Record<string, { title: string; body: string }> | null) ?? {}

  // Team-chat @mention: the recipients are explicit (the mentioned users), so
  // this bypasses the proof-ownership recipient machinery entirely.
  if (eventCode === 'team_chat_mention') {
    return await handleChatMention(admin, body, copyMap)
  }

  // Money events stay silent until ordering is actually live, so test orders
  // don't ping like real sales.
  if (FULFILMENT_EVENTS.has(eventCode)) {
    if (settings.payment_mode !== 'live' || settings.ordering_enabled === false) {
      return json({ status: 'skipped', reason: 'testmode' })
    }
  }

  // ── 1. Resolve context: proof id, owners, company label ──
  const ctx = await resolveContext(admin, body)
  const proofId = ctx.proofId
  const ownerIds = ctx.ownerIds
  const company = ctx.company

  // ── 2. Candidate staff = every active profile (the team is small) ──
  const { data: profilesData } = await admin
    .from('profiles')
    .select('id, role')
    .is('deactivated_at', null)
  const profiles = (profilesData ?? []) as Profile[]

  // Bulk-load prefs + this proof's watches so shouldNotify is pure.
  const ids = profiles.map((p) => p.id)
  const { data: prefRows } = await admin
    .from('notification_preferences')
    .select('user_id, prefs')
    .in('user_id', ids)
  const prefsByUser = new Map<string, Record<string, PrefValue | boolean>>()
  for (const r of (prefRows ?? []) as Array<{ user_id: string; prefs: Record<string, PrefValue | boolean> }>) {
    prefsByUser.set(r.user_id, r.prefs ?? {})
  }
  const watchByUser = new Map<string, Record<string, 'on' | 'off'>>()
  if (proofId) {
    const { data: watchRows } = await admin
      .from('proof_watches')
      .select('user_id, events')
      .eq('proof_id', proofId)
    for (const r of (watchRows ?? []) as Array<{ user_id: string; events: Record<string, 'on' | 'off'> }>) {
      watchByUser.set(r.user_id, r.events ?? {})
    }
  }

  const recipients = profiles.filter((p) => {
    if (p.id === body.actor_user_id) return false // drop the actor
    return shouldNotify(eventCode, p, ownerIds, prefsByUser.get(p.id), watchByUser.get(p.id), roleDefaults, fulfilmentIds)
  })

  // ── Build the (recipient-agnostic) copy once ──
  const copy = copyMap[eventCode] ?? { title: 'Proof Viewer', body: 'You have a new update.' }
  const vars = { company, ...(body.vars ?? {}) }
  const payload: PushPayload = {
    title: clip(interpolate(copy.title, vars), 30),
    body: clip(interpolate(copy.body, vars), 120),
    url: deepLink(eventCode, proofId),
    tag: proofId ? `proof:${proofId}` : `order:${body.order_id ?? eventCode}`,
  }

  // ── 3–5. Per recipient: dedup, fetch devices, send, prune ──
  let sent = 0
  let skipped = 0
  for (const r of recipients) {
    // Dedup: insert the ledger row first. A unique-violation means we've already
    // handled this (event, source, recipient) — skip.
    const { error: insErr } = await admin.from('notification_outbox').insert({
      event_code: eventCode,
      source_kind: body.source_kind,
      source_event_id: body.source_event_id,
      proof_id: proofId,
      order_id: body.order_id ?? null,
      recipient_user_id: r.id,
      title: payload.title,
      body: payload.body,
      url: payload.url,
      status: 'queued',
    })
    if (insErr) {
      // 23505 = already in the ledger for this recipient → idempotent skip.
      if ((insErr as { code?: string }).code === '23505') {
        skipped++
        continue
      }
      console.error('[send-push] outbox insert failed', insErr)
      continue
    }

    const { data: subs } = await admin
      .from('push_subscriptions')
      .select('id, endpoint, p256dh, auth')
      .eq('user_id', r.id)
    const devices = (subs ?? []) as Array<{ id: string; endpoint: string; p256dh: string; auth: string }>
    if (devices.length === 0) {
      await setOutcome(admin, eventCode, body, r.id, 'no_subscription')
      continue
    }

    let anySent = false
    for (const d of devices) {
      const outcome = await sendPush({ endpoint: d.endpoint, p256dh: d.p256dh, auth: d.auth }, payload)
      if (outcome.ok) {
        anySent = true
      } else if (outcome.status === 404 || outcome.status === 410) {
        // Dead subscription — delete it (the source of truth for pruning).
        await admin.from('push_subscriptions').delete().eq('id', d.id)
      } else {
        await admin
          .from('push_subscriptions')
          .update({ last_failure_code: outcome.status ?? null })
          .eq('id', d.id)
        console.warn('[send-push] send failed', { user: r.id, status: outcome.status, error: outcome.error })
      }
    }
    await setOutcome(admin, eventCode, body, r.id, anySent ? 'sent' : 'failed')
    if (anySent) sent++
  }

  return json({ status: 'ok', recipients: recipients.length, sent, skipped })
})

// ── Helpers ──

function shouldNotify(
  event: string,
  profile: Profile,
  ownerIds: Set<string>,
  prefs: Record<string, PrefValue | boolean> | undefined,
  watch: Record<string, 'on' | 'off'> | undefined,
  roleDefaults: Record<string, Record<string, PrefValue>>,
  fulfilmentIds: Set<string>,
): boolean {
  const p = prefs ?? {}
  // Account-wide pause wins over everything, including a project watch.
  if (p._muted === true) return false

  // Per-project watch override.
  if (watch) {
    if (Object.keys(watch).length === 0) return true // watch-all
    if (event in watch) return watch[event] === 'on'
    // event not named in a non-empty watch → fall through to account level
  }

  // Personal per-event override.
  const personal = p[event]
  if (personal === 'on') return true
  if (personal === 'off') return false
  if (personal === 'own_projects') return ownerIds.has(profile.id)

  // Baseline.
  if (FULFILMENT_EVENTS.has(event)) return fulfilmentIds.has(profile.id)
  if (PROOF_EVENTS.has(event)) {
    const def = roleDefaults[profile.role]?.[event]
    if (def === 'on') return true
    if (def === 'off') return false
    if (def === 'own_projects') return ownerIds.has(profile.id)
  }
  return false
}

function deepLink(event: string, proofId: string | null): string {
  if (FULFILMENT_EVENTS.has(event)) return '/orders'
  if (event === 'project_flagged') return '/flagged'
  return proofId ? `/proofs/${proofId}` : '/'
}

// Team-chat @mention fan-out. Recipients are the explicit mentioned users (not
// derived from any proof), so this is self-contained: for each, respect an
// account-wide pause or an explicit "mentions off", dedup via the outbox, send
// to every device, prune dead subscriptions. Deep-links to /chat.
async function handleChatMention(
  admin: SupabaseClient,
  body: Body,
  copyMap: Record<string, { title: string; body: string }>,
): Promise<Response> {
  const recipientIds = Array.from(
    new Set((body.recipient_user_ids ?? []).filter((id): id is string => !!id)),
  ).filter((id) => id !== body.actor_user_id)
  if (recipientIds.length === 0) return json({ status: 'skipped', reason: 'no_recipients' })

  const copy = copyMap['team_chat_mention'] ?? { title: '{actor} mentioned you', body: '{snippet}' }
  const vars = { ...(body.vars ?? {}) }
  const payload: PushPayload = {
    title: clip(interpolate(copy.title, vars), 30),
    body: clip(interpolate(copy.body, vars), 120),
    url: '/chat',
    tag: `chat:${body.source_event_id}`,
  }

  let sent = 0
  let skipped = 0
  for (const recipientId of recipientIds) {
    const { data: prof } = await admin
      .from('profiles')
      .select('id')
      .eq('id', recipientId)
      .is('deactivated_at', null)
      .maybeSingle()
    if (!prof) {
      skipped++
      continue
    }
    const { data: prefRow } = await admin
      .from('notification_preferences')
      .select('prefs')
      .eq('user_id', recipientId)
      .maybeSingle()
    const prefs = (prefRow as { prefs?: Record<string, unknown> } | null)?.prefs ?? {}
    if (prefs._muted === true || prefs['team_chat_mention'] === 'off') {
      skipped++
      continue
    }

    const { error: insErr } = await admin.from('notification_outbox').insert({
      event_code: 'team_chat_mention',
      source_kind: 'chat',
      source_event_id: body.source_event_id,
      proof_id: null,
      order_id: null,
      recipient_user_id: recipientId,
      title: payload.title,
      body: payload.body,
      url: payload.url,
      status: 'queued',
    })
    if (insErr) {
      if ((insErr as { code?: string }).code === '23505') {
        skipped++
        continue
      }
      console.error('[send-push] mention outbox insert failed', insErr)
      continue
    }

    const { data: subs } = await admin
      .from('push_subscriptions')
      .select('id, endpoint, p256dh, auth')
      .eq('user_id', recipientId)
    const devices = (subs ?? []) as Array<{ id: string; endpoint: string; p256dh: string; auth: string }>
    if (devices.length === 0) {
      await setOutcome(admin, 'team_chat_mention', body, recipientId, 'no_subscription')
      continue
    }

    let anySent = false
    for (const d of devices) {
      const outcome = await sendPush({ endpoint: d.endpoint, p256dh: d.p256dh, auth: d.auth }, payload)
      if (outcome.ok) {
        anySent = true
      } else if (outcome.status === 404 || outcome.status === 410) {
        await admin.from('push_subscriptions').delete().eq('id', d.id)
      } else {
        await admin
          .from('push_subscriptions')
          .update({ last_failure_code: outcome.status ?? null })
          .eq('id', d.id)
      }
    }
    await setOutcome(admin, 'team_chat_mention', body, recipientId, anySent ? 'sent' : 'failed')
    if (anySent) sent++
  }

  return json({ status: 'ok', recipients: recipientIds.length, sent, skipped })
}

async function setOutcome(
  admin: SupabaseClient,
  eventCode: string,
  body: Body,
  recipientId: string,
  status: string,
): Promise<void> {
  await admin
    .from('notification_outbox')
    .update({ status })
    .eq('event_code', eventCode)
    .eq('source_kind', body.source_kind)
    .eq('source_event_id', body.source_event_id)
    .eq('recipient_user_id', recipientId)
}

async function resolveContext(
  admin: SupabaseClient,
  body: Body,
): Promise<{ proofId: string | null; ownerIds: Set<string>; company: string }> {
  const ownerIds = new Set<string>()
  let proofId: string | null = body.proof_id ?? null
  let contactId: string | null = null

  // From a version: gives us the version author + the proof + its owner/contact.
  if (body.proof_version_id) {
    const { data } = await admin
      .from('proof_versions')
      .select('created_by, proof_id, proofs:proof_id ( id, created_by, contact_id )')
      .eq('id', body.proof_version_id)
      .maybeSingle()
    const v = data as
      | { created_by: string | null; proof_id: string; proofs: { id: string; created_by: string | null; contact_id: string | null } | null }
      | null
    if (v) {
      if (v.created_by) ownerIds.add(v.created_by)
      proofId = v.proofs?.id ?? v.proof_id ?? proofId
      if (v.proofs?.created_by) ownerIds.add(v.proofs.created_by)
      contactId = v.proofs?.contact_id ?? null
    }
  }

  // From an order: gives us the order creator + its proof.
  if (!proofId && body.order_id) {
    const { data } = await admin
      .from('orders')
      .select('created_by, proof_id')
      .eq('id', body.order_id)
      .maybeSingle()
    const o = data as { created_by: string | null; proof_id: string | null } | null
    if (o) {
      if (o.created_by) ownerIds.add(o.created_by)
      proofId = o.proof_id ?? proofId
    }
  }

  // Round out the owner set + contact from the proof itself.
  if (proofId && (ownerIds.size === 0 || !contactId)) {
    const { data } = await admin
      .from('proofs')
      .select('created_by, contact_id')
      .eq('id', proofId)
      .maybeSingle()
    const pr = data as { created_by: string | null; contact_id: string | null } | null
    if (pr) {
      if (pr.created_by) ownerIds.add(pr.created_by)
      contactId = contactId ?? pr.contact_id
    }
    // The current version's author is also a natural owner.
    const { data: cv } = await admin
      .from('proof_versions')
      .select('created_by')
      .eq('proof_id', proofId)
      .eq('is_current', true)
      .maybeSingle()
    const cvRow = cv as { created_by: string | null } | null
    if (cvRow?.created_by) ownerIds.add(cvRow.created_by)
  }

  // Company label for the copy: company name, else contact name, else generic.
  let company = 'A customer'
  if (contactId) {
    const { data } = await admin
      .from('contacts')
      .select('full_name, companies:company_id ( name )')
      .eq('id', contactId)
      .maybeSingle()
    const c = data as { full_name: string | null; companies: { name: string | null } | null } | null
    company = c?.companies?.name || c?.full_name || 'A customer'
  }

  return { proofId, ownerIds, company }
}
