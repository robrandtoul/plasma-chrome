// Needs-attention rule copy — the single place that turns a rule_code (+ its
// rule_meta) into human text. The dashboard reason chip, the dashboard +
// detail status-pill tooltips, and (in time) the admin editor all read from
// here, so a rule's wording lives in exactly one spot.
//
// proofs_needing_attention() (migration 000154/000164/000221) emits the
// single highest-priority rule that fired per proof — attentionReason /
// attentionResolution describe that one rule. Since 000221 the winning
// row's rule_meta.others carries any other rules that also fired; the
// resolve popover renders those via attentionShortLabel.

import type { NeedsAttentionMeta, NeedsAttentionRule } from './dashboardGrouping'

/**
 * Short reason text — what tripped the rule. Templated against rule_meta for
 * the rules that carry one; the no-threshold rules ignore it.
 */
export function attentionReason(
  code: NeedsAttentionRule,
  meta: NeedsAttentionMeta | null | undefined,
): string {
  const days = meta?.days
  switch (code) {
    case 'request_changes_no_version':
      return `Customer requested changes ${days ?? '—'} days ago, no new version`
    case 'helpscout_follow_up_tag':
      return 'Help Scout conversation tagged "follow up"'
    case 'sent_never_viewed':
      return `Sent ${days ?? '—'} days ago, never opened`
    case 'viewed_not_actioned':
      return `Last viewed ${days ?? '—'} days ago, no action since`
    case 'approaching_dormant':
      return `Approaching dormant — ${days ?? '—'} days since last activity`
    case 'stuck_in_progress':
      return `Stuck in progress — no activity for ${days ?? '—'} days`
    case 'approved_earlier_version':
      return 'Customer approved a non-current version — current version not approved'
    case 'nudges_exhausted':
      // meta.sent = reminders already sent; meta.no_contact = the customer
      // has never viewed any version OR replied by email — a deliverability
      // red flag (wrong address / spam folder), not just a quiet customer.
      return meta?.no_contact
        ? `${meta?.sent ?? 2} reminders sent, never opened or replied — may not be reaching them`
        : `${meta?.sent ?? 2} reminders sent — still no response`
  }
}

/**
 * One-line, plain-English next step to clear the rule. Authored copy (Rob can
 * tweak the wording); the mapping is exhaustive over the rules so the
 * tooltip always has something to show.
 */
export function attentionResolution(code: NeedsAttentionRule): string {
  switch (code) {
    case 'request_changes_no_version':
      return 'Upload a new version addressing the change request, or reply to the customer.'
    case 'helpscout_follow_up_tag':
      return 'Follow up on the Help Scout conversation, then clear the "follow up" tag.'
    case 'sent_never_viewed':
      return 'Nudge the customer to open the proof, or resend the link.'
    case 'viewed_not_actioned':
      return 'Chase the customer for approval or a decision.'
    case 'approaching_dormant':
      return 'Ping the customer before the proof auto-marks dormant.'
    case 'stuck_in_progress':
      return "Check in with the customer, or close the proof out if it's dead."
    case 'approved_earlier_version':
      return 'The customer approved a version that isn’t the current one. Check with them, then get them to approve the current version — or open the approved version and “Set as current” if that’s the one they want.'
    case 'nudges_exhausted':
      return 'Email reminders have run their course — time for a phone call. If they’ve never opened anything, double-check the email address first (the proof may be landing in spam).'
  }
}

/**
 * Two-or-three-word label per rule, for compact contexts: the resolve
 * popover's "Also: …" line (rule_meta.others) and the Outbox review queue.
 */
export function attentionShortLabel(code: string): string {
  switch (code) {
    case 'request_changes_no_version': return 'changes requested'
    case 'helpscout_follow_up_tag':    return 'follow-up tag'
    case 'sent_never_viewed':          return 'never opened'
    case 'viewed_not_actioned':        return 'viewed, no action'
    case 'approaching_dormant':        return 'approaching dormant'
    case 'stuck_in_progress':          return 'stuck in progress'
    case 'approved_earlier_version':   return 'earlier version approved'
    case 'nudges_exhausted':           return 'reminders exhausted'
    default:                           return code.replace(/_/g, ' ')
  }
}

// Reply-template id (in reply_templates / DEFAULT_BODIES) used for the
// one-click "Send a reminder" action on each customer-chase rule. Seeded in
// migration 000207.
export type NudgeTemplateId =
  | 'nudge_sent_never_viewed'
  | 'nudge_viewed_not_actioned'
  | 'nudge_approaching_dormant'
  | 'nudge_stuck_in_progress'

/**
 * The nudge template for a rule, or null when "send the customer a reminder"
 * isn't the right move:
 *   - request_changes_no_version → the fix is shipping a new version, not a
 *     nudge (the resolve popover offers "Start new version" instead).
 *   - helpscout_follow_up_tag → a human flagged it; the action is staff-side.
 *   - nudges_exhausted → another email is exactly what this rule says has
 *     stopped working; the resolution is a call.
 */
export function nudgeTemplateFor(code: NeedsAttentionRule): NudgeTemplateId | null {
  switch (code) {
    case 'sent_never_viewed':   return 'nudge_sent_never_viewed'
    case 'viewed_not_actioned': return 'nudge_viewed_not_actioned'
    case 'approaching_dormant': return 'nudge_approaching_dormant'
    case 'stuck_in_progress':   return 'nudge_stuck_in_progress'
    case 'request_changes_no_version':
    case 'helpscout_follow_up_tag':
    // approved_earlier_version → the fix is a designer reconciliation
    // (re-approve the current version, or promote the approved one),
    // not a customer nudge. Resolve popover falls through to snooze +
    // the resolution copy.
    case 'approved_earlier_version':
    case 'nudges_exhausted':
      return null
  }
}
