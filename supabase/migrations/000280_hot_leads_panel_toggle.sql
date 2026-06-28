-- 000280: dashboard Hot-leads panel master toggle.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), where
-- proof-viewer lives in the `proofs` schema. Apply by pasting into that
-- project's dashboard SQL editor (or an MCP apply_migration). Do NOT use
-- `supabase db push` — the CLI link points at the retired standalone project.
--
-- AUTHORED, NOT YET APPLIED — Rob applies this.
--
-- Admin-controlled switch for the "Hot leads to chase" card on the designer
-- dashboard (src/components/HotLeadsCard.tsx, reading analytics_hot_leads()).
-- Lives on the proofs.settings singleton (id = 1) alongside the other feature
-- flags (approvals_enabled, ordering_enabled, ...). Defaults to TRUE because
-- the panel ships shown — the toggle lets an admin hide it, so the default
-- keeps current behaviour unchanged on apply. Adding a column inherits the
-- table's existing grants, so no grant statement is needed. Deliberately NOT
-- added to the public_settings() anon RPC: the dashboard is designer-facing,
-- never exposed to the customer page. `if not exists` for safe replay.

alter table proofs.settings
  add column if not exists hot_leads_panel_enabled boolean not null default true;
