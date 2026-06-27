-- 000277_analytics_followups.sql
--
-- Follow-ups to the 000276 analytics functions, driven by the designer-disparity
-- deep-dive (see memory:conversion-analytics-baseline):
--   1. analytics_hot_leads()    — add designer_user_id (so the dashboard card can
--      filter to "mine") and is_returning (durable `repeat customer` tag).
--   2. analytics_by_designer()  — rebuilt as a FAIR scorecard, not a raw league
--      table: new-customer conversion (maturity-controlled), change-request
--      recovery rate, returning share, and the open-queue workload.
--   3. analytics_funnel()       — add returning-vs-new + change-request recovery.
--   4. analytics_by_segment()   — add a 'returning' dimension.
--
-- Tag rule baked in everywhere: the ONLY tag safe for conversion analysis is the
-- durable `repeat customer`. Lifecycle tags (priority 1/2/3, ready to order,
-- shipped, sanity check ok, artwork request, material tags) are added/stripped by
-- the approval workflow and correlate spuriously with conversion — never segment
-- on them; use structured fields (material_id, currency, shape) instead.

-- ── 1. analytics_hot_leads() — add designer_user_id + is_returning ───────────
drop function if exists proofs.analytics_hot_leads();
create function proofs.analytics_hot_leads()
returns table (
  proof_id uuid,
  company_name text,
  contact_name text,
  contact_email text,
  designer_user_id uuid,
  designer_name text,
  designer_initials text,
  designer_colour text,
  current_version_number int,
  view_count int,
  last_viewed_at timestamptz,
  created_at timestamptz,
  age_days numeric,
  days_since_view numeric,
  nudges_sent int,
  reengaged boolean,
  is_returning boolean,
  helpscout_conversation_url text,
  tier text
)
language sql
stable
security invoker
set search_path to 'proofs', 'public', 'extensions', 'pg_temp'
as $$
  with d as (
    select *
    from public_dashboard_projects
    where status = 'in_progress'
      and current_version_id is not null
      and current_version_viewed_at is not null
  ),
  vc as (
    select
      pv.proof_id,
      count(vv.id) filter (where vv.is_bot = false) as views,
      max(vv.viewed_at) filter (where vv.is_bot = false) as last_view
    from proof_versions pv
    left join proof_version_views vv on vv.proof_version_id = pv.id
    where pv.is_current
    group by pv.proof_id
  ),
  decided_cur as (
    select distinct pv.proof_id
    from proof_versions pv
    join proof_events e on e.proof_version_id = pv.id
    where pv.is_current
      and e.event_type in ('approve', 'request_changes', 'designer_override_approve')
  ),
  nud as (
    select
      proof_id,
      count(*) filter (where state = 'sent') as sent_n,
      max(created_at) filter (where state = 'sent') as last_nudge_at
    from proof_nudges
    group by proof_id
  )
  select
    d.proof_id,
    d.company_name,
    d.contact_name,
    d.contact_email,
    d.designer_user_id,
    d.designer_name,
    d.designer_initials,
    d.designer_colour,
    d.current_version_number,
    coalesce(vc.views, 0)::int,
    vc.last_view,
    d.created_at,
    round(extract(epoch from (now() - d.created_at)) / 86400, 1),
    round(extract(epoch from (now() - vc.last_view)) / 86400, 1),
    coalesce(nud.sent_n, 0)::int,
    (nud.last_nudge_at is not null and vc.last_view > nud.last_nudge_at),
    coalesce(p.helpscout_tags @> array['repeat customer']::text[], false),
    d.helpscout_conversation_url,
    case
      when nud.last_nudge_at is not null and vc.last_view > nud.last_nudge_at then 'reengaged'
      when coalesce(vc.views, 0) >= 3 then 'hot'
      when extract(epoch from (now() - d.created_at)) / 86400 > 7 then 'stale'
      else 'warm'
    end
  from d
  join vc on vc.proof_id = d.proof_id
  join proofs p on p.id = d.proof_id
  left join nud on nud.proof_id = d.proof_id
  where d.proof_id not in (select proof_id from decided_cur)
    and (d.snoozed_until is null or d.snoozed_until <= now())
  order by coalesce(vc.views, 0) desc, vc.last_view desc nulls last;
$$;

revoke all on function proofs.analytics_hot_leads() from public, anon;
grant execute on function proofs.analytics_hot_leads() to authenticated;

