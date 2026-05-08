-- Migration 000151: belt-and-braces REVOKE on material_price_tier_counts.
--
-- Bug audit PV-2026W19-002 (re-flag) — the view added in 000148 grants
-- SELECT to authenticated but never explicitly REVOKEs from anon /
-- public. Views run as their owner and Postgres' default schema grants
-- to PUBLIC can leak the underlying RLS-protected data through the
-- view. The 000127 dashboard_latest_events view shows the canonical
-- shape: explicit REVOKE before the GRANT.
--
-- The view aggregates counts only (no row data), so the real-world
-- exposure is mild even today — but the playbook view-leak rule
-- prescribes REVOKE FROM anon, public as defence in depth, and 000148
-- shipped without it. Closing the gap in source so a fresh replay of
-- migrations produces a locked-down view from the start, and so the
-- live DB matches.
--
-- Idempotent: REVOKE on a privilege that was never granted is a no-op.
--
-- Live-DB pre-check skipped (no .env / service-role key available
-- inside the audit sandbox). Safe to apply as written; verify on the
-- live DB before merging.

begin;

revoke all on material_price_tier_counts from anon, public;

-- Re-grant SELECT to authenticated to make the intent explicit and
-- guard against any future schema-level grant change. No behavioural
-- change vs 000148.
grant select on material_price_tier_counts to authenticated;

commit;
