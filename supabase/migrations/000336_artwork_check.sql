-- Artwork sanity check — Phase 1 storage + rollout gates
-- (docs/artwork-check-spec.md).
--
-- The check compares what the customer supplied (Help Scout thread) against
-- what's on the print artwork (Dropbox print files) + the stored QR contents,
-- and stores its latest report on the order — the handoff_payload pattern
-- (000332): one jsonb column, no history table until re-run history is needed.
--
-- All columns ride EXISTING proofs tables, so they inherit those tables'
-- explicit grant matrices — no new grants needed (the no-default-grants rule
-- bites on new TABLES, not new columns). The report is internal-only: nothing
-- here touches public_* views or anon RPCs.
--
-- Target: the merged stock-control project (proofs schema). Apply via MCP /
-- dashboard SQL editor per the house workflow — never CLI push.

-- The latest report + run stamp + verdict on the order. artwork_checked_at is
-- the mandatory-run gate's key: place-order (mode confirm) refuses when
-- settings.artwork_check_required is on and this is NULL. An errored run still
-- stamps it (verdict 'error') so a transient Help Scout / Dropbox outage can't
-- strand an order — the verdict stays advisory either way.
alter table proofs.orders
  add column if not exists artwork_check jsonb,
  add column if not exists artwork_checked_at timestamptz,
  add column if not exists artwork_check_verdict text;

alter table proofs.orders
  drop constraint if exists orders_artwork_check_verdict_check;
alter table proofs.orders
  add constraint orders_artwork_check_verdict_check
  check (artwork_check_verdict is null or artwork_check_verdict in ('clear', 'flagged', 'error'));

comment on column proofs.orders.artwork_check is
  'Latest artwork sanity-check report (docs/artwork-check-spec.md): verdict + per-card supplied-vs-printed findings + corrections + notes + reference gaps. Written by the artwork-check edge function; advisory only.';
comment on column proofs.orders.artwork_checked_at is
  'When the artwork check last ran for this order. The mandatory-run gate key: place-order refuses to confirm while NULL when settings.artwork_check_required is on. Errored runs stamp it too (non-stranding).';
comment on column proofs.orders.artwork_check_verdict is
  'clear | flagged | error — the latest report''s verdict, for Orders-page filtering/chips without parsing the jsonb.';

-- The rollout switches (ai_drafts_mode / direct_handoff_mode house pattern).
-- off = nothing runs; shadow = the review page triggers the check and the
-- report is stored, but the page shows nothing (Rob reviews reports via SQL
-- while the prompt + allow-list are tuned); live = the advisory card appears.
alter table proofs.settings
  add column if not exists artwork_check_mode text not null default 'off';
alter table proofs.settings
  drop constraint if exists settings_artwork_check_mode_check;
alter table proofs.settings
  add constraint settings_artwork_check_mode_check
  check (artwork_check_mode in ('off', 'shadow', 'live'));
comment on column proofs.settings.artwork_check_mode is
  'Artwork sanity-check rollout switch (docs/artwork-check-spec.md): off | shadow | live.';

-- The mandatory-run enforcement, separate from the mode so the card can run
-- live for a settling-in period before running the check becomes required.
-- Only bites when the mode is ALSO live (a shadow/off check can't be a
-- precondition the reviewer can see or satisfy).
alter table proofs.settings
  add column if not exists artwork_check_required boolean not null default false;
comment on column proofs.settings.artwork_check_required is
  'When true (and artwork_check_mode = live), an order cannot be placed until the artwork check has run for it — enforced in the review page UI and server-side in place-order. The verdict stays advisory; only RUNNING is mandatory.';
