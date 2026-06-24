-- 000261: approved_no_order needs-attention rule counts a 'revision' order as
-- "an order is in flight".
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via the dashboard SQL editor / an MCP apply_migration. Do NOT
-- use `supabase db push`.
--
-- Follow-up to 000260 (order revision status). The approved_no_order rule flags
-- an approved proof that has had no order link sent. Its "an order exists"
-- guard counted statuses (sent, paid, fulfilled) but not the new 'revision'
-- (000260). On the revision happy path the proof is RE-APPROVED while its paid
-- order is still parked in 'revision' (not yet re-placed), so the rule would
-- spuriously fire "approved — no order link sent" for an order that is paid and
-- mid-revision. Adding 'revision' to the guard keeps the rule quiet for those.
--
-- The rule ships DISABLED today, so this is a correctness fix ahead of its
-- go-live, not a live behaviour change.
--
-- Body is a verbatim CREATE OR REPLACE of the live function (captured via
-- pg_get_functiondef) with the SINGLE change being the orders.status list in the
-- `ano` CTE. CREATE OR REPLACE preserves grants + the pinned search_path.

CREATE OR REPLACE FUNCTION proofs.proofs_needing_attention()
 RETURNS TABLE(proof_id uuid, rule_code text, rule_meta jsonb)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'proofs', 'public', 'extensions', 'pg_temp'
