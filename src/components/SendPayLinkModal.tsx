import { useEffect, useState } from 'react'
import Modal from './Modal'
import { ButtonCoral, ButtonGhost } from '../design'
import { supabase } from '../lib/supabase'
import { renderTemplate, DEFAULT_BODIES } from '../lib/replyTemplates'
import { customerOrderUrl } from '../lib/customerOrderUrl'

// Send (or re-send) an order's pay link on its Help Scout thread.
//
// WHY THIS EXISTS. The Orders page had no way to send anything. Reactivating
// an expired link pushed the expiry out fourteen days and wrote an audit row —
// and told the customer nothing. To let them know their link worked again the
// designer had to copy it, open Help Scout, find the thread and paste it by
// hand. The automation couldn't cover either: an expired link has by
// definition spent its reminders, so the card reads "All 3 reminders sent" and
// nothing will chase it. A live link nobody knows about is a stalled sale.
//
// Same send path as the order builder's own "Send to customer"
// (send-helpscout-reply, anchored on the proof + its current version) and the
// same admin-editable `order_payment_link` template, so a re-send reads
// exactly like the original.

interface Props {
  open: boolean
  onClose: () => void
  order: {
    id: string
    proof_id: string
    token: string | null
    current_version_id?: string | null
  }
  /** Shown in the heading so the designer can see who this is going to. */
  customerLabel: string
  /** True when a link has gone out before — changes the wording to a re-send. */
  resend: boolean
  /** Called after a successful send so the page can refresh its rows. */
  onSent: () => void
}

export default function SendPayLinkModal({
  open, onClose, order, customerLabel, resend, onSent,
}: Props) {
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)

  // Compose from the admin-editable template each time it opens, so an edit in
  // Admin → Content shows up here without a redeploy.
  useEffect(() => {
    if (!open) return
    setSent(false)
    setError(null)
    let cancelled = false
    const url = order.token ? customerOrderUrl(order.id, order.token) : ''
    void supabase
      .from('reply_templates')
      .select('id, body')
      .eq('id', 'order_payment_link')
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return
        const body = data?.body ?? DEFAULT_BODIES.order_payment_link
        setMessage(renderTemplate(body, { order_url: url }))
      })
    return () => { cancelled = true }
  }, [open, order.id, order.token])

  async function send() {
    if (!message.trim()) return
    setSending(true)
    setError(null)
    try {
      const { data, error: fnErr } = await supabase.functions.invoke<{ thread_id?: number; error?: string }>(
        'send-helpscout-reply',
        { body: { proof_id: order.proof_id, version_id: order.current_version_id ?? null, body: message } },
      )
      if (fnErr || !data || 'error' in data) {
        // The edge function reports failures in the response body, which
        // supabase-js hides behind a non-2xx context — dig it out so the
        // designer sees the real reason rather than a generic failure.
        let msg = (data as { error?: string } | null)?.error ?? null
        const ctx = (fnErr as { context?: Response } | null)?.context
        if (!msg && ctx && typeof ctx.json === 'function') {
          try { const b = await ctx.json(); if (b && typeof b.error === 'string') msg = b.error } catch { /* not JSON */ }
        }
        setError(msg ?? 'Could not send via Help Scout — you can copy the link and send it manually.')
        return
      }
      setSent(true)
      onSent()
    } catch {
      setError('Could not send via Help Scout — you can copy the link and send it manually.')
    } finally {
      setSending(false)
    }
  }

  if (!open) return null

  return (
    <Modal
      open
      onClose={onClose}
      preventClose={sending}
      ariaLabel={resend ? 'Re-send the pay link' : 'Send the pay link'}
      panelClassName="w-full max-w-2xl rounded-2xl bg-surface p-6 shadow-xl"
    >
      <h2 className="text-base font-semibold text-ink">
        {resend ? 'Re-send the pay link' : 'Send the pay link'}
      </h2>
      <p className="mt-1 text-[13px] text-ink-mute">
        Posts on {customerLabel}’s Help Scout thread, the same way the original link was sent.
      </p>

      {sent ? (
        <div className="mt-5 rounded-lg border border-in-stock bg-in-stock-soft px-4 py-3">
          <p className="text-sm text-ink">Sent. The customer has the link on their thread.</p>
          <div className="mt-3 flex justify-end">
            <ButtonCoral size="sm" onClick={onClose}>Done</ButtonCoral>
          </div>
        </div>
      ) : (
        <>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={10}
            aria-label="Message to the customer"
            className="mt-4 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink focus:border-[var(--c-focus)] focus:outline-2 focus:outline-offset-1 focus:outline-[var(--c-focus)]"
          />
          {!order.token && (
            <p className="mt-2 rounded-lg bg-low-soft px-3 py-2 text-[13px] text-ink">
              This order has no pay-link token, so there is no link to include. Cancel and create a
              fresh order link instead.
            </p>
          )}
          {error && (
            <p className="mt-3 rounded-lg bg-out-soft px-3 py-2 text-[13px] text-out">{error}</p>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <ButtonGhost size="sm" onClick={onClose} disabled={sending}>Cancel</ButtonGhost>
            <ButtonCoral size="sm" onClick={() => void send()} disabled={sending || !message.trim() || !order.token}>
              {sending ? 'Sending…' : resend ? 'Re-send link' : 'Send link'}
            </ButtonCoral>
          </div>
        </>
      )}
    </Modal>
  )
}
