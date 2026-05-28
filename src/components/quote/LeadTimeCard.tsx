import type { LeadTimeState } from '../../lib/quote/leadTime'

// Top-of-results lead-time card. Sits alongside the Total card so
// the two read as siblings — same chrome, same dominant headline
// weight. Three states drive the render:
//
//   * standard — neutral card. The recorded min-max window goes
//     in the same 6xl slot HeadlinePrice uses for the price.
//   * custom   — amber accent (matching the existing "No prices
//     available" defensive panel). Same outer dimensions, smaller
//     headline because the message is wordy, but still loud.
//   * not_set  — returns null. The 2-col grid slot is left empty
//     deliberately so the layout doesn't fake a value the admin
//     has not recorded.
//
// The custom state is the safety nudge for unusual orders. The
// brief is explicit: the card must not collapse or shrink when
// it fires, because that defeats the prompt.

interface LeadTimeCardProps {
  state: LeadTimeState
  materialDisplayName: string
}

export function LeadTimeCard({ state, materialDisplayName }: LeadTimeCardProps) {
  if (state.kind === 'not_set') return null

  if (state.kind === 'custom') {
    return (
      <div
        role="status"
        className="rounded-2xl bg-low-soft p-8 shadow-sm ring-1 ring-low"
      >
        <p className="text-xs font-semibold uppercase tracking-widest text-low">
          Lead time
        </p>
        <p className="mt-2 text-3xl font-bold leading-tight tracking-tight text-low">
          Custom quote
        </p>
        <p className="mt-3 text-sm text-low">
          Confirm lead time with Production before quoting.
        </p>
      </div>
    )
  }

  const lowered = materialDisplayName.toLowerCase()
  const range =
    state.minDays === state.maxDays
      ? `${state.minDays}`
      : `${state.minDays}-${state.maxDays}`

  return (
    <div
      role="status"
      className="rounded-2xl bg-surface p-8 shadow-sm ring-1 ring-line"
    >
      <p className="text-xs font-semibold uppercase tracking-widest text-ink-dim">
        Lead time
      </p>
      <div className="mt-2 flex flex-wrap items-baseline gap-x-4">
        <span className="text-6xl font-bold tracking-tight tabular-nums leading-none text-ink">
          {range}
        </span>
      </div>
      <p className="mt-3 text-sm text-ink-mute">
        business days for {lowered}
      </p>
    </div>
  )
}
