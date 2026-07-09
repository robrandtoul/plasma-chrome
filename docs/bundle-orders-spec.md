# Bundle orders — buying two or more different-material cards in one proof-and-pay flow

**Status:** design agreed, not yet built · **Working name:** "Bundle" (placeholder — see Open points) · **Origin:** the Novion order, 8 Jul 2026 · **Audience:** a Claude Code session (or dev) with repo access, no prior context.

This is the build brief for letting a customer buy **more than one card** — typically for different people, on different materials (e.g. one steel, one letterpress) — through **one proof link, one approval flow, and one checkout**, without breaking how the work is made, invoiced and reconciled.

---

## 0. Handoff prompt (paste this into a Claude Code session)

> You're in the `proof-viewer` repo on branch `claude/novion-approval-process-u5krz6`. Read this whole file (`docs/bundle-orders-spec.md`), plus the **Ordering & checkout**, **Proof-type wizard**, and **Claude operating discipline** sections of `CLAUDE.md`.
>
> Implement **Slice 1 only** (see §10 and §12): the guardrails that stop a designer using version bumps to smuggle two different products into one proof, and a way to surface approvals stranded on superseded versions. **Slice 1 is frontend-only — no schema/migration changes.**
>
> Constraints: Rob is a non-coder — explain each step in plain English. Reuse existing components and the design kit in `src/design/`; match surrounding patterns. Run `pnpm build` before finishing to confirm types + bundle are clean. Do **not** touch the DB/migration path. Keep the diff to Slice 1 — if you spot Slice 2/3 work, note it, don't build it. Commit with a clear message and open a **draft** PR.

---

## 1. The problem (what went wrong with Novion)

A customer wanted **two cards** — Bita Najafi on **steel**, Hirok Poddar on **letterpress** — and intended to buy **both**. There was no way to offer that, so the designer improvised: built the steel card as **v1**, got it approved, then **replaced it** with the letterpress card as **v2** and got that approved too.

Result: the proof shows approved, but only **v2** can ever be turned into an order. The steel card (v1) is **stranded** — approved but unreachable, invisible on customer revisit, impossible to order. (That first case was untangled by hand; this feature stops it recurring.)

**Root cause:** a *version* means "a newer draft of the **same** card." The whole stack — the customer page, `_finalize_proof_if_complete`, and the order builder — treats the **current** version as *the* product. Two genuinely different products can't be modelled as versions of each other.

