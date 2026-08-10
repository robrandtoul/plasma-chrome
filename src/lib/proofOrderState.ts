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

import { isTrackingStage, stageLabel, stageLine, type TrackingStage } from './orderTracking'
import { parseReengagementContext, type ReengagementContext } from './reengagement'

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
  // Where the order has got to (000371) — the same projection the pay page
  // reads, so the two surfaces can't tell one customer two different stories.
  // Null when the order isn't paid, when a designer has switched customer
  // tracking off in Admin → Settings, or when the Stock Control job was
  // cancelled. Never accompanied by a tracking NUMBER here; see 000371.
  stage: TrackingStage | null
  // Whether this parcel's carrier reports delivery. Null before dispatch.
  // Drives the length of the progress rail — see src/lib/orderTracking.ts.
  deliveryTracked: boolean | null
  // When it actually went (000375). Only ever spoken aloud on a parcel whose
  // journey ENDS at dispatch — a carrier that never confirms delivery — where
  // the alternative is telling someone their cards are still travelling weeks
  // after they arrived. A date, never a handle: 000371's refusal of the
  // tracking number stands.
  shippedAt: string | null
  // May this customer ask for more of these cards (000372)? The whole gate —
  // master switch, paid, no live link, approved, and the quiet window since
  // delivery or dispatch — resolved server-side into one boolean, so the
  // window can change without a frontend deploy.
  reorderAvailable: boolean
  // When someone last asked, echoed back so a reload shows the
  // acknowledgement rather than re-arming the button, and a colleague can see
  // it has already been done. Same idea as resendRequestedAt.
  reorderRequestedAt: string | null
  // The reorder project raised from this one (000374), once it exists AND is
  // safe to name — approved, or sent. Null while a designer is mid-build, and
  // null for an abandoned one. This is what stops the bookmark going stale:
  // the old page becomes a hub pointing at whatever is current.
  reorderProofId: string | null
  // The display-safe re-engagement snapshot (000392), present only when the
  // Reorder desk created this project — i.e. we approached the customer rather
  // than the other way round. Its presence is what lets /p/:id greet a past
  // customer instead of interrogating them like someone who commissioned new
  // work. Null on every ordinary proof and on any deployment predating 000392.
  reengagement: ReengagementContext | null
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
  const stage = obj.stage
  const tracked = obj.delivery_tracked
  return {
    state: state as ProofOrderState,
    expiresAt: typeof expires === 'string' && expires.length > 0 ? expires : null,
    resendRequestedAt: typeof resend === 'string' && resend.length > 0 ? resend : null,
    // An unrecognised stage degrades to null (no progress shown) rather than
    // rendering an unknown label — this page worked without any of this, and
    // must keep working if the RPC grows a stage the bundle doesn't know.
    stage: isTrackingStage(stage) ? stage : null,
    deliveryTracked: typeof tracked === 'boolean' ? tracked : null,
    shippedAt:
      typeof obj.shipped_at === 'string' && obj.shipped_at.length > 0 ? obj.shipped_at : null,
    // Defaults false, so an older RPC (or a failed read) hides the panel
    // rather than offering an action the server would refuse.
    reorderAvailable: obj.reorder_available === true,
    reorderRequestedAt:
      typeof obj.reorder_requested_at === 'string' && obj.reorder_requested_at.length > 0
        ? obj.reorder_requested_at
        : null,
    reorderProofId:
      typeof obj.reorder_proof_id === 'string' && obj.reorder_proof_id.length > 0
        ? obj.reorder_proof_id
        : null,
    // Allow-listed field-by-field by parseReengagementContext, so a future
    // column on the register can't reach the customer by riding along.
    reengagement: parseReengagementContext(obj.reengagement),
  }
}

