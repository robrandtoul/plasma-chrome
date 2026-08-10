import { useState } from 'react'
import { supabase } from '../lib/supabase'

// Customer-facing "Not ready to approve?" panel on the proof page. Captures a
// face-saving reason (the learning loop) and, for a price objection, shows
// recovery offers — a cheaper same-category material (public_get_cheaper_alternatives
// RPC), the smallest-run price, and an optional discount (admin-set, off by
// default). Records via the anon proof-feedback edge function. NOT an approval
// action — the proof stays open and the customer can still approve.
//
// Behavioural design (from the conversion analysis): people rarely admit "too
// expensive" or "I don't like it" outright, so the options are worded to remove
// the awkward admission — "more than I'd budgeted", "a different direction".
//
// setDiscard mode (bundle orders Slice 3): the same panel doubles as the
// per-card "decide against this card" action on the set review page. Same
// reasons, same edge function — plus a set_discard flag so the server stamps
// proofs.set_discarded_at — but NO recovery offers: the set front door
// carries no pricing of any kind (docs/bundle-orders-spec.md §14.2).

type ReasonCode = 'price_too_high' | 'different_direction' | 'timing' | 'going_elsewhere' | 'still_thinking'

const REASONS: { code: ReasonCode; label: string; followUp: string }[] = [
  { code: 'price_too_high', label: 'The price is more than I’d budgeted', followUp: 'Let’s see if we can make it work for your budget.' },
  { code: 'different_direction', label: 'I’d like to see a different design direction', followUp: 'No problem at all — we’ll put together a fresh take. Anything specific you’d like to see?' },
  { code: 'timing', label: 'The timing isn’t right just now', followUp: 'Totally fine — we’ll keep everything on file and pick it up whenever you’re ready.' },
  { code: 'going_elsewhere', label: 'I’m going a different route / no longer need these', followUp: 'Thanks for letting us know — we’ll close this off. If anything changes, just reply.' },
  { code: 'still_thinking', label: 'I just need to think it over', followUp: 'Take your time. Is there anything we can help clarify?' },
]

interface Alt { display_name: string; code?: string; from_total: number | string }
interface Recovery {
  currency: string | null
  current_from_total: number | string | null
  alternatives: Alt[]
  discount_percent: number | string
}

function money(currency: string | null, amount: number | string | null | undefined): string {
  if (amount == null) return ''
  const n = typeof amount === 'string' ? parseFloat(amount) : amount
  if (!Number.isFinite(n)) return ''
  const sym = currency === 'EUR' ? '€' : currency === 'USD' ? '$' : '£'
  return `${sym}${n.toLocaleString('en-GB', { maximumFractionDigits: 0 })}`
}

