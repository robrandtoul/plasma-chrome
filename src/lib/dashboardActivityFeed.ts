import type { DashboardLatestEvent, DashboardProject } from './dashboardGrouping'

// The Latest-activity card shows the newest 20 things that happened, merged
// across a dozen sources. Both the polled rebuild in DashboardPage and the live
// path below trim to this same number, so a row arriving live can never push
// the feed past the length the next poll would produce.
export const ACTIVITY_FEED_CAP = 20

// A realtime-delivered `proofs.proof_version_views` row — only the columns the
// feed needs, not the whole table.
export interface LiveViewRow {
  id: string
  proof_version_id: string
  viewed_at: string
  is_bot: boolean
}

export interface LiveViewResult {
  events: DashboardLatestEvent[]
  // True when the row is real but can't be rendered from what's already loaded,
  // so only a refetch can show it. See the enrichment note in applyLiveView.
  needsRefresh: boolean
}

/**
 * The day a view belongs to, matching dashboard_latest_events' own dedup:
 * `distinct on (proof_version_id, date_trunc('day', viewed_at))`.
 *
 * UTC days, deliberately. The live database runs its session at UTC (checked
 * 2026-08-08), so `date_trunc` cuts UTC days and this has to cut the same ones.
 * A London-day key would disagree with the view for an hour either side of
 * midnight right through BST — long enough to put two rows on screen for one
 * customer until the next poll quietly replaced them with one.
 */
export function viewDayKey(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10)
}

// Newest first, the order the card reads in and the same comparator the polled
// rebuild uses.
function byNewest(a: DashboardLatestEvent, b: DashboardLatestEvent): number {
  return b.created_at.localeCompare(a.created_at)
}

/**
 * Fold one realtime page-view into the feed.
 *
 * Realtime carries page views because they're the highest-volume source, the
 * most time-sensitive ("they're reading it right now"), and the only one
 * already in the `supabase_realtime` publication. Everything else in the feed
 * is polled — see the note above the poll in DashboardPage.
 *
 * Pure, and returns the ORIGINAL array whenever nothing on screen changes, so a
 * discarded row costs no re-render.
 */
export function applyLiveView(
  events: DashboardLatestEvent[],
  row: LiveViewRow,
  projects: DashboardProject[],
): LiveViewResult {
  const unchanged: LiveViewResult = { events, needsRefresh: false }

  // Bots never reach the feed: the view filters them server-side with
  // `where is_bot = false`, so letting one through here would put a row on the
  // card that the next poll silently took away again.
  if (row.is_bot) return unchanged
  if (!row.proof_version_id || !row.viewed_at) return unchanged

  const day = viewDayKey(row.viewed_at)
  const existingIndex = events.findIndex(
    (e) =>
      e.event_type === 'view' &&
      e.proof_version_id === row.proof_version_id &&
      viewDayKey(e.created_at) === day,
  )

  if (existingIndex !== -1) {
    const existing = events[existingIndex]
    // One row per version per day, holding the LATEST view of that day (000242)
    // — so a customer refreshing five times moves the row's clock rather than
    // printing five identical lines. A delivery that arrives out of order and
    // is older than what we hold simply isn't the latest, so it changes nothing.
    if (row.viewed_at <= existing.created_at) return unchanged
    const next = [...events]
    next[existingIndex] = { ...existing, id: row.id, created_at: row.viewed_at }
    next.sort(byNewest)
    return { events: next, needsRefresh: false }
  }

  // A row we have no line for yet has to be enriched. Realtime delivers the
  // bare proof_version_views row, while a feed row carries the company, contact
  // and version number that dashboard_latest_events gets from its joins — and
  // the loaded projects can only answer for a proof's CURRENT version. So a
  // view of a superseded version, or of a proof outside the loaded working set,
  // asks for a refetch rather than being dropped or guessed at.
  //
  // That's self-limiting: once the poll brings the row in, every later view of
  // it matches the branch above and needs no lookup at all.
  const project = projects.find((p) => p.current_version_id === row.proof_version_id)
  if (!project) return { events, needsRefresh: true }

  const next: DashboardLatestEvent[] = [
    ...events,
    {
      id: row.id,
      created_at: row.viewed_at,
      event_type: 'view',
      // The view reads the contact's name here and falls back to 'Customer' —
      // a proof with no contact on it still had somebody open it.
      actor_name: project.contact_name ?? 'Customer',
      recipient_name: null,
      helpscout_thread_id: null,
      proof_version_id: row.proof_version_id,
      proof_id: project.proof_id,
      version_number: project.current_version_number ?? 0,
      contact_name: project.contact_name,
      company_name: project.company_name,
    },
  ]
  next.sort(byNewest)
  const capped = next.slice(0, ACTIVITY_FEED_CAP)
  // The row sorted straight off the end of a full feed. Nothing on screen
  // changed, so don't hand React a new array for it.
  if (!capped.some((e) => e.id === row.id)) return unchanged
  return { events: capped, needsRefresh: false }
}
