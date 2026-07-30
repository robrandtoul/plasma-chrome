// "Ready to order?" — the customer proof page's signpost to the pay link.
//
// The proof page shows prices but cannot take an order: ordering happens on
// a separate, token-gated pay page whose link we email. Without this card the
// page looks broken to anyone who has approved and wants to buy — see the
// verbatim customer report in src/lib/proofOrderState.ts.
//
// Deliberately a signpost and not a link. The pay-page token must never ride
// a /p/ URL, which team sharing hands out freely (migration 000367,
// src/lib/customerProofUrl.ts:26-34), so this card carries no href at all —
// the words are the whole feature. All copy lives in proofOrderState.ts and
// is asserted verbatim by its test.
//
// Chrome mirrors the "About this proof" card in CustomerProofPage (icon +
// eyebrow + prose in a bordered surface card) so it reads as part of the
// page rather than an advert, with the brand-toned eyebrow the pricing
// callouts use.

import { CreditCard } from 'lucide-react'
import { ButtonInk } from '../design'
import { RESEND_COPY, type ReadyToOrderCopy } from '../lib/proofOrderState'

export type ResendState = 'idle' | 'sending' | 'sent' | 'error'

interface Props {
  copy: ReadyToOrderCopy
  // Mobile ordering slot. The page's columns are `display: contents` below
  // lg, so every card is a direct flex child of <main> and is sequenced by
  // its order-N class; without one it defaults to slot 0 and jumps above the
  // artwork on phones (the bug DeclineFeedbackPanel shipped with once).
  className?: string
  // The "send it again" action (000369). Omit both and the card renders
  // exactly as it did before the button existed — which is what the
  // link_expired and no-order states want, since there is nothing to re-send.
  onResend?: () => void
  resendState?: ResendState
}

export function ReadyToOrderPanel({ copy, className, onResend, resendState = 'idle' }: Props) {
  const expiry = formatExpiry(copy.expiresAt)
  const showResend = typeof onResend === 'function'

  return (
    <div
      className={`rounded-[10px] bg-surface border border-line p-5 flex items-start gap-3${className ? ` ${className}` : ''}`}
    >
      <CreditCard size={18} aria-hidden="true" className="text-brand mt-0.5 shrink-0" />
      <div className="min-w-0">
        <span className="eyebrow text-brand block mb-1.5">{copy.eyebrow}</span>
        <p className="text-[15px] leading-snug text-ink font-medium m-0">{copy.heading}</p>
        <p className="mt-1.5 text-[13px] leading-[1.6] text-ink-soft m-0">{copy.body}</p>
        {expiry && (
          <p className="mt-1.5 text-[12px] text-ink-mute m-0">
            Your payment link is valid until {expiry}.
          </p>
        )}
        {showResend && (
          <div className="mt-3">
            {resendState === 'sent' ? (
              // Terminal for the cooldown window, and driven by the SERVER's
              // stamp rather than in-session state, so a reload keeps saying
              // this instead of re-arming the button — the people using it are
              // refreshing while they hunt for the email.
              <p className="text-[13px] leading-[1.6] text-ink m-0">{RESEND_COPY.sent}</p>
            ) : (
              <>
                <ButtonInk
                  size="sm"
                  busy={resendState === 'sending'}
                  onClick={onResend}
                >
                  {resendState === 'sending' ? RESEND_COPY.sending : RESEND_COPY.action}
                </ButtonInk>
                {resendState === 'error' && (
                  <p className="mt-1.5 text-[13px] leading-[1.6] text-out m-0">{RESEND_COPY.error}</p>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// A malformed timestamp must not render "Invalid Date" at a customer, and
// must not throw either — the line simply drops.
function formatExpiry(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
}

export default ReadyToOrderPanel
