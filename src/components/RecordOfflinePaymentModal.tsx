import { useId, useState } from 'react'
import Modal from './Modal'
import { Field, Input, ButtonCoral, ButtonGhost } from '../design'
import { supabase } from '../lib/supabase'
import { customerOrderUrl } from '../lib/customerOrderUrl'
import { renderTemplate, DEFAULT_BODIES } from '../lib/replyTemplates'
import { formatPrice } from '../lib/currency'
import type { Currency } from '../lib/types'

// Record offline payment (Ordering & checkout). Opens from the "Record offline
// payment" button on an Awaiting-payment order. Converts a live online pay-link
// into an offline-PAID order in place (sent → paid / offline) for a customer who
// paid by bank transfer instead of card — no email, no Stripe, no Xero, and it
// lands in the "To order" queue. The designer raises the Xero invoice by hand.
//
// An online order can be open-quantity and use address-rated shipping, neither
// of which can settle without the pay page, so this collects the two missing
// locked inputs: a fixed quantity and a free / manual shipping charge. The price
// is computed server-side by the record-offline-payment edge function (the
// client never computes money).

interface OfflineOrder {
  id: string
  proof_id: string
  token: string
  currency: Currency
  quantity: number | null
}

export default function RecordOfflinePaymentModal({
  order,
  title,
  spec,
  onClose,
  onRecorded,
}: {
  order: OfflineOrder
  /** Customer label for the order (e.g. "Acme Ltd · Jane Doe"). */
  title: string
  /** Spec summary line (e.g. material / finish). */
  spec: string
  onClose: () => void
  /** Called once the record succeeds so the parent can refetch the order row
      (its new paid/offline amounts) in the background. */
  onRecorded: (orderId: string) => void
}) {
  const headingId = useId()
  const [quantity, setQuantity] = useState(order.quantity != null ? String(order.quantity) : '')
  const [shipping, setShipping] = useState<'free' | 'manual'>('free')
  const [shippingAmount, setShippingAmount] = useState('')
  const [sendConfirmation, setSendConfirmation] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const qtyNum = Number(quantity)
  const qtyValid = Number.isInteger(qtyNum) && qtyNum > 0
  const shipNum = Number(shippingAmount)
  const shipValid = shipping === 'free' || (Number.isFinite(shipNum) && shipNum >= 0)
  const canSubmit = qtyValid && shipValid && !submitting

  // Pull the edge function's error message out of its Response body, falling
  // back to a friendly default (mirrors the OrderBuilderModal error handling).
  async function readFnError(data: unknown, fnErr: unknown): Promise<string> {
    let msg = (data as { error?: string } | null)?.error ?? null
    const ctx = (fnErr as { context?: Response } | null)?.context
    if (!msg && ctx && typeof ctx.json === 'function') {
      try {
        const b = await ctx.json()
        if (b && typeof b.error === 'string') msg = b.error
      } catch {
        /* not JSON */
      }
    }
    return msg ?? 'Could not record the payment — please try again.'
  }

  async function submit() {
    if (!canSubmit) return
    setError(null)
    setSubmitting(true)
    try {
      const { data, error: fnErr } = await supabase.functions.invoke<
        { ok: true; total: number; currency: Currency } | { error: string }
      >('record-offline-payment', {
        body: {
          order_id: order.id,
          quantity: qtyNum,
          shipping_treatment: shipping,
          shipping_charged: shipping === 'manual' ? Math.round(shipNum * 100) / 100 : undefined,
        },
      })
      if (fnErr || !data || 'error' in data) {
        setError(await readFnError(data, fnErr))
        return
      }

      const totalLabel = formatPrice(data.total, data.currency)
      let message = `Recorded as paid (offline) — ${totalLabel}. It's now in the To-order queue. Raise the invoice in Xero when you're ready.`

      // Optional: post the order-confirmation message on the Help Scout thread
      // (no "pay" language). Best-effort — the payment is already recorded, so a
      // send failure only softens the success note.
      if (sendConfirmation) {
        const sent = await sendOrderConfirmation()
        message = sent
          ? `${message} Order confirmation sent to the customer on Help Scout.`
          : `${message} (Couldn't send the confirmation message — you can send it from the Help Scout thread.)`
      }

      // Let the parent refresh the order row (accurate stamped amounts) while
      // this modal shows the confirmation.
      onRecorded(order.id)
      setDone(message)
    } catch {
      setError('Could not record the payment — please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  // Post the order_confirmation_link template on the proof's linked Help Scout
  // thread. send-helpscout-reply needs the current version id, so resolve it
  // first. Returns false on any miss (no version, no conversation, HS down).
  async function sendOrderConfirmation(): Promise<boolean> {
    try {
      const { data: version } = await supabase
        .from('proof_versions')
        .select('id')
        .eq('proof_id', order.proof_id)
        .eq('is_current', true)
        .maybeSingle()
      if (!version?.id) return false

      const body = renderTemplate(DEFAULT_BODIES.order_confirmation_link, {
        order_url: customerOrderUrl(order.id, order.token),
      })
      const { data, error: fnErr } = await supabase.functions.invoke<{ thread_id?: number; error?: string }>(
        'send-helpscout-reply',
        { body: { proof_id: order.proof_id, version_id: version.id, body } },
      )
      if (fnErr || !data || 'error' in data) return false

      // Record that the confirmation went out, exactly as the Stripe webhook
      // does for an online payment (000248). Without this, a hand-recorded
      // payment's confirmation is the one message we send that leaves no trace
      // of what it was — so the dashboard's activity feed can only call it "was
      // sent a reply", while the identical message on an online order names
      // itself. Awaited, not fired and forgotten: a bare `void supabase…` never
      // sends the request at all (see the lazy-builder rule in CLAUDE.md).
      //
      // Best-effort like the send itself — the customer has the message either
      // way, so a failed stamp costs the feed its label and nothing more.
      const { error: stampErr } = await supabase
        .from('orders')
        .update({ confirmation_sent_at: new Date().toISOString() })
        .eq('id', order.id)
      if (stampErr) console.error('[offline-payment] confirmation stamp failed', stampErr)
      return true
    } catch {
      return false
    }
  }

  if (done) {
    return (
      <Modal open onClose={onClose} ariaLabelledBy={headingId}>
        <div className="space-y-4">
          <h2 id={headingId} className="text-lg font-semibold text-ink">
            Order recorded as paid
          </h2>
          <div className="rounded-lg border border-in-stock bg-in-stock-soft px-3 py-2.5 text-[13px] text-ink">
            {done}
          </div>
          <div className="flex justify-end">
            <ButtonCoral onClick={onClose}>Done</ButtonCoral>
          </div>
        </div>
      </Modal>
    )
  }

  return (
    <Modal open onClose={onClose} preventClose={submitting} ariaLabelledBy={headingId}>
      <div className="space-y-4">
        <div>
          <h2 id={headingId} className="text-lg font-semibold text-ink">
            Record offline payment
          </h2>
          <p className="mt-1 text-sm text-ink-soft">{title}</p>
          {spec && <p className="text-[13px] text-ink-mute">{spec}</p>}
        </div>

        <p className="rounded-lg bg-paper-soft px-3 py-2 text-[13px] text-ink-mute">
          Records this order as paid by bank transfer. No card payment is taken, no email is sent automatically,
          and no Xero invoice is raised — you raise that in Xero yourself. The order moves to <strong>To order</strong>.
        </p>

        <Field label="Quantity" hint="How many cards the customer ordered.">
          <Input
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            placeholder="e.g. 500"
          />
        </Field>

        <Field label="Shipping" asLabel={false} hint="Live rates need the online pay page, so record shipping as free or a fixed amount.">
          <div className="flex flex-wrap gap-2">
            {([['free', 'Free shipping'], ['manual', 'Fixed amount']] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setShipping(value)}
                className={`rounded-lg border px-3 py-1.5 text-sm ${
                  shipping === value
                    ? 'border-ink bg-ink text-white'
                    : 'border-line bg-white text-ink-soft hover:border-ink/40'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {shipping === 'manual' && (
            <div className="mt-2">
              <Input
                type="number"
                min={0}
                step="0.01"
                inputMode="decimal"
                value={shippingAmount}
                onChange={(e) => setShippingAmount(e.target.value)}
                placeholder={`Shipping amount (${order.currency})`}
              />
            </div>
          )}
        </Field>

        <label className="flex items-start gap-2 text-sm text-ink-soft">
          <input
            type="checkbox"
            checked={sendConfirmation}
            onChange={(e) => setSendConfirmation(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            Also send the customer an order confirmation on the Help Scout thread (no payment is requested).
          </span>
        </label>

        {error && <p className="text-sm text-out">{error}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <ButtonGhost onClick={onClose} disabled={submitting}>
            Cancel
          </ButtonGhost>
          <ButtonCoral onClick={() => void submit()} disabled={!canSubmit}>
            {submitting ? 'Recording…' : 'Record as paid'}
          </ButtonCoral>
        </div>
      </div>
    </Modal>
  )
}
