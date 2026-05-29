-- 000202_dashboard_tile_counts.sql
--
-- Server-side counts for the six dashboard stat tiles. The dashboard
-- computed these in the browser by .filter()-ing the loaded projects
-- array, which is capped at 2000 rows — so past 2000 proofs the tile
-- numbers would silently undercount (and the dashboard would drop the
-- oldest-by-activity rows). This RPC counts across every proof in the
-- database, decoupling the headline numbers from whatever subset the
-- list happens to load. (A counts function shipped in 000152 and was
-- dropped in 000187 when counts moved client-side; this is its
-- correctness-restoring replacement, with the predicates kept in exact
-- lockstep with the current client-side filters.)
--
-- Predicates mirror DashboardPage's count memos one-for-one. Every tile
-- excludes currently-snoozed proofs (a snooze row whose snoozed_until is
-- still in the future — the same test as isCurrentlySnoozed; the
-- view's grace-windowed snoozed_until column is deliberately not used
-- here, an EXISTS on the table is the precise "active snooze" check):
--   * needs_attention   — rule_code is not null
--   * not_viewed        — no rule; active (in_progress|dormant); current
--                         version exists; customer hasn't viewed it
--   * awaiting_customer — no rule; in_progress; current version viewed
--   * changes_requested — no rule; in_progress; latest non-view event is
--                         a change request newer than the current version
--                         (latest_non_view_event_*, migration 000198)
--   * dormant           — status dormant
--   * approved_this_week— approved within the last 7 days
--
-- SECURITY INVOKER: reads public_dashboard_projects + proof_attention_
-- snoozes, both already readable by the authenticated role. EXECUTE to
-- authenticated only; never anon.

begin;

create or replace function dashboard_tile_counts()
returns json
language sql
security invoker
set search_path = public
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
        and status in ('in_progress', 'dormant')
        and current_version_id is not null
        and current_version_viewed_at is null
    ),
    'awaiting_customer', (
      select count(*) from p
      where rule_code is null and not snoozed
        and status = 'in_progress'
        and current_version_id is not null
        and current_version_viewed_at is not null
    ),
    'changes_requested', (
      select count(*) from p
      where rule_code is null and not snoozed
        and status = 'in_progress'
        and latest_non_view_event_type = 'request_changes'
        and latest_non_view_event_at is not null
        and version_created_at is not null
        and latest_non_view_event_at > version_created_at
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

revoke execute on function dashboard_tile_counts() from anon, public;
grant execute on function dashboard_tile_counts() to authenticated;

commit;
