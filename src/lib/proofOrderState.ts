// "Ready to order?" — what the customer proof page says about ordering.
//
// Why this exists: /p/:id shows a price grid and a "Need a price for a
// specific quantity?" lookup, and no way to order — because ordering happens
// through a pay link we email, on a separate token-gated page. A customer who
// has just approved and wants to buy reads that as broken. One did, on
// 2026-07-30: "how do I add the cards into my cart for ordering? I cant click
// on any of the quantities? ... still have nowhere to select add to order or
// add to cart?" Every clause was accurate.
//
// The page deliberately never receives the pay link itself — see the header
// of migration 000367 and src/lib/customerProofUrl.ts:26-34 for why a bearer
// token must not ride a broadly-shared /p/ link. It receives a bare state
// from proofs.public_get_proof_order_state and turns it into a sentence.
//
// Copy lives here rather than in the component, and is asserted verbatim in
// proofOrderState.test.ts, so a wording change is a deliberate edit with a
// failing test behind it — the same rule previousSpec.ts follows for the two
// pay pages.

// Mirrors the `state` values built by proofs.public_get_proof_order_state.
export type ProofOrderState = 'awaiting_payment' | 'link_expired' | 'paid' | 'none'

export interface ProofOrderStatePayload {
  state: ProofOrderState
  // Present only on 'awaiting_payment'. ISO timestamp of the live link's
  // deadline — the customer's own, and nothing is derivable from it.
  expiresAt: string | null
  // When this customer last asked for the link to be re-sent (000369). Echoed
  // back so a reload shows the acknowledgement rather than re-arming the
  // button — the population using it is people refreshing while they hunt for
  // an email, and an in-session-only "sent" would fan out into their thread.
  resendRequestedAt: string | null
}

export interface ReadyToOrderCopy {
  eyebrow: string
  heading: string
  body: string
  // When set, the component renders "Your payment link is valid until <date>"
  // beneath the body, formatting the date itself.
  expiresAt: string | null
}

// Copy for the "send it again" action (000369). Grouped here so the component
// holds no strings, and asserted verbatim by proofOrderState.test.ts.
export const RESEND_COPY = {
  action: 'Email it to me again',
  sending: 'Sending…',
  // ⚠ This is the ONE place we may claim a send, because unlike the card's
  // main body this describes an action we just performed and confirmed. Even
  // so it promises the THREAD, not the inbox — we can't see their mail.
  sent: 'Sent — it’s on its way to the email address we have for you. Do check your spam folder if it doesn’t appear.',
  error: 'We couldn’t send that just now. Please reply to any message from us and we’ll get it to you.',
} as const

const VALID_STATES: ProofOrderState[] = ['awaiting_payment', 'link_expired', 'paid', 'none']

// Defensive parse of the RPC payload. Anything unrecognised returns null,
// which renders no panel at all — a page that has always worked without this
// feature must never break because the RPC changed shape or failed.
export function parseProofOrderState(raw: unknown): ProofOrderStatePayload | null {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  const state = obj.state
  if (typeof state !== 'string') return null
  if (!VALID_STATES.includes(state as ProofOrderState)) return null
  const expires = obj.expires_at
  const resend = obj.resend_requested_at
  return {
    state: state as ProofOrderState,
    expiresAt: typeof expires === 'string' && expires.length > 0 ? expires : null,
    resendRequestedAt: typeof resend === 'string' && resend.length > 0 ? resend : null,
  }
}

// How long the acknowledgement stands before the button re-arms. Matches
// COOLDOWN_MINUTES in supabase/functions/resend-pay-link — the server is the
// only real gate (it refuses inside the window regardless), so this exists to
// stop the UI offering an action that would silently do nothing.
export const RESEND_COOLDOWN_MINUTES = 10

// Was the link re-sent recently enough that we should still be saying so?
// `now` is injectable for the test; production passes nothing.
export function resendIsRecent(iso: string | null, now: number = Date.now()): boolean {
  if (!iso) return false
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return false
  const age = now - t
  // Guard the future too: a clock skew shouldn't strand the button forever.
  return age >= 0 && age < RESEND_COOLDOWN_MINUTES * 60_000
}

// Whether the "send it again" action should be offered at all. Only a live
// link can be re-sent — an expired one needs a new link, which is a designer's
// job, and there is nothing to send when none exists or it's already paid.
export function canResendPayLink(payload: ProofOrderStatePayload | null): boolean {
  return payload?.state === 'awaiting_payment'
}

const NOTHING_TO_ADD =
  'This page is for checking your design, so there’s nothing to add to a basket here.'

// ⚠ Describes how ordering works — deliberately NOT "we've emailed you a
// payment link". `awaiting_payment` only means an order row is live and
// unexpired, which is NOT the same as the customer having been sent
// anything: create-order stamps status 'sent' at row-creation time and
// contains no Help Scout call at all, the actual send is a separate manual
// step (SendPayLinkModal), and a combined-payment group has no send step
// whatsoever — only "Copy combined link" on the Orders page. Asserting a
// send we cannot verify would send a customer hunting for an email that may
// never have left, which is the precise failure this card exists to end.
//
// It also must not promise a quantity choice: the pay page only shows a
// quantity chooser when the designer left quantity open, and a custom-quote
// order has no chooser at all.
const HOW_ORDERING_WORKS = 'Ordering is done through a payment link we send you by email.'

// The one nudge that works whatever went wrong: replying to ANY message from
// us reaches the same Help Scout thread. Deliberately not "reply to that
// email" — someone who can't find the email can't reply to it.
const ASK_AGAIN = 'Just reply to any message from us and we’ll send it over.'

/**
 * The panel to show, or null for no panel.
 *
 * `proofStatus` gates the no-order case only: an approved proof with no order
 * yet is exactly the customer who needs telling how to buy, whereas a proof
 * still being worked on should not be nudged towards ordering mid-revision.
 * Typed as a plain string so this module stays free of the page's types.
 */
export function readyToOrderCopy(
  payload: ProofOrderStatePayload | null,
  proofStatus: string | null | undefined,
): ReadyToOrderCopy | null {
  if (!payload) return null

  switch (payload.state) {
    case 'awaiting_payment':
      return {
        eyebrow: 'Ordering',
        heading: 'Ready to order?',
        // No "reply to any message from us" here, unlike the other two
        // states: this is the one state where a live link exists to re-send,
        // so the button below is the better answer. The reply route survives
        // as the button's own error copy (RESEND_COPY.error).
        body: `${NOTHING_TO_ADD} ${HOW_ORDERING_WORKS} Can’t find yours?`,
        expiresAt: payload.expiresAt,
      }

    case 'link_expired':
      return {
        eyebrow: 'Ordering',
        heading: 'Your payment link has expired',
        // "links don't stay live indefinitely", not "the link we sent" — the
        // same unverifiable-send problem as above.
        body: `Prices and delivery costs move over time, so payment links don’t stay live indefinitely. ${ASK_AGAIN}`,
        expiresAt: null,
      }

    // Already paid for. The proof page is not the order page — status and
    // delivery live on the pay page, which they reached to pay — so say
    // nothing rather than duplicate it half-accurately here.
    case 'paid':
      return null

    case 'none':
      if (proofStatus !== 'approved') return null
      return {
        eyebrow: 'Ordering',
        heading: 'Ready to order?',
        body: `${NOTHING_TO_ADD} ${HOW_ORDERING_WORKS} ${ASK_AGAIN}`,
        expiresAt: null,
      }
  }
}
