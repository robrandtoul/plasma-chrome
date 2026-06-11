-- 000217 — needs-attention rule: customer approved an earlier version.
--
-- A customer can step back to a superseded version in the customer-page
-- selector and approve it (after ticking the earlier-version
-- acknowledgement). That approval lands on a NON-current version and never
-- finalizes the proof — the current version stays unapproved, so the proof
-- sits in_progress and the sign-off is invisible on the dashboard. The
-- detail page already surfaces this (see ProofDetailPage banner); this
-- migration adds the matching dashboard signal as a needs-attention rule so
-- the proof lands in the "Needs attention" tile + reason chip rather than
-- quietly looking like nothing happened.
--
-- Detection mirrors the detail-page banner exactly:
--   * an `approved` proof_name_approvals row exists on a version that is NOT
--     the proof's current version, AND
--   * that recipient name is NOT approved on the current version (so a
--     carry-forward / re-approval is correctly excluded), AND
--   * the proof is neither approved nor abandoned.
--
-- No threshold: the mismatch is actionable the moment it exists (and the
-- name-not-on-current guard already absorbs the carry-forward window). Not a
-- customer-chase rule, so the 000208 Help Scout reply grace window does not
-- suppress it — a staff/customer reply doesn't resolve the version mismatch.
-- Snoozeable like every other rule (the snooze guard keys on (proof_id,
-- rule_code) and applies to all flagged rows).
--
-- rule_meta carries the highest stranded version number as { "version": N }
-- for future chip copy; today's frontend renders a fixed reason string and
-- ignores it.
--
-- CREATE OR REPLACE preserves the 000182 grants + search_path. No view or
-- tile-count DDL: public_dashboard_projects sources rule_code from this
-- function, and dashboard_tile_counts() counts `rule_code is not null` off
-- that view, so both pick the new rule up automatically.

create or replace function proofs.proofs_needing_attention()
 returns table(proof_id uuid, rule_code text, rule_meta jsonb)
 language plpgsql
 stable
 set search_path to 'proofs', 'public', 'extensions', 'pg_temp'
as $function$
declare
  rules jsonb;
  rule_rcnv jsonb;
  rule_hs   jsonb;
  rule_snv  jsonb;
  rule_vna  jsonb;
  rule_ad   jsonb;
  rule_sip  jsonb;
  rule_aev  jsonb;
  grace_days int;
  dormancy_cutoff int;
begin
  select s.needs_attention_rules, coalesce(s.dormancy_threshold_days, 90)
    into rules, dormancy_cutoff
    from site_settings s where s.id = 1;

  rule_rcnv := rules->'request_changes_no_version';
  rule_hs   := rules->'helpscout_follow_up_tag';
  rule_snv  := rules->'sent_never_viewed';
  rule_vna  := rules->'viewed_not_actioned';
  rule_ad   := rules->'approaching_dormant';
  rule_sip  := rules->'stuck_in_progress';
  rule_aev  := rules->'approved_earlier_version';
  -- Grace window: a recent Help Scout reply (staff or customer) suppresses the
  -- chase rules for this many days. Defaults to 3 when the key is absent.
  grace_days := coalesce((rules->>'helpscout_reply_grace_days')::int, 3);

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
  -- last_activity_at is in the (cutoff - threshold, cutoff) days-ago band,
  -- where cutoff = site_settings.dormancy_threshold_days (000209). Gives a
  -- window to ping the customer before the auto-dormant cron flips it.
  ad as (
    select p.id as proof_id,
      (extract(epoch from now() - p.last_activity_at)::int) / 86400 as days
    from proofs p
    where p.status not in ('approved', 'abandoned')
      and p.last_activity_at <= now() - make_interval(days => (dormancy_cutoff - (rule_ad->>'threshold_days')::int))
      and p.last_activity_at >= now() - make_interval(days => dormancy_cutoff)
  ),
  -- Rule 6: stuck in progress - in_progress with no event or view in
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
  -- Rule 7 (000217): customer approved a non-current version while the
  -- current version is still unapproved by that recipient. No threshold.
  aev as (
    select cv.proof_id,
      max(old_pv.version_number) as approved_version
    from current_versions cv
    join proofs p on p.id = cv.proof_id
    join proof_versions old_pv
      on old_pv.proof_id = cv.proof_id
     and old_pv.id <> cv.version_id
    join proof_name_approvals a
      on a.proof_version_id = old_pv.id
     and a.state = 'approved'
    where p.status not in ('approved', 'abandoned')
      and not exists (
        select 1 from proof_name_approvals ca
        where ca.proof_version_id = cv.version_id
          and ca.state = 'approved'
          and ca.name = a.name
      )
    group by cv.proof_id
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

    -- 000217: approved-earlier-version. No threshold; rule_meta carries the
    -- stranded version number for future chip copy.
    union all
    select aev.proof_id, 'approved_earlier_version'::text,
      jsonb_build_object('version', aev.approved_version),
      (rule_aev->>'priority')::int
    from aev
    where (rule_aev->>'enabled')::boolean
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
  -- 000208: suppress the four customer-chase rules when there has been a recent
  -- Help Scout reply (staff or customer) on the linked conversation. Leaves
  -- request_changes_no_version (owe a version), helpscout_follow_up_tag and
  -- approved_earlier_version alone — none of those are resolved by a reply.
  and not (
    f.rule_code in ('sent_never_viewed', 'viewed_not_actioned', 'approaching_dormant', 'stuck_in_progress')
    and exists (
      select 1 from proofs p
      where p.id = f.proof_id
        and greatest(p.helpscout_last_reply_at, p.helpscout_last_customer_reply_at)
            >= now() - make_interval(days => grace_days)
    )
  )
  order by f.proof_id, f.priority asc, f.rule_code;
end;
$function$;

-- Seed the rule into the live needs_attention_rules document. Enabled by
-- default; priority 2 (a direct customer action, just below
-- request_changes_no_version at 1). Shares the ordinal with the *disabled*
-- helpscout_follow_up_tag rule — harmless: disabled rules never enter the
-- flagged set, and if that rule is ever enabled the engine's
-- `order by priority asc, rule_code` tiebreak picks 'approved_earlier_version'
-- first (alphabetical), which is the precedence we want anyway. No threshold
-- or calendar keys — this rule has neither. Idempotent: only writes when the
-- key is absent, so a re-run (or a later admin edit) is preserved.
update proofs.site_settings
set needs_attention_rules = jsonb_set(
  needs_attention_rules,
  '{approved_earlier_version}',
  '{"enabled": true, "priority": 2}'::jsonb,
  true
)
where id = 1
  and not (needs_attention_rules ? 'approved_earlier_version');
