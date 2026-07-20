-- Order hand-off Phase 1 — proofs-side columns + the mode switch
-- (docs/order-handoff-spec.md §5, §3.6).
--
-- All columns ride EXISTING proofs tables, so they inherit those tables'
-- explicit grant matrices — no new grants needed here (the no-default-grants
-- rule bites on new TABLES, not new columns).
--
-- Target: the merged stock-control project (proofs schema). Apply via MCP /
-- dashboard SQL editor per the house workflow — never CLI push.

-- Explicit mapping to Stock Control's catalogue for the 1:1 material families
-- (metals, carbon, papers, full-colour/translucent plastic). Soft reference to
-- public.materials.id — deliberately NO cross-schema FK (the 000258 house
-- pattern). Letterpress resolves via its colour trio, wood via species name,
-- satin/tinted/acrylic via orders.stock_colour, so those rows stay NULL.
-- Admin surface: Admin → Catalogue data → Stock materials.
alter table proofs.materials
  add column if not exists stock_material_id uuid;
comment on column proofs.materials.stock_material_id is
  'Stock Control public.materials.id this material maps to for the direct order hand-off. Soft reference, no FK. NULL = resolved another way (letterpress trio / wood species / stock colour) or not yet mapped.';

-- Hand-off state on the order. handoff_at + handoff_payload are stamped by the
-- create_order_handoff RPC in the SAME transaction as the Stock Control insert
-- (live mode) — handoff_at is therefore the direct path's idempotency key. In
-- shadow mode place-order stores handoff_payload + any validation problems
-- (handoff_error) without executing, for the parity check. The two *_at send
-- stamps are done-once flags for the human messages (000309 idiom), consumed by
-- the Phase 2 retry surfacing.
alter table proofs.orders
  add column if not exists handoff_at timestamptz,
  add column if not exists handoff_payload jsonb,
  add column if not exists handoff_error text,
  add column if not exists production_note_posted_at timestamptz,
  add column if not exists supplier_email_sent_at timestamptz;
comment on column proofs.orders.handoff_at is
  'When the direct hand-off wrote this order into Stock Control (live mode). Set in the same transaction as the SC insert — non-null means the SC job exists; the direct path''s idempotency key.';
comment on column proofs.orders.handoff_payload is
  'The exact contract payload (docs/order-handoff-spec.md §3.2) composed at placement. Shadow mode: stored for parity checking. Live mode: stamped by the RPC.';
comment on column proofs.orders.handoff_error is
  'Last hand-off failure, cleared on success. Shadow mode: validation problems (prefixed "shadow:"). Live mode: the RPC error that blocked placement. Backs the Orders-page chip.';
comment on column proofs.orders.production_note_posted_at is
  'Done-once stamp: the in-house production note was posted to Help Scout (live mode). NULL on a fulfilled in-house order = send failed, surface + retry.';
comment on column proofs.orders.supplier_email_sent_at is
  'Done-once stamp: the supplier email conversation was created (live mode). NULL on a fulfilled supplier order = send failed, surface + retry.';

-- The mode switch (ai_drafts_mode house pattern). off = today's behaviour
-- byte-for-byte; shadow = today + validate-only call + payload stored; live =
-- direct-write-first (Phase 2 code). Editable on Admin → Settings.
alter table proofs.settings
  add column if not exists direct_handoff_mode text not null default 'off';
alter table proofs.settings
  drop constraint if exists settings_direct_handoff_mode_check;
alter table proofs.settings
  add constraint settings_direct_handoff_mode_check
  check (direct_handoff_mode in ('off', 'shadow', 'live'));
comment on column proofs.settings.direct_handoff_mode is
  'Order hand-off rollout switch (docs/order-handoff-spec.md §3.6): off | shadow | live.';
