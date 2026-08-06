// The artwork sanity-check report (docs/artwork-check-spec.md) — shared
// between the Place-order review card (OrderReviewPage) and the Orders-page
// report modal (the in-app archive). Renders its own verdict headline (icon +
// text, with an optional right-side action like Re-run) so both surfaces stay
// identical and can't drift.
import { useEffect, useState, type ReactNode } from 'react'
import { supabase } from '../lib/supabase'
import {
  ACK_REASONS,
  ACK_REASON_LABELS,
  ackKey,
  ackProgress,
  hasFixedAcks,
  type AckEntry,
  type AckReason,
  type AckTarget,
} from '../lib/artworkAcks'

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

// A deterministic check the function ran itself, recorded whatever it found —
// pass included. Written in code from the measurement, never by the model:
// see CheckSummary in supabase/functions/_shared/artworkCheck/types.ts for why
// a silent pass was the wrong default.
export interface ArtworkCheckSummary {
  key: string
  label: string
  outcome: 'passed' | 'flagged' | 'not_applicable' | 'not_run'
  detail: string
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
  // Per-advisory "Mark as addressed" ticks (src/lib/artworkAcks.ts) — same
  // lifecycle as investigations: keyed per item on THIS report, wiped by any
  // re-run. The stored verdict is never rewritten by a tick; the "all
  // addressed" green is derived at render time and worded apart from the
  // machine's own "all clear".
  acknowledgements?: Record<string, AckEntry>
  // Absent on reports stored before this shipped — those render no "Checks
  // run" group at all, rather than implying the run did or didn't do it.
  checks?: ArtworkCheckSummary[]
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

// The check as the designer saw it AT THE MOMENT THEY ACTED, for the audit
// metadata on the preview gate's two buttons and the order review page's exit.
//
// Recorded on the click rather than reconstructed afterwards from timestamps,
// because a re-run replaces the stored report: a designer who runs the check,
// sees a flag, goes back and fixes it, then re-runs and gets a clear result
// leaves nothing behind saying the check was flagged when they chose to go
// back — which is precisely the question ("did a flag change what they did?").
// The run ledger (000357) makes the sequence reconstructable, but only this
// says what was on screen under their cursor.
export function artworkCheckAuditFields(report: ArtworkCheckReport | null): Record<string, unknown> {
  if (!report) return { check_ran: false, check_verdict: null, check_flags: 0, check_defects: 0, check_flags_addressed: 0 }
  return {
    check_ran: true,
    check_verdict: report.verdict,
    // Both are 0 on an errored report (it carries no cards or corrections).
    check_flags: artworkFlagCount(report),
    check_defects: artworkDefectCount(report),
    // How many of those the designer had ticked off when they acted — the
    // verdict alone can't distinguish "acted on a flagged report" from
    // "acted after working every flag".
    check_flags_addressed: ackProgress(report).addressed,
  }
}

// One short timestamp format for the whole report — the footer's "Checked …"
// and each tick's "· Donna, 05 Aug, 14:02" read alike.
function shortWhen(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function artworkCheckedAtLabel(report: ArtworkCheckReport): string {
  return shortWhen(report.checked_at)
}

// The verdict icon + headline text, shared so the review card and the archive
// modal read identically. `heading` names the check for the surface: the
// order-time surfaces say "Artwork check", the pre-send proof surface says
// "Proof check".
export function artworkVerdict(report: ArtworkCheckReport, heading = 'Artwork check'): { icon: string; text: string } {
  if (report.verdict === 'clear') return { icon: '✅', text: `${heading} — all clear` }
  if (report.verdict === 'defect' || report.verdict === 'flagged') {
    const prog = ackProgress(report)
    // Every advisory ticked by hand goes green — but NEVER as "all clear",
    // which is the machine's own verdict and this isn't it. The wording is
    // the only thing keeping the two greens apart; don't converge them.
    if (prog.total > 0 && prog.open === 0) {
      return {
        icon: '✅',
        text: `${heading} — ${prog.total === 1 ? 'the advisory' : `all ${prog.total} advisories`} addressed`,
      }
    }
    // Mid-worklist the headline counts down what's LEFT, and the icon tracks
    // the severity of what's left — ticking the only defect drops ❌ to ⚠️.
    if (prog.addressed > 0) {
      return {
        icon: prog.openDefects > 0 ? '❌' : '⚠️',
        text: `${heading} — ${prog.open} of ${prog.total} still to check`,
      }
    }
    if (report.verdict === 'defect') {
      const n = artworkDefectCount(report)
      return { icon: '❌', text: `${heading} — ${n} item${n === 1 ? ' looks' : 's look'} wrong` }
    }
    const n = artworkFlagCount(report)
    return { icon: '⚠️', text: `${heading} — ${n} thing${n === 1 ? '' : 's'} to check` }
  }
  return { icon: '⚠️', text: `${heading} couldn’t run` }
}

// Small eyebrow label above the "Good to know" / "Couldn't check" groups.
function GroupLabel({ children }: { children: ReactNode }) {
  return <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-mute">{children}</p>
}

// One flag, handed back whole to whoever offers "Hold this and ask the
// customer". The card + field identify it; printed/supplied/note/severity are
// the finding itself, snapshotted onto the hold — `orders.artwork_check` is
// overwritten wholesale by every re-run (including the automatic one the
// 000337 trigger fires when a Dropbox folder is linked), so the hold has to
// carry its own copy or the reason outlives the finding that caused it.
export interface ArtworkFlagRef {
  card: string
  field: string
  printed: string
  supplied: string
  note: string
  severity?: ArtworkFinding['severity']
}

export default function ArtworkCheckReportView({
  report,
  heading,
  action,
  notice,
  onInvestigate,
  investigatingKey,
  investigationError,
  onHoldFromFlag,
  onAcknowledge,
  onUnacknowledge,
  acknowledgingKey,
  acknowledgeError,
  history,
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
  // When provided, each flag also offers "Hold this and ask the customer" —
  // the Place-order page's route from a finding to a hold on the order, with
  // the reason pre-written from the flag.
  //
  // Only that page passes it. The Orders-page archive modal and the pre-send
  // proof check leave it out, so nothing renders there: an archived report has
  // no order left to hold, and a proof hasn't been paid for yet.
  onHoldFromFlag?: (flag: ArtworkFlagRef) => void
  // When provided, each advisory offers "Mark as addressed" — the per-item
  // tick with a reason (fixed / intentional / misread), attributed to whoever
  // ticked it, plus Undo. One tick per advisory, deliberately: a single
  // clear-the-lot button is exactly the thing that gets pressed unread, and
  // per-item is what makes the worklist a worklist. Read-only archives leave
  // these out — stored ticks still render there, they just can't be changed.
  onAcknowledge?: (target: AckTarget, reason: AckReason) => void
  onUnacknowledge?: (target: AckTarget) => void
  acknowledgingKey?: string | null
  acknowledgeError?: { key: string; message: string } | null
  // When provided, a "Previous runs" disclosure renders under the footer,
  // backed by the 000385 run ledger: every earlier run for this order/version,
  // each opening its full stored report read-only (ticks included — the ledger
  // row holds each report's final state). Hidden entirely when the ledger has
  // no earlier rows or the database predates 000385.
  history?: { orderId?: string; versionId?: string }
}) {
  // Which advisory's reason picker is open (one at a time; ackKey-keyed).
  const [reasonPickerKey, setReasonPickerKey] = useState<string | null>(null)
  const acks = report.acknowledgements ?? {}
  // Open items first (defect-grade leading — the red items are what the
  // reviewer must see), addressed items sink to the bottom of their list so
  // the worklist reads top-down.
  const flags = report.cards.flatMap((c) =>
    c.findings.filter((f) => f.status === 'flag').map((f) => {
      const target: AckTarget = { kind: 'finding', card: c.label, field: f.field, printed: f.printed }
      const key = ackKey(target)
      return { card: c.label, ...f, target, key, ack: acks[key] as AckEntry | undefined }
    }))
    .sort((a, b) =>
      (a.ack ? 1 : 0) - (b.ack ? 1 : 0) ||
      (a.severity === 'defect' ? 0 : 1) - (b.severity === 'defect' ? 0 : 1))
  const correctionItems = report.corrections
    .filter((c) => !c.resolved)
    .map((c) => {
      const target: AckTarget = { kind: 'correction', quote: c.quote }
      const key = ackKey(target)
      return { ...c, target, key, ack: acks[key] as AckEntry | undefined }
    })
    .sort((a, b) => (a.ack ? 1 : 0) - (b.ack ? 1 : 0))
  const fieldsChecked = report.cards.reduce((s, c) => s + c.findings.length, 0)
  const { icon, text } = artworkVerdict(report, heading)
  const prog = ackProgress(report)
  const allAddressed = prog.total > 0 && prog.open === 0

  // The three tick pieces one advisory carries — shared by the flag blocks
  // and the correction blocks so the two can't drift. `button` joins the
  // item's action row; `picker` and `status` render as their own rows.
  type AckItem = { target: AckTarget; key: string; ack: AckEntry | undefined }
  function ackStatusLine(item: AckItem) {
    if (!item.ack) return null
    const busy = acknowledgingKey === item.key
    return (
      <p className="mt-1.5 text-[13px]">
        <span className="font-medium text-in-stock">✓ Addressed — {ACK_REASON_LABELS[item.ack.reason]}</span>
        <span className="text-ink-mute"> · {item.ack.by}, {shortWhen(item.ack.at)}</span>
        {onUnacknowledge && (
          <button
            type="button"
            onClick={() => onUnacknowledge(item.target)}
            disabled={!!acknowledgingKey}
            className="ml-3 text-[12px] font-medium text-ink-mute hover:underline disabled:opacity-50"
          >
            {busy && <InlineSpinner className="mr-1 h-3 w-3" />}
            Undo
          </button>
        )}
      </p>
    )
  }
  function ackButton(item: AckItem) {
    if (!onAcknowledge || item.ack || reasonPickerKey === item.key) return null
    const busy = acknowledgingKey === item.key
    return (
      <button
        type="button"
        onClick={() => setReasonPickerKey(item.key)}
        disabled={!!acknowledgingKey}
        className="text-[13px] font-medium text-brand hover:underline disabled:opacity-50"
      >
        {busy && <InlineSpinner className="mr-1.5 h-3 w-3" />}
        {busy ? 'Saving…' : 'Mark as addressed'}
      </button>
    )
  }
  function ackPicker(item: AckItem) {
    if (!onAcknowledge || item.ack || reasonPickerKey !== item.key) return null
    // Picking the reason IS the tick — the reason is what makes the record
    // worth anything (and, in aggregate, what tunes the check's allow-list).
    return (
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <span className="text-[12px] text-ink-mute">Addressed how?</span>
        {ACK_REASONS.map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => {
              setReasonPickerKey(null)
              onAcknowledge(item.target, r)
            }}
            disabled={!!acknowledgingKey}
            className="rounded-full px-2.5 py-1 text-[12px] font-medium text-ink ring-1 ring-line hover:bg-canvas disabled:opacity-50"
          >
            {ACK_REASON_LABELS[r]}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setReasonPickerKey(null)}
          className="text-[12px] text-ink-mute hover:underline"
        >
          Cancel
        </button>
      </div>
    )
  }
  function ackErrorLine(item: AckItem) {
    if (acknowledgeError?.key !== item.key) return null
    return <p className="mt-1 text-[13px] text-out">{acknowledgeError.message}</p>
  }

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
                    // A ticked flag row drops its warning tint and shows a GREY
                    // tick — deliberately not the machine-match green, so a
                    // human judgement never reads as a machine verification.
                    const rowAck = isFlag
                      ? acks[ackKey({ kind: 'finding', card: c.label, field: f.field, printed: f.printed })]
                      : undefined
                    return (
                      <div
                        key={j}
                        className={`grid grid-cols-[minmax(72px,0.9fr)_1.3fr_1.3fr] gap-x-3 px-2.5 py-1.5 text-[13px] ${
                          j > 0 ? 'border-t border-line-soft' : ''
                        } ${rowAck ? '' : isDefect ? 'bg-out-soft/40' : isFlag ? 'bg-[var(--c-low-soft)]/40' : ''}`}
                      >
                        <span className="break-words font-medium text-ink">
                          <span
                            aria-hidden="true"
                            title={rowAck ? 'Marked as addressed' : undefined}
                            className={`mr-1 ${f.status === 'match' ? 'text-in-stock' : rowAck ? 'text-ink-mute' : ''}`}
                          >
                            {isFlag ? (rowAck ? '✓' : isDefect ? '❌' : '⚠️') : f.status === 'match' ? '✓' : '—'}
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
            const invKey = investigationKey(f.card, f.field)
            const inv = report.investigations?.[invKey]
            const busy = investigatingKey === invKey
            const invError = investigationError?.key === invKey ? investigationError.message : null
            const defect = f.severity === 'defect'
            // Addressed items calm down — green rule, muted heading — but the
            // finding itself stays readable: the tick records a judgement, it
            // doesn't erase the evidence the judgement was about.
            const done = !!f.ack
            return (
              <li
                key={i}
                className={`break-words rounded-lg border-l-[3px] py-2 pl-3 pr-2 ${
                  done
                    ? 'border-[var(--c-in-stock)]/60 bg-canvas/50'
                    : defect ? 'border-out bg-out-soft/40' : 'border-low bg-[var(--c-low-soft)]/40'
                }`}
              >
                <p className={`font-semibold ${done ? 'text-ink-soft' : ''}`}>
                  <span aria-hidden="true" className={`mr-1 ${done ? 'text-in-stock' : ''}`}>{done ? '✓' : defect ? '❌' : '⚠️'}</span>
                  {f.card} · {f.field.replace(/_/g, ' ')}
                </p>
                <p className="mt-1 text-ink-soft">
                  printed <span className="font-mono text-[12.5px]">“{f.printed}”</span>
                  {f.supplied && <> vs supplied <span className="font-mono text-[12.5px]">“{f.supplied}”</span></>}
                </p>
                {f.note && <p className="mt-1 text-ink-soft">{f.note}</p>}
                {ackStatusLine(f)}
                {inv && (
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
                )}
                {/* The things a reviewer can do with an open flag: tick it off,
                    understand it, or stop the order while they ask. Investigate
                    drops away once its history is on screen (it has answered
                    itself); holding stays offered either way, because reading
                    the history is often exactly what makes someone decide to
                    ask. An addressed flag hides the row — it's done; Undo
                    brings the controls back. */}
                {!done && ((onInvestigate && !inv) || onHoldFromFlag || onAcknowledge) ? (
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                    {ackButton(f)}
                    {onInvestigate && !inv && (
                      <button
                        type="button"
                        onClick={() => onInvestigate({ card: f.card, field: f.field })}
                        disabled={!!investigatingKey}
                        className="text-[13px] font-medium text-brand hover:underline disabled:opacity-50"
                      >
                        {busy && <InlineSpinner className="mr-1.5 h-3 w-3" />}
                        {busy ? 'Reconstructing the history…' : 'Investigate the history'}
                      </button>
                    )}
                    {onHoldFromFlag && (
                      <button
                        type="button"
                        onClick={() =>
                          onHoldFromFlag({
                            card: f.card,
                            field: f.field,
                            printed: f.printed,
                            supplied: f.supplied,
                            note: f.note,
                            severity: f.severity,
                          })
                        }
                        className="text-[13px] font-medium text-brand hover:underline"
                      >
                        Hold this and ask the customer
                      </button>
                    )}
                    {busy && (
                      <span className="text-[12px] text-ink-mute">
                        Reading this card’s artwork across every round — takes half a minute or so.
                      </span>
                    )}
                  </div>
                ) : null}
                {!done && ackPicker(f)}
                {ackErrorLine(f)}
                {invError && <p className="mt-1 text-[13px] text-out">{invError}</p>}
              </li>
            )
          })}
        </ul>
      )}

      {correctionItems.length > 0 && (
        <ul className="mt-3 space-y-2.5">
          {correctionItems.map((c, i) => {
            const defect = c.severity === 'defect'
            const done = !!c.ack
            return (
              <li
                key={i}
                className={`break-words rounded-lg border-l-[3px] py-2 pl-3 pr-2 ${
                  done
                    ? 'border-[var(--c-in-stock)]/60 bg-canvas/50'
                    : defect ? 'border-out bg-out-soft/40' : 'border-low bg-[var(--c-low-soft)]/40'
                }`}
              >
                <p className={`font-semibold ${done ? 'text-ink-soft' : ''}`}>
                  <span aria-hidden="true" className={`mr-1 ${done ? 'text-in-stock' : ''}`}>{done ? '✓' : defect ? '❌' : '⚠️'}</span>
                  Customer correction not picked up
                </p>
                <p className="mt-1 text-ink-soft">“{c.quote}”</p>
                {c.note && <p className="mt-1 text-ink-soft">{c.note}</p>}
                {ackStatusLine(c)}
                {!done && onAcknowledge && <div className="mt-1.5">{ackButton(c)}</div>}
                {!done && ackPicker(c)}
                {ackErrorLine(c)}
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

      {/* What the run MEASURED for itself, pass or fail. Separate from "Good
          to know" on purpose: those are the model's observations, these are
          deterministic results computed in code, and a reviewer betting a
          reprint on "no piece will fall out" needs to know which one they're
          reading. A passing safety check that says nothing is
          indistinguishable from one that never ran (Rob, 2026-08-02). */}
      {(report.checks?.length ?? 0) > 0 && (
        <div className="mt-4">
          <GroupLabel>Checks run</GroupLabel>
          <ul className="space-y-1.5 text-[13px]">
            {report.checks!.map((c, i) => {
              const passed = c.outcome === 'passed'
              const attention = c.outcome === 'flagged' || c.outcome === 'not_run'
              return (
                <li
                  key={i}
                  className={`flex gap-2 break-words rounded-md py-1 ${
                    // Unverified must never look verified inside a green card —
                    // the same rule the "Couldn't check" group follows.
                    c.outcome === 'not_run' ? 'bg-[var(--c-low-soft)]/40 px-2' : ''
                  }`}
                >
                  <span aria-hidden className={`shrink-0 ${passed ? 'text-in-stock' : 'text-ink-mute'}`}>
                    {passed ? '✓' : attention ? '⚠️' : '—'}
                  </span>
                  <span className="text-ink-soft">
                    <span className="font-medium text-ink">{c.label}</span> — {c.detail}
                  </span>
                </li>
              )
            })}
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
        {/* Once every advisory is ticked, the "resolve before placing" lines
            stand down — but the footer still says what the ticks are: a
            human's sign-off layered ON the check, not the check changing its
            mind. */}
        {allAddressed &&
          `${prog.total === 1 ? 'The advisory has' : `All ${prog.total} advisories have`} been marked addressed by hand — the check’s own findings above are unchanged. `}
        {!allAddressed && report.verdict === 'defect' &&
          (artworkDefectCount(report) === 1
            ? 'The ❌ item looks wrong outright — resolve it before placing. Everything here stays advisory. '
            : 'The ❌ items look wrong outright — resolve them before placing. Everything here stays advisory. ')}
        {!allAddressed && report.verdict === 'flagged' && 'Flags are advisory — review them, then place the order when you’re satisfied. '}
        {/* "Fixed" means the artwork changed under this report — the honest
            close-out of a fix is the re-run that confirms it. Only nudged on
            interactive surfaces (archives have no Re-run to offer). */}
        {onAcknowledge && hasFixedAcks(report) &&
          'Items marked “Fixed in the artwork” changed what was checked — re-run the check to confirm the fix. '}
        Checked {artworkCheckedAtLabel(report)}.
      </p>

      {history && (
        <PreviousRunsSection history={history} currentCheckedAt={report.checked_at} heading={heading ?? 'Artwork check'} />
      )}
    </div>
  )
}

// ── Previous runs (migration 000385) ─────────────────────────────────────────
// The run ledger keeps each superseded report's FINAL state (the artwork-check
// function mirrors ticks and investigations onto the run's row), so "what did
// the check say before the fix, and who dismissed what" stays answerable after
// a re-run overwrites the live slot. Renders nothing when there are no earlier
// runs — and degrades to nothing on a pre-000385 database, where selecting the
// `report` column errors (the blanks-candidates idiom: an unmigrated DB just
// hides the feature).
interface HistoryRunRow {
  id: string
  ran_at: string
  verdict: string
  flag_count: number
  defect_count: number
  error: string | null
  report: ArtworkCheckReport | null
}

function PreviousRunsSection({
  history,
  currentCheckedAt,
  heading,
}: {
  history: { orderId?: string; versionId?: string }
  currentCheckedAt: string
  heading: string
}) {
  const [rows, setRows] = useState<HistoryRunRow[]>([])
  const [expanded, setExpanded] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setRows([])
    setExpanded(false)
    setOpenId(null)
    const id = history.orderId ?? history.versionId
    if (!id) return
    void supabase
      .from('artwork_check_runs')
      .select('id, ran_at, verdict, flag_count, defect_count, error, report')
      .eq(history.orderId ? 'order_id' : 'proof_version_id', id)
      .order('ran_at', { ascending: false })
      .limit(25)
      .then(({ data, error }) => {
        if (cancelled || error || !Array.isArray(data)) return
        // The newest row IS the report on screen — filtered by timestamp value
        // (parsed, not string-compared: PostgREST serialises +00:00 where the
        // report's checked_at says Z).
        const current = Date.parse(currentCheckedAt)
        setRows((data as HistoryRunRow[]).filter((r) => Date.parse(r.ran_at) !== current))
      })
    return () => {
      cancelled = true
    }
  }, [history.orderId, history.versionId, currentCheckedAt])

  if (rows.length === 0) return null

  return (
    <div className="mt-3 border-t border-line-soft pt-2.5">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="text-[12px] font-medium text-ink-mute hover:text-ink hover:underline"
      >
        {expanded ? 'Hide previous runs' : `Previous runs (${rows.length})`}
      </button>
      {expanded && (
        <ul className="mt-2 space-y-1.5">
          {rows.map((r) => {
            const open = openId === r.id
            const icon = r.verdict === 'clear' ? '✅' : r.verdict === 'defect' ? '❌' : '⚠️'
            const summary =
              r.verdict === 'error'
                ? 'couldn’t run'
                : r.verdict === 'clear'
                  ? 'all clear'
                  : `${r.flag_count} advisor${r.flag_count === 1 ? 'y' : 'ies'}${r.defect_count > 0 ? ` (${r.defect_count} ❌)` : ''}`
            return (
              <li key={r.id} className="text-[13px]">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span aria-hidden="true">{icon}</span>
                  <span className="text-ink-soft">{shortWhen(r.ran_at)}</span>
                  <span className="text-ink-mute">{summary}</span>
                  {r.report ? (
                    <button
                      type="button"
                      onClick={() => setOpenId(open ? null : r.id)}
                      className="text-[12px] font-medium text-brand hover:underline"
                    >
                      {open ? 'Hide' : 'View'}
                    </button>
                  ) : (
                    // Runs recorded before 000385 kept only their numbers.
                    <span className="text-[12px] italic text-ink-mute">report not kept</span>
                  )}
                </div>
                {open && r.report && (
                  // Read-only by construction: no handlers, so its ticks
                  // render frozen; and no history prop, so nesting stops at
                  // one level.
                  <div className="mt-2 rounded-lg border border-line-soft bg-canvas/50 px-3 py-2.5">
                    <ArtworkCheckReportView report={r.report} heading={heading} />
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
