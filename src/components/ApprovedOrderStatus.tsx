import OrderProgressStrip from './OrderProgressStrip'
import type { OrderStatusLine } from '../lib/proofOrderState'

// The order-status footer inside the approved card on /p/:id (migration
// 000371).
//
// Lives on that card rather than in a strip of its own so the page has ONE
// place answering "where is this", with approval and everything that follows
// from it reading as a single story. Its sibling further down the page — the
// "Ready to order?" panel by the price grid — answers the different question
// "how do I buy these?", and the two deliberately never speak about the same
// moment (see the note in lib/proofOrderState.ts).
//
// Extracted from CustomerProofPage so the verify harness can render every
// state without a live proof (?path=/approved-order-status).

export default function ApprovedOrderStatus({ status }: { status: OrderStatusLine }) {
  return (
    <div
      className="mt-3.5 border-t pt-3"
      style={{ borderColor: 'color-mix(in srgb, var(--c-in-stock) 22%, transparent)' }}
    >
      <p
        className="font-mono text-[11px] font-semibold uppercase"
        style={{ color: 'var(--c-in-stock)', letterSpacing: '0.12em' }}
      >
        {status.label}
      </p>
      {status.line && (
        <p className="mt-1 text-[13px] leading-relaxed text-ink-soft">{status.line}</p>
      )}
      {status.stage && (
        <div className="mt-3">
          <OrderProgressStrip stage={status.stage} deliveryTracked={status.deliveryTracked} />
        </div>
      )}
    </div>
  )
}
