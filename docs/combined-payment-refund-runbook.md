# Combined payments — refund runbook

**When to use this:** a customer has **paid a combined payment** (one payment covering two or more card orders, reference starting **GRP-**) and one of the cards needs to be cancelled and refunded while the others go ahead. The last section covers refunding the whole group.

**The principle:** the money for a combined payment lives in three places that must stay in step — **Stripe** (the charge), **Xero** (the invoice), and the **proof viewer** (the order statuses). A partial refund touches all three, in this order: work out the amount → refund in Stripe → credit note in Xero → cancel the card in the app. Nothing here is automated on purpose: partial refunds are rare, judgement-heavy, and safer done deliberately.

---

## Step 1 — Work out the refund amount

Open the order being cancelled (Orders page → the member card, or Admin → Order log). Every paid member order carries its own stamped breakdown. The refund for one card is:

> **Cards (incl. finish) + Tooling + Personalisation − that card's Discount**

- These are the `Cards / Tooling / Personalisation / Discount` figures shown on the order (for a bespoke-quote card, it's simply the agreed figure minus any discount).
- **Do NOT refund shipping or the US tariff line** by default. Those are billed once for the whole group and the parcel still ships with the remaining cards. Only refund a share of shipping if you decide as goodwill, or if cancelling this card genuinely changes the consignment (see Judgement calls below).
- GBP figures are VAT-inclusive — refund the figure as shown; the VAT sorts itself out via the credit note in Step 3.

**Worked example.** A paid group `GRP-1234ABCD` covers two cards: 300 × Stainless Steel 500µm Mirror (Cards £905, Tooling £39) and 500 × Full Colour Plastic (Cards £395). Combined shipping £12.90. The customer cancels the plastic card. Refund = **£395.00** — the steel card and the £12.90 shipping stand.

## Step 2 — Partial refund in Stripe

1. In the Stripe Dashboard, search for the group's payment reference (**GRP-…**) — it's on the payment's metadata and description.
2. Open the payment → **Refund** → enter the amount from Step 1 (not the full amount) → confirm.
3. Note the refund ID (re_…) for the record in Step 5.

Stripe returns the money to the original card in 5–10 working days. The customer needs no link or action.

## Step 3 — Credit note in Xero

1. Open the group's invoice (search the **GRP-** reference; the invoice number is also on the group's card on the Orders page).
2. Create a **credit note** for the cancelled card's lines only — same item codes, same amounts as the invoice lines for that card (its product line, its tooling `020` line, its personalisation line, and its discount line if it had one). Copying the invoice line and adjusting is the least error-prone route.
3. Use the **same tax treatment** as the lines you're crediting (a VAT-inclusive line credits VAT-inclusive; a zero-rated line credits at the zero rate) — Xero does this automatically if you copy the lines.
4. **Allocate the credit note to the invoice.** The invoice then shows as partly paid by credit; when the Stripe refund lands in the bank feed, match it against the credit.

## Step 4 — Cancel the card in the proof viewer

On the Orders page, cancel the member order (its danger-zone Cancel action). This takes it out of the To-order production queue so it can't be placed. The group stays **paid** — that's correct; the payment record covers the cards that remain. The other members are untouched and production continues as normal.

## Step 5 — Leave a paper trail

On the cancelled order (or its proof), add an internal note with: why it was cancelled, the refund amount, the Stripe refund ID, and the Xero credit note number. Thirty seconds now saves a very confusing bank-rec conversation later.

---

## Judgement calls

- **Shipping:** if the cancelled card was the only heavy item and the parcel drops a weight band, you *may* refund the difference as goodwill — but the default is no shipping refund; the consignment still ships. Never re-bill the remaining customers more, even if per-card shipping would now be higher (we absorb it).
- **US tariff line:** refund it only if the whole group no longer ships to the US, or the whole group is being refunded. One customs entry still happens for the remaining cards.
- **Production already started:** if the cancelled card is already in production or shipped, this runbook doesn't apply — that's a returns/goodwill conversation, not a cancellation.

## Refunding the whole group

Same steps at 100%: full refund on the Stripe payment → credit note for **every** line (or void the invoice if the bank feed hasn't matched yet and nothing has been emailed — ask your accountant which they prefer) → cancel every member order in the app. If the group's pay link somehow revives, it refuses payment while the group isn't cancelled, so there's no double-charge risk.

## What the system does and doesn't do for you

- The webhook's money flags are **write-once**: a Stripe refund does **not** automatically flip anything in the proof viewer or Xero. All three systems are updated by hand, per this runbook.
- A member's own pay link stays blocked while its group is paid, so a cancelled-and-refunded card can't accidentally be paid again through an old link. If the customer later wants that card after all, create a **fresh order** on the proof — its own link, its own payment, its own invoice.
