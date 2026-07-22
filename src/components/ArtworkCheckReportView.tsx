// The artwork sanity-check report body (docs/artwork-check-spec.md) — shared
// between the Place-order review card (OrderReviewPage, which wraps it with
// its own headline + Re-run) and the Orders-page report modal (the in-app
// archive for past checks). One renderer so the two can't drift.

export interface ArtworkFinding {
  field: string
  supplied: string
  printed: string
  status: 'match' | 'flag' | 'not_supplied'
  // review = amber (worth a glance, may be intentional); defect = red (the
  // "bet a reprint on it" tier). Absent on pre-tier reports → review.
  severity?: 'review' | 'defect'
  note: string
}

// A designer-triggered per-flag history walk: the flagged card's artwork
// across every proof round, lined up against the thread's dated instructions,
// ending in a fault lean. Cached on the report under investigationKey.
export interface ArtworkInvestigation {
  timeline: { at: string; kind: 'instruction' | 'version'; label: string; detail: string }[]
  conclusion: string
  fault: 'ours_transcription' | 'ours_missed_revision' | 'customer_origin' | 'undetermined'
  card: string
  field: string
  at: string
}

export function investigationKey(card: string, field: string): string {
  return `${card}::${field}`
}

const FAULT_LABELS: Record<ArtworkInvestigation['fault'], string> = {
  ours_transcription: 'Looks like our transcription slip',
  ours_missed_revision: 'A revision we missed',
  customer_origin: 'Matches what the customer supplied',
  undetermined: 'Couldn’t be determined from the history',
}

export interface ArtworkCheckReport {
  verdict: 'clear' | 'flagged' | 'defect' | 'error'
  summary: string
  cards: { label: string; findings: ArtworkFinding[] }[]
  corrections: { quote: string; resolved: boolean; severity?: 'review' | 'defect'; note: string }[]
  notes: string[]
  reference_gaps: string[]
  checked_at: string
  error?: string
  investigations?: Record<string, ArtworkInvestigation>
}

// Red count for the ❌ headline: defect-grade flags + defect-grade unresolved
// corrections. Pre-tier reports count 0.
export function artworkDefectCount(report: ArtworkCheckReport): number {
  return (
    report.cards.reduce(
      (sum, c) => sum + c.findings.filter((f) => f.status === 'flag' && f.severity === 'defect').length,
      0,
    ) + report.corrections.filter((c) => !c.resolved && c.severity === 'defect').length
  )
}

// Flags = 'flag' findings + corrections the customer sent that the artwork
// doesn't reflect — the number the ⚠️ headline carries.
export function artworkFlagCount(report: ArtworkCheckReport): number {
  const findingFlags = report.cards.reduce(
    (sum, c) => sum + c.findings.filter((f) => f.status === 'flag').length,
    0,
  )
  return findingFlags + report.corrections.filter((c) => !c.resolved).length
}

