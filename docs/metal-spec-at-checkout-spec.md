# Metal thickness & finish at checkout — spec

**Status:** draft for Rob's review — nothing built yet.
**Date:** 2026-07-03.
**Builds on:** `docs/ordering-checkout-spec.md` (the pay page + order object), migration 000199 (admin-editable metal thickness copy), 000296/000297 (order-link notes on Links-to-send cards).

---

## 1. The problem

Metal is the most popular product, and it is the one product where an approved proof cannot go straight to a pay link. Thickness (300/500/800µm) and — on steel, gold and rose gold — surface finish are genuinely end-of-process choices, and because the customer can't hold samples, the team currently settles them by email after approval: "thanks for approving — before we send your order link, which thickness would you like?".

That inserts a serial email round-trip at the exact moment the customer's momentum peaks. The visible symptom is the Links-to-send queue filling with metal cards annotated "Awaiting confirmation of preferred thickness/finish", some of them days overdue. The invisible symptom is worse: customers who never reply to the spec email are lost silently — the current process has a bail-out rate too, it just doesn't show up as a checkout bounce.

The fix is not to remove the hand-holding. It is to **relocate it**: first to the moment of approval (automatically), then into the pay page itself (productised), so the whole decision happens in one sitting with good guidance instead of over days of email.

## 2. What the system does today (verified against source, 2026-07-03)

- **Approval already triggers an automatic email.** `proof-action` posts the customer's action to the Help Scout thread, then layers a staff confirmation reply resolved from `reply_templates` row `proof_approval_confirmation`, rendered by `renderTemplate` which supports `{? var}…{/?}` conditional blocks (`src/lib/replyTemplates.ts`). The reply is emailed to the customer by Help Scout, then hidden in the designer's view.
- **The code already knows finish is unsettled.** On multi-option versions the approval confirmation deliberately suppresses the finish suffix and file manifest — the comment at `supabase/functions/proof-action/index.ts:255-259` reads "finish is settled over email for metal, so the confirmation must not assert one". Today's process pain is literally encoded in a comment.
- **Orders already support "customer decides later" — for quantity.** `orders.quantity` is nullable; open-quantity orders show a quantity selector on the pay page and `create-checkout-session` validates + prices the choice server-side (returning a `quantity_required` error if missing). The pay page has an inputs-panel + Continue pattern with auto-advance logic gated on `needsQty` / `needsDest` (`src/pages/OrderPayPage.tsx:580-592`).
- **The order object was designed for this.** `orders.material_variant_id` is nullable, and the comment at `supabase/functions/create-order/index.ts:122` says the pay page "resolves the precise variant/price" — the original v1 intention. The pay-page chooser was never built, so in practice the order builder always locks the variant (null today only means custom quote). `orders.material_option_id` (finish) is designer-picked; null means "base / no finish", so null cannot double as "customer chooses".
- **Pricing at pay time is already server-authoritative.** `create-checkout-session` prices from `price_tiers` (with interpolation) plus `material_option_surcharges` for the chosen finish (`index.ts:336-350`). The client's breakdown recomputes the same maths for display only.
- **The pay page already fetches the proof's pricing payload.** It reads `material_variants` and `price_tiers` from the `public_get_customer_proof` payload to populate the open-quantity selector (`OrderPayPage.tsx:483-526`), and per-option artwork images flow through `customer-proof-images`. The data needed by a spec chooser is largely already anon-reachable for the proof in question.
- **The education copy exists and is admin-editable.** `settings.metal_thickness_notes` (000199) holds an intro plus per-thickness label/name/description rows — two sets, standard metals (300/500/800µm, "Slim / Mid-weight / Substantial") and Mini Steel — with defaults in `src/lib/metalThicknessNotes.ts` and presentation in `src/components/MetalThicknessPanel.tsx`. (⚠ CLAUDE.md describes this panel as an SVG bar diagram; the current component is a text list — trust the code.)
- **Chasing is already automated.** `send-order-reminders` nudges unpaid pay links on an admin-editable cadence (000270), and `pay_link_opened_at` (000262) records when the customer last opened the page. The `approved_no_order` needs-attention rule is built but ships disabled.
- **The queue notes are structured.** `order_link_notes` (000296) is the "Awaiting confirmation of preferred thickness" note in the screenshot; create-order deletes it when the link goes out.

