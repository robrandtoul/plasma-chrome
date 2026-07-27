// Dashboard bundle stitching — making it visible that two or more projects in
// the list are ONE bundle (proofs.proof_sets, migration 000311).
//
// The problem this solves: a bundle is N separate proofs, so the dashboard
// renders N independent-looking rows. Sorted by activity they often aren't even
// adjacent, and nothing on the row says the cards are related — you had to open
// one to find out. That's actively misleading now that a bundle is CHASED as one
// (000317: the whole bundle gets one reminder on one thread with one link), so
// two rows each showing their own follow-up state describe a chase that doesn't
// exist.
//
// Two treatments, and which one applies is decided per SECTION:
//
//   A. Bundle block — when 2+ of a bundle's cards are in the same section, they
//      are pulled adjacent and wrapped in one container, so the grouping reads
//      as containment. Same shape the Orders page uses for a combined payment
//      (OrdersPage.tsx, "the group header is the container, not a sibling
//      banner"), so staff learn the pattern once.
//   B. Chip — a card whose siblings aren't in the same section keeps its place
//      in the sort and carries a "Bundle of N" chip instead. Rows are never
//      teleported into another day bucket to force adjacency: silently filing a
//      card under the wrong day would be worse than the problem being fixed.
//
// Deliberately NOT joined into public_dashboard_projects. Membership is fetched
// as a small standalone query and merged client-side, exactly like proof_pins
// (000155) — no migration, and bundle churn doesn't force a dashboard refetch.

import type { DashboardProject } from './dashboardGrouping'
import type { ProofStatus } from './types'

/**
 * One member proof, straight from the `proofs` table. Deliberately a handful of
 * narrow columns: the whole membership table is fetched unfiltered, so the row
 * shape is the only thing keeping it cheap. (35 member rows across 16 sets on
 * live at time of writing — nowhere near PostgREST's 1000-row default cap, but
 * worth knowing that cap is what would silently break the counts if bundles
 * ever became a mass-market feature.)
 */
export interface BundleMemberRow {
  id: string
  proof_set_id: string | null
  set_discarded_at: string | null
  status: ProofStatus
}

/** The set row itself — the shared context and the customer's one review link. */
export interface BundleSetRow {
  id: string
  token: string
  sent_at: string | null
  last_opened_at: string | null
}

export interface BundleInfo {
  setId: string
  token: string
  sentAt: string | null
  lastOpenedAt: string | null
  /** Live cards only: set-aside and abandoned members are excluded. */
  memberIds: string[]
  /** memberIds.length — the "of N" every label counts against. */
  size: number
  /** How many live cards are approved. Counted across the WHOLE bundle, not
   *  just what's on screen, so "1 of 3 approved" stays true when a sibling is
   *  filtered out of the list. */
  approvedCount: number
}

export interface BundleIndex {
  /** proof_id → its bundle. Only cards in a bundle of 2+ live cards appear. */
  byProof: Map<string, BundleInfo>
}

export const EMPTY_BUNDLE_INDEX: BundleIndex = { byProof: new Map() }

/**
 * Fold the two membership queries into a lookup keyed by proof id.
 *
 * Three exclusions, all of which showed up in live data:
 *   * set-aside cards (`set_discarded_at`) — the customer decided against it;
 *   * abandoned cards — the designer dropped it (10 of 35 live members);
 *   * bundles left with fewer than 2 live cards — one card is not a bundle, and
 *     a "Bundle of 1" chip is noise. Live has three sets whose members are all
 *     abandoned and two down to a single card; none of them should render.
 */
