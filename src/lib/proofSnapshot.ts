// Pure derivations for the proof detail page's "snapshot" band — the
// engagement funnel (Sent → Viewed → Responded), the at-a-glance stat
// cards (age / last activity / total views / quantity range), and the
// one-line state summary under the header. Kept framework-free (no
// React, no supabase) so it can be unit-tested with tsx like
// dashboardGrouping and proofTimeline. ProofDetailPage owns rendering
// and relative-time formatting; this module owns the logic + states.

import type { ProofBucket } from './dashboardGrouping'

// ── Send evidence ──────────────────────────────────────────────────────────────
//
// "Sent" for the current version is the in-app reply timestamp
// (proof_versions.last_reply_sent_at). Versions sent straight from Help
// Scout never get that stamp, so we fall back to the proof's last Help
// Scout staff reply — but ONLY when it postdates the current version's
// creation, mirroring migration 000224's send-evidence scoping (an older
// reply is evidence for a previous version, not this one).

export function sentEvidenceAt(opts: {
  versionReplyAt: string | null
  versionCreatedAt: string | null
  helpscoutLastReplyAt: string | null
}): string | null {
  if (opts.versionReplyAt) return opts.versionReplyAt
  const hs = opts.helpscoutLastReplyAt
  if (!hs) return null
  if (opts.versionCreatedAt && new Date(hs).getTime() <= new Date(opts.versionCreatedAt).getTime()) {
    return null
  }
  return hs
}

// ── Engagement funnel ───────────────────────────────────────────────────────────

export type FunnelState = 'done' | 'active' | 'pending'
export type RespondedKind = 'approved' | 'changes' | 'selection'

export interface FunnelStep {
  key: 'sent' | 'viewed' | 'responded'
  label: string
  state: FunnelState
  /** ISO timestamp the step renders as its "when", or null. */
  at: string | null
  /** Short qualifier shown under the label when there's no timestamp
   *  (e.g. "not viewed", "awaiting reply"). Null when `at` carries it. */
  note: string | null
}

export interface FunnelInput {
  sentAt: string | null
  viewCount: number
  lastViewedAt: string | null
  responded: { kind: RespondedKind; at: string } | null
  /** Help Scout customer email-reply timestamp scoped to this round (the
   *  same signal the dashboard's "Replied by email" pill uses). Counts as a
   *  response when there's no in-app approve/change-request, so the funnel
   *  doesn't read "awaiting reply" while the header says the customer
   *  replied. Null/omitted when there's no qualifying email reply. */
  emailRepliedAt?: string | null
}

const RESPONDED_NOTE: Record<RespondedKind, string> = {
  approved: 'approved',
  changes: 'changes requested',
  selection: 'option chosen',
}

export function buildFunnel(i: FunnelInput): FunnelStep[] {
  const sentState: FunnelState = i.sentAt ? 'done' : 'pending'
  const viewedState: FunnelState = i.viewCount > 0 ? 'done' : i.sentAt ? 'active' : 'pending'
  // An in-app approve/change-request is the strongest "responded" signal;
  // failing that, a Help Scout email reply (emailRepliedAt) also counts as a
  // response, so the funnel agrees with the header's "Replied by email" pill
  // instead of being stuck on "awaiting reply". In-app wins when both exist —
  // it's the more specific outcome (approved vs changes).
  const respondedState: FunnelState =
    i.responded || i.emailRepliedAt ? 'done' : i.viewCount > 0 ? 'active' : 'pending'

  return [
    {
      key: 'sent',
      label: 'Sent',
      state: sentState,
      at: i.sentAt,
      note: i.sentAt ? null : 'not sent yet',
    },
    {
      key: 'viewed',
      label: i.viewCount > 0 ? `Viewed ${i.viewCount}×` : 'Viewed',
      state: viewedState,
      at: i.viewCount > 0 ? i.lastViewedAt : null,
      note: i.viewCount > 0 ? null : 'not viewed',
    },
    {
      key: 'responded',
      label: 'Responded',
      state: respondedState,
      at: i.responded?.at ?? null,
      note: i.responded
        ? RESPONDED_NOTE[i.responded.kind]
        : i.emailRepliedAt
          ? 'replied by email'
          : i.viewCount > 0
            ? 'awaiting reply'
            : null,
    },
  ]
}

// ── Stat cards ──────────────────────────────────────────────────────────────────

/** Whole days between an ISO timestamp and `nowMs`, floored, never negative. */
export function ageDays(iso: string, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - new Date(iso).getTime()) / 86_400_000))
}

