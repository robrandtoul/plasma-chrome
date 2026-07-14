# Order cancel & revision — build spec

Handling customers who, **after an order link has been sent (and possibly paid /
placed)**, either (a) want to abort, or (b) want design changes. The hard
requirement throughout: **never let previously-approved artwork that has since
been altered reach production.**

Status: spec / not yet built. Builds on the ordering system (see
`ordering-checkout-spec.md`) and the proof reopen flow (`reopen_proof`, migration
000158).

---

## 1. The four scenarios + what each needs

| # | Situation | Order status today | What we do |
|---|---|---|---|
| 1 | Abort, **unpaid** | `sent` | Cancel the order link (`sent → cancelled`) + tell the customer. |
| 2 | Changes, **unpaid** | `sent` | Cancel the link (`sent → cancelled`) + reopen the proof. New proof → re-approve → new order. |
| 3 | Changes, **paid, not yet placed** | `paid` (in "To order") | Hold the order (`paid → revision`) + reopen. Redesign → re-approve → re-prep Dropbox → re-place. Payment stands. |
| 4 | Changes, **paid AND placed** | `fulfilled` | Same as 3 (`fulfilled → revision` + reopen) **plus** cancel the old Stock Control job + confirm it hasn't printed, then re-place (Stock Control re-imports the new artwork). |

The pivot is **paid-not-placed (3)** vs **placed (4)**: in (4) the artwork has
already left proof-viewer (HS note attachments / supplier email / Dropbox /
a Stock Control job), so part of the fix is necessarily human.

---

## 2. Status model

`orders.status` today: `draft | sent | paid | fulfilled | expired | cancelled`.
**Add one:** `revision`.

Transitions introduced by this feature:

```
sent      → cancelled        (scenario 1 abort; scenario 2 unpaid-reopen)
paid      → revision         (scenario 3 reopen-for-changes)
fulfilled → revision         (scenario 4 reopen-for-changes)
revision  → fulfilled        (re-placed after re-approval — via place-order)
revision  → cancelled        (customer aborts mid-revision)
```

`revision` = a paid/placed order whose proof is being redesigned. It is **held**:
out of "To order", out of "Recently ordered", shown in its own loud section.

### Migration `000260_order_revision_status.sql`
- Drop + re-add the `orders.status` CHECK to include `'revision'` (verify the
  live constraint name first via `pg_constraint`; re-add all 7 values).
- `alter table proofs.orders add column if not exists revised_at timestamptz` —
  stamped when an order enters `revision` (drives the "being revised since…" label;
  full detail lives in `audit_log`).
- Seed two editable customer-message reply_templates (house pattern, `ON CONFLICT
  DO NOTHING`, mirror `DEFAULT_BODIES` in `src/lib/replyTemplates.ts`):
  - `order_cancelled` — "We've cancelled the order/payment link for your cards{? company}…". Vars: `first_name`, `company`.
  - `order_revision` — "We're updating your cards{? company} — a fresh proof will follow shortly.". Vars: `first_name`, `company`.
- No new RLS work: `orders` already has authenticated CRUD; `reply_templates`
  insert is admin-gated (migration 000259), but these two are seeded by the
  migration so no runtime insert is needed.

---

## 3. Building blocks

### 3a. Edge function `order-lifecycle` (NEW, `verify_jwt = true`, designer-gated)
One small function for the two order-side state changes, so the HS-post + audit
logic lives in one place. Body: `{ order_id, action: 'cancel' | 'revise', reason?: string, notify?: boolean }`.

