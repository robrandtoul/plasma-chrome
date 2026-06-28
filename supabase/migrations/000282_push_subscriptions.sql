-- 000282: push_subscriptions — one row per device a staffer has enabled
-- web-push notifications on.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via the dashboard SQL editor / an MCP apply_migration. Do NOT
-- use `supabase db push`.
--
-- AUTHORED, NOT YET APPLIED — for Rob's review before applying.
--
-- Phase 1 of the push-notification system (docs/push-notifications-spec.md).
-- This is the only table needed to prove the end-to-end pipeline: the browser
-- subscribes (PushManager.subscribe) and writes its endpoint + keys here; the
-- send-push edge function reads across all rows via the service role to deliver
-- a notification to every enabled device.
--
-- The row is written DIRECTLY by the authenticated frontend under RLS (same as
-- proof_pins / proof_attention_snoozes), not via an edge function — the user
-- only ever touches their own rows, gated by user_id = auth.uid().
--
-- ⚠ Grants note (the proofs schema has NO default privileges — a new table is
-- born with no grants at all, service_role included): every grant below is
-- explicit.

begin;

create table proofs.push_subscriptions (
  id                uuid        primary key default gen_random_uuid(),
  -- Whose device. FK to profiles (= auth.users.id) so RLS can gate on
  -- auth.uid(); ON DELETE CASCADE so removing an account clears its devices.
  user_id           uuid        not null references proofs.profiles(id) on delete cascade,
  -- The push service URL Apple/Mozilla/Google hands back. UNIQUE so a
  -- re-subscribe (same browser, same key) upserts cleanly rather than
  -- duplicating, and so a rotated subscription replaces the old row.
  endpoint          text        not null unique,
  -- The subscription's public key (p256dh) + auth secret — the two pieces
  -- the server needs to encrypt the payload for this device.
  p256dh            text        not null,
  auth              text        not null,
  -- So the settings screen can show "iPhone" vs "Mac" when listing the
  -- user's own devices for removal. Best-effort, may be null.
  user_agent        text,
  created_at        timestamptz not null default now(),
  -- Bumped on every re-subscribe so stale rows can be pruned later.
  last_seen_at      timestamptz not null default now(),
  -- Last HTTP status the send-push function got for this endpoint. 404/410
  -- mean the subscription is dead and the row is deleted at send time; this
  -- column is just diagnostic for anything that fails transiently.
  last_failure_code int
);

create index push_subscriptions_user_idx on proofs.push_subscriptions (user_id);

alter table proofs.push_subscriptions enable row level security;

-- A user reads, writes, and removes ONLY their own device rows. The send-push
-- edge function uses the service-role client (bypasses RLS) to read across all
-- users when fanning a notification out.
create policy push_subscriptions_select on proofs.push_subscriptions
  for select to authenticated using (user_id = auth.uid());

create policy push_subscriptions_insert on proofs.push_subscriptions
  for insert to authenticated with check (user_id = auth.uid());

create policy push_subscriptions_update on proofs.push_subscriptions
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy push_subscriptions_delete on proofs.push_subscriptions
  for delete to authenticated using (user_id = auth.uid());

revoke all on proofs.push_subscriptions from anon, public;
grant select, insert, update, delete on proofs.push_subscriptions to authenticated;
grant all on proofs.push_subscriptions to service_role;

comment on table proofs.push_subscriptions is
  'Web-push device subscriptions, one row per browser/device a staffer has '
  'enabled notifications on. Written directly by the authenticated frontend '
  'under RLS (own rows only); read across all users by the send-push edge '
  'function via the service role. endpoint is UNIQUE so re-subscribe upserts.';

commit;
