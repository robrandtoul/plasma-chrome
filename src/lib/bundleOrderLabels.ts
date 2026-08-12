// How the designer surfaces WORD a bundle's state at order time.
//
// The structural rule — which siblings count — lives in bundleOrderGuard.ts and
// is shared with the edge function. This file is the client half: naming the
// outstanding cards and saying why they're outstanding, so the Orders worklist,
// the order builder and the proof page all phrase it the same way. One place,
// because three surfaces describing the same bundle in three different terms is
// how a warning stops being believed.
//
// "Why" matters as much as "how many". In the 12 August case the sibling had
// requested changes 3 seconds earlier — a very different thing from a card
// nobody has looked at yet, and the difference is what decides whether you hold
// the link or send it.

import { isChangesRequested } from './dashboardGrouping'
import { bundleOrderState, bundleProgressLabel, type BundleOrderState } from './bundleOrderGuard'

/** The columns of `public_dashboard_projects` needed to describe a sibling.
 *  Six, fetched only for the handful of cards actually being described. */
export interface SiblingRow {
  proof_id: string
  status: string
  material_display: string | null
  has_open_change_request: boolean
  latest_non_view_event_type: 'approve' | 'request_changes' | 'designer_override_approve' | null
  latest_non_view_event_at: string | null
  version_created_at: string | null
}

/** Everything a surface needs to say its piece about one card's bundle.
 *  Null everywhere the project is an ordinary standalone one, which is most. */
export interface BundleHint {
  setId: string
  /** "1 of 2 approved". */
  progress: string
  /** Empty when the whole bundle is signed off — the combine-payments moment. */
  outstanding: OutstandingLine[]
}

export interface OutstandingLine {
  id: string
  /** "Letterpress" — the card's material, which is how a bundle's cards are
   *  told apart in conversation. Falls back when a version carries no material
   *  (a per-direction Selection stores none, 000142/000144). */
  name: string
  /** Lower-case fragment that completes "<name> — <reason>". */
  reason: string
}

/**
 * One line per outstanding sibling, in the order the guard returned them.
 *
 * A sibling we couldn't fetch detail for still gets a line — an unnamed card is
 * far better than a silently shortened list, which would under-report the very
 * thing being warned about.
 */
export function describeOutstanding(
  state: BundleOrderState,
  siblings: SiblingRow[],
): OutstandingLine[] {
  const byId = new Map(siblings.map((s) => [s.proof_id, s]))
  return state.outstanding.map(({ id }) => {
    const row = byId.get(id)
    return {
      id,
      name: row?.material_display?.trim() || 'Another card',
      reason: outstandingReason(row),
    }
  })
}

// Reuses the dashboard's own change-request rule rather than re-testing the
// event type here, so a card reading "Changes requested" on the dashboard can
// never read "not approved yet" on the Orders page.
function outstandingReason(row: SiblingRow | undefined): string {
  if (!row) return 'not approved yet'
  if (isChangesRequested(row)) return 'changes requested'
  if (row.status === 'dormant') return 'gone quiet'
  return 'not approved yet'
}

/** Guard + labels in one step, for the callers that hold both halves already. */
export function buildBundleHint(
  proofId: string,
  members: Parameters<typeof bundleOrderState>[1],
  siblings: SiblingRow[],
): BundleHint | null {
  const state = bundleOrderState(proofId, members)
  if (!state) return null
  return {
    setId: state.setId,
    progress: bundleProgressLabel(state),
    outstanding: describeOutstanding(state, siblings),
  }
}

/** "Letterpress — changes requested" / "Letterpress and 2 others aren't approved
 *  yet" — the one-line form for a card that has no room for a list. */
export function outstandingSummary(lines: OutstandingLine[]): string {
  if (lines.length === 0) return ''
  if (lines.length === 1) return `${lines[0].name} — ${lines[0].reason}`
  const rest = lines.length - 1
  return `${lines[0].name} and ${rest} other card${rest === 1 ? '' : 's'} not approved yet`
}