export function buildBundleIndex(
  members: BundleMemberRow[],
  sets: BundleSetRow[],
): BundleIndex {
  const setById = new Map(sets.map((s) => [s.id, s]))
  const grouped = new Map<string, BundleMemberRow[]>()

  for (const m of members) {
    if (!m.proof_set_id) continue
    if (m.set_discarded_at) continue
    if (m.status === 'abandoned') continue
    const rows = grouped.get(m.proof_set_id)
    if (rows) rows.push(m)
    else grouped.set(m.proof_set_id, [m])
  }

  const byProof = new Map<string, BundleInfo>()
  for (const [setId, rows] of grouped) {
    if (rows.length < 2) continue
    const set = setById.get(setId)
    // A member pointing at a set row we didn't get back (deleted mid-flight, or
    // a read that failed) can't offer a working review link, so it stays a
    // plain row rather than rendering a bundle we can't open.
    if (!set) continue
    const info: BundleInfo = {
      setId,
      token: set.token,
      sentAt: set.sent_at,
      lastOpenedAt: set.last_opened_at,
      memberIds: rows.map((r) => r.id),
      size: rows.length,
      approvedCount: rows.filter((r) => r.status === 'approved').length,
    }
    for (const r of rows) byProof.set(r.id, info)
  }

  return { byProof }
}

/**
 * What the customer has actually seen. `unsent` is the genuinely useful one —
 * a bundle still being built, which the dashboard has no other signal for.
 *
 * Note it says "the bundle LINK hasn't gone out", not "nothing has been sent":
 * a set can hold cards that were each sent standalone before being attached
 * (the 000317 unsent-bundle case — live has one sitting fully approved).
 */
export type BundleSentState = 'unsent' | 'sent_unopened' | 'opened'

export function bundleSentState(info: Pick<BundleInfo, 'sentAt' | 'lastOpenedAt'>): BundleSentState {
  if (!info.sentAt) return 'unsent'
  return info.lastOpenedAt ? 'opened' : 'sent_unopened'
}

/** A row in a rendered section: either a lone project, or a bundle wrapping 2+. */
export type DashboardRowItem =
  | { kind: 'project'; key: string; project: DashboardProject }
  | { kind: 'bundle'; key: string; bundle: BundleInfo; projects: DashboardProject[] }

/**
 * Turn one section's project list into the items to render, pulling bundle
 * siblings together where they're both present.
 *
 * The block anchors at the position of its TOPMOST member, and everything else
 * keeps its place — so the section still reads in the order the sort produced,
 * with the siblings gathered rather than the list resequenced. A bundle whose
 * other cards aren't in this section produces no block; the caller renders the
 * chip for those (see bundleShownHere).
 */
export function buildRowItems(
  projects: DashboardProject[],
  index: BundleIndex,
): DashboardRowItem[] {
  if (index.byProof.size === 0) {
    return projects.map((project) => ({ kind: 'project', key: project.proof_id, project }))
  }

  // How many of each bundle's cards are in THIS list. Two passes rather than
  // one, because whether the first member opens a block depends on whether a
  // later one exists.
  const membersHere = new Map<string, DashboardProject[]>()
  for (const p of projects) {
    const info = index.byProof.get(p.proof_id)
    if (!info) continue
    const list = membersHere.get(info.setId)
    if (list) list.push(p)
    else membersHere.set(info.setId, [p])
  }

  const emitted = new Set<string>()
  const items: DashboardRowItem[] = []
  for (const project of projects) {
    const info = index.byProof.get(project.proof_id)
    const siblings = info ? membersHere.get(info.setId) : undefined
    if (!info || !siblings || siblings.length < 2) {
      items.push({ kind: 'project', key: project.proof_id, project })
      continue
    }
    if (emitted.has(info.setId)) continue
    emitted.add(info.setId)
    items.push({ kind: 'bundle', key: `bundle:${info.setId}`, bundle: info, projects: siblings })
  }
  return items
}

/**
 * How many of a bundle's cards are present in a given list. Drives the block
 * header's "1 card shown elsewhere" note — the block nests what's in this
 * section, but the headline count is always the true bundle size.
 */
export function bundleShownHere(projects: DashboardProject[], info: BundleInfo): number {
  return projects.reduce((n, p) => (info.memberIds.includes(p.proof_id) ? n + 1 : n), 0)
}
