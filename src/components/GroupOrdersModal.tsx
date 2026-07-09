import { useEffect, useState } from 'react'
import Modal from './Modal'
import { Field, Input, ButtonCoral, ButtonGhost } from '../design'
import { supabase } from '../lib/supabase'
import { customerOrderGroupUrl } from '../lib/customerOrderUrl'
import { renderTemplate, DEFAULT_BODIES } from '../lib/replyTemplates'
import { SHIP_COUNTRIES } from '../lib/shipCountries'

// Combine-payments modal (bundle orders Slice 2, docs/bundle-orders-spec.md
// §13). Opened from the Orders page with the awaiting-payment orders the
// designer selected: confirms the grouping rules that only a human can check
// (one payer, one delivery address), captures the group's combined-shipping
// billing choice, then calls the order-group edge function and — mirroring
// OrderBuilderModal's success step — offers the ONE pay link for sending on
// the customer's Help Scout conversation.

type ShippingTreatment = 'full_cost' | 'goodwill' | 'free' | 'manual'

const TREATMENT_OPTIONS: { value: ShippingTreatment; label: string }[] = [
  { value: 'full_cost', label: 'Charge full cost' },
  { value: 'goodwill', label: 'Goodwill (subsidise)' },
  { value: 'free', label: 'Free shipping' },
  { value: 'manual', label: 'Manual amount' },
]

// The slice of each selected order the modal needs — computed by the Orders
// page so this component doesn't re-derive display labels.
export interface GroupCandidate {
  id: string
  proofId: string
  label: string // customer (company/contact)
  spec: string // material · variant · finish line
  quantity: number | null
  currency: string
  reference: string | null
  shipDestCountry: string | null
  hasHelpScoutConversation: boolean
}

