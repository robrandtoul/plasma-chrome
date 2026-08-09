// The Reorder desk (migration 000389) — re-engaging past customers from the
// back book. A scored register of pre-system customers (seeded from three
// years of Xero invoice history) is served as a small daily worklist on the
// dashboard: the designer builds their proof from archived artwork, sends ONE
// personal outreach note, and at most ONE personal follow-up if the customer
// opened the page. Nothing in this flow ever emails anyone automatically —
// the desk selects, drafts, times and records; a person always sends.
//
// Guard rails carried by this module (agreed with Rob, 9 Aug 2026):
//   * Outreach proofs are created with auto_nudge_disabled_at stamped and the
//     four chase rules snoozed, because the standard reminder wording presumes
//     the customer ASKED for the work — these customers did not.
//   * A customer who never opens their page gets silence and a quiet close;
//     only openers earn the follow-up.
//   * One outreach per customer per cycle; skipped customers rest for 90 days.

import { supabase } from './supabase'
import { logAudit } from './audit'
import type { NeedsAttentionRule } from './dashboardGrouping'

export type ProspectState =
  | 'pending'
  | 'queued'
  | 'in_build'
  | 'contacted'
  | 'replied'
  | 'converted'
  | 'declined'
  | 'closed_no_response'
  | 'suppressed'

export interface ReorderProspect {
  id: string
  xero_contact_id: string | null
  customer_name: string
  email: string | null
  currency: string | null
  first_order_on: string | null
  last_order_on: string | null
  orders_count: number
  lifetime_value: number | null
  avg_order_value: number | null
  cadence_days: number | null
  score: number
  score_reasons: string[]
  state: ProspectState
  queued_on: string | null
  contacted_at: string | null
  follow_up_due_on: string | null
  followed_up_at: string | null
  proof_id: string | null
  matched_contact_id: string | null
  outcome_note: string | null
  suppressed_until: string | null
}

export const PROSPECT_COLUMNS =
  'id, xero_contact_id, customer_name, email, currency, first_order_on, last_order_on, ' +
  'orders_count, lifetime_value, avg_order_value, cadence_days, score, score_reasons, ' +
  'state, queued_on, contacted_at, follow_up_due_on, followed_up_at, proof_id, ' +
  'matched_contact_id, outcome_note, suppressed_until'

// The chase rules the desk snoozes on an outreach proof, and for how long.
// 60 days covers the outreach → follow-up → quiet-close arc with room to
// spare; an engaged customer re-enters normal attention automatically because
// the 000222 trigger expires chase snoozes on any approve / request_changes.
export const OUTREACH_SNOOZE_RULES: NeedsAttentionRule[] = [
  'sent_never_viewed',
  'viewed_not_actioned',
  'approaching_dormant',
  'stuck_in_progress',
]
export const OUTREACH_SNOOZE_HOURS = 60 * 24

// Satisfies the 000067 link-or-override CHECK on proofs created from the desk.
// Past customers usually have no live Help Scout thread; the form's email
// match often finds an old one, and this reason covers the rest.
export const OUTREACH_OVERRIDE_REASON =
  'Re-engagement outreach from the Reorder desk (past customer, pre-system)'

// ── Desk settings (settings singleton, 000389) ──────────────────────────────
// Same cached-getter idiom as orderingEnabled.ts: 60s TTL, in-flight de-dup,
// fail-safe defaults with the desk OFF.

export interface ReorderDeskSettings {
  enabled: boolean
  dailyLimit: number
  followupDays: number
}

const SETTINGS_TTL_MS = 60_000
const SETTINGS_FAIL_SAFE: ReorderDeskSettings = { enabled: false, dailyLimit: 5, followupDays: 5 }

let settingsCache: { value: ReorderDeskSettings; fetchedAt: number } | null = null
let settingsInFlight: Promise<ReorderDeskSettings> | null = null

