import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { PanelShell } from '../design'

// The Orders-page sidebar: a focused "what's stalled" view of the
// approved → to-order funnel. Unlike the work queue (which only shows orders
// that exist), this surfaces the leak — approved projects that never became an
// order, links going cold, and paid orders whose invoice failed — so the
// conversion-critical stretch from approval to payment doesn't go quiet.
//
// Presentational only: the page computes each bucket and passes shaped rows.

export interface PipelineApprovedItem {
  proofId: string
  label: string
  /** ISO approved_at — rendered as a short date. */
  approvedAt: string
}

export interface PipelineColdItem {
  proofId: string
  label: string
  /** Plain reason, e.g. "Link expired" / "Reminders done, still unpaid". */
  reason: string
}

export interface PipelineInvoiceItem {
  proofId: string
  label: string
}

// Cap per bucket so the card stays scannable; the overflow is summarised.
const CAP = 6

function shortDate(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
}

function Row({ to, label, meta }: { to: string; label: string; meta: string }) {
  return (
    <Link
      to={to}
      className="-mx-1 flex items-baseline justify-between gap-2 rounded px-1 py-1 hover:bg-canvas"
    >
      <span className="min-w-0 truncate text-[13px] text-ink hover:underline">{label}</span>
      <span className="shrink-0 text-[11px] text-ink-mute">{meta}</span>
    </Link>
  )
}

function Bucket({
  dotVar,
  title,
  count,
  overflow,
  children,
}: {
  dotVar: string
  title: string
  count: number
  overflow: number
  children: ReactNode
}) {
  return (
    <div>
      <div className="flex items-center gap-2">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: dotVar }} aria-hidden="true" />
        <span className="text-[11px] font-medium uppercase tracking-wide text-ink-mute">
          {title} · {count}
        </span>
      </div>
      <div className="mt-1">{children}</div>
      {overflow > 0 && (
        <p className="mt-0.5 px-1 text-[11px] text-ink-mute">+{overflow} more</p>
      )}
    </div>
  )
}

export default function OrdersPipelineCard({
  approvedNoOrder,
  cold,
  invoiceFailed,
}: {
  approvedNoOrder: PipelineApprovedItem[]
  cold: PipelineColdItem[]
  invoiceFailed: PipelineInvoiceItem[]
}) {
  const total = approvedNoOrder.length + cold.length + invoiceFailed.length

  return (
    <PanelShell>
      <h2 className="text-sm font-semibold text-ink">Needs action</h2>
      <p className="mt-0.5 text-[12px] text-ink-mute">
        Approved → ordered — what’s stalled before payment.
      </p>

      {total === 0 ? (
        <p className="mt-4 text-[13px] text-ink-soft">Nothing stalled — every approved project is moving.</p>
      ) : (
        <div className="mt-4 space-y-4">
          {approvedNoOrder.length > 0 && (
            <Bucket
              dotVar="var(--c-low)"
              title="Approved, no order yet"
              count={approvedNoOrder.length}
              overflow={approvedNoOrder.length - CAP}
            >
              {approvedNoOrder.slice(0, CAP).map((i) => (
                <Row key={i.proofId} to={`/proofs/${i.proofId}`} label={i.label} meta={`approved ${shortDate(i.approvedAt)}`} />
              ))}
            </Bucket>
          )}

          {cold.length > 0 && (
            <Bucket
              dotVar="var(--c-out)"
              title="Going cold"
              count={cold.length}
              overflow={cold.length - CAP}
            >
              {cold.slice(0, CAP).map((i) => (
                <Row key={i.proofId} to={`/proofs/${i.proofId}`} label={i.label} meta={i.reason} />
              ))}
            </Bucket>
          )}

          {invoiceFailed.length > 0 && (
            <Bucket
              dotVar="var(--c-critical)"
              title="Invoice failed"
              count={invoiceFailed.length}
              overflow={invoiceFailed.length - CAP}
            >
              {invoiceFailed.slice(0, CAP).map((i) => (
                <Row key={i.proofId} to={`/proofs/${i.proofId}`} label={i.label} meta="paid, not invoiced" />
              ))}
            </Bucket>
          )}
        </div>
      )}
    </PanelShell>
  )
}
