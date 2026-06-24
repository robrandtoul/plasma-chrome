# Ordering go-live playbook

How to switch the ordering / checkout system from **test** to **live** (real
customer charges). Last refreshed 2026-06-24, verified against the live database
(`bjvinrzbdrwebylkmbwy`).

---

## Where things stand right now (verified)

| Thing | Current value | Meaning |
| --- | --- | --- |
| `settings.payment_mode` | **`test`** | Stripe charges fake money. This is the master live switch. |
| `settings.ordering_enabled` | `true` | Ordering UI is on (Create order, pay page all work). |
| `settings.replies_enabled` | `true` | Help Scout sends are on (pay link, paid confirmation, reminders). |
| `settings.auto_order_reminders_enabled` | `false` | Unpaid-order reminders are in dry-run (not actually sent). |
| `approved_no_order` needs-attention rule | `false` (threshold 2 working days) | The "approved but no order link" flag is off. |
| `settings.xero_stripe_account_code` | `null` | No Stripe clearing account — paid invoices aren't auto-marked PAID in Xero. |
| US tariff config | £39 / €39 / $39, Xero item `910` | Set and ready. |
| Orders so far | 16 total, 5 paid (test), **0 placed** | The place-to-production step has not yet been run end-to-end. |

**The whole flow already works in test mode** — embedded Stripe checkout, the
itemised Xero invoice, the VAT-invoice email, the Help Scout confirmation, the
in-house note / supplier email hand-off, and the new cancel + revision flows.
Going live is essentially flipping one setting **once the live credentials are in
place**.

---

## How the switch actually works

`payment_mode` is read by `create-checkout-session` at request time, so flipping
it needs **no redeploy**:

- `test` → uses `STRIPE_SECRET_KEY_TEST` + `STRIPE_PUBLISHABLE_KEY_TEST`
- `live` → uses `STRIPE_SECRET_KEY_LIVE` + `STRIPE_PUBLISHABLE_KEY_LIVE`

The pay page gets its publishable key + PaymentIntent **from the server**, so
there's nothing to rebuild on the frontend either. The Stripe webhook verifies
incoming events against whichever signing secret matches (`_LIVE` or `_TEST`),
so it accepts live events the moment the live signing secret is set.

---

## Preconditions — do these BEFORE flipping (the risky bits)

These are the steps that, if missed, break a real order. None of them are in the
`settings` table — they're credentials/config held elsewhere.

**A. Live Stripe credentials set as Edge Function secrets** (Supabase dashboard →
Edge Functions → Manage secrets, project `bjvinrzbdrwebylkmbwy`):
- `STRIPE_SECRET_KEY_LIVE` = your `sk_live_…` key
- `STRIPE_PUBLISHABLE_KEY_LIVE` = your `pk_live_…` key
- `STRIPE_WEBHOOK_SECRET_LIVE` = the `whsec_…` from the live webhook endpoint (step B)

**B. A live Stripe webhook endpoint** (Stripe dashboard, in **Live mode**):
- Add an endpoint pointing at the `stripe-webhook` function URL
  (`https://bjvinrzbdrwebylkmbwy.supabase.co/functions/v1/stripe-webhook`)
- Subscribe it to **`payment_intent.succeeded`**
- Copy its signing secret into `STRIPE_WEBHOOK_SECRET_LIVE` (step A)
- (The test-mode webhook is separate and stays as-is.)

