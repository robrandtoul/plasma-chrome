-- Migration 000161: extend public_dashboard_projects with an
-- awaiting_customer boolean column so the dashboard's tile count
-- and tile-filtered project list agree on a single predicate.
--
-- Why
--   dashboard_tile_counts() computes the "Awaiting customer" tile
--   from a CTE: status = 'in_progress' AND no non-bot
--   proof_version_views on the current version AND no
--   proof_events of type approve / request_changes on the current
--   version. The client filter at DashboardPage:886 used a
--   simpler predicate (status = 'in_progress' AND
--   current_version_viewed_at IS NULL), missing the events
--   absence check. A theoretical edge case (request_changes
--   recorded without a corresponding non-bot view, e.g. direct
--   API call) would be counted by the tile but excluded from the
--   list, so the count and the filter result disagreed.
--
-- What
--   Drop and recreate public_dashboard_projects with an
--   awaiting_customer boolean column whose expression mirrors
--   dashboard_tile_counts.awaiting CTE exactly. Client then reads
--   p.awaiting_customer directly — no second round-trip, no
--   client-side predicate to keep in sync with SQL. Same
--   single-source-of-truth pattern 000154 used for rule_code.
--
-- View must be drop+create (CREATE OR REPLACE VIEW can't add a
-- column in an arbitrary position). Re-grants SELECT to
-- authenticated; keeps the REVOKE on anon, public — same
-- treatment 000152 / 000154 applied.

begin;

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
    le.latest_event_at,
    le.latest_event_type,
    le.latest_event_actor,
    cvs.current_version_viewed_at,
    na.rule_code,
    na.rule_meta,
    -- awaiting_customer mirrors dashboard_tile_counts.awaiting CTE
    -- exactly: in_progress with a current version that has neither
    -- a non-bot view nor an approve / request_changes event.
    -- cv.version_id IS NOT NULL guard prevents an in_progress
    -- proof with no current version (edge case during creation)
    -- from being flagged as awaiting — the tile CTE inner-joins
    -- current_versions, so a missing version excludes it there
    -- too.
    (
      p.status = 'in_progress'
      and cv.version_id is not null
      and not exists (
        select 1
        from proof_version_views v
        where v.proof_version_id = cv.version_id
          and v.is_bot = false
      )
      and not exists (
        select 1
        from proof_events e
        where e.proof_version_id = cv.version_id
          and e.event_type in ('approve', 'request_changes')
      )
    )                                                        as awaiting_customer
  from proofs p
  left join contacts  c   on c.id = p.contact_id
  left join companies co  on co.id = c.company_id
  left join current_versions cv on cv.proof_id = p.id
  left join profiles  pr  on pr.id = cv.designer_user_id
  left join latest_events   le  on le.proof_id = p.id
  left join current_view_state cvs on cvs.proof_id = p.id
  left join na on na.proof_id = p.id;

revoke all on public_dashboard_projects from anon, public;
grant select on public_dashboard_projects to authenticated;

comment on view public_dashboard_projects is
  'One row per proof for the redesigned designer dashboard. Joins '
  'contact, company, latest version (with designer attribution from '
  'profiles), the latest dashboard_latest_events row, and the '
  'highest-priority needs-attention rule from '
  'proofs_needing_attention(). The awaiting_customer column '
  'mirrors dashboard_tile_counts.awaiting exactly so the tile '
  'count and the tile-filtered list share one predicate. View '
  'runs as owner so it bypasses admin-only RLS on profiles for '
  'the avatar metadata.';

commit;
