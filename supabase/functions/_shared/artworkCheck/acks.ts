// Advisory acknowledgements — the per-item "Mark as addressed" tick on a
// check report (docs/artwork-check-spec.md). A designer works through a
// flagged report advisory by advisory, recording for each one WHY it's now
// handled; when every advisory carries a tick the headline turns green as
// "all addressed" — deliberately worded apart from the machine's own
// "all clear", so the two greens can never be mistaken for each other.
//
// Acks live INSIDE the stored report jsonb (orders.artwork_check /
// proof_versions.artwork_check), exactly like investigations: keyed per item,
// and wiped by any re-run because a re-run replaces the report wholesale. That
// reset is the intended semantic, not a loss — a new report is a new
// judgement, and an item ticked "fixed" is honestly closed out by the re-run
// that confirms the fix.
//
// Twin module: src/lib/artworkAcks.ts carries the same key derivation for the
// frontend (rendering matches acks to items by key), parity-tested via
// pnpm test:artwork-acks. Change one, change both.

export type AckReason = 'fixed' | 'intentional' | 'incorrect'
export const ACK_REASONS: readonly AckReason[] = ['fixed', 'intentional', 'incorrect']

export interface AckEntry {
  reason: AckReason
  // Display name frozen at tick time (the house denormalised-author pattern —
  // the report is a record, and a later rename must not rewrite who ticked).
  by: string
  by_id: string
  at: string
}

// The two kinds of advisory a report carries: a 'flag' finding on a card, and
// an unresolved customer correction. Nothing else is tickable — matches,
// not_supplied rows, reference gaps and notes are context, not tasks.
export type AckTarget =
  | { kind: 'finding'; card: string; field: string; printed: string }
  | { kind: 'correction'; quote: string }

// `printed` is part of a finding's key so two 'other' flags on one card can't
// share a tick. Exact strings only, and deliberately NOT the Investigate
// button's tolerant cross-run matching (resolveReportFlag): an ack asserts a
// human judgement about one specific finding on one specific report, so it
// must never survive onto a reworded re-run.
export function ackKey(target: AckTarget): string {
  return target.kind === 'correction'
    ? `c:${target.quote}`
    : `f:${target.card}::${target.field}::${target.printed}`
}

// Parse the raw request body into a target, refusing anything malformed.
export function parseAckTarget(raw: Record<string, unknown> | null | undefined): AckTarget | null {
  if (!raw) return null
  if (raw.kind === 'correction') {
    const quote = typeof raw.quote === 'string' ? raw.quote : ''
    return quote ? { kind: 'correction', quote } : null
  }
  if (raw.kind === 'finding') {
    const card = typeof raw.card === 'string' ? raw.card : ''
    const field = typeof raw.field === 'string' ? raw.field : ''
    // printed may legitimately be '' (a missing value IS a printable fact).
    const printed = typeof raw.printed === 'string' ? raw.printed : null
    return card && field && printed !== null ? { kind: 'finding', card, field, printed } : null
  }
  return null
}

// The report slice both twins understand (structurally satisfied by
// ArtworkCheckReport on either side).
export interface AckableReport {
  cards: { label: string; findings: { field: string; status: string; printed: string }[] }[]
  corrections: { quote: string; resolved: boolean }[]
  acknowledgements?: Record<string, AckEntry>
}

// Does this target exist on the report as an open advisory item? Exact match
// only — a miss means the report on the caller's screen isn't the one stored,
// and the caller should be handed the stored one rather than have a tick
// land on an item the designer never read.
export function ackTargetExists(report: AckableReport, target: AckTarget): boolean {
  if (target.kind === 'correction') {
    return report.corrections.some((c) => !c.resolved && c.quote === target.quote)
  }
  return report.cards.some(
    (c) =>
      c.label === target.card &&
      c.findings.some((f) => f.status === 'flag' && f.field === target.field && f.printed === target.printed),
  )
}
