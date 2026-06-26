-- 000274_grant_compute_candidates_to_authenticated.sql
--
-- Hotfix for 000273. That migration wired compute_nudge_candidates() into
-- proofs_in_follow_up() (its new "Branch B"). proofs_in_follow_up() is
-- SECURITY INVOKER and is called by the designer dashboard via
-- public_dashboard_projects + dashboard_tile_counts(), so it runs as the
-- `authenticated` role. compute_nudge_candidates() was granted to service_role
-- only (it was built for the send-nudges edge function), so the authenticated
-- dashboard query hit "permission denied for function compute_nudge_candidates"
-- and the entire projects view + tile counts failed — the dashboard showed no
-- projects and every count as 00.
--
-- Grant EXECUTE to authenticated. The function is SECURITY INVOKER, so RLS on
-- every table it reads still applies, and it returns only data designers
-- already see on the dashboard (proof/contact/company/version/reply metadata).
-- No anon grant — the customer surface never touches this.

grant execute on function proofs.compute_nudge_candidates() to authenticated;
