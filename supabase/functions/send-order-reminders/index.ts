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
// COMBINED PAYMENTS (migration 000388). A member of a live payment group is not
// chased on its own link — that link refuses payment while the group is active
// (create-checkout-session → order_in_group), so a reminder pointing at it
// would send the customer somewhere they cannot pay. Instead the GROUP is
// chased as one unit on the combined /order/group/ link, capped and spaced per
// group by the same admin cadence. Between 000309 and 000388 those members were
// simply dropped, so combined payments were never chased at all — GRP-20509458EE
// was opened by the customer and then lapsed unpaid without a single reminder.
//
// Everything below treats a group and a single order as the same thing: a
// ChaseTarget, built by buildTargets() and then run through ONE loop with one
// set of guards. That is deliberate — "chased in the same manner as standalone
// orders" is the requirement, and the way to keep that true a year from now is
// to leave exactly one implementation of the manner.
//
// Two things a group needs that a single order gets for free:
//   * A thread. A group has none of its own and its members' proofs often span
//     several, so the sender nominates the one the combined link was actually
//     sent on — see pickRepresentative().
//   * Send evidence. create-order posts a single order's pay link itself, so
//     its sent_at really does mean "the customer has it". A group link is
//     copied by hand, so sent_at only means the link exists. No reply on any
//     member thread since the group was created ⇒ nobody has been told ⇒
//     skipped_no_send_evidence rather than a reminder about a link the
//     customer has never seen.
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
import { pingHeartbeat } from '../_shared/heartbeat.ts'

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
  order_group_id: string | null
}

interface GroupRow {
  id: string
  status: string
  sent_at: string | null
  expires_at: string | null
  token: string
  payment_reference: string | null
}

interface LedgerInsert {
  order_id: string
  /** Set only on a group-level reminder (000388); null for a single order. */
  order_group_id?: string | null
  reminder_no: number
  source: 'auto'
  state: 'sending' | 'sent' | 'failed' | 'skipped' | 'dry_run'
  outcome: string
  helpscout_conversation_id: string | null
  rendered_body?: string | null
}

/**
 * One thing to chase — a single order, or a whole combined payment. Built once
 * up front so the send loop below can be identical for both.
 */
interface ChaseTarget {
  kind: 'order' | 'group'
  /** Ledger identity: what the cap is counted by, and the emitted-stages key. */
  ledgerKey: string
  /**
   * The order the ledger row is booked against. For a group this is the
   * REPRESENTATIVE member — the one whose Help Scout thread the reminder goes
   * out on — because order_nudges.order_id is NOT NULL and every existing
   * reader (proof timeline, order log, dashboard activity) joins through it.
   */
  orderId: string
  groupId: string | null
  /** The proof whose Help Scout thread the reminder posts on. */
  proofId: string
  /**
   * Every proof whose state gates this chase. Identical to [proofId] for a
   * single order; for a group it is all its members, so a 'follow up' tag or a
   * recent reply on ANY of the customer's threads pauses the whole thing. A
   * group is one conversation with one person however many projects it spans.
   */
  contextProofIds: string[]
  /** The cadence clock: reminder k is due k × interval days after this. */
  sentAt: string
  expiresAt: string | null
  /** The customer-facing pay link this reminder points at. */
  url: string
  templateId: string
  /** For run logs and the errors array. */
  label: string
  /**
   * A skip decided while building the target rather than in the send loop.
   * Applied AFTER the stage is worked out, so the ledger row still records
   * which reminder it was that didn't go — a skip with no stage number is
   * unreadable in the Outbox.
   */
  blocked?: string
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

  // ── Candidates: live unpaid single orders, and live unpaid groups ──────────
  // status filtered to 'sent' (paid / expired / cancelled / fulfilled drop
  // out). Expiry is filtered in JS so a null (no-expiry) order still qualifies
  // for reminder 1 without wrestling PostgREST's .or() timestamp parsing.
  const { data: orderRowsRaw, error: ordersErr } = await admin
    .from('orders')
    .select('id, proof_id, sent_at, expires_at, token, currency, order_group_id')
    .eq('status', 'sent')
    .not('sent_at', 'is', null)
  if (ordersErr) return json({ error: `orders: ${ordersErr.message}` }, 500)
  const orderRows = (orderRowsRaw ?? []) as OrderRow[]

