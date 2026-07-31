# Customer-initiated reorder — build spec

Letting a customer say "we need more of these" from the proof page, instead of
having to remember to email.

Status: **built** (31 Jul 2026). Decisions in §3 are settled (Rob, 30 Jul 2026);
all six build-order steps below are done. Migrations 000372 / 000373 / 000374 are
applied to live and `request-reorder` is deployed.

⚠ `settings.reorder_enabled` is **ON** on live, so the panel goes live for real
customers the moment the frontend merges — see the note at the end of §10.

---

## 1. Why

`/p/:id` is the URL that ends up bookmarked. It's in every proof email, it
survives forever (nothing expires it), and since 000371 it also answers "where
has my order got to?" — so there's now a real reason to come back to it.

What it can't do is the one thing a returning customer most often wants. A
repeat order today starts with the customer remembering to email us. The orders
that never get placed are the emails that never get written.

The designer side is already built and good:

- **"Create another order"** on an approved proof with a settled order
  (`ProofDetailPage`, gated on `isApproved && orderingEnabled && hasOpenOrder && !hasLiveLink`).
- **Duplicate project** (`src/lib/duplicateProof.ts`) — documented as the
  repeat-order path; copies the current version into a fresh proof for the same
  contact.
- The order builder **auto-suggests the last order's spec** via
  `last_paid_order_for_proof` (000364), and the pay page **badges** it —
  "Your last order · March 2022".

So this spec is not "build reordering". It is "let the customer start the
reordering we already do".

---

## 2. The governing decision: a request, not a transaction

The customer **asks**; a designer sends the pay link through the existing
channel. Reordering is never self-serve. Three reasons, in order of weight:

1. **`/p/:id` is deliberately broad.** Team sharing hands `?for=<name>` links to
   colleagues and `docs/team-sharing-feature.md` calls them "a convenience, not
   security". Self-serve reordering would mean anyone ever sent the artwork can
   spend the company's money. This is the same argument 000367 made about not
   putting the pay token on this page, and buying is the most consequential
   capability there is.
2. **Reorders are rarely identical.** People leave, numbers change, addresses
   move. Frictionless identical reordering eventually prints 500 cards for a
   departed employee.
3. **Prices move, and this page shows today's prices** (it reads live
   `price_tiers`). Charging against a figure they last saw two years ago is a
   complaint waiting to happen.

The request therefore carries **no recipient**. Same structural refusal as
`resend-pay-link` (000369): a `/p/` holder can *cause* a payment link to reach
the real customer, and can never redirect one to themselves. If a colleague
genuinely needs it, they say so in the note and a designer judges.

---

## 3. Decisions taken

| Question | Decision |
|---|---|
| New project, or another order on the same proof? | **Always a new project**, whether or not changes are needed. |
| Re-approval on an identical reorder? | **No** — the new project is created already approved. |
| Which Help Scout mailbox? | **Customer Support.** |
| Existing thread or new? | **New conversation, always.** |

### Why always a new project

It **dissolves the Help Scout problem** rather than working around it. Help
Scout locks threads after a period of inactivity, so a reorder months or years
later cannot reuse the original — and if the reorder lived on the *same* proof,
that proof's `helpscout_conversation_id` would still point at the locked thread.
Three things post to that id: the pay-link send (`send-helpscout-reply`), the
payment confirmation (`stripe-webhook`) and the unpaid-order reminders
(`send-order-reminders`). We'd have raised the order fine and then fired the
payment link into a dead thread.

A new project needs a new conversation as its natural state. `duplicateProof`
already declines to copy the Help Scout link, writing a
`helpscout_override_reason` until a designer links one — so "new project, new
thread" is the shape that flow already expects.

It also buys: one project = one order (so the proof page, order log, timeline
and repeat-customer analytics all read truthfully); today's prices quoted at
today's date, with the old proof left as the honest record of what was approved
and charged then; and a fresh artwork copy in a fresh Dropbox folder, so a
reorder can't pull files edited since.

The customer's thread history ties the two together on the Help Scout side —
their old conversations show in the sidebar — so nothing is lost by not
reusing the thread.

### ⚠ What "straight to approved" actually requires

**Do not just set `status = 'approved'`.** `ProofDetailPage` (~:1305) reads the
current version's `proof_name_approvals` rows to build the **Approved artwork**
table and the production ZIP. With no rows it sets `approvedImages = []` and the
table renders empty — and its own comment says the state "shouldn't happen under
the current approve-shortcut flow (it always writes approvals first)". A
pre-approved reorder with only a status flip would produce exactly that state,
and the designer would find no artwork to hand to production.

So the reorder must synthesise the approval rows too, mirroring `handleApprove`'s
two steps: **insert the per-slot `proof_name_approvals` rows first, then flip the
status and stamp `approved_at`.** Rows are attributed as carried from the source
project, not as a customer action — the distinction matters, because approval
means something in this system and a synthesised row must never read as a
sign-off somebody gave.

This is the cross-proof equivalent of `approvalCarry`, which does the same job
between versions of one proof.

---

## 4. Eligibility — when the panel appears