Summary: the "decide later" pattern, the server-side pricing, the education copy, the chasing automation and the measurement hook all exist. What's missing is (a) the ask arriving instantly instead of at designer latency, and (b) a guided chooser on the pay page plus the validation that lets thickness/finish stay open on an order.

## 3. Design overview

Two moves, shippable independently:

- **Move 1 (small, days):** the thickness/finish question rides along in the automatic approval confirmation email for metal proofs. Kills the team's latency from the round trip immediately; nothing else changes.
- **Move 2 (the real fix):** "open-spec" orders. The designer sends the pay link straight after approval; the pay page gains a guided *Confirm your card* step (thickness, then finish where offered) before payment unlocks. The email round trip disappears; the existing unpaid-order reminders chase spec-plus-payment as one action.

**Why checkout and not the approval click:** the funnel's fragile point is the decision to approve (the analytics leak is "opened, never decided"), so the approve action must stay light. At the pay page the customer has committed, is in ordering mode, and is looking at prices — the right context for a price-bearing choice. Thickness changes the card price materially; the decision belongs next to payment.

**Interplay:** Move 1's copy initially asks for an email reply (that's how the designer unblocks the order today). Once Move 2 is live, Rob edits the template block (Admin → Templates, no code change) so it *primes* the decision instead of asking for a reply: "you'll choose your thickness and finish on your order page — here's a guide to the options."

## 4. Move 1 — the spec ask joins the approval confirmation

### Behaviour

When a customer approval **finalises** a metal proof (status flips to `approved`), the confirmation email gains a block explaining the thickness options (and listing the finish options where the version offered more than one), asking the customer to reply with their preference.

Gating — all of:

1. The action is an approve and the proof finalised as a result (re-read `proofs.status` after the approval write; the 000126/000212 trigger runs synchronously). This sends the ask **once**, not per recipient slot on multi-name proofs.
2. The version's material code starts `metal_` (same gate as the proof page's thickness panel, via `material_code`).
3. No order row already exists for the proof (cheap guard; skip the ask if a link somehow went out first).

### Mechanics

- `proof-action` builds a new **conditional template variable** `specs_to_confirm`: a plain-text block assembled from `settings.metal_thickness_notes` (resolving standard vs Mini Steel set the same way the proof page does) plus, when the version's `material_options` has 2+ entries, a line listing those finish names. Empty string when the gates don't pass — the `{? specs_to_confirm}…{/?}` block then renders nothing and every non-metal proof's confirmation is byte-identical to today.
- The `proof_approval_confirmation` template body gains the conditional block. Three places stay in lockstep (the house rule): `DEFAULT_BODIES` in `src/lib/replyTemplates.ts`, the shared edge copy in `supabase/functions/_shared/replyTemplates.ts`, and a migration updating the seeded row — using the loose-match pattern from 000150 so a hand-edited live body isn't clobbered (if Rob has customised it, the migration no-ops and he applies the block by hand in Admin → Templates).
- Register `specs_to_confirm` in `TEMPLATE_VARIABLES` (scope: the confirmation family, `conditional: true`) so the admin editor documents it.
- v1 sends the reply exactly as today (no Help Scout status flip) — see open question 1.

### Draft copy (the conditional block, appended to the existing thank-you)

> One thing before we send your order link: metal cards come in three thicknesses, and we'd like you to pick the one that suits you best.
>
> **300µm — Slim.** The same thickness as a standard paper business card, but with the rigidity of a credit card — because it's solid steel throughout.
> **500µm — Mid-weight.** Noticeably more substantial than card stock, with a satisfying presence in the hand. Our most popular choice.
> **800µm — Substantial.** The thickness of a bank card — rigid, reassuringly weighty, and commands attention the moment it's handed over.
>
> {finish line, when offered:} We'd also like to confirm your surface finish: {Natural / Brushed / Mirror}.
>
> Just reply with your preference and we'll send your order link straight over.

