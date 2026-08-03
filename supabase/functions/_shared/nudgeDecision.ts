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

/**
 * Extra working days added to the cooldown per reminder already sent for the
 * same (proof, rule, version): the gap before reminder 2 is repeat_days, the
 * gap before reminder 3 is repeat_days + 2, and so on. Not an admin dial —
 * the base repeat_days stays the single configurable knob.
 */
export const COOLDOWN_STRETCH_WD = 2

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
  /**
   * Which chase rule this candidate is for ('sent_never_viewed' |
   * 'viewed_not_actioned'). Drives the per-(proof, rule, version) cap count
   * and which template/subject the sender uses. A proof is only ever in one
   * rule's population per run — it either has a non-bot view or it doesn't.
   */
  ruleCode: string
  conversationId: string | null
  contactEmail: string | null
  /**
   * The clock the threshold counts from, and the "was this ever sent/seen?"
   * gate. Rule-specific: sent_never_viewed anchors on the send evidence
   * (coalesce(version.last_reply_sent_at, postdating proof.helpscout_last_reply_at));
   * viewed_not_actioned anchors on the customer's last non-bot view (itself
   * proof of receipt, so never null for that population). A null anchor only
   * happens for sent_never_viewed and means "no record this version was sent".
   */
  anchorAt: string | null
  /**
   * coalesce(version.last_reply_sent_at, proof.helpscout_last_reply_at) — the
   * genuine outbound touch, used only for the customer-replied floor. May be
   * null for a viewed_not_actioned proof whose link reached the customer
   * outside a tracked Help Scout reply.
   */
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
  /**
   * Current version's currency — the house proxy for territory (EUR/USD are
   * only used outside the UK). USD proofs are deferred to the afternoon run
   * so reminders land mid-morning US time instead of ~5am ET (the live data
   * showed USD re-engagement at half the GBP rate). Null for per-direction
   * variant rounds and pre-000314 candidate rows → treated as "not USD".
   */
  currency: string | null
  /**
   * True when the current version has non-bot views on 2+ distinct
   * Europe/London calendar days (migration 000380) — the customer keeps
   * coming back without deciding: stuck, not hot. Read ONLY by template
   * selection (prefersReturnTone), which swaps the viewed_not_actioned
   * wording for the obstacle-removal body — it changes which words go out,
   * never whether or when, so decideForProof ignores it entirely. False for
   * pre-000380 candidate rows (the sender defaults a missing column).
   */
  returnViews: boolean
  /**
   * The proof set (bundle) this card belongs to, IFF the sender has determined
   * the bundle is chaseable as a unit (bundleChaseable) — the trigger to
   * collapse the bundle's due cards into ONE reminder (migration 000317).
   * Null/undefined for a standalone proof, a bundle that fails bundleChaseable,
   * or a bundle down to its last outstanding card (that lone card chases
   * individually, per Rob's 2026-07-15 decision). Set by the sender after
   * decideForProof; read only by groupSendables. Absent on the candidate SQL —
   * a sender concern, not the database's.
   */
  bundleId?: string | null
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

/**
 * Monday before 13:00 London. The sender demotes this run to dry_run and the
 * weekend-matured batch goes out on the afternoon run instead: Monday-morning
 * sends re-engaged 12/55 (22%) vs ~35-39% midweek in the first month of live
 * data — the biggest batch of the week landing at the worst-performing
 * moment. A deferral, not a drop: the same candidates send at ~16:00 London
 * the same day, so proofs_in_follow_up()'s "automation will handle it"
 * promise still holds.
 */
export function isLondonMondayMorning(instant: Date): boolean {
  const dow = new Date(utcMidnight(londonDate(instant))).getUTCDay() // 0=Sun..6=Sat
  return dow === 1 && londonHour(instant) < 13
}

// ── The per-proof decision ───────────────────────────────────────────────────

