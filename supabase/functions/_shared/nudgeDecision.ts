// Pure decision logic for the automated follow-up (nudge) pipeline.
// Spec: docs/followup-automation-spec.md.
//
// This module makes every cadence/cap/guard DECISION; the send-nudges edge
// function supplies the facts (compute_nudge_candidates + the proof_nudges
// ledger + settings) and performs the network work (Help Scout gates, the
// actual send). Keeping decisions here, dependency-free and clock-injected,
// is what makes the send→suppress loop unit-testable — the spec's Phase 1
// acceptance requires synthetic-history tests because the real loop cannot
// run in dry-run mode.
//
// Dual-runtime constraint: imported by the Deno edge function AND by the
// Node test harness (npx tsx supabase/functions/_shared/nudgeDecision.test.ts),
// so: no Deno.* APIs, no Node APIs, no imports. `now` is always a parameter —
// never read the clock here.

// ── Config shapes ─────────────────────────────────────────────────────────────

export interface AutomationRuleConfig {
  mode: 'auto' | 'review' | 'off'
  /** Working-day cooldown between nudges. */
  repeat_days?: number
  /** Auto-nudge cap per (proof, rule, version). */
  max_nudges?: number
}

export interface NudgeConfig {
  /** The snv rule's own settings from needs_attention_rules. */
  ruleEnabled: boolean
  thresholdDays: number
  /** true → thresholds count calendar days; false → working days. */
  calendar: boolean
  /** The automation.sent_never_viewed block. Missing mode reads as 'off' (fail closed). */
  automation: AutomationRuleConfig
  /** Per-proof ceiling across all versions and rules. */
  lifetimeMax: number
  /** helpscout_reply_grace_days — calendar days, mirroring the 000209 guard. */
  graceDays: number
  /** England & Wales bank holidays as 'YYYY-MM-DD' (Europe/London civil dates). */
  bankHolidays: ReadonlySet<string>
}

// ── Fact shapes (mirrors compute_nudge_candidates + proof_nudges) ────────────

export interface CandidateFacts {
  proofId: string
  versionId: string
  conversationId: string | null
  contactEmail: string | null
  /** coalesce(version.last_reply_sent_at, proof.helpscout_last_reply_at). */
  sendEvidenceAt: string | null
  lastCustomerReplyAt: string | null
  lastStaffReplyAt: string | null
  snoozed: boolean
  autoNudgeDisabled: boolean
  /**
   * proofs.helpscout_tags carries 'follow up' (Phase 2b tag sync — the
   * webhook mirrors Help Scout conversation tags). A human flagged the
   * conversation, so a human owns the chase: automation stands down.
   */
  hasFollowUpTag: boolean
}

export interface LedgerRow {
  proofId: string
  versionId: string | null
  ruleCode: string
  source: 'auto' | 'manual'
  state: string
  outcome: string | null
  createdAt: string
}

/**
 * Which ledger rows count toward caps and cooldowns. Truth table kept
 * IDENTICAL to the SQL nudge_cap_rows() in migration 000214 (this copy is
 * the one the sender runs; the SQL twin serves analytics — change one,
 * change both): a row counts iff state is 'sending' or 'sent', any source.
 * A crashed claim ('sending') must not be spendable twice; dry_run and
 * skipped never count in LIVE mode. Re-filtered here defensively so a caller
 * passing raw rows can't skew the maths.
 */
export function capRows(rows: LedgerRow[]): LedgerRow[] {
  return rows.filter((r) => r.state === 'sending' || r.state === 'sent')
}

/**
 * Dry-run cadence simulation (spec Phase 1: "the cadence simulation counts
 * dry rows so spacing and cap exhaustion are visible night-over-night").
 * In dry_run mode the sender passes the ledger through this first: prior
 * would-send dry rows are treated as if they had really sent, so the dry
 * week demonstrates cooldowns, the per-version cap, and exhaustion exactly
 * as Phase 2 would behave. Live mode never calls this — at the flip, dry
 * rows go back to being structurally invisible to the maths.
 */
