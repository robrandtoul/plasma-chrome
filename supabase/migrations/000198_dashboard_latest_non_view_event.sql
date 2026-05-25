-- Migration 000198: expose latest_non_view_event_at / latest_non_view_event_type
-- on public_dashboard_projects (PV-2026W22-087).
--
-- The Changes-requested dashboard tile counts proofs whose most recent
-- customer action on the current version was a change request, with no
-- newer version shipped since. It read latest_event_type, which is the
-- most recent row from dashboard_latest_events — and dashboard_latest_events
-- UNIONs synthetic event_type='view' rows from proof_version_views (000127).
-- So when a customer requested changes and then simply re-opened the proof
-- page, the latest event became 'view' and the proof silently dropped out
-- of the tile even though nothing had been resolved.
--
-- This adds a parallel pair of columns sourced from the same
-- dashboard_latest_events feed, filtered to event_type <> 'view':
--   * latest_non_view_event_type — most recent non-view event type
--   * latest_non_view_event_at   — its timestamp
-- The dashboard's Changes-requested tile count and click-through filter
-- switch to these. Using the non-view event's own timestamp also fixes a
-- second case the naive field-swap would miss: a change request answered by
-- a new version, then followed by a customer view, would otherwise re-count
-- because latest_event_at would be the later view. Comparing the change
-- request's own time against version_created_at keeps "no newer version
-- since" correct. latest_event_type / latest_event_at are unchanged for the
-- Latest-activity timeline, which does want view events.
--
-- CREATE OR REPLACE VIEW with the two new columns appended last, so grants
-- and the security_invoker = on option (000181 / 000197) survive without a
-- drop. security_invoker = on is re-stated explicitly at the end as
-- belt-and-braces.

begin;

create or replace view public_dashboard_projects as
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
  latest_non_view_events as (
    select distinct on (e.proof_id)
      e.proof_id,
      e.created_at    as latest_non_view_event_at,
      e.event_type    as latest_non_view_event_type
    from dashboard_latest_events e
    where e.event_type <> 'view'
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
    snz.snooze_rule_code,
    snz.snoozed_until,
    snz.snooze_note,
    snz.snoozed_by_name,
    snz.snoozed_by_initials,
    snz.snoozed_by_colour,
    -- Latest non-view event (PV-2026W22-087): same dashboard_latest_events
    -- feed as latest_event_*, filtered to event_type <> 'view' so a later
    -- customer page-view cannot mask an outstanding change request.
    lne.latest_non_view_event_at,
    lne.latest_non_view_event_type
  from proofs p
  left join contacts  c   on c.id = p.contact_id
  left join companies co  on co.id = c.company_id
  left join current_versions cv on cv.proof_id = p.id
  left join profiles  pr  on pr.id = cv.designer_user_id
  left join latest_events   le  on le.proof_id = p.id
  left join latest_non_view_events lne on lne.proof_id = p.id
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
alter view public_dashboard_projects set (security_invoker = on);

comment on view public_dashboard_projects is
  'One row per proof for the redesigned designer dashboard. Joins '
  'contact, company, latest version (with designer attribution from '
  'profiles including avatar_url since 000166), the latest '
  'dashboard_latest_events row, the latest non-view event (000198, for '
  'the Changes-requested tile), the highest-priority needs-attention '
  'rule from proofs_needing_attention() (snooze-excluded since 000164), '
  'and the longest-remaining snooze from proof_attention_snoozes. Snooze '
  'lateral widened in 000186 to a 24-hour grace window so '
  'recentlyAwakened() can fire on freshly-expired snoozes; frontend '
  'predicates that mean "currently snoozed" require snoozed_until to be '
  'in the future as well as non-null. Runs with security_invoker = on '
  '(000181), so it honours the querying user''s RLS context.';

commit;
