-- 000283: notification preferences, per-project watches, the send ledger, and
-- the settings that govern who hears what.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via the dashboard SQL editor / an MCP apply_migration. Do NOT
-- use `supabase db push`.
--
-- AUTHORED, NOT YET APPLIED — for Rob's review before applying.
--
-- Phase 2 of the push-notification system (docs/push-notifications-spec.md).
-- Three tables + five settings columns:
--   1. notification_preferences — account-level per-event toggles + quiet hours
--   2. proof_watches            — per-project "watch this" overrides (tri-state)
--   3. notification_outbox      — the send ledger (dedup + observability)
--   4. settings.*               — master switch, fulfilment list, role defaults,
--                                 deploy cutoff, editable copy
--
-- Recipient model agreed with Rob (2026-06-28):
--   * Rob (admin)  — the firehose: notified about EVERY project's events.
--                    Seeded via his personal prefs all "on" (NOT a role default,
--                    because Chris is also an admin and should NOT inherit the
--                    firehose).
--   * Role default — both admin and designer default to "own_projects" for
--                    proof events; everyone other than Rob starts conservative
--                    and opts into more.
--   * Fulfilment   — order / pay-link / to-order events go to the people in
--                    settings.fulfilment_user_ids (= Rob + Chris), independent of
--                    role. Chris (admin) gets to-order pings this way without the
--                    firehose.
--
-- Per-event value grammar (everywhere): 'on' | 'off' | 'own_projects'.
--
-- ⚠ Grants note (the proofs schema has NO default privileges): every grant
-- below is explicit. notification_outbox is SELECT-only for authenticated
-- (writes flow via the service-role send-push function).

begin;

-- ── 1. notification_preferences ──────────────────────────────────────────────
-- One row per user. prefs is a JSON map of event_code -> setting, so adding a
-- new notifiable event later needs no migration. A user with NO row falls back
-- to the role default — every read path must tolerate the missing row.

create table proofs.notification_preferences (
  user_id          uuid        primary key references proofs.profiles(id) on delete cascade,
  -- { "<event_code>": "on" | "off" | "own_projects" }. Empty = use role default.
  prefs            jsonb       not null default '{}'::jsonb,
  -- { "enabled": bool, "start": "20:00", "end": "08:00", "tz": "Europe/London" }.
  -- Null = no quiet hours. Enforced in the send-push function, not the DB.
  quiet_hours      jsonb,
  -- Drives the unread/badge model: unread = count of this user's sent outbox
  -- rows created after this timestamp. Stamped when they open the app.
  badge_cleared_at timestamptz,
  updated_at       timestamptz not null default now()
);

alter table proofs.notification_preferences enable row level security;

create policy notification_preferences_select on proofs.notification_preferences
  for select to authenticated using (user_id = auth.uid());
create policy notification_preferences_insert on proofs.notification_preferences
  for insert to authenticated with check (user_id = auth.uid());
create policy notification_preferences_update on proofs.notification_preferences
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy notification_preferences_delete on proofs.notification_preferences
  for delete to authenticated using (user_id = auth.uid());

revoke all on proofs.notification_preferences from anon, public;
grant select, insert, update, delete on proofs.notification_preferences to authenticated;
grant all on proofs.notification_preferences to service_role;

comment on table proofs.notification_preferences is
  'Account-level push preferences: per-event on/off/own_projects toggles + quiet '
  'hours. One row per user, written under RLS by the owner. A missing row means '
  '"use the role default" — every reader must tolerate that.';

