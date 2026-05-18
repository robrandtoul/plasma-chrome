-- Migration 000188: include designer_override_approve in the
-- request_changes_no_version and viewed_not_actioned rule predicates
-- (PV-2026W21-044).
--
-- The two rules ship from 000164 with a `pe.event_type in ('approve',
-- 'request_changes')` filter. They were written before the
-- designer_override_approve event type existed as a distinct value
-- (it lived under 'approve' at the time 000154 was drafted), and the
-- audit on 2026-05-19 caught that 000164 carried the two-value list
-- through unchanged. The behavioural consequence:
--
--   * Rule 1 (request_changes_no_version): if a designer override-
--     approves a version after the customer's request_changes event,
--     the proof should stop firing the rule because the workflow has
--     moved on. With the current predicate, the override_approve row
--     is invisible to the `event_type in ('approve','request_changes')`
--     filter, so the request_changes remains the latest event and the
--     rule keeps firing indefinitely.
--
--   * Rule 4 (viewed_not_actioned): the rule fires once a version is
--     viewed but neither approved nor change-requested. A designer
--     override-approve should clear the rule because it's a positive
--     workflow signal; today it doesn't, so the proof stays flagged
--     until the customer also acts (which may never happen because the
--     workflow is already complete).
--
-- The fix is mechanical: widen both `in (...)` lists to include
-- 'designer_override_approve'. Everything else in the function body is
-- preserved verbatim from 000164. The snooze exclusion in the final
-- SELECT and all other rules carry through untouched.
--
-- Drop-and-recreate is required because public_dashboard_projects (and
-- na CTE inside it) depends on the return shape; we don't change the
-- shape so the dependency stays satisfied without dropping the view.

begin;

create or replace function proofs_needing_attention()
returns table (
  proof_id  uuid,
  rule_code text,
  rule_meta jsonb
)
language plpgsql
stable
set search_path = public
as $$
declare
  rules jsonb;
  rule_rcnv jsonb;
  rule_hs   jsonb;
  rule_snv  jsonb;
  rule_vna  jsonb;
  rule_ad   jsonb;
  rule_sip  jsonb;
