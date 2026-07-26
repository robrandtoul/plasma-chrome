// The artwork sanity-check report (docs/artwork-check-spec.md) — shared
// between the Place-order review card (OrderReviewPage) and the Orders-page
// report modal (the in-app archive). Renders its own verdict headline (icon +
// text, with an optional right-side action like Re-run) so both surfaces stay
// identical and can't drift.
import type { ReactNode } from 'react'

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

// A dependency-free indeterminate spinner that inherits the current text
// colour and sits on the text baseline — used wherever the check or an
// investigation is working (there's no honest % to show for a single opaque
// multimodal call, so an indeterminate spinner is the right signal).
export function InlineSpinner({ className = '' }: { className?: string }) {
  return (
    <span
      role="status"
      aria-label="Working"
      className={`inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent align-[-2px] ${className}`}
    />
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

// The verdict icon + headline text, shared so the review card and the archive
// modal read identically. `heading` names the check for the surface: the
// order-time surfaces say "Artwork check", the pre-send proof surface says
// "Proof check".
export function artworkVerdict(report: ArtworkCheckReport, heading = 'Artwork check'): { icon: string; text: string } {
  if (report.verdict === 'clear') return { icon: '✅', text: `${heading} — all clear` }
  if (report.verdict === 'defect') {
    const n = artworkDefectCount(report)
    return { icon: '❌', text: `${heading} — ${n} item${n === 1 ? ' looks' : 's look'} wrong` }
  }
  if (report.verdict === 'flagged') {
    const n = artworkFlagCount(report)
    return { icon: '⚠️', text: `${heading} — ${n} thing${n === 1 ? '' : 's'} to check` }
  }
  return { icon: '⚠️', text: `${heading} couldn’t run` }
}

// Small eyebrow label above the "Good to know" / "Couldn't check" groups.
function GroupLabel({ children }: { children: ReactNode }) {
  return <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-mute">{children}</p>
}

export default function ArtworkCheckReportView({
  report,
  heading,
  action,
  notice,
  onInvestigate,
  investigatingKey,
  investigationError,
}: {
  report: ArtworkCheckReport
  // Names the check in the headline — defaults to "Artwork check" (the
  // order-time surfaces); the pre-send proof surface passes "Proof check".
  heading?: string
  // Report-level message, shown under the summary. Used when the report on
  // screen had to be swapped for the stored one (the check was re-run
  // underneath the page) — a per-flag message would disappear along with the
  // flag it was keyed to.
  notice?: string | null
  // Optional control shown at the top-right of the headline (the review page's
  // Re-run); the read-only archive modal passes none.
  action?: ReactNode
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
  const { icon, text } = artworkVerdict(report, heading)

  return (
    <div className="text-[14px] leading-relaxed text-ink">
      <div className="flex items-start justify-between gap-3">
        <p className="flex items-baseline gap-2 font-semibold">
          <span className="text-[20px] leading-none">{icon}</span>
          <span>{text}</span>
        </p>
        {action && <div className="shrink-0">{action}</div>}
      </div>

      <p className="mt-2 text-ink-soft">{report.summary}</p>

      {notice && (
        <p className="mt-2 rounded-lg border border-line-soft bg-canvas/70 px-3 py-2 text-[13px] text-ink-soft">
          {notice}
        </p>
      )}

      {/* The side-by-side comparison — second only to the verdict (Rob,
          2026-07-24), so it renders open and up top: every checked field per
          card, what's on the artwork vs what was supplied, flagged rows
          tinted so the table carries the severity signal on its own. The
          detailed flag blocks below explain the WHY. */}
      {report.cards.length > 0 && (
        <div className="mt-4">
          <GroupLabel>Field by field</GroupLabel>
          <div className="space-y-3">
            {report.cards.map((c, i) => (
              <div key={i}>
                <p className="text-[13px] font-semibold text-ink">{c.label}</p>
                <div className="mt-1 overflow-hidden rounded-lg border border-line-soft">
                  <div className="grid grid-cols-[minmax(72px,0.9fr)_1.3fr_1.3fr] gap-x-3 border-b border-line-soft bg-canvas/60 px-2.5 py-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-ink-mute">
                    <span>Field</span>
                    <span>On the card</span>
                    <span>Supplied</span>
                  </div>
                  {c.findings.map((f, j) => {
                    const isFlag = f.status === 'flag'
                    const isDefect = isFlag && f.severity === 'defect'
                    return (
                      <div
                        key={j}
                        className={`grid grid-cols-[minmax(72px,0.9fr)_1.3fr_1.3fr] gap-x-3 px-2.5 py-1.5 text-[13px] ${
                          j > 0 ? 'border-t border-line-soft' : ''
                        } ${isDefect ? 'bg-out-soft/40' : isFlag ? 'bg-[var(--c-low-soft)]/40' : ''}`}
                      >
                        <span className="break-words font-medium text-ink">
                          <span aria-hidden="true" className={`mr-1 ${f.status === 'match' ? 'text-in-stock' : ''}`}>
                            {isFlag ? (isDefect ? '❌' : '⚠️') : f.status === 'match' ? '✓' : '—'}
                          </span>
                          {f.field.replace(/_/g, ' ')}
                        </span>
                        <span className="break-words text-ink-soft">{f.printed || '—'}</span>
                        <span className={`break-words ${f.status === 'not_supplied' ? 'italic text-ink-mute' : 'text-ink-soft'}`}>
                          {f.status === 'not_supplied' ? 'Not supplied' : f.supplied || '—'}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {flags.length > 0 && (
        <ul className="mt-3 space-y-2.5">
          {flags.map((f, i) => {
            const key = investigationKey(f.card, f.field)
            const inv = report.investigations?.[key]
            const busy = investigatingKey === key
            const invError = investigationError?.key === key ? investigationError.message : null
            const defect = f.severity === 'defect'
            return (
              <li
                key={i}
                className={`break-words rounded-lg border-l-[3px] py-2 pl-3 pr-2 ${
                  defect ? 'border-out bg-out-soft/40' : 'border-low bg-[var(--c-low-soft)]/40'
                }`}
              >
                <p className="font-semibold">
                  <span className="mr-1">{defect ? '❌' : '⚠️'}</span>
                  {f.card} · {f.field.replace(/_/g, ' ')}
                </p>
                <p className="mt-1 text-ink-soft">
                  printed <span className="font-mono text-[12.5px]">“{f.printed}”</span>
                  {f.supplied && <> vs supplied <span className="font-mono text-[12.5px]">“{f.supplied}”</span></>}
                </p>
                {f.note && <p className="mt-1 text-ink-soft">{f.note}</p>}
                {inv ? (
                  <div className="mt-2 rounded-lg border border-line-soft bg-canvas/70 px-3 py-2">
                    <p className="text-[13px] font-semibold text-ink">History: {FAULT_LABELS[inv.fault]}</p>
                    <p className="mt-1 text-[13px] text-ink-soft">{inv.conclusion}</p>
                    {inv.timeline.length > 0 && (
                      <details className="mt-1.5">
                        <summary className="cursor-pointer text-[12px] font-medium text-ink-mute">Timeline</summary>
                        <ul className="mt-1.5 space-y-1 text-[13px] text-ink-soft">
                          {inv.timeline.map((t, j) => (
                            <li key={j} className="break-words">
                              <span className="text-ink-mute">{t.at}</span>{' '}
                              <span className="font-medium">{t.label}:</span>{' '}
                              {t.detail}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </div>
                ) : onInvestigate ? (
                  <div className="mt-1.5">
                    <button
                      type="button"
                      onClick={() => onInvestigate({ card: f.card, field: f.field })}
                      disabled={!!investigatingKey}
                      className="text-[13px] font-medium text-brand hover:underline disabled:opacity-50"
                    >
                      {busy && <InlineSpinner className="mr-1.5 h-3 w-3" />}
                      {busy ? 'Reconstructing the history…' : 'Investigate the history'}
                    </button>
                    {busy && (
                      <span className="ml-2 text-[12px] text-ink-mute">
                        Reading this card’s artwork across every round — takes half a minute or so.
                      </span>
                    )}
                    {invError && <p className="mt-1 text-[13px] text-out">{invError}</p>}
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}

      {correctionsOpen.length > 0 && (
        <ul className="mt-3 space-y-2.5">
          {correctionsOpen.map((c, i) => {
            const defect = c.severity === 'defect'
            return (
              <li
                key={i}
                className={`break-words rounded-lg border-l-[3px] py-2 pl-3 pr-2 ${
                  defect ? 'border-out bg-out-soft/40' : 'border-low bg-[var(--c-low-soft)]/40'
                }`}
              >
                <p className="font-semibold">
                  <span className="mr-1">{defect ? '❌' : '⚠️'}</span>
                  Customer correction not picked up
                </p>
                <p className="mt-1 text-ink-soft">“{c.quote}”</p>
                {c.note && <p className="mt-1 text-ink-soft">{c.note}</p>}
              </li>
            )
          })}
        </ul>
      )}

      {/* Unverified ≠ verified: the gaps render amber-accented so that inside
          a green all-clear card they still read as "these bits were NOT
          checked" (Rob, 2026-07-24). The verdict itself stays green on
          purpose — nearly every report has some gap, and demoting the
          traffic light for gaps would make green meaningless. */}
      {report.reference_gaps.length > 0 && (
        <div className="mt-4 rounded-lg border-l-[3px] border-low bg-[var(--c-low-soft)]/40 py-2 pl-3 pr-2">
          <GroupLabel>Couldn’t check</GroupLabel>
          <ul className="space-y-1.5 text-[13px] text-ink-soft">
            {report.reference_gaps.map((g, i) => (
              <li key={i} className="flex gap-2 break-words">
                <span aria-hidden className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-ink-mute" />
                <span>{g}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {report.notes.length > 0 && (
        <div className="mt-4">
          <GroupLabel>Good to know</GroupLabel>
          <ul className="space-y-1.5 text-[13px] text-ink-soft">
            {report.notes.map((n, i) => (
              <li key={i} className="flex gap-2 break-words">
                <span aria-hidden className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-ink-mute" />
                <span>{n}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="mt-4 border-t border-line-soft pt-2.5 text-[12px] text-ink-mute">
        {report.verdict !== 'error' && fieldsChecked > 0 && `${fieldsChecked} field${fieldsChecked === 1 ? '' : 's'} compared. `}
        {report.verdict === 'defect' && 'The ❌ items look wrong outright — resolve them before placing. Everything here stays advisory. '}
        {report.verdict === 'flagged' && 'Flags are advisory — review them, then place the order when you’re satisfied. '}
        Checked {artworkCheckedAtLabel(report)}.
      </p>
    </div>
  )
}
