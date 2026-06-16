# Ordering — go-live cutover runbook

How to repoint the ordering pipeline from sandbox to production: **Stripe
test → live** and **Xero Demo Company → your real organisation**. Both are
reversible. Nothing here changes code — it's secrets + two switches.

> The dangerous state is a **mismatch** — real Stripe money landing in the
> Demo Xero org, or a live Xero org behind test payments. The **Payments &
> accounting status** panel on Admin → Settings exists to make that
> impossible to miss: it shows a red "Mismatch" banner until both sides agree.
> Check it before and after every step below.

## How each side switches

| | Mechanism | Where |
| --- | --- | --- |
| **Stripe** | Pick which key set the functions use | Admin → Settings → **Stripe payment mode** (test / live). Needs the live keys present in the environment (below). |
| **Xero** | OAuth reconnect to the real org | Admin → Settings → **Connect Xero**, authorise the real organisation (not Demo) |

The app holds **both** Stripe key sets in the environment and `settings.payment_mode`
(migration 000241) selects which is used — so flipping is a toggle, no redeploy.
Xero has a single connection; reconnecting changes which org it points at.

## One-time prep (before you can go live)

### 1. Add the live Stripe secrets

In the Stripe dashboard (Live mode), get the live secret key, then register the
webhook to get its live signing secret:

- **Live secret key** — Developers → API keys (Live) → `sk_live_…`
- **Live webhook** — Developers → Webhooks → add endpoint (Live mode):
  - URL: `https://bjvinrzbdrwebylkmbwy.supabase.co/functions/v1/stripe-webhook`
  - Event: `checkout.session.completed`
  - Copy the signing secret → `whsec_…`

Set these as Supabase **edge-function secrets** on project `bjvinrzbdrwebylkmbwy`
(keep the existing test ones — the app reads both):

```
STRIPE_SECRET_KEY_TEST        = sk_test_…   (your current test key)
STRIPE_SECRET_KEY_LIVE        = sk_live_…
STRIPE_WEBHOOK_SECRET_TEST    = whsec_…     (your current test webhook secret)
STRIPE_WEBHOOK_SECRET_LIVE    = whsec_…     (the live webhook's secret)
```

Notes:
- If `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` (the old single names) are
  still set, they're used as a fallback for whichever mode-specific key is
  missing — so nothing breaks before you split them. Once both `_TEST` and
  `_LIVE` are set you can remove the unsuffixed ones.
- After changing secrets, **redeploy** the two functions so they pick up the
  new env: `supabase functions deploy create-checkout-session --project-ref bjvinrzbdrwebylkmbwy`
  and `supabase functions deploy stripe-webhook --project-ref bjvinrzbdrwebylkmbwy`.
  (Secrets are read at runtime, but a redeploy is the reliable way to be sure.)

### 2. Enable multi-currency in live Xero (only if you sell in USD/EUR)

The Demo Company is GBP-only, which is why a USD test order's invoice was
rejected. Your live org must have USD/EUR added (Xero → Settings → Currencies)
before a foreign-currency invoice will create. GBP works regardless.

### 3. Confirm the product catalogue exists in live Xero

The invoice lines carry item codes (e.g. `0144`, `020`, `052`). Those item
codes must exist in the **live** org. Run **Admin → Xero self-test** after
connecting the live org to confirm every product code resolves (it creates
draft invoices you can delete). Fix any gaps via Admin → Material options /
Xero item codes.

## The cutover (do in this order)

1. **Status panel** (Admin → Settings) — confirm it reads **Sandbox** (test +
   Demo). This is your "before" baseline.
2. **Reconnect Xero to the real org** — Connect Xero → authorise the real
   organisation. Press **Refresh** on the status panel: Xero should now show
   your real org name with **no DEMO badge**. (Stripe still test → panel shows
   a **Mismatch** banner. Expected mid-cutover.)
3. **Switch Stripe to Live** — Stripe payment mode → **Live (real money)**,
   confirm the prompt. Press **Refresh**: the panel should go **green —
   "Live & consistent"**. If it shows "key is test/absent", the live key isn't
   set right (revisit prep step 1).
4. **Smoke test** — create one small real order to yourself, pay it with a real
   card, and confirm:
   - the invoice appears in the **live** Xero org with the right item code, tax,
     and total, and
   - the Stripe → Xero bank feed reconciles it against the payment (existing
     daily sweep — unchanged).
   Refund yourself in Stripe afterwards.
5. **Turn ordering on for customers** — only now flip **Ordering & checkout
   enabled** (if not already on). Enabling it while still in test mode warns
   you, since customers would get a sandbox checkout.

## Rolling back

Fully reversible: set **Stripe payment mode → Test** and **Connect Xero** back
to the Demo Company. The status panel returns to amber "Sandbox". No redeploy.

## Kill switches (stop taking orders fast)

- **Admin → Settings → Ordering & checkout enabled → off** — hides the pay-page
  and the Create-order button immediately (fail-safe; cached ≤60s).
- **Stripe payment mode → Test** — new checkouts use the sandbox even if
  ordering stays on.
