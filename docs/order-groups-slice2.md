# Order groups (Bundle orders, Slice 2) — design note + rollout

**Status:** built · **Migration:** `000309_order_groups.sql` — **applied to live 2026-07-08** via MCP `apply_migration` (Rob approved; verified: table + grants + RLS + the three RPCs all correct, functional smoke on live data passed, security advisors show only the same WARN-by-design findings the single-order siblings carry) · **Spec:** `docs/bundle-orders-spec.md` §2/§6/§13.

## What this gives you, in one paragraph

When a customer is buying two or more cards that live as **separate projects** (the sanctioned "split into separate projects" path — e.g. one steel card and one letterpress card), you can now put their orders into **one payment group** and send **one pay link**. The customer pays once; every card in the group flips to paid; Xero gets **one itemised invoice** (a product + tooling line per card, one combined shipping line, one US-tariff line if it's going to the US); one confirmation goes on the Help Scout thread and one VAT invoice is emailed. Each card still goes into production and ships **on its own** — grouping changes the money, never the making.

## How it fits the existing system

- A new table `proofs.order_groups` holds only the **money** fields: currency, the one delivery destination, the combined-shipping billing choice, the pay-link token, the payment reference, the Xero invoice id, and the "already done" flags (invoice created / emailed / confirmation sent) that make webhook retries safe.
- Each order gets one new nullable column, `order_group_id`. Standalone orders have it empty and behave exactly as today — nothing about the existing single-order flow changes.
- The group's payment reference starts **`GRP-`** (single orders use `ORD-`), so a combined payment is instantly recognisable in Xero. It's stamped on the Stripe payment and the invoice, so the bank-feed match stays exactly 1:1.

## The rules for grouping (checked by the server)

1. Every order must be **awaiting payment** (status `sent`), an **online** order, and not already in a group.
2. All orders must share **one currency** (spec §7).
3. Every order must be **priceable**: either its quantity is set, or the quantity is left open for the customer, or it's a custom quote with an agreed total. Orders with **open choices** (customer picks quantity / thickness / finish at checkout, exactly like a single-order link) are welcome — the group page runs the same guided choosers per card. The only refusal is an order with no quantity, no open-quantity flag and no custom-quote total (nothing to price against).
4. **One payer, one delivery address** is your call to confirm in the modal — the machine can't know who'll pay. Different contacts at the same company are fine.
5. Each order's proof must still be approved.

## What the customer sees

One link → `/order/group/…` — a page listing each card (material, quantity, its price), one combined shipping line, the US-tariff line where relevant, **one total, one payment**. Cards the designer left open get a **"Confirm your cards"** section — quantity first, then the thickness cards, then the finish cards, exactly the single-order chooser flow, one section per open card, nothing pre-selected. Prices update live as they pick, the combined total recomputes, and the Pay button stays off until every choice on every card is made. Their picks are validated and priced server-side at checkout (the same maths as a single order) and saved onto each card's order. Each open card also shows **the customer's own artwork**, cross-fading to the chosen finish as they pick — the same preview behaviour as a single-order link, per card. They enter the delivery country/postcode once. After payment it shows the paid confirmation and the VAT-invoice download, same as today. (Artwork thumbnails for locked cards and on the paid screen are a later slice.)

## Release a ready card early (settled decision §7.1)

If one card needs to move before the others are ready to pay, **Release** it from the group on the Orders page: it becomes a normal standalone order again with its own live pay link → its own payment → its own invoice ("one invoice per payment event"). The group re-prices automatically because every checkout call recomputes server-side.

## Guard rails built in

- A member order's own pay link **refuses payment** while its group is active, so the same card can't be paid twice.
- The unpaid-order reminder sender **skips grouped orders** (a member link in a reminder would break the group). Group-level reminders are deferred — noted below.
- Cancelling a member (order-lifecycle) releases it from the group first; an emptied group cancels itself.
- The webhook only ever creates **one** invoice per group (gated on `xero_invoice_id`), emails it once, posts one confirmation — a Stripe retry finds the flags set and does nothing.

## Open points (flagged, not assumed)

1. **Combined shipping billing** — built as the default per spec §8 (one combined consignment billed once; per-card dispatch stays a fulfilment decision that doesn't re-bill). Confirm this is right before go-live.
2. **US tariff per parcel** — one group = one customs entry = one $39/£39/€39 line. If a delay-driven split dispatch creates a second customs entry, that extra is absorbed (spec §8). Confirm against how Plasma files.
3. **Customer-facing name** — everything customer-visible says neutral things like "your order" / "N card orders in this payment"; the durable word ("bundle", "order set", …) is a later copy decision.
4. **Partial refunds** — cancelling one card from a *paid* group = partial Stripe refund + Xero credit note against that card's lines; needs a defined runbook before go-live (not before build).
5. **Group payment reminders** — grouped orders are excluded from auto-reminders for now; a group-level reminder needs its own pass.

## Rollout (in order — the order matters)

1. ~~**Review + apply migration `000309`**~~ — **done 2026-07-08** (MCP `apply_migration` name `order_groups_combined_payments`, Rob approved).
2. **Deploy edge functions** (Homebrew CLI, `--project-ref bjvinrzbdrwebylkmbwy`): `order-group` (new), `create-checkout-session`, `stripe-webhook`, `order-vat-invoice`, `retry-order-invoice`, `send-order-reminders`, `order-lifecycle`.
3. Frontend ships with the normal Netlify deploy (merge to `main`) — **only after step 1**: the Orders page now selects `orders.order_group_id`, so deploying the frontend before the migration would break the Orders page with a missing-column error. (The migration going first is harmless the other way round — the new column just sits unused.)
4. Smoke-test in **test payment mode**: group two small orders, pay with a test card, check both flip paid + one invoice lands in Xero with per-card lines. Include one order with **open choices** (customer-picks thickness/finish/quantity): make the picks on the group page, pay, and check the picks were saved onto the order and the invoice lines carry the chosen spec + quantity.