// ── The reorder panel (000372) ──────────────────────────────────────────────
//
// Copy lives here with the rest, and is asserted verbatim by the test, so a
// wording change is a deliberate edit with a failing test behind it.
//
// ⚠ Nothing here may promise a price, a date, or that an order has been
// placed. The customer is asking; a designer decides and sends the link. The
// panel's job is to make asking easy and to be honest that it is an ask.
export const REORDER_COPY = {
  eyebrow: 'Need more?',
  heading: 'Order these again',
  body: 'Tell us how many you need and we’ll send you a payment link. Prices are on this page and are current.',
  quantityLabel: 'How many do you need?',
  quantityPlaceholder: 'e.g. 500',
  noteLabel: 'Anything changed? (optional)',
  notePlaceholder: 'New name, different details, a change of address…',
  // Deliberately not "changes cost more" — whether a change needs a fresh
  // proof round is a designer's call, and pre-judging it here would either
  // over-promise or put someone off mentioning something that matters.
  noteHint: 'If anything has changed we’ll send a fresh proof to approve first.',
  // ⚠ Names no outcome, and cannot. This form has TWO inputs, and the second
  // one — "Anything changed?" — decides what actually happens next: nothing
  // changed goes straight to a payment link, anything changed needs a fresh
  // proof round first, which is days, not minutes. Only the designer can tell
  // which, by reading the note. So a button promising either one is wrong
  // half the time.
  //
  // "Request a payment link" was the first attempt and had exactly that
  // fault. Before it, "Ask us to reorder" had three others: it made US the
  // one reordering when the customer is the one buying, "ask us to" put a
  // paying customer in the position of requesting permission, and it named
  // nothing at all.
  //
  // "Send my request" is true in both branches, keeps the verb-first shape of
  // "Request changes" (the button they have already used on this page), and
  // "my" makes it theirs rather than a favour asked of us. The outcome is
  // stated where it CAN be qualified — the body copy and the note hint
  // directly above, both of which they read before reaching this.
  //
  // A label that changed as they typed in the note box was considered and
  // rejected: a control relabelling itself under the cursor is unsettling,
  // and a note is not necessarily a change ("same as before, thanks").
  action: 'Send my request',
  sending: 'Sending…',
  // ⚠ Three acknowledgements, because this is the LAST thing the customer
  // reads — it replaces the whole form — and it is the worst place in the
  // feature to promise something that then does not arrive.
  //
  // All three promise the ASK landed, never that a link has been SENT: the
  // designer still has to raise it, and we cannot claim a send we have not
  // made. Same rule the Ready-to-order copy follows.
  //
  // `sent` is the one used when we cannot tell which branch they are in —
  // specifically on a reload inside the 24-hour window, where the page knows
  // a request exists but not whether it carried a note. Deliberately says
  // less rather than guessing.
  sent: 'Thanks — we’ve got your request and we’ll be in touch shortly.',
  // No note: nothing has changed, so the payment link is the honest and
  // reassuring thing to name.
  sentPaymentLink: 'Thanks — we’ve got your request and we’ll be in touch with a payment link shortly.',
  // A note: it may be a change, and a change means a fresh proof first. Sets
  // that expectation now rather than leaving them waiting for a link that
  // was never coming. Hedged ("if") because a note is not always a change.
  sentWithNote:
    'Thanks — we’ve got your request. We’ll read what you’ve told us and come back to you — if it needs a new proof, we’ll send that to approve first.',
  error: 'We couldn’t send that just now. Please reply to any message from us and we’ll sort it out.',
} as const

// Should the panel be shown at all? Server-resolved; the client never
// re-derives the gate, it only reads the answer.
//
// The one client-side subtraction is the forward link: once the reorder
// project exists, the honest thing on this page is "here's the one you asked
// for", not another invitation to ask. Offering both would read as though the
// first request had gone nowhere.
export function canRequestReorder(payload: ProofOrderStatePayload | null): boolean {
  return payload?.reorderAvailable === true && payload.reorderProofId == null
}

