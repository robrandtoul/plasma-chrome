// Pure assembly logic for the per-project activity timeline on the
// proof detail page. Kept framework-free (no React, no supabase) so
// it can be unit-tested with tsx like dashboardGrouping — the
// component in src/components/ProofTimeline.tsx owns the rendering.
//
// The timeline is built entirely from data ProofDetailPage already
// fetches: the proof row's status timestamps, the versions list,
// the raw proof_events rows, and the non-bot proof_version_views
// map. No new database surface — the dashboard's global activity
// feed (dashboard_latest_events) stays untouched.

export type TimelineEntryType =
  | 'project_created'
  | 'version_created'
  | 'reply_sent'
  | 'reminder_sent'
  | 'order_reminder_sent'
  | 'customer_email_reply'
  | 'view'
  | 'approve'
  | 'request_changes'
  | 'designer_override_approve'
  | 'terms_acknowledged'
  | 'proof_approved'
  | 'proof_abandoned'

export interface TimelineEntry {
  /** Unique render key. Synthetic entries derive theirs from the source row. */
  id: string
  type: TimelineEntryType
  /** ISO timestamp the entry sorts on. */
  at: string
  /**
   * Who did it ("Sarah Smith"). Null for milestone entries (version
   * created, project approved…) where no actor is recorded — the
   * component renders the verb alone in that case.
   */
  actor: string | null
  /** Rendered after the actor: "opened v2", "requested changes on v3". */
  verb: string
  /** Customer's message on request_changes (and approve-with-note). */
  comment: string | null
  /** Split-name recipient slot the action applied to, when recorded. */
  recipientName: string | null
  /**
   * True when a customer action failed to notify Help Scout
   * (helpscout_thread_id null on an approve / request_changes row) —
   * same warning the dashboard feed surfaces.
   */
  failedNotification: boolean
}

// Raw proof_events row shape as fetched by ProofDetailPage (with the
// nested proof_round_variants embed already unwrapped to a string).
export interface TimelineEventRow {
  id: string
  proof_version_id: string
  event_type: 'approve' | 'request_changes' | 'designer_override_approve'
  actor_name: string
  name: string | null
  comment: string | null
  helpscout_thread_id: string | null
  created_at: string
  variant_display_name: string | null
}

// A sent reminder from the proof_nudges ledger. One row per genuine
// outbound chase (manual one-click or the automatic send-nudges cron),
// surfaced as its own timeline entry so the whole cadence is visible —
// not collapsed into the single, overwritten last_reply_sent_at stamp.
export interface TimelineReminderRow {
  /** proof_nudges.id — render key. */
  id: string
  proof_version_id: string
  /** 'auto' = the send-nudges cron; 'manual' = a designer's one-click chase. */
  source: 'auto' | 'manual'
  created_at: string
  /**
   * Designer auth id for a manual nudge; null for an automatic send (the
   * sender records no author). Resolved to a name via designerNamesById,
   * exactly like version attribution.
   */
  sent_by?: string | null
}

// A sent unpaid-order payment reminder from the order_nudges ledger
// (send-order-reminders cron, migration 000238). Order-level rather than
// version-level — an order isn't tied to a proof version — so it carries
// its own reminder_no for the "payment reminder N" ordinal rather than
// being numbered per version like the proof-chase reminders above.
export interface TimelineOrderReminderRow {
  /** order_nudges.id — render key. */
  id: string
  /** 1-based stage from the ledger (reminder 1, 2, 3…). */
  reminder_no: number
  /** 'auto' = the send-order-reminders cron; 'manual' kept for symmetry. */
  source: 'auto' | 'manual'
  created_at: string
}

export interface TimelineSources {
  proof: {
    created_at: string
    approved_at: string | null
    abandoned_at: string | null
    disclaimer_acknowledged_at: string | null
    /** The proof's contact full name — implicit actor for view rows. */
    contactName: string | null
    /**
     * Last inbound customer reply on the linked Help Scout conversation
     * (proofs.helpscout_last_customer_reply_at, 000208). When set, a single
     * 'customer_email_reply' entry is added — the latest one — mirroring how
     * reply_sent carries only the latest outbound reply per version. Optional
     * so callers that don't surface it (the harness, older tests) still type.
     */
    customerEmailReplyAt?: string | null
  }
  versions: Array<{
    id: string
    version_number: number
    created_at: string
    last_reply_sent_at: string | null
    /** Designer auth ids — resolved to names via designerNamesById. */
    created_by?: string | null
    last_reply_sent_by?: string | null
  }>
  events: TimelineEventRow[]
  /**
   * Sent reminders from the proof_nudges ledger (state='sent' only — the
   * caller filters skips out). Each becomes its own 'reminder_sent' entry,
   * numbered per version. Optional: callers that don't load the ledger
   * (older tests, the preview harness) simply omit it.
   */
  reminders?: TimelineReminderRow[]
  /**
   * Sent unpaid-order payment reminders (order_nudges, state='sent' only).
   * Each becomes its own 'order_reminder_sent' entry. Optional — callers
   * that don't load the order ledger simply omit it.
   */
  orderReminders?: TimelineOrderReminderRow[]
  /** proof_version_id → non-bot view rows (any extra fields ignored). */
  viewsByVersion: ReadonlyMap<string, ReadonlyArray<{ viewed_at: string }>>
  /**
   * auth user id → designer full name, for attributing version-created
   * and reply-sent entries ("Donna Lambe created v2"). Entries whose id
   * is null/missing fall back to the unattributed milestone copy, so
   * the map is optional and may be partial (deleted profiles, versions
   * predating attribution, automated nudge sends).
   */
  designerNamesById?: ReadonlyMap<string, string>
}

