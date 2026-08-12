# Supplier proof holding pen

**Migration:** `000409_supplier_proof_holding_pen.sql`
**Status:** built; migration NOT yet applied to live (apply via MCP `apply_migration` per the house workflow)
**Edge functions:** `approve-supplier-proof` (new), `helpscout-webhook` (changed)

---

## Why

A supplier order used to end at **Place**. We emailed QX Metals, the card dropped
into *Recently ordered*, and the project was closed off.

But QX always reply with their own internal proof for us to approve, and that
step lived nowhere — it happened in Help Scout, tracked in somebody's head.

The hole: **if the supplier never received the order email, or simply forgot to
reply, nothing told us.** We found out a fortnight later when the cards didn't
ship.

## What the live data said

Measured across all 46 supplier orders placed between 26 July and 12 August 2026:

| | |
| --- | --- |
| QX Metals orders | 41 (Solopress 3, Swype 2) |
| Orders carrying `supplier_helpscout_conversation_id` | 46 of 46 |
| Supplier replies already delivered to our webhook | **62** |
| Orders that never got a reply | 0 |
| Median lag, order email → supplier reply | **2.0 hours** (mean 6.2) |

Three findings shaped the design:

1. **The signal already arrived and we threw it away.** `place-order` opens a NEW
   Help Scout conversation per supplier order with the supplier as its customer.
   Their proof comes back as a reply on that thread, firing
   `convo.customer.reply.created` at our own webhook — which matched conversations
   only against `proofs.helpscout_conversation_id`, found no proof, and dropped
   the event. 62 of them.
2. **Re-proofs are routine.** Several orders show a second reply hours after the
   first ("Sorry, please find the *updated* proof attached") — sometimes after we
   had already approved. The pen cannot be a one-way door.
3. **A reply is not proof of a proof.** Two Swype rows captured our own outbound
   text. So a reply means *the supplier received and acted on the order* — which
   closes the hole — and a human still eyeballs the artwork. No text matching.

### ⚠ Only ONE of the three suppliers sends a proof

Read off the live threads 2026-08-12, after the pen was already built:

| Supplier | What comes back |
| --- | --- |
| QX Metals | An artwork proof for approval — *"Please find the proof attached for your confirmation"* |
| Solopress | A booking confirmation and their own job number — *"All booked in — 5436477"* |
| Swype | A **proforma invoice**, and they don't start until it's paid — *"Once payment has been received, I can put into production"* |

The original "all suppliers" decision was taken on the evidence that all three
*replied* to every order. True, but it hadn't read what the replies said. Two
consequences, both now handled:

- **The reply we send back is per-supplier** (`supplier_proof_approval:<supplier_id>`,
  all three seeded). A shared *"the proof is approved, please go ahead and produce
  the order"* would have told Swype to start printing something they are waiting
  to be paid for. The shared default is deliberately vague, so a supplier added in
  future gets a safe acknowledgement rather than an instruction.
- **The on-screen wording says only what we know** — *"QX Metals replied"*, never
  *"Proof from QX Metals"*. We never read the message, and one of three suppliers
  sending a proof is not a basis for the label. Deliberately NOT per-supplier UI
  labels: that needs a per-supplier "what do they send" setting, which would go
  stale the day a supplier changes their process — exactly what happened to the
  original assumption.

Swype's prepayment requirement is tracked outside this app (Rob, 2026-08-12) and
is deliberately out of scope here.

## The one rule

> **needs checking when `supplier_reply_at > supplier_proof_approved_at`**

A comparison rather than a flag, so a corrected proof arriving after sign-off
simply re-flags the card and cannot be silently swallowed.

## States

`supplierProofState()` in `src/lib/supplierProof.ts` — total and disjoint,
property-tested over every input combination in `supplierProof.test.ts`.

| State | Meaning | Where it renders |
| --- | --- | --- |
| `none` | in-house, blanks-sourced, not placed, or no supplier thread | Recently ordered (unchanged) |
| `to_check` | something arrived since we last approved | **CHECK** (work) |
| `awaiting` | emailed, nothing back, inside the threshold | Waiting (collapsed) |
| `overdue` | emailed, nothing back, past the threshold | **Fix** ← the hole |
| `approved` | signed off, nothing newer since | Recently ordered |

### Scope is keyed off the supplier EMAIL, not the material route

`supplier_email_sent_at IS NOT NULL AND supplier_helpscout_conversation_id IS NOT NULL`,
gated on `status = 'fulfilled'`.

That is not a shortcut — it is what makes the scope correct. A **blanks-sourced**
order (000382) has a supplier material but deliberately sends no supplier email:
its blanks ride a sibling order's batch and its message is the workshop note.
Asked "is this a supplier material?" it would wait forever for a proof from a
supplier nobody emailed. Asked "did we email a supplier?" it is correctly
excluded — along with custom-quote orders whose route is unknown, and every
in-house job. `status = 'fulfilled'` means an order cancelled or pulled into
revision after placement drops out on its own.