The sanctioned alternative today (a separate project per material — the wizard's "split-guard") fixes proofing but moves the pain to money: **two pay links, two invoices, two things to reconcile.** This feature closes that gap.

---

## 2. Core architecture — the bundle sits *above* the orders

The decisive constraint: **an `orders` row is a production record**, not just a payment. It carries the supplier, production route, stock-order number, Dropbox artwork folder, date-required and tracking. Steel and letterpress are made by different processes, likely different suppliers. **Two materials therefore can never share one order row.**

So the "buy both" concept must live in a **layer above the orders**, never inside one:

- **Bundle** = a light container over N cards for one customer purchase.
- **Card** = its own `proof` **and** its own `orders` row **and** its own fulfilment unit (exactly like today's single order).
- After payment, **the money converges up** to the bundle (one invoice per payment, one reconciliation) while **the making fans out** to each card (each produced and shipped independently).

This is why the design is a *composition* of existing parts, not a rebuild: each card keeps its own single-material price grid, approval, order and fulfilment; the bundle only adds a shell + a combined checkout.

---

## 3. Shared vs per-card

| Entered once, at bundle level | Chosen per card |
|---|---|
| Company / contact | Material + variant/spec |
| Help Scout conversation | Recipient name(s) |
| Currency | Artwork images |
| Delivery address & payer | Change notes & its own revisions |
| Combined shipping (billing) | Pricing, approval, order & fulfilment/dispatch |
| The one customer link | |

A bundle is **one destination, one payer, one currency** (see §7). Split-delivery / split-payer jobs route back to separate projects.

---

## 4. Customer experience

Approving the artwork and building the order are **two different jobs**, kept apart:

1. **One link → an overview.** Lists each card with a preview, price, and status; a progress strip ("1 of 2 approved").
2. **Approve each design.** Artwork sign-off only — the provable record. No commitment to quantity/spec yet. (For finishes that change appearance, all offered finishes are proofed, so the approval covers whichever is later chosen.)
3. **Build the order in the basket.** Each card expands **in place** into its own quantity/thickness/finish chooser (the *existing* `OrderPayPage` "Confirm your card" flow — see §9). One card open at a time, so the page stays a clean basket, not a wall. Price updates live so the customer can build to a budget.
4. **Open specs force an explicit choice.** Where the designer left thickness/finish/quantity **open**, nothing is pre-selected and the customer must actively pick before continuing; the "Most popular" badge guides but does not choose. Where the designer **locked** a spec at order-creation, it shows as a fixed value with no chooser. (This already matches the shipped pay page — `OrderPayPage.tsx:1682` "Explicit tap required — no pre-selection".)
5. **Discard.** A card the customer decides against is removed with a reason (reuse the existing decline panel), the basket reprices, and the dropped card becomes an ordinary abandoned proof. Nothing approved is lost.
6. **Pay once.** When every card is terminal (kept or dropped) and ≥1 is kept, a single checkout covers the lot — one payment, one receipt.

**Gate:** pay opens when no card is pending/in-revision and ≥1 is kept. If one card lags in revision, the **designer can release a ready card early** for its own payment (see §7).

Reference mock (visual only, not wired): the customer overview and the forced-choice chooser were prototyped during design — see the "real components" screenshot Rob has, and the archived artifacts. The build should use the real components, not those prototypes.

---

## 5. Designer experience

Each card is built with the **same** proof builder as today; the only new idea is that customer context is entered once. Two entry points:

- **Entry A — known up front:** the proof-type wizard's "different materials" fork (today a dead-end split-guard) becomes the **entrance**: "this is a set — build the cards one at a time," landing on a set workspace with **[+ Add a card]**.
- **Entry B — discovered later:** on an existing proof, **"Add another material to this order"** spins up a sibling card in the same bundle, inheriting customer/HS/currency. This is the honest version of the Novion move — a second card *alongside* the first, not a version that replaces it.

Each card keeps its own versions for revisions. Bundle membership **locks once sent** (a later addition starts a fresh link).

---

## 6. After payment

**Money converges up (per payment event):**
- The webhook flips **every card in the bundle** to paid, keyed off the bundle id.
- **One itemised Xero invoice** — a product + tooling line per card, plus **one** combined shipping line (and one tariff line if US-bound). Each card resolves its own Xero item code.
- **Reconciliation stays 1:1** — one payment → one `payment_reference` → one invoice, so the Stripe→Xero bank-feed match is exactly as today. (This is *why* it's one combined invoice, not one-per-card.)
- **One receipt** — one confirmation on the HS thread, one VAT invoice emailed.
- Releasing a ready card early simply produces its **own** payment + invoice (one invoice per payment event).

**Making fans out (per card):**
- Each card's order enters production independently — its own supplier, route, stock order, artwork folder, tracking — exactly like a standalone order.
- **Ships together by default, but never locked in:** one combined dispatch normally, but a delayed card needn't hold up the rest — ready cards can ship and the held one follows; any extra postage on the held card is absorbed.
- The Orders page shows the bundle with each card's fulfilment status under one paid banner.

**Robustness rule:** money fields (invoice id, payment reference, "emailed"/"confirmation sent") live on the **bundle** and are done-once (webhook retries must not double-invoice); making fields (supplier, route, stock order, tracking, fulfilled_at) live on each **card**.

---

## 7. Settled decisions

1. **Payment timing — designer can release a ready card early.** One combined payment by default; the designer may split off a ready card rather than hold it behind a lagging one. → "one invoice per payment event."
2. **Shipping — ship together by default, never locked in.** Billed as one combined parcel; a delayed card can be dispatched separately, absorbing any extra postage. (This is a *capability* requirement — don't hard-couple one bundle to one physical dispatch.)
3. **Scope — one address, one payer, one currency.** Split-delivery/payer jobs route back to separate projects.
4. **Discard — customer self-serves, with a reason.** Reuse the existing decline panel; designer is notified; basket reprices.

---

## 8. Open points (resolve before/with the relevant slice)

- **Charge shipping per card vs combined:** default is **combined billing** (per payment); per-card dispatch is a fulfilment capability, not a re-bill. Confirm before Slice 2.
- **US tariff on a split dispatch:** one combined dispatch = one customs entry = one tariff; only a delay-driven split creates a second to absorb. Confirm against how Plasma files.
- **Naming:** "Bundle" is a placeholder — "set" already means a single-material collection (Set collection). Needs its own durable word before it hits the UI (candidates: "order set", "bundle").
- **Partial-refund runbook:** cancelling one card from a paid bundle = partial Stripe refund + a Xero credit note against that card's line, other card's production continues. Needs a defined process before go-live (not before build starts).

---

## 9. Reuse map — build ON these, don't redesign them

The per-card "how it's made" experience **already exists and ships**. The bundle re-hosts it; almost nothing here is new UI.

| Existing asset | What it already does | Role in a bundle |
|---|---|---|
| `src/pages/OrderPayPage.tsx` → the "Confirm your card" block (~L1680–1773) | Quantity-first, then thickness cards + finish cards, **forced choice, no pre-selection**, live pricing, "Not sure? Ask us" escape hatch | **This *is* the per-card chooser** — run it per card |
| `src/components/FinishChoiceCard.tsx` | Finish photo, hover loupe, full-screen viewer, description, price, `selected`/`onChoose` | Finish selection, untouched (parent seeds `selected=false` for forced choice) |
| `src/lib/metalThicknessNotes.ts` | `ThicknessOption` + `thicknessNoteFor`/`hasThicknessGuide`/`thicknessSetForMaterial`; notes carry `label` (microns), `name` (plain), `badge` ("Most popular"), `description` | Thickness cards, untouched |
| `src/components/PricingDisplay.tsx` / `PricingDisplayField.tsx` | The price grid | Pricing, untouched |
| `src/lib/materialTraits.ts` | `finishIsPreferenceOnly`, etc. | Gating rules, untouched |
| `src/design/` kit | `PanelShell`, `ProofStatusPill`, `Pill`, `ButtonInk/Coral/Ghost`, `CurrencyAmount`, `Eyebrow`, `PlasmaWordmark` | The overview + checkout chrome |

Existing order/payment plumbing to extend (Slice 2), **all single-product today** (one order = one proof = one material variant = current version = one Stripe payment = one Xero invoice):
- Table `proofs.orders` — `proof_id`, `material_id`, `material_variant_id`, `material_option_id`, `thickness_open`/`finish_open`/`quantity_open`, `quantity`, `currency`, `amount_cards/tooling/personalisation/shipping/us_tariff/card_discount`, `ship_dest_country/postcode`, `token`, `status`, `payment_reference`, `xero_invoice_id`, plus fulfilment columns (`production_route`, `stock_order_number`, `dropbox_folder_url`, `supplier_id`, `date_required`, `customer_tracking_*`).
- Edge functions: `create-order`, `create-checkout-session`, `stripe-webhook`, `order-vat-invoice`, `retry-order-invoice`, `send-order-reminders`.
- Shared: `_shared/invoiceBuild.ts` (already multi-**line**, single-**product**), `_shared/orderPricing.ts`, `_shared/ukVatArea.ts`, `_shared/xero.ts`.
- Approval: `proof_name_approvals`, `_finalize_proof_if_complete`, `proof_versions.shape` / `is_current` / `names`.
- Wizard: `src/components/ProofShapeWizard.tsx` (split-guard), `src/pages/NewVersionPage.tsx`.

---

## 10. Build slices (ship in order; each stands alone)

- **Slice 1 — Guardrails** *(frontend only, no schema).* Stop the version-abuse at the moment it happens and surface existing stranded approvals. **Highest value first, lowest risk.** Detailed in §12.
- **Slice 2 — The order-group money engine** *(schema + edge functions + the checkout/grouping surfaces).* Introduce `order_groups`, combined checkout, one-invoice-per-payment, per-card paid-flip and fulfilment, early release — **plus the designer action to group existing orders and the group-aware pay page.** Its headline capability: a designer bundles **any N already-approved separate projects** for one customer into a single payment (no shared authoring required). **The group pay page MUST let the customer choose any open specs (quantity/thickness/finish) per card** — reusing the single-order chooser; a locked-specs-only build is not shippable (§13). Delivers the payment fix (one link, one invoice) without needing Slice 3. Detailed in §13.
- **Slice 3 — Unified customer & designer surfaces.** The single customer overview link (composing the §9 per-card chooser) + designer set-authoring (the two entry points in §5). Turns "combined payment" into the seamless one-link experience.

---

## 11. Repo conventions & guardrails (do not skip)

- **Migrations (Slice 2+):** the live DB is the merged stock-control project `bjvinrzbdrwebylkmbwy`, `proofs` schema. **The CLI push path is dead.** Author migrations as `supabase/migrations/000NNN_*.sql`, **schema-qualified** (`proofs.` prefixes, functions pin `set search_path = proofs, public, extensions, pg_temp`). **Pick the number by `ls supabase/migrations/0003*`, never from CLAUDE.md's summary.** Verify live state read-only first via the Supabase MCP (`execute_sql` on that ref). **Rob applies to prod** (MCP `apply_migration` he approves, or dashboard) — Claude never applies unilaterally. **The `proofs` schema has NO default privileges** — every `CREATE TABLE` must state its full grant matrix (service_role included) or edge functions silently lose access. A drop+recreate of any `public_*` view must re-state its `REVOKE ... FROM anon` and `GRANT ... TO authenticated` and `security_invoker = on`.
- **Edge deploys:** Homebrew `supabase` CLI with `--project-ref bjvinrzbdrwebylkmbwy`.
- **Git:** never `git add -A` (stage explicit paths); never `--no-verify`; never `--amend` a pushed commit without asking. One feature per commit, plain-English message.
- **Verify:** run `pnpm build` (tsc + vite) before claiming done. Relevant tests exist (`pnpm test:order-pricing`, `test:vat-area`, `test:wizard`, etc.).
- **Rob is a non-coder** — explain steps, no jargon, no surprises.

---

## 12. Slice 1 — detailed spec (the first actionable chunk)

**Goal:** make the version-abuse path visibly wrong at the moment it happens and surface existing stranded approvals. **No schema changes** — reads existing tables only. Conservative: **warn, don't block** (avoid false positives on legitimate revisions).

### 12.1 New-version material-swap guard
- **Where:** `src/pages/NewVersionPage.tsx` (and/or `ProofShapeWizard.tsx` if that's the cleaner hook on the new-version path).
- **Trigger (heuristic):** the new version's `material_id` differs from the current version's **and** the recipient roster (`proof_versions.names`) is **disjoint** from the previous version's (no overlapping names).
- **Behaviour:** an interstitial/inline warning, e.g. *"This looks like a different product, not a revision. A new version replaces what the customer sees, and only the current version can be ordered — the previous card would no longer be visible or orderable. If the customer wants both, they should be separate cards."* Offer a one-click route to `/proofs/new` prefilled with the same company/contact/HS context (the wizard already supports `?companyId=`/`?contactId=` prefills). Let the designer proceed if it *is* a genuine revision.

### 12.2 Order-time guard
- **Where:** the create-order path — `OrderBuilderModal` open from `src/pages/ProofDetailPage.tsx`, and/or a check in `create-order`.
- **Trigger:** the proof has `proof_name_approvals` rows with `state='approved'` on **non-current** versions whose `material_id` differs from the current version.
- **Behaviour:** warn the designer that those approved cards will **not** be included in this order and can't be ordered from here (name them). Non-blocking.

### 12.3 Stranded-approval detection (surface existing messes)
- A read-only report or a needs-attention-style flag that finds proofs with `state='approved'` `proof_name_approvals` on non-current versions with a **different** `material_id` than the current version. Start as a query the team can run; a full needs-attention rule is optional and can defer.

### Slice 1 acceptance
- Creating a new version that swaps material for a disjoint roster shows the warning + the "make it separate cards" route; a normal revision (same roster, or same material) shows nothing.
- Opening the order builder on a proof with a stranded differing-material approval shows the warning naming the stranded card.
- A way to list existing stranded-approval proofs exists.
- `pnpm build` is clean. Draft PR opened. No schema/migration changes in this slice.

---

## 13. Slice 2 — scope notes (the primary use case)

**The headline capability is combining *existing, independently-created* projects for one payment** — not only cards authored together (that's Slice 3's nicer front door). Because the money layer (the order group) sits *above* the orders (§2), grouping is an **order-time action** that doesn't care how the proofs were created. This is the common case — separate projects already exist everywhere (the sanctioned "split into separate projects" path creates them), so it's arguably the single highest-value piece of the plan.

**Flow — two separate approved projects → one payment:**
1. Each project is approved on its own `/p/:id`, as today.
2. The designer creates an order for each (existing `create-order`).
3. The designer puts both orders into **one order group** and sends **one** pay link.
4. Customer pays once → one Stripe payment → one itemised Xero invoice covering both (§6).

**Conditions to group:** one payer, one currency, one delivery address (§7), and both approved. Different contacts at the same company are fine (the payer at checkout is who matters). Two currencies or two ship-to addresses can't be combined.

**So Slice 2 is _not_ backend-only** — it includes two small checkout-side surfaces (distinct from Slice 3's proof overview):
- a **designer grouping action** — "add this order to a payment group" / build a group from selected orders and send one link (on the Orders page and/or proof detail), and
- the **pay page in group mode** — loads the group + its member orders and renders one line per card. For any member whose specs are **open**, it shows that card's **guided chooser** (quantity → thickness → finish) inline — reuse the single-order `OrderPayPage` "Confirm your card" flow (`FinishChoiceCard`, thickness cards, forced-choice / no pre-selection) — with the combined total **and combined shipping recomputing live** as the customer picks, and Pay **gated** until every open spec across all cards is chosen. Locked-spec members render as a priced line.

**Definition of done — customer choice inside a bundle is required (decided 8 Jul).** The common case is the *customer* choosing quantity/thickness/finish, not the designer locking them. So Slice 2 must let **open-spec orders join a group** and let the customer resolve those specs on the group pay page (above). A locked-specs-only build **cannot ship**: bundling would rarely apply and would reintroduce the exact "what thickness would you like?" email round-trip the open-spec checkout was built to remove. (The first Slice 2 build — PR #438 — deferred this to Slice 3 and only grouped locked-spec orders; that limit is being lifted into Slice 2. The lift is a **bounded extension**: relax the one eligibility gate in `order-group`, teach `create-checkout-session` group mode to accept per-card customer choices and price them like the single-order open-spec branch already does, and add the choosers to `OrderGroupPayPage` by reusing the single-order flow. The money engine — schema, webhook, invoice builder, reconciliation — is unchanged.)

**Correctness fix required for go-live (from the #438 review):** a member's standalone pay link is currently refused only while its group is `sent`. Block it whenever the group is **not `cancelled`** — server-side in `create-checkout-session` and mirrored on the pay page (`order_group_status` is already returned by `public_get_order`) — so a member left `sent` under a `paid` group can't be charged a second time.

**Still excluded (Slice 3):** only the unified *customer proof overview* (one link to review/approve several cards together as a set) and the designer set-authoring entry points (§5). Those are about *proofing* together; all *payment* (including in-bundle spec choosers) is Slice 2.

**Backend shape (direction — verify live state first, §11):** a `proofs.order_groups` table owning the money fields (currency, ship destination, token, status, `payment_reference`, `xero_invoice_id`, invoice-emailed / confirmation-sent flags, `created_by`) + `orders.order_group_id` (nullable FK; standalone orders have none). `create-checkout-session` group mode sums each member's goods + tooling, computes **one** combined shipping (+ tariff), **one** PaymentIntent. `stripe-webhook` group mode flips **every** member paid, builds **one** multi-line invoice (product+tooling per card + one shipping + one tariff), posts one confirmation, emails one VAT invoice — preserving the 1:1 `payment_reference` ↔ invoice match. Money side is done-once / idempotent per group; per-card dispatch (ship-each-when-made, §6) stays on each order row. Full grants on the new table (the `proofs` schema has no defaults, §11).

---

*Prepared 8 Jul 2026 from the Novion design conversation (Slice 2 scope note added 8 Jul; in-bundle customer spec choice pulled into Slice 2 after the #438 review, 8 Jul). Decisions in §7 are settled; §8 are open. Naming is a placeholder throughout.*