  // The combined payments those members belong to (000309).
  const memberGroupIds = [...new Set(orderRows.map((o) => o.order_group_id).filter((g): g is string => !!g))]
  const groupById = new Map<string, GroupRow>()
  if (memberGroupIds.length > 0) {
    const { data: groupRows, error: groupsErr } = await admin
      .from('order_groups')
      .select('id, status, sent_at, expires_at, token, payment_reference')
      .in('id', memberGroupIds)
    if (groupsErr) return json({ error: `order_groups: ${groupsErr.message}` }, 500)
    for (const g of (groupRows ?? []) as GroupRow[]) groupById.set(g.id, g)
  }

  const notExpired = (expiresAt: string | null) => expiresAt == null || Date.parse(expiresAt) > now.getTime()

  // A member whose group is cancelled — or whose group row has vanished — is
  // chased as an ordinary single order. Cancelling a group releases its members
  // and re-livens their own links, and create-checkout-session only refuses a
  // NON-cancelled group, so that link really is payable again; a leftover
  // pointer is a husk, not a reason to stay silent.
  const inLiveGroup = (o: OrderRow): boolean => {
    if (!o.order_group_id) return false
    const g = groupById.get(o.order_group_id)
    return g != null && g.status === 'sent'
  }

  const soloLive = orderRows.filter((o) => !inLiveGroup(o) && notExpired(o.expires_at))

  // Dedupe to the LATEST live order per proof. A proof can accumulate several
  // 'sent' orders (a reissued link, or test spam — the live data already has
  // five for one proof); the most-recently-sent link is the operative one, and
  // reminding on the older siblings would nudge the same customer repeatedly on
  // one Help Scout thread. Older siblings are recorded as skipped for the
  // Outbox, not silently dropped.
  const latestByProof = new Map<string, OrderRow>()
  const superseded: OrderRow[] = []
  for (const o of [...soloLive].sort((a, b) => Date.parse(b.sent_at) - Date.parse(a.sent_at))) {
    if (latestByProof.has(o.proof_id)) superseded.push(o)
    else latestByProof.set(o.proof_id, o)
  }
  const soloCandidates = [...latestByProof.values()]

  // Live groups still holding at least one unpaid member. The group's own
  // expiry is the hard stop (its members' individual expiries are dormant while
  // grouped — the combined link is the only payable one).
  const membersOf = (groupId: string) => orderRows.filter((o) => o.order_group_id === groupId)
  const groupCandidates = [...groupById.values()].filter((g) =>
    g.status === 'sent' && g.sent_at != null && notExpired(g.expires_at) && membersOf(g.id).length > 0
  )

  // ── Joined context (flat reads, joined in JS — volume is tiny) ─────────────
  // Every group member's proof is loaded, not just a nominated one: the
  // representative is chosen FROM this context (by reply recency), and the tag
  // and grace guards read across all of them.
  const proofIds = [...new Set([
    ...soloCandidates.map((o) => o.proof_id),
    ...groupCandidates.flatMap((g) => membersOf(g.id).map((o) => o.proof_id)),
  ])]
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

  const baseUrl = (Deno.env.get('PROOF_VIEWER_BASE_URL')?.trim() ?? '').replace(/\/+$/, '')
  const defaultUserId = Number(Deno.env.get('HELPSCOUT_DEFAULT_USER_ID')?.trim() ?? '')

  // ── Build the chase targets ────────────────────────────────────────────────
  const targets: ChaseTarget[] = soloCandidates.map((o) => ({
    kind: 'order' as const,
    ledgerKey: `order:${o.id}`,
    orderId: o.id,
    groupId: null,
    proofId: o.proof_id,
    contextProofIds: [o.proof_id],
    sentAt: o.sent_at,
    expiresAt: o.expires_at,
    url: `${baseUrl}/order/${o.id}?token=${encodeURIComponent(o.token)}`,
    templateId: 'order_reminder_1',
    label: o.id,
  }))