**C. Xero connected to your REAL org, not the Demo Company.** Xero is currently
connected (there's a live token), but confirm the connected organisation is the
real Plasma org — invoices from real orders land in whatever org is connected. If
it's on the Demo Company, reconnect via the Xero auth flow before the first real
order.

**D. (Recommended, optional) Set a Stripe clearing-account code** in Xero and put
it in `settings.xero_stripe_account_code`. Without it, a paid order's Xero invoice
is raised but stays *unpaid* until your bank feed reconciles, so the customer's
"Download VAT invoice" link shows the soft "available shortly" message rather than
a paid invoice. With it, paid orders are auto-marked PAID and the link works
immediately.

---

## Go-live steps (in order)

**1. Final test-mode dry-run (do the bit that's never been run).**
On an approved proof, in test mode:
- Create an order → pay with a Stripe test card (`4242 4242 4242 4242`, any
  future expiry/CVC) → confirm: order flips to **paid**, the Xero invoice is
  created with the right lines (product code + tooling `020` + shipping `050`
  intl / `052` UK + tariff `910` where US), the VAT invoice emails, and the Help
  Scout confirmation posts.
- **Place it** (Review & place) — in-house *and*, if you can, a supplier order —
  and confirm Stock Control picks it up and the artwork files attach.
- Run a **cancel** on an unpaid order and a **revision** (reopen a paid order)
  once, so you've seen those flows.
> ⚠ 0 orders have been *placed* so far — make sure you exercise the place step at
> least once in test before going live.

**2. Put the live credentials in place** — preconditions A, B, and confirm C.

**3. Flip to live:**
- Admin → Settings → set payment mode to **Live**, or run:
  `update proofs.settings set payment_mode = 'live';`
- No redeploy needed.

**4. First REAL order — prove the whole chain with real money:**
- Place a small real order yourself (your own card, small quantity).
- Confirm: a real charge appears in Stripe **Live**, the order → **paid**, the
  Xero invoice lands in the **real org** with correct line items, the VAT invoice
  emails, and the HS confirmation posts.
- **Before your first real US order specifically:** check the mixed
  VAT-inclusive + zero-rated `910` tariff invoice on the live Xero org — that
  exact line combination has never been exercised live.
- Place it and confirm the Stock Control / supplier hand-off.
- Then **void/refund** that proving order in Stripe + Xero to keep the books
  clean.

**5. After a clean week of real orders — turn on unpaid-order reminders:**
- `update proofs.settings set auto_order_reminders_enabled = true;`
- Sends up to two gentle reminders on the HS thread for unpaid order links; stops
  the moment an order is paid / expires / is cancelled.

**6. (Optional) Enable the "approved, no order link sent" flag:**
- Admin → Follow-ups (Needs-attention) → enable `approved_no_order`. Flags an
  approved proof that's had no order link sent for ≥ 2 working days.

---

## Kill switch / rollback

- **Flip `payment_mode` back to `test`** — instantly stops real charges, no
  redeploy. This is the safe abort if anything looks wrong.
- **`ordering_enabled = false`** — hides ordering entirely if you need to pull it.

---

## The flips, at a glance

| Setting | Now | Target | When |
| --- | --- | --- | --- |
| `payment_mode` | `test` | `live` | At go-live (after preconditions) |
| `auto_order_reminders_enabled` | `false` | `true` | After a clean week live |
| `approved_no_order` rule enabled | `false` | `true` | Optional, any time |
| `xero_stripe_account_code` | `null` | a clearing-account code | Optional, recommended |

---

## Things to watch once live

- **"Sent but not recorded":** if a hand-off posts to Help Scout / the supplier
  but the status flip fails, you get a distinct error telling you to mark the
  order placed manually — do NOT retry (that re-sends). Rare, but know the signal.
- **Supplier email attachments:** the supplier email now attaches the artwork
  files (like the in-house note), with the Dropbox link as a backup. The first
  live supplier send is the real proof that Help Scout emails the attachments out.
- **Cancelling a *paid* order** is deliberately a manual refund (Stripe + Xero) —
  there's no in-app button for it, only the revision/hold path. Reopening a paid
  order holds it for revision; it does **not** auto-refund.
- **VAT invoice link** only goes "ready" once Xero marks the invoice PAID — which
  needs either the clearing account (precondition D) or your bank-feed
  reconciliation. Until then the customer sees the soft "available shortly" copy.
