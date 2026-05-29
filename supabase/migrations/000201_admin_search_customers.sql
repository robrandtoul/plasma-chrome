-- 000201_admin_search_customers.sql
--
-- Server-side search + pagination for the Admin > Customers list.
--
-- The list used to load every company, every contact, and up to 2000
-- project rows in one go and filter/sort/paginate in the browser. This
-- RPC does it in the database: one searchable, sortable, paginated page
-- of companies, each with its contact count, project count, and
-- most-recent activity, plus the global overview totals and the
-- "No company" orphan summary — in a single round trip.
--
-- Aggregates:
--   * contact_count   — contacts rows for the company
--   * project_count   — public_dashboard_projects rows for the company
--                       (one row per proof that has a current version,
--                       i.e. the same "real projects" the detail page
--                       lists; shell proofs with no version are excluded)
--   * last_activity_at — max(last_activity_at) over those project rows
--
-- Sorts: 'alpha' (default), 'newest', 'oldest', 'active' (most recent
-- activity first, no-activity companies last). lower(name) is the
-- stable tiebreaker.
--
-- SECURITY INVOKER: reads companies, contacts, and
-- public_dashboard_projects, all already readable by the authenticated
-- role (the page queried them directly before). No new exposure; the
-- admin surface stays gated by the RequireAdmin route as before. EXECUTE
-- granted to authenticated only — never anon.

begin;

create or replace function admin_search_customers(
  p_search text default '',
  p_sort text default 'alpha',
  p_limit int default 50,
  p_offset int default 0
)
returns json
language sql
security invoker
set search_path = public
as $$
  with proj as (
    select company_id, contact_id, last_activity_at
    from public_dashboard_projects
  ),
  company_proj as (
    select company_id, count(*) as project_count, max(last_activity_at) as last_activity_at
    from proj
    where company_id is not null
    group by company_id
  ),
  company_agg as (
    select
      co.id,
      co.name,
      co.created_at,
      (select count(*) from contacts c where c.company_id = co.id) as contact_count,
      coalesce(cp.project_count, 0) as project_count,
      cp.last_activity_at
    from companies co
    left join company_proj cp on cp.company_id = co.id
  ),
  filtered as (
    select * from company_agg
    where coalesce(p_search, '') = '' or name ilike '%' || p_search || '%'
  ),
  page as (
    select * from filtered
    order by
      case when p_sort = 'newest' then created_at end desc nulls last,
      case when p_sort = 'oldest' then created_at end asc nulls last,
      case when p_sort = 'active' then last_activity_at end desc nulls last,
      lower(name) asc
    limit greatest(coalesce(p_limit, 50), 0)
    offset greatest(coalesce(p_offset, 0), 0)
  )
  select json_build_object(
    'total', (select count(*) from filtered),
    'companies', coalesce(
      (select json_agg(json_build_object(
        'id', id,
        'name', name,
        'created_at', created_at,
        'contact_count', contact_count,
        'project_count', project_count,
        'last_activity_at', last_activity_at
      )) from page),
      '[]'::json
    ),
    'overview', json_build_object(
      'companies', (select count(*) from companies),
      'contacts', (select count(*) from contacts),
      'with_projects', (select count(distinct company_id) from proj where company_id is not null)
    ),
    'orphan', (
      select json_build_object(
        'contact_count', (select count(*) from contacts where company_id is null),
        'project_count', count(*) filter (where contact_id is not null),
        'last_activity_at', max(last_activity_at)
      )
      from proj
      where company_id is null
    )
  );
$$;

revoke execute on function admin_search_customers(text, text, int, int) from anon, public;
grant execute on function admin_search_customers(text, text, int, int) to authenticated;

commit;