export function simulateDryLedger(rows: LedgerRow[]): LedgerRow[] {
  // Both would-send shapes count: 'would_send' (reply into the thread) and
  // 'would_send_new_conversation' (reminder #2's fresh conversation).
  return rows.map((r) =>
    r.state === 'dry_run' && (r.outcome ?? '').startsWith('would_send')
      ? { ...r, state: 'sent' }
      : r,
  )
}

// ── Decision result ──────────────────────────────────────────────────────────

/**
 * drop  — not eligible at all; no ledger row is written (below threshold,
 *         rule disabled). Keeps nightly ledger noise down.
 * skip  — eligible but blocked by a guard; logged with `outcome` so the
 *         Outbox explains why nothing was sent.
 * send  — passes every local guard; the edge function still runs the
 *         Help Scout gates (conversation status, recipient match, newer
 *         customer thread) before anything posts.
 */
export type ProofDecision =
  | { action: 'drop'; reason: string }
  | { action: 'skip'; outcome: string }
  | { action: 'send' }

// ── Europe/London calendar helpers ───────────────────────────────────────────
//
// Civil-date arithmetic happens on 'YYYY-MM-DD' strings in Europe/London,
// derived via Intl (available in both Deno and Node). Weekday/diff maths then
// uses Date.UTC on the civil date, which is timezone-safe because the date is
// already localised.

const LONDON_DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/London',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

const LONDON_HOUR_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London',
  hour: '2-digit',
  hour12: false,
})

/** The Europe/London civil date ('YYYY-MM-DD') of an instant. */
export function londonDate(instant: Date): string {
  // en-CA formats as YYYY-MM-DD directly.
  return LONDON_DATE_FMT.format(instant)
}

/** The Europe/London hour (0-23) of an instant. */
export function londonHour(instant: Date): number {
  return parseInt(LONDON_HOUR_FMT.format(instant), 10) % 24
}

function utcMidnight(dateIso: string): number {
  const [y, m, d] = dateIso.split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}

/** Mon-Fri and not a bank holiday. */
export function isWorkingDay(dateIso: string, bankHolidays: ReadonlySet<string>): boolean {
  const dow = new Date(utcMidnight(dateIso)).getUTCDay() // 0=Sun..6=Sat
  if (dow === 0 || dow === 6) return false
  return !bankHolidays.has(dateIso)
}

/**
 * Working days from start to end, exclusive of start, INCLUSIVE of end —
 * matching business_days_between's 000160 semantics ("fires on the
 * human-counted day"), with bank holidays additionally skipped (which the
 * SQL helper deliberately does not do; the sender is stricter than the
 * dashboard, per the spec).
 */
export function workingDaysBetween(
  startIso: string,
  endIso: string,
  bankHolidays: ReadonlySet<string>,
): number {
  let t = utcMidnight(startIso)
  const end = utcMidnight(endIso)
  if (end <= t) return 0
  let days = 0
  const DAY = 86_400_000
  for (t += DAY; t <= end; t += DAY) {
    const iso = new Date(t).toISOString().slice(0, 10)
    if (isWorkingDay(iso, bankHolidays)) days++
  }
  return days
}

/** Whole calendar days from start to end (civil dates). */
export function calendarDaysBetween(startIso: string, endIso: string): number {
  return Math.max(0, Math.round((utcMidnight(endIso) - utcMidnight(startIso)) / 86_400_000))
}

/**
 * The live-send window: Europe/London working day (Mon-Fri, not a bank
 * holiday), 09:00-16:59. The cron only has to land approximately inside
 * this; dry-run mode deliberately ignores it so a manual test run at any
 * hour still fills the Outbox.
 */
export function isWithinSendWindow(now: Date, bankHolidays: ReadonlySet<string>): boolean {
  const date = londonDate(now)
  if (!isWorkingDay(date, bankHolidays)) return false
  const hour = londonHour(now)
  return hour >= 9 && hour < 17
}

// ── The per-proof decision ───────────────────────────────────────────────────

