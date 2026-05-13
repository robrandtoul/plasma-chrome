// Lead-time helpers shared by the Quote compiler panel and the
// copy-paste formatter. Migration 000175 stores a min/max pair in
// business days on each material; this module turns that pair (plus
// the compiler's "custom quote" signal) into the three states the
// UI cares about and the matching customer-facing sentence.

export type LeadTimeState =
  | { kind: 'standard'; minDays: number; maxDays: number }
  | { kind: 'custom' }
  | { kind: 'not_set' }

export interface LeadTimePair {
  lead_time_min_days: number | null
  lead_time_max_days: number | null
}

// Resolve a material's stored pair plus the compiler's custom-quote
// signal to one of three states. The custom signal wins over a
// stored lead time, because a custom-quote scenario means the
// production team has to confirm a real lead time per request.
export function resolveLeadTimeState(
  material: LeadTimePair,
  customQuote: boolean,
): LeadTimeState {
  if (customQuote) return { kind: 'custom' }
  const min = material.lead_time_min_days
  const max = material.lead_time_max_days
  if (min == null || max == null) return { kind: 'not_set' }
  return { kind: 'standard', minDays: min, maxDays: max }
}

// Customer-facing sentence for the copy-paste quote body. Returns
// null when the line should be omitted silently (in-range with no
// recorded lead time — per the brief).
export function leadTimeQuoteLine(
  state: LeadTimeState,
  materialDisplayName: string,
): string | null {
  const lowered = materialDisplayName.toLowerCase()
  if (state.kind === 'standard') {
    const range =
      state.minDays === state.maxDays
        ? `${state.minDays} business days`
        : `${state.minDays}-${state.maxDays} business days`
    return `We are currently quoting ${range} for ${lowered}.`
  }
  if (state.kind === 'custom') {
    return `Lead time to be confirmed for ${lowered}, please ask.`
  }
  return null
}
