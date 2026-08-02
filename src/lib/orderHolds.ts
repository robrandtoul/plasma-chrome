// "On hold, waiting on the customer" — the rules, in one place.
//
// An artwork-check finding sometimes has to be cleared with the customer before
// the cards are made. Until this existed the order carried on sitting in Place
// looking exactly like one nobody had got round to, and any of five staff could
// push it into production while the person who raised the query was waiting on
// a reply — a supplier email nobody can recall (migration 000377).
//
// Every surface reads its answers from here — the Orders card, the Place-order
// review page and the artwork report — so they cannot drift into disagreeing
// about whether an order is held or what to say about it. The real block is the
// database trigger; this module decides what a human is shown.

export interface OrderHoldRow {
  status?: string | null
  held_at?: string | null
  hold_reason?: string | null
  held_by_name?: string | null
}

// Thread-wide Help Scout stamps, already fetched with every order row
// (OrdersPage's SELECT joins proofs(helpscout_last_reply_at,
// helpscout_last_customer_reply_at)). No new query, no new column.
export interface HoldReplyContext {
  lastCustomerReplyAt?: string | null
  lastStaffReplyAt?: string | null
}

export interface HeldState {
  held: true
  heldAt: string
  reason: string
  byName: string | null
  /**
   * When the customer has replied on the thread since we put this on hold and
   * we have not answered since. Null otherwise.
   *
   * NOT a claim that the question is answered — see repliedLine().
   */
  repliedAt: string | null
}

export type HoldState = { held: false } | HeldState

const ms = (s: string | null | undefined): number | null => {
  if (!s) return null
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : null
}

/**
 * Has the customer come back to us since we asked?
 *
 * Two conditions, and BOTH matter:
 *   - the reply lands after the hold went on (they are answering us, not
 *     something from before we asked), and
 *   - we have not replied since (otherwise we have already dealt with it and
 *     the prompt is stale).
 *
 * This mirrors the `unansweredReplyAt` gate the approved-no-order list already
 * uses (OrdersPage), minus its current-version clause, which is meaningless
 * here — the proof is approved and paid for by the time an order can be held.
 *
 * `helpscout_last_customer_reply_at` is stamped per CONVERSATION, not per
 * question, so this can fire on a reply about something else entirely. That is
 * why nothing acts on it: it surfaces the card and asks a human to go and read
 * the thread. Auto-releasing on this stamp was considered and rejected — "let
 * me check with my boss" would open the gate on an irreversible action.
 */
export function customerRepliedSince(
  heldAt: string,
  reply: HoldReplyContext | null | undefined,
): string | null {
  if (!reply) return null
  const held = ms(heldAt)
  const customer = ms(reply.lastCustomerReplyAt)
  if (held == null || customer == null) return null
  if (customer <= held) return null
  const staff = ms(reply.lastStaffReplyAt)
  if (staff != null && staff >= customer) return null
  return reply.lastCustomerReplyAt ?? null
}

/** The one place that decides whether an order counts as held. */
export function holdState(
  order: OrderHoldRow | null | undefined,
  reply?: HoldReplyContext | null,
): HoldState {
  const heldAt = order?.held_at
  if (!heldAt) return { held: false }
  // The DB CHECK guarantees a reason accompanies a hold, but a row could be
  // read mid-migration or through a stale cache; degrade rather than render an
  // empty band that explains nothing.
  const reason = (order?.hold_reason ?? '').trim()
  return {
    held: true,
    heldAt,
    reason: reason || 'No reason was recorded.',
    byName: order?.held_by_name?.trim() || null,
    repliedAt: customerRepliedSince(heldAt, reply),
  }
}

export function isHeld(order: OrderHoldRow | null | undefined): boolean {
  return !!order?.held_at
}

/**
 * Why the place button is unavailable, for the disabled-reason line and the
 * review page's block chain.
 *
 * Deliberately NOT "nobody can place this order". A hand-written Help Scout
 * note carrying Qty:/Card: lines still creates a Stock Control job through the
 * `helpscout-inhouse-order` parser — a deliberate backstop that never touches
 * an order row, so no control on an order can close it. Printing an absolute
 * promise would teach people to trust something broader than what is true.
 */
export function holdBlockReason(state: HoldState): string | null {
  if (!state.held) return null
  const who = state.byName ? `${state.byName} put this on hold` : 'This is on hold'
  return `${who} while a question is out with the customer. Take it off hold to place it.`
}

/**
 * The line shown when the customer has been back in touch. Phrased as an
 * errand, never as an answer — the stamp is thread-wide and cannot know what
 * they actually said.
 */
export function repliedLine(state: HoldState): string | null {
  if (!state.held || !state.repliedAt) return null
  return 'The customer has replied on the thread since you asked — worth a read.'
}

// Copy, kept here so the dialog, the card and the review page cannot drift.
// Verb-first and plain, matching the page's own voice ("Prepare order", "Send
// it now", "Go to it").
//
// NB "Release" is deliberately avoided throughout: on this very page it already
// means "Release from combined payment", and two different Releases on one card
// family is a trap worth spending three extra characters to dodge.
export const HOLD_COPY = {
  put: 'Put on hold…',
  take_off: 'Take it off hold',
  dialog_title: 'Put this order on hold',
  // Scoped on purpose — "nobody can push it into production" would be the
  // absolute this feature can't deliver (the Help Scout note parser makes
  // Stock Control jobs without an order row at all). Say what is true.
  //
  // "where it is" rather than "in your Place list": holds are offered on
  // revision orders too, and those sit under Being revised, not Place.
  dialog_body:
    'It stays in the queue where it is, but it can no longer be pushed into production from here until someone takes it off hold.',
  reason_label: 'What are you waiting on?',
  reason_help:
    'Your colleagues read this, not the customer — it is what tells them whether to wait or to go ahead.',
  reason_placeholder: 'e.g. asked Sarah to confirm the mobile number on the front',
  confirm: 'Put it on hold',
  take_off_title: 'Take this order off hold',
  take_off_confirm: 'Take it off hold',
} as const

/** Max length enforced by the DB CHECK (orders_hold_shape_check). */
export const HOLD_REASON_MAX = 500

export function holdReasonError(reason: string): string | null {
  const trimmed = reason.trim()
  if (!trimmed) return 'Say what you are waiting on, so a colleague knows whether to wait.'
  if (trimmed.length > HOLD_REASON_MAX) return `Keep it under ${HOLD_REASON_MAX} characters.`
  return null
}
