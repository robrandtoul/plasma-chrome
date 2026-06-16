# Ordering & checkout — build brief

Status: **agreed in principle, not yet building.** This spec encodes the design
worked through with Rob on 2026-06-14. It is a design brief to react to, not a
final implementation plan — verify every live-DB and Xero/Stripe assumption
against the real systems before writing code. Where this spec disagrees with
older docs, this spec wins.

## Why

Today, once a customer approves a proof, the order is taken by hand: we email
asking for quantity / billing / shipping, the customer replies in prose, a
staff member retypes it into Xero (contact + invoice), emails the invoice with
a "Pay by Stripe" link, and the customer pays. It is multi-touch, multi-day,
double-keyed, and error-prone. Every other online vendor does this as a
checkout. This feature replaces the retyping and the email ping-pong with a
staff-built order and a customer pay-page, while **keeping human judgement on
the two things that need it** — custom pricing and shipping discretion.

It also gives us, as a side-effect, a clean reorder surface: an approved proof
already holds the artwork, material, currency and name roster, so "the same
again" becomes a button rather than a fresh enquiry. (Reorder UX is out of
scope for v1 but the order object is designed not to preclude it.)

## Decisions (locked, Rob 2026-06-14)

- **Model: designer-prepared order + customer pay-page.** Not a self-serve
  shopping cart. The designer builds the order (applying judgement), locks the
  parameters, and sends the customer a link whose only job is "confirm where
  it's going, and pay." The pricing intelligence stays with a human; the
  customer gets the modern checkout *experience* at the end.
- **Accounting: Stripe-led, sync to Xero.** The customer pays via our Stripe
  Checkout on **the existing Stripe account**; the app creates the Xero invoice
  on payment success. See the Stripe → Xero contract below — it is the part
  that most needed certainty and is now pinned down.
- **Build in parallel, gated by an admin toggle.** All new code is additive and
  inert until switched on. Staff use the existing system unaffected by default.
  Same pattern as `settings.ai_drafts_mode` and `settings.auto_nudges_enabled`.
- **Shipping discretion is expressed as a *treatment* the designer picks, not a
  number they type.** Each treatment is a predefined rule with its absorption
  capped in absolute pounds, per zone. This is what lets the customer keep
  choosing quantity (a rule recomputes live; a fixed number could not).
- **Quantity lives on the pay-page, not the approval step.** Approval is an
  artwork decision; quantity is a purchase decision. Grid-priced proofs default
  to customer-selectable quantity; the designer can lock it.
- **Custom-quote proofs and bespoke-shipping orders stay in a manual lane** —
  the designer hand-sets the figure. This is one option on the same order
  builder, not a separate system.

## Architecture rule #1: additive and inert until toggled on

The existing approve → manual-Xero-invoice flow must be **completely
untouched** by this work. New tables, new edge functions, new routes only.
A single master switch in `settings` (e.g. `ordering_mode` `off`/`on`, or an
`ordering_enabled` boolean — match whichever shape the live `settings` table
already favours; verify before adding) gates every entry point:

- **off (default):** no "Create order" button on approved proofs; the customer
  pay-page route returns not-found for any token; nothing changes for staff.
- **on:** the order builder and pay-pages activate.
- **allowlist:** support a per-designer allowlist for first rollout, mirroring
  the nudge rollout — switch on for one or two people, watch real orders flow,
  then open up.

## Architecture rule #2: the app creates the invoice, the Stripe feed settles it

Xero pulls Stripe transactions into the Stripe account **in near-real-time**
(confirmed by Rob, the day-to-day bookkeeper, 2026-06-14). That single fact
determines the money-side design:

1. Customer pays on the pay-page via Stripe Checkout, on **the existing Stripe
   account**.
2. On payment success, the app **creates the Xero invoice** (itemised,
   VAT-correct) and **stops there — it does NOT record a payment.**
3. The existing Stripe feed pulls the charge into the Xero Stripe account as a
   statement line, exactly as today.
4. That line reconciles against the new invoice — auto-matched by a **shared
   reference** the app stamps on both the Stripe payment and the Xero invoice —
   marking it paid.

**The app must never apply the payment itself.** Because the feed already
brings the money in as a statement line, an app-recorded payment would
double-count (invoice paid twice / orphaned statement line / overpayment). The
feed *is* the payment event, as it is today. The app's job ends at creating the
invoice.

Consequences:

