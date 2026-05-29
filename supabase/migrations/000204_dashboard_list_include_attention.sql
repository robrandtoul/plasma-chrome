-- 000204_dashboard_list_include_attention.sql
--
-- Correction to dashboard_list() (000203). The working set there was
-- active (in_progress/dormant) + recently-closed + pinned, on the
-- assumption — inherited from CLAUDE.md — that every needs-attention
-- proof is active and so already covered. Live data disproves it:
-- proofs_needing_attention() flags proofs in statuses the working set
-- excluded, so the dashboard's Needs attention tile read 110 while the
-- scoped list surfaced only 17 of them. The single most important tile
-- must have all its members present and clickable.
--
-- Add `rule_code is not null` to the inclusion set: every proof
-- proofs_needing_attention() flags (the same signal dashboard_tile_counts
-- counts for the needs_attention tile) is now in the list, regardless of
-- status. With this, every stat tile's click-through members are present
-- in the loaded list:
--   needs_attention   → rule_code is not null            (added here)
--   not_viewed / awaiting_customer / changes_requested   → active
--   dormant                                              → active
--   approved_this_week                                   → approved ≤14d
-- plus pinned proofs, regardless of status/age.
--
-- 000203 is left as-shipped (it was already applied); this create-or-
-- replace realigns both a fresh replay and the live database to the
-- correct definition.

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
    or d.rule_code is not null
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