export default function GroupOrdersModal({
  candidates,
  onClose,
  onCreated,
}: {
  candidates: GroupCandidate[]
  onClose: () => void
  onCreated?: () => void
}) {
  const [shippingTreatment, setShippingTreatment] = useState<ShippingTreatment>('full_cost')
  const [shippingCharged, setShippingCharged] = useState('')
  const [shippingDiscountPercent, setShippingDiscountPercent] = useState('')
  // Destination hint: pre-fill when every selected order that has a hint
  // agrees on it (the group ships as ONE parcel to one address).
  const [shipDestCountry, setShipDestCountry] = useState(() => {
    const hints = [...new Set(candidates.map((c) => c.shipDestCountry).filter((c): c is string => !!c))]
    return hints.length === 1 ? hints[0] : ''
  })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ id: string; token: string; payment_reference: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [message, setMessage] = useState('')
  const [templateBody, setTemplateBody] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)

  const currencies = [...new Set(candidates.map((c) => c.currency))]
  const currencyMismatch = currencies.length > 1
  const tooFew = candidates.length < 2

  // The Help Scout conversation the ONE pay link goes out on: the first
  // selected order's proof (the modal names the customer so the designer can
  // see where it will land). Orders on proofs without a linked conversation
  // fall back to copy-the-link.
  const sendTarget = candidates.find((c) => c.hasHelpScoutConversation) ?? null

  useEffect(() => {
    let cancelled = false
    void supabase
      .from('reply_templates')
      .select('id, body')
      .eq('id', 'order_payment_link')
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled && data && typeof (data as { body?: string }).body === 'string') {
          setTemplateBody((data as { body: string }).body)
        }
      })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!result) return
    const url = customerOrderGroupUrl(result.id, result.token)
    setMessage(renderTemplate(templateBody ?? DEFAULT_BODIES.order_payment_link, { order_url: url }))
  }, [result, templateBody])

  async function submit() {
    setError(null)
    if (tooFew) {
      setError('Pick at least two orders to combine.')
      return
    }
    if (currencyMismatch) {
      setError(`These orders use different currencies (${currencies.join(', ')}) — a combined payment needs one currency.`)
      return
    }
    if (shippingTreatment === 'manual') {
      const s = Number(shippingCharged)
      if (!Number.isFinite(s) || s < 0) {
        setError('Enter a manual shipping amount (zero or greater).')
        return
      }
    }
    if (shippingTreatment === 'goodwill') {
      const d = Number(shippingDiscountPercent)
      if (!Number.isFinite(d) || d < 0 || d > 100) {
        setError('Enter a goodwill discount between 0 and 100%.')
        return
      }
    }
    setSubmitting(true)
    try {
      const { data, error: fnErr } = await supabase.functions.invoke<
        { id: string; token: string; payment_reference: string } | { error: string }
      >('order-group', {
        body: {
          action: 'create',
          order_ids: candidates.map((c) => c.id),
          shipping_treatment: shippingTreatment,
          shipping_charged: shippingTreatment === 'manual' ? Number(shippingCharged) : undefined,
          shipping_discount_percent: shippingTreatment === 'goodwill' ? Number(shippingDiscountPercent) : undefined,
          ship_dest_country: shipDestCountry || undefined,
        },
      })
      if (fnErr || !data || 'error' in data) {
        // The edge function's refusals are written for humans (they name the
        // offending order) — surface them verbatim when we can dig them out.
        let msg = (data as { error?: string } | null)?.error ?? null
        const ctx = (fnErr as { context?: Response } | null)?.context
        if (!msg && ctx && typeof ctx.json === 'function') {
          try { const b = await ctx.json(); if (b && typeof b.error === 'string') msg = b.error } catch { /* not JSON */ }
        }
        setError(msg ?? 'Could not create the combined payment. Please try again.')
        return
      }
      setResult({ id: data.id, token: data.token, payment_reference: data.payment_reference })
      onCreated?.()
    } catch {
      setError('Could not create the combined payment. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  async function copyLink() {
    if (!result) return
    try {
      await navigator.clipboard.writeText(customerOrderGroupUrl(result.id, result.token))
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard blocked — the link stays visible for manual copy.
    }
  }

  // Send the one pay link on the target proof's Help Scout conversation — the
  // same send-helpscout-reply path the order builder uses, which needs the
  // proof's current version id (resolved here on demand).
  async function sendToCustomer() {
    if (!result || !sendTarget || !message.trim()) return
    setSendError(null)
    setSending(true)
    try {
      const { data: curV } = await supabase
        .from('proof_versions')
        .select('id')
        .eq('proof_id', sendTarget.proofId)
        .eq('is_current', true)
        .maybeSingle()
      const versionId = (curV as { id?: string } | null)?.id ?? null
      if (!versionId) {
        setSendError('Couldn’t resolve the proof version to send on — copy the link and send it manually.')
        return
      }
      const { data, error: fnErr } = await supabase.functions.invoke<{ thread_id?: number; error?: string }>(
        'send-helpscout-reply',
        { body: { proof_id: sendTarget.proofId, version_id: versionId, body: message } },
      )
      if (fnErr || !data || 'error' in data) {
        let msg = (data as { error?: string } | null)?.error ?? null
        const ctx = (fnErr as { context?: Response } | null)?.context
        if (!msg && ctx && typeof ctx.json === 'function') {
          try { const b = await ctx.json(); if (b && typeof b.error === 'string') msg = b.error } catch { /* not JSON */ }
        }
        setSendError(msg ?? 'Could not send the link via Help Scout — you can copy it and send it manually.')
        return
      }
      setSent(true)
    } catch {
      setSendError('Could not send the link via Help Scout — you can copy it and send it manually.')
    } finally {
      setSending(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      ariaLabel="Combine into one payment"
      panelClassName="w-full max-w-lg md:max-h-[88vh] overflow-y-auto rounded-2xl bg-white shadow-xl"
    >
      {result ? (
        // ── Success — one link for the whole group ─────────────────
        <div className="p-6">
          <h2 className="text-lg font-semibold text-ink">Combined payment created</h2>
          <p className="mt-1 text-sm text-ink-soft">
            Reference <span className="font-medium text-ink">{result.payment_reference}</span> — one link covering{' '}
            {candidates.length} orders.
          </p>

          {sent ? (
            <>
              <div className="mt-4 rounded-lg border border-in-stock bg-in-stock-soft px-3 py-2.5 text-[13px] text-ink">
                Payment link sent to the customer on Help Scout. They&rsquo;ll get it by email.
              </div>
              <div className="mt-5 flex items-center justify-end gap-2">
                <ButtonGhost onClick={copyLink}>{copied ? 'Copied' : 'Copy link'}</ButtonGhost>
                <ButtonCoral onClick={onClose}>Done</ButtonCoral>
              </div>
            </>
          ) : sendTarget ? (
            <>
              <p className="mt-3 text-[13px] text-ink-soft">
                Send the one payment link on <span className="font-medium text-ink">{sendTarget.label}</span>&rsquo;s
                Help Scout conversation:
              </p>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={8}
                className="mt-2 w-full rounded-lg border border-line bg-surface p-3 text-sm text-ink focus:border-[var(--c-brand)] focus:outline-2 focus:outline-offset-1 focus:outline-[var(--c-brand)]"
              />
              {sendError && (
                <div className="mt-2 rounded-lg border border-out bg-out-soft px-3 py-2 text-[13px] text-out">{sendError}</div>
              )}
              <div className="mt-4 flex items-center justify-end gap-2">
                <ButtonGhost onClick={copyLink}>{copied ? 'Copied' : 'Copy link'}</ButtonGhost>
                <ButtonGhost onClick={onClose} disabled={sending}>Close</ButtonGhost>
                <ButtonCoral onClick={() => void sendToCustomer()} disabled={sending || !message.trim()}>
                  {sending ? 'Sending…' : 'Send to customer'}
                </ButtonCoral>
              </div>
            </>
          ) : (
            <>
              <div className="mt-4 rounded-lg border border-line bg-canvas p-3">
                <p className="break-all font-mono text-[12px] text-ink-soft">{customerOrderGroupUrl(result.id, result.token)}</p>
              </div>
              <p className="mt-2 text-[12px] text-ink-mute">
                None of these proofs has a linked Help Scout conversation, so copy the link and send it to the customer yourself.
              </p>
              <div className="mt-5 flex items-center justify-end gap-2">
                <ButtonGhost onClick={copyLink}>{copied ? 'Copied' : 'Copy link'}</ButtonGhost>
                <ButtonCoral onClick={onClose}>Done</ButtonCoral>
              </div>
            </>
          )}
        </div>
      ) : (
        // ── Form — confirm the rules + the combined-shipping choice ─
        <div className="p-6">
          <h2 className="text-lg font-semibold text-ink">Combine into one payment</h2>
          <p className="mt-1 text-sm text-ink-soft">
            One pay link, one payment, one invoice — each order still goes into production on its own.
          </p>

          <div className="mt-4 rounded-lg border border-line bg-canvas p-3">
            <ul className="space-y-1.5 text-[13px] text-ink">
              {candidates.map((c) => (
                <li key={c.id} className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0">
                    <span className="font-medium">{c.label}</span>
                    <span className="text-ink-soft"> — {c.spec}{c.quantity != null ? ` · ${c.quantity.toLocaleString()} cards` : ''}</span>
                  </span>
                  <span className="shrink-0 text-[12px] text-ink-mute">{c.reference ?? ''} · {c.currency}</span>
                </li>
              ))}
            </ul>
          </div>

          {currencyMismatch && (
            <div className="mt-3 rounded-lg border border-out bg-out-soft px-3 py-2 text-[13px] text-out">
              These orders use different currencies ({currencies.join(', ')}). A combined payment needs one currency — deselect the odd one out.
            </div>
          )}

          <div className="mt-3 rounded-lg border border-low bg-low-soft px-3 py-2.5 text-[13px] text-ink">
            Check before you combine: <span className="font-medium">one person pays</span>, and everything ships together{' '}
            <span className="font-medium">to one address</span>. Different contacts at the same company are fine — the payer at
            checkout is what matters. Split deliveries or split payers need separate pay links.
          </div>

          <div className="mt-4 space-y-4">
            <Field label="Combined shipping">
              <div className="flex flex-wrap gap-1.5">
                {TREATMENT_OPTIONS.map((t) => (
                  <button
                    key={t.value}
                    type="button"
                    onClick={() => setShippingTreatment(t.value)}
                    className={`rounded-full px-3 py-1.5 text-[12px] font-medium ring-1 transition-colors ${
                      shippingTreatment === t.value ? 'bg-ink text-surface ring-ink' : 'text-ink-soft ring-line hover:bg-canvas'
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-[12px] text-ink-mute">
                Billed once for the whole order — one parcel to one address. A card dispatched separately later doesn&rsquo;t re-bill shipping.
              </p>
            </Field>

            {shippingTreatment === 'manual' && (
              <Field label={`Shipping amount (${currencies[0] ?? 'GBP'})`}>
                <Input value={shippingCharged} onChange={(e) => setShippingCharged(e.target.value)} inputMode="decimal" placeholder="e.g. 25.00" />
              </Field>
            )}
            {shippingTreatment === 'goodwill' && (
              <Field label="Goodwill discount (% off the live rate)">
                <Input value={shippingDiscountPercent} onChange={(e) => setShippingDiscountPercent(e.target.value)} inputMode="decimal" placeholder="e.g. 50" />
              </Field>
            )}

            <Field label="Destination country (pre-fills the pay page)">
              <select
                value={shipDestCountry}
                onChange={(e) => setShipDestCountry(e.target.value)}
                className="h-[38px] w-full rounded-[8px] border border-line bg-surface px-3 text-sm text-ink focus:border-[var(--c-brand)] focus:outline-2 focus:outline-offset-1 focus:outline-[var(--c-brand)]"
              >
                <option value="">Customer enters at checkout</option>
                {SHIP_COUNTRIES.map((c) => (<option key={c.code} value={c.code}>{c.name}</option>))}
              </select>
            </Field>
          </div>

          {error && (
            <div className="mt-4 rounded-lg border border-out bg-out-soft px-3 py-2 text-[13px] text-out">{error}</div>
          )}

          <div className="mt-5 flex items-center justify-end gap-2">
            <ButtonGhost onClick={onClose} disabled={submitting}>Cancel</ButtonGhost>
            <ButtonCoral onClick={() => void submit()} disabled={submitting || tooFew || currencyMismatch}>
              {submitting ? 'Creating…' : `Create one payment link (${candidates.length})`}
            </ButtonCoral>
          </div>
        </div>
      )}
    </Modal>
  )
}
