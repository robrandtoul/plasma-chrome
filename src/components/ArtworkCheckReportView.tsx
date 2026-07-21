// The artwork sanity-check report body (docs/artwork-check-spec.md) — shared
// between the Place-order review card (OrderReviewPage, which wraps it with
// its own headline + Re-run) and the Orders-page report modal (the in-app
// archive for past checks). One renderer so the two can't drift.

export interface ArtworkFinding {
  field: string
  supplied: string
  printed: string
  status: 'match' | 'flag' | 'not_supplied'
  note: string
}

export interface ArtworkCheckReport {
  verdict: 'clear' | 'flagged' | 'error'
  summary: string
  cards: { label: string; findings: ArtworkFinding[] }[]
  corrections: { quote: string; resolved: boolean; note: string }[]
  notes: string[]
  reference_gaps: string[]
  checked_at: string
  error?: string
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

export default function ArtworkCheckReportView({ report }: { report: ArtworkCheckReport }) {
  const flags = report.cards.flatMap((c) =>
    c.findings.filter((f) => f.status === 'flag').map((f) => ({ card: c.label, ...f })))
  const correctionsOpen = report.corrections.filter((c) => !c.resolved)
  const fieldsChecked = report.cards.reduce((s, c) => s + c.findings.length, 0)

  return (
    <>
      <p className="mt-1 text-ink-soft">{report.summary}</p>
      {flags.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {flags.map((f, i) => (
            <li key={i} className="break-words">
              <span className="font-medium">{f.card} · {f.field.replace(/_/g, ' ')}:</span>{' '}
              printed <span className="font-mono text-[12px]">“{f.printed}”</span>
              {f.supplied && <> vs supplied <span className="font-mono text-[12px]">“{f.supplied}”</span></>}
              {f.note && <span className="text-ink-soft"> — {f.note}</span>}
            </li>
          ))}
        </ul>
      )}
      {correctionsOpen.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {correctionsOpen.map((c, i) => (
            <li key={i} className="break-words">
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
                      {f.status === 'flag' ? '⚠️' : f.status === 'match' ? '✓' : '—'}{' '}
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
        {report.verdict === 'flagged' && 'Flags are advisory — review them, then place the order when you’re satisfied. '}
        Checked {artworkCheckedAtLabel(report)}.
      </p>
    </>
  )
}