// ── The forward link (000374) ───────────────────────────────────────────────
//
// ⚠ Says what happened and where it went, and nothing about where the reorder
// has GOT to — that page answers its own status question, and guessing at it
// from here would be a second, staler voice. Same rule as the divide between
// the Ready-to-order panel and the approved card's status strip.
export const REORDER_FORWARD_COPY = {
  eyebrow: 'Your reorder',
  heading: 'You asked us for more of these',
  // Rendered as "<lead> <date>." with the date formatted by the component, so
  // there is one date format on the page rather than two.
  lead: 'You asked for a repeat of these on',
  // Used when the stamp is missing or unparseable — the link still matters.
  leadNoDate: 'You asked us for a repeat of these.',
  action: 'Open your reorder',
} as const

export interface ReorderForwardLink {
  proofId: string
  requestedAt: string | null
}

export function reorderForwardLink(
  payload: ProofOrderStatePayload | null,
): ReorderForwardLink | null {
  if (!payload?.reorderProofId) return null
  return { proofId: payload.reorderProofId, requestedAt: payload.reorderRequestedAt }
}

// How long the acknowledgement stands before the panel offers the button
// again. Matches COOLDOWN_HOURS in supabase/functions/request-reorder — the
// server is the real gate (it refuses inside the window regardless), so this
// exists to stop the UI offering an action that would silently do nothing.
export const REORDER_COOLDOWN_HOURS = 24

export function reorderRequestIsRecent(iso: string | null, now: number = Date.now()): boolean {
  if (!iso) return false
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return false
  const age = now - t
  // Guard the future too: clock skew shouldn't strand the panel forever.
  return age >= 0 && age < REORDER_COOLDOWN_HOURS * 60 * 60 * 1000
}

// ── The order status shown on the approved card ─────────────────────────────
//
// Distinct from the "Ready to order?" panel below the price grid: that one
// answers "how do I buy these?", this answers "where is the thing I bought?".
// They sit in different places and never both speak about the same moment.
//
// Returns null for every state with nothing to say — no order, an expired link
// on a proof that never got paid (the pricing panel covers that one), or a paid
// order whose tracking a designer has switched off.

export interface OrderStatusLine {
  /** Short label, rendered in the pill register. */
  label: string
  /** One sentence beneath it. Empty string for states that need no gloss. */
  line: string
  /** Set only when there is a real journey to draw. */
  stage: TrackingStage | null
  deliveryTracked: boolean | null
}

// ⚠ Deliberately no expiry here. The Ready-to-order panel already prints
// "Your payment link is valid until <date>" next to the button that acts on
// it; saying it twice on one page makes the deadline read as two different
// facts. This card states WHERE the order is, the panel states what to DO.

export function orderStatusLine(payload: ProofOrderStatePayload | null): OrderStatusLine | null {
  if (!payload) return null
  switch (payload.state) {
    case 'awaiting_payment':
      return {
        label: 'Awaiting payment',
        // Deliberately not "we've emailed you a link" — status 'sent' means the
        // link is live, not that anything left the building. Same rule the
        // Ready-to-order copy follows, for the same reason.
        line: 'Your order is ready to pay for through the payment link.',
        stage: null,
        deliveryTracked: null,
      }
    case 'link_expired':
      // The pricing panel already explains this one and offers the way out.
      // Repeating it up here would be two apologies for one problem.
      return null
    case 'paid':
      if (!payload.stage) {
        // Paid, but no journey to draw: tracking switched off, or the job was
        // cancelled in Stock Control. Confirming the payment still matters —
        // that is the fact the customer came back to check.
        return {
          label: 'Paid',
          line: 'Thanks — your order is confirmed.',
          stage: null,
          deliveryTracked: null,
        }
      }
      return {
        label: stageLabel(payload.stage, payload.deliveryTracked),
        line: stageLine(payload.stage, {
          deliveryTracked: payload.deliveryTracked,
          shippedAt: payload.shippedAt,
        }),
        stage: payload.stage,
        deliveryTracked: payload.deliveryTracked,
      }
    case 'none':
      return null
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
