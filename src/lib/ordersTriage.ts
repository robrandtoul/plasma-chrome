// Orders page triage: the one decision that gives the page its shape.
//
// The page is split into work at the top (FIX / SEND / PLACE) and a collapsed
// WAITING block underneath, on a single question: **if nobody opens this page
// today, does something go wrong?**
//
// An unpaid pay link is NOT work by default. `send-order-reminders` has chased
// them automatically since 28 June 2026, and each card says as much ("Next
// reminder due …"). A person is needed only when the automation has run out of
// road, or the customer has spoken and no robot can answer.
//
// This lives here rather than inline in OrdersPage because collapsing rows out
// of sight is the one change that could genuinely lose work: if the predicate is
// wrong, a job hides in Waiting and a customer waits on cards nobody is making.
// Extracting it makes the property testable — see ordersTriage.test.ts, which
// asserts the two buckets are exact complements over every combination of
// inputs, so a row can never land in both or neither.

/** The order fields the triage decision reads. Deliberately narrow so the
 *  predicate can be tested without constructing a whole OrderRow. */
export interface TriageOrder {
  /** True when the pay link's own expiry has passed. */
  expired: boolean
  /** Highest reminder number actually sent (0 when none have gone out). */
  remindersSent: number
  /** The customer used "Not sure? Ask us" on the pay page (000298). */
  askedForHelp: boolean
}

/** Whether a human has to deal with this unpaid link. */
export function needsHumanChase(o: TriageOrder, maxReminders: number): boolean {
  return o.expired || o.remindersSent >= maxReminders || o.askedForHelp
}

/** Why it's in FIX, in the customer's terms. A question from the customer
 *  outranks our own chase mechanics — they are waiting on a reply from us. */
export function chaseReason(o: TriageOrder, maxReminders: number): string {
  if (o.askedForHelp) return 'Asked us a question from the pay page'
  if (o.expired) return 'Pay link expired'
  return `All ${maxReminders} reminders sent, still unpaid`
}

/** Split unpaid links into the two buckets the page renders. Returned as one
 *  object from one pass so the two lists cannot drift apart — the caller never
 *  gets the chance to filter twice with mismatched predicates. */
export function splitByChaseNeed<T>(
  orders: T[],
  toTriage: (o: T) => TriageOrder,
  maxReminders: number,
): { needsYou: T[]; waiting: T[] } {
  const needsYou: T[] = []
  const waiting: T[] = []
  for (const o of orders) {
    if (needsHumanChase(toTriage(o), maxReminders)) needsYou.push(o)
    else waiting.push(o)
  }
  return { needsYou, waiting }
}

/** A combined payment whose own link has lapsed. Its own predicate because the
 *  automatic chaser skips grouped orders entirely (`send-order-reminders`), so
 *  an expired group is being chased by precisely nothing. */
export function groupNeedsAttention(expiresAt: string | null, now: number = Date.now()): boolean {
  return expiresAt != null && new Date(expiresAt).getTime() < now
}
