-- 000238: unpaid-order follow-up reminders — ledger, toggle, templates.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via the dashboard SQL editor / an MCP apply_migration. Do NOT
-- use `supabase db push`.
--
-- AUTHORED, NOT YET APPLIED — for Rob's review before applying.
--
-- The order equivalent of the proof follow-up automation (000214). When a
-- payment link has been sent but not paid, a cron sender (send-order-reminders,
-- a later deploy) nudges the customer on the proof's Help Scout thread, twice
-- within the 14-day window (a gentle reminder, then a soft pre-expiry one).
-- Dry-run until settings.auto_order_reminders_enabled is flipped — same safety
-- pattern as auto_nudges_enabled. Stops the moment the order is paid / expired /
-- cancelled (the sender only ever looks at live 'sent' orders inside the window).
--
-- ⚠ Grants note (proofs schema has NO default privileges — a new table is born
-- with no grants at all, service_role included): every grant below is explicit.

-- ── 1. order_nudges — the reminder ledger ────────────────────────────────────
--
-- One row per reminder (auto or a manual resend). reminder_no is the stage
-- (1 = gentle, 2 = pre-expiry). Auto rows are written claim-first: INSERT
-- state='sending' before the Help Scout POST (the unique index is the
-- idempotency gate), then UPDATE to sent/failed. Dry-run rows carry
-- state='dry_run' with outcome describing what WOULD have happened; they're
-- excluded from the idempotency gate so a dry-run day can't block the first
-- live send. outcome is free text (would_send, sent, skipped_no_conversation,
-- skipped_paid, skipped_capped, skipped_out_of_window, failed: <reason>, …).
create table proofs.order_nudges (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references proofs.orders(id) on delete cascade,
  reminder_no smallint not null check (reminder_no in (1, 2)),
  source text not null check (source in ('auto', 'manual')),
  state text not null check (state in ('sending', 'sent', 'failed', 'skipped', 'dry_run')),
  outcome text,
  helpscout_conversation_id text,
  helpscout_thread_id bigint,
  sent_by uuid references proofs.profiles(id) on delete set null,
  rendered_body text,
  created_at timestamptz not null default now()
);

-- One REAL send of each reminder stage per order — reminders are once-off per
-- stage (not daily), so the gate is keyed on (order, reminder_no) and only
-- sending/sent rows occupy it (dry_run / skipped stay out).
create unique index order_nudges_auto_claim
  on proofs.order_nudges (order_id, reminder_no)
  where source = 'auto' and state in ('sending', 'sent');

create index order_nudges_order_idx on proofs.order_nudges (order_id, created_at desc);

alter table proofs.order_nudges enable row level security;
create policy order_nudges_select on proofs.order_nudges
  for select to authenticated using (true);
revoke all on proofs.order_nudges from anon, public;
grant select on proofs.order_nudges to authenticated;
grant all on proofs.order_nudges to service_role;

-- ── 2. the dry-run / live toggle ─────────────────────────────────────────────
-- Mirrors settings.auto_nudges_enabled. Default false → every run is dry-run.
alter table proofs.settings
  add column if not exists auto_order_reminders_enabled boolean not null default false;

-- ── 3. reminder reply templates ──────────────────────────────────────────────
-- Editable in Admin → Templates (id prefix order_ → "Order messages" group).
-- Bodies mirror DEFAULT_BODIES.order_reminder_* in src/lib/replyTemplates.ts and
-- the edge twin. No sign-off (Help Scout appends the signature). Variables:
-- {first_name}, {company} (conditional), {order_url}, {order_expiry}.
insert into proofs.reply_templates (id, display_name, description, body) values
  (
    'order_reminder_1',
    'Order reminder — gentle',
    'First automated nudge (~day 7) for an order whose payment link was sent but not paid.',
    'Hi {first_name},

Just a gentle reminder that your cards{? company} for {company}{/?} are approved and ready to order whenever you''re set. You can choose your quantity and pay securely here:

{order_url}'
  ),
  (
    'order_reminder_2',
    'Order reminder — before expiry',
    'Second automated nudge (~day 11–12), framed around the link''s expiry date.',
    'Hi {first_name},

A quick reminder that your order link{? company} for {company}{/?} expires on {order_expiry}. If you''d still like to go ahead, you can complete it here:

{order_url}

If the link has lapsed by the time you read this, just reply and we''ll send a fresh one.'
  )
on conflict (id) do nothing;