-- ── 2. proof_watches ─────────────────────────────────────────────────────────
-- Per-(proof, user) overrides. Mirrors proof_pins' shape + RLS, but tri-state
-- per event so a watch can both ADD ("hear about this project even though my
-- default is off") and SCOPE DOWN ("only this project; mute it elsewhere").
-- An empty events {} = "watch everything on this project".

create table proofs.proof_watches (
  id          uuid        primary key default gen_random_uuid(),
  proof_id    uuid        not null references proofs.proofs(id) on delete cascade,
  user_id     uuid        not null references proofs.profiles(id) on delete cascade,
  -- { "<event_code>": "on" | "off" }; empty {} = watch all notifiable events.
  events      jsonb       not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  -- Audit attribution; pinned to auth.uid() by the insert check below.
  created_by  uuid        references proofs.profiles(id) on delete set null
);

create unique index proof_watches_proof_user_idx
  on proofs.proof_watches (proof_id, user_id);

alter table proofs.proof_watches enable row level security;

-- Everyone signed in can SEE who watches a proof (so the proof page can show
-- "also watched by …" — same open-read precedent as proof_pins).
create policy proof_watches_select on proofs.proof_watches
  for select to authenticated using (true);

-- A user can only create / change / remove their OWN watch, and can't spoof
-- another's attribution (created_by pinned to auth.uid(), per the 000159
-- proof_pins hardening).
create policy proof_watches_insert on proofs.proof_watches
  for insert to authenticated
  with check (user_id = auth.uid() and created_by = auth.uid());
create policy proof_watches_update on proofs.proof_watches
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and created_by = auth.uid());
create policy proof_watches_delete on proofs.proof_watches
  for delete to authenticated using (user_id = auth.uid());

revoke all on proofs.proof_watches from anon, public;
grant select, insert, update, delete on proofs.proof_watches to authenticated;
grant all on proofs.proof_watches to service_role;

comment on table proofs.proof_watches is
  'Per-project push overrides. events is { event_code: on|off }; empty {} = '
  'watch everything on this proof. A watch wins over both the personal pref and '
  'the role default for that proof. Read-all (like proof_pins); write-own only.';

-- ── 3. notification_outbox ───────────────────────────────────────────────────
-- The send ledger. Written ONLY by the service-role send-push function. Powers
-- (a) dedup — the unique index makes a webhook retry / double-fire a no-op;
-- (b) observability — "did Rob's push send, and if not why?";
-- (c) the unread/badge count (sent rows since badge_cleared_at).

create table proofs.notification_outbox (
  id                 uuid        primary key default gen_random_uuid(),
  event_code         text        not null,
  -- Namespaces source_event_id so the three id spaces can't collide.
  source_kind        text        not null
                       check (source_kind in ('proof_event','order','proof_finalize','condition')),
  -- The originating id, with a cycle discriminator for condition/finalize
  -- events (e.g. '<proof_id>:<approved_at epoch>') so a legitimate re-approval
  -- after a reopen gets its own key and notifies, while a re-evaluation of the
  -- same approval stays deduped.
  source_event_id    text        not null,
  -- SET NULL (not CASCADE): deleting a proof/order must not erase the ledger
  -- the outbox exists to preserve.
  proof_id           uuid        references proofs.proofs(id) on delete set null,
  order_id           uuid        references proofs.orders(id) on delete set null,
  recipient_user_id  uuid        not null references proofs.profiles(id) on delete cascade,
  title              text,
  body               text,
  url                text,
  status             text        not null
                       check (status in ('queued','sent','failed','skipped_pref',
                                         'skipped_quiet','skipped_actor','skipped_killswitch',
                                         'skipped_testmode','skipped_backfill','no_subscription')),
  created_at         timestamptz not null default now()
);

-- Dedup: one (event, source, recipient) outcome row. The cycle discriminator in
-- source_event_id keeps honest re-firings distinct.
create unique index notification_outbox_dedup_idx
  on proofs.notification_outbox (event_code, source_kind, source_event_id, recipient_user_id);
create index notification_outbox_recipient_idx
  on proofs.notification_outbox (recipient_user_id, created_at desc);

alter table proofs.notification_outbox enable row level security;

-- A user sees their own send rows; an admin sees everything (the observability
-- surface). Nobody writes from the client — the send-push function does, via
-- the service role.
create policy notification_outbox_select on proofs.notification_outbox
  for select to authenticated
  using (recipient_user_id = auth.uid() or proofs.is_admin());

revoke all on proofs.notification_outbox from anon, public;
grant select on proofs.notification_outbox to authenticated;
grant all on proofs.notification_outbox to service_role;

comment on table proofs.notification_outbox is
  'Push send ledger (dedup + observability + unread count). Service-role writes '
  'only; authenticated SELECT own rows, admin SELECT all. The unique index on '
  '(event_code, source_kind, source_event_id, recipient_user_id) makes retries '
  'idempotent.';