AS $function$
declare
  rules jsonb;
  rule_rcnv jsonb;
  rule_hs   jsonb;
  rule_snv  jsonb;
  rule_vna  jsonb;
  rule_ad   jsonb;
  rule_sip  jsonb;
  rule_aev  jsonb;
  rule_nex  jsonb;
  rule_ano  jsonb;
  automation jsonb;
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
  rule_nex  := rules->'nudges_exhausted';
  rule_ano  := rules->'approved_no_order';
  automation := coalesce(rules->'automation', '{}'::jsonb);
  grace_days := coalesce((rules->>'helpscout_reply_grace_days')::int, 3);

  return query
  with current_versions as (
    select pv.proof_id, pv.id as version_id, pv.created_at
    from proof_versions pv
    where pv.is_current
  ),
  rcnv_evt as (
    select cv.proof_id, cv.created_at as version_created_at, e.created_at as event_at
    from current_versions cv
    join proofs p on p.id = cv.proof_id
    join lateral (
      select pe.created_at, pe.event_type
      from proof_events pe
      where pe.proof_version_id = cv.version_id
        and pe.event_type in ('approve', 'request_changes', 'designer_override_approve')
      order by pe.created_at desc
      limit 1
    ) e on true
    where p.status not in ('approved', 'abandoned')
      and e.event_type = 'request_changes'
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
  hs as (
    select p.id as proof_id
    from proofs p
    where p.helpscout_conversation_id is not null
      and p.helpscout_tags @> array['follow up']::text[]
  ),
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
  ad as (
    select p.id as proof_id,
      (extract(epoch from now() - p.last_activity_at)::int) / 86400 as days
    from proofs p
    where p.status not in ('approved', 'abandoned')
      and p.last_activity_at <= now() - make_interval(days => (dormancy_cutoff - (rule_ad->>'threshold_days')::int))
      and p.last_activity_at >= now() - make_interval(days => dormancy_cutoff)
  ),
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
  ano as (
    select p.id as proof_id,
      case when (rule_ano->>'calendar')::boolean
        then (extract(epoch from now() - p.approved_at)::int) / 86400
        else business_days_between(p.approved_at::date, now()::date)
      end as days
    from proofs p
    where p.status = 'approved'
      and p.approved_at is not null
      and not exists (
        select 1 from orders o
        where o.proof_id = p.id
          and o.status in ('sent', 'paid', 'fulfilled', 'revision')
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

    union all
    select aev.proof_id, 'approved_earlier_version'::text,
      jsonb_build_object('version', aev.approved_version),
      (rule_aev->>'priority')::int
    from aev
    where coalesce((rule_aev->>'enabled')::boolean, false)

    union all
    select ano.proof_id, 'approved_no_order'::text,
      jsonb_build_object('days', ano.days),
      (rule_ano->>'priority')::int
    from ano
    where coalesce((rule_ano->>'enabled')::boolean, false)
      and ano.days >= (rule_ano->>'threshold_days')::int
  ),
  cap_counts as (
    select n.proof_id, n.rule_code, count(*)::int as sent_count
    from proof_nudges n
    join current_versions cv
      on cv.proof_id = n.proof_id and cv.version_id = n.proof_version_id
    where n.state in ('sending', 'sent')
    group by n.proof_id, n.rule_code
  ),
  exhausted as (
    select distinct on (f.proof_id)
      f.proof_id,
      'nudges_exhausted'::text as rule_code,
      jsonb_build_object(
        'rule', f.rule_code,
        'sent', cc.sent_count,
        'no_contact', (
          not exists (
            select 1 from proof_version_views v
            join proof_versions pv on pv.id = v.proof_version_id
            where pv.proof_id = f.proof_id and v.is_bot = false
          )
          and exists (
            select 1 from proofs p
            where p.id = f.proof_id and p.helpscout_last_customer_reply_at is null
          )
        )
      ) as rule_meta,
      (rule_nex->>'priority')::int as priority
    from flagged f
    join cap_counts cc
      on cc.proof_id = f.proof_id and cc.rule_code = f.rule_code
    where coalesce((rule_nex->>'enabled')::boolean, false)
      and f.rule_code in ('sent_never_viewed', 'viewed_not_actioned',
                          'approaching_dormant', 'stuck_in_progress')
      and cc.sent_count >= coalesce((automation->f.rule_code->>'max_nudges')::int, 2)
    order by f.proof_id, cc.sent_count desc, f.rule_code
  ),
  follow_up as (
    select i.proof_id, i.rule_code
    from proofs_in_follow_up() i
  ),
  all_flagged as (
    select * from flagged
    union all
    select * from exhausted
  ),
  filtered as (
    select f.proof_id, f.rule_code, f.rule_meta, f.priority
    from all_flagged f
    where not exists (
      select 1 from proof_attention_snoozes s
      where s.proof_id = f.proof_id
        and s.rule_code = f.rule_code
        and s.snoozed_until > now()
    )
    and not (
      f.rule_code in ('sent_never_viewed', 'viewed_not_actioned', 'approaching_dormant',
                      'stuck_in_progress', 'nudges_exhausted')
      and exists (
        select 1 from proofs p
        where p.id = f.proof_id
          and greatest(p.helpscout_last_reply_at, p.helpscout_last_customer_reply_at)
              >= now() - make_interval(days => grace_days)
      )
    )
    and not (
      f.rule_code in ('sent_never_viewed', 'viewed_not_actioned')
      and exists (
        select 1 from follow_up fu
        where fu.proof_id = f.proof_id and fu.rule_code = f.rule_code
      )
    )
  ),
  ranked as (
    select f.proof_id, f.rule_code, f.rule_meta, f.priority,
      row_number() over (
        partition by f.proof_id
        order by f.priority asc, f.rule_code
      ) as rn,
      array_agg(f.rule_code) over (
        partition by f.proof_id
        order by f.priority asc, f.rule_code
        rows between unbounded preceding and unbounded following
      ) as all_codes
    from filtered f
  )
  select r.proof_id,
    r.rule_code,
    case when array_length(array_remove(r.all_codes, r.rule_code), 1) > 0
      then r.rule_meta
        || jsonb_build_object('others', to_jsonb(array_remove(r.all_codes, r.rule_code)))
      else r.rule_meta
    end as rule_meta
  from ranked r
  where r.rn = 1;
end;
$function$;