export function decideForProof(
  facts: CandidateFacts,
  ledger: LedgerRow[],
  cfg: NudgeConfig,
  now: Date,
): ProofDecision {
  if (!cfg.ruleEnabled) return { action: 'drop', reason: 'rule_disabled' }
  // Fail closed: anything other than an explicit 'auto' means no unattended send.
  if (cfg.automation.mode !== 'auto') return { action: 'drop', reason: 'mode_not_auto' }
  if (!facts.conversationId) return { action: 'drop', reason: 'no_conversation' }

  const counted = capRows(ledger).filter((r) => r.proofId === facts.proofId)
  const today = londonDate(now)

  // Send-evidence anchor (spec): no positive evidence the customer was ever
  // sent this version → no auto-nudge, surfaced to the Outbox as a
  // designer-side problem rather than silently dropped.
  if (!facts.sendEvidenceAt) return { action: 'skip', outcome: 'skipped_no_send_evidence' }

  // Threshold, measured from the send evidence — not version creation.
  const anchorDate = londonDate(new Date(facts.sendEvidenceAt))
  const elapsed = cfg.calendar
    ? calendarDaysBetween(anchorDate, today)
    : workingDaysBetween(anchorDate, today, cfg.bankHolidays)
  if (elapsed < cfg.thresholdDays) return { action: 'drop', reason: 'below_threshold' }

  if (facts.autoNudgeDisabled) return { action: 'skip', outcome: 'skipped_opted_out' }
  if (facts.snoozed) return { action: 'skip', outcome: 'skipped_snoozed' }
  // Phase 2b interaction rule (spec): a Help Scout "follow up" tag means a
  // human has claimed the chase, so the bot must NOT also email — decided
  // here with a logged outcome, never silently by the dashboard's priority
  // ordering. Clears itself when the human removes the tag.
  if (facts.hasFollowUpTag) return { action: 'skip', outcome: 'skipped_followup_tag' }

  // Hard rule (spec architecture rule #3): a customer reply newer than our
  // last outbound touch means a human owes the next message — regardless of
  // the grace window. Outbound touch = send evidence, any HS staff reply, or
  // any counted ledger row.
  const lastCustomer = facts.lastCustomerReplyAt ? Date.parse(facts.lastCustomerReplyAt) : null
  if (lastCustomer != null) {
    const outboundTimes = [
      Date.parse(facts.sendEvidenceAt),
      facts.lastStaffReplyAt ? Date.parse(facts.lastStaffReplyAt) : -Infinity,
      ...counted.map((r) => Date.parse(r.createdAt)),
    ]
    const lastOutbound = Math.max(...outboundTimes)
    if (lastCustomer > lastOutbound) return { action: 'skip', outcome: 'skipped_customer_replied' }
  }

  // Grace window, mirroring the 000209 guard EXACTLY: the SQL is
  // `greatest(staff, customer) >= now() - make_interval(days => grace)` —
  // rolling timestamp arithmetic, not civil days. Using day-diffs here would
  // clear up to ~24h earlier than the dashboard's flag and let the sender
  // nudge a proof the engine is still suppressing.
  const lastReplyMs = Math.max(
    facts.lastStaffReplyAt ? Date.parse(facts.lastStaffReplyAt) : -Infinity,
    lastCustomer ?? -Infinity,
  )
  if (lastReplyMs > -Infinity) {
    if (now.getTime() - lastReplyMs < cfg.graceDays * 86_400_000) {
      return { action: 'skip', outcome: 'skipped_grace_window' }
    }
  }

  // Cap per (proof, rule, version): a new version re-arms with a fresh
  // allowance; the lifetime ceiling below still counts across versions.
  // ANY source counts — a manual nudge consumes a cap slot (the spec's
  // locked default: two chases per version total, not two bot chases on top
  // of human ones).
  const maxNudges = cfg.automation.max_nudges ?? 2
  const versionRuleCount = counted.filter(
    (r) => r.versionId === facts.versionId && r.ruleCode === 'sent_never_viewed',
  ).length
  if (versionRuleCount >= maxNudges) return { action: 'skip', outcome: 'skipped_capped' }
  const autoRows = counted.filter((r) => r.source === 'auto')

  if (autoRows.length >= cfg.lifetimeMax) {
    return { action: 'skip', outcome: 'skipped_capped_lifetime' }
  }

  // Cooldown: working days since the newest counted touch of ANY source —
  // manual nudges always delay automation. Authoritative from the ledger;
  // the grace window above is belt-and-braces, never the spacing mechanism.
  const repeatDays = cfg.automation.repeat_days ?? 3
  if (counted.length > 0) {
    const newest = counted.reduce((a, b) => (a.createdAt > b.createdAt ? a : b))
    const since = workingDaysBetween(
      londonDate(new Date(newest.createdAt)),
      today,
      cfg.bankHolidays,
    )
    if (since < repeatDays) return { action: 'skip', outcome: 'skipped_cooldown' }
  }

  return { action: 'send' }
}

