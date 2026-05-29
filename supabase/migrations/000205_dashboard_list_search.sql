-- 000205_dashboard_list_search.sql
--
-- Server-side search for the dashboard (scaling step C). dashboard_list()
-- (000203/000204) returns the working set; the dashboard's search box
-- then filtered that loaded set client-side, so a designer could only
-- find proofs already in the working set — never an archived (old
-- approved / abandoned) proof.
--
-- Add a p_search parameter:
--   * empty / null  → the working set, exactly as before
--   * non-empty     → every proof matching the term across company name,
--                     contact name, contact email, Help Scout
--                     conversation id, or proof id — regardless of status
--                     or age, so the archive is reachable.
--
-- The old zero-arg dashboard_list() is dropped and replaced with this
-- single-arg version (default ''), so there's no overload ambiguity.
-- PostgREST still allows calling it with no args (the default applies),
-- so a client that hasn't been updated keeps getting the working set.
--
-- Defensive limit 1000, most-recently-active first (a search that would
-- match more than 1000 proofs is unlikely and would want narrowing
-- anyway). SECURITY INVOKER; EXECUTE to authenticated only.

begin;

drop function if exists dashboard_list();

create or replace function dashboard_list(p_search text default '')
returns setof public_dashboard_projects
language sql
security invoker
set search_path = public
as $$
  select d.*
  from public_dashboard_projects d
  where
    (coalesce(p_search, '') = '' and (
      d.status in ('in_progress', 'dormant')
      or d.rule_code is not null
      or (d.status = 'approved'  and d.approved_at  >= now() - interval '14 days')
      or (d.status = 'abandoned' and d.abandoned_at >= now() - interval '30 days')
      or exists (
        select 1 from proof_pins pp
        where pp.proof_id = d.proof_id
          and (pp.scope = 'team' or (pp.scope = 'mine' and pp.user_id = auth.uid()))
      )
    ))
    or
    (coalesce(p_search, '') <> '' and (
      coalesce(d.company_name, '')                  ilike '%' || p_search || '%'
      or coalesce(d.contact_name, '')               ilike '%' || p_search || '%'
      or coalesce(d.contact_email, '')              ilike '%' || p_search || '%'
      or coalesce(d.helpscout_conversation_id::text, '') ilike '%' || p_search || '%'
      or d.proof_id::text                           ilike '%' || p_search || '%'
    ))
  order by d.last_activity_at desc nulls last
  limit 1000;
$$;

revoke execute on function dashboard_list(text) from anon, public;
grant execute on function dashboard_list(text) to authenticated;

commit;