begin
  select s.needs_attention_rules into rules from site_settings s where s.id = 1;

  rule_rcnv := rules->'request_changes_no_version';
  rule_hs   := rules->'helpscout_follow_up_tag';
  rule_snv  := rules->'sent_never_viewed';
  rule_vna  := rules->'viewed_not_actioned';
  rule_ad   := rules->'approaching_dormant';
  rule_sip  := rules->'stuck_in_progress';

  return query
  with current_versions as (
    select pv.proof_id, pv.id as version_id, pv.created_at
    from proof_versions pv
    where pv.is_current
  ),
  -- Rule 1: latest customer event on the current version is a
  -- request_changes, AND no version newer than that event has been
  -- shipped. Widened in 000188 to recognise designer_override_approve
  -- as a terminal workflow event.
  rcnv_evt as (
    select cv.proof_id, cv.created_at as version_created_at, e.created_at as event_at
    from current_versions cv
    join lateral (
      select pe.created_at, pe.event_type
      from proof_events pe
      where pe.proof_version_id = cv.version_id
        and pe.event_type in ('approve', 'request_changes', 'designer_override_approve')
      order by pe.created_at desc
      limit 1
    ) e on true
    where e.event_type = 'request_changes'
      and not exists (
        select 1 from proof_versions newer
        where newer.proof_id = cv.proof_id
          and newer.created_at > e.created_at
      )
  ),
  rcnv as (
    select
      r.proof_id,
      case when (rule_rcnv->>'calendar')::boolean
        then (extract(epoch from now() - r.event_at)::int) / 86400
        else business_days_between(r.event_at::date, now()::date)
      end as days
    from rcnv_evt r
  ),
  -- Rule 2: HS follow-up tag (no threshold).
  hs as (
    select p.id as proof_id
    from proofs p
    where p.helpscout_conversation_id is not null
      and p.helpscout_tags @> array['follow up']::text[]
  ),
  -- Rule 3: in_progress, no non-bot view of the current version.
  snv as (
    select cv.proof_id,
      case when (rule_snv->>'calendar')::boolean
        then (extract(epoch from now() - cv.created_at)::int) / 86400
        else business_days_between(cv.created_at::date, now()::date)
      end as days
    from current_versions cv
    join proofs p on p.id = cv.proof_id
    where p.status = 'in_progress'
      and not exists (
        select 1 from proof_version_views v
        where v.proof_version_id = cv.version_id and v.is_bot = false
      )
  ),
  -- Rule 4: in_progress, current version was viewed but no approve/
  -- request_changes/designer_override_approve since the last view.
  -- Widened in 000188 so a designer override-approve clears the rule.
  vna_seed as (
    select cv.proof_id, cv.version_id, max(v.viewed_at) as last_viewed_at
    from current_versions cv
    join proofs p on p.id = cv.proof_id
    join proof_version_views v on v.proof_version_id = cv.version_id and v.is_bot = false
    where p.status = 'in_progress'
    group by cv.proof_id, cv.version_id
  ),
  vna as (
    select s.proof_id,
      case when (rule_vna->>'calendar')::boolean
        then (extract(epoch from now() - s.last_viewed_at)::int) / 86400
        else business_days_between(s.last_viewed_at::date, now()::date)
      end as days
    from vna_seed s
    where not exists (
      select 1 from proof_events pe
      where pe.proof_version_id = s.version_id
        and pe.event_type in ('approve', 'request_changes', 'designer_override_approve')
        and pe.created_at >= s.last_viewed_at
    )
  ),
  -- Rule 5: approaching dormant (calendar days only). Fires when
  -- last_activity_at is in the (30 - threshold, 30) days-ago band.
  ad as (
    select p.id as proof_id,
      (extract(epoch from now() - p.last_activity_at)::int) / 86400 as days
    from proofs p
    where p.status not in ('approved', 'abandoned')
      and p.last_activity_at <= now() - make_interval(days => (30 - (rule_ad->>'threshold_days')::int))
      and p.last_activity_at >= now() - interval '30 days'
  ),
  -- Rule 6: stuck in progress — in_progress with no event or view in
  -- threshold working/calendar days.
  sip as (
    select p.id as proof_id,
      case when (rule_sip->>'calendar')::boolean
        then (extract(epoch from now() - p.last_activity_at)::int) / 86400
        else business_days_between(p.last_activity_at::date, now()::date)
      end as days
    from proofs p
    where p.status = 'in_progress'
      and not exists (
        select 1 from proof_events pe
        join proof_versions pv on pv.id = pe.proof_version_id
        where pv.proof_id = p.id
          and pe.created_at >= now() - make_interval(days => (rule_sip->>'threshold_days')::int)
      )
      and not exists (
        select 1 from proof_version_views v
        join proof_versions pv on pv.id = v.proof_version_id
        where pv.proof_id = p.id
          and v.is_bot = false
          and v.viewed_at >= now() - make_interval(days => (rule_sip->>'threshold_days')::int)
      )
  ),
  flagged as (
    select rcnv.proof_id, 'request_changes_no_version'::text as rule_code,
      jsonb_build_object('days', rcnv.days) as rule_meta,
      (rule_rcnv->>'priority')::int as priority
    from rcnv
    where (rule_rcnv->>'enabled')::boolean
      and rcnv.days >= (rule_rcnv->>'threshold_days')::int

    union all
    select hs.proof_id, 'helpscout_follow_up_tag'::text,
      '{}'::jsonb,
      (rule_hs->>'priority')::int
    from hs
    where (rule_hs->>'enabled')::boolean

    union all
    select snv.proof_id, 'sent_never_viewed'::text,
      jsonb_build_object('days', snv.days),
      (rule_snv->>'priority')::int
    from snv
    where (rule_snv->>'enabled')::boolean
      and snv.days >= (rule_snv->>'threshold_days')::int

    union all
    select vna.proof_id, 'viewed_not_actioned'::text,
      jsonb_build_object('days', vna.days),
      (rule_vna->>'priority')::int
    from vna
    where (rule_vna->>'enabled')::boolean
      and vna.days >= (rule_vna->>'threshold_days')::int

    union all
    select ad.proof_id, 'approaching_dormant'::text,
      jsonb_build_object('days', ad.days),
      (rule_ad->>'priority')::int
    from ad
    where (rule_ad->>'enabled')::boolean

    union all
    select sip.proof_id, 'stuck_in_progress'::text,
      jsonb_build_object('days', sip.days),
      (rule_sip->>'priority')::int
    from sip
    where (rule_sip->>'enabled')::boolean
      and sip.days >= (rule_sip->>'threshold_days')::int
  )
  select distinct on (f.proof_id) f.proof_id, f.rule_code, f.rule_meta
  from flagged f
  -- Exclude proof+rule combinations with an active snooze.
  where not exists (
    select 1 from proof_attention_snoozes s
    where s.proof_id = f.proof_id
      and s.rule_code = f.rule_code
      and s.snoozed_until > now()
  )
  order by f.proof_id, f.priority asc, f.rule_code;
end;
$$;

comment on function proofs_needing_attention() is
  'Returns the highest-priority unfired needs-attention rule for each '
  'proof, excluding any (proof_id, rule_code) pair with an active '
  'snooze in proof_attention_snoozes. Updated by 000188 to include '
  'designer_override_approve in the request_changes_no_version and '
  'viewed_not_actioned event-type filters so a designer override '
  'clears those rules; body otherwise identical to 000164.';

commit;
