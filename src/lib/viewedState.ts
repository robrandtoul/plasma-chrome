// Three-state viewed classifier for designer-facing UI. Takes a
// project's current version id and the set of version ids that
// have at least one real (is_bot = false) view, returns:
//
//   'unviewed'       — no version has any real view
//   'viewed_stale'   — some prior version was viewed, but not the
//                      current one (customer saw an earlier proof;
//                      designer has added a newer version since)
//   'viewed_current' — the current version has a real view
//
// currentVersionId is nullable: projects with no versions (or a
// state the dashboard doesn't expect) fall through as 'unviewed'.

export type ViewedState = 'unviewed' | 'viewed_stale' | 'viewed_current'

export function computeViewedState({
  currentVersionId,
  viewedVersionIds,
}: {
  currentVersionId: string | null
  viewedVersionIds: Set<string>
}): ViewedState {
  if (viewedVersionIds.size === 0) return 'unviewed'
  if (currentVersionId && viewedVersionIds.has(currentVersionId)) return 'viewed_current'
  return 'viewed_stale'
}

// Small presentation helpers kept alongside so both the dashboard
// and the proof detail page use exactly the same colour + title
// palette. Viewed-current was emerald-500 originally, swapped to
// cyan-500 once the Names roll-up adopted green for approval state,
// then swapped to sky-500 because cyan and emerald were too easy to
// confuse at dot size. Green is reserved for approval; sky for
// "customer viewed the current version".
// Palette: zinc-300 / amber-500 / sky-500.

export function viewedStateDotClass(state: ViewedState): string {
  switch (state) {
    case 'unviewed':       return 'bg-zinc-300'
    case 'viewed_stale':   return 'bg-amber-500'
    case 'viewed_current': return 'bg-sky-500'
  }
}

export function viewedStateTitle(state: ViewedState): string {
  switch (state) {
    case 'unviewed':       return 'Not viewed'
    case 'viewed_stale':   return 'Viewed earlier version only'
    case 'viewed_current': return 'Viewed current version'
  }
}
