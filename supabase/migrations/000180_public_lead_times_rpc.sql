-- Migration 000180: public read access to material lead times.
--
-- The marketing site's /turnaround-times page (Squarespace) needs to
-- show the current production lead time per material to the public.
-- Migration 000175 added lead_time_min_days / lead_time_max_days /
-- lead_time_updated_at to `materials`, but migration 000162 revoked
-- anon SELECT on the `materials` table, so the anon role cannot read
-- those columns directly.
--
-- This migration follows the same anon-RPC house pattern as
-- public_get_customer_proof (000162): a SECURITY DEFINER function with
-- EXECUTE granted to anon, returning a tightly-scoped payload and
-- nothing else. No view is added — a view over `materials` would need
-- a fresh anon GRANT (re-opening table-shaped access to a table 000162
-- deliberately closed), whereas the RPC keeps the exposed surface to
-- exactly the six columns the public page consumes.
--
-- The function returns a jsonb array, one object per active,
-- published, non-archived material that has a lead-time pair set.
-- Materials with no lead time recorded are omitted entirely, so the
-- page only ever shows figures a human has signed off on via the
-- admin Lead times tab. Pricing, disclaimers, split-name surcharges
-- and every other materials column stay unexposed.

begin;

create or replace function public_get_lead_times()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'code',                 m.code,
        'display_name',         m.display_name,
        'category',             m.category,
        'lead_time_min_days',   m.lead_time_min_days,
        'lead_time_max_days',   m.lead_time_max_days,
        'lead_time_updated_at', m.lead_time_updated_at
      )
      order by m.sort_order, m.display_name
    ),
    '[]'::jsonb
  )
  from materials m
  where m.is_active          = true
    and m.is_published       = true
    and m.archived_at        is null
    and m.lead_time_min_days is not null
    and m.lead_time_max_days is not null;
$$;

revoke execute on function public_get_lead_times() from public;
grant  execute on function public_get_lead_times() to anon, authenticated;

commit;
