import type { ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'
import { PanelShell, ButtonInk } from '../design'

// The Orders-page "Needs action" summary: a focused "what's stalled" view of
// the order pipeline — links going cold, paid orders whose invoice failed, and
// placed orders whose workshop note / supplier email never went out — so
// neither the stretch from approval to payment nor the hand-over to production
// goes quiet.
//
// Presentational only: the page computes each bucket and passes shaped rows.
// Each row jumps to the stalled order's card in the work queue below (via
// onSelect), so the "what's stalled" view and the list that fixes it connect.
// The page renders nothing at all when both buckets are empty — an empty
// "nothing stalled" panel was spending the top of the mobile page saying
// nothing. Desktop gets the full sidebar panel; mobile gets a compact
// tap-to-expand banner instead.

export interface PipelineColdItem {
  orderId: string
  label: string
  /** Plain reason, e.g. "Link expired" / "Reminders done, still unpaid". */
  reason: string
}

export interface PipelineInvoiceItem {
  orderId: string
  label: string
}

// An order that reached Stock Control but whose message to the workshop or the
// supplier never went (docs/order-handoff-spec.md §3.4). Unlike the other two
// buckets this one carries its own fix — nobody is making the cards until the
// message goes, so the button sits right on the row.
export interface PipelineUnsentMessageItem {
  orderId: string
  label: string
  /** Plain sentence, e.g. "In Stock Control, but the workshop note wasn't sent." */
  reason: string
  /** True while this row's message is being sent. */
  busy?: boolean
  /** Why the last attempt didn't work, if it didn't. */
  error?: string | null
}

// Cap per bucket so the card stays scannable; the overflow is summarised.
const CAP = 6

function Row({ onClick, label, meta }: { onClick: () => void; label: string; meta: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="-mx-1 flex w-[calc(100%+8px)] items-baseline justify-between gap-2 rounded px-1 py-1 text-left hover:bg-canvas focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--c-brand)]"
    >
      <span className="min-w-0 truncate text-[13px] text-ink underline-offset-2 hover:underline">{label}</span>
      <span className="shrink-0 text-[11px] text-ink-mute">{meta}</span>
    </button>
  )
}

// A taller row than the others: it explains the problem in a sentence and
// carries the button that fixes it, so the message can be sent without hunting
// for the order (a placed order sits in the collapsed Recently-ordered list).
function UnsentMessageRow({
  item,
  onSelect,
  onSend,
}: {
  item: PipelineUnsentMessageItem
  onSelect: () => void
  onSend: () => void
}) {
  return (
    <div className="-mx-1 rounded px-1 py-1.5">
      <button
        type="button"
        onClick={onSelect}
        className="block w-full truncate text-left text-[13px] text-ink underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--c-brand)]"
      >
        {item.label}
      </button>
      <p className="mt-0.5 text-[12px] text-ink-soft">{item.reason}</p>
      {item.error && <p className="mt-0.5 break-words text-[12px] text-out">{item.error}</p>}
      <ButtonInk size="sm" onClick={onSend} disabled={item.busy} className="mt-1.5 max-md:h-11">
        {item.busy ? 'Sending…' : 'Send it now'}
      </ButtonInk>
    </div>
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
  cold,
  invoiceFailed,
  unsentMessage = [],
  onSelectCold,
  onSelectInvoiceFailed,
  onSelectUnsentMessage,
  onSendMessage,
}: {
  cold: PipelineColdItem[]
  invoiceFailed: PipelineInvoiceItem[]
  unsentMessage?: PipelineUnsentMessageItem[]
  /** Jump to the order's card under Awaiting payment. */
  onSelectCold: (orderId: string) => void
  /** Jump to the order's card under To order. */
  onSelectInvoiceFailed: (orderId: string) => void
  /** Jump to the order's row under Recently ordered. */
  onSelectUnsentMessage?: (orderId: string) => void
  /** Send the missing workshop note / supplier email for this order. */
  onSendMessage?: (orderId: string) => void
}) {
  const total = cold.length + invoiceFailed.length + unsentMessage.length
  if (total === 0) return null

  const summaryParts = [
    unsentMessage.length > 0 ? `${unsentMessage.length} not sent to production` : null,
    cold.length > 0 ? `${cold.length} going cold` : null,
    invoiceFailed.length > 0 ? `${invoiceFailed.length} invoice${invoiceFailed.length === 1 ? '' : 's'} failed` : null,
  ].filter(Boolean)

  const buckets = (
    <div className="space-y-4">
      {/* First: an order the workshop or the supplier hasn't been told about is
          the most time-critical thing on this panel — the customer has paid and
          nothing is being made. */}
      {unsentMessage.length > 0 && (
        <Bucket
          dotVar="var(--c-critical)"
          title="Not sent to production"
          count={unsentMessage.length}
          overflow={unsentMessage.length - CAP}
        >
          {unsentMessage.slice(0, CAP).map((i) => (
            <UnsentMessageRow
              key={i.orderId}
              item={i}
              onSelect={() => onSelectUnsentMessage?.(i.orderId)}
              onSend={() => onSendMessage?.(i.orderId)}
            />
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
            <Row key={i.orderId} onClick={() => onSelectCold(i.orderId)} label={i.label} meta={i.reason} />
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
            <Row key={i.orderId} onClick={() => onSelectInvoiceFailed(i.orderId)} label={i.label} meta="paid, not invoiced" />
          ))}
        </Bucket>
      )}
    </div>
  )

  return (
    <>
      {/* Desktop: the full sidebar panel. */}
      <div className="hidden md:block">
        <PanelShell>
          <h2 className="text-sm font-semibold text-ink">Needs action</h2>
          <p className="mt-0.5 text-[12px] text-ink-mute">
            What’s stalled on the way from pay link to production.
          </p>
          <div className="mt-4">{buckets}</div>
        </PanelShell>
      </div>

      {/* Mobile: a compact amber banner that expands to the same rows, so the
          alert is one line tall until it's actually wanted. */}
      <details className="md:hidden rounded-xl border border-[var(--c-low)]/50 bg-[var(--c-low-soft)] px-3">
        <summary className="flex min-h-[46px] cursor-pointer list-none items-center gap-2 text-[13px] font-medium text-ink">
          <AlertTriangle size={15} className="shrink-0 text-[var(--c-low)]" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">Needs action · {summaryParts.join(' · ')}</span>
          <span className="shrink-0 text-[11px] font-normal text-ink-mute">Show</span>
        </summary>
        <div className="pb-3 pt-1">{buckets}</div>
      </details>
    </>
  )
}