export async function getReorderDeskSettings(): Promise<ReorderDeskSettings> {
  if (settingsCache && Date.now() - settingsCache.fetchedAt < SETTINGS_TTL_MS) return settingsCache.value
  if (settingsInFlight) return settingsInFlight

  settingsInFlight = (async () => {
    try {
      const { data, error } = await supabase
        .from('settings')
        .select('reorder_desk_enabled, reorder_desk_daily_limit, reorder_desk_followup_days')
        .eq('id', 1)
        .single()
      const value: ReorderDeskSettings = error || !data
        ? SETTINGS_FAIL_SAFE
        : {
            enabled: !!data.reorder_desk_enabled,
            dailyLimit: data.reorder_desk_daily_limit ?? 5,
            followupDays: data.reorder_desk_followup_days ?? 5,
          }
      settingsCache = { value, fetchedAt: Date.now() }
      return value
    } catch {
      settingsCache = { value: SETTINGS_FAIL_SAFE, fetchedAt: Date.now() }
      return SETTINGS_FAIL_SAFE
    } finally {
      settingsInFlight = null
    }
  })()
  return settingsInFlight
}

/** Invalidate the cache. Called by the admin settings save so an open
 *  dashboard picks up the change faster than the 60-second TTL. */
export function invalidateReorderDeskSettings(): void {
  settingsCache = null
}

// ── The daily plan (pure — unit tested) ─────────────────────────────────────

/** What the desk knows about an outreach proof when partitioning. */
export interface OutreachProofFacts {
  status: string
  opened: boolean
  /** proofs.helpscout_last_customer_reply_at — the customer answered by email.
   *  The outreach note explicitly invites replying WITHOUT opening the page,
   *  so a reply is engagement even when `opened` is false. */
  repliedAt: string | null
}

/** A reply counts only if it landed after the outreach went out — these
 *  customers often have years-old Help Scout threads with old replies. */
function customerRepliedSinceContact(
  p: ReorderProspect,
  facts: OutreachProofFacts | undefined,
): boolean {
  return !!(facts?.repliedAt && p.contacted_at && facts.repliedAt > p.contacted_at)
}

export interface DeskPlan {
  /** Today's servings, best first: already-queued-today plus the promotions. */
  queue: ReorderProspect[]
  /** The subset of `queue` that still needs its DB state moved to queued. */
  promote: ReorderProspect[]
  /** Projects a designer has started but not yet sent. */
  inBuild: ReorderProspect[]
  /** Opened the page, went quiet, follow-up now due — a human sends one note. */
  followUps: ReorderProspect[]
  /** Silence where silence is the answer: either never opened and the window
   *  passed, or the one follow-up went out and its window passed too. Closed
   *  quietly, no email. Never contains a customer who has REPLIED. */
  quietCloses: ReorderProspect[]
  /** Outcome sync: their proof got approved → mark converted. */
  toConvert: ReorderProspect[]
  /** Outcome sync: their proof was abandoned elsewhere → close the prospect. */
  toClose: ReorderProspect[]
  /** Outcome sync: the customer replied by email since the outreach — a live
   *  conversation. The desk steps back entirely (state → replied); the thread
   *  continues in Help Scout and the normal proof flows. */
  toReply: ReorderProspect[]
}

function servable(p: ReorderProspect, todayIso: string): boolean {
  return !p.suppressed_until || p.suppressed_until <= todayIso
}

