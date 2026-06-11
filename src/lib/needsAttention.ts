// Needs-attention rule copy — the single place that turns a rule_code (+ its
// rule_meta.days threshold) into human text. The dashboard reason chip, the
// dashboard + detail status-pill tooltips, and (in time) the admin editor all
// read from here, so a rule's wording lives in exactly one spot.
//
// proofs_needing_attention() (migration 000154/000164) emits the single
// highest-priority rule that fired per proof, so each proof has exactly one
// rule_code — attentionReason / attentionResolution describe that one rule.

import type { NeedsAttentionRule } from './dashboardGrouping'

/**
 * Short reason text — what tripped the rule. Templated against rule_meta.days
 * for the rules that carry a threshold; the no-threshold rule ignores it.
 */
export function attentionReason(code: NeedsAttentionRule, days: number | undefined): string {
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
  }
}

/**
 * One-line, plain-English next step to clear the rule. Authored copy (Rob can
 * tweak the wording); the mapping is exhaustive over the six rules so the
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
 *   - helpscout_follow_up_tag → inert until the Phase 2b tag sync ships, and
 *     the action is staff-side anyway.
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
      return null
  }
}
