-- Migration 000122: dashboard_latest_events view for designer surfacing.
--
-- Phase 2 Prompt 8 surfaces customer-recorded approvals + change-
-- requests in three places:
--   * DashboardPage right-hand sidebar — last 10 events across all
--     proofs.
--   * Project list status badges — derived per-version from
--     proof_name_approvals, no view needed.
--   * ProofDetailPage per-recipient detail — designers read
--     proof_events directly (RLS allows authenticated SELECT per
--     migration 000116).
--
-- Only the dashboard sidebar warrants a view: it joins through to
-- proofs → contacts → companies for the project name display, and
-- the join predicate is verbose enough that hand-rolling it in
-- supabase-js with PostgREST nested selects would be brittle. The
-- view collapses the join into one anon-server-friendly select, then
-- the dashboard caps to 10 client-side via .order(...).limit(10).
--
-- No RLS — the view inherits from proof_events (authenticated
-- SELECT) and the joined tables (designers see all). Anon SELECT is
-- NOT granted; the customer page has no business reading the
-- dashboard's audit feed.

begin;

create or replace view dashboard_latest_events as
  select
    e.id,
    e.created_at,
    e.event_type,
    e.actor_name,
    e.name                  as recipient_name,
    e.helpscout_thread_id,
    pv.id                   as proof_version_id,
    pv.version_number,
    p.id                    as proof_id,
    c.full_name             as contact_name,
    co.name                 as company_name
  from proof_events e
  join proof_versions pv on pv.id = e.proof_version_id
  join proofs p on p.id = pv.proof_id
  left join contacts c on c.id = p.contact_id
  left join companies co on co.id = c.company_id;

-- Default Postgres views run as their owner (security_definer-like)
-- regardless of grants on underlying tables, so the view would
-- otherwise leak proof_events to anon despite proof_events itself
-- being authenticated-only via RLS. Explicit REVOKE FROM anon, PUBLIC
-- closes that — the only roles with SELECT after this are
-- authenticated and service_role.
revoke all on dashboard_latest_events from anon, public;
grant select on dashboard_latest_events to authenticated;

commit;
