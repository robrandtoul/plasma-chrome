-- 000325: per-person "last opened the Orders page" stamp.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via the dashboard SQL editor / an MCP apply_migration. Do NOT
-- use `supabase db push`.
--
-- AUTHORED — apply via MCP apply_migration BEFORE the frontend deploys (the
-- chrome's profile select names this column).
--
-- Repurposes the Orders nav badge: it used to count approved proofs with no
-- order link sent — a worklist where jobs deliberately sit for a long time,
-- so the badge was permanently lit and meant nothing. It now counts PAYMENTS
-- RECEIVED since this person last opened /orders (orders.status = 'paid' AND
-- paid_at > orders_seen_at) — an actual event signal. Same idiom as
-- profiles.team_chat_seen_at (000319) / feedback_seen_at: default now() so
-- nobody is badged with history at rollout, and new profiles are born
-- "seen". Inherits profiles' grants (authenticated UPDATE, 000176) and the
-- owner-update RLS (000165/000171 lock only role / helpscout_user_id /
-- deactivated_at), so the owner stamps this field freely — no grant or
-- policy change needed.

alter table proofs.profiles
  add column if not exists orders_seen_at timestamptz default now();

comment on column proofs.profiles.orders_seen_at is
  'When this user last opened the Orders page. Drives the Orders nav badge (paid orders with paid_at newer than this). Stamped to now() on every /orders visit; backfilled to apply time in 000325.';
