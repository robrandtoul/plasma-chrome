# Unpaid-order reminders — rollout steps

Operational companion to migration `000238` and the `send-order-reminders`
edge function. The order-side equivalent of `followup-automation-rollout.md`,
and it mirrors that one step-for-step.

> **Cadence is now admin-editable (migration `000270`).** The original
> two-stage model (a gentle nudge at day 7 + a pre-expiry nudge) was replaced
> by a single repeating reminder driven by two settings —
> `order_reminders_max` (default 3) and `order_reminder_interval_days`
> (default 3) — both editable under **Admin → Settings → Ordering & checkout**.
> Reminder *k* is sent once *k × interval* days have passed since the link was
> sent, up to the max, and always stops at the link's expiry. The
> `order_reminder_2` template was retired; `order_reminder_1` is the single
> reminder. Anywhere below that says "two reminders / before-expiry", read it
> as this cadence instead.

Everything here is prod-touching. Per the house rule Rob runs each step (SQL
into the **stock-control** project's dashboard SQL editor; shell lines in the
local `proof-viewer` checkout).

The result: every weekday morning the sender runs in **dry-run** (nothing
sends — `auto_order_reminders_enabled` defaults to off), writing `order_nudges`
rows that show what it *would* have sent. Watch for a week, then flip one
toggle on Admin → Settings.

## 1. Apply migration 000238 — DONE

Applied via MCP on 2026-06-16 (`order_reminders` in the stock project's
migration history): `proofs.order_nudges` ledger, the
`settings.auto_order_reminders_enabled` toggle (default false), and the two
`order_reminder_1` / `order_reminder_2` reply templates. Nothing to do here.

## 2. Deploy the edge function

One new function. From Terminal:

```
cd ~/proof-viewer && supabase functions deploy send-order-reminders --project-ref bjvinrzbdrwebylkmbwy
```

No new secrets: it uses the same `HELPSCOUT_*` + `PROOF_VIEWER_BASE_URL` +
`HELPSCOUT_DEFAULT_USER_ID` secrets the other functions already have.

(Note: this build also touched the shared `_shared/replyTemplates.ts` with
purely additive changes — `send-nudges` / `proof-action` don't use the new
exports, so they need no redeploy. Redeploying them is harmless if you prefer
to keep the deployed bundles current.)

## 3. Create the cron job

SQL editor. **No vault secret to create** — the order cron reuses the same
`proofs_send_nudges_key` the proof sender already uses (it's just the
service-role key). Schedule is 09:30 UTC weekdays, 30 min after `send-nudges`
so the two don't hit Help Scout at the same minute:

```sql
select cron.schedule(
  'proofs-send-order-reminders',
  '30 9 * * 1-5',
  $$
  select net.http_post(
    url := 'https://bjvinrzbdrwebylkmbwy.supabase.co/functions/v1/send-order-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'proofs_send_nudges_key')
    ),
    body := '{}'::jsonb
  );
  $$
);
```

## 4. Trigger the first dry run now (optional but recommended)

Rather than waiting for tomorrow:

```sql
select net.http_post(
  url := 'https://bjvinrzbdrwebylkmbwy.supabase.co/functions/v1/send-order-reminders',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'proofs_send_nudges_key')
  ),
  body := '{}'::jsonb
);
```

Then check what it logged (dry-run rows are state `dry_run`, outcome
`would_send`):

```sql
select o.id, n.reminder_no, n.state, n.outcome, left(n.rendered_body, 80) as preview, n.created_at
from proofs.order_nudges n
join proofs.orders o on o.id = n.order_id
order by n.created_at desc
limit 20;
```

Note: the test orders currently on the system were all sent on 2026-06-15 with
**no expiry**, so the first dry run will show **zero** would-send rows — a
reminder-1 only becomes due 7 days after the link was sent (≈ 2026-06-22), and
reminder-2 needs an expiry date to anchor to. That's correct, not a bug. New
orders created from now on carry the 14-day expiry, so reminder-2 will apply to
them. Rows appear as orders age.

## 5. The week of watching

- Re-run the query in step 4 each morning; read the `rendered_body` previews —
  wording problems are template edits in **Admin → Templates → Order messages**.
- `recipient_mismatch` rows are real findings (the Help Scout conversation's
  customer differs from the proof's contact). `skipped_followup_tag` means a
  human is on the thread (a "follow up" tag) — working as intended.
- The Orders page shows real sent reminders per Awaiting-payment card; during
  the dry week that stays empty (nothing is actually sent), which is correct.

## 6. Go live (after the week, deliberately)

**Admin → Settings → Ordering & checkout → "Send unpaid-order reminders
automatically"** → on. Kill switches: the same toggle (off = back to dry-run)
and the existing Customer-replies pause (`replies_enabled`, the master gate)
both stop live sends. The sender also only runs live inside the London send
window, so an out-of-hours manual trigger stays dry.
