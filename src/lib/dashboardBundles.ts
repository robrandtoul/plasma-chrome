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
// Two treatments:
//
//   A. Bundle block — every card of a bundle that's in the visible list is
//      gathered into ONE container, hoisted into the section of the bundle's
//      most recently active card (hoistBundleSections below). Originally the
//      block only formed when 2+ cards happened to share a section, so a fresh
//      send split off into Today while its siblings sat grouped in Older.
//      Rob's call (2026-07-28) is that the bundle always travels together: the
//      per-row status pills already say which card is new / viewed / responded
//      to, so one block with mixed pills is clearer than a scattered bundle.
//      The container shape matches the Orders page's combined payment
//      (OrdersPage.tsx, "the group header is the container, not a sibling
//      banner"), so staff learn the pattern once.
//   B. Chip — a card whose siblings aren't in the visible list at all (tile
//      filter, search, or outside the dashboard working set), or a card
//      sitting in the Pinned / Snoozed special sections away from its
//      siblings, keeps its place in the sort and carries a "Part of a bundle
//      of N" line instead. Those sections state a fact about the card ("you
//      pinned this", "you snoozed this") that its siblings don't share, so
//      they are never pulled in to force adjacency.
//
// Deliberately NOT joined into public_dashboard_projects. Membership is fetched
// as a small standalone query and merged client-side, exactly like proof_pins
// (000155) — no migration, and bundle churn doesn't force a dashboard refetch.

import type { DashboardProject, ProjectSection } from './dashboardGrouping'
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

/**
 * Gather each bundle's cards into ONE section, so the whole bundle renders as
 * a single block wherever its most recently active card sits.
 *
 * Sections arrive in render order (Today → This week → Older, or companies
 * A→Z), each already sorted, so the first section holding any member is the
 * bundle's freshest — members from later sections move up into it, appended
 * after the rows already there. The anchor card keeps its sort position (the
 * block anchors at the topmost member, see buildRowItems), the hoisted cards
 * stay in their relative order, and rows outside the bundle never move. A
 * section emptied by hoisting is dropped rather than rendered as a bare
 * heading.
 *
 * Only the tail sections are passed in — Pinned / Team / Snoozed are built
 * separately and deliberately keep the chip treatment (see the header note).
 * Under company grouping a bundle's cards always share a section (one bundle
 * = one contact), so this is a no-op there.
 */
export function hoistBundleSections(
  sections: ProjectSection[],
  index: BundleIndex,
): ProjectSection[] {
  if (index.byProof.size === 0) return sections

  // Where does each bundle anchor? The first section (in render order) that
  // holds any of its cards.
  const anchorFor = new Map<string, string>()
  for (const s of sections) {
    for (const p of s.projects) {
      const info = index.byProof.get(p.proof_id)
      if (info && !anchorFor.has(info.setId)) anchorFor.set(info.setId, s.key)
    }
  }

  // Split each section into the rows it keeps and the members leaving for an
  // earlier section. Iterating sections in order means arrivals accumulate in
  // global sort order.
  const arrivals = new Map<string, DashboardProject[]>()
  const kept = sections.map((s) => {
    const keep: DashboardProject[] = []
    for (const p of s.projects) {
      const info = index.byProof.get(p.proof_id)
      const anchor = info ? anchorFor.get(info.setId) : undefined
      if (anchor && anchor !== s.key) {
        const list = arrivals.get(anchor)
        if (list) list.push(p)
        else arrivals.set(anchor, [p])
      } else {
        keep.push(p)
      }
    }
    return { section: s, keep }
  })

  const out: ProjectSection[] = []
  for (const { section, keep } of kept) {
    const incoming = arrivals.get(section.key)
    // Untouched section → keep the original object (stable identity for React).
    if (!incoming && keep.length === section.projects.length) {
      out.push(section)
      continue
    }
    const projects = incoming ? [...keep, ...incoming] : keep
    if (projects.length === 0) continue
    out.push({ ...section, projects })
  }
  return out
}