(The thickness lines are rendered from the admin-editable settings copy, not hardcoded — the above shows the current defaults. The prices for each thickness are on the proof page the customer just approved from, so the block links back rather than repeating the grid.)

### Rollout & retirement

Deploy `proof-action` first (a template that doesn't reference the new variable is unaffected), then apply the template migration / edit. When Move 2 goes live, edit the block's last line from "reply with your preference" to "you'll pick these on your order page". The block never needs removing — it becomes the customer's advance reading.

## 5. Move 2 — open-spec orders

### 5.1 Data model

> **As built (migration 000298):** thickness openness got its own explicit flag, `thickness_open`, rather than being inferred from a null `material_variant_id` as first drafted. Reason found during the build: create-checkout-session *persists* the customer's choice onto the order at PaymentIntent time (so the webhook/Xero/fulfilment read it), which would destroy a null-column openness marker and freeze the first pick — breaking "Edit order details". A durable flag lets the body choice win on every checkout call while the order is open (the same request-wins pattern the rating destination uses).

Four columns on `proofs.orders` (columns added to an existing table inherit its grants — no grant statements needed; all auto-flow to the pay page because `public_get_order` returns `to_jsonb(o) - 'token'`):

- `material_id uuid references proofs.materials(id)` — stamped by `create-order` on **every** new order (derived server-side from the variant when one is locked, from the builder's material when open). The pay-page chooser and the checkout validation key off it.
- `thickness_open boolean not null default false` / `finish_open boolean not null default false` — the explicit "customer chooses at checkout" flags. Finish needed one anyway (`material_option_id = null` already means "base / no finish"); thickness gets the symmetric treatment per the note above. Both stay true after a choice is persisted — openness is a property of the order, resolvedness is a property of the columns.
- `help_requested_at timestamptz` — stamped by the `order-question` edge fn (§5.5a); drives the Orders-page "Asked for help" chip.

No new tables, so the proofs-schema "explicit grants for new tables" footgun doesn't bite.

### 5.2 Order builder (`OrderBuilderModal`)

- The variant picker gains a first option, **"Customer chooses at checkout"**, which is the *default* for materials with 2+ priced thickness variants in the order currency (in practice: the metal family). Selecting it leaves `material_variant_id` null. The designer can still lock a thickness for e.g. a repeat customer — the whole feature is optional per order.
- The finish picker gains the same **"Customer chooses at checkout"** option (sets `finish_open`), offered only when the proof version's `material_options` has 2+ entries — if the version proofed one finish, that finish is the artwork and stays locked, matching the existing `variant_type` lock rule for artwork-defined dimensions (ink count, paper finish, species).
- Price preview: with thickness open the builder can't show one figure — show the honest range, e.g. "Customer picks at checkout — £245 (300µm) to £395 (800µm) at 100 cards".
- Excluded from open-spec: custom quotes (price is agreed, variant persisted only for production hand-off), prototypes and reprints (variant semantics already defined), and per-direction-pricing Selection versions with no version material (the designer resolves the material first, as with new versions today).

### 5.3 Pay page — the *Confirm your card* step

The chooser lives inside the existing inputs panel (the one open-quantity and shipping-destination orders already get). Input order — **revised during Rob's preview testing (2026-07-03)**: **quantity → thickness → finish** → destination → Continue. Quantity leads because it's the question the customer already knows the answer to, and with it set every thickness card and finish premium shows the true figure for *their* quantity rather than a lowest-tier "from" price — the expensive decisions get exact numbers. (First build had thickness first; the quantity input also had to stop waiting for a thickness pick — its bounds now come from the union of the offerable variants' tiers until one is chosen.) Everything stays live-editable, so changing quantity later re-prices the cards instantly. The auto-advance gate gains `needsSpec` / `needsFinish` alongside `needsQty` / `needsDest` — an open-spec order never skips the panel, and the payment form stays collapsed until every open field is resolved (same enforcement as `quantity_required` today).

Design rules — this is the part Rob flagged as make-or-break:

1. **It's a step, not a form field.** Section heading "Confirm your card", with the approved artwork recap directly above it keeping commitment salient. One decision at a time, generous spacing, mobile-first stacking (cards full-width on small screens).
2. **Educate in place.** Thickness renders as option cards: µm label + weight name + one-line description, all from `settings.metal_thickness_notes` via the existing anon `public_settings()` path — the same copy the proof page shows, so nothing new to maintain. Mini Steel automatically gets its set via `thicknessSetForMaterial()`.
3. **Recommend, don't pre-select.** No default selection — an explicit tap is required (a wrong thickness is a costly reprint and a "I never chose this" dispute; with no physical samples, informed consent matters). Paralysis is handled by a **"Most popular"** badge instead. Implementation: an optional `badge` string per row in the `metal_thickness_notes` JSONB (no schema change; admin-editable like the rest of the copy).
4. **Show the money on the options.** Each thickness card shows its price at the currently selected quantity, recomputed live from the proof payload's `price_tiers` (the same client-side maths the breakdown already uses). Each finish card shows its surcharge delta — "Included" for the base option, "+£39" style otherwise — from the option surcharge data. The itemised breakdown updates as choices change.
5. **Honest finish visuals.** Finish cards use the version's own artwork as swatches — the first image per option tab from `customer-proof-images` (per-option images exist whenever the designer proofed finish tabs). Fallback: text-only cards. No stock imagery pretending to be their card.
6. **An escape hatch that captures instead of loses.** A quiet "Not sure which to pick? Ask us" link under the choosers opens a one-field panel and submits via a small anon, token-scoped edge function (`order-question`, modelled on `proof-feedback`): posts the customer's question as a note on the proof's Help Scout thread and stamps `orders.help_requested_at` (new nullable column, rides along in the 5.1 migration). The Orders page card shows an amber "Customer asked for help" chip off that stamp. Hesitation becomes a tracked conversation, not a closed tab.

### 5.4 Checkout validation (`create-checkout-session`)

Mirrors the open-quantity trust rule exactly:

- Accept `material_variant_id` in the request body **only when** the order's thickness is open; validate it belongs to `orders.material_id`, is active, and has price tiers in the order currency. Reject otherwise. Missing → error `variant_required` ("Please choose a thickness before paying.").
- Accept `material_option_id` **only when** `finish_open`; validate it belongs to the material and (when the proof version is resolvable) is one of the version's offered option codes. Missing → `finish_required`.
- Persist the validated choices onto the order row **before** pricing, then price exactly as today (tiers + interpolation + option surcharge). Everything downstream — Stripe metadata, `stripe-webhook`'s Xero item-code resolution, the fulfilment hand-off — reads the stamped variant/option and is unchanged.
- **Shipping sequencing falls out naturally:** FedEx rating uses `material_variants.weight_grams`, which depends on thickness. Because the spec step sits above destination in one panel and everything submits together on Continue, the session always rates with the chosen variant's weight. No partial-state rating path exists.

### 5.5 Reminders

No code change — `send-order-reminders` already chases unpaid links, and an open-spec order is just an unpaid link. Optional copy tweak to `order_reminder_1` (admin-editable) so the reminder says "choose your thickness and finish, and pay, here: {url}" for accuracy. The reminders are what replace the team's manual "any thoughts on thickness?" follow-ups.

## 6. Non-goals

- **Auto-creating or auto-sending order links at approval.** The designer still builds the order (quantity mode, shipping treatment, Xero contact need judgement). Worth revisiting once open-spec has bedded in; out of scope here.
- **Changing the proofing/approval flow.** No spec questions at the approve click, for the funnel reasons in §3.
- **Other materials' option dimensions.** Species, ink count and paper finish are artwork-defined — the proof shows what was chosen — so they stay locked (existing builder rule). Nothing here precludes extending open-spec later if a genuine case appears.
- **Sample packs.** A commercial decision, not a build. The escape hatch (§5.3.6) is where a sample-pack offer would slot if ever wanted.
- **Custom quotes and the Set-collection kept-together case.** Unchanged; they keep the manual path.

## 7. Rollout

**Move 1:** deploy `proof-action` → apply the template migration (or hand-edit in Admin → Templates) → send a test approval on an internal metal proof and eyeball the email. Order-safe: template-first would also be harmless (unknown variables render empty via `renderTemplate`), but function-first is tidier.

**Move 2:** migration (5.1 columns) → deploy `create-order`, `create-checkout-session`, `order-question` (all tolerate the columns existing before the frontend uses them) → ship the builder + pay-page frontend. Exercise end-to-end with `settings.payment_mode = 'test'` on a quiet moment (the PR #317 go-live playbook pattern): create an open-spec order on an internal proof, choose specs on the pay page, pay with a test card, confirm the Xero invoice line carries the chosen variant's item code. Then re-verify one live payment on the first real order, as with the original checkout go-live.

**Afterwards:** edit the Move 1 template block per §4; enable the `approved_no_order` needs-attention rule (already built, ships disabled) so anything that still stalls pre-link gets flagged; consider retiring the "Awaiting confirmation of preferred thickness" note habit — the queue should mostly clear itself.

Edge deploys per the house rule: MCP `deploy_edge_function` against `bjvinrzbdrwebylkmbwy`, byte-verify, `verify_jwt` per each function's auth model (`order-question` is anon like `proof-feedback`). Migration applied by Rob via dashboard SQL editor / approved MCP `apply_migration`.

## 8. How we'll know it worked

All measurable with existing data:

- **Queue depth:** count of approved-no-order metal proofs (the Links-to-send list) — should trend towards zero for standard metal orders.
- **Cycle time:** median approval→order-created and order-created→paid (order timestamps), before vs after.
- **Stall-at-chooser signal:** orders with `pay_link_opened_at` set but thickness still null after N days — the honest replacement for today's invisible email silence, and the number to watch for the bail-out risk. If the chooser loses more people than the email dance did, this surfaces it within days.
- **Help requests:** `help_requested_at` volume tells us whether the guidance copy is doing its job.
- **Reminder exhaustion:** how many open-spec orders burn all reminders unpaid, vs today's unpaid rate.

## 9. Risks & mitigations

- **Customer bails at the chooser.** Mitigated by the §5.3 design rules, the escape hatch, and reminders continuing to chase; measured explicitly (§8) unlike today's silent attrition. Worst case: designers lock specs again per order (the feature degrades gracefully — open-spec is a builder choice, not a mode).
- **Wrong-choice reprints.** Explicit selection (no pre-select), plain-English weight anchors, honest finish swatches from their own artwork, and the chosen spec named on the pay page summary, Stripe receipt and Xero invoice line.
- **Price manipulation.** Same trust boundary as open quantity: the server only accepts choices for open fields and validates membership + currency pricing before persisting. Client values never price anything.
- **Xero/fulfilment assumes a variant.** Guaranteed stamped before the PaymentIntent exists (§5.4); the webhook path is untouched.
- **Proof edited after the order was created** (reopen, new version, different material). Chooser filters the proof payload's variants by `orders.material_id`; on a mismatch it degrades to the escape-hatch copy ("we'll confirm options with you") rather than offering wrong choices. Same exposure class as open-quantity today, now handled explicitly.
- **Template/body drift** (Move 1). Lockstep rule + loose-match seed migration per 000149/000150; the variable is registered in the admin editor's reference list.

## 10. Open questions for Rob

1. **Move 1 interim only:** should the confirmation-with-ask also flip the Help Scout conversation to Pending/Active so replies are visibly awaited? (Today's confirmation deliberately doesn't change status.)
2. **Badge:** "Most popular" on 500µm for standard metals — correct? And for Mini Steel's 200/300/500 set? Any equivalent badge for a finish?
3. **Finish swatches:** happy using the proof's own per-finish artwork images as the visual? Or would you rather supply studio photos per finish (nicer, but an asset job)?
4. **Scope of the default:** default *both* thickness and finish to "customer chooses" on metal orders from day one, or thickness first and finish in a second beat once we've seen it behave?
5. **Reminder copy:** want the `order_reminder_1` tweak (§5.5), or leave it generic?
