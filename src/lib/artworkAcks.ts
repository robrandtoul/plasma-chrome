// Advisory acknowledgements, frontend twin — the per-item "Mark as addressed"
// tick on a proof/artwork check report. The key derivation here MUST match
// supabase/functions/_shared/artworkCheck/acks.ts byte for byte (the server
// writes acks keyed this way; the UI matches them back to items by the same
// key) — pnpm test:artwork-acks imports both twins and fails on drift.
//
// The frontend-only half of the module is the display derivation: progress
// counts and the display verdict. The rule that shapes both: a human-cleared
// report goes green as "all addressed", NEVER as the machine's "all clear" —
// unverified must never look verified (the house rule from the reference-gaps
// panel), and by the same token human-verified must never look machine-
// verified. The stored `verdict` is untouched by ticks; everything here is
// derived at render time.

export type AckReason = 'fixed' | 'intentional' | 'incorrect'
export const ACK_REASONS: readonly AckReason[] = ['fixed', 'intentional', 'incorrect']

// Reason copy, shared by the picker buttons and the addressed line. 'fixed'
// is the one that implies the artwork changed — pickers pair it with a
// re-run nudge, because the honest close-out of a fix is the machine
// confirming it (the stored report describes the OLD pixels).
export const ACK_REASON_LABELS: Record<AckReason, string> = {
  fixed: 'Fixed in the artwork',
  intentional: 'Intentional — confirmed correct',
  incorrect: 'The check misread it',
}

export interface AckEntry {
  reason: AckReason
  by: string
  by_id: string
  at: string
}

export type AckTarget =
  | { kind: 'finding'; card: string; field: string; printed: string }
  | { kind: 'correction'; quote: string }

export function ackKey(target: AckTarget): string {
  return target.kind === 'correction'
    ? `c:${target.quote}`
    : `f:${target.card}::${target.field}::${target.printed}`
}

// The report slice the derivations need — structurally satisfied by the
// component's ArtworkCheckReport.
export interface AckableReport {
  verdict: string
  cards: { label: string; findings: { field: string; status: string; printed: string; severity?: string }[] }[]
  corrections: { quote: string; resolved: boolean; severity?: string }[]
  acknowledgements?: Record<string, AckEntry>
}

export interface AckProgress {
  // Every advisory on the report: 'flag' findings + unresolved corrections —
  // the same set artworkFlagCount counts for the ⚠️ headline.
  total: number
  addressed: number
  open: number
  // Defect-grade items still open — the ❌ icon tracks what's LEFT, so a
  // report whose only defect is ticked drops to ⚠️ while any advisory remains.
  openDefects: number
}

// Counted item-by-item against the report, never by map size: an ack entry
// whose key matches nothing (impossible via the server path, but jsonb is
// jsonb) must not inflate the addressed figure.
export function ackProgress(report: AckableReport): AckProgress {
  const acks = report.acknowledgements ?? {}
  let total = 0
  let addressed = 0
  let openDefects = 0
  for (const card of report.cards) {
    for (const f of card.findings) {
      if (f.status !== 'flag') continue
      total += 1
      if (acks[ackKey({ kind: 'finding', card: card.label, field: f.field, printed: f.printed })]) addressed += 1
      else if (f.severity === 'defect') openDefects += 1
    }
  }
  for (const c of report.corrections) {
    if (c.resolved) continue
    total += 1
    if (acks[ackKey({ kind: 'correction', quote: c.quote })]) addressed += 1
    else if (c.severity === 'defect') openDefects += 1
  }
  return { total, addressed, open: total - addressed, openDefects }
}

// The state a surface should PRESENT, distinct from the stored verdict:
// 'addressed' is a flagged/defect report whose every advisory carries a tick.
// Wrapper tints treat it like the green states; the headline wording keeps
// the two greens apart.
export type ArtworkDisplayVerdict = 'clear' | 'flagged' | 'defect' | 'error' | 'addressed'

export function artworkDisplayVerdict(report: AckableReport): ArtworkDisplayVerdict {
  if (report.verdict === 'clear' || report.verdict === 'error') return report.verdict
  const prog = ackProgress(report)
  if (prog.total > 0 && prog.open === 0) return 'addressed'
  // Severity of what's LEFT: a report whose defects are all ticked reads
  // amber, not red, while review-tier advisories remain.
  if (prog.addressed > 0) return prog.openDefects > 0 ? 'defect' : 'flagged'
  return report.verdict === 'defect' ? 'defect' : 'flagged'
}

// Does any tick say "fixed in the artwork"? Those change the pixels the
// stored report was measured against, so the surfaces offer a re-run nudge.
export function hasFixedAcks(report: AckableReport): boolean {
  const acks = report.acknowledgements ?? {}
  const keys = new Set<string>()
  for (const card of report.cards) {
    for (const f of card.findings) {
      if (f.status === 'flag') keys.add(ackKey({ kind: 'finding', card: card.label, field: f.field, printed: f.printed }))
    }
  }
  for (const c of report.corrections) {
    if (!c.resolved) keys.add(ackKey({ kind: 'correction', quote: c.quote }))
  }
  return Object.entries(acks).some(([k, a]) => keys.has(k) && a.reason === 'fixed')
}