## Deliberately NOT a new order status

`fulfilled` means "placed into production" and is read by `src/lib/orderLog.ts`,
`src/lib/reorderDesk.ts`, `src/lib/dashboardGrouping.ts`, `ReprintModal`,
`ProofDetailPage` (reopen gating), `OrderPayPage`, and the customer tracking
projection. An `awaiting_supplier_proof` status would silently move all of them —
the drift 000245 / 000246 / 000279 each had to be written to undo.

The pen is an **overlay on a placed order**. Money, production, Stock Control and
everything the customer sees are untouched: `/p/:id` and the pay page keep
showing "In production" throughout.

## Ordering: send FIRST, stamp only on success

The opposite of the 000366 abandon notice, deliberately.

There, the status flip was its own durable record and the worse failure was
telling a customer we had closed something we hadn't. **Here the approval IS the
message.** Stamp first and the send fails, and the card vanishes off the page
while the supplier waits for a go-ahead that never came — nobody knowing until
the cards don't ship, which is the exact hole this feature closes.

A failed send leaves the order in CHECK with the error shown: honest and
retryable. Same order `place-order` uses for `supplier_email_sent_at`. If the
send succeeds but the stamp fails, the function returns `sent_not_recorded` and
says *do not send it again* — the house shape for that case.

## Notes on the customer's thread

Asked for by the team, 12 Aug: they wanted the customer's proof conversation to
say where the order has got to, so they don't have to open the Orders page.

Two internal notes, a matched pair, bodies in `supabase/functions/_shared/supplierNote.ts`
(`pnpm test:supplier-note`):

| When | Note | Posted by |
| --- | --- | --- |
| Order emailed | **AWAITING RESPONSE FROM QX METALS** + the order copy | `place-order` |
| Reply cleared | **QX METALS RESPONSE CLEARED** — *Replied by Chris Jackson.* | `approve-supplier-proof` |

- **No new note at placement.** `place-order` already filed a "COPY OF ORDER SENT
  TO SUPPLIER" note there; the status just moved into its heading, so this adds
  exactly one note per order, not two.
- **The status leads the heading**, not the contents — someone opening the thread
  wants "where has this got to", which a "copy of order" heading buries.
- ⚠ **Names the supplier, claims nothing about what they send.** The wording
  originally asked for was "AWAITING SUPPLIER PROOF" / "SUPPLIER PROOF APPROVED",
  which is false on two of the three suppliers. Third time this rule has bitten
  in one feature, hence the shared module and its test.
- **Replied vs recorded is stated.** One means the supplier was told; the other
  (the "just record it" path) means they weren't. Not a cosmetic distinction.
- **Best-effort, and after the stamp.** A Help Scout wobble must never cost
  someone their sign-off or invite a retry that emails the supplier twice.
  Skipped silently when the proof has no linked conversation.
- Help Scout notes are staff-only — never emailed, never shown to the customer.

