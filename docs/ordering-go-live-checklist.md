# Going live with online ordering — checklist

Right now the shop only takes **practice payments** — no real money changes hands.
This is how to switch it on for real, in order. Tick each box as you go.

Date started: ______________     Done by: ______________

## 1. Get these ready first (the important setup)

- [ ] Your **real Stripe keys** are loaded into the system (the "live" ones, not the practice "test" ones). *Not sure? Ask me — it's a quick check.*
- [ ] Stripe is set up to **tell the system when a real payment goes through** (the "live webhook"). *Also worth me confirming for you.*
- [ ] **Xero is connected to your real Plasma company** — not the "Demo Company". Real invoices must land in your real books.
- [ ] *(Optional, recommended)* Xero is set up so a paid order **shows as PAID automatically**. Without this, the invoice sits as unpaid until your bank feed catches up, and the customer's "download invoice" link says "available shortly" for a while.

## 2. Do a full practice run (while still in practice mode)

- [ ] Create an order on an approved proof and pay it with a **test card**: `4242 4242 4242 4242`, any future expiry date, any 3-digit security code.
- [ ] Check it all happened: the order shows **Paid**, an **invoice appears in Xero** with the right lines, the customer gets the **invoice email**, and a **confirmation note** appears in Help Scout.
- [ ] **"Place" that order to production** — once as an in-house order, and once as a supplier order if you can — and check Stock Control picks it up and the **artwork files are attached**. *This part has never been run for real, so don't skip it.*
- [ ] Try **cancelling** an unpaid order, and try **reopening a paid order for changes** (a "revision"), so you've seen both once.

## 3. Flip the switch

- [ ] In the app, go to **Admin → Settings** and switch **Payment mode** to **Live**. That's the actual switch — from this moment, real cards get charged.

## 4. Prove it with one real order

- [ ] Place **one small real order yourself** (your own card, small quantity).
- [ ] Check the whole chain with real money: a **real charge** in Stripe, the order shows **Paid**, the **invoice is in your real Xero company** with the right lines, the **invoice email** arrives, and the **Help Scout confirmation** posts.
- [ ] **If you sell to the US:** before your first real US order, check that first US invoice looks right — the VAT and the **£39 customs/tariff line**. This exact combination hasn't been tested for real yet.
- [ ] **"Place" your test order**, check the hand-off, then **refund/cancel it** in Stripe and Xero so your books stay clean.

## 5. A week later

- [ ] Once a few real orders have gone through smoothly, turn on **automatic reminders** for customers who haven't paid their order link yet (Admin → Settings).
- [ ] *(Optional)* Turn on the **"approved but no order sent"** flag (Admin → Follow-ups), so approved jobs that haven't been turned into an order get flagged after a couple of days.

## If anything looks wrong

- [ ] Switch **Payment mode back to Test** in Admin → Settings. That instantly stops real charges — nothing else needed. **This is your safety switch.**

## Good to know

- Cancelling a **paid** order means **you refund it yourself** in Stripe and Xero — there's no automatic button. (Reopening a paid order for changes is fine and built in; it just doesn't refund anything.)
- If you ever see **"sent but not recorded"** when placing an order, **don't press place again** — it already went through. Mark it placed by hand instead.