-- ── 2. analytics_by_designer() — fair scorecard ─────────────────────────────
drop function if exists proofs.analytics_by_designer();
create function proofs.analytics_by_designer()
returns table (
  designer_user_id uuid,
  designer_name text,
  designer_initials text,
  designer_colour text,
  proofs_all int,
  approved_all int,
  abandoned_all int,
  open_now int,
  returning_share_pct numeric,
  new_mature_n int,
  new_mature_approved int,
  new_mature_pct numeric,
  cr_n int,
  cr_recovered int,
  cr_recovery_pct numeric,
  avg_days_to_approve numeric
)
language sql
stable
security invoker
set search_path to 'proofs', 'public', 'extensions', 'pg_temp'
as $$
  with cur as (
    select pv.proof_id, pv.created_by
    from proof_versions pv
    where pv.is_current
  ),
  cr as (
    select distinct pv.proof_id
    from proof_events e
    join proof_versions pv on pv.id = e.proof_version_id
    where e.event_type = 'request_changes'
  ),
  base as (
    select
      p.id,
      p.status,
      p.created_at as proof_created_at,
      p.approved_at,
      cur.created_by,
      (p.created_at <= now() - interval '7 days') as mature,
      not coalesce(p.helpscout_tags @> array['repeat customer']::text[], false) as is_new,
      (p.id in (select proof_id from cr)) as had_change_req
    from proofs p
    join cur on cur.proof_id = p.id
  )
  select
    b.created_by,
    pr.full_name,
    pr.designer_initials,
    pr.designer_colour,
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
  from base b
  left join profiles pr on pr.id = b.created_by
  group by b.created_by, pr.full_name, pr.designer_initials, pr.designer_colour
  order by count(*) desc;
$$;

revoke all on function proofs.analytics_by_designer() from public, anon;
grant execute on function proofs.analytics_by_designer() to authenticated;

-- ── 3. analytics_funnel() — add returning-vs-new + change-request recovery ───
create or replace function proofs.analytics_funnel()
returns json
language sql
stable
security invoker
set search_path to 'proofs', 'public', 'extensions', 'pg_temp'
as $$
  with nb as (
    select distinct pv.proof_id
    from proof_versions pv
    join proof_version_views vv on vv.proof_version_id = pv.id and vv.is_bot = false
  ),
  dec as (
    select distinct pv.proof_id
    from proof_versions pv
    join proof_events e on e.proof_version_id = pv.id
    where e.event_type in ('approve', 'request_changes', 'designer_override_approve')
  ),
  cr as (
    select distinct pv.proof_id
    from proof_events e
    join proof_versions pv on pv.id = e.proof_version_id
    where e.event_type = 'request_changes'
  ),
  ord_sent as (select distinct proof_id from orders where sent_at is not null),
  ord_paid as (select distinct proof_id from orders where status in ('paid', 'fulfilled') or paid_at is not null)
  select json_build_object(
    'total_proofs',        (select count(*) from proofs),
    'viewed',              (select count(*) from nb),
    'decided',             (select count(*) from dec),
    'approved',            (select count(*) from proofs where status = 'approved'),
    'abandoned',           (select count(*) from proofs where status = 'abandoned'),
    'in_progress',         (select count(*) from proofs where status = 'in_progress'),
    'dormant',             (select count(*) from proofs where status = 'dormant'),
    'order_sent',          (select count(*) from ord_sent),
    'order_paid',          (select count(*) from ord_paid),
    'viewed_no_decision',  (select count(*) from nb where proof_id not in (select proof_id from dec)),
    'median_days_to_approve', (
      select round((percentile_cont(0.5) within group (
        order by extract(epoch from (approved_at - created_at)) / 86400))::numeric, 2)
      from proofs where status = 'approved' and approved_at is not null
    ),
    'returning_n',         (select count(*) from proofs where helpscout_tags @> array['repeat customer']::text[]),
    'returning_approved',  (select count(*) from proofs where helpscout_tags @> array['repeat customer']::text[] and status = 'approved'),
    'new_n',               (select count(*) from proofs where not coalesce(helpscout_tags @> array['repeat customer']::text[], false)),
    'new_approved',        (select count(*) from proofs where not coalesce(helpscout_tags @> array['repeat customer']::text[], false) and status = 'approved'),
    'cr_proofs',           (select count(*) from cr),
    'cr_recovered',        (select count(*) from cr join proofs p2 on p2.id = cr.proof_id where p2.status = 'approved'),
    'payment_mode',        (select payment_mode from settings limit 1)
  );
$$;

revoke all on function proofs.analytics_funnel() from public, anon;
grant execute on function proofs.analytics_funnel() to authenticated;

-- ── 4. analytics_by_segment() — add the 'returning' dimension ────────────────
create or replace function proofs.analytics_by_segment(p_dimension text)
returns table (
  label text,
  n int,
  approved int,
  abandoned int,
  approve_pct numeric
)
language sql
stable
security invoker
set search_path to 'proofs', 'public', 'extensions', 'pg_temp'
as $$
  with cur as (
    select pv.proof_id, pv.currency, pv.shape, pv.material_id, pv.names
    from proof_versions pv
    where pv.is_current
  ),
  base as (
    select
      p.status,
      case p_dimension
        when 'currency' then coalesce(cur.currency::text, '(none)')
        when 'shape' then coalesce(cur.shape, '(unset)')
        when 'material' then coalesce(m.display_name, '(per-direction)')
        when 'returning' then (
          case when p.helpscout_tags @> array['repeat customer']::text[]
               then 'Returning customer' else 'New customer' end
        )
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
  )
  select
    label,
    count(*)::int,
    count(*) filter (where status = 'approved')::int,
    count(*) filter (where status = 'abandoned')::int,
    round(100.0 * count(*) filter (where status = 'approved') / count(*), 1)
  from base
  group by label
  order by count(*) desc;
$$;

revoke all on function proofs.analytics_by_segment(text) from public, anon;
grant execute on function proofs.analytics_by_segment(text) to authenticated;