export function artworkCheckedAtLabel(report: ArtworkCheckReport): string {
  return new Date(report.checked_at).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function ArtworkCheckReportView({
  report,
  onInvestigate,
  investigatingKey,
  investigationError,
}: {
  report: ArtworkCheckReport
  // When provided, each flag offers "Investigate the history" — the
  // designer-triggered walk of that card's artwork across the proof rounds.
  // Deliberately a button, never automatic: the designer decides per-flag
  // whether the circumstances are worth the wait and the cost.
  onInvestigate?: (flag: { card: string; field: string }) => void
  investigatingKey?: string | null
  investigationError?: { key: string; message: string } | null
}) {
  // Defect-grade flags first — the red items are what the reviewer must see.
  const flags = report.cards.flatMap((c) =>
    c.findings.filter((f) => f.status === 'flag').map((f) => ({ card: c.label, ...f })))
    .sort((a, b) => (a.severity === 'defect' ? 0 : 1) - (b.severity === 'defect' ? 0 : 1))
  const correctionsOpen = report.corrections.filter((c) => !c.resolved)
  const fieldsChecked = report.cards.reduce((s, c) => s + c.findings.length, 0)

  return (
    <>
      <p className="mt-1 text-ink-soft">{report.summary}</p>
      {flags.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {flags.map((f, i) => {
            const key = investigationKey(f.card, f.field)
            const inv = report.investigations?.[key]
            const busy = investigatingKey === key
            const invError = investigationError?.key === key ? investigationError.message : null
            return (
              <li key={i} className="break-words">
                {f.severity === 'defect' && <span className="font-semibold text-out">✗ </span>}
                <span className="font-medium">{f.card} · {f.field.replace(/_/g, ' ')}:</span>{' '}
                printed <span className="font-mono text-[12px]">“{f.printed}”</span>
                {f.supplied && <> vs supplied <span className="font-mono text-[12px]">“{f.supplied}”</span></>}
                {f.note && <span className="text-ink-soft"> — {f.note}</span>}
                {inv ? (
                  <div className="mt-1.5 rounded-lg border border-line-soft bg-canvas/60 px-2.5 py-2">
                    <p className="text-[12px] font-semibold text-ink">History: {FAULT_LABELS[inv.fault]}</p>
                    <p className="mt-0.5 text-[12px] text-ink-soft">{inv.conclusion}</p>
                    {inv.timeline.length > 0 && (
                      <details className="mt-1">
                        <summary className="cursor-pointer text-[11px] font-medium text-ink-mute">Timeline</summary>
                        <ul className="mt-1 space-y-0.5 text-[12px] text-ink-soft">
                          {inv.timeline.map((t, j) => (
                            <li key={j} className="break-words">
                              <span className="text-ink-mute">{t.at}</span>{' '}
                              <span className={t.kind === 'instruction' ? 'font-medium text-ink' : 'font-medium'}>{t.label}:</span>{' '}
                              {t.detail}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </div>
                ) : onInvestigate ? (
                  <div className="mt-1">
                    <button
                      type="button"
                      onClick={() => onInvestigate({ card: f.card, field: f.field })}
                      disabled={!!investigatingKey}
                      className="text-[12px] font-medium text-brand hover:underline disabled:opacity-50"
                    >
                      {busy ? 'Reconstructing the history…' : 'Investigate the history'}
                    </button>
                    {busy && (
                      <span className="ml-2 text-[11px] text-ink-mute">
                        Reading this card’s artwork across every round — takes half a minute or so.
                      </span>
                    )}
                    {invError && <p className="mt-0.5 text-[12px] text-out">{invError}</p>}
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
      {correctionsOpen.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {correctionsOpen.map((c, i) => (
            <li key={i} className="break-words">
              {c.severity === 'defect' && <span className="font-semibold text-out">✗ </span>}
              <span className="font-medium">Customer correction not picked up:</span>{' '}
              “{c.quote}”{c.note && <span className="text-ink-soft"> — {c.note}</span>}
            </li>
          ))}
        </ul>
      )}
      {(report.notes.length > 0 || report.reference_gaps.length > 0) && (
        <ul className="mt-2 space-y-0.5 text-[12px] text-ink-soft">
          {report.notes.map((n, i) => <li key={`n-${i}`} className="break-words">{n}</li>)}
          {report.reference_gaps.map((g, i) => <li key={`g-${i}`} className="break-words">Couldn’t check: {g}</li>)}
        </ul>
      )}
      {report.cards.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-[12px] font-medium text-ink-soft">Full comparison table</summary>
          <div className="mt-1 space-y-2">
            {report.cards.map((c, i) => (
              <div key={i}>
                <p className="text-[12px] font-medium text-ink">{c.label}</p>
                <ul className="mt-0.5 space-y-0.5 text-[12px] text-ink-soft">
                  {c.findings.map((f, j) => (
                    <li key={j} className="break-words">
                      {f.status === 'flag' ? (f.severity === 'defect' ? '✗' : '⚠️') : f.status === 'match' ? '✓' : '—'}{' '}
                      {f.field.replace(/_/g, ' ')}: {f.printed}
                      {f.status === 'not_supplied' ? ' (not supplied by customer)' : ''}
                      {f.status === 'flag' && f.supplied ? ` (supplied: ${f.supplied})` : ''}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </details>
      )}
      <p className="mt-1.5 text-[12px] text-ink-mute">
        {report.verdict !== 'error' && fieldsChecked > 0 && `${fieldsChecked} field${fieldsChecked === 1 ? '' : 's'} compared. `}
        {report.verdict === 'defect' && '✗ items look wrong outright — resolve them before placing. Everything here stays advisory. '}
        {report.verdict === 'flagged' && 'Flags are advisory — review them, then place the order when you’re satisfied. '}
        Checked {artworkCheckedAtLabel(report)}.
      </p>
    </>
  )
}