  /**
   * Which member's Help Scout thread a group reminder goes out on.
   *
   * A combined payment has no thread of its own, and its members' proofs often
   * span several (5 of 10 paid groups on live), so the honest answer is
   * "wherever the combined link was actually sent" — and the evidence for that
   * is a reply on a member thread dated after the group was created. Newest
   * such reply wins; the common single-thread case collapses to the same
   * answer.
   *
   * Any reply counts, staff or customer. A customer replying on that thread
   * after the group was created means the conversation about this payment is
   * live there too, which is just as good a place to be reminded — and the case
   * this guard exists to catch is "nobody has told the customer anything at
   * all", which a reply of either kind rules out.
   *
   * Null when no member thread has such a reply: the link exists, but nobody
   * has been sent it, so there is nothing to remind them about yet.
   */
  const pickRepresentative = (group: GroupRow): OrderRow | null => {
    const sentMs = Date.parse(group.sent_at as string)
    let best: OrderRow | null = null
    let bestMs = -Infinity
    for (const m of membersOf(group.id)) {
      const p = proofMap.get(m.proof_id)
      if (!p?.conversationId) continue
      const replyMs = p.lastReplyAt ? Date.parse(p.lastReplyAt) : -Infinity
      if (!(replyMs > sentMs)) continue
      if (replyMs > bestMs) { best = m; bestMs = replyMs }
    }
    return best
  }

  // Where to book a group's row when there is no representative. order_id is
  // NOT NULL, so a skip still needs a member; the earliest-sent one is the
  // stable pick (id breaks ties) so the skip doesn't hop around the group from
  // run to run and read as several different problems.
  const earliestMember = (groupId: string): OrderRow | null =>
    [...membersOf(groupId)].sort((a, b) => {
      const d = Date.parse(a.sent_at) - Date.parse(b.sent_at)
      return d !== 0 ? d : (a.id < b.id ? -1 : 1)
    })[0] ?? null

  for (const g of groupCandidates) {
    const rep = pickRepresentative(g)
    const anchor = rep ?? earliestMember(g.id)
    if (!anchor) continue // no members left to book against; nothing to chase
    targets.push({
      kind: 'group',
      ledgerKey: `group:${g.id}`,
      orderId: anchor.id,
      groupId: g.id,
      proofId: anchor.proof_id,
      contextProofIds: [...new Set(membersOf(g.id).map((m) => m.proof_id))],
      sentAt: g.sent_at as string,
      expiresAt: g.expires_at,
      url: `${baseUrl}/order/group/${g.id}?token=${encodeURIComponent(g.token)}`,
      templateId: 'order_reminder_group',
      label: g.payment_reference ?? g.id,
      blocked: rep ? undefined : 'skipped_no_send_evidence',
    })
  }

  // ── Which reminder stages has each target already had? ─────────────────────
  // A stage counts as emitted if a real send claimed it (sending/sent), or —
  // in dry-run only — if a prior dry run already logged a would_send for it, so
  // a dry week doesn't re-emit the same stage every day.
  //
  // ⚠ The two ledgers are read SEPARATELY, matching the disjoint claim indexes
  // in 000388: a single order's stages are its rows carrying no group id, and a
  // group's are its rows by group id. Reading a member's rows without that
  // filter would count the group's reminders against the member — so a member
  // released back to its own live link would resume mid-sequence, or, once the
  // group cap was spent, never be chased on that new link at all.
  const emitted = new Map<string, Set<number>>()
  {
    const record = (key: string, row: { reminder_no: unknown; source: unknown; state: unknown; outcome: unknown }) => {
      const realSend = row.source === 'auto' && (row.state === 'sending' || row.state === 'sent')
      const dryWould = mode === 'dry_run' && row.state === 'dry_run' && typeof row.outcome === 'string' && row.outcome.startsWith('would_send')
      if (!realSend && !dryWould) return
      const set = emitted.get(key) ?? new Set<number>()
      set.add(row.reminder_no as number)
      emitted.set(key, set)
    }
    const soloIds = soloCandidates.map((o) => o.id)
    if (soloIds.length > 0) {
      const { data: nudges } = await admin
        .from('order_nudges')
        .select('order_id, reminder_no, source, state, outcome')
        .in('order_id', soloIds)
        .is('order_group_id', null)
      for (const n of nudges ?? []) record(`order:${n.order_id as string}`, n)
    }
    const groupTargetIds = targets.map((t) => t.groupId).filter((g): g is string => !!g)
    if (groupTargetIds.length > 0) {
      const { data: nudges } = await admin
        .from('order_nudges')
        .select('order_group_id, reminder_no, source, state, outcome')
        .in('order_group_id', groupTargetIds)
      for (const n of nudges ?? []) record(`group:${n.order_group_id as string}`, n)
    }
  }

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
  const logSkip = async (target: ChaseTarget, reminderNo: number, outcome: string, conversationId: string | null) => {
    const id = await insertLedger({
      order_id: target.orderId, order_group_id: target.groupId,
      reminder_no: reminderNo, source: 'auto', state: logState, outcome,
      helpscout_conversation_id: conversationId,
    })
    if (id) skipped++
  }

