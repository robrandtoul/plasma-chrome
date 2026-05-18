-- Migration 000186: widen the snooze lateral on public_dashboard_projects
-- to also surface snoozes that expired within the last 24 hours
-- (PV-2026W21-069).
--
-- The lateral subquery added in 000164 (and re-emitted in 000170) carried
-- `where s.snoozed_until > now()`, so as soon as a snooze expired the
-- dashboard row's six snooze_* columns dropped to NULL. recentlyAwakened()
-- in src/lib/dashboardGrouping.ts requires snoozed_until to be non-null
-- before it can apply the 24-hour Today-bucket boost, so on production
-- data the awakening boost never fired — the rule was passing unit tests
-- (which set snoozed_until on synthetic objects) but had no effect on
-- live rows.
--
-- Widening the filter to `s.snoozed_until > now() - interval '24 hours'`
-- lets recently-expired snoozes carry their snoozed_until forward for one
-- day, which gives recentlyAwakened() the signal it needs and lets the
-- "what happened on this proof yesterday" tooltip text stay coherent for
-- the first day after a snooze ends.
--
-- Semantic note for the frontend: with this widening, a row with
-- snoozed_until set no longer implies the proof is currently snoozed.
-- Tile-count predicates, click-through filters, and the buildSnoozedSection
-- grouping in src/pages/DashboardPage.tsx + src/lib/dashboardGrouping.ts
-- are tightened in the same PR to also check that snoozed_until is in the
-- future. The Unsnooze action-visibility check still triggers on
-- snoozed_until != null so a designer can clear a freshly-expired snooze
-- row during the grace window.
--
-- Body is otherwise identical to the 000170 emission of the view — same
-- column order, same joins, only the lateral subquery's where clause
-- changes.

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
    pr.avatar_url                                            as designer_avatar_url,
    le.latest_event_at,
    le.latest_event_type,
    le.latest_event_actor,
    cvs.current_version_viewed_at,
    na.rule_code,
    na.rule_meta,
    -- Snooze columns. Lateral filter widened to a 24-hour grace window
    -- so recentlyAwakened() in dashboardGrouping.ts can fire on rows
    -- whose snooze has just expired (PV-2026W21-069).
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
      and s.snoozed_until > now() - interval '24 hours'
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
  'and the longest-remaining snooze from proof_attention_snoozes. Snooze '
  'lateral widened in 000186 to a 24-hour grace window so '
  'recentlyAwakened() can fire on freshly-expired snoozes; frontend '
  'predicates that mean "currently snoozed" now require snoozed_until '
  'to be in the future as well as non-null. View runs as owner so it '
  'bypasses admin-only RLS on profiles.';

commit;
