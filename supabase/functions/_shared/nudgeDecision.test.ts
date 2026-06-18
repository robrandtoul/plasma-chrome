// Synthetic-history tests for the nudge decision module. The Phase 1 spec
// requires these because the send→suppress feedback loop cannot occur in
// dry-run mode — this harness is the only pre-launch coverage it gets.
//
// Run: npx tsx supabase/functions/_shared/nudgeDecision.test.ts
// (same hand-rolled harness convention as src/lib/dashboardGrouping.test.ts —
// no test framework in this repo; exits 1 on any failure.)

import {
  calendarDaysBetween,
  capRows,
  decideForProof,
  groupSendables,
  isWithinSendWindow,
  isWorkingDay,
  londonDate,
  londonHour,
  nudgeNumberFor,
  simulateDryLedger,
  workingDaysBetween,
  type CandidateFacts,
  type LedgerRow,
  type NudgeConfig,
} from './nudgeDecision.ts'
import { templateProblem, NUDGE_DEFAULT_BODIES } from './replyTemplates.ts'

let failures = 0
let passes = 0

function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passes++
  } else {
    failures++
    console.error(`✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function eq<T>(name: string, actual: T, expected: T) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

// Bank holidays for the synthetic calendar: Easter Monday 2026-04-06.
const HOLIDAYS: ReadonlySet<string> = new Set(['2026-04-06'])

// A Wednesday morning, well inside the send window. 2026-06-10 is a Wednesday.
const NOW = new Date('2026-06-10T09:30:00Z') // 10:30 BST

const CFG: NudgeConfig = {
  ruleEnabled: true,
  thresholdDays: 3,
  calendar: false,
  automation: { mode: 'auto', repeat_days: 3, max_nudges: 2 },
  lifetimeMax: 6,
  graceDays: 3,
  bankHolidays: HOLIDAYS,
}

function facts(overrides: Partial<CandidateFacts> = {}): CandidateFacts {
  const base: CandidateFacts = {
    proofId: 'p1',
    versionId: 'v1',
    ruleCode: 'sent_never_viewed',
    conversationId: 'c1',
    contactEmail: 'jane@example.com',
    // The threshold anchor. For sent_never_viewed it mirrors the send
    // evidence (kept in sync below); viewed_not_actioned tests pass their own.
    anchorAt: '2026-06-03T10:00:00Z',
    // Sent the previous Wednesday — 5 working days before NOW, past the
    // 3-working-day threshold.
    sendEvidenceAt: '2026-06-03T10:00:00Z',
    lastCustomerReplyAt: null,
    lastStaffReplyAt: null,
    snoozed: false,
    autoNudgeDisabled: false,
    hasFollowUpTag: false,
  }
  const merged = { ...base, ...overrides }
  // sent_never_viewed anchors on its send evidence, so a test that moves
  // sendEvidenceAt should move the anchor with it — unless it set anchorAt
  // itself. This preserves the existing send-evidence test semantics now that
  // the threshold + no-evidence gate read anchorAt.
  if (!('anchorAt' in overrides) && merged.ruleCode === 'sent_never_viewed') {
    merged.anchorAt = merged.sendEvidenceAt
  }
  return merged
}

function row(overrides: Partial<LedgerRow> = {}): LedgerRow {
  return {
    proofId: 'p1',
    versionId: 'v1',
    ruleCode: 'sent_never_viewed',
    source: 'auto',
    state: 'sent',
    outcome: 'sent',
    createdAt: '2026-06-01T08:30:00Z',
    ...overrides,
  }
}

// ── Calendar helpers ─────────────────────────────────────────────────────────

eq('londonDate formats civil date', londonDate(new Date('2026-06-10T09:30:00Z')), '2026-06-10')
// 23:30 UTC on the 10th is 00:30 BST on the 11th — London is ahead in summer.
eq('londonDate respects BST rollover', londonDate(new Date('2026-06-10T23:30:00Z')), '2026-06-11')
eq('londonHour in BST', londonHour(new Date('2026-06-10T09:30:00Z')), 10)
eq('londonHour in GMT', londonHour(new Date('2026-01-14T09:30:00Z')), 9)

eq('weekday is a working day', isWorkingDay('2026-06-10', HOLIDAYS), true)
eq('Saturday is not', isWorkingDay('2026-06-13', HOLIDAYS), false)
eq('bank holiday is not', isWorkingDay('2026-04-06', HOLIDAYS), false)

// Fri 3 Apr → Tue 7 Apr 2026 spans a weekend and Easter Monday: only
// Tue 7th counts. Inclusive-at-end, exclusive-of-start.
eq('workingDaysBetween skips weekend + holiday', workingDaysBetween('2026-04-03', '2026-04-07', HOLIDAYS), 1)
eq('workingDaysBetween same day is 0', workingDaysBetween('2026-06-10', '2026-06-10', HOLIDAYS), 0)
eq('workingDaysBetween inclusive at end', workingDaysBetween('2026-06-09', '2026-06-10', HOLIDAYS), 1)
eq('calendarDaysBetween', calendarDaysBetween('2026-06-03', '2026-06-10'), 7)

// Send window: Wednesday 10:30 BST in; Saturday out; Wednesday 07:00 London out;
// Easter Monday out even at 10:00.
eq('window: weekday morning in', isWithinSendWindow(NOW, HOLIDAYS), true)
eq('window: Saturday out', isWithinSendWindow(new Date('2026-06-13T10:00:00Z'), HOLIDAYS), false)
eq('window: too early out', isWithinSendWindow(new Date('2026-06-10T06:00:00Z'), HOLIDAYS), false)
eq('window: bank holiday out', isWithinSendWindow(new Date('2026-04-06T10:00:00Z'), HOLIDAYS), false)

// ── capRows filtering (mirrors SQL nudge_cap_rows) ───────────────────────────

const mixed: LedgerRow[] = [
  row({ state: 'sent' }),
  row({ state: 'sending' }),
  row({ state: 'dry_run' }),
  row({ state: 'skipped' }),
  row({ state: 'failed' }),
]
eq('capRows counts sent + sending only', capRows(mixed).length, 2)

// ── decideForProof: the guard ladder ─────────────────────────────────────────

eq('clean candidate sends', decideForProof(facts(), [], CFG, NOW).action, 'send')

eq('rule disabled drops', decideForProof(facts(), [], { ...CFG, ruleEnabled: false }, NOW).action, 'drop')
eq('mode review drops (no unattended send)', decideForProof(facts(), [], { ...CFG, automation: { mode: 'review' } }, NOW).action, 'drop')
eq('missing mode fails closed', decideForProof(facts(), [], { ...CFG, automation: {} as never }, NOW).action, 'drop')

{
  const d = decideForProof(facts({ sendEvidenceAt: null }), [], CFG, NOW)
  check('no send evidence skips with outcome', d.action === 'skip' && d.outcome === 'skipped_no_send_evidence')
}

// Sent Monday the 8th — only 2 working days before Wednesday NOW; threshold 3.
eq('below threshold drops', decideForProof(facts({ sendEvidenceAt: '2026-06-08T10:00:00Z' }), [], CFG, NOW).action, 'drop')

{
  const d = decideForProof(facts({ autoNudgeDisabled: true }), [], CFG, NOW)
  check('opt-out skips', d.action === 'skip' && d.outcome === 'skipped_opted_out')
}
{
  const d = decideForProof(facts({ snoozed: true }), [], CFG, NOW)
  check('snooze skips', d.action === 'skip' && d.outcome === 'skipped_snoozed')
}
// Phase 2b: a Help Scout "follow up" tag means a human owns the chase.
{
  const d = decideForProof(facts({ hasFollowUpTag: true }), [], CFG, NOW)
  check('follow-up tag skips', d.action === 'skip' && d.outcome === 'skipped_followup_tag')
}

// Customer replied after our send evidence, nothing outbound since → hard skip,
// even though the reply is older than the grace window.
{
  const d = decideForProof(
    facts({ lastCustomerReplyAt: '2026-06-04T10:00:00Z' }),
    [],
    CFG,
    NOW,
  )
  check('customer reply newer than outbound hard-skips', d.action === 'skip' && d.outcome === 'skipped_customer_replied',
    JSON.stringify(d))
}

// Customer replied, but we replied after them (staff reply newer) and that
// staff reply is outside the grace window → eligible again.
{
  const d = decideForProof(
    facts({
      lastCustomerReplyAt: '2026-06-01T10:00:00Z',
      lastStaffReplyAt: '2026-06-03T10:00:00Z',
    }),
    [],
    CFG,
    NOW,
  )
  eq('answered customer reply outside grace sends', d.action, 'send')
}

// Staff reply yesterday → inside the 3-calendar-day grace window.
{
  const d = decideForProof(facts({ lastStaffReplyAt: '2026-06-09T10:00:00Z' }), [], CFG, NOW)
  check('recent staff reply hits grace window', d.action === 'skip' && d.outcome === 'skipped_grace_window')
}

// ── viewed_not_actioned: the second auto-send rule ───────────────────────────
//
// Same guard ladder, different population. The anchor is the customer's last
// view (not the send evidence), so a viewed proof with no tracked send still
// sends — and its cap counts only its own rule's ledger rows.

// Last viewed the previous Wednesday (5 working days before NOW), no tracked
// send at all → still past threshold and sends.
{
  const vna = facts({
    ruleCode: 'viewed_not_actioned',
    anchorAt: '2026-06-03T10:00:00Z',
    sendEvidenceAt: null,
  })
  eq('viewed_not_actioned past threshold sends', decideForProof(vna, [], CFG, NOW).action, 'send')
}

// Viewed only on Monday the 8th — 2 working days before Wednesday NOW,
// threshold 3 → drops. Anchor, not send evidence, drives this.
{
  const vna = facts({ ruleCode: 'viewed_not_actioned', anchorAt: '2026-06-08T10:00:00Z', sendEvidenceAt: null })
  eq('viewed_not_actioned below threshold drops', decideForProof(vna, [], CFG, NOW).action, 'drop')
}

// A prior sent_never_viewed nudge on the SAME version does NOT consume the
// viewed_not_actioned cap (caps are per proof+rule+version). Old enough not to
// trip the cooldown.
{
  const ledger = [row({ ruleCode: 'sent_never_viewed', createdAt: '2026-06-01T08:30:00Z' })]
  const vna = facts({ ruleCode: 'viewed_not_actioned', anchorAt: '2026-06-03T10:00:00Z' })
  eq('other rule ledger rows do not consume this rule cap', decideForProof(vna, ledger, CFG, NOW).action, 'send')
}

// …but two viewed_not_actioned sends on this version DO exhaust its own cap.
{
  const ledger = [
    row({ ruleCode: 'viewed_not_actioned', createdAt: '2026-05-26T08:30:00Z' }),
    row({ ruleCode: 'viewed_not_actioned', createdAt: '2026-06-01T08:30:00Z' }),
  ]
  const vna = facts({ ruleCode: 'viewed_not_actioned', anchorAt: '2026-06-03T10:00:00Z' })
  const d = decideForProof(vna, ledger, CFG, NOW)
  check('viewed_not_actioned per-version cap exhausts', d.action === 'skip' && d.outcome === 'skipped_capped')
}

// Reminder numbering counts the candidate's own rule.
eq('viewed_not_actioned reminder number counts its own rule',
  nudgeNumberFor(
    facts({ ruleCode: 'viewed_not_actioned' }),
    [row({ ruleCode: 'viewed_not_actioned' })],
    'viewed_not_actioned',
  ), 2)

// ── Cap semantics ────────────────────────────────────────────────────────────

// Two prior auto sends on this version → capped (the exhaustion signal).
{
  const ledger = [
    row({ createdAt: '2026-05-26T08:30:00Z' }),
    row({ createdAt: '2026-06-01T08:30:00Z' }),
  ]
  const d = decideForProof(facts(), ledger, CFG, NOW)
  check('per-version cap of 2 exhausts', d.action === 'skip' && d.outcome === 'skipped_capped')
}

// Same two sends but the proof shipped v2 → cap re-arms for the new version
// (old rows are keyed to v1).
{
  const ledger = [
    row({ createdAt: '2026-05-26T08:30:00Z' }),
    row({ createdAt: '2026-06-01T08:30:00Z' }),
  ]
  const d = decideForProof(facts({ versionId: 'v2' }), ledger, CFG, NOW)
  eq('new version re-arms the cap', d.action, 'send')
}

// …but the lifetime ceiling still counts across versions: 6 prior auto sends
// on older versions exhausts the proof for good.
{
  const ledger = Array.from({ length: 6 }, (_, i) =>
    row({ versionId: `v${i}`, createdAt: `2026-04-0${i + 1}T08:30:00Z` }))
  const d = decideForProof(facts({ versionId: 'v9' }), ledger, CFG, NOW)
  check('lifetime ceiling holds across versions', d.action === 'skip' && d.outcome === 'skipped_capped_lifetime')
}

// dry_run rows never count toward caps in LIVE mode (structural exclusion —
// at the Phase 2 flip, the dry week's rows must not block real sends).
{
  const ledger = [
    row({ state: 'dry_run', outcome: 'would_send', createdAt: '2026-05-26T08:30:00Z' }),
    row({ state: 'dry_run', outcome: 'would_send', createdAt: '2026-06-01T08:30:00Z' }),
  ]
  eq('dry-run rows do not consume the cap (live mode)', decideForProof(facts(), ledger, CFG, NOW).action, 'send')
}

// …but the DRY-RUN simulation counts them: passed through simulateDryLedger,
// prior would-send rows behave as sent, so the dry week demonstrates cap
// exhaustion and cooldown night-over-night (spec Phase 1 acceptance).
{
  const ledger = simulateDryLedger([
    row({ state: 'dry_run', outcome: 'would_send', createdAt: '2026-05-26T08:30:00Z' }),
    row({ state: 'dry_run', outcome: 'would_send', createdAt: '2026-06-01T08:30:00Z' }),
  ])
  const d = decideForProof(facts(), ledger, CFG, NOW)
  check('simulated dry ledger exhausts the cap', d.action === 'skip' && d.outcome === 'skipped_capped')
}
{
  const ledger = simulateDryLedger([
    row({ state: 'dry_run', outcome: 'would_send', createdAt: '2026-06-09T08:30:00Z' }),
  ])
  const d = decideForProof(facts(), ledger, CFG, NOW)
  check('simulated dry ledger enforces cooldown', d.action === 'skip' && d.outcome === 'skipped_cooldown')
}
{
  // Skip rows are NOT simulated as sends — only would_send rows count.
  const ledger = simulateDryLedger([
    row({ state: 'dry_run', outcome: 'skipped_snoozed', createdAt: '2026-06-09T08:30:00Z' }),
  ])
  eq('simulated skips stay invisible to the maths', decideForProof(facts(), ledger, CFG, NOW).action, 'send')
}

// A MANUAL nudge consumes a per-version cap slot (locked default: two chases
// per version total, human or bot).
{
  const ledger = [
    row({ source: 'manual', createdAt: '2026-05-20T08:30:00Z' }),
    row({ createdAt: '2026-05-26T08:30:00Z' }),
  ]
  const d = decideForProof(facts(), ledger, CFG, NOW)
  check('manual nudge consumes a cap slot', d.action === 'skip' && d.outcome === 'skipped_capped')
}

// A crashed claim ('sending', never flipped) still counts — it cannot be
// spent twice.
{
  const ledger = [
    row({ state: 'sending', createdAt: '2026-05-26T08:30:00Z' }),
    row({ state: 'sent', createdAt: '2026-06-01T08:30:00Z' }),
  ]
  const d = decideForProof(facts(), ledger, CFG, NOW)
  check('sending rows count toward the cap', d.action === 'skip' && d.outcome === 'skipped_capped')
}

// ── Cooldown semantics ───────────────────────────────────────────────────────

// Auto send on Monday the 8th — 2 working days before Wednesday NOW, repeat_days 3.
{
  const ledger = [row({ createdAt: '2026-06-08T08:30:00Z' })]
  const d = decideForProof(facts(), ledger, CFG, NOW)
  check('recent auto send cools down', d.action === 'skip' && d.outcome === 'skipped_cooldown')
}

// A MANUAL nudge on Monday also cools down the auto path (single ledger).
{
  const ledger = [row({ source: 'manual', createdAt: '2026-06-08T08:30:00Z' })]
  const d = decideForProof(facts(), ledger, CFG, NOW)
  check('manual nudge delays automation', d.action === 'skip' && d.outcome === 'skipped_cooldown')
}

// Send last Wednesday (3 June): Thu, Fri, Mon, Tue = 4 working days → clear.
{
  const ledger = [row({ createdAt: '2026-06-03T08:30:00Z' })]
  eq('cooldown clears after repeat_days working days', decideForProof(facts(), ledger, CFG, NOW).action, 'send')
}

// Weekend + bank-holiday awareness: send Thu 2 Apr 2026; Fri 3rd is Good
// Friday (not in our fixture set), but Easter Mon 6 Apr IS. With NOW = Wed
// 8 Apr, working days since = Fri 3rd + Tue 7th + Wed 8th = 3 → clear; with
// NOW = Tue 7 Apr it is 2 → cooling.
{
  const ledger = [row({ createdAt: '2026-04-02T08:30:00Z' })]
  const cooling = decideForProof(facts({ sendEvidenceAt: '2026-03-20T10:00:00Z' }), ledger, CFG, new Date('2026-04-07T09:30:00Z'))
  check('cooldown counts through holiday weekend correctly (still cooling)',
    cooling.action === 'skip' && cooling.outcome === 'skipped_cooldown', JSON.stringify(cooling))
  const cleared = decideForProof(facts({ sendEvidenceAt: '2026-03-20T10:00:00Z' }), ledger, CFG, new Date('2026-04-08T09:30:00Z'))
  eq('cooldown clears the day after', cleared.action, 'send')
}

// ── Sibling grouping ─────────────────────────────────────────────────────────

{
  const a = facts({ proofId: 'pA', conversationId: 'cA', contactEmail: 'same@x.com' })
  const b = facts({ proofId: 'pB', conversationId: 'cB', contactEmail: 'Same@X.com' })
  const g = groupSendables([a, b])
  eq('same identity (case-insensitive) sends none', g.send.length, 0)
  eq('both siblings suppressed', g.suppressed.length, 2)
}

{
  const a = facts({ proofId: 'pA', conversationId: 'cShared', contactEmail: 'one@x.com', sendEvidenceAt: '2026-06-01T10:00:00Z' })
  const b = facts({ proofId: 'pB', conversationId: 'cShared', contactEmail: 'two@x.com', sendEvidenceAt: '2026-06-03T10:00:00Z' })
  const g = groupSendables([a, b])
  eq('shared conversation sends one', g.send.length, 1)
  eq('most overdue wins', g.send[0]?.proofId, 'pA')
  eq('the other is suppressed', g.suppressed[0]?.proofId, 'pB')
}

{
  const a = facts({ proofId: 'pA', conversationId: 'cA', contactEmail: 'a@x.com' })
  const b = facts({ proofId: 'pB', conversationId: 'cB', contactEmail: 'b@x.com' })
  const g = groupSendables([a, b])
  eq('unrelated proofs both send', g.send.length, 2)
}

{
  const g = groupSendables([facts({ contactEmail: null })])
  eq('null email falls back to conversation identity', g.send.length, 1)
}

// ── Calendar-mode threshold (the live rules carry per-rule calendar flags) ──

{
  // Sent Saturday 6 June, NOW Wednesday 10 June: 4 calendar days ≥ 3 → past
  // threshold in calendar mode…
  const cal: NudgeConfig = { ...CFG, calendar: true }
  eq('calendar-mode threshold counts weekends', decideForProof(facts({ sendEvidenceAt: '2026-06-06T10:00:00Z' }), [], cal, NOW).action, 'send')
  // …but only 2 WORKING days (Mon, Tue… Wed inclusive = 3? Sat→Wed is
  // Mon+Tue+Wed = 3) — make the contrast unambiguous with Sunday the 7th:
  // calendar 3 ≥ 3 sends; working Mon+Tue+Wed = 3 also sends; so use the
  // 8th: calendar 2 < 3 drops in both modes. The discriminating case:
  // Saturday the 6th with threshold 4 — calendar 4 ≥ 4 sends, working 3 < 4
  // drops.
  const cal4: NudgeConfig = { ...CFG, calendar: true, thresholdDays: 4 }
  const work4: NudgeConfig = { ...CFG, calendar: false, thresholdDays: 4 }
  eq('calendar mode passes at 4 days', decideForProof(facts({ sendEvidenceAt: '2026-06-06T10:00:00Z' }), [], cal4, NOW).action, 'send')
  eq('working mode still below at 3/4 days', decideForProof(facts({ sendEvidenceAt: '2026-06-06T10:00:00Z' }), [], work4, NOW).action, 'drop')
}

// ── nudgeNumberFor (reminder #2 opens a fresh conversation) ─────────────────

eq('first reminder is #1', nudgeNumberFor(facts(), [], 'sent_never_viewed'), 1)
// A prior counted send — auto or manual — makes the next one #2.
eq('prior auto send makes it #2',
  nudgeNumberFor(facts(), [row({ createdAt: '2026-06-01T08:30:00Z' })], 'sent_never_viewed'), 2)
eq('prior manual send also counts',
  nudgeNumberFor(facts(), [row({ source: 'manual' })], 'sent_never_viewed'), 2)
// Dry-run rows and other versions/rules don't advance the number.
eq('dry rows do not advance the number',
  nudgeNumberFor(facts(), [row({ state: 'dry_run', outcome: 'would_send' })], 'sent_never_viewed'), 1)
eq('other version does not advance the number',
  nudgeNumberFor(facts(), [row({ versionId: 'v0' })], 'sent_never_viewed'), 1)

// ── Null-versionId ledger rows (FK on delete set null) never crash or match ──

{
  const ledger = [
    row({ versionId: null, createdAt: '2026-05-26T08:30:00Z' }),
    row({ versionId: null, createdAt: '2026-05-27T08:30:00Z' }),
  ]
  const d = decideForProof(facts(), ledger, CFG, NOW)
  // They miss the per-version cap (keyed to v1) but DO count for lifetime +
  // cooldown — cooldown cleared here (long ago), cap not reached → send.
  eq('null-version rows do not match the version cap', d.action, 'send')
}

// ── templateProblem (the pre-render guard) ───────────────────────────────────

const GOOD_CTX = { first_name: 'Jane', full_name: 'Jane Doe', company: 'Acme', version_number: 2, url: 'https://x/p/1', designer_first_name: '' }

eq('seeded template is clean', templateProblem(NUDGE_DEFAULT_BODIES.nudge_sent_never_viewed, GOOD_CTX), null)
check('typo token is caught pre-render', templateProblem('Hi {first_name}, link: {ur1}', GOOD_CTX) !== null)
check('unbalanced conditional is caught', templateProblem('Hi {? company}for {company}', GOOD_CTX) !== null)
check('empty url is caught', templateProblem('Hi {first_name} {url}', { ...GOOD_CTX, url: '' }) !== null)
check('empty first name is caught', templateProblem('Hi {first_name} {url}', { ...GOOD_CTX, first_name: ' ' }) !== null)
eq('known-but-empty company is fine (conditional collapses)', templateProblem('Hi {first_name}{? company} of {company}{/?} {url}', { ...GOOD_CTX, company: null }), null)

// ── Result ───────────────────────────────────────────────────────────────────

console.log(`${passes} passed, ${failures} failed`)
if (failures > 0) process.exit(1)