// LOCKSTEP: the dashboard mirrors this function's pre-send guards in SQL — see
// proofs.proofs_in_follow_up() "Branch B" (migration 000273). That mirror
// decides whether a chase proof is hidden from "Needs attention" as
// "automation will handle it". If you add or rename a guard here that changes
// whether a proof WILL be auto-sent (anchor / no-send-evidence, proof-wide
// snooze, opt-out, follow-up tag, customer-reply floor, per-version cap,
// threshold), update Branch B in lockstep — otherwise a proof the automation
// can't actually send may be wrongly hidden from the human pile.
// Deliberately NOT mirrored in Branch B: the USD morning deferral (the proof
// still sends the same day, on the afternoon run), the progressive
// cooldown stretch (changes WHEN, never WHETHER — a proof waiting out a
// cooldown is exactly the "automation will handle it" case), and the
// returner template tone (returnViews picks the WORDS a reminder uses,
// never whether or when one sends — see prefersReturnTone).
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

  // Threshold anchor (spec): the rule-specific clock start. sent_never_viewed
  // anchors on the send evidence — no evidence the customer was ever sent this
  // version → no auto-nudge, surfaced to the Outbox as a designer-side problem
  // rather than silently dropped. viewed_not_actioned anchors on the last
  // view, so its anchor is never null. A null anchor therefore only ever
  // means "no record this version was sent".
  if (!facts.anchorAt) return { action: 'skip', outcome: 'skipped_no_send_evidence' }

  // Threshold, measured from the anchor — not version creation.
  const anchorDate = londonDate(new Date(facts.anchorAt))
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
      // sendEvidenceAt can be null for a viewed_not_actioned proof that was
      // never sent via a tracked reply — treat a missing touch as -Infinity.
      facts.sendEvidenceAt ? Date.parse(facts.sendEvidenceAt) : -Infinity,
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
    (r) => r.versionId === facts.versionId && r.ruleCode === facts.ruleCode,
  ).length
  if (versionRuleCount >= maxNudges) return { action: 'skip', outcome: 'skipped_capped' }
  const autoRows = counted.filter((r) => r.source === 'auto')

  if (autoRows.length >= cfg.lifetimeMax) {
    return { action: 'skip', outcome: 'skipped_capped_lifetime' }
  }

  // Cooldown: working days since the newest counted touch of ANY source —
  // manual nudges always delay automation. Authoritative from the ledger;
  // the grace window above is belt-and-braces, never the spacing mechanism.
  // The gap STRETCHES as this rule's sequence progresses (repeat_days before
  // reminder 2, +2 working days per later reminder — so 3, 5, … at the
  // default dial): the live decay curve showed later reminders barely
  // re-engage, so they get more room instead of the same drumbeat.
  const repeatDays = (cfg.automation.repeat_days ?? 3) +
    COOLDOWN_STRETCH_WD * Math.max(0, versionRuleCount - 1)
  if (counted.length > 0) {
    const newest = counted.reduce((a, b) => (a.createdAt > b.createdAt ? a : b))
    const since = workingDaysBetween(
      londonDate(new Date(newest.createdAt)),
      today,
      cfg.bankHolidays,
    )
    if (since < repeatDays) return { action: 'skip', outcome: 'skipped_cooldown' }
  }

  // USD proofs only send on the afternoon run (~11:00 New York) — the last
  // gate, so a capped / cooling-down / replied proof reports that instead of
  // the deferral. Same-day timing only: never changes whether a proof sends,
  // so the Branch B mirror is deliberately untouched (see LOCKSTEP above).
  if ((facts.currency ?? '').toUpperCase() === 'USD' && londonHour(now) < 13) {
    return { action: 'skip', outcome: 'skipped_us_send_window' }
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

/**
 * Template lookup chain for a given reminder position, most specific first.
 * The sender takes the first id with a non-empty body (DB row, else seeded
 * default): reminder 1 uses the base per-rule template; the LAST allowed
 * reminder (position == max_nudges) prefers `<base>_final` — the
 * "we'll stop nudging you" close; anything in between prefers its numbered
 * id, then `<base>_2`. Every chain ends at the base id, so a missing row can
 * never block a send — worst case the customer gets the reminder-1 body
 * again, which is exactly the pre-sequence behaviour.
 */
export function nudgeTemplateIds(
  baseId: string,
  nudgeNumber: number,
  maxNudges: number,
): string[] {
  const ids: string[] = []
  if (nudgeNumber >= 2) {
    if (nudgeNumber >= maxNudges) ids.push(`${baseId}_final`)
    ids.push(`${baseId}_${nudgeNumber}`, `${baseId}_2`)
  }
  ids.push(baseId)
  return [...new Set(ids)]
}

// ── Return-tone template preference (migration 000380) ───────────────────────
//
// A viewed_not_actioned customer who has come back to their proof on 2+
// separate days approves at 34% vs 50% — stuck, not hot, usually on price —
// so their reminder swaps the standard chase copy for an obstacle-removal
// body. Template selection ONLY: same schedule, same caps, same cooldowns
// (the LOCKSTEP comment above decideForProof names this as deliberately not
// mirrored in Branch B).

/** The one rule whose reminders soften for a returning customer. */
export const RETURN_TONE_RULE_CODE = 'viewed_not_actioned'

/**
 * Should this reminder prefer the return-tone (_return) template family?
 * viewed_not_actioned only, and only when the candidate fact says the
 * customer came back on 2+ separate days. Tolerates undefined/null so a
 * sender deployed ahead of migration 000380 (no return_views column yet)
 * reads false — standard copy, exactly the pre-feature behaviour.
 */
export function prefersReturnTone(
  ruleCode: string,
  returnViews: boolean | null | undefined,
): boolean {
  return ruleCode === RETURN_TONE_RULE_CODE && returnViews === true
}

/** `nudge_x` → `nudge_x_return`; `nudge_x_2` → `nudge_x_return_2`. */
function returnToneId(baseId: string, id: string): string {
  return `${baseId}_return${id.slice(baseId.length)}`
}

/**
 * True iff `id` is a return-tone variant in `baseId`'s chain. The sender's
 * switch for the `&ask=1` link suffix: only the return-toned body invites
 * the customer to say what's in the way, so only its link auto-opens the
 * "Not ready to approve?" panel.
 */
export function isReturnToneTemplateId(baseId: string, id: string): boolean {
  return id === `${baseId}_return` || id.startsWith(`${baseId}_return_`)
}

/**
 * nudgeTemplateIds with the return-tone preference folded in: at EACH chain
 * position the `_return` variant is tried first, then the standard id — so
 * a position with no seeded return body falls back to that position's
 * standard copy (the compiled defaults always resolve the standard id, so
 * resolution never walks past a position and the return BASE body can never
 * repeat as reminder 2). Today only the base return variant is seeded, so
 * reminders 2+ intentionally use the standard _2/_final bodies. With the
 * preference off the chain is identical to nudgeTemplateIds.
 */
export function nudgeTemplateIdsFor(
  baseId: string,
  nudgeNumber: number,
  maxNudges: number,
  preferReturnTone: boolean,
): string[] {
  const standard = nudgeTemplateIds(baseId, nudgeNumber, maxNudges)
  if (!preferReturnTone) return standard
  const ids: string[] = []
  for (const id of standard) ids.push(returnToneId(baseId, id), id)
  return [...new Set(ids)]
}

// ── Batch-level grouping ─────────────────────────────────────────────────────

export interface Sendable<T extends CandidateFacts = CandidateFacts> {
  facts: T
}

export interface BundleGroup<T extends CandidateFacts = CandidateFacts> {
  bundleId: string
  /**
   * The most-overdue due card — carries the ledger attribution (proof_id +
   * version) and the greeting context. All members share one customer, so the
   * choice only affects which row the bundle reminder is booked against.
   */
  rep: T
  /** Every due card of this bundle this run (includes rep). */
  members: T[]
}

export interface GroupedSendables<T extends CandidateFacts> {
  send: T[]
  /** outcome 'suppressed_sibling' — logged, and the cap/cooldown clocks must not advance. */
  suppressed: T[]
  /**
   * One entry per bundle whose due cards collapse into a SINGLE reminder
   * (migration 000317). The sender then applies the bundle-level cap/cooldown
   * (decideForBundle) and, if it sends, posts one reminder on the bundle's own
   * Help Scout thread with the bundle review link.
   */
  bundles: BundleGroup<T>[]
}

// Most overdue first: oldest send evidence. A null/empty evidence sorts first
// (empty string < any ISO date), matching the pre-000317 conversation pass.
function byOverdue<T extends CandidateFacts>(a: T, b: T): number {
  return (a.sendEvidenceAt ?? '').localeCompare(b.sendEvidenceAt ?? '')
}

/**
 * Batch grouping. Three outputs:
 *   * send        — per-card reminders (standalone proofs, or a bundle down to
 *                   its last outstanding card, which chases on its own link).
 *   * suppressed  — outcome 'suppressed_sibling': a customer's daily touch that
 *                   maps to MORE THAN ONE logical item (two separate projects,
 *                   or a bundle plus an unrelated card) still defers to a human
 *                   combined message. The cap/cooldown clocks must not advance.
 *   * bundles     — one entry per bundle whose due cards collapse into a single
 *                   reminder (000317), so a bundle's own cards no longer cancel
 *                   each other out.
 *
 * A "logical item" is one bundle OR one standalone proof (`bundleId ?? proofId`).
 * The tag on `bundleId` is the sender's call (bundleChaseable + ≥2 outstanding
 * cards); here it just decides collapse vs. per-card.
 *
 * Rules preserved from the pre-bundle version:
 *   * Same daily-touch identity (lowercased contact email → conversation id →
 *     proof id) covering >1 logical item → suppress all (human sends one).
 *   * Different identities sharing one conversation (rare) → at most one per
 *     conversation per run; the most overdue wins. The proof_nudges_convo_daily
 *     unique index backstops this — and the bundle conversation — in the DB.
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

  const suppressed: T[] = []
  const survivors: T[] = [] // per-card sendables → conversation pass below
  const bundleMembers: T[] = [] // collapse by bundleId below

  for (const list of byIdentity.values()) {
    // More than one logical item for this customer this run → human combined
    // message (a bundle plus an unrelated card lands here too, preserving the
    // one-touch-per-customer guarantee). A bundle's own cards share ONE logical
    // key, so they fall through to the collapse instead of cancelling out.
    const logicalKeys = new Set(list.map((f) => f.bundleId ?? f.proofId))
    if (logicalKeys.size > 1) {
      suppressed.push(...list)
      continue
    }
    if (list[0].bundleId) bundleMembers.push(...list)
    else survivors.push(list[0])
  }

  // Collapse bundle members by set. Grouping here (not per identity) keeps one
  // group even if a bundle's cards ever span two contact emails → two identity
  // buckets. Each set becomes one reminder, booked against its most-overdue card.
  const byBundle = new Map<string, T[]>()
  for (const f of bundleMembers) {
    const list = byBundle.get(f.bundleId!) ?? []
    list.push(f)
    byBundle.set(f.bundleId!, list)
  }
  const bundles: BundleGroup<T>[] = []
  for (const [bundleId, members] of byBundle) {
    const rep = [...members].sort(byOverdue)[0]
    bundles.push({ bundleId, rep, members })
  }
  bundles.sort((a, b) => byOverdue(a.rep, b.rep))

  // Conversation-level pass over the per-card survivors (unchanged behaviour).
  const byConversation = new Map<string, T[]>()
  for (const f of survivors) {
    const key = f.conversationId ?? f.proofId
    const list = byConversation.get(key) ?? []
    list.push(f)
    byConversation.set(key, list)
  }
  const send: T[] = []
  for (const list of byConversation.values()) {
    if (list.length === 1) {
      send.push(list[0])
      continue
    }
    const sorted = [...list].sort(byOverdue)
    send.push(sorted[0])
    suppressed.push(...sorted.slice(1))
  }

  // Deterministic order: most overdue first.
  send.sort(byOverdue)
  return { send, suppressed, bundles }
}

// ── Bundle-level decision (migration 000317) ─────────────────────────────────

/**
 * Is a bundle chaseable as a single unit? Two ways in:
 *   * the bundle was formally SENT (the customer has the review link), or
 *   * it was never sent as a bundle, but every outstanding card's current
 *     version went out individually — the Shard Global shape (2026-07-24):
 *     a designer builds the set but sends per-card links, so the cards then
 *     suppress each other as siblings on every run, forever, while the
 *     dashboard's In-follow-up promises "automation will handle it". Chasing
 *     such a set as a bundle is safe precisely because every card is already
 *     in front of the customer — the bundle link shows nothing they haven't
 *     been sent — and the nudge_bundle template reads naturally as a first
 *     introduction of that link. The sender stamps proof_sets.sent_at on the
 *     first live bundle send, so the set is genuinely sent from then on and
 *     every surface (workspace, front-door open-tracking, the next run) agrees.
 *
 * A card with NO send evidence on its current version (a shell still being
 * built, or a fresh unsent draft version) blocks the unsent-set path — the
 * bundle page would show the customer something never sent to them. Those
 * sets keep the sibling suppression (a human sends one combined message).
 * Fewer than 2 outstanding cards is never a bundle chase: the last card
 * chases individually on its own /p/ link (Rob, 2026-07-15).
 *
 * `outstandingSendEvidence` carries one entry per outstanding card
 * (in_progress, not set aside): its current version's last_reply_sent_at,
 * null when there is none (deliberately strict — a card sent only via an
 * untracked Help Scout reply falls back to suppression, never a wrong chase).
 */
export function bundleChaseable(
  sentAt: string | null,
  outstandingSendEvidence: Array<string | null>,
): boolean {
  if (outstandingSendEvidence.length < 2) return false
  if (sentAt != null) return true
  return outstandingSendEvidence.every((e) => e != null)
}

export interface BundleConfig {
  /** Auto-reminder cap for the whole bundle. Mirrors a single card's cap. */
  maxNudges: number
  /** Base working-day cooldown; stretches per prior reminder like a single card. */
  repeatDays: number
  bankHolidays: ReadonlySet<string>
}

/** Reminder position for a bundle (1-based) — counts sent/sending bundle rows. */
export function bundleNudgeNumber(bundleLedger: LedgerRow[]): number {
  return capRows(bundleLedger).length + 1
}

/**
 * Cap + cooldown for a whole-bundle reminder. Every due card already passed
 * decideForProof (threshold, snooze, grace, customer-reply floor, opt-out,
 * follow-up tag) to be eligible, so the bundle decision owns ONLY what is
 * genuinely per-bundle: the reminder cap, the stretching cooldown (same curve
 * as a single card, COOLDOWN_STRETCH_WD per prior reminder), and the USD
 * afternoon deferral. A customer reply landing on the bundle's own thread is
 * caught by the sender's live thread-trail re-check before it posts.
 * `bundleLedger` is this set's rows only (rule_code = 'bundle', by proof_set_id).
 */
export function decideForBundle(
  bundleLedger: LedgerRow[],
  cfg: BundleConfig,
  now: Date,
  currency: string | null,
): ProofDecision {
  const counted = capRows(bundleLedger)
  const today = londonDate(now)
  if (counted.length >= cfg.maxNudges) return { action: 'skip', outcome: 'skipped_capped' }
  const repeatDays = cfg.repeatDays + COOLDOWN_STRETCH_WD * Math.max(0, counted.length - 1)
  if (counted.length > 0) {
    const newest = counted.reduce((a, b) => (a.createdAt > b.createdAt ? a : b))
    const since = workingDaysBetween(londonDate(new Date(newest.createdAt)), today, cfg.bankHolidays)
    if (since < repeatDays) return { action: 'skip', outcome: 'skipped_cooldown' }
  }
  if ((currency ?? '').toUpperCase() === 'USD' && londonHour(now) < 13) {
    return { action: 'skip', outcome: 'skipped_us_send_window' }
  }
  return { action: 'send' }
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
