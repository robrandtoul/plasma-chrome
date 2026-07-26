-- 000353: the arming switch for the AI draft edit-miner.
--
-- WHY THIS EXISTS. The miner (supabase/functions/ai-draft-miner) reads the
-- draft ledger, asks a model what the team keeps changing, and files the
-- findings as PENDING proposals for a human to approve. It has two locks before
-- it is allowed to write anything:
--
--   1. this flag must be true, and
--   2. the request must explicitly say "dry_run": false.
--
-- The function was written against a column that did not exist. Without this
-- migration the settings read fails with 42703 (undefined column) on every run,
-- which the handler treats as "not enabled" — so it can never write, and Rob has
-- no switch to turn it on. That is a safe failure, but a useless one: this
-- migration is what makes the switch real.
--
-- WHY A PLAIN BOOLEAN, DEFAULT FALSE. Exactly the house pattern for a feature
-- that must stay dark until someone deliberately turns it on — verified against
-- the live settings row before writing this: auto_nudges_enabled,
-- auto_order_reminders_enabled, ordering_enabled, replies_enabled and
-- proof_check_enabled are all `boolean not null default false`. Not an
-- off/shadow/live enum like ai_drafts_mode / artwork_check_mode: those exist
-- because an automatic pipeline needed a way to run invisibly while it was
-- tuned. The miner already has that — every run is a dry run unless the caller
-- asks otherwise, and a dry run returns the full list of proposals it WOULD have
-- filed. So there is nothing a "shadow" mode would add, and one fewer state to
-- reason about is worth having.
--
-- FALSE ON EVERY EXISTING ROW, which is the whole point: applying this migration
-- changes no behaviour at all. The miner stays read-only until Rob turns it on
-- from the admin page, and even then a run must ask to write.
--
-- WHERE IT IS TURNED ON: Admin → AI drafts → Proposals (the tab the miner's
-- output lands in). Not built in this migration — see the handover note in the
-- PR; the column is here so the control has something to bind to.
--
-- GRANTS: none needed, none given. Postgres table-level privileges automatically
-- cover columns added later, and proofs.settings already sits exactly where it
-- should (verified read-only against live): full CRUD to authenticated (the
-- admin surface writes it), full CRUD to service_role (the edge functions read
-- it), and nothing at all to anon. Restating the matrix here could only widen it
-- by accident, so it is deliberately left alone — the same reasoning as 000349
-- and 000351.
--
-- Additive and inert, so the migration and the edge-function deploy can land in
-- either order: before it, the function reads "not enabled" and dry-runs; after
-- it, the flag reads false and the function still dry-runs.
--
-- Apply via MCP apply_migration / the dashboard SQL editor per the house
-- workflow — never CLI push.

alter table proofs.settings
  add column if not exists ai_draft_miner_enabled boolean not null default false;

comment on column proofs.settings.ai_draft_miner_enabled is
  'Arms the AI draft edit-miner (ai-draft-miner edge function) to FILE its findings as pending proposals. False = every run is computed and returned but nothing is written. Even when true, a run must also pass "dry_run": false. Never writes to the live briefing either way — an admin approving a proposal is still the only path in.';