Gate on: proof **approved**, an order **paid**, **no live unpaid link** (that
customer needs to pay for what they have, not order more), and the order
**dispatched long enough ago**.

### ⚠ The quiet window, and the DPD asymmetry

A customer wants time to compare the delivered cards against the proof before
being asked to buy more. So the panel waits after delivery.

Counting from `delivered` alone would mean **the panel never appears for any UK
customer**. Live, at time of writing:

| carrier | paid orders w/ a job | have `delivered_at` | have a dispatch stamp |
|---|---|---|---|
| FedEx | 25 | 22 | 25 |
| **DPD** | **63** | **0 — ever** | **63** |
| not yet dispatched | 58 | — | — |

This is the same asymmetry 000370 handled for the progress bar, one layer up,
and it wants the same treatment: count from **delivered** where we have it, and
from **dispatch** where we don't, with a longer offset to cover transit. Every
dispatched order carries at least one usable clock, so nothing falls through;
the 58 with no clock haven't shipped and are correctly ineligible.

Suggested defaults, both admin-editable in Settings (house pattern —
`dormancy_threshold_days`, `order_reminder_interval_days`):

- `reorder_quiet_days_after_delivery` — 14
- `reorder_quiet_days_after_dispatch` — 17 (delivery window + the same 14)

**Compute eligibility server-side and return a boolean.** Do not put the
timestamps on the page's payload: it keeps the surface a fact rather than a
capability, adds no new dates to a broadly-shared page, and lets the window
change without a frontend deploy.

---

## 5. Data + read path

Extend `proofs.public_get_proof_order_state(p_proof_id)` — the function the page
already calls — with:

- `reorder_available boolean` — the §4 gate, computed server-side.
- `reorder_requested_at timestamptz` — echoed back so a reload shows the
  acknowledgement instead of re-arming the button, and a second colleague sees
  it's already been asked. Exactly the `resend_requested_at` pattern (000369).

⚠ Re-emit from the **live** `pg_get_functiondef`, never from a migration file —
this function has now been re-emitted three times (000367, 000369, 000371) and
carries keys from each. Take named keys only; never `|| proj`.

Nothing else joins the payload. No quantity, no amount, no spec, no order id.

**Rate limit** in the UPDATE's own WHERE clause, the way
`claim_pay_link_resend` does — a shared URL plus an action that pings the queue
is a spam vector, and two colleagues clicking shouldn't raise two jobs.

---

## 6. The request flow

**Edge function `request-reorder`** (anon, body is `{ proof_id, quantity?, note? }`
— **no recipient, ever**). Modelled on `proof-contact-submit`, which already
creates a fresh Help Scout conversation with the proof reference attached, not on
`send-helpscout-reply`, which assumes a live thread.

1. Claim the rate limit; refuse quietly inside the cooldown.
2. Verify eligibility server-side — never trust the client's view of the gate.
3. Create the Help Scout conversation in **Customer Support**, carrying: the
   customer, a link to the source proof, what they ordered last time, the
   quantity asked for, and the note.
4. Duplicate the source proof (the `duplicateProof` logic, moved server-side or
   invoked from it), link the new conversation to the new proof, and — when no
   changes were requested — write the carried approval rows and flip it to
   approved per §3.
5. Stamp `reorder_requested_at` on the source order/proof.
6. Return `{ status: 'ok' }`. Never the new proof id: that would hand a `/p/`
   holder a fresh surface they weren't given.

### The two branches

The "has anything changed?" answer is not just a note — it routes the work:

- **Nothing changed** → new project, pre-approved, straight into the
  order-it-up queue.
- **Something changed** → new project left `in_progress` with the note attached;
  a normal artwork round follows.

---

## 7. Designer side

The fulfilment path already exists. What's needed is that the request **cannot
be missed** — a customer asking to spend money and nobody noticing is worse than
not offering it at all.

- A **`reorder` marker on the proof** so the dashboard can chip it, and so a
  pre-approved reorder is visibly distinct from a proof a customer signed off.
  Rob's explicit ask: it must be clear on the dashboard that this is a
  pre-approved reorder, so it's handled accordingly rather than being treated as
  a fresh approval to celebrate.
- A **needs-attention rule** so it lands in the queue that's already worked. The
  existing `approved_no_order` rule (currently disabled) is the closest fit — a
  reorder is a high-priority instance of exactly that shape — but a distinct
  rule reads better on the chip and can carry its own priority.

The old proof page then gains a **forward link**: "You reordered these on 12
August — follow that order here." `duplicateProofMapping` already writes
`cloned_from_version_id`, so the lineage is queryable today with no schema
change. This is what stops the bookmark going stale: it becomes a hub that
points at whatever is current, rather than a dead end showing a two-year-old
delivery.

---

## 8. Deliberately out of scope

- **Self-serve checkout.** See §2.
- **Any recipient field on the request.** See §2.
- **Reusing the original Help Scout thread.** See §3.
- **Skipping the artwork check.** A reorder is a normal order and goes through
  the same `place-order` gates.
- **Auto-placing the order.** A designer still sends the link.

## 9. Open / deferred