/** Date-only arithmetic for the follow-up windows (YYYY-MM-DD in, out). */
function plusDaysIso(dateIso: string, days: number): string {
  const d = new Date(`${dateIso.slice(0, 10)}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/**
 * Partition the fetched prospects into the desk's buckets. Pure so the queue
 * arithmetic is testable: promotion tops the day's queue up to `dailyLimit`,
 * preferring yesterday's unactioned servings (already surfaced once — finish
 * or skip them before fresh names) and then the highest scores.
 *
 * The daily limit is a BUDGET, not a concurrency cap: every prospect whose
 * queued_on is today counts against it whatever state they've since moved to,
 * so working through the cards doesn't refill the desk with fresh names
 * (skipProspect/putBackProspect deliberately preserve queued_on for the same
 * reason).
 */
export function planDesk(
  prospects: ReorderProspect[],
  proofFacts: Map<string, OutreachProofFacts>,
  todayIso: string,
  dailyLimit: number,
  followupDays: number,
): DeskPlan {
  const queuedToday: ReorderProspect[] = []
  const staleQueued: ReorderProspect[] = []
  const pending: ReorderProspect[] = []
  const inBuild: ReorderProspect[] = []
  const followUps: ReorderProspect[] = []
  const quietCloses: ReorderProspect[] = []
  const toConvert: ReorderProspect[] = []
  const toClose: ReorderProspect[] = []
  const toReply: ReorderProspect[] = []

  // The day's budget counts everyone served today, not just those still
  // sitting in 'queued'.
  const servedToday = new Set(
    prospects.filter((p) => p.queued_on === todayIso).map((p) => p.id),
  )

  const seen = new Set<string>()
  for (const p of prospects) {
    if (seen.has(p.id)) continue
    seen.add(p.id)

    if (p.state === 'queued') {
      // servable() guards the display too: a row another dashboard suppressed
      // after promotion must not render, though it still spends its slot.
      if (p.queued_on === todayIso) {
        if (servable(p, todayIso)) queuedToday.push(p)
      } else if (servable(p, todayIso)) staleQueued.push(p)
      continue
    }
    if (p.state === 'pending') {
      if (servable(p, todayIso) && p.queued_on !== todayIso) pending.push(p)
      continue
    }
    if (p.state === 'in_build') {
      inBuild.push(p)
      continue
    }
    if (p.state === 'contacted' || p.state === 'replied') {
      const facts = p.proof_id ? proofFacts.get(p.proof_id) : undefined
      if (customerRepliedSinceContact(p, facts) && p.state === 'contacted') {
        toReply.push(p)
        continue
      }
      if (facts?.status === 'approved') {
        toConvert.push(p)
        continue
      }
      if (facts?.status === 'abandoned') {
        toClose.push(p)
        continue
      }
      if (p.state !== 'contacted') continue
      if (!p.followed_up_at) {
        if (p.follow_up_due_on && p.follow_up_due_on <= todayIso) {
          if (facts?.opened) followUps.push(p)
          else quietCloses.push(p)
        }
      } else if (plusDaysIso(p.followed_up_at, followupDays) <= todayIso) {
        // The one follow-up went out and its window has passed in silence.
        quietCloses.push(p)
      }
    }
  }

  const byScore = (a: ReorderProspect, b: ReorderProspect) => b.score - a.score
  staleQueued.sort(byScore)
  pending.sort(byScore)

  const room = Math.max(0, dailyLimit - servedToday.size)
  const promote = [...staleQueued, ...pending].slice(0, room)
  const queue = [...queuedToday, ...promote].sort(byScore)

  return { queue, promote, inBuild, followUps, quietCloses, toConvert, toClose, toReply }
}

// ── Data fetch ──────────────────────────────────────────────────────────────

export interface DeskData {
  prospects: ReorderProspect[]
  proofFacts: Map<string, OutreachProofFacts>
  /** Contacted in the last 7 days — the panel's "this week" line. */
  contactedThisWeek: number
}

export async function fetchDeskData(): Promise<DeskData> {
  const today = todayIsoLocal()
  // Three reads: the live states in full (bounded populations), a slice of the
  // SERVABLE pending pool deep enough to fill any day's promotions (the
  // server-side suppression filter matters — resting skipped rows must not
  // occupy the slice and starve the desk), and everyone served today whatever
  // state they've moved to (the daily budget).
  const [liveRes, pendingRes, servedRes] = await Promise.all([
    supabase
      .from('reorder_prospects')
      .select(PROSPECT_COLUMNS)
      .in('state', ['queued', 'in_build', 'contacted', 'replied']),
    supabase
      .from('reorder_prospects')
      .select(PROSPECT_COLUMNS)
      .eq('state', 'pending')
      .or(`suppressed_until.is.null,suppressed_until.lte.${today}`)
      .order('score', { ascending: false })
      .limit(40),
    supabase
      .from('reorder_prospects')
      .select(PROSPECT_COLUMNS)
      .eq('queued_on', today),
  ])
  if (liveRes.error) throw liveRes.error
  if (pendingRes.error) throw pendingRes.error
  if (servedRes.error) throw servedRes.error
  const prospects = [
    ...(liveRes.data ?? []),
    ...(pendingRes.data ?? []),
    ...(servedRes.data ?? []),
  ] as unknown as ReorderProspect[]

  const proofIds = prospects.map((p) => p.proof_id).filter((id): id is string => !!id)
  const proofFacts = new Map<string, OutreachProofFacts>()
  if (proofIds.length > 0) {
    const { data: proofRows, error: proofErr } = await supabase
      .from('proofs')
      .select('id, status, helpscout_last_customer_reply_at')
      .in('id', proofIds)
    if (proofErr) throw proofErr
    for (const row of proofRows ?? [])
      proofFacts.set(row.id, {
        status: row.status,
        opened: false,
        repliedAt: (row as { helpscout_last_customer_reply_at?: string | null })
          .helpscout_last_customer_reply_at ?? null,
      })

    // "Opened" = any non-bot view of any version of the proof.
    const { data: versionRows, error: verErr } = await supabase
      .from('proof_versions')
      .select('id, proof_id')
      .in('proof_id', proofIds)
    if (verErr) throw verErr
    const versionToProof = new Map((versionRows ?? []).map((v) => [v.id, v.proof_id]))
    const versionIds = [...versionToProof.keys()]
    if (versionIds.length > 0) {
      const { data: viewRows, error: viewErr } = await supabase
        .from('proof_version_views')
        .select('proof_version_id')
        .eq('is_bot', false)
        .in('proof_version_id', versionIds)
      if (viewErr) throw viewErr
      for (const v of viewRows ?? []) {
        const proofId = versionToProof.get(v.proof_version_id)
        const facts = proofId ? proofFacts.get(proofId) : undefined
        if (facts) facts.opened = true
      }
    }
  }

  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString()
  const { count } = await supabase
    .from('reorder_prospects')
    .select('id', { count: 'exact', head: true })
    .gte('contacted_at', weekAgo)

  return { prospects, proofFacts, contactedThisWeek: count ?? 0 }
}

// ── State transitions ───────────────────────────────────────────────────────

export function todayIsoLocal(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Move today's promotions into the queued state. Conditional on their current
 *  state so a race between two open dashboards over-serves by at most one
 *  card rather than double-writing. */
export async function promoteProspects(ids: string[], todayIso: string): Promise<void> {
  if (ids.length === 0) return
  const { error } = await supabase
    .from('reorder_prospects')
    .update({ state: 'queued', queued_on: todayIso, updated_at: new Date().toISOString() })
    .in('id', ids)
    .in('state', ['pending', 'queued'])
    // A row another dashboard just rested must stay rested — a promotion
    // computed from a stale fetch must not override a designer's "Not now".
    .or(`suppressed_until.is.null,suppressed_until.lte.${todayIso}`)
  if (error) throw error
}

/**
 * A designer takes a prospect: find or create the company + contact, mark the
 * prospect in_build, and hand back the contact id for the new-project form.
 * The email is required — for register rows whose email never resolved, the
 * panel collects one from the designer first (Xero and Help Scout have it).
 */
export async function startProspect(
  prospect: ReorderProspect,
  email: string,
): Promise<{ contactId: string }> {
  const cleanEmail = email.trim().toLowerCase()
  if (!cleanEmail) throw new Error('An email address is needed to create the contact.')

  let contactId: string | null = null
  let companyIdForContact: string | null = null

  if (prospect.matched_contact_id) {
    contactId = prospect.matched_contact_id
  } else {
    // An existing contact with this email wins, wherever they live.
    const { data: existing, error: findErr } = await supabase
      .from('contacts')
      .select('id')
      .ilike('email', cleanEmail)
      .limit(1)
    if (findErr) throw findErr
    contactId = existing?.[0]?.id ?? null
  }

  if (!contactId) {
    // Xero's customer name is almost always the company. Reuse an existing
    // company row of the same name rather than tripping the unique index.
    const companyName = prospect.customer_name.trim()
    const { data: companyMatch, error: companyFindErr } = await supabase
      .from('companies')
      .select('id')
      .ilike('name', companyName)
      .limit(1)
    if (companyFindErr) throw companyFindErr
    companyIdForContact = companyMatch?.[0]?.id ?? null

    if (!companyIdForContact) {
      const { data: created, error: createErr } = await supabase
        .from('companies')
        .insert({ name: companyName })
        .select('id')
        .single()
      if (createErr && createErr.code !== '23505') throw createErr
      if (created) {
        companyIdForContact = created.id
        void logAudit({
          action: 'company.created',
          targetType: 'company',
          targetId: created.id,
          metadata: { name: companyName, source: 'reorder_desk' },
        })
      } else {
        // Lost a race to another insert — fetch the winner.
        const { data: winner } = await supabase
          .from('companies')
          .select('id')
          .ilike('name', companyName)
          .limit(1)
        companyIdForContact = winner?.[0]?.id ?? null
      }
    }

    const { data: contact, error: contactErr } = await supabase
      .from('contacts')
      .insert({
        company_id: companyIdForContact,
        full_name: prospect.customer_name.trim(),
        email: cleanEmail,
      })
      .select('id')
      .single()
    if (contactErr && contactErr.code !== '23505') throw contactErr
    if (contact) {
      contactId = contact.id
      void logAudit({
        action: 'contact.created',
        targetType: 'contact',
        targetId: contact.id,
        metadata: { email: cleanEmail, source: 'reorder_desk' },
      })
    } else {
      const { data: winner } = await supabase
        .from('contacts')
        .select('id')
        .eq('company_id', companyIdForContact)
        .ilike('email', cleanEmail)
        .limit(1)
      contactId = winner?.[0]?.id ?? null
    }
  }

  if (!contactId) throw new Error('Could not find or create the contact.')

  // Conditional on state AND row-checked: a colleague may have suppressed,
  // started, or contacted this customer since the panel loaded — the stale
  // dashboard must lose, not resurrect them.
  const { data: stamped, error: stampErr } = await supabase
    .from('reorder_prospects')
    .update({
      state: 'in_build',
      matched_contact_id: contactId,
      email: cleanEmail,
      updated_at: new Date().toISOString(),
    })
    .eq('id', prospect.id)
    .in('state', ['pending', 'queued'])
    .select('id')
  if (stampErr) throw stampErr
  if (!stamped || stamped.length === 0) {
    throw new Error(
      'A colleague has just taken or set aside this customer — refresh the desk.',
    )
  }

  void logAudit({
    action: 'reorder_desk.started',
    targetType: 'reorder_prospect',
    targetId: prospect.id,
    metadata: { customer_name: prospect.customer_name, contact_id: contactId },
  })

  return { contactId }
}

/** Put an in_build (or served) prospect back into the pool untouched.
 *  queued_on survives on purpose: a same-day put-back spent its desk slot. */
export async function putBackProspect(id: string): Promise<void> {
  const { error } = await supabase
    .from('reorder_prospects')
    .update({ state: 'pending', updated_at: new Date().toISOString() })
    .eq('id', id)
    .in('state', ['queued', 'in_build'])
  if (error) throw error
}

/** 'later' rests the customer for 90 days; 'never' suppresses them for good.
 *  queued_on survives so the day's budget stays spent — skipping cards must
 *  not refill the desk with fresh names. */
export async function skipProspect(id: string, mode: 'later' | 'never'): Promise<void> {
  const patch =
    mode === 'never'
      ? { state: 'suppressed' as const, outcome_note: 'Marked never-contact from the desk' }
      : {
          state: 'pending' as const,
          suppressed_until: new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10),
        }
  const { error } = await supabase
    .from('reorder_prospects')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw error
  void logAudit({
    action: 'reorder_desk.skipped',
    targetType: 'reorder_prospect',
    targetId: id,
    metadata: { mode },
  })
}

/**
 * The outreach went out (called from the send panel's onSent when the proof
 * carries a prospect). Conditional on state so a duplicate call is a no-op.
 */
export async function markProspectContactedByProof(proofId: string): Promise<void> {
  const { followupDays } = await getReorderDeskSettings()
  const followUpDue = new Date(Date.now() + followupDays * 86_400_000).toISOString().slice(0, 10)
  const { error } = await supabase
    .from('reorder_prospects')
    .update({
      state: 'contacted',
      contacted_at: new Date().toISOString(),
      follow_up_due_on: followUpDue,
      updated_at: new Date().toISOString(),
    })
    .eq('proof_id', proofId)
    .in('state', ['pending', 'queued', 'in_build'])
  if (error) throw error
}

/**
 * The outreach went out by hand, outside the send panel — a fresh Help Scout
 * conversation, a plain email. Without this the prospect would strand in
 * in_build forever, because the automatic stamp only fires from the panel's
 * onSent. Same state guard as the automatic path.
 */
export async function markProspectContactedManually(id: string): Promise<void> {
  const { followupDays } = await getReorderDeskSettings()
  const followUpDue = new Date(Date.now() + followupDays * 86_400_000).toISOString().slice(0, 10)
  const { error } = await supabase
    .from('reorder_prospects')
    .update({
      state: 'contacted',
      contacted_at: new Date().toISOString(),
      follow_up_due_on: followUpDue,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .in('state', ['pending', 'queued', 'in_build'])
  if (error) throw error
  void logAudit({
    action: 'reorder_desk.marked_contacted',
    targetType: 'reorder_prospect',
    targetId: id,
    metadata: { manual: true },
  })
}

/** The one human follow-up went out. */
export async function recordFollowUpSent(id: string): Promise<void> {
  const { error } = await supabase
    .from('reorder_prospects')
    .update({ followed_up_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw error
  void logAudit({
    action: 'reorder_desk.follow_up_sent',
    targetType: 'reorder_prospect',
    targetId: id,
    metadata: {},
  })
}

/**
 * Never opened, window passed: close the project quietly (no email — silence
 * was the answer) and record the outcome. The customer becomes eligible again
 * in a year.
 */
export async function closeProspectQuietly(p: ReorderProspect): Promise<void> {
  if (p.proof_id) {
    // Re-verify at click time against a stale panel: a customer who has
    // REPLIED since the outreach is a live conversation, not silence — never
    // close them from here.
    const { data: proofNow, error: checkErr } = await supabase
      .from('proofs')
      .select('status, helpscout_last_customer_reply_at')
      .eq('id', p.proof_id)
      .single()
    if (checkErr) throw checkErr
    const repliedAt = (proofNow as { helpscout_last_customer_reply_at?: string | null })
      ?.helpscout_last_customer_reply_at
    if (repliedAt && p.contacted_at && repliedAt > p.contacted_at) {
      throw new Error(
        'This customer has replied by email since the outreach — check the Help Scout thread instead of closing.',
      )
    }
    const { error: proofErr } = await supabase
      .from('proofs')
      .update({ status: 'abandoned', abandoned_at: new Date().toISOString() })
      .eq('id', p.proof_id)
      .eq('status', 'in_progress')
    if (proofErr) throw proofErr
  }
  const { error } = await supabase
    .from('reorder_prospects')
    .update({
      state: 'closed_no_response',
      outcome_note: 'No response to outreach — closed quietly',
      suppressed_until: new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10),
      updated_at: new Date().toISOString(),
    })
    .eq('id', p.id)
    .in('state', ['contacted'])
  if (error) throw error
  void logAudit({
    action: 'reorder_desk.closed_quiet',
    targetType: 'reorder_prospect',
    targetId: p.id,
    metadata: { proof_id: p.proof_id },
  })
}

/** Reconcile outcomes the rest of the system already decided. Best-effort:
 *  a failed sync leaves the row for the next load. */
export async function syncProspectOutcomes(plan: DeskPlan): Promise<void> {
  for (const p of plan.toReply) {
    void supabase
      .from('reorder_prospects')
      .update({ state: 'replied', updated_at: new Date().toISOString() })
      .eq('id', p.id)
      .in('state', ['contacted'])
      .then(({ error }) => {
        if (error) console.error('[reorder-desk] replied sync failed', error)
      })
  }
  for (const p of plan.toConvert) {
    void supabase
      .from('reorder_prospects')
      .update({ state: 'converted', updated_at: new Date().toISOString() })
      .eq('id', p.id)
      .in('state', ['contacted', 'replied'])
      .then(({ error }) => {
        if (error) console.error('[reorder-desk] convert sync failed', error)
      })
  }
  for (const p of plan.toClose) {
    void supabase
      .from('reorder_prospects')
      .update({
        state: 'closed_no_response',
        outcome_note: p.outcome_note ?? 'Project closed elsewhere',
        updated_at: new Date().toISOString(),
      })
      .eq('id', p.id)
      .in('state', ['contacted', 'replied'])
      .then(({ error }) => {
        if (error) console.error('[reorder-desk] close sync failed', error)
      })
  }
}
