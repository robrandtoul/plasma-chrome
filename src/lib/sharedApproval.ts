// Derives the implicit "Shared" approval state for a proof version.
// The Shared section/back has no own approval row in the split-name
// case — when every named recipient on a version has approved, the
// Shared section is approved-by-implication. This helper formalises
// the rule so the dashboard names rollup and the customer page's
// shared info band compute identically.
//
// Each surface supplies its own timestamp source:
//   * dashboard → proof_name_approvals.updated_at (matches how named
//     rollup rows are dated)
//   * customer  → latest_events_by_name.created_at (the moment
//     approval crossed the line, not later edits)
//
// Edge cases:
//   * names = [] → 'pending'. The all-shared one-off project (no
//     names) is handled at the call site, not here — that path keeps
//     its own Approve button and writes the approved_* columns
//     directly on the __shared__ row.
//   * any name missing from approvedNames → 'pending'.
//   * timestampByName may be partial (e.g. carry-forward approvals
//     have no co-located event on this version); missing names
//     contribute nothing to the aggregate but still satisfy the
//     predicate via approvedNames.

export interface DeriveSharedApprovalInput {
  names: string[]
  approvedNames: Set<string>
  timestampByName: Map<string, string>
}

export interface SharedApprovalState {
  state: 'approved' | 'pending'
  latestApprovedAt: string | null
}

export function deriveSharedApprovalState(
  input: DeriveSharedApprovalInput,
): SharedApprovalState {
  if (input.names.length === 0) {
    return { state: 'pending', latestApprovedAt: null }
  }
  for (const name of input.names) {
    if (!input.approvedNames.has(name)) {
      return { state: 'pending', latestApprovedAt: null }
    }
  }
  let latestMs = -Infinity
  let latestIso: string | null = null
  for (const name of input.names) {
    const ts = input.timestampByName.get(name)
    if (!ts) continue
    const ms = new Date(ts).getTime()
    if (Number.isFinite(ms) && ms > latestMs) {
      latestMs = ms
      latestIso = ts
    }
  }
  return { state: 'approved', latestApprovedAt: latestIso }
}
