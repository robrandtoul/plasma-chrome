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

export interface TimelineSources {
  proof: {
    created_at: string
    approved_at: string | null
    abandoned_at: string | null
    disclaimer_acknowledged_at: string | null
    /** The proof's contact full name — implicit actor for view rows. */
    contactName: string | null
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
  terms_acknowledged: 4,
  view: 5,
  reply_sent: 6,
  version_created: 7,
  project_created: 8,
}

export function buildTimelineEntries(sources: TimelineSources): TimelineEntry[] {
  const { proof, versions, events, viewsByVersion, designerNamesById } = sources
  const entries: TimelineEntry[] = []
  const designerName = (id: string | null | undefined): string | null =>
    (id && designerNamesById?.get(id)) || null

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
    // Only the latest reply per version is stored (last_reply_sent_at
    // is overwritten on re-send), so a "Send again" replaces the
    // earlier entry rather than stacking — acceptable for a history
    // view; the precise audit trail lives in Help Scout.
    if (v.last_reply_sent_at) {
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