/**
 * Which reminder this would be for (proof, rule, current version) — counted
 * rows of ANY source, matching the cap semantics (a manual chase consumed
 * slot #1, so the bot's first send is reminder #2). The sender opens
 * reminder #2+ as a NEW Help Scout conversation with a fresh subject (spec
 * section 6): if the original thread is in the customer's spam folder, a
 * second reply there measures the spam folder, not the customer.
 */
export function nudgeNumberFor(
  facts: CandidateFacts,
  ledger: LedgerRow[],
  ruleCode: string,
): number {
  return capRows(ledger).filter(
    (r) => r.proofId === facts.proofId &&
      r.versionId === facts.versionId &&
      r.ruleCode === ruleCode,
  ).length + 1
}

// ── Batch-level grouping ─────────────────────────────────────────────────────

export interface Sendable<T extends CandidateFacts = CandidateFacts> {
  facts: T
}

export interface GroupedSendables<T extends CandidateFacts> {
  send: T[]
  /** outcome 'suppressed_sibling' — logged, and the cap/cooldown clocks must not advance. */
  suppressed: T[]
}

/**
 * Sibling rules (spec):
 *   * Same daily-touch identity (lowercased contact email, falling back to
 *     conversation id, then proof id) with more than one eligible proof →
 *     auto-send NONE of them; a human sends one combined message.
 *   * Different identities sharing one conversation (rare) → at most one per
 *     conversation per run; the most overdue (oldest send evidence) wins.
 *     The proof_nudges_convo_daily unique index backstops this in the DB.
 */
export function groupSendables<T extends CandidateFacts>(eligible: T[]): GroupedSendables<T> {
  const byIdentity = new Map<string, T[]>()
  for (const f of eligible) {
    const identity =
      (f.contactEmail ?? '').trim().toLowerCase() || f.conversationId || f.proofId
    const list = byIdentity.get(identity) ?? []
    list.push(f)
    byIdentity.set(identity, list)
  }

  const send: T[] = []
  const suppressed: T[] = []
  for (const list of byIdentity.values()) {
    if (list.length > 1) suppressed.push(...list)
    else send.push(list[0])
  }

  // Conversation-level pass over the survivors.
  const byConversation = new Map<string, T[]>()
  for (const f of send) {
    const key = f.conversationId ?? f.proofId
    const list = byConversation.get(key) ?? []
    list.push(f)
    byConversation.set(key, list)
  }
  const finalSend: T[] = []
  for (const list of byConversation.values()) {
    if (list.length === 1) {
      finalSend.push(list[0])
      continue
    }
    const sorted = [...list].sort((a, b) =>
      (a.sendEvidenceAt ?? '').localeCompare(b.sendEvidenceAt ?? ''),
    )
    finalSend.push(sorted[0])
    suppressed.push(...sorted.slice(1))
  }

  // Deterministic order: most overdue first.
  finalSend.sort((a, b) => (a.sendEvidenceAt ?? '').localeCompare(b.sendEvidenceAt ?? ''))
  return { send: finalSend, suppressed }
}

// ── Bank-holiday fallback ────────────────────────────────────────────────────
//
// England & Wales bank holidays. The edge function refreshes from the gov.uk
// JSON feed at run time; this embedded list is the offline fallback so a
// gov.uk outage cannot stop the morning run (the cost of staleness is a
// nudge landing on a future unlisted holiday — annoying, not harmful).
// Extend annually.
export const EW_BANK_HOLIDAYS_FALLBACK: readonly string[] = [
  '2026-01-01', '2026-04-03', '2026-04-06', '2026-05-04', '2026-05-25',
  '2026-08-31', '2026-12-25', '2026-12-28',
  '2027-01-01', '2027-03-26', '2027-03-29', '2027-05-03', '2027-05-31',
  '2027-08-30', '2027-12-27', '2027-12-28',
]
