-- 000246_needs_attention_human_only_follow_up_tile.sql
--
-- Make "Needs attention" mean "needs a human", and add an "In follow-up"
-- view of the proofs the automation is actively chasing.
--
-- Background: the two customer-chase rules (sent_never_viewed,
-- viewed_not_actioned) are now auto-send (000244). While the automation is
-- still working through its reminders, those proofs don't need a person —
-- yet they were filling the Needs-attention tile. This splits them out.
--
-- Four changes, all schema-qualified for the live `proofs` schema:
--
-- 1. proofs_in_follow_up() — the single source of truth for "this proof is
--    currently in the automated follow-up loop". A proof+rule is in-flight
--    when, on the CURRENT version, at least one reminder has been sent
--    (manual or auto — a sent reminder guarantees send-evidence, so the
--    automation will keep going), the per-version reminder cap is NOT yet
--    spent, and the rule is in auto mode. Keyed off the nudge ledger (what
--    actually happened), so the "hide from attention" set and the "show in
--    follow-up" set are provably identical and nothing falls through:
--      * never-sent / no-send-evidence  -> not in-flight -> stays in attention
--      * cap spent (exhausted)          -> not in-flight -> nudges_exhausted
--      * rule switched to review mode    -> not in-flight -> stays in attention
--
-- 2. proofs_needing_attention() — suppress sent_never_viewed /
--    viewed_not_actioned for proofs that are in-flight (per proofs_in_follow_up).
--    Everything else (exhaustion via nudges_exhausted, grace, snooze, the
--    one-chip collapse) is byte-for-byte the live 000221/000217 body.
--
-- 3. public_dashboard_projects — expose follow_up_rule_code /
--    follow_up_sent_count / follow_up_max_nudges / follow_up_last_sent_at so
--    the dashboard can count the tile, filter the list, render the row pill
--    and show "Reminder N of M". Appended columns only (CREATE OR REPLACE
--    VIEW keeps grants + security_invoker + the dashboard_list SETOF type).
--
-- 4. dashboard_tile_counts() — add the in_follow_up count, and exclude
--    in-flight proofs from not_viewed / awaiting_customer so In follow-up is
--    its own bucket (no double-listing — same partitioning discipline as
--    000245's awaiting/responded split). needs_attention is unchanged: it
--    reads rule_code, which now already excludes in-flight chases.

begin;

-- 1. ───────────────────────────────────────────────────────────────────────
create or replace function proofs.proofs_in_follow_up()
returns table(proof_id uuid, rule_code text, sent_count int, max_nudges int, last_sent_at timestamptz)
language sql
stable
set search_path = proofs, public, extensions, pg_temp
as $$
  with automation as (
    select coalesce(
      (select needs_attention_rules->'automation' from site_settings where id = 1),
      '{}'::jsonb
    ) as a
  ),
  current_versions as (
    select pv.proof_id, pv.id as version_id
    from proof_versions pv
    join proofs p on p.id = pv.proof_id
    where pv.is_current and p.status = 'in_progress'
  ),
  -- Reminder usage on the CURRENT version, per chase rule. A row counts for
  -- the cap when state is 'sending'/'sent', any source — manual reminders
  -- spend the cap too (matches nudges_exhausted in proofs_needing_attention).
  nudge_usage as (
    select n.proof_id, n.rule_code,
      count(*) filter (where n.state in ('sending','sent'))::int as sent_count,
      max(n.created_at) filter (where n.state in ('sending','sent')) as last_sent_at
    from proof_nudges n
    join current_versions cv
      on cv.proof_id = n.proof_id and cv.version_id = n.proof_version_id
    where n.rule_code in ('sent_never_viewed','viewed_not_actioned')
    group by n.proof_id, n.rule_code
  ),
  enriched as (
    select u.*,
      coalesce((select (a->u.rule_code->>'max_nudges')::int from automation), 2) as max_nudges,
      coalesce((select (a->u.rule_code->>'mode') from automation), 'review') as mode
    from nudge_usage u
  )
  -- One row per proof: the chase rule with the most recent reminder wins
  -- (a proof is only ever chased under one rule at a time).
  select distinct on (e.proof_id)
    e.proof_id, e.rule_code, e.sent_count, e.max_nudges, e.last_sent_at
  from enriched e
  where e.sent_count >= 1
    and e.sent_count < e.max_nudges
    and e.mode = 'auto'
  order by e.proof_id, e.last_sent_at desc nulls last;
$$;

revoke execute on function proofs.proofs_in_follow_up() from anon, public;
grant execute on function proofs.proofs_in_follow_up() to authenticated;

-- 2. ───────────────────────────────────────────────────────────────────────
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
  rule_nex  jsonb;
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
  -- 000246: proofs the automation is actively chasing right now. Their
  -- chase rule is the automation's job, not a human's, so it is removed from
  -- the attention set below.
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
    -- 000246: a chase rule the automation is still working is not a human
    -- task, so drop it from attention while in-flight. Exhausted chases keep
    -- firing here (they are not in-flight) and surface as nudges_exhausted.
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

-- 3. ───────────────────────────────────────────────────────────────────────
-- Append the four follow_up_* columns. CREATE OR REPLACE VIEW keeps the
-- existing grants, security_invoker, and the dashboard_list() SETOF type.
create or replace view proofs.public_dashboard_projects as
 WITH current_versions AS (
         SELECT DISTINCT ON (pv.proof_id) pv.proof_id,
            pv.id AS version_id,
            pv.version_number,
            pv.material_display,
            pv.created_at AS version_created_at,
            pv.created_by AS designer_user_id
           FROM proofs.proof_versions pv
          WHERE pv.is_current
          ORDER BY pv.proof_id, pv.version_number DESC
        ), latest_events AS (
         SELECT DISTINCT ON (e.proof_id) e.proof_id,
            e.created_at AS latest_event_at,
            e.event_type AS latest_event_type,
            e.actor_name AS latest_event_actor
           FROM proofs.dashboard_latest_events e
          ORDER BY e.proof_id, e.created_at DESC
        ), latest_non_view_events AS (
         SELECT DISTINCT ON (e.proof_id) e.proof_id,
            e.created_at AS latest_non_view_event_at,
            e.event_type AS latest_non_view_event_type
           FROM proofs.dashboard_latest_events e
          WHERE e.event_type <> 'view'::text
          ORDER BY e.proof_id, e.created_at DESC
        ), current_view_state AS (
         SELECT DISTINCT ON (cv_1.proof_id) cv_1.proof_id,
            v.viewed_at AS current_version_viewed_at
           FROM proofs.proof_versions cv_1
             JOIN proofs.proof_version_views v ON v.proof_version_id = cv_1.id
          WHERE cv_1.is_current AND v.is_bot = false
          ORDER BY cv_1.proof_id, v.viewed_at DESC
        ), na AS (
         SELECT proofs_needing_attention.proof_id,
            proofs_needing_attention.rule_code,
            proofs_needing_attention.rule_meta
           FROM proofs.proofs_needing_attention() proofs_needing_attention(proof_id, rule_code, rule_meta)
        ), fu AS (
         SELECT proofs_in_follow_up.proof_id,
            proofs_in_follow_up.rule_code,
            proofs_in_follow_up.sent_count,
            proofs_in_follow_up.max_nudges,
            proofs_in_follow_up.last_sent_at
           FROM proofs.proofs_in_follow_up() proofs_in_follow_up(proof_id, rule_code, sent_count, max_nudges, last_sent_at)
        )
 SELECT p.id AS proof_id,
    p.created_at,
    p.last_activity_at,
    p.status,
    p.approved_at,
    p.abandoned_at,
    p.disclaimer_acknowledged_at,
    p.helpscout_conversation_url,
    p.helpscout_conversation_id,
    c.id AS contact_id,
    c.full_name AS contact_name,
    c.email AS contact_email,
    co.id AS company_id,
    co.name AS company_name,
    cv.version_id AS current_version_id,
    cv.version_number AS current_version_number,
    cv.material_display,
    cv.version_created_at,
    cv.designer_user_id,
    pr.full_name AS designer_name,
    pr.designer_initials,
    pr.designer_colour,
    pr.avatar_url AS designer_avatar_url,
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
    lne.latest_non_view_event_at,
    lne.latest_non_view_event_type,
    p.helpscout_last_reply_at,
    p.helpscout_last_customer_reply_at,
    fu.rule_code AS follow_up_rule_code,
    fu.sent_count AS follow_up_sent_count,
    fu.max_nudges AS follow_up_max_nudges,
    fu.last_sent_at AS follow_up_last_sent_at
   FROM proofs.proofs p
     LEFT JOIN proofs.contacts c ON c.id = p.contact_id
     LEFT JOIN proofs.companies co ON co.id = c.company_id
     LEFT JOIN current_versions cv ON cv.proof_id = p.id
     LEFT JOIN proofs.profiles pr ON pr.id = cv.designer_user_id
     LEFT JOIN latest_events le ON le.proof_id = p.id
     LEFT JOIN latest_non_view_events lne ON lne.proof_id = p.id
     LEFT JOIN current_view_state cvs ON cvs.proof_id = p.id
     LEFT JOIN na ON na.proof_id = p.id
     LEFT JOIN fu ON fu.proof_id = p.id
     LEFT JOIN LATERAL ( SELECT s.rule_code AS snooze_rule_code,
            s.snoozed_until,
            s.note AS snooze_note,
            pr2.full_name AS snoozed_by_name,
            pr2.designer_initials AS snoozed_by_initials,
            pr2.designer_colour AS snoozed_by_colour
           FROM proofs.proof_attention_snoozes s
             LEFT JOIN proofs.profiles pr2 ON pr2.id = s.snoozed_by
          WHERE s.proof_id = p.id AND s.snoozed_until > (now() - '24:00:00'::interval)
          ORDER BY s.snoozed_until DESC
         LIMIT 1) snz ON true;

-- 4. ───────────────────────────────────────────────────────────────────────
create or replace function proofs.dashboard_tile_counts()
returns json
language sql
security invoker
set search_path = proofs, public, extensions, pg_temp
as $$
  with p as (
    select
      d.*,
      exists (
        select 1 from proof_attention_snoozes s
        where s.proof_id = d.proof_id and s.snoozed_until > now()
      ) as snoozed
    from public_dashboard_projects d
  )
  select json_build_object(
    'needs_attention', (
      select count(*) from p
      where rule_code is not null and not snoozed
    ),
    'not_viewed', (
      select count(*) from p
      where rule_code is null and not snoozed
        and follow_up_rule_code is null
        and status in ('in_progress', 'dormant')
        and current_version_id is not null
        and current_version_viewed_at is null
    ),
    'awaiting_customer', (
      select count(*) from p
      where rule_code is null and not snoozed
        and follow_up_rule_code is null
        and status = 'in_progress'
        and current_version_id is not null
        and current_version_viewed_at is not null
        and not (
          (
            latest_non_view_event_type = 'request_changes'
            and latest_non_view_event_at is not null
            and version_created_at is not null
            and latest_non_view_event_at > version_created_at
          )
          or (
            helpscout_last_customer_reply_at is not null
            and helpscout_last_customer_reply_at > coalesce(helpscout_last_reply_at, 'epoch'::timestamptz)
            and (version_created_at is null or helpscout_last_customer_reply_at > version_created_at)
          )
        )
    ),
    'in_follow_up', (
      select count(*) from p
      where not snoozed
        and follow_up_rule_code is not null
        and status = 'in_progress'
        -- A customer who has responded needs a human, so they belong to the
        -- Customer responded tile even though a chase is on the clock.
        and not (
          (
            latest_non_view_event_type = 'request_changes'
            and latest_non_view_event_at is not null
            and version_created_at is not null
            and latest_non_view_event_at > version_created_at
          )
          or (
            helpscout_last_customer_reply_at is not null
            and helpscout_last_customer_reply_at > coalesce(helpscout_last_reply_at, 'epoch'::timestamptz)
            and (version_created_at is null or helpscout_last_customer_reply_at > version_created_at)
          )
        )
    ),
    'customer_responded', (
      select count(*) from p
      where rule_code is null and not snoozed
        and status = 'in_progress'
        and (
          (
            latest_non_view_event_type = 'request_changes'
            and latest_non_view_event_at is not null
            and version_created_at is not null
            and latest_non_view_event_at > version_created_at
          )
          or (
            helpscout_last_customer_reply_at is not null
            and helpscout_last_customer_reply_at > coalesce(helpscout_last_reply_at, 'epoch'::timestamptz)
            and (version_created_at is null or helpscout_last_customer_reply_at > version_created_at)
          )
        )
    ),
    'dormant', (
      select count(*) from p
      where not snoozed and status = 'dormant'
    ),
    'approved_this_week', (
      select count(*) from p
      where not snoozed
        and status = 'approved'
        and approved_at is not null
        and approved_at >= now() - interval '7 days'
    )
  );
$$;

revoke execute on function proofs.dashboard_tile_counts() from anon, public;
grant execute on function proofs.dashboard_tile_counts() to authenticated;

commit;
