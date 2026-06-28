// Automated unpaid-order reminder sender. The order-side companion to
// send-nudges (the proof follow-up sender) — see docs/followup-automation-spec.md
// for the proof version's architecture, which this deliberately mirrors in
// miniature.
//
// Invoked by pg_cron on the merged stock project via net.http_post with the
// service-role key as Bearer (same pattern as send-nudges). verify_jwt = true,
// so the platform validates the JWT first; the handler then requires the
// Bearer to carry the service_role claim, so neither anon nor designer JWTs
// can trigger a run.
//
// What it does: for each order whose pay-link was sent but not paid and is
// still live (status 'sent', expires_at in the future or unset), it sends a
// repeating reminder on the proof's Help Scout thread. The cadence is admin-set
// (settings.order_reminders_max / order_reminder_interval_days, migration
// 000270): reminder k goes out once k × interval days have passed since the
// link was sent, up to the max, one per run, and never after the link expires.
// The moment the order is paid / expires / is cancelled it drops out of the
// candidate set, so no further reminders go out.
//
// Two architecture rules carried over from the proof sender:
//   #1 The sender is the authority — every guard is re-checked in THIS run
//      immediately before a send (status, expiry, follow-up tag, recipient).
//   #2 Claim first, send second — the order_nudges row is INSERTed in state
//      'sending' under the (order_id, reminder_no) unique index BEFORE the
//      Help Scout POST, then flipped to sent/failed.
//
// Mode: live iff settings.auto_order_reminders_enabled AND replies_enabled
// (the master gate), AND inside the London send window. Anything else runs
// dry: the full pipeline executes but nothing posts and every ledger row is
// state 'dry_run' with outcome 'would_send' / a skip reason. Phase 1 IS the
// dry run; the rollout flips auto_order_reminders_enabled later.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (platform), HELPSCOUT_APP_ID,
// HELPSCOUT_APP_SECRET, HELPSCOUT_DEFAULT_USER_ID, PROOF_VIEWER_BASE_URL —
// the same secrets send-nudges already uses; nothing new to configure.

import { createClient } from 'jsr:@supabase/supabase-js@2'
import {
  fetchConversationWithThreads,
  getAccessToken,
  HsError,
  postStaffReply,
  type HsConversationWithThreads,
} from '../_shared/helpscout.ts'
import {
  ORDER_REMINDER_DEFAULT_BODIES,
  renderTemplate,
  templateProblem,
  type TemplateContext,
} from '../_shared/replyTemplates.ts'
import {
  EW_BANK_HOLIDAYS_FALLBACK,
  isWithinSendWindow,
} from '../_shared/nudgeDecision.ts'

const DAY_MS = 24 * 60 * 60 * 1000
// Cadence fallbacks. The live figures come from settings (order_reminders_max /
// order_reminder_interval_days, migration 000270); these apply only if a column
// reads null. Reminder k is sent once k × interval days have passed since the
// link was sent, up to the max, one per run, never past expiry.
const DEFAULT_REMINDERS_MAX = 3
const DEFAULT_INTERVAL_DAYS = 3

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

// Constant-time string compare (same shape as send-nudges' gate).
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// Role claim of an already-platform-verified JWT (verify_jwt = true makes this
// a verified claim, not trusted client input). A project can hold more than
// one legitimately-minted service-role JWT, so byte-equality alone is brittle.
function bearerRole(bearer: string): string | null {
  const parts = bearer.split('.')
  if (parts.length !== 3) return null
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
    const payload = JSON.parse(atob(padded)) as { role?: unknown }
    return typeof payload.role === 'string' ? payload.role : null
  } catch {
    return null
  }
}

// gov.uk bank-holidays feed (england-and-wales), best-effort with the embedded
// fallback so a gov.uk outage never stops the run.
async function fetchBankHolidays(): Promise<ReadonlySet<string>> {
  try {
    const resp = await fetch('https://www.gov.uk/bank-holidays.json', { signal: AbortSignal.timeout(5000) })
    if (resp.ok) {
      const data = await resp.json() as { 'england-and-wales'?: { events?: Array<{ date?: string }> } }
      const dates = (data['england-and-wales']?.events ?? []).map((e) => e.date).filter((d): d is string => typeof d === 'string')
      if (dates.length > 0) return new Set(dates)
    }
  } catch (err) {
    console.warn('[send-order-reminders] gov.uk holidays fetch failed, using fallback', err)
  }
  return new Set(EW_BANK_HOLIDAYS_FALLBACK)
}