-- ── 4. settings columns ──────────────────────────────────────────────────────

alter table proofs.settings
  -- MASTER KILL SWITCH. send-push returns early (skipped_killswitch) while
  -- false. Ships false; flip true after the Phase-1 smoke test. Mirrors
  -- auto_nudges_enabled / auto_order_reminders_enabled.
  add column if not exists push_enabled boolean not null default false,
  -- Deploy cutoff for the (future) condition sweep so its first run doesn't
  -- backfill-notify every already-approved proof in history.
  add column if not exists notification_feature_since timestamptz,
  -- Who gets order / pay-link / to-order pings, independent of role. NOT a role
  -- (Chris is an admin; this is how he gets to-order pings without the firehose).
  add column if not exists fulfilment_user_ids uuid[] not null default '{}'::uuid[],
  -- Baseline per role for PROOF events, value grammar on/off/own_projects.
  -- (Order events resolve from fulfilment_user_ids, not from here.)
  add column if not exists notification_role_defaults jsonb,
  -- Admin-editable per-event lock-screen copy (title/body templates).
  add column if not exists notification_copy jsonb;

-- Role defaults: both roles default to "own projects" for proof events. Rob's
-- firehose is seeded as personal prefs below, NOT here, so Chris (also admin)
-- stays conservative.
update proofs.settings set notification_role_defaults = '{
  "admin": {
    "customer_requests_changes": "own_projects",
    "proof_approve_per_recipient": "own_projects",
    "project_reaches_approved_status": "own_projects",
    "customer_replies_by_email": "own_projects"
  },
  "designer": {
    "customer_requests_changes": "own_projects",
    "proof_approve_per_recipient": "own_projects",
    "project_reaches_approved_status": "own_projects",
    "customer_replies_by_email": "own_projects"
  }
}'::jsonb
where id = 1 and notification_role_defaults is null;

-- Default lock-screen copy. send-push interpolates {company} {actor} {comment}
-- {recipient} {version} and clips to the iOS limits (title 30 / body 120).
update proofs.settings set notification_copy = '{
  "customer_requests_changes":      { "title": "Changes requested",  "body": "{company} — {actor}: {comment}" },
  "proof_approve_per_recipient":    { "title": "Proof approved",     "body": "{company} — {actor} approved" },
  "project_reaches_approved_status":{ "title": "Fully approved",     "body": "{company} — every sign-off is in" },
  "customer_replies_by_email":      { "title": "Customer replied",   "body": "{company} replied by email" },
  "order_paid":                     { "title": "Order paid",         "body": "{company} paid their order" },
  "pay_link_opened":                { "title": "Pay link opened",    "body": "{company} opened the pay link" },
  "project_reaches_to_order_status":{ "title": "Ready to order",     "body": "{company} is ready to order" }
}'::jsonb
where id = 1 and notification_copy is null;

-- Fulfilment list = Rob + Chris (resolved by email so this is replay-safe and
-- not pinned to UUIDs that differ between environments).
update proofs.settings set fulfilment_user_ids = (
  select coalesce(array_agg(p.id), '{}'::uuid[])
  from proofs.profiles p
  join auth.users u on u.id = p.id
  where u.email in ('rob@plasmadesign.co.uk', 'chris@plasmadesign.co.uk')
)
where id = 1;

-- Deploy cutoff = now, so the future condition sweep treats everything already
-- in the system as "before the feature existed".
update proofs.settings set notification_feature_since = now()
where id = 1 and notification_feature_since is null;

-- Rob's firehose: seed every event "on" as his PERSONAL preference. on conflict
-- do nothing so re-applying never clobbers a later customisation he makes.
insert into proofs.notification_preferences (user_id, prefs)
select p.id, '{
  "customer_requests_changes": "on",
  "proof_approve_per_recipient": "on",
  "project_reaches_approved_status": "on",
  "customer_replies_by_email": "on",
  "order_paid": "on",
  "pay_link_opened": "on",
  "project_reaches_to_order_status": "on"
}'::jsonb
from proofs.profiles p
join auth.users u on u.id = p.id
where u.email = 'rob@plasmadesign.co.uk'
on conflict (user_id) do nothing;

commit;