- **cancel** — conditional `update orders set status='cancelled' where id=? and status in ('sent','revision')` (so it can't cancel a `paid`/`fulfilled` order — those are revision/refund territory). On success, if `notify`, post the `order_cancelled` template as a **customer reply** on the proof's HS conversation (reuse `_shared/helpscout.ts` + the `send-helpscout-reply` pattern — attributes to the caller, falls back to the conversation assignee / default user). Audit `order.cancelled` (reason: abort | reopen).
- **revise** — conditional `update orders set status='revision', revised_at=now() where id=? and status in ('paid','fulfilled')`. On success, if `notify`, post the `order_revision` template as a customer reply. Audit `order.revision_started` with `before.status` (so paid-vs-placed is recorded).
- Best-effort HS post (a post failure logs + still returns ok — the state change is the important bit). Returns `{ ok, status }` or `{ ok:false, error }`.

### 3b. `place-order` (MODIFY) — accept `revision` as placeable
- Top guard (`index.ts:370`): `if (order.status !== 'paid' && order.status !== 'revision') return 409`.
- `markPlaced` (`index.ts:672`, the conditional flip at `:693`): `.in('status', ['paid','revision'])` instead of `.eq('status','paid')`. A revision re-place therefore flips `revision → fulfilled`.
- **Re-place attestation:** if the order was *previously placed* (`fulfilled_at` is non-null — column from migration 000234), the confirm requires `old_job_cancelled: true` in the body; place-order rejects the confirm without it (409 "Cancel the old Stock Control job first") and records the ack in the `order.placed` audit `afterValue`. A first-ever placement (`fulfilled_at` null, e.g. scenario 3) needs no ack.
- Everything else (config-driven supplier scope, per-supplier template, note, Dropbox attach) is unchanged — the re-hand-off carries the **new** artwork because the Dropbox folder was re-prepped and the proof re-approved.

### 3c. Order-aware **reopen** (`ProofDetailPage.tsx` `handleReopen`)
Reopen is the single entry point for "changes". It already loads the latest order
(`hasOpenOrder`/`latestOrder`, the Tier-2 order panel). Branch the confirm dialog
on the latest order's status:

- **none / cancelled / expired** → plain reopen (existing `reopen_proof`).
- **`sent`** → "Reopening will cancel the unpaid order link." → `order-lifecycle(cancel, reason:reopen, notify:true)` → `reopen_proof`.
- **`paid`** (not placed) → strong warning: *"This order has been PAID (£X on {date}) but not yet placed. Reopening holds it for revision — the payment is NOT refunded automatically; refund/credit it yourself if the change affects the price."* → `order-lifecycle(revise, notify:true)` → `reopen_proof`.
- **`fulfilled`** (placed) → strongest warning + a **required checklist** before the button enables:
  - *"This order was placed with {supplier | in-house production} on {date}. Before reopening: (1) cancel the job in Stock Control, (2) check with {QX/Swype/Solopress | the workshop} that it has NOT printed. The previously-approved artwork must not be produced."*
  - required checkbox: ☐ "I've cancelled the Stock Control job."
  - → `order-lifecycle(revise, notify:true)` → `reopen_proof`.

`reopen_proof` (unchanged) clears all approvals + flips the proof to `in_progress`
— this is the "reverts to pre-approved" the workflow relies on.

### 3d. `OrdersPage.tsx` — "Being revised" section + Cancel button
- New section **"Being revised · N"** (orders where `status='revision'`), between
  "To order" and "Recently ordered". Each card: the loud banner *"PAID · REVISION
  IN PROGRESS — do not produce the previous artwork"*, the proof link, `revised_at`
  ("being revised since…"), and the **Review & place** button — enabled only once
  the proof is **re-approved** (place-order enforces `status='approved'`) and the
  Dropbox folder is re-verified (the existing folder gate). For a previously-placed
  order it also shows the ☐ "old Stock Control job cancelled" check that gates the
  re-place (passed to place-order as `old_job_cancelled`).
- **Cancel** button on each "Awaiting payment" (`sent`) card, beside Reactivate →
  confirm dialog → `order-lifecycle(cancel, reason:abort, notify:<choice>)`. The
  dialog (July 2026: `CancelOrderDialog`, replacing the original `window.confirm`)
  carries an "Email the customer to let them know" checkbox — ticked by default
  (posts the `order_cancelled` reply, the original behaviour); untick to cancel
  **silently** (no customer email — for correcting a mistake before sending a
  fresh link). The order leaves the list (the page query is
  `.in('status',['sent','paid','fulfilled'])`; add `'revision'` so the new
  section populates — cancelled stays excluded).

### 3e. `OrderPayPage.tsx` — non-payable states
The customer page status union already includes `cancelled`. Add explicit, calm
states so a stale link reads cleanly (checkout already 409s server-side):
- `cancelled` → "This order has been cancelled. Get in touch if you'd like to reorder."
- `revision` → "We're updating your cards — a new link will follow once the revised proof is approved."

---

## 4. The anti-stale-artwork defence (layered)

1. **Re-approval forced** — `reopen_proof` clears every approval; the proof can't be re-placed until the *new* version is explicitly re-approved (place-order requires `status='approved'`).
2. **Version-scoped approved-artwork** — the proof's "Approved artwork" table + ZIP serve only the *current* version (fixed earlier this session), so the old artwork is never downloadable once a new version is current.
3. **`revision` parks the order** — out of the placeable pipeline; it can't be placed from the "To order" queue with old artwork.
4. **Dropbox re-prep required** — the folder is the production source; the place gate already requires a verified folder. Add a one-line reminder on the revision card: "replace the old files in the Dropbox folder."
5. **Re-import is gated on the old job being cancelled** — Stock Control's importer no-ops a re-post for a still-live order number (idempotency); it only re-imports once the old job is `cancelled` there. So a half-done revision **cannot silently double-place**, and the re-place attestation (3b) makes the human step explicit.

---

## 5. Cross-app contract (Stock Control)

Verified from the deployed `helpscout-inhouse-order` importer:
- Every Stock Control job is keyed on the **order number** (the Dropbox-folder
  number = the HS subject number) — this stays constant across a revision.
- The importer **ignores cancelled orders** (`.neq('status','cancelled')`), so a
  cancelled job can be **corrected and re-imported**. ⇒ re-placing the same order
  number after the old job is cancelled re-imports the **new** artwork cleanly.

**What proof-viewer cannot do (deliberately human):**
- Cancel the Stock Control job — done by a person in Stock Control (no proof-viewer
  signal for it; the importer has no "cancel" note format). The re-place attestation
  (3b) records that the human did it.
- Un-send the supplier email / un-print a started run — impossible; the checklist
  forces the "has it printed?" check.

---

## 6. Money (out of scope to automate)
- **Same spec/price** (artwork tweak): the original payment stands — nothing to do.
- **Price changed**: refund/credit or top-up handled **manually** in Stripe + Xero.
  The warnings state this; automating refunds is a separate, riskier piece.

---

## 7. Audit + templates
- Audit events: `order.cancelled` (reason), `order.revision_started` (before.status),
  `order.placed` (already exists; gains `old_job_cancelled` on a re-place).
- Templates: `order_cancelled`, `order_revision` (editable in Admin → Templates;
  variables `first_name`/`company`; exclude is not needed — they belong in the
  generic editor, unlike the supplier ones).

---

## 8. Build order

**Phase 1 — unpaid (low risk, no Stock Control involvement):**
1. `order-lifecycle` edge fn (cancel action only) + `order_cancelled` template (seed can ride in 000260 or its own tiny migration).
2. Pay-page `cancelled` state.
3. Orders-page Cancel button (`sent` cards).
4. Order-aware reopen for the `sent` case (cancel + reopen).

**Phase 2 — paid revision:**
5. Migration 000260 (`revision` status + `revised_at` + `order_revision` template).
6. `order-lifecycle` revise action.
7. `place-order` accepts `revision` + the re-place attestation.
8. Orders-page "Being revised" section + the re-place ack.
9. Reopen warnings/checklist for `paid` / `fulfilled`.
10. Pay-page `revision` state.

Phase 1 is independently shippable and covers the common abort/early-change cases;
Phase 2 adds the post-payment revision path with the production safeguards.

---

## 9. Explicitly out of scope
- Automated refunds / Xero credit notes / price top-ups.
- proof-viewer auto-cancelling a Stock Control job (stays a human action there).
- Recalling a supplier email or a started print run (impossible; checklist-gated).