  // Superseded siblings are dropped silently (they never get a ledger row —
  // logging them would re-write daily since they're never claimed). The run
  // summary reports the count.

  // Template bodies (DB row → seeded fallback), fetched once.
  const bodies: Record<string, string> = { ...ORDER_REMINDER_DEFAULT_BODIES }
  {
    const { data: tpls } = await admin.from('reply_templates').select('id, body').in('id', ['order_reminder_1', 'order_reminder_group'])
    for (const t of tpls ?? []) {
      if (typeof t.body === 'string' && t.body.trim() !== '') bodies[t.id as string] = t.body as string
    }
  }
  const expiryFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

  for (const target of targets) {
    const proof = proofMap.get(target.proofId)
    const contact = proof?.contactId ? contactMap.get(proof.contactId) : undefined
    const company = contact?.companyId ? (companyMap.get(contact.companyId) ?? null) : null
    const conversationId = proof?.conversationId ?? null
    const stagesDone = emitted.get(target.ledgerKey) ?? new Set<number>()
    // The proofs whose tags + reply stamps gate this chase: just this one for a
    // single order, every member for a group.
    const contextProofs = target.contextProofIds.map((id) => proofMap.get(id)).filter((p): p is NonNullable<typeof p> => !!p)

    // ── Which reminder (if any) is due now? ──────────────────────────────────
    // Reminders run 1..maxReminders, one per run. The next reminder is one past
    // the highest already emitted; it's due once that many intervals have
    // elapsed since the link was sent, and only while the link is still live
    // (expiry, if set, is the hard stop). A cron that missed days catches up one
    // reminder per run rather than bursting.
    const sentMs = Date.parse(target.sentAt)
    const expiresMs = target.expiresAt ? Date.parse(target.expiresAt) : null
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
    // Decided while building the target (today: a group whose combined link has
    // never been sent to anyone). Applied here so the row carries the stage.
    if (target.blocked) { await logSkip(target, stage, target.blocked, conversationId); continue }
    if (!conversationId) { await logSkip(target, stage, 'skipped_no_conversation', null); continue }
    // A 'follow up' tag on ANY thread this chase covers means a human has taken
    // it on. For a group that is deliberately broader than the thread we would
    // post to: the tag is about the customer, not the project.
    if (contextProofs.some((p) => p.tags.some((t) => t.trim().toLowerCase() === 'follow up'))) {
      await logSkip(target, stage, 'skipped_followup_tag', conversationId); continue
    }
    // Comms grace (mirror proof side): greatest(staff, customer) reply within
    // the window pauses the chase. Calendar days, matching the 000208 guard.
    // A skip row doesn't occupy the claim slot (that's a partial index on
    // sending/sent), so this stage still sends once the grace window lapses —
    // the pause is transient, not terminal.
    //
    // Across every covered thread for a group: replying about one of the cards
    // is still a live conversation with the person we are about to chase for
    // the payment that covers all of them.
    const lastReplyMs = Math.max(
      -Infinity,
      ...contextProofs.flatMap((p) => [
        p.lastReplyAt ? Date.parse(p.lastReplyAt) : -Infinity,
        p.lastCustomerReplyAt ? Date.parse(p.lastCustomerReplyAt) : -Infinity,
      ]),
    )
    if (lastReplyMs > -Infinity && now.getTime() - lastReplyMs < graceDays * DAY_MS) {
      await logSkip(target, stage, 'skipped_grace_window', conversationId); continue
    }
    if (!baseUrl) { await logSkip(target, stage, 'skipped_no_base_url', conversationId); continue }

    const orderUrl = target.url
    const orderExpiry = expiresMs != null ? expiryFmt.format(new Date(expiresMs)) : ''
    // One repeating template per kind since 000270 / 000388; both mention expiry
    // only when set, via a {? order_expiry} conditional block.
    const templateId = target.templateId
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
      if (problem) { await logSkip(target, stage, `render_failed: ${problem}`, conversationId); continue }
      const id = await insertLedger({
        order_id: target.orderId, order_group_id: target.groupId,
        reminder_no: stage, source: 'auto', state: 'dry_run',
        outcome: 'would_send', helpscout_conversation_id: conversationId, rendered_body: renderTemplate(body, ctx),
      })
      if (id) sent++
      continue
    }

    // ── LIVE ─────────────────────────────────────────────────────────────────
    if (!appId || !appSecret) { await logSkip(target, stage, 'skipped_helpscout_unconfigured', conversationId); continue }
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

