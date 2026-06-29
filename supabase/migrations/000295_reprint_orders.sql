-- 000295: free reprint after complaint — order_kind='reprint' + link-back.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), where
-- proof-viewer lives in the `proofs` schema. Apply via the dashboard SQL editor
-- (or an MCP apply_migration). Do NOT use `supabase db push` — the CLI link
-- points at the retired standalone project.
--
-- A reprint is a FREE remake (goodwill) raised after a complaint or damage:
-- lost in transit, arrived faulty, or a design we need to correct. Rob's rule:
-- if we'd charge for it, it almost certainly wasn't our fault, so it's a normal
-- new project — not a reprint. A reprint is therefore ALWAYS free.
--
-- It is modelled as a NEW order (order_kind='reprint') on the SAME proof, NOT a
-- revision of the original and NOT a duplicated proof. The original order stays
-- a complete, untouched record (it was produced + shipped). The reprint is born
-- already 'paid' with every amount zero (the create-order 'offline' path), so it
-- never goes through Stripe or the pay page, and lands straight in the To-order
-- queue for the existing place-order → Stock Control hand-off. reprint_of_order_id
-- links it back to the order it replaces, so the complaint → original → reprint
-- story stays in one place (shown on the Flagged board card + the Orders page).
--
-- Two additive, replay-safe changes. No grant work: order_kind already exists,
-- and the new column inherits proofs.orders' existing grants (authenticated full
-- CRUD, service_role all, anon none — 000229/000176). No customer-facing
-- exposure: a reprint never reaches /p/:id or the anon pay-page RPC.

begin;

-- ── 1. reprint_of_order_id link-back ───────────────────────────────
-- ON DELETE SET NULL (not CASCADE): if the original order is ever deleted the
-- reprint survives with the link cleared, preserving its own record. Self-FK on
-- proofs.orders; nullable (only reprint rows set it).
alter table proofs.orders
  add column if not exists reprint_of_order_id uuid references proofs.orders(id) on delete set null;

comment on column proofs.orders.reprint_of_order_id is
  'For an order_kind=''reprint'' order, the original (already produced + shipped) '
  'order this free reprint replaces — on the same proof. NULL for every other '
  'order. ON DELETE SET NULL so the reprint outlives a deleted original. '
  'Added in 000295.';

-- Index the link so the Flagged card + Orders page can find "the reprints of
-- this order" without a scan.
create index if not exists orders_reprint_of_order_id_idx
  on proofs.orders(reprint_of_order_id);

-- ── 2. allow order_kind='reprint' ──────────────────────────────────
-- The constraint already exists from 000287 as ('production','prototype'); drop
-- and recreate it to add 'reprint' (idempotent on replay).
do $$
begin
  if exists (
    select 1 from pg_constraint where conname = 'orders_order_kind_check'
  ) then
    alter table proofs.orders drop constraint orders_order_kind_check;
  end if;
  alter table proofs.orders
    add constraint orders_order_kind_check
    check (order_kind in ('production', 'prototype', 'reprint'));
end $$;

comment on column proofs.orders.order_kind is
  'production (a normal card order), prototype (the flat-fee prototyping '
  'service), or reprint (a FREE remake after a complaint/damage). A prototype is '
  'a custom-quote order (custom_quote_total = the flat fee). A reprint is free '
  '(all amounts 0), born ''paid'' off the offline path so it skips Stripe/Xero, '
  'and links to its original via reprint_of_order_id. All three flow through the '
  'same place-order hand-off. Added in 000287; updated in 000295.';

commit;
