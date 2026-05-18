-- Migration 000170: drop the awaiting_customer column from
-- public_dashboard_projects and the awaiting_customer field from
-- dashboard_tile_counts() (PV-2026W20-005).
--
-- 000161 added awaiting_customer to the view; 000152 (and re-emitted
-- in 000154) shipped the same field on the tile-count function. Both
-- have been dead since the dashboard moved every tile count to client-
-- side computation against the rows of public_dashboard_projects. The
-- awaitingCustomerCount useMemo in DashboardPage now sources the
-- Awaiting customer tile directly from the projects array, and the
-- filter predicate behind the tile's click-through lives in the same
-- file. Keeping the SQL column wired up duplicates that logic for no
-- consumer and risks a future maintainer wiring the dashboard back to
-- it and reintroducing the count/filter drift fixed under PV-2026W19-015
-- + PV-2026W20-014.
--
-- Drop+recreate for the view (Postgres won't let us drop a column
-- from an existing view body). DROP + CREATE OR REPLACE for the
-- function (CREATE OR REPLACE can't change the return shape).
--
-- The view body is otherwise identical to 000166 — same column
-- order, same joins, same comment style. Only the awaiting_customer
-- subquery and its surrounding comma have been removed. The function
-- body is identical to 000154 minus the awaiting CTE and the
-- awaiting_customer field in the SELECT.

begin;

-- ── 1. public_dashboard_projects without awaiting_customer ──────────────────

drop view if exists public_dashboard_projects;

create view public_dashboard_projects as
  with current_versions as (
    select distinct on (pv.proof_id)
      pv.proof_id,
      pv.id              as version_id,
      pv.version_number,
      pv.material_display,
      pv.created_at      as version_created_at,
      pv.created_by      as designer_user_id
    from proof_versions pv
    where pv.is_current
    order by pv.proof_id, pv.version_number desc
  ),
  latest_events as (
    select distinct on (e.proof_id)
      e.proof_id,
      e.created_at    as latest_event_at,
      e.event_type    as latest_event_type,
      e.actor_name    as latest_event_actor
    from dashboard_latest_events e
    order by e.proof_id, e.created_at desc
  ),
  current_view_state as (
    select distinct on (cv.proof_id)
      cv.proof_id,
      v.viewed_at as current_version_viewed_at
    from proof_versions cv
    join proof_version_views v on v.proof_version_id = cv.id
    where cv.is_current and v.is_bot = false
    order by cv.proof_id, v.viewed_at desc
  ),
  na as (
    select * from proofs_needing_attention()
  )
  select
    p.id                                                     as proof_id,
    p.created_at,
    p.last_activity_at,
    p.status,
    p.approved_at,
    p.abandoned_at,
    p.disclaimer_acknowledged_at,
    p.helpscout_conversation_url,
    p.helpscout_conversation_id,
    c.id                                                     as contact_id,
    c.full_name                                              as contact_name,
    c.email                                                  as contact_email,
    co.id                                                    as company_id,
    co.name                                                  as company_name,
    cv.version_id                                            as current_version_id,
    cv.version_number                                        as current_version_number,
    cv.material_display,
    cv.version_created_at,
    cv.designer_user_id,
    pr.full_name                                             as designer_name,
    pr.designer_initials,
    pr.designer_colour,
    pr.avatar_url                                            as designer_avatar_url,
    le.latest_event_at,
    le.latest_event_type,
    le.latest_event_actor,
    cvs.current_version_viewed_at,
    na.rule_code,
    na.rule_meta,
    -- Snooze columns (unchanged from 000164)
    snz.snooze_rule_code,
    snz.snoozed_until,
    snz.snooze_note,
    snz.snoozed_by_name,
    snz.snoozed_by_initials,
    snz.snoozed_by_colour
  from proofs p
  left join contacts  c   on c.id = p.contact_id
  left join companies co  on co.id = c.company_id
  left join current_versions cv on cv.proof_id = p.id
  left join profiles  pr  on pr.id = cv.designer_user_id
  left join latest_events   le  on le.proof_id = p.id
  left join current_view_state cvs on cvs.proof_id = p.id
  left join na on na.proof_id = p.id
  left join lateral (
    select
      s.rule_code           as snooze_rule_code,
      s.snoozed_until,
      s.note                as snooze_note,
      pr2.full_name         as snoozed_by_name,
      pr2.designer_initials as snoozed_by_initials,
      pr2.designer_colour   as snoozed_by_colour
    from proof_attention_snoozes s
    left join profiles pr2 on pr2.id = s.snoozed_by
    where s.proof_id = p.id
      and s.snoozed_until > now()
    order by s.snoozed_until desc
    limit 1
  ) snz on true;

revoke all on public_dashboard_projects from anon, public;
grant select on public_dashboard_projects to authenticated;

comment on view public_dashboard_projects is
  'One row per proof for the redesigned designer dashboard. Joins '
  'contact, company, latest version (with designer attribution from '
  'profiles including avatar_url since 000166), the latest '
  'dashboard_latest_events row, the highest-priority needs-attention '
  'rule from proofs_needing_attention() (snooze-excluded since 000164), '
  'and the longest-remaining active snooze from proof_attention_snoozes. '
  'View runs as owner so it bypasses admin-only RLS on profiles. '
  'awaiting_customer column dropped in 000169 — the dashboard now '
  'computes that tile count and its filter predicate client-side.';

-- ── 2. dashboard_tile_counts() without awaiting_customer ────────────────────
--
-- CREATE OR REPLACE can't change the return shape (the awaiting_customer
-- column is being removed from the returns table) so the function has
-- to be dropped first. Postgres function-to-function references resolve
-- at call time, not at definition time, so no CASCADE needed here even
-- though the function previously called proofs_needing_attention().
-- No consumers in the frontend still call this function (DashboardPage
-- moved every tile to client-side computation in PV-2026W20-014), but
-- it's still exported on the authenticated grant so a future caller
-- could pick it up; keep it intact for the remaining three counts.

drop function if exists dashboard_tile_counts();

create or replace function dashboard_tile_counts()
returns table (
  needs_attention    int,
  dormant            int,
  approved_this_week int
)
language sql
stable
set search_path = public
as $$
  select
    (select count(*)::int from proofs_needing_attention())   as needs_attention,
    (select count(*)::int from proofs where status = 'dormant') as dormant,
    (select count(*)::int from proofs
       where status = 'approved'
         and approved_at >= now() - interval '7 days')        as approved_this_week;
$$;

grant execute on function dashboard_tile_counts() to authenticated;

comment on function dashboard_tile_counts() is
  'Aggregate counts for the three remaining dashboard tiles served '
  'server-side (needs_attention, dormant, approved_this_week). The '
  'awaiting_customer count was dropped in 000169 — the dashboard '
  'computes it (and its filter predicate) client-side from the '
  'public_dashboard_projects rows it already loads.';

commit;