      if (!conv) { await logSkip(target, stage, 'skipped_conversation_missing', conversationId); continue }
      const status = (conv.status ?? '').toLowerCase()
      if (status === 'closed' || status === 'spam') { await logSkip(target, stage, 'skipped_closed_conversation', conversationId); continue }

      // Recipient match: the email HS will actually send to vs the proof's
      // contact. Either side missing is a mismatch — fail toward a human.
      // For a group this is the REPRESENTATIVE member's contact; every group on
      // live has one contact across all its members, and the modal makes the
      // designer confirm one payer, but this check is what makes that a fact
      // rather than an assumption at send time.
      const hsEmail = (conv.primaryCustomer?.email ?? '').trim().toLowerCase()
      const contactEmail = (contact?.email ?? '').trim().toLowerCase()
      if (!hsEmail || !contactEmail || hsEmail !== contactEmail) { await logSkip(target, stage, 'recipient_mismatch', conversationId); continue }

      const firstName = (conv.primaryCustomer?.first ?? '').trim() || contactFirst
      const ctx = buildCtx(firstName)
      const problem = templateProblem(body, ctx, 'order_url')
      if (problem) { await logSkip(target, stage, `render_failed: ${problem}`, conversationId); continue }
      const rendered = renderTemplate(body, ctx)

      // Claim first (architecture rule #2).
      claimId = await insertLedger({
        order_id: target.orderId, order_group_id: target.groupId,
        reminder_no: stage, source: 'auto', state: 'sending',
        outcome: 'sending', helpscout_conversation_id: conversationId, rendered_body: rendered,
      })
      if (!claimId) { console.warn('[send-order-reminders] claim conflict', { target: target.label, kind: target.kind, stage }); continue }

      const senderId = conv.assignee?.id ?? (Number.isInteger(defaultUserId) && defaultUserId > 0 ? defaultUserId : null)
      if (!senderId) {
        await admin.from('order_nudges').update({ state: 'failed', outcome: 'failed: no sender identity (set HELPSCOUT_DEFAULT_USER_ID)' }).eq('id', claimId)
        errors.push({ target: target.label, error: 'no sender identity' }); continue
      }
      const customerId = conv.primaryCustomer?.id
      if (!customerId) {
        await admin.from('order_nudges').update({ state: 'failed', outcome: 'failed: conversation has no primary customer' }).eq('id', claimId)
        errors.push({ target: target.label, error: 'no primary customer' }); continue
      }

      const threadId = await postStaffReply(token, conversationId, { text: rendered, userId: senderId, customerId })

      await admin.from('order_nudges').update({ state: 'sent', outcome: 'sent', helpscout_thread_id: threadId || null }).eq('id', claimId)
      sent++

      // Audited against the thing that was actually chased, so a combined
      // payment's reminders read as the group's own history rather than as
      // reminders about one card that happened to host them.
      await admin.from('audit_log').insert({
        actor_id: null,
        actor_label: 'Automated reminder',
        action: 'order.auto_reminder_sent',
        target_type: target.kind === 'group' ? 'order_group' : 'order',
        target_id: target.groupId ?? target.orderId,
        metadata: {
          reminder_no: stage, template_id: templateId, nudge_id: claimId,
          helpscout_thread_id: threadId || null, automated: true,
          ...(target.kind === 'group' ? { order_group_id: target.groupId, representative_order_id: target.orderId } : {}),
        },
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
      errors.push({ target: target.label, error: detail })
      console.error('[send-order-reminders] item failed', { target: target.label, kind: target.kind, detail })
      // A claim left in 'sending' after a non-HsError is deliberate: the POST
      // may have landed, so it is never auto-retried.
    }
  }

  // Better Stack heartbeat — the external "this job completed" signal.
  // pg_cron's `succeeded` only means it queued the pg_net request, so without
  // this nothing outside the function can tell a completed run from a silently
  // dead one. On the success path only: this line is unreachable if the run
  // threw. No-op until the secret is set; never throws, so it cannot cost a
  // run of reminders.
  await pingHeartbeat('BETTERSTACK_HEARTBEAT_ORDER_REMINDERS')

  return json({
    ok: true, mode, note: modeNote || undefined,
    candidates: targets.length,
    orders: targets.filter((t) => t.kind === 'order').length,
    groups: targets.filter((t) => t.kind === 'group').length,
    superseded: superseded.length,
    sent, skipped, errors: errors.length,
  })
}