// Inference-typed so the proofs schema pin survives into every .from() call.
function makeAdmin(supabaseUrl: string, serviceKey: string) {
  return createClient(supabaseUrl, serviceKey, {
    db: { schema: 'proofs' },
    auth: { persistSession: false, autoRefreshToken: false },
  })
}
type Admin = ReturnType<typeof makeAdmin>

interface OrderRow {
  id: string
  proof_id: string
  sent_at: string
  expires_at: string | null
  token: string
  currency: string
}

interface LedgerInsert {
  order_id: string
  reminder_no: number
  source: 'auto'
  state: 'sending' | 'sent' | 'failed' | 'skipped' | 'dry_run'
  outcome: string
  helpscout_conversation_id: string | null
  rendered_body?: string | null
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  if (!serviceKey || !supabaseUrl) return json({ error: 'missing supabase env' }, 500)

  const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  const authorised = bearer !== '' && (timingSafeEqual(bearer, serviceKey) || bearerRole(bearer) === 'service_role')
  if (!authorised) return json({ error: 'forbidden' }, 403)

  const admin = makeAdmin(supabaseUrl, serviceKey)
  try {
    return await run(admin)
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    console.error('[send-order-reminders] crashed:', msg, err instanceof Error ? err.stack : '')
    return json({ error: 'crash', detail: msg }, 500)
  }
})

