-- 000270: make the unpaid-order reminder cadence admin-editable.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via the dashboard SQL editor / an MCP apply_migration. Do NOT
-- use `supabase db push`.
--
-- Replaces the hard-coded two-reminder model from 000238 (a "gentle" nudge at
-- day 7 + a "before expiry" nudge 3 days before the link lapses) with a single
-- repeating reminder the admin tunes from Admin → Settings:
--   • order_reminders_max         — how many reminders an order may receive
--   • order_reminder_interval_days — days between them, anchored to "link sent"
-- The sender (send-order-reminders) reads both, sends reminder k once k ×
-- interval days have passed since the link was sent, one per run, and always
-- stops at the link's expiry. Defaults (3 reminders, every 3 days) match the
-- model Rob approved; both are inert until auto_order_reminders_enabled flips.

-- ── 1. the two cadence settings ──────────────────────────────────────────────
-- On the existing singleton settings row, so no new grants (settings already
-- carries the authenticated CRUD + service_role grants). Bounds mirror the
-- frontend inputs; max capped at 5 (more would be spam inside a 14-day window),
-- interval 1–30 (longer suits the occasional no-expiry order).
alter table proofs.settings
  add column if not exists order_reminders_max smallint not null default 3
    check (order_reminders_max between 1 and 5);
alter table proofs.settings
  add column if not exists order_reminder_interval_days smallint not null default 3
    check (order_reminder_interval_days between 1 and 30);

-- ── 2. lift the reminder-stage cap ───────────────────────────────────────────
-- 000238 pinned reminder_no to exactly (1, 2). The drip model emits 1..N, so
-- the ledger must accept any positive stage. The (order_id, reminder_no) unique
-- claim index is unaffected — it keys on the pair, not the value range.
alter table proofs.order_nudges
  drop constraint order_nudges_reminder_no_check;
alter table proofs.order_nudges
  add constraint order_nudges_reminder_no_check check (reminder_no >= 1);

-- ── 3. collapse the two reminder templates into one ──────────────────────────
-- The "before expiry" variant goes away with the two-stage model. The single
-- surviving template optionally mentions the expiry date via a {? order_expiry}
-- conditional block, so it stays useful for orders that have an expiry and
-- renders cleanly for those that don't. Body mirrors DEFAULT_BODIES.order_
-- reminder_1 in src/lib/replyTemplates.ts and the _shared edge twin.
update proofs.reply_templates
set display_name = 'Order reminder',
    description  = 'Automated reminder for an order whose payment link was sent but not paid. Sent every few days (admin-set cadence) up to the configured maximum, stopping at the link''s expiry.',
    body = 'Hi {first_name},

Just a reminder that your cards{? company} for {company}{/?} are approved and ready to order whenever you''re set. You can choose your quantity and pay securely here:

{order_url}{? order_expiry}

This order link expires on {order_expiry}.{/?}'
where id = 'order_reminder_1';

delete from proofs.reply_templates where id = 'order_reminder_2';
