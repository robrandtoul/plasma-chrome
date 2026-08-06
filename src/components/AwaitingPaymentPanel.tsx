import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { CreditCard } from 'lucide-react'
import CollapsibleSidebarPanel from './CollapsibleSidebarPanel'
import { supabase } from '../lib/supabase'
import { formatAbsoluteDateTime } from '../lib/relativeTime'
import {
  awaitingChip,
  awaitingStatusLine,
  awaitingSummary,
  buildAwaitingRows,
  type AwaitingGroupInput,
  type AwaitingOrderInput,
  type AwaitingRow,
} from '../lib/awaitingPayment'

// Dashboard rail panel: every order with a live pay link, and whether the
// customer has opened it.
//
// These rows live on the Orders page inside the collapsed "Waiting" section,
// which is right for that page — as full cards they were two thirds of it while
// needing nothing from anyone — but it put the one fact worth watching behind a
// click. This is that fact, at the size it deserves: a line per customer, on the
// page a designer already has open. Clicking a row lands on the Orders page with
// the Waiting section OPEN and that card ringed, so the panel and the place you
// act on it are the same gesture.
//
// Shaping, sorting and copy all live in ../lib/awaitingPayment (unit-tested);
// this file fetches and renders.

/** Only the columns the panel reads. */
const ORDER_SELECT = `
  id, proof_id, order_group_id, sent_at, pay_link_opened_at, expires_at,
  held_at, help_requested_at, payment_method,
  proofs(contacts(full_name, companies(name)))
`

interface OrderQueryRow {
  id: string
  proof_id: string
  order_group_id: string | null
  sent_at: string | null
  pay_link_opened_at: string | null
  expires_at: string | null
  held_at: string | null
  help_requested_at: string | null
  payment_method: string | null
  proofs: { contacts: { full_name: string | null; companies: { name: string | null } | null } | null } | null
}

function toInput(o: OrderQueryRow): AwaitingOrderInput {
  return {
    id: o.id,
    proof_id: o.proof_id,
    order_group_id: o.order_group_id,
    sent_at: o.sent_at,
    pay_link_opened_at: o.pay_link_opened_at,
    expires_at: o.expires_at,
    held_at: o.held_at,
    help_requested_at: o.help_requested_at,
    payment_method: o.payment_method,
    contact_name: o.proofs?.contacts?.full_name ?? null,
    company_name: o.proofs?.contacts?.companies?.name ?? null,
  }
}

export default function AwaitingPaymentPanel() {
  const [rows, setRows] = useState<AwaitingRow[] | null>(null)
  const inFlight = useRef(false)

  // ⚠ A failed read must leave good rows on screen. supabase-js returns
  // `data: null` on error, so the idiomatic `data ?? []` would silently empty
  // the panel and report "nothing waiting on payment" — the most reassuring
  // possible rendering of a broken query. See the iOS-PWA note in CLAUDE.md;
  // this is the same trap that emptied team chat.
  const load = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      const { data, error } = await supabase.from('orders').select(ORDER_SELECT).eq('status', 'sent')
      if (error || !data) return
      const orders = (data as unknown as OrderQueryRow[]).map(toInput)

      // Combined payments (000309): the group owns the link the customer was
      // actually sent, so its stamps decide the row. Only fetched when one is
      // present — most days there are none.
      let groups: AwaitingGroupInput[] = []
      const groupIds = [...new Set(orders.map((o) => o.order_group_id).filter((id): id is string => id != null))]
      if (groupIds.length > 0) {
        const { data: gData } = await supabase
          .from('order_groups')
          .select('id, status, sent_at, pay_link_opened_at, expires_at')
          .in('id', groupIds)
        // A failed group read falls through to `groups = []`, which renders the
        // members standalone rather than dropping them — see buildAwaitingRows.
        if (gData) groups = gData as unknown as AwaitingGroupInput[]
      }

      setRows(buildAwaitingRows(orders, groups))
    } finally {
      inFlight.current = false
    }
  }, [])

  useEffect(() => { void load() }, [load])

  // Resync when the tab comes back. An installed iOS PWA keeps this page in
  // memory across a backgrounding without remounting, so a fetch-once panel
  // would show yesterday's links indefinitely — and "who has paid" is exactly
  // the thing that changes while the phone is in a pocket.
  useEffect(() => {
    function onWake() {
      if (document.visibilityState !== 'visible') return
      void load()
    }
    document.addEventListener('visibilitychange', onWake)
    window.addEventListener('focus', onWake)
    return () => {
      document.removeEventListener('visibilitychange', onWake)
      window.removeEventListener('focus', onWake)
    }
  }, [load])

  const body =
    rows == null ? (
      <p className="px-5 py-8 text-center text-sm text-ink-mute">Loading…</p>
    ) : rows.length === 0 ? (
      <p className="px-5 py-8 text-center text-sm text-ink-mute">
        Nothing waiting on payment.
      </p>
    ) : (
      <>
        <p className="px-5 pt-3 pb-1 text-[12px] text-ink-mute">{awaitingSummary(rows)}</p>
        {/* Scrolls rather than caps. The complaint this panel answers is that
            these orders were hidden, so a "+N more" that hides the tail again
            would be a strange thing to build. Roughly six rows are in view. */}
        <ul className="max-h-[336px] overflow-y-auto divide-y divide-line-soft">
          {rows.map((r) => {
            const chip = awaitingChip(r)
            const opened = r.openedAt != null
            return (
              <li key={r.key}>
                <Link
                  to={`/orders?order=${r.orderId}`}
                  className="flex items-start gap-3 px-5 py-3 transition-colors hover:bg-canvas focus-visible:bg-canvas focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--c-brand)]"
                >
                  {/* Filled = opened, hollow = not. Shape carries the meaning as
                      well as colour, and the line below says it in words too. */}
                  <span
                    aria-hidden="true"
                    className="mt-[7px] h-2 w-2 shrink-0 rounded-full"
                    style={
                      opened
                        ? { backgroundColor: 'var(--c-in-stock)' }
                        : { boxShadow: 'inset 0 0 0 1.5px var(--c-ink-dim)' }
                    }
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate text-[14px] font-medium leading-snug text-ink">
                        {r.label}
                      </span>
                      {chip && (
                        <span className="shrink-0 rounded-full bg-[var(--c-low-soft)] px-1.5 py-px text-[10px] font-medium uppercase tracking-wide text-[var(--c-low-ink)]">
                          {chip}
                        </span>
                      )}
                    </span>
                    <span
                      className="mt-0.5 block truncate text-[12px] text-ink-mute"
                      // The exact stamp on hover — the relative phrasing is for
                      // scanning, but "was that Tuesday?" needs the real thing.
                      title={
                        r.openedAt
                          ? `Pay link opened ${formatAbsoluteDateTime(r.openedAt)}`
                          : r.sentAt
                            ? `Pay link sent ${formatAbsoluteDateTime(r.sentAt)}`
                            : undefined
                      }
                    >
                      {awaitingStatusLine(r)}
                    </span>
                  </span>
                </Link>
              </li>
            )
          })}
        </ul>
      </>
    )

  return (
    <CollapsibleSidebarPanel
      icon={CreditCard}
      iconTint="var(--c-low)"
      eyebrow="Orders"
      title="Awaiting payment"
      storageKey="pv:panel-awaiting-payment"
    >
      {body}
      <div className="border-t border-line-soft px-5 py-3">
        <Link
          to="/orders"
          className="text-[13px] text-ink-soft underline-offset-2 hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--c-brand)]"
        >
          Open Orders →
        </Link>
      </div>
    </CollapsibleSidebarPanel>
  )
}
