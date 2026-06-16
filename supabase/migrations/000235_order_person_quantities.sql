-- 000235: per-person order quantities (Ordering & checkout).
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via the dashboard SQL editor / an MCP apply_migration. Do NOT
-- use `supabase db push`.
--
-- AUTHORED, NOT YET APPLIED — for Rob's review before applying. A split-name
-- order can now carry a different quantity per person (e.g. Alec 100, Kyle 50)
-- rather than an implied equal split. The customer enters these on the pay-page;
-- the COMBINED total drives the tier price (Rob's decision 2026-06-15), and this
-- per-person breakdown is the production instruction the fulfilment team needs.
--
-- Shape: a jsonb array of { name, quantity }, e.g.
--   [{"name":"Alec","quantity":100},{"name":"Kyle","quantity":50}]
-- Null for single-person / custom-quote orders, or any order placed before this.
--
-- Additive only. authenticated already has full CRUD on proofs.orders (000229)
-- and the column inherits it; service_role (the checkout edge function) writes it.

alter table proofs.orders
  add column if not exists person_quantities jsonb;
