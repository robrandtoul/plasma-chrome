-- 000390: keep re-engagement outreach out of the organic conversion numbers.
--
-- The Reorder desk (000389) creates proofs for past customers WE approached.
-- An unsolicited outreach proof that (perfectly normally) never gets a
-- response is not a failed enquiry, and a tranche of them would drag the
-- funnel's approval rate down and muddy every number the team already trusts.
-- So the four funnel-family analytics functions exclude proofs carrying
-- reengagement_prospect_id; the Re-engagement tab (analytics_reengagement,
-- 000389) is where those proofs are counted, with their own honest funnel.
--
-- ⚠ Each function below is re-emitted from the LIVE pg_get_functiondef read on
-- 2026-08-09 (the 000363 house rule — live had no drift vs source at read
-- time), plus ONLY the reengagement guard. CREATE OR REPLACE preserves ACLs.
-- ⚠ Requires 000389 (the proofs.reengagement_prospect_id column) first.
--
-- Deliberately untouched: analytics_hot_leads (panel retired),
-- analytics_loss_reasons (proof_feedback is customer-initiated either way),
-- proofs_needing_attention (outreach proofs are kept out of the chase flags by
-- the desk's snoozes + auto_nudge_disabled_at, not by rewriting the engine),
-- and every operational surface (dashboard list/tiles) — an outreach proof a
-- customer engages with is real work and must stay visible.

-- 1. analytics_funnel ---------------------------------------------------------

create or replace function proofs.analytics_funnel()
returns json
language sql
stable
set search_path to 'proofs', 'public', 'extensions', 'pg_temp'
as $function$
  with pop as (
    -- Organic population: everything except re-engagement outreach (000390).
    select * from proofs where reengagement_prospect_id is null
  ),
  nb as (
    select distinct pv.proof_id from proof_versions pv
    join pop on pop.id = pv.proof_id
    join proof_version_views vv on vv.proof_version_id = pv.id and vv.is_bot = false
  ),
  dec as (
    select distinct pv.proof_id from proof_versions pv
    join pop on pop.id = pv.proof_id
    join proof_events e on e.proof_version_id = pv.id
    where e.event_type in ('approve', 'request_changes', 'designer_override_approve')
  ),
  cr as (
    select distinct pv.proof_id from proof_events e
    join proof_versions pv on pv.id = e.proof_version_id
    join pop on pop.id = pv.proof_id
    where e.event_type = 'request_changes'
  ),
  ord_sent as (select distinct o.proof_id from orders o join pop on pop.id = o.proof_id where o.sent_at is not null),
  ord_paid as (select distinct o.proof_id from orders o join pop on pop.id = o.proof_id where o.status in ('paid', 'fulfilled') or o.paid_at is not null)
  select json_build_object(
    'total_proofs', (select count(*) from pop),
    'viewed', (select count(*) from nb),
    'decided', (select count(*) from dec),
    'approved', (select count(*) from pop where status = 'approved'),
    'abandoned', (select count(*) from pop where status = 'abandoned'),
    'in_progress', (select count(*) from pop where status = 'in_progress'),
    'dormant', (select count(*) from pop where status = 'dormant'),
    'order_sent', (select count(*) from ord_sent),
    'order_paid', (select count(*) from ord_paid),
    'viewed_no_decision', (select count(*) from nb where proof_id not in (select proof_id from dec)),
    'median_days_to_approve', (
      select round((percentile_cont(0.5) within group (
        order by extract(epoch from (approved_at - created_at)) / 86400))::numeric, 2)
      from pop where status = 'approved' and approved_at is not null
    ),
    'returning_n', (select count(*) from pop where helpscout_tags @> array['repeat customer']::text[]),
    'returning_approved', (select count(*) from pop where helpscout_tags @> array['repeat customer']::text[] and status = 'approved'),
    'new_n', (select count(*) from pop where not coalesce(helpscout_tags @> array['repeat customer']::text[], false)),
    'new_approved', (select count(*) from pop where not coalesce(helpscout_tags @> array['repeat customer']::text[], false) and status = 'approved'),
    'cr_proofs', (select count(*) from cr),
    'cr_recovered', (select count(*) from cr join pop p2 on p2.id = cr.proof_id where p2.status = 'approved'),
    'payment_mode', (select payment_mode from settings limit 1)
  );
$function$;

-- 2. analytics_weekly ---------------------------------------------------------

create or replace function proofs.analytics_weekly()
returns table(week_start date, enquiries integer, viewed integer, approved integer, abandoned integer, in_progress integer, paid integer, approve_pct numeric, mature boolean)
language sql
stable
set search_path to 'proofs', 'public', 'extensions', 'pg_temp'
as $function$
  with base as (
    select
      p.id,
      p.status,
      date_trunc('week', p.created_at)::date as wk,
      exists (
        select 1 from proof_versions pv
        join proof_version_views vv on vv.proof_version_id = pv.id and vv.is_bot = false
        where pv.proof_id = p.id
      ) as viewed,
      exists (
        select 1 from orders o
        where o.proof_id = p.id and (o.status in ('paid', 'fulfilled') or o.paid_at is not null)
      ) as paid
    from proofs p
    -- 000390: outreach proofs are counted on the Re-engagement tab instead.
    where p.reengagement_prospect_id is null
  )
  select
    wk,
    count(*)::int,
    count(*) filter (where viewed)::int,
    count(*) filter (where status = 'approved')::int,
    count(*) filter (where status = 'abandoned')::int,
    count(*) filter (where status = 'in_progress')::int,
    count(*) filter (where paid)::int,
    round(100.0 * count(*) filter (where status = 'approved') / count(*), 1),
    (wk <= (now()::date - 7))
  from base
  group by wk
  order by wk;
$function$;

-- 3. analytics_by_segment -----------------------------------------------------

create or replace function proofs.analytics_by_segment(p_dimension text)
returns table(label text, n integer, approved integer, abandoned integer, approve_pct numeric)
language sql
stable
set search_path to 'proofs', 'public', 'extensions', 'pg_temp'
as $function$
  with cur as (
    select pv.proof_id, pv.currency, pv.shape, pv.material_id, pv.names
    from proof_versions pv where pv.is_current
  ),
  base as (
    select p.status,
      case p_dimension
        when 'currency' then coalesce(cur.currency::text, '(none)')
        when 'shape' then coalesce(cur.shape, '(unset)')
        when 'material' then coalesce(m.display_name, '(per-direction)')
        when 'returning' then (case when p.helpscout_tags @> array['repeat customer']::text[] then 'Returning customer' else 'New customer' end)
        when 'recipients' then (
          case
            when coalesce(array_length(cur.names, 1), 0) = 0 then 'Set / single'
            when array_length(cur.names, 1) = 1 then '1 name'
            when array_length(cur.names, 1) between 2 and 5 then '2-5 names'
            else '6+ names'
          end
        )
        else '(all)'
      end as label
    from proofs p
    join cur on cur.proof_id = p.id
    left join materials m on m.id = cur.material_id
    -- 000390: outreach proofs are counted on the Re-engagement tab instead.
    where p.reengagement_prospect_id is null
  )
  select label, count(*)::int,
    count(*) filter (where status = 'approved')::int,
    count(*) filter (where status = 'abandoned')::int,
    round(100.0 * count(*) filter (where status = 'approved') / count(*), 1)
  from base group by label order by count(*) desc;
$function$;

-- 4. analytics_by_designer ----------------------------------------------------

create or replace function proofs.analytics_by_designer()
returns table(designer_user_id uuid, designer_name text, designer_initials text, designer_colour text, proofs_all integer, approved_all integer, abandoned_all integer, open_now integer, returning_share_pct numeric, new_mature_n integer, new_mature_approved integer, new_mature_pct numeric, cr_n integer, cr_recovered integer, cr_recovery_pct numeric, avg_days_to_approve numeric)
language sql
stable
set search_path to 'proofs', 'public', 'extensions', 'pg_temp'
as $function$
  with cur as (select pv.proof_id, pv.created_by from proof_versions pv where pv.is_current),
  cr as (
    select distinct pv.proof_id from proof_events e
    join proof_versions pv on pv.id = e.proof_version_id where e.event_type = 'request_changes'
  ),
  base as (
    select p.id, p.status, p.created_at as proof_created_at, p.approved_at, cur.created_by,
      (p.created_at <= now() - interval '7 days') as mature,
      not coalesce(p.helpscout_tags @> array['repeat customer']::text[], false) as is_new,
      (p.id in (select proof_id from cr)) as had_change_req
    from proofs p join cur on cur.proof_id = p.id
    -- 000390: outreach proofs are counted on the Re-engagement tab instead —
    -- a designer working the desk must not look worse for doing so.
    where p.reengagement_prospect_id is null
  )
  select b.created_by, pr.full_name, pr.designer_initials, pr.designer_colour,
    count(*)::int,
    count(*) filter (where b.status = 'approved')::int,
    count(*) filter (where b.status = 'abandoned')::int,
    count(*) filter (where b.status = 'in_progress')::int,
    round(100.0 * count(*) filter (where not b.is_new) / count(*), 0),
    count(*) filter (where b.is_new and b.mature)::int,
    count(*) filter (where b.is_new and b.mature and b.status = 'approved')::int,
    round(100.0 * count(*) filter (where b.is_new and b.mature and b.status = 'approved')
          / nullif(count(*) filter (where b.is_new and b.mature), 0), 0),
    count(*) filter (where b.had_change_req)::int,
    count(*) filter (where b.had_change_req and b.status = 'approved')::int,
    round(100.0 * count(*) filter (where b.had_change_req and b.status = 'approved')
          / nullif(count(*) filter (where b.had_change_req), 0), 0),
    round((avg(extract(epoch from (b.approved_at - b.proof_created_at)) / 86400)
      filter (where b.status = 'approved' and b.approved_at is not null))::numeric, 1)
  from base b left join profiles pr on pr.id = b.created_by
  group by b.created_by, pr.full_name, pr.designer_initials, pr.designer_colour
  order by count(*) desc;
$function$;
