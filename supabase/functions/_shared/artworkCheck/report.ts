// Report assembly — verdict derivation is CODE, not model output, so the
// clear/flagged line is deterministic and testable: a report is flagged iff it
// carries at least one 'flag' finding or an unresolved correction. 'error' is
// only ever set by the function itself (run couldn't complete).

import type {
  ArtworkCheckReport,
  CheckSummary,
  ModelReport,
  ReportInputs,
  ReportUsage,
} from './types.ts'

export function deriveVerdict(report: ModelReport): 'clear' | 'flagged' | 'defect' {
  const hasDefect =
    report.cards.some((c) => c.findings.some((f) => f.status === 'flag' && f.severity === 'defect')) ||
    report.corrections.some((c) => !c.resolved && c.severity === 'defect')
  if (hasDefect) return 'defect'
  const hasFlag = report.cards.some((c) => c.findings.some((f) => f.status === 'flag'))
  const hasUnresolvedCorrection = report.corrections.some((c) => !c.resolved)
  return hasFlag || hasUnresolvedCorrection ? 'flagged' : 'clear'
}

// The red count for the ❌ headline — defect-grade flags + defect-grade
// unresolved corrections. Pre-tier reports (no severity anywhere) count 0.
export function countDefects(report: ModelReport): number {
  return (
    report.cards.reduce(
      (sum, c) => sum + c.findings.filter((f) => f.status === 'flag' && f.severity === 'defect').length,
      0,
    ) + report.corrections.filter((c) => !c.resolved && c.severity === 'defect').length
  )
}

// Count helpers for the UI headline ("N things to check").
export function countFlags(report: ModelReport): number {
  const findingFlags = report.cards.reduce(
    (sum, c) => sum + c.findings.filter((f) => f.status === 'flag').length,
    0,
  )
  const unresolved = report.corrections.filter((c) => !c.resolved).length
  return findingFlags + unresolved
}

export function countCheckedFields(report: ModelReport): number {
  return report.cards.reduce((sum, c) => sum + c.findings.length, 0)
}

export function buildReport(
  model: string,
  modelReport: ModelReport,
  inputs: ReportInputs,
  usage: ReportUsage | null,
  now: Date = new Date(),
  // The deterministic checks this run performed, pass or fail (see
  // CheckSummary). Trailing and defaulted so every existing caller is
  // unchanged; omitted means the report simply says nothing about them, which
  // is what a report from before this shipped honestly does.
  checks: CheckSummary[] = [],
): ArtworkCheckReport {
  return {
    ...modelReport,
    verdict: deriveVerdict(modelReport),
    inputs,
    model,
    usage,
    checked_at: now.toISOString(),
    ...(checks.length > 0 ? { checks } : {}),
  }
}

// A run that couldn't complete (Help Scout down, no readable print files, AI
// error). Persisted like any other report — per the spec an errored run still
// satisfies the mandatory-run gate, so a transient outage can't strand an
// order — and the card shows the reason with a Re-run.
export function buildErrorReport(
  model: string,
  error: string,
  inputs: ReportInputs,
  now: Date = new Date(),
): ArtworkCheckReport {
  return {
    verdict: 'error',
    summary: `The check couldn't run: ${error}`,
    cards: [],
    corrections: [],
    notes: [],
    reference_gaps: [],
    inputs,
    model,
    usage: null,
    checked_at: now.toISOString(),
    error,
  }
}
