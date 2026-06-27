-- 000276_analytics_functions.sql
--
-- Read-only aggregation functions backing the new Admin → Analytics page.
-- The goal of the page is conversion insight: how qualified enquiries (proofs)
-- progress to a paid sale, where they leak, and which levers (designer, product,
-- timing) move the rate.
--
-- All five are SECURITY INVOKER, plain `language sql`, schema-qualified, with the
-- live proofs-schema search_path convention. They read the same base tables and
-- the public_dashboard_projects view the dashboard already uses, so the numbers
-- reconcile with dashboard_tile_counts() by construction (same predicates).
--
-- Grants: EXECUTE is revoked from public/anon and granted to authenticated only.
-- These expose company/contact names + designer performance — designer-facing,
-- never anon. No customer-page surface touches them.
--
-- "Won" is, per the brief, a paid order (settings.payment_mode is 'live'); but
-- proof `approved` is the leading signal and is surfaced alongside it because the
-- order/checkout layer is only days old. The funnel returns both stages so the
-- page can lead with whichever has signal.

-- ── 1. analytics_funnel() ───────────────────────────────────────────────────
-- One JSON object: the whole enquiry→paid funnel as absolute counts, plus the
-- "viewed but never decided" leak and the median days-to-approve. payment_mode
-- is included so the UI can label the paid stage honestly (live vs test).
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
    'payment_mode',        (select payment_mode from settings limit 1)
  );
$$;

revoke all on function proofs.analytics_funnel() from public, anon;
grant execute on function proofs.analytics_funnel() to authenticated;

-- ── 2. analytics_weekly() ───────────────────────────────────────────────────
-- One row per creation week (cohort): inflow, viewed, outcome split, paid, and
-- approval rate. `mature` flags weeks whose cohort has had >=7 days to convert
-- (approvals land at a ~1-day median, p90 ~5 days), so the UI can grey the
-- still-maturing tail rather than read it as a dip.
create or replace function proofs.analytics_weekly()
returns table (
  week_start date,
  enquiries int,
  viewed int,
  approved int,
  abandoned int,
  in_progress int,
  paid int,
  approve_pct numeric,
  mature boolean
)
language sql
stable
security invoker
set search_path to 'proofs', 'public', 'extensions', 'pg_temp'
as $$
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
$$;

revoke all on function proofs.analytics_weekly() from public, anon;
grant execute on function proofs.analytics_weekly() to authenticated;

-- ── 3. analytics_by_designer() ──────────────────────────────────────────────
-- Per-designer conversion. Designer = creator of the current version. Returns
-- both an all-time view and a maturity-controlled one (cohort >=7 days old) so
-- comparisons are fair and not skewed by a designer holding fresher work.
create or replace function proofs.analytics_by_designer()
returns table (
  designer_user_id uuid,
  designer_name text,
  designer_initials text,
  designer_colour text,
  proofs_all int,
  approved_all int,
  abandoned_all int,
  in_progress_all int,
  proofs_mature int,
  approved_mature int,
  approve_pct_mature numeric,
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
  base as (
    select
      p.id,
      p.status,
      p.created_at as proof_created_at,
      p.approved_at,
      cur.created_by,
      (p.created_at <= now() - interval '7 days') as mature
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
    count(*) filter (where b.mature)::int,
    count(*) filter (where b.mature and b.status = 'approved')::int,
    case
      when count(*) filter (where b.mature) > 0
      then round(100.0 * count(*) filter (where b.mature and b.status = 'approved')
                 / count(*) filter (where b.mature), 1)
      else null
    end,
    round((avg(extract(epoch from (b.approved_at - b.proof_created_at)) / 86400)
      filter (where b.status = 'approved' and b.approved_at is not null))::numeric, 2)
  from base b
  left join profiles pr on pr.id = b.created_by
  group by b.created_by, pr.full_name, pr.designer_initials, pr.designer_colour
  order by count(*) desc;
$$;

revoke all on function proofs.analytics_by_designer() from public, anon;
grant execute on function proofs.analytics_by_designer() to authenticated;

-- ── 4. analytics_by_segment(p_dimension) ────────────────────────────────────
-- Conversion broken down by a chosen product dimension of the current version.
-- p_dimension ∈ 'material' | 'currency' | 'shape' | 'recipients'. Always returns
-- the row count (n) so the caller can suppress over-reading tiny samples.
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

-- ── 5. analytics_hot_leads() ────────────────────────────────────────────────
-- The live worklist: in-progress proofs the customer has OPENED but not decided
-- in-app (no approve / request-changes on the current version), excluding any
-- currently-snoozed proof. Repeat viewing is a buying signal, so rows carry the
-- non-bot view count + a tier:
--   reengaged = customer re-viewed AFTER the last reminder we sent (warm again)
--   hot       = viewed the current version 3+ times
--   stale     = older than 7 days (past the conversion window)
--   warm      = everything else still in the window
-- Ordered hottest first (most views, most recent view).
create or replace function proofs.analytics_hot_leads()
returns table (
  proof_id uuid,
  company_name text,
  contact_name text,
  contact_email text,
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
    d.helpscout_conversation_url,
    case
      when nud.last_nudge_at is not null and vc.last_view > nud.last_nudge_at then 'reengaged'
      when coalesce(vc.views, 0) >= 3 then 'hot'
      when extract(epoch from (now() - d.created_at)) / 86400 > 7 then 'stale'
      else 'warm'
    end
  from d
  join vc on vc.proof_id = d.proof_id
  left join nud on nud.proof_id = d.proof_id
  where d.proof_id not in (select proof_id from decided_cur)
    and (d.snoozed_until is null or d.snoozed_until <= now())
  order by coalesce(vc.views, 0) desc, vc.last_view desc nulls last;
$$;

revoke all on function proofs.analytics_hot_leads() from public, anon;
grant execute on function proofs.analytics_hot_leads() to authenticated;
