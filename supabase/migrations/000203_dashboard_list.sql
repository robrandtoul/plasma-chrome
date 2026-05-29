-- 000203_dashboard_list.sql
--
-- Scope the dashboard's loaded project list to the working set instead of
-- pulling every proof (capped at 2000) into the browser. The dashboard is
-- a live work queue, not an archive, so the rows that matter are the
-- active and recently-closed ones — plus anything the designer has pinned,
-- regardless of age.
--
-- dashboard_list() returns one row per proof (the public_dashboard_projects
-- shape the dashboard already renders) for:
--   * status in ('in_progress', 'dormant')          — the active queue
--   * approved within the last 14 days               — covers the
--     "Approved this week" tile (7 days) with a buffer
--   * abandoned within the last 30 days              — recently abandoned
--   * any proof pinned by the caller ('mine') or the team ('team'),
--     regardless of status/age, so the Pinned / Team sections never miss
--     an archived pin
--
-- Long-closed history (older approved / abandoned) is intentionally left
-- out — it's reachable via search (the next step, C). Every dashboard tile
-- count comes from dashboard_tile_counts() (000202) which counts across ALL
-- proofs, so the headline numbers stay correct even though this list is
-- scoped; and each tile's click-through members are all active/recent, so
-- they're present here.
--
-- Defensive `limit 1000` (most-recently-active first) as a backstop — the
-- working set is bounded by active volume, which in practice is far below
-- this; 1000 concurrently-open jobs would itself signal a different problem.
--
-- SECURITY INVOKER: reads public_dashboard_projects + proof_pins, both
-- readable by the authenticated role; auth.uid() resolves the caller for
-- the 'mine' pin check (same pattern proof_pins RLS already uses). EXECUTE
-- to authenticated only; never anon.

begin;

create or replace function dashboard_list()
returns setof public_dashboard_projects
language sql
security invoker
set search_path = public
as $$
  select d.*
  from public_dashboard_projects d
  where
    d.status in ('in_progress', 'dormant')
    or (d.status = 'approved'  and d.approved_at  >= now() - interval '14 days')
    or (d.status = 'abandoned' and d.abandoned_at >= now() - interval '30 days')
    or exists (
      select 1 from proof_pins pp
      where pp.proof_id = d.proof_id
        and (pp.scope = 'team' or (pp.scope = 'mine' and pp.user_id = auth.uid()))
    )
  order by d.last_activity_at desc nulls last
  limit 1000;
$$;

revoke execute on function dashboard_list() from anon, public;
grant execute on function dashboard_list() to authenticated;

commit;