// Within-a-second ties happen for real: maybe_finalize_proof_status
// stamps proofs.approved_at with the same transaction now() as the
// approve event's created_at. When timestamps tie, lower rank renders
// nearer the top of the (newest-first) list — i.e. reads as the later
// consequence of the same moment.
const TIE_RANK: Record<TimelineEntryType, number> = {
  proof_abandoned: 0,
  proof_approved: 1,
  designer_override_approve: 2,
  approve: 3,
  request_changes: 3,
  customer_email_reply: 3,
  terms_acknowledged: 4,
  view: 5,
  reply_sent: 6,
  reminder_sent: 6,
  order_reminder_sent: 6,
  version_created: 7,
  project_created: 8,
}

// last_reply_sent_at is stamped inside the same request that logs a
// reminder, so the version stamp and the ledger row land within a second
// or two of each other. A reply the timeline should keep as its own
// "Reply sent" row — a designer's genuine typed reply — happens at an
// unrelated time (the automatic chase only fires at 09:00/15:00), so a
// tight window cleanly tells "the stamp IS this reminder" from "the stamp
// is a separate human reply".
const REMINDER_REPLY_DEDUP_MS = 2 * 60 * 1000

export function buildTimelineEntries(sources: TimelineSources): TimelineEntry[] {
  const { proof, versions, events, reminders, orderReminders, viewsByVersion, designerNamesById } = sources
  const entries: TimelineEntry[] = []
  const designerName = (id: string | null | undefined): string | null =>
    (id && designerNamesById?.get(id)) || null

  // Sent reminders, oldest-first per version, so the ordinal reads
  // "reminder 1 / 2 / 3 for v2" across both manual and automatic sends.
  // Also drives dedup of the version's single last_reply_sent_at stamp
  // below: whichever reminder sent most recently overwrote that stamp, so
  // the generic "Reply sent" entry it would otherwise produce is the SAME
  // outbound touch — suppress it and let the richer reminder entry stand.
  const sentReminders = [...(reminders ?? [])].sort((a, b) =>
    a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0,
  )
  const reminderOrdinal = new Map<string, number>()
  const latestReminderAtByVersion = new Map<string, string>()
  const perVersionCount = new Map<string, number>()
  for (const r of sentReminders) {
    const n = (perVersionCount.get(r.proof_version_id) ?? 0) + 1
    perVersionCount.set(r.proof_version_id, n)
    reminderOrdinal.set(r.id, n)
    latestReminderAtByVersion.set(r.proof_version_id, r.created_at) // sorted asc → last wins
  }

  const milestone = (
    id: string,
    type: TimelineEntryType,
    at: string,
    verb: string,
  ): TimelineEntry => ({
    id,
    type,
    at,
    actor: null,
    verb,
    comment: null,
    recipientName: null,
    failedNotification: false,
  })

  entries.push(milestone('project_created', 'project_created', proof.created_at, 'Project created'))
  if (proof.approved_at) {
    entries.push(milestone('proof_approved', 'proof_approved', proof.approved_at, 'Project approved'))
  }
  if (proof.abandoned_at) {
    entries.push(milestone('proof_abandoned', 'proof_abandoned', proof.abandoned_at, 'Project abandoned'))
  }
  if (proof.disclaimer_acknowledged_at) {
    entries.push({
      ...milestone(
        'terms_acknowledged',
        'terms_acknowledged',
        proof.disclaimer_acknowledged_at,
        'acknowledged the terms',
      ),
      actor: proof.contactName ?? 'Customer',
    })
  }
  // Customer's latest inbound email reply on the Help Scout conversation. Only
  // the latest timestamp is stored (like last_reply_sent_at for our side), so
  // this is one entry; its body is revealed inline on demand by the component,
  // matching the closest customer-authored thread — the mirror of reply_sent.
  if (proof.customerEmailReplyAt) {
    entries.push({
      ...milestone(
        `customer_email_reply:${proof.customerEmailReplyAt}`,
        'customer_email_reply',
        proof.customerEmailReplyAt,
        'replied by email',
      ),
      actor: proof.contactName ?? 'Customer',
    })
  }

  const versionNumberById = new Map<string, number>()
  for (const v of versions) {
    versionNumberById.set(v.id, v.version_number)
    // Designer attribution where a name resolves; the unattributed
    // milestone copy otherwise (versions predating created_by,
    // deleted profiles, automated nudge sends).
    const creator = designerName(v.created_by)
    entries.push({
      ...milestone(`version_created:${v.id}`, 'version_created', v.created_at, `v${v.version_number} created`),
      ...(creator ? { actor: creator, verb: `created v${v.version_number}` } : {}),
    })
    // Only the latest reply per version is stored (last_reply_sent_at is
    // overwritten on re-send). When that latest send was a reminder, the
    // reminder ledger now carries it as its own (richer) entry, so skip the
    // generic "Reply sent" duplicate; otherwise this captures a designer's
    // genuine typed reply. The precise audit trail lives in Help Scout.
    if (v.last_reply_sent_at) {
      const latestReminderAt = latestReminderAtByVersion.get(v.id)
      const isReminderStamp =
        latestReminderAt != null &&
        Math.abs(Date.parse(v.last_reply_sent_at) - Date.parse(latestReminderAt)) <=
          REMINDER_REPLY_DEDUP_MS
      if (!isReminderStamp) {
        const sender = designerName(v.last_reply_sent_by)
        entries.push({
          ...milestone(
            `reply_sent:${v.id}`,
            'reply_sent',
            v.last_reply_sent_at,
            `Reply sent for v${v.version_number}`,
          ),
          ...(sender ? { actor: sender, verb: `sent a reply for v${v.version_number}` } : {}),
        })
      }
    }
  }

  // Reminder entries, one per sent ledger row. Manual chase with a
  // resolved sender → attributed ("Rob sent reminder 1 for v2"); automatic
  // send (or an unresolved manual sender) → the unattributed copy, the
  // automatic case marked "Automatic" so it reads plainly as the bot.
  for (const r of sentReminders) {
    const vn = versionNumberById.get(r.proof_version_id)
    const vLabel = vn != null ? `v${vn}` : 'a version'
    const n = reminderOrdinal.get(r.id) ?? 1
    const sender = r.source === 'manual' ? designerName(r.sent_by) : null
    entries.push({
      id: `reminder:${r.id}`,
      type: 'reminder_sent',
      at: r.created_at,
      actor: sender,
      verb: sender
        ? `sent reminder ${n} for ${vLabel}`
        : `${r.source === 'auto' ? 'Automatic reminder' : 'Reminder'} ${n} sent for ${vLabel}`,
      comment: null,
      recipientName: null,
      failedNotification: false,
    })
  }

  // Unpaid-order payment reminders. Order-level (no version), automatic, and
  // already carrying their own stage number — so "Payment reminder N sent"
  // reads straight off reminder_no. Actor is null (the bot), like the
  // automatic proof reminders, so the verb renders on its own.
  for (const r of orderReminders ?? []) {
    entries.push({
      id: `order-reminder:${r.id}`,
      type: 'order_reminder_sent',
      at: r.created_at,
      actor: null,
      verb: `Payment reminder ${r.reminder_no} sent`,
      comment: null,
      recipientName: null,
      failedNotification: false,
    })
  }

  for (const e of events) {
    const vn = versionNumberById.get(e.proof_version_id)
    const vLabel = vn != null ? `v${vn}` : 'a version'
    let verb: string
    if (e.event_type === 'approve') {
      verb = e.variant_display_name
        ? `chose ‘${e.variant_display_name}’ on ${vLabel}`
        : `signed off ${vLabel}`
    } else if (e.event_type === 'designer_override_approve') {
      verb = `marked ${vLabel} approved`
    } else {
      verb = `requested changes on ${vLabel}`
    }
    entries.push({
      id: `event:${e.id}`,
      type: e.event_type,
      at: e.created_at,
      actor: e.actor_name,
      verb,
      comment: e.comment?.trim() ? e.comment : null,
      recipientName: e.name,
      failedNotification:
        e.event_type !== 'designer_override_approve' && e.helpscout_thread_id == null,
    })
  }

  // Views, deduped to the first view per (version, local day) — same
  // rationale as dashboard_latest_events: a customer refreshing ten
  // times in five minutes is one timeline entry; coming back the next
  // day is a fresh one.
  for (const [versionId, views] of viewsByVersion) {
    const vn = versionNumberById.get(versionId)
    const vLabel = vn != null ? `v${vn}` : 'the proof'
    const earliestByDay = new Map<string, string>()
    for (const view of views) {
      const day = new Date(view.viewed_at).toDateString()
      const existing = earliestByDay.get(day)
      if (!existing || view.viewed_at < existing) {
        earliestByDay.set(day, view.viewed_at)
      }
    }
    for (const viewedAt of earliestByDay.values()) {
      entries.push({
        id: `view:${versionId}:${viewedAt}`,
        type: 'view',
        at: viewedAt,
        actor: proof.contactName ?? 'Customer',
        verb: `opened ${vLabel}`,
        comment: null,
        recipientName: null,
        failedNotification: false,
      })
    }
  }

  // Newest first; same-instant rows order by TIE_RANK so e.g. the
  // "Project approved" milestone sits above the approve event that
  // triggered it.
  entries.sort((a, b) => {
    if (a.at !== b.at) return a.at < b.at ? 1 : -1
    return TIE_RANK[a.type] - TIE_RANK[b.type]
  })
  return entries
}
