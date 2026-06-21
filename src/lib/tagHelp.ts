// Plain-English explanations for the cryptic status tags the staff-facing
// screens show (Reminder Outbox outcomes, Needs-attention rules, dashboard
// buckets, AI-draft labels, plus a couple of Outbox header indicators).
//
// This is the single source of truth for the *meanings* shown in the
// in-context HelpTip tooltips. The labels themselves still live next to the
// components that render them (OUTCOME_LABELS in NudgeOutboxPanel, BUCKET_META
// in dashboardGrouping, attentionShortLabel in needsAttention, the AI-draft
// label maps in the admin pages); this file only adds the one-line "what does
// this mean" copy keyed by the same stable codes those components already use.
//
// Keyed by family first so the same short code in two families can't collide
// (e.g. 'skipped' means different things in different places). A missing key
// returns undefined, and <HelpTip> renders the tag with no tooltip — so a new
// tag code is never a hard error, it just has no help until a line is added
// here. Wording is Rob's to tweak; British English, no jargon.

export type TagHelpFamily = 'outbox' | 'needs' | 'bucket' | 'tile' | 'aidraft' | 'system'

const TAG_HELP: Record<TagHelpFamily, Record<string, string>> = {
  // ── Reminder Outbox: what the automation did (or would do) for each proof.
  // Keyed by the free-text outcome code the sender writes (send-nudges +
  // nudgeDecision). 'fresh_conversation' is the badge shown when an outcome
  // ends in '_new_conversation', so it gets its own friendly entry too.
  outbox: {
    would_send:
      'Dry-run only: this is the reminder we would have emailed. Nothing was actually sent.',
    would_send_new_conversation:
      'Dry-run only: we would have sent this as a brand-new email thread (used from the 2nd reminder onwards). Nothing was actually sent.',
    sent: 'The reminder was emailed to the customer.',
    sent_new_conversation:
      'Sent as a brand-new email thread, not a reply. A fresh subject line has a better chance of reaching the inbox if the first email landed in spam. Used from the 2nd reminder onwards.',
    fresh_conversation:
      'Sent as a brand-new email thread, not a reply. A fresh subject line has a better chance of reaching the inbox if the first email landed in spam. Used from the 2nd reminder onwards.',
    sending: 'This reminder is being sent right now.',
    recipient_mismatch:
      "The email on this proof does not match the linked Help Scout conversation, so we held off. Worth checking the proof is linked to the right customer.",
    suppressed_sibling:
      'This customer has more than one proof due a reminder at once. We send one combined email rather than several, so the others are held.',
    skipped_customer_replied:
      'The customer wrote back, so the auto-reminders stopped. Someone should read the thread and reply personally.',
    skipped_conversation_missing:
      "We could not find the linked Help Scout conversation, so no reminder was sent.",
    skipped_closed_conversation:
      'The Help Scout conversation is closed, so we did not send a reminder.',
    skipped_no_send_evidence:
      "We have no record that this version was ever sent to the customer, so we held off chasing them about it.",
    skipped_snoozed: 'Reminders are snoozed on this proof, so none was sent.',
    skipped_opted_out: 'Automatic chasing is switched off for this proof.',
    skipped_capped:
      'The automatic chasing has hit its limit (2 reminders) with no response. Time for a call or a personal email.',
    skipped_capped_lifetime:
      'This proof has had the maximum number of reminders over its lifetime, so no more will be sent automatically.',
    skipped_cooldown:
      'Skipped because not enough time has passed since the last message.',
    skipped_grace_window:
      'The customer replied recently, so we are holding off for a few days before sending any reminder.',
    skipped_followup_tag:
      "The Help Scout conversation is tagged 'follow up', so a person is handling the chase and the automation stays out of it.",
  },

  // ── Needs-attention rules. Keyed by rule_code (proofs_needing_attention).
  // These describe what the label *means*; the next-step copy lives in
  // attentionResolution() and is shown in the resolve popover.
  needs: {
    request_changes_no_version:
      'The customer asked for changes in the proof viewer, but no new version has been uploaded yet.',
    helpscout_follow_up_tag:
      "The linked Help Scout conversation is tagged 'follow up', flagging it for a person to chase.",
    sent_never_viewed: "We can see the customer has not opened the proof link yet.",
    viewed_not_actioned:
      'The customer opened the proof but has not approved it or asked for changes.',
    approaching_dormant:
      'There has been no activity for a while. The proof will soon be filed away as dormant.',
    stuck_in_progress: 'This proof has sat with no activity for a long time.',
    approved_earlier_version:
      "The customer approved an older version, not the current one, so the sign-off does not count until the current version is approved.",
    nudges_exhausted:
      'We have sent the maximum number of reminders with no reply. This one needs a human nudge, such as a phone call.',
  },

  // ── Dashboard status buckets. Keyed by ProofBucket (dashboardGrouping).
  bucket: {
    needs_attention:
      'Something about this proof needs a person to look at it. The reason chip beside it has the specifics.',
    changes_requested:
      'The customer asked for changes inside the proof viewer. You owe them a new version.',
    customer_replied:
      'The customer replied on the Help Scout email thread. Open it and read what they said.',
    in_follow_up:
      'The automatic reminder system is chasing this customer. No action needed from you unless it runs out of reminders.',
    awaiting_customer:
      'The proof has been sent and we are waiting for the customer to act.',
    not_viewed: "The proof has been sent but the customer has not opened it yet.",
    snoozed: 'You have hidden this from Needs attention until a date you chose.',
    approved: 'The customer has approved the proof.',
    dormant:
      'No activity for a long time, so it has been filed away as dormant. It wakes up again if the customer does something.',
    abandoned: 'This proof was manually marked as abandoned.',
  },

  // ── Dashboard headline stat tiles (counts across all proofs). Keyed by
  // TileKey in DashboardPage. Distinct from the per-row buckets above: these
  // are totals rather than one proof's status, and a couple differ in meaning
  // (customer_responded folds in both in-app change requests and email
  // replies; approved_this_week is a 7-day window).
  tile: {
    needs_attention:
      'How many proofs currently need a person to step in. Click to show just those.',
    not_viewed: "Proofs that have been sent but the customer hasn't opened yet.",
    awaiting_customer:
      'Proofs sent and waiting on the customer, with nothing flagged as wrong.',
    in_follow_up:
      "Proofs the automatic reminder system is actively chasing (a reminder has gone out and more are due). They leave this tile and land in Needs attention if the reminders run out with no reply.",
    customer_responded:
      "Proofs where the customer either asked for changes in the viewer or replied on the email thread, and we haven't responded since.",
    approved_this_week: 'Proofs the customer has approved in the last 7 days.',
    snoozed:
      'Proofs you have hidden from Needs attention until a date you chose. Click to show them.',
    dormant: 'Proofs filed away after a long stretch of no activity.',
  },

  // ── AI drafts admin panel. Covers the decision outcome, how the team used
  // the draft (edit class), and why a non-customer email was skipped.
  aidraft: {
    drafted: 'The AI wrote a draft reply for the team to review and send.',
    abstained:
      "The AI chose not to draft a reply because it was not confident enough.",
    blocked:
      'A safety guardrail stopped the draft (for example it mentioned a price or a link it should not).',
    skipped:
      "No draft was written because this email is not a customer enquiry that needs one.",
    sent_as_is: "The team sent the AI's draft reply exactly as written, with no edits.",
    lightly_edited: 'The team sent the draft with only small tweaks.',
    rewritten:
      'The team used the draft as a starting point but rewrote most of it.',
    discarded: "The team did not use the draft and wrote their own reply.",
    spam: 'Skipped: this looked like unsolicited junk.',
    supplier:
      'Skipped: this email came from a supplier, not a customer, so no reply was drafted.',
    automated_notification:
      'Skipped: this was an automated notification, not a person writing in.',
  },

  // ── Outbox header indicators (run mode + webhook freshness).
  system: {
    live: "Reminders are really being emailed. In dry-run mode they would only be logged, not sent.",
    dry_run:
      'The run is in dry-run mode: it logs what it would send, but emails nothing.',
    webhook_fresh:
      "Help Scout is sending us customer activity in real time, so 'opened' and 'replied' are up to date.",
    webhook_quiet:
      "We have not heard from the Help Scout webhook in a while, so 'opened' and 'replied' may be out of date. Worth checking the connection.",
  },
}

/**
 * The plain-English explanation for a tag, or undefined when there isn't one.
 * Pass straight into <HelpTip body={...}> — an undefined result makes the tip
 * render its children with no tooltip, so call sites never need to branch.
 */
export function tagHelp(
  family: TagHelpFamily,
  code: string | null | undefined,
): string | undefined {
  if (!code) return undefined
  return TAG_HELP[family]?.[code]
}