async function run(admin: Admin): Promise<Response> {
  const now = new Date()

  // ── Mode resolution ──────────────────────────────────────────────────────
  const { data: settings, error: settingsErr } = await admin
    .from('settings')
    .select('auto_order_reminders_enabled, replies_enabled, order_reminders_max, order_reminder_interval_days')
    .eq('id', 1)
    .single()
  if (settingsErr) return json({ error: `settings: ${settingsErr.message}` }, 500)

  // Admin-tuned cadence (migration 000270), clamped to the column bounds with a
  // fallback in case a column reads null.
  const maxReminders = Math.min(5, Math.max(1, Number(settings?.order_reminders_max ?? DEFAULT_REMINDERS_MAX)))
  const intervalDays = Math.min(30, Math.max(1, Number(settings?.order_reminder_interval_days ?? DEFAULT_INTERVAL_DAYS)))

  // Comms grace — mirror the proof follow-up sender. If there's been a recent
  // reply on the Help Scout thread (customer OR staff) within the grace window,
  // pause the chase so an automated payment nag doesn't land mid-conversation.
  // Same knob the proof chase uses (site_settings.needs_attention_rules
  // .helpscout_reply_grace_days, calendar days, default 3); not duplicated onto
  // a separate order-specific setting.
  let graceDays = 3
  {
    const { data: site } = await admin.from('site_settings').select('needs_attention_rules').eq('id', 1).maybeSingle()
    const rules = (site?.needs_attention_rules ?? {}) as Record<string, unknown>
    graceDays = Number((rules['helpscout_reply_grace_days'] as number | undefined) ?? 3)
  }

  const bankHolidays = await fetchBankHolidays()

  let mode: 'live' | 'dry_run' = 'dry_run'
  let modeNote = ''
  if (settings?.auto_order_reminders_enabled !== true) {
    modeNote = 'dry run: auto_order_reminders_enabled is off'
  } else if (settings?.replies_enabled !== true) {
    modeNote = 'dry run: replies are paused (master gate)'
  } else if (!isWithinSendWindow(now, bankHolidays)) {
    modeNote = 'dry run: outside the London send window'
  } else {
    mode = 'live'
  }

  let sent = 0
  let skipped = 0
  const errors: Array<Record<string, unknown>> = []

  // ── Candidate orders: live, sent, unpaid ───────────────────────────────────
  // status filtered to 'sent' (paid / expired / cancelled / fulfilled drop
  // out). Expiry is filtered in JS so a null (no-expiry) order still qualifies
  // for reminder 1 without wrestling PostgREST's .or() timestamp parsing.
  const { data: orderRowsRaw, error: ordersErr } = await admin
    .from('orders')
    .select('id, proof_id, sent_at, expires_at, token, currency')
    .eq('status', 'sent')
    .not('sent_at', 'is', null)
  if (ordersErr) return json({ error: `orders: ${ordersErr.message}` }, 500)

  const live = (orderRowsRaw ?? []).filter((o) =>
    o.expires_at == null || Date.parse(o.expires_at as string) > now.getTime()
  ) as OrderRow[]

  // Dedupe to the LATEST live order per proof. A proof can accumulate several
  // 'sent' orders (a reissued link, or test spam — the live data already has
  // five for one proof); the most-recently-sent link is the operative one, and
  // reminding on the older siblings would nudge the same customer repeatedly on
  // one Help Scout thread. Older siblings are recorded as skipped for the
  // Outbox, not silently dropped.
  const latestByProof = new Map<string, OrderRow>()
  const superseded: OrderRow[] = []
  for (const o of [...live].sort((a, b) => Date.parse(b.sent_at) - Date.parse(a.sent_at))) {
    if (latestByProof.has(o.proof_id)) superseded.push(o)
    else latestByProof.set(o.proof_id, o)
  }
  const candidates = [...latestByProof.values()]

  // ── Joined context (flat reads, joined in JS — volume is tiny) ─────────────
  const proofIds = [...new Set(candidates.map((o) => o.proof_id))]
  const proofMap = new Map<string, { conversationId: string | null; tags: string[]; contactId: string | null; lastReplyAt: string | null; lastCustomerReplyAt: string | null }>()
  const contactMap = new Map<string, { fullName: string | null; email: string | null; companyId: string | null }>()
  const companyMap = new Map<string, string>()

  if (proofIds.length > 0) {
    const { data: proofs } = await admin
      .from('proofs')
      .select('id, helpscout_conversation_id, helpscout_tags, contact_id, helpscout_last_reply_at, helpscout_last_customer_reply_at')
      .in('id', proofIds)
    for (const p of proofs ?? []) {
      proofMap.set(p.id as string, {
        conversationId: (p.helpscout_conversation_id as string | null) ?? null,
        tags: ((p.helpscout_tags as string[] | null) ?? []),
        contactId: (p.contact_id as string | null) ?? null,
        lastReplyAt: (p.helpscout_last_reply_at as string | null) ?? null,
        lastCustomerReplyAt: (p.helpscout_last_customer_reply_at as string | null) ?? null,
      })
    }
    const contactIds = [...new Set([...proofMap.values()].map((p) => p.contactId).filter((x): x is string => !!x))]
    if (contactIds.length > 0) {
      const { data: contacts } = await admin
        .from('contacts')
        .select('id, full_name, email, company_id')
        .in('id', contactIds)
      for (const c of contacts ?? []) {
        contactMap.set(c.id as string, {
          fullName: (c.full_name as string | null) ?? null,
          email: (c.email as string | null) ?? null,
          companyId: (c.company_id as string | null) ?? null,
        })
      }
      const companyIds = [...new Set([...contactMap.values()].map((c) => c.companyId).filter((x): x is string => !!x))]
      if (companyIds.length > 0) {
        const { data: companies } = await admin.from('companies').select('id, name').in('id', companyIds)
        for (const co of companies ?? []) companyMap.set(co.id as string, (co.name as string | null) ?? '')
      }
    }
  }

  // ── Which reminder stages has each order already had? ──────────────────────
  // A stage counts as emitted if a real send claimed it (sending/sent), or —
  // in dry-run only — if a prior dry run already logged a would_send for it, so
  // a dry week doesn't re-emit the same stage every day.
  const orderIds = candidates.map((o) => o.id)
  const emitted = new Map<string, Set<number>>()
  if (orderIds.length > 0) {
    const { data: nudges } = await admin
      .from('order_nudges')
      .select('order_id, reminder_no, source, state, outcome')
      .in('order_id', orderIds)
    for (const n of nudges ?? []) {
      const realSend = n.source === 'auto' && (n.state === 'sending' || n.state === 'sent')
      const dryWould = mode === 'dry_run' && n.state === 'dry_run' && typeof n.outcome === 'string' && n.outcome.startsWith('would_send')
      if (!realSend && !dryWould) continue
      const set = emitted.get(n.order_id as string) ?? new Set<number>()
      set.add(n.reminder_no as number)
      emitted.set(n.order_id as string, set)
    }
  }

  const baseUrl = (Deno.env.get('PROOF_VIEWER_BASE_URL')?.trim() ?? '').replace(/\/+$/, '')
  const defaultUserId = Number(Deno.env.get('HELPSCOUT_DEFAULT_USER_ID')?.trim() ?? '')

  // Help Scout token only fetched lazily when a live send is actually reached.
  let token: string | null = null
  const appId = Deno.env.get('HELPSCOUT_APP_ID')?.trim()
  const appSecret = Deno.env.get('HELPSCOUT_APP_SECRET')?.trim()

  const insertLedger = async (row: LedgerInsert): Promise<string | null> => {
    const { data, error } = await admin.from('order_nudges').insert(row).select('id').maybeSingle()
    if (error) {
      if (error.code === '23505') return null // claim conflict: another run handled it
      throw new Error(`order_nudges insert: ${error.message}`)
    }
    return (data?.id as string) ?? null
  }
  const logState = mode === 'live' ? 'skipped' : 'dry_run'
  const logSkip = async (order: OrderRow, reminderNo: number, outcome: string, conversationId: string | null) => {
    const id = await insertLedger({ order_id: order.id, reminder_no: reminderNo, source: 'auto', state: logState, outcome, helpscout_conversation_id: conversationId })
    if (id) skipped++
  }

  // Superseded siblings are dropped silently (they never get a ledger row —
  // logging them would re-write daily since they're never claimed). The run
  // summary reports the count.

  // Template bodies (DB row → seeded fallback), fetched once.
  const bodies: Record<string, string> = { ...ORDER_REMINDER_DEFAULT_BODIES }
  {
    const { data: tpls } = await admin.from('reply_templates').select('id, body').in('id', ['order_reminder_1'])
    for (const t of tpls ?? []) {
      if (typeof t.body === 'string' && t.body.trim() !== '') bodies[t.id as string] = t.body as string
    }
  }
  const expiryFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

  for (const order of candidates) {
    const proof = proofMap.get(order.proof_id)
    const contact = proof?.contactId ? contactMap.get(proof.contactId) : undefined
    const company = contact?.companyId ? (companyMap.get(contact.companyId) ?? null) : null
    const conversationId = proof?.conversationId ?? null
    const stagesDone = emitted.get(order.id) ?? new Set<number>()

    // ── Which reminder (if any) is due now? ──────────────────────────────────
    // Reminders run 1..maxReminders, one per run. The next reminder is one past
    // the highest already emitted; it's due once that many intervals have
    // elapsed since the link was sent, and only while the link is still live
    // (expiry, if set, is the hard stop). A cron that missed days catches up one
    // reminder per run rather than bursting.
    const sentMs = Date.parse(order.sent_at)
    const expiresMs = order.expires_at ? Date.parse(order.expires_at) : null
    const highestDone = stagesDone.size > 0 ? Math.max(...stagesDone) : 0
    const nextNo = highestDone + 1
    const dueAtMs = sentMs + nextNo * intervalDays * DAY_MS
    const stage: number | null =
      nextNo <= maxReminders &&
      now.getTime() >= dueAtMs &&
      (expiresMs == null || now.getTime() < expiresMs)
        ? nextNo
        : null
    if (stage == null) continue // not due — drop silently

    // ── Guards (architecture rule #1) ────────────────────────────────────────
    if (!conversationId) { await logSkip(order, stage, 'skipped_no_conversation', null); continue }
    if (proof!.tags.some((t) => t.trim().toLowerCase() === 'follow up')) {
      await logSkip(order, stage, 'skipped_followup_tag', conversationId); continue
    }
    // Comms grace (mirror proof side): greatest(staff, customer) reply within
    // the window pauses the chase. Calendar days, matching the 000208 guard.
    // A skip row doesn't occupy the (order, reminder_no) claim slot (that's a
    // partial index on sending/sent), so this stage still sends once the grace
    // window lapses — the pause is transient, not terminal.
    const lastReplyMs = Math.max(
      proof!.lastReplyAt ? Date.parse(proof!.lastReplyAt) : -Infinity,
      proof!.lastCustomerReplyAt ? Date.parse(proof!.lastCustomerReplyAt) : -Infinity,
    )
    if (lastReplyMs > -Infinity && now.getTime() - lastReplyMs < graceDays * DAY_MS) {
      await logSkip(order, stage, 'skipped_grace_window', conversationId); continue
    }
    if (!baseUrl) { await logSkip(order, stage, 'skipped_no_base_url', conversationId); continue }

    const orderUrl = `${baseUrl}/order/${order.id}?token=${encodeURIComponent(order.token)}`
    const orderExpiry = expiresMs != null ? expiryFmt.format(new Date(expiresMs)) : ''
    // One repeating template since 000270; it mentions expiry only when set,
    // via a {? order_expiry} conditional block.
    const templateId = 'order_reminder_1'
    const body = bodies[templateId]
    const contactFirst = (contact?.fullName ?? '').trim().split(/\s+/)[0] || ''

    const buildCtx = (firstName: string): TemplateContext => ({
      first_name: firstName,
      company,
      order_url: orderUrl,
      order_expiry: orderExpiry,
    })

    // ── DRY RUN: log what would happen, send nothing ─────────────────────────
    if (mode === 'dry_run') {
      const ctx = buildCtx(contactFirst)
      const problem = templateProblem(body, ctx, 'order_url')
      if (problem) { await logSkip(order, stage, `render_failed: ${problem}`, conversationId); continue }
      const id = await insertLedger({
        order_id: order.id, reminder_no: stage, source: 'auto', state: 'dry_run',
        outcome: 'would_send', helpscout_conversation_id: conversationId, rendered_body: renderTemplate(body, ctx),
      })
      if (id) sent++
      continue
    }

    // ── LIVE ─────────────────────────────────────────────────────────────────
    if (!appId || !appSecret) { await logSkip(order, stage, 'skipped_helpscout_unconfigured', conversationId); continue }
    let claimId: string | null = null
    try {
      if (!token) token = await getAccessToken(appId, appSecret)
      let conv: HsConversationWithThreads | null
      try {
        conv = await fetchConversationWithThreads(token, conversationId)
      } catch (err) {
        if (err instanceof HsError && err.status === 401) {
          token = await getAccessToken(appId, appSecret)
          conv = await fetchConversationWithThreads(token, conversationId)
        } else throw err
      }

      if (!conv) { await logSkip(order, stage, 'skipped_conversation_missing', conversationId); continue }
      const status = (conv.status ?? '').toLowerCase()
      if (status === 'closed' || status === 'spam') { await logSkip(order, stage, 'skipped_closed_conversation', conversationId); continue }

      // Recipient match: the email HS will actually send to vs the proof's
      // contact. Either side missing is a mismatch — fail toward a human.
      const hsEmail = (conv.primaryCustomer?.email ?? '').trim().toLowerCase()
      const contactEmail = (contact?.email ?? '').trim().toLowerCase()
      if (!hsEmail || !contactEmail || hsEmail !== contactEmail) { await logSkip(order, stage, 'recipient_mismatch', conversationId); continue }

      const firstName = (conv.primaryCustomer?.first ?? '').trim() || contactFirst
      const ctx = buildCtx(firstName)
      const problem = templateProblem(body, ctx, 'order_url')
      if (problem) { await logSkip(order, stage, `render_failed: ${problem}`, conversationId); continue }
      const rendered = renderTemplate(body, ctx)

      // Claim first (architecture rule #2).
      claimId = await insertLedger({
        order_id: order.id, reminder_no: stage, source: 'auto', state: 'sending',
        outcome: 'sending', helpscout_conversation_id: conversationId, rendered_body: rendered,
      })
      if (!claimId) { console.warn('[send-order-reminders] claim conflict', { orderId: order.id, stage }); continue }

      const senderId = conv.assignee?.id ?? (Number.isInteger(defaultUserId) && defaultUserId > 0 ? defaultUserId : null)
      if (!senderId) {
        await admin.from('order_nudges').update({ state: 'failed', outcome: 'failed: no sender identity (set HELPSCOUT_DEFAULT_USER_ID)' }).eq('id', claimId)
        errors.push({ order_id: order.id, error: 'no sender identity' }); continue
      }
      const customerId = conv.primaryCustomer?.id
      if (!customerId) {
        await admin.from('order_nudges').update({ state: 'failed', outcome: 'failed: conversation has no primary customer' }).eq('id', claimId)
        errors.push({ order_id: order.id, error: 'no primary customer' }); continue
      }

      const threadId = await postStaffReply(token, conversationId, { text: rendered, userId: senderId, customerId })

      await admin.from('order_nudges').update({ state: 'sent', outcome: 'sent', helpscout_thread_id: threadId || null }).eq('id', claimId)
      sent++

      await admin.from('audit_log').insert({
        actor_id: null,
        actor_label: 'Automated reminder',
        action: 'order.auto_reminder_sent',
        target_type: 'order',
        target_id: order.id,
        metadata: { reminder_no: stage, template_id: templateId, nudge_id: claimId, helpscout_thread_id: threadId || null, automated: true },
      })
    } catch (err) {
      // An HsError means HS rejected the POST (definitively unsent) — flip the
      // claim to failed rather than leave it squatting in 'sending'.
      if (claimId && err instanceof HsError) {
        await admin.from('order_nudges').update({ state: 'failed', outcome: `failed: hs_${err.status}` }).eq('id', claimId).eq('state', 'sending')
      }
      if (err instanceof HsError && err.status === 429) {
        errors.push({ error: 'hs_429_rate_limited, run stopped early' })
        console.error('[send-order-reminders] HS 429, stopping run early')
        break
      }
      const detail = err instanceof Error ? err.message : String(err)
      errors.push({ order_id: order.id, error: detail })
      console.error('[send-order-reminders] item failed', { orderId: order.id, detail })
      // A claim left in 'sending' after a non-HsError is deliberate: the POST
      // may have landed, so it is never auto-retried.
    }
  }

  return json({ ok: true, mode, note: modeNote || undefined, candidates: candidates.length, superseded: superseded.length, sent, skipped, errors: errors.length })
}