/** Total non-bot views summed across every version's view list. */
export function totalNonBotViews(
  viewsByVersion: ReadonlyMap<string, ReadonlyArray<unknown>>,
): number {
  let n = 0
  for (const list of viewsByVersion.values()) n += list.length
  return n
}

/**
 * Order-scale label for the current version's price grid: the span of
 * quantity tiers the customer can pick ("25–1,000"). Returns "Custom"
 * for custom-quote / per-direction-pricing versions (no single grid)
 * and null when no quantities are known.
 */
export function quantityRangeLabel(opts: {
  customQuote: boolean
  perDirectionPricing: boolean
  quantities: number[] | null | undefined
}): string | null {
  if (opts.customQuote || opts.perDirectionPricing) return 'Custom'
  const q = opts.quantities
  if (!q || q.length === 0) return null
  const fmt = (n: number) => n.toLocaleString('en-GB')
  const min = Math.min(...q)
  const max = Math.max(...q)
  return min === max ? fmt(min) : `${fmt(min)}–${fmt(max)}`
}

// ── Per-version rounds ──────────────────────────────────────────────────────────
//
// Each version is one send/respond lap of the proof's back-and-forth.
// The engagement panel's rounds strip reads an outcome per version:
//   'changes'  — the customer asked for changes on this version
//   'approved' — the customer approved this version
//   'awaiting' — the current version, sent, no response yet
//   'none'     — a superseded version the customer never responded to
//                (a proactive designer revision)
// A change request wins over a stray approval on the same version (a
// split-name proof where one recipient approved and another didn't is
// still a round that bounced). The current version reports its live
// state; the funnel below it details the sub-state.

export type RoundOutcome = 'approved' | 'changes' | 'awaiting' | 'none'

export function roundOutcome(opts: {
  isCurrent: boolean
  proofApproved: boolean
  hasChanges: boolean
  hasApproved: boolean
}): RoundOutcome {
  if (opts.isCurrent) {
    if (opts.proofApproved || (opts.hasApproved && !opts.hasChanges)) return 'approved'
    return opts.hasChanges ? 'changes' : 'awaiting'
  }
  return opts.hasChanges ? 'changes' : opts.hasApproved ? 'approved' : 'none'
}

// ── Header state summary ────────────────────────────────────────────────────────
//
// A one-line human sentence under the header that turns the status pill's
// category into "what's happening + since when". Only the active
// in-progress workflow states get a line — terminal states (approved /
// abandoned / dormant) and snoozed already read clearly from the pill +
// the existing header notes, so we return null and add nothing.

export interface SummaryInput {
  bucket: ProofBucket
  ruleCode: string | null
  sentAt: string | null
  lastViewedAt: string | null
  respondedAt: string | null
  customerRepliedAt: string | null
  lastActivityAt: string | null
}

export interface SummaryLine {
  /** Phrase before the relative time ("Sent to customer"). */
  lead: string
  /** ISO timestamp to relative-format after the lead, or null. */
  at: string | null
}

const RULE_LEAD: Record<string, string> = {
  request_changes_no_version: 'Customer requested changes — needs a new version',
  helpscout_follow_up_tag: 'Flagged “follow up” in Help Scout',
  sent_never_viewed: 'Sent but not opened yet',
  viewed_not_actioned: 'Opened, no response yet',
  approaching_dormant: 'Going quiet — approaching dormant',
  stuck_in_progress: 'No movement for a while',
  approved_earlier_version: 'Customer approved an earlier version',
  nudges_exhausted: 'Reminders sent, still no response',
}

export function summaryLine(i: SummaryInput): SummaryLine | null {
  switch (i.bucket) {
    case 'needs_attention':
      return {
        lead: (i.ruleCode && RULE_LEAD[i.ruleCode]) || 'Needs attention',
        at: i.lastActivityAt,
      }
    case 'changes_requested':
      return { lead: 'Customer requested changes', at: i.respondedAt }
    case 'customer_replied':
      return { lead: 'Customer replied by email', at: i.customerRepliedAt }
    case 'awaiting_customer':
      return i.lastViewedAt
        ? { lead: 'Opened — awaiting reply', at: i.lastViewedAt }
        : { lead: 'Sent — awaiting first view', at: i.sentAt }
    case 'not_viewed':
      return i.sentAt
        ? { lead: 'Sent — not opened yet', at: i.sentAt }
        : { lead: 'Not sent to the customer yet', at: null }
    default:
      // approved / abandoned / dormant / snoozed — pill + header notes cover it.
      return null
  }
}