- **No phantom invoices.** The invoice is created only on payment *success*, so
  abandoned checkouts leave nothing in Xero to void.
- **No double-counting.** App creates; feed settles.
- **Money is never invisible.** If the app's invoice-creation step ever failed
  (missed webhook), the cash still appears in Xero as an unreconciled Stripe
  line — the feed is its own backstop. A reconciliation check ("paid Stripe
  lines with no matching invoice") surfaces any slip for a one-click retry.
- **Daily sweep unchanged.** The gross-minus-fees daily transfer to the current
  account, and all fee handling, are completely untouched — we only change how
  the invoice is born (auto, instead of hand-typed).
- **Invoice always matches the money.** The invoice is generated *from* the
  settled payment amount, so it can never disagree with what was received.

VAT: the tax point is the payment instant; the customer still receives a proper
Xero VAT invoice, generated already-paid and emailed as a receipt.

## The order object

One new table (schema-qualified `proofs.orders` per the merged-project
convention; full grant matrix required — the proofs schema has no default
privileges), hanging off a proof:

- link to the proof (and therefore artwork, material, currency, contact roster)
- status: `draft` → `sent` → `paid` → `fulfilled` (plus `expired` / `cancelled`)
- locked line items: cards (variant + quantity, or quantity-open), split
  tooling (auto from name count, overridable), personalisation, custom-quote
  price if any
- chosen **shipping treatment** (a reference to a predefined rule, not a number)
- currency + VAT treatment (inherited from the proof)
- a customer-facing token for the pay-page URL, and an expiry timestamp
- the shared reference used for Stripe ↔ Xero matching
- audit columns (created_by, sent_at, paid_at, Xero invoice id once created)

Line prices are read **live** at order-build time (the customer page already
reads pricing live, post-000117), so an order never honours a stale figure.

## Shipping treatments

Discretion encoded as a short menu of named rules, each with absorption capped
in absolute pounds, **per zone** (the engine already splits domestic flat-DPD
from international FedEx, and FedEx is keyed on destination):

- **Charge full cost** — pass on the true rate.
- **Goodwill** — subsidise up to £C (per zone); customer pays `cost − min(C,
  cost)`. Bounds our exposure regardless of order size or destination.
- **Free shipping** — fully absorbed.
- **Manual** — type a bespoke figure (the escape hatch for genuinely odd
  orders / custom quotes).

**Domestic UK (locked, Rob 2026-06-14).** UK orders default to the existing
flat published DPD rate (mainland / Northern Ireland, migration 000179) and are
**not** discounted — so the Goodwill cap doesn't apply here (a flat rate has no
runaway to bound). The designer can still override a single UK order to **Free**
or a **specified fixed amount** from the same menu; those are available but
never the default. So the menu is universal, but the *base figure* it operates
on is the flat DPD rate for UK and the live FedEx rate internationally, and the
Goodwill-cap treatment is meaningful only for the variable international base.

The builder **pre-selects** a sensible treatment from the loosely-known
destination (captured at the currency stage), and the designer confirms or
nudges it — smart default + human override. A **manual-review threshold** (raw
shipping above a per-zone line, or a Rest-of-World destination) drops the order
out of the automated path so the long tail of exotic/large shipments is a
handled exception, never an unbounded exposure.

Because the treatment is a *rule*, the pay-page recomputes the shipping line
live as the customer changes quantity (weight scales with quantity; zone stays
fixed to the designer's assumption), always inside the cap. The customer's
entered delivery address does **not** re-price shipping — it is captured for
delivery only; a wildly out-of-zone address is the rare case handled by hand.

## Non-standard quantities (price interpolation)

Customers often want a quantity that isn't a listed tier (e.g. 60 between the
50 and 75 rows). Today this is handled by hand: staff look at the two prices
either side and weight slightly upward. The ordering flow must do this
deterministically.

**Scoped exception.** The existing rule — *no interpolation between listed
tiers; the picker snaps* — stays in force on the **proof page** and the
**marketing price-list**, which advertise published prices. Interpolation
applies **only** on designer-only / ordering surfaces: the Quote compiler and
the customer pay-page. This boundary must not leak interpolated figures onto
the advertised surfaces.

**One shared engine.** The interpolation lives in `src/lib/quote/calculate.ts`
— already the pure, side-effect-free pricing function, and already the place
that computes the bracketing tiers. Today, for an in-between quantity,
`calculate` returns `total: null, validTier: false` plus `snap.lower` /
`snap.upper` hints (the designer interpolates mentally). The interpolation
drops straight into that gap. Both the Quote compiler (now) and the
order/checkout (later) consume the same function, so **the quoted price is
byte-identical to the price the customer pays.**