**Nothing posts when a supplier goes quiet** (Rob's call): the "awaiting" note
with no follow-up already implies it, and chasing belongs on the Orders page. A
note the day it flags would need a cron that can write to customer threads.

## The customer thread is renamed to the folder name

In-house orders have always renamed the customer's proof conversation to the
Dropbox order folder name at placement (`Order 402910 - Capital Piling`), so the
thread, the folder and the Stock Control job number all read the same. Supplier
orders never did. Now they do (team request, 12 Aug).

⚠ **The two routes were computing that subject differently, and only one was
right:**

| Route | Formula | Matches the folder? |
| --- | --- | --- |
| in-house | `Order <no> - <project_name ?? customer>` | yes |
| supplier | `Order <no> - <customer>` | **only by luck** |

`project_name` is *parsed out of the linked Dropbox folder name* by the
`dropbox-folder` function — it IS the folder. So reusing the supplier route's
existing `subject` would have produced the wrong thread name on **23 of the 46**
live supplier orders, where the folder's project name isn't the customer's name.

One formula now lives in `supabase/functions/_shared/orderSubject.ts`
(`pnpm test:order-subject`), used by both routes.

**The supplier email's own subject is deliberately unchanged.** It is
outward-facing and nobody asked for it to move, so the two can now differ: the
supplier's email keeps the customer name, the customer's thread gets the folder
name. Nothing parses either (checked: no Postgres function reads a Help Scout
subject — `update_outsourced_order`'s `subject_id` is an unrelated polymorphic
reference). Aligning them is a one-line change if wanted.

The rename is **best-effort**, in the same block as the awaiting note: by then
the supplier email has already gone, so a Help Scout failure must never report a
failed placement and invite a re-send. The review screen shows the pending new
name whenever it differs from the supplier subject, so a thread never renames
itself unannounced.

## Schema (000409)

- `orders.supplier_reply_at` — newest supplier reply, webhook-written
- `orders.supplier_proof_approved_at` / `_by`
- partial index on `orders.supplier_helpscout_conversation_id` (the webhook's
  lookup key; none existed)
- `settings.supplier_proof_overdue_days` (1–30, default 1) — Admin → Settings →
  Ordering & checkout
- four reply templates: the vague shared `supplier_proof_approval` plus one per
  live supplier (`supplier_proof_approval:<supplier_id>`), the pattern
  `supplier_order_email` already uses — see the table above for why each differs
- ⚠ the three new columns added to the strip list in `proofs._customer_order_json()`
  in the same migration (the 000365 rule), re-emitted from the **live**
  `pg_get_functiondef`

### Backfill: start clean

Every supplier order placed before the migration is stamped
`supplier_proof_approved_at = fulfilled_at`.

We have no record of which were really approved — the approval has only ever
existed as a message in Help Scout — so the alternative is opening day one with
~46 stale cards demanding attention for work finished weeks ago. A worklist that
is wrong the first time you look at it does not get looked at again. The feature
governs orders placed from now on.

## The webhook change

`helpscout-webhook` gains `stampSupplierReply()`:

- **CUSTOMER-direction replies only.** Our own approval goes onto the same thread
  as a staff reply; stamping it would make `supplier_reply_at` leapfrog
  `supplier_proof_approved_at` and bounce the card back into CHECK forever, one
  second after someone cleared it.
- Independent of the proof match, deliberately not an `else` — a supplier
  conversation is never a proof conversation, so neither can steal the other's
  event.
- **Best-effort.** Against a database where 000409 hasn't been applied, the
  update errors on the missing column; failing the whole delivery would cost us
  the proof-reply stamp, which is the older load-bearing contract. Logged and
  reported, never thrown. Either deploy order is therefore safe.

## Deploy order

1. **Migration** (Rob applies via MCP `apply_migration` / the dashboard SQL
   editor — never `db push`; the CLI link points at the retired standalone
   project)
2. `helpscout-webhook` — stamps a column that must exist
3. `approve-supplier-proof` — new; `verify_jwt` stays **true** (in-body
   `requireDesigner`)
4. Frontend — selects the new columns

The frontend reads `supplier_proof_overdue_days` in its OWN settings query, not
folded into the reminder-cadence one: PostgREST fails a whole select on one
unknown column, so sharing it would have cost the cadence on a pre-migration
database.

## Verification

- `pnpm test` — `supplierProof.test.ts` (states total + disjoint over 96
  combinations), `supplierProofTemplate.test.ts` (seed ↔ `DEFAULT_BODIES`
  byte-identity), `orderTimeline.test.ts` (the two new entries)
- `pnpm exec playwright test e2e/harness/orders-supplier-proof.spec.ts --project=harness`
  — nine cases over five fixture orders, one per state
- Harness rig: `?path=/orders`, fixtures `sp-*` in `verify-harness/mock-supabase.ts`

### After applying, on live

Day one should read: **CHECK 0, Fix (supplier) 0, Waiting (supplier) 0** — the
backfill leaves nothing outstanding. Then on the next real QX order: place it,
watch `supplier_reply_at` land within ~2 hours, confirm the card appears in
CHECK, approve it, confirm the reply reaches the QX thread and the card moves to
Recently ordered.

## Out of scope (deliberate)

- **Reading the proof attachment.** The supplier's proof is an email attachment,
  not a file in our Dropbox folder, so running the artwork sanity check against
  it needs a new ingest path. Worth a follow-up once the pen is proving itself.
- **Chasing the supplier automatically.** The pen makes silence visible; whether
  to auto-nudge a supplier the way `send-nudges` chases customers is a separate
  decision.
- **Anything customer-facing.** No projection or tracking change.

## Known limitations

- `supplier_reply_at` holds only the **newest** reply — each one overwrites it.
  A re-proofed order therefore shows its latest round on the timeline, not its
  history. Honest about what we store rather than inventing rounds we never
  recorded.
- The pen covers **all suppliers**, not just QX (Rob's call, 12 Aug) — the
  "did they receive it at all" question is identical for all three. Only the
  reply wording differs.
- **Replying from a mail client rather than inside Help Scout may register as an
  inbound reply.** Both Swype orders show our own message (*"Hi Helen, Thanks.
  This has now been paid"*) recorded against a `convo.customer.reply.created`
  event. If that reading is right, a card cleared that way bounces back into
  Check — one click of "Just record it" to clear again, not dangerous. The
  approve button itself posts via the API as a staff reply, so it is unaffected.
  Unconfirmed; watch the first live week.