- **The underorder case.** Someone who ordered too few wants a top-up next week
  — the quiet window works against exactly them. They'll probably just email.
  Revisit if it shows up.
- **Storage growth.** Every reorder copies the artwork objects. Trivial per
  order, non-trivial over years of repeat customers. No cleanup exists today
  (project delete is the only path).
- **Whether the reorder panel should show the price.** The live grid is right
  there, and pre-empting "what does it cost now?" would help — but it needs the
  last quantity, which is order data the page doesn't currently carry. Left out
  of v1 so the payload stays a bare fact.

## 10. Build order

1. ✅ Settings + the eligibility maths (§4), read-only verified against live — `000372`.
2. ✅ `public_get_proof_order_state` re-emit with the two new keys (§5) — `000372`.
3. ✅ `request-reorder` edge function + rate limit (§6).
4. ✅ The panel on `/p/:id` — `src/components/ReorderPanel.tsx`.
5. ✅ Dashboard marker + needs-attention rule (§7) — `000373`.
6. ✅ Forward link on the source proof page (§7) — `000374`.
7. ✅ **Raise the reorder** — the designer-side action that closes the loop
   (no migration; `duplicateProof` + `ProofDetailPage` + `ResolvePopover`).

1–2 are independently shippable and inert (the panel doesn't exist yet), which
is the natural place to stop and check the gate is picking the right orders.

## 11. What shipped, and what is still owed

**Live database state.** All three migrations are applied via MCP
`apply_migration` against `bjvinrzbdrwebylkmbwy`, each verified read-only first:
`000373` left the Needs-attention count unchanged at 7 and `000374` reproduced
`public_get_proof_order_state` byte-for-byte across all 172 proofs with orders
(the new key is stripped until a reorder exists). `request-reorder` is deployed
with `verify_jwt = false`.

⚠ **`settings.reorder_enabled` was set to `true` on live** during the build, so
the preview deploy shows the panel against real data — 21 proofs are currently
eligible. That is harmless only while the panel code is absent from `main`.
**Merging this ships the panel to real customers immediately.** Set
`reorder_enabled` back to `false` first if that isn't wanted yet; the gate is a
single settings column and needs no redeploy either way.

⚠ **The endpoint could not be smoke-tested end to end.** The build container's
network policy blocks `*.supabase.co`, so the deployed function was never
actually invoked. Its logic is covered by the eligibility preview and the unit
tests, but the first real click is the first real execution — watch the function
logs for it.

**The designer-side action — built.** "Raise the reorder" appears on a flagged
project, in both the header overflow menu and the needs-attention popover's
primary slot. It extends `duplicateProof` with a `raiseReorder` option rather
than forking it, and does the three things a bare Duplicate does not:

- **Carries the source's approved `proof_name_approvals` rows** onto the new v1,
  keyed `carried_from_version_id = <source current version>`. That value is
  doing two jobs: it records the honest provenance (a carry-forward, not a fresh
  customer act — nothing in RLS would stop us faking one), and it suppresses the
  finalise trigger, whose live guard is
  `WHEN (state = 'approved' AND carried_from_version_id IS NULL)`.
- **Sets `status='approved'` in the proofs INSERT**, never by a follow-up
  UPDATE. `proofs` has no INSERT trigger but does have
  `notify_push_on_proof_approved AFTER UPDATE OF status`, so flipping it
  afterwards would push "proof approved" to the whole team's phones for an
  approval the customer never gave on that project.
- **Stamps `reorder_of_proof_id` LAST.** It is the commit point: the rule clears
  on the bare existence of a child, with no status or version filter, and can
  never re-fire. Stamped early, a crash mid-build would clear the customer's
  request forever against a half-made project; stamped last, the worst outcome
  is an orphan project and a source that stays flagged for a retry.

Two rules worth keeping straight:

- **Pre-approve only when the source IS approved and has rows to carry.** Two
  halves, two different failures. The row count catches a source that is
  `approved` with zero approval rows (a designer used "Mark as approved", or it
  is a variant round whose slots the finaliser bails on, 000141) — carrying
  nothing and claiming approved is the empty-artwork-table failure this feature
  exists to prevent. The **status check protects production**:
  `src/lib/approvedArtwork.ts` takes the current version's non-QR images
  wholesale and says why — "a proof reaches 'approved' only once every required
  slot of the CURRENT version is signed off". Every other route to approved
  upholds that; this one could not, since carried rows suppress the finaliser by
  design. Reopen a source (deleting its approvals, 000158), re-approve one of
  two recipients, and a partial carry would mint a fully-approved child whose
  production ZIP contained the unapproved person's card. Either decline leaves
  the reorder OPEN with a toast saying so.
- **The button retires itself.** Nothing clears `reorder_requested_at`, so the
  source page reads its own child on load: that hides the action once it has
  done its job, and renders a "Reorder raised — open it" link so the source and
  the reorder point at each other rather than the source being a dead end.
- **Set-collection slot keys are layout ids**, and the duplicate mints fresh
  ones. `duplicateApprovalInsert` remaps them through the layout id map; an
  unmappable key returns null and the caller rolls the whole reorder back rather
  than shipping a key that matches no image.