**Formula** (for quantity Q strictly between tiers Q_low @ P_low and
Q_high @ P_high):

1. Linear-interpolate the base total between the two tiers.
2. Apply a configurable upward weighting % (admin-set — the "weight slightly
   upward").
3. Round up to a tidy figure (always up, never down).
4. Clamp to `[P_low, P_high]`.

**Guardrails:**

- Never cheaper than the lower tier (60 ≥ 50's price).
- Never dearer than the upper tier (60 ≤ 75's price) — so ordering *more* is
  never cheaper. (This is the trap a naïve marginal-rate method falls into near
  the top of a band.)
- Exact tier match = exact published price, no weighting.

**Ends:** below the lowest tier → no downward extrapolation (enforce a minimum
order quantity); above the highest tier → keep the compiler's existing
custom-quote bail.

**Surface behaviour.** `calculate` returns a new flag (e.g. `interpolated:
true`, distinct from `validTier`) so the UI shows the price **labelled as an
estimate** with the two anchor tiers beside it ("£117 — between 50 and 75"),
not hidden — and offers a natural override point (flip to custom quote). The
existing `discountPercent` knob stays independent: discount pulls the total
down, weighting nudges the interpolated base up.

**Surcharge wrinkle.** Surcharges are resolved at the chosen quantity before
`calculate` is called:

- **Split-name tooling** — flat per extra name, quantity-independent, so
  unaffected.
- **Personalisation** — a continuous formula (`max(min, qty × rate)`), so it
  resolves at any quantity.
- **Finish surcharge** (metal Brushed/Mirror) — a *per-quantity schedule* (the
  39-tier grid), so it has the same "no exact row for 60" problem and needs the
  same bracketing/interpolation treatment, or the base interpolates while the
  finish surcharge fails to resolve.

**Calibration bench.** Because the Quote compiler is designer-only, switch
interpolation on there first, quote a few real in-between jobs, and confirm the
weighted figures match the manual instinct *before* any customer sees them at
checkout.

## Staff workflow: the order builder

Lives on the approved proof page (`/proofs/:id`). A "Create order" button (only
when the toggle is on) opens a builder pre-filled from the proof:

- customer / contact / company, currency, material, variant, artwork → prefilled
- split tooling → auto-calculated from the name count
- destination zone → shipping treatment pre-selected
- live price grid → already present

The designer's actual inputs: confirm/leave-open quantity, confirm or nudge the
shipping treatment, (custom quote only: type the figure), then **Send**. A
templated email with the pay-link goes out. For a standard order this is
~30–60 seconds of review and one click, versus today's collect-interpret-
retype-send-reconcile across multiple days.

## Customer workflow: the pay-page

A customer-facing route (e.g. `/order/:token`), styled as a calm continuation
of the proof page (Plasma UI kit, customer-accent), ideally one scroll:

1. **Recap** — thumbnail of the approved artwork + spec, as a trust anchor.
2. **Quantity** — selector locked to real price tiers (or fixed if locked),
   total updating live.
3. **Live order summary** — cards + tooling + personalisation + shipping + VAT,
   recalculating with quantity.
4. **Delivery address** — captured for fulfilment.
5. **Pay** — Stripe Checkout (billing address + card / Apple Pay / Google Pay).
6. **Confirmation** — order confirmed, what happens next, VAT receipt.

Edge states to design explicitly:

- **expired** — shipping quote gone stale; "this order has expired, contact us".
- **already paid** — idempotent "already paid, thank you"; prevents double pay.
- **abandoned** — retryable; no invoice created.
- **revised** — designer reissued; old token superseded.

Principle: the customer already approved the artwork, so this page asks only
*how many, where to, and pay* — mobile-first, in Plasma's voice.

## Post-payment / fulfilment

A paid order must become a visible "go print this" signal for the team, with
the approved artwork attached, and the artwork must flow to production. The
post-payment side deserves as much design as the checkout itself (it is not in
detail here yet — flagged as a first-class part of the build, not an
afterthought).

## Preconditions & suggested build sequence

**Greenfield integrations (verified 2026-06-14).** The app has **no existing
Stripe or Xero integration** — a repo grep for `stripe`/`xero` finds only an
unrelated domain regex and a VAT comment. Today's entire payment flow happens
*outside* the app: a Xero-hosted invoice carrying Xero's native "Pay by Stripe"
link (Xero payment services), which is how Xero auto-settles the right invoice.
Two consequences a builder must hold:

- **Stripe Checkout** (the pay-page payment surface) and the **Xero API**
  (invoice creation) are both net-new builds — credentials/OAuth, edge
  functions, the webhook handler. Budget for them as first-class infrastructure,
  not glue.
- **The new flow replaces Xero's native Pay-by-Stripe link.** The customer pays
  on our pay-page, not on a Xero invoice. So the existing auto-match (link tied
  to invoice number) is *not* the mechanism here — settlement instead relies on
  the near-real-time Stripe bank feed reconciling against the app-created
  invoice via the shared reference (Architecture rule #2).

**Suggested starting sequence (not locked — Rob was still exploring sequencing).**
Ordered smallest-risk-first, each slice independently useful:

1. **Interpolation in `calculate.ts` + the Quote compiler surface.**
   Designer-only, needs no payment/accounting infrastructure, and delivers
   standalone value (better quotes + the calibration bench) even if everything
   below stalls. The safest first slice.
2. **The order object** (the `proofs.orders` table + full grant matrix) and the
   `settings` toggle.
3. **The order builder UI** on the proof page (behind the toggle).
4. **The customer pay-page + Stripe Checkout** — the first net-new integration.
5. **The Stripe webhook → Xero invoice creation** + shared-reference matching —
   the second net-new integration, and Architecture rule #2 in code.
6. **The post-payment fulfilment signal.**

Steps 1–3 touch no external money systems at all, so the genuinely novel risk
(Stripe + Xero) is concentrated in 4–5 and can be de-risked on its own.

### Build status (2026-06-14, autonomous run)

- **Step 1 — DONE & verified.** Price interpolation shipped: `src/lib/quote/
  interpolation.ts` (the shared engine), `calculate.ts` (`interpolated` flag +
  in-between branch), the finish-surcharge schedule fix in `QuotePage`, and the
  "estimated" labelling on `HeadlinePrice` / `QuantityInput`. 24 unit tests
  (`pnpm test:quote`) green; full `pnpm build` clean. The three knobs ship as
  PROVISIONAL placeholders in `interpolation.ts` (upwardWeighting 0.05,
  roundUpToIncrement £1, MOQ = lowest tier) for Rob to calibrate on the
  compiler, then graduate to admin config.
- **Step 2 — DONE.** `000228` (the `ordering_enabled` toggle on
  `proofs.settings`) and `000229` (the `proofs.orders` table) were APPLIED to
  the live merged project via MCP `apply_migration` (Rob authorised, 2026-06-14)
  and verified live: column present; table present (20 cols, RLS on, 1 policy);
  `authenticated` full CRUD, `service_role` full, anon nothing. The admin master
  toggle is wired house-style into `AdminSettingsPage` (new "Ordering & checkout"
  section, defaults off). `pnpm build` clean.
- **Step 3 — DONE (code built + edge function deployed).** The `create-order`
  edge function (`supabase/functions/create-order/index.ts`, registered in
  `config.toml`), the `OrderBuilderModal`, the `getOrderingEnabled` gate, the
  `customerOrderUrl` helper, and the "Create order" button on approved proofs
  (gated by `isApproved && orderingEnabled`) are all built; full `pnpm build`
  clean. `create-order` was DEPLOYED to the live project via MCP (status ACTIVE,
  `verify_jwt = false`, Rob authorised 2026-06-14). The whole surface stays inert
  behind the OFF toggle. **Verified end-to-end by Rob on the preview
  (2026-06-14):** toggle on → Create order on an approved proof → order row
  created with pay-link.
- **Step 4 — checkout (custom-quote slice) built; payment-function deploy
  pending explicit approval.** Decisions locked (Rob 2026-06-14): hosted
  **Stripe Checkout**, **14-day** expiry, **test mode first**; `STRIPE_SECRET_KEY`
  (test) set on the live project. Built + verified: `000230` `public_get_order`
  (APPLIED + verified), the `/order/:id` pay-page (recap + not-found / payable /
  already-paid / expired / optimistic-paid states), and `create-checkout-session`
  — an anonymous, token-validated edge function that computes the amount
  **server-side** (so the client never prices money) and returns a Stripe
  Checkout URL. `pnpm build` clean. **Both pricing paths built:** custom-quote
  (amount = agreed total) and **grid** (price tiers + interpolation + split-name
  tooling + personalisation, via the shared `_shared/orderPricing.ts` helper —
  the single server-authoritative source of truth, kept in lockstep with the
  Quote-compiler engine, unit-tested via `pnpm test:order-pricing`). The order
  builder captures the **variant** for grid orders (auto-selected when the
  material has one priced variant; a dropdown when several). Shipping is
  **free/manual** for both; the address-dependent treatments
  (`full_cost`/`goodwill`) are the remaining increment. The pay-page shows the
  total inline for custom quotes and "Continue to secure payment" (total shown
  on Stripe) for locked grid orders.
  **Open (customer-chosen) quantity — BUILT (pay-page + edge function; deploy
  pending Rob's authorize).** When the designer leaves quantity open, the
  pay-page renders a quantity selector populated from the order variant's
  listed price tiers and shows a live total (exact tier → byte-equal to the
  server figure). `create-checkout-session` accepts the chosen quantity, binds
  it to a listed tier (rejects anything else, so the price can't be bent
  client-side), prices it via the shared `orderPricing` helper, and persists it
  to `orders.quantity` so the Stripe→Xero webhook itemises the invoice at the
  quantity actually paid. Also stamped into Stripe `metadata[quantity]`.
  **Per-person quantities — BUILT (migration `000235` + pay-page + edge function
  + fulfilment; migration apply + checkout redeploy pending Rob).** A split-name
  order can carry a different quantity per person (Alec 100, Kyle 50), not just
  an implied equal split. Term is **"person/people"** (Rob 2026-06-15); pricing
  is **combined-total** (sum drives the tier price, interpolated off-tier), with
  the per-person breakdown persisted (`orders.person_quantities` jsonb) as the
  production instruction shown on the fulfilment page ("Make 100 Alec, 50 Kyle").
  Pay-page renders a quantity field per person for open multi-person orders;
  `create-checkout-session` sums + validates + prices + persists the split.
  Single-person open orders keep the tier selector; locked orders keep the fixed
  total. "Recipients" relabelled "People" throughout.
  **Pay-page recap — BUILT.** A trust-anchor block at the top of the pay-page
  shows up to three approved-artwork thumbnails (from the same
  `customer-proof-images` edge function the proof page uses) plus a one-line
  spec (material + locked variant), best-effort from `public_get_customer_proof`.
  `create-checkout-session` DEPLOYED to the live project via MCP (Rob authorised
  2026-06-14). **Remaining:** Rob's test-card click-test (create a grid order,
  locked quantity + free/manual shipping → pay-link → Stripe test card 4242…).
  Then Step 5 (webhook → Xero — flips status to paid + writes the invoice) and
  Step 6 (fulfilment). **Grid checkout end-to-end verified by Rob on the preview
  (2026-06-14): a locked-quantity order priced server-side to £199 and reached
  Stripe's hosted Sandbox checkout.**
- **Step 5a — Stripe webhook (order → paid): BUILT; deploy + secret pending.**
  `stripe-webhook` edge function verifies the `Stripe-Signature` (manual
  HMAC-SHA256 + 5-min replay tolerance, raw body) and, on
  `checkout.session.completed` with `payment_status = paid`, flips the order
  `sent → paid` idempotently (keyed on `metadata.order_id`). Per Architecture
  rule #2 it does NOT record the payment — the existing Stripe→Xero feed settles
  it; this only updates our status. Registered in `config.toml`
  (`verify_jwt = false`). **Outstanding:** deploy the function, then register its
  URL as a Stripe webhook endpoint and set `STRIPE_WEBHOOK_SECRET`. Step 5b (the
  Xero invoice write, needs Xero OAuth) follows. **DEPLOYED + verified end-to-end
  by Rob (2026-06-14): a test-card payment fired the webhook and flipped
  `ORD-0A41498347` to `paid` (paid_at stamped); the pay-page shows the real Paid
  state.** Webhook registered in Stripe (test) as a Snapshot destination on the
  latest API version, listening to `checkout.session.completed`.
- **Step 5b — Xero invoice write: BUILT + connected; pending a test-pay verify.**
  Xero OAuth connection is live (migration `000231` `proofs.xero_connection`
  token store; `_shared/xero.ts` OAuth + rotating-refresh-token helper;
  `xero-oauth-start` / `xero-oauth-callback` functions; admin **Connect Xero**
  button). Rob connected the **Demo Company** (tenant stored) on 2026-06-14.
  **Scope gotcha resolved:** Xero replaced broad scopes with granular ones for
  apps created after 2 Mar 2026 — we use `openid accounting.contacts
  accounting.invoices offline_access` (the old `accounting.transactions` caused
  the `invalid_scope` 500s). On `checkout.session.completed`, `stripe-webhook`
  now best-effort creates an AUTHORISED Xero invoice (`createSalesInvoice`):
  contact from the Stripe payer, amount from `session.amount_total`,
  `Reference = payment_reference`, GBP VAT-inclusive / EUR-USD NoTax, revenue
  account 200 (override via `XERO_SALES_ACCOUNT_CODE`); the order's
  `xero_invoice_id` is stamped on success. Per Architecture rule #2 the app
  only CREATES the invoice — the Stripe bank feed settles it via the Reference.
  **Remaining:** Rob test-pays a Demo-Company order and confirms the invoice
  appears in Xero (then verify the account code / tax treatment with the
  bookkeeper before live). Cosmetic: the OAuth callback success page renders as
  raw HTML (content-type quirk) — tidy later.
- **Step 6 — fulfilment signal: BUILT (frontend live; migration + webhook
  redeploy pending Rob).** A paid order now becomes a visible "go print this"
  surface for the team. Three pieces: (1) **migration `000234`** (AUTHORED, NOT
  YET APPLIED) adds `fulfilled_at` / `fulfilled_by` and the delivery address
  (`ship_to_name` / `ship_to_email` / `ship_to_address` jsonb) to `proofs.orders`
  — additive, inherits the 000229 grants; (2) **`stripe-webhook`** now persists
  the Stripe delivery name/email/address onto the order atomically with the
  `sent → paid` flip (it already parsed that address for the Xero invoice — now
  it stores it too); needs a redeploy to take effect. (3) The **`/orders`
  fulfilment page** (`src/pages/OrdersPage.tsx`, routed + a toggle-gated "Orders"
  nav pill in `DesignerHeader`) lists paid orders awaiting dispatch with a
  representative artwork thumbnail, spec, quantity, delivery address, reference,
  Xero-invoiced pill, and a **Mark as fulfilled** button (→ `status='fulfilled'`,
  `fulfilled_at`/`fulfilled_by`), plus a quiet "Recently fulfilled" list. The
  nav pill stays hidden until `settings.ordering_enabled` is on. Artwork still
  flows to production via the linked proof page; a thumbnail-per-proof is a
  recognition aid (one `customer-proof-images` call each). **Remaining:** Rob
  applies `000234` + redeploys `stripe-webhook`, then a test-pay confirms the
  delivery address + the queue render.

## Autonomy boundary & guardrails

This feature is intended to be built largely hands-off (Claude Code in an
autonomous / multi-agent mode). Autonomy changes nothing about the design but
adds two requirements: a firm boundary between work an agent may run unattended
and work that must stop for a human, and standing rules the agent cannot drift
past.

**The boundary:**

- **Autonomy-safe — Steps 1–3.** Frontend plus additive DB behind a toggle that
  defaults OFF. The worst case from a mistake is dead code that is switched off:
  no customer impact, no money moved, no prod-data risk. An agent may build,
  test, and commit these unattended, pausing only at the checkpoints below.
- **Human-gated — Steps 4–6.** Live Stripe credentials, live Xero OAuth, real
  customer money, and the prod migration for the order table. An agent must NOT
  wire live payment/accounting secrets, apply any migration to the live
  (`bjvinrzbdrwebylkmbwy`) project, or flip the ordering toggle on. These steps
  stop and hand back to Rob.

**Standing guardrails (non-negotiable, every step):**

- Never commit secrets or credentials; never hardcode API keys.
- Never `git add -A` — stage explicit paths only (stray `_tmp_*` files exist).
- Never apply a migration to prod — author it, then hand to Rob to apply via the
  dashboard SQL editor (the CLI push path is dead; see CLAUDE.md).
- The ordering toggle stays OFF for the whole build; only Rob flips it.
- The existing approve → manual-Xero-invoice flow must stay untouched and fully
  working at every commit.
- `pnpm build` clean + the relevant test suite green before every commit;
  "done" means tests pass, not "looks right".
- Work only behind the toggle / in new files; if a change seems to require
  touching the existing flow, stop and ask.

**Checkpoints (where the agent pauses for Rob):**

1. End of Step 1 — Rob calibrates the interpolation placeholders (weighting %,
   rounding, MOQ) on the Quote compiler.
2. The boundary before Step 4 — Rob supplies Stripe + Xero credentials and the
   locked commercial decisions (below), and confirms the reconciliation.
3. Before flipping the toggle on / the first live order — Rob's explicit go-live.

**Multi-agent shape.** The six steps are largely sequential, so parallelism is
intra-step, not whole-step: e.g. the interpolation engine alongside the
shipping-treatment rules, or the pay-page UI alongside the Stripe edge function,
with a reviewer/critic agent running against the builder (the same
adversarial-review pattern the nudge and AI-draft features used).

## Out of scope for v1

- Customer self-serve reorder (the object is designed not to preclude it).
- Deposits / part payment (currently pay-in-full only; the model leaves room).
- Refunds beyond the basic path (Stripe refund → Xero credit note) — needs its
  own short design pass.
- Full self-serve checkout with no human touch — deliberately not the model.

## Decisions to lock before autonomous build

An autonomous agent cannot stop mid-build to ask, so every decision below must
resolve to one of: a **locked value** written into this spec, or **admin-config
with a flagged placeholder default** the agent ships and Rob calibrates later.
Items marked **(gate)** block the human-gated phase (Steps 4+) specifically and
can be deferred until then; everything else must be settled or placeholdered
before the autonomous Steps 1–3 run.

- **Interpolation weighting %, rounding granularity, minimum order quantity** —
  ship as admin-config with placeholder defaults; Rob calibrates on the Quote
  compiler (Step 1 checkpoint). Does not block Step 1.
- **`settings` toggle shape** (boolean vs mode enum) — Rob confirms, or the
  agent matches whatever the live `settings` table already favours and records
  the choice. Blocks Step 2.
- **Domestic-UK shipping — LOCKED (Rob 2026-06-14).** Default the existing flat
  published DPD rate (000179), not discounted; per-order override to Free or a
  specified fixed amount available from the menu. No per-zone cap needed for UK.
  No longer blocks Step 3.
- **Per-zone shipping caps + manual-review thresholds** — Rob to set from the
  real spread of destinations. Ship the treatment *mechanism* with placeholders;
  the figures block go-live, not the build.
- **Show the shipping subsidy as a perk, or keep it silent** — copy decision;
  default silent, Rob can switch it on. Does not block.
- **(gate) Stripe Checkout vs Payment Element / Payment Links** — Rob decides
  before Step 4.
- **(gate) Link expiry window** — Rob sets before Step 4.
- **(gate) Stripe + Xero credentials / OAuth** — Rob supplies before Steps 4–5.

## Xero invoice self-test (verification tool)

Built 2026-06-16. Admin → **Xero self-test** (`/admin/xero-self-test`,
`AdminXeroSelfTestPage`) verifies that every product type produces an invoice
with the correct Xero item code — and surfaces the tax rate Xero resolves —
without paying through Stripe checkout for each one.

- Edge function `xero-invoice-selftest` (admin-gated). For each active variant,
  each option that carries its own code (the wood species), plus one case each
  for split-name tooling and UK / international shipping, it synthesises an order
  and runs it through the **same** line builder the live webhook uses
  (`_shared/invoiceBuild.ts`, extracted from stripe-webhook for exactly this so
  the test can't pass on logic the real invoice wouldn't run). It batches one
  **draft** invoice per case into the connected Xero org (`summarizeErrors=false`
  so each validates independently), reads back the ItemCode / TaxType /
  AccountCode Xero resolved, and asserts the code matches the database.
- `action: 'cleanup'` deletes every draft whose Reference starts with `SELFTEST`.
  Drafts never hit the ledger, so a run is non-destructive and reversible.
- **Org caveat:** the test runs against whatever org the app's `xero_connection`
  points at. On the Demo org, products fall back / report "rejected" if Demo
  lacks Plasma's item catalogue — the meaningful run is after the app is pointed
  at the live PlasmaDesign Ltd org, just before go-live.
- Shared plumbing: `createSalesInvoice` now returns `{ invoiceId, error, invoice }`
  and accepts `{ status: 'AUTHORISED' | 'DRAFT' }`; the one-invoice body assembly
  lives in `buildInvoicePayload` so both the live path and the batch self-test
  share it.
