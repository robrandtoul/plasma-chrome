-- 000228: ordering feature master toggle.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), where
-- proof-viewer lives in the `proofs` schema. Apply by pasting into that
-- project's dashboard SQL editor (or an MCP apply_migration). Do NOT use
-- `supabase db push` — the CLI link points at the retired standalone project.
--
-- AUTHORED, NOT YET APPLIED — Rob applies this (Step 2 of the Ordering &
-- checkout build; see docs/ordering-checkout-spec.md).
--
-- Admin-controlled master switch for the new Ordering & checkout feature.
-- Lives on the proofs.settings singleton (id = 1) alongside the other feature
-- flags (approvals_enabled, auto_nudges_enabled, ai_drafts_mode). Defaults to
-- false so the feature stays inert — no "Create order" button, no customer
-- pay-page — until an admin flips it. Adding a column inherits the table's
-- existing grants, so no grant statement is needed. Deliberately NOT added to
-- the public_settings() anon RPC: ordering is an admin/designer concern, never
-- exposed to the customer page. `if not exists` for safe replay.

alter table proofs.settings
  add column if not exists ordering_enabled boolean not null default false;