export default function DeclineFeedbackPanel({
  proofId,
  proofVersionId,
  setDiscard = false,
  suppressRecovery = false,
  onSubmitted,
  className = '',
  id,
}: {
  proofId: string
  proofVersionId: string
  // Set review page's per-card discard (bundle orders Slice 3): different
  // copy, a set_discard flag in the payload, and no recovery offers — the
  // front door must never show pricing. Default false = the proof page's
  // behaviour, byte-for-byte.
  setDiscard?: boolean
  // Re-engagement outreach (000392). Same copy as the ordinary proof page —
  // this customer IS deciding whether to approve — but no cheaper-material
  // offer. The band two inches above says the artwork is exactly as we last
  // printed it; answering "too expensive" with a different material both
  // contradicts that and reads as an unsolicited downsell of a design they
  // chose years ago. Kept separate from setDiscard, which also changes the
  // wording.
  suppressRecovery?: boolean
  // Fires after a successful submit so the set review page can reflect the
  // card as set aside without a refetch.
  onSubmitted?: () => void
  // Extra classes on the root of every state (collapsed link, open panel,
  // thank-you note). The customer page uses this to slot the panel into its
  // mobile order-* reading sequence — the class must sit on the flex item
  // itself, so a wrapper div won't do.
  className?: string
  // Anchor for the reminder welcome-back strip's "tell us" jump. On the
  // root of every state for the same reason as className.
  id?: string
}) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState<ReasonCode | null>(null)
  const [note, setNote] = useState('')
  const [name, setName] = useState('')
  const [recovery, setRecovery] = useState<Recovery | null>(null)
  const [recoveryLoading, setRecoveryLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function pickReason(code: ReasonCode) {
    setReason(code)
    setError(null)
    // No recovery offers in setDiscard mode — the set front door carries no
    // pricing (the offer card quotes from-prices and a discount) — nor on an
    // outreach proof, where a cheaper material contradicts the page.
    if (code === 'price_too_high' && !setDiscard && !suppressRecovery) {
      setRecoveryLoading(true)
      try {
        const { data } = await supabase.rpc('public_get_cheaper_alternatives', { p_proof_id: proofId })
        setRecovery((data ?? null) as Recovery | null)
      } catch {
        setRecovery(null) // recovery is a bonus; never block the feedback
      } finally {
        setRecoveryLoading(false)
      }
    }
  }

  async function submit() {
    if (!reason || submitting) return
    setSubmitting(true)
    setError(null)
    const discountPct = recovery ? Number(recovery.discount_percent) || 0 : 0
    const recovery_offer = reason === 'price_too_high' && recovery
      ? {
          from_total: recovery.current_from_total != null ? Number(recovery.current_from_total) : null,
          cheaper_materials: (recovery.alternatives ?? []).map((a) => ({ display_name: a.display_name, from_total: Number(a.from_total) })),
          discount_percent: discountPct,
        }
      : null
    try {
      const { data, error: fnErr } = await supabase.functions.invoke<{ status?: string; error?: string }>('proof-feedback', {
        body: {
          proof_id: proofId,
          proof_version_id: proofVersionId,
          reason_code: reason,
          note: note.trim() || undefined,
          actor_name: name.trim() || undefined,
          recovery_offer,
          ...(setDiscard ? { set_discard: true } : {}),
        },
      })
      if (fnErr || data?.status !== 'ok') throw new Error(data?.error || fnErr?.message || 'Could not send')
      setDone(true)
      onSubmitted?.()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  if (done) {
    return (
      <div id={id} className={`mt-4 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-700 ${className}`}>
        {setDiscard
          ? 'Thank you — we’ve set this card aside and let the team know.'
          : 'Thank you — that’s a real help. We’ll be in touch.'}
      </div>
    )
  }

  if (!open) {
    return (
      <button
        type="button"
        id={id}
        onClick={() => setOpen(true)}
        className={`mt-4 text-sm text-gray-500 underline underline-offset-2 hover:text-gray-700 ${className}`}
      >
        {setDiscard ? 'Decide against this card?' : 'Not ready to approve just yet?'}
      </button>
    )
  }

  const selected = REASONS.find((r) => r.code === reason)
  const alts = recovery?.alternatives ?? []
  const discountPct = recovery ? Number(recovery.discount_percent) || 0 : 0

  return (
    <div id={id} className={`mt-4 rounded-xl border border-gray-200 bg-gray-50 p-4 ${className}`}>
      {!reason ? (
        <>
          <p className="text-sm font-medium text-gray-800">
            {setDiscard ? 'No problem — can you let us know why?' : 'No problem — what’s holding you back?'}
          </p>
          <p className="mt-0.5 text-xs text-gray-500">
            {setDiscard
              ? 'This sets the card aside — nothing is deleted, and the other cards aren’t affected.'
              : 'This just helps us help you — choosing a reason won’t approve or change your proof on its own.'}
          </p>
          <div className="mt-3 space-y-1.5">
            {REASONS.map((r) => (
              <button
                key={r.code}
                type="button"
                onClick={() => pickReason(r.code)}
                className="block w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-left text-sm text-gray-700 transition-colors hover:border-gray-300 hover:bg-gray-50"
              >
                {r.label}
              </button>
            ))}
          </div>
          <button type="button" onClick={() => setOpen(false)} className="mt-3 text-xs text-gray-400 hover:text-gray-600">
            Never mind
          </button>
        </>
      ) : (
        <>
          <p className="text-sm text-gray-700">{selected?.followUp}</p>

          {/* Price-objection recovery offers — never in setDiscard mode, and
              never on an outreach proof (see suppressRecovery)
              (the set front door carries no pricing). */}
          {reason === 'price_too_high' && !setDiscard && !suppressRecovery && (
            <div className="mt-3 rounded-lg border border-gray-200 bg-white p-3 text-sm">
              {recoveryLoading ? (
                <p className="text-gray-500">Finding some options…</p>
              ) : (
                <>
                  <p className="font-medium text-gray-800">A few ways to bring the cost down:</p>
                  <ul className="mt-2 space-y-1.5 text-gray-700">
                    {recovery?.current_from_total != null && (
                      <li>• Smaller runs of this design start from <strong>{money(recovery.currency, recovery.current_from_total)}</strong>.</li>
                    )}
                    {alts.length > 0 && (
                      <li>
                        • The same design also comes in{' '}
                        {alts.map((a, i) => (
                          <span key={a.display_name}>
                            {i > 0 ? ', ' : ''}
                            <strong>{a.display_name}</strong> from {money(recovery?.currency ?? null, a.from_total)}
                          </span>
                        ))}
                        .
                      </li>
                    )}
                    {discountPct > 0 && (
                      <li>• We can offer <strong>{discountPct}% off</strong> if you order this week.</li>
                    )}
                  </ul>
                  <p className="mt-2 text-xs text-gray-500">
                    Send this and we’ll follow up with the exact figures — no obligation.
                  </p>
                </>
              )}
            </div>
          )}

          <label className="mt-3 block text-xs text-gray-500">
            Anything to add? (optional)
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              className="mt-1 w-full resize-none rounded-lg border border-gray-200 px-2.5 py-1.5 text-sm text-gray-800 focus:border-gray-400 focus:outline-none"
              placeholder={reason === 'different_direction' ? 'e.g. simpler, bolder, different colour…' : ''}
            />
          </label>
          <label className="mt-2 block text-xs text-gray-500">
            Your name (optional)
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-sm text-gray-800 focus:border-gray-400 focus:outline-none"
            />
          </label>

          {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              onClick={submit}
              disabled={submitting}
              className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
            >
              {submitting ? 'Sending…' : 'Send'}
            </button>
            <button type="button" onClick={() => { setReason(null); setRecovery(null); setError(null) }} className="text-xs text-gray-400 hover:text-gray-600">
              ← Back
            </button>
          </div>
        </>
      )}
    </div>
  )
}
