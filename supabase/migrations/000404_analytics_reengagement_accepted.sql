-- 000404: don't lose the "said yes, not paid yet" prospects on Admin → Analytics.
--
-- 000403 split 'accepted' out of 'converted' so the register stops calling an
-- approval a sale. analytics_reengagement's register block has FIXED per-state
-- buckets, so without this an accepted row counts in `total` and in NO bucket:
-- the panel would appear to drop customers somewhere between "Outreach sent"
-- and "Ordered again", with nothing on screen to say where they went.
--
-- One new key. Every existing key keeps its exact predicate — in particular
-- 'contacted' stays (contacted, replied) and does NOT absorb 'accepted', because
-- the whole point of the new state is that those people have answered.
--
-- ⚠ Re-emitted from the LIVE prosrc (read 2026-08-10, md5
-- cad289023e4412a3606e4a4a6e14dd73), not from 000389/000391 — both of those
-- files carry an older body. Header restated exactly as live has it: language
-- sql, STABLE, SECURITY INVOKER, search_path pinned, p_days default 90.
--
-- ⚠ Expect the "Converted" tile to fall when this and 000403 ship together.
-- That is the old number being wrong, not a regression: it counted approvals,
-- including designer overrides, as sales.

create or replace function proofs.analytics_reengagement(p_days integer default 90)
returns json
language sql
stable
set search_path to 'proofs', 'public', 'extensions', 'pg_temp'
as $function$
  with windowed_prospects as (
    select pr.id, pr.contacted_at from reorder_prospects pr
    where pr.contacted_at is not null
      and pr.contacted_at >= now() - make_interval(days => p_days)
  ),
  op as (
    select p.id, p.reengagement_prospect_id, p.status,
      exists (
        select 1 from proof_versions pv
        join proof_version_views vv on vv.proof_version_id = pv.id and vv.is_bot = false
        where pv.proof_id = p.id
      ) as opened,
      exists (
        select 1 from orders o
        where o.proof_id = p.id and (o.paid_at is not null or o.status in ('paid','fulfilled'))
      ) as paid
    from proofs p
    join windowed_prospects wp on wp.id = p.reengagement_prospect_id
  ),
  paid_val as (
    select o.currency,
      count(*) as n,
      sum(coalesce(o.amount_cards,0) + coalesce(o.amount_tooling,0)
        + coalesce(o.amount_personalisation,0) + coalesce(o.amount_shipping,0)
        + coalesce(o.amount_us_tariff,0) - coalesce(o.amount_card_discount,0)) as total
    from orders o
    join proofs p on p.id = o.proof_id
    join windowed_prospects wp on wp.id = p.reengagement_prospect_id
    where o.paid_at is not null
    group by o.currency
  ),
  wk as (
    select date_trunc('week', wp.contacted_at)::date as week_start,
      count(*) as contacted,
      count(*) filter (where op.opened) as opened,
      count(*) filter (where op.status = 'approved') as approved,
      count(*) filter (where op.paid) as paid
    from windowed_prospects wp
    left join op on op.reengagement_prospect_id = wp.id
    group by 1 order by 1
  )
  select json_build_object(
    'window_days', p_days,
    'register', json_build_object(
      'total', (select count(*) from reorder_prospects),
      'pending', (select count(*) from reorder_prospects where state in ('pending','queued')),
      'in_build', (select count(*) from reorder_prospects where state = 'in_build'),
      'contacted', (select count(*) from reorder_prospects where state in ('contacted','replied')),
      -- 000404. Its own bucket, deliberately not folded into 'contacted': these
      -- people have answered, and not into 'converted': they haven't paid.
      'accepted', (select count(*) from reorder_prospects where state = 'accepted'),
      'converted', (select count(*) from reorder_prospects where state = 'converted'),
      'declined', (select count(*) from reorder_prospects where state = 'declined'),
      'closed_no_response', (select count(*) from reorder_prospects where state = 'closed_no_response'),
      'suppressed', (select count(*) from reorder_prospects where state = 'suppressed')
    ),
    'outreach', json_build_object(
      'contacted_in_window', (select count(*) from windowed_prospects),
      'opened', (select count(*) from op where opened),
      'approved', (select count(*) from op where status = 'approved'),
      'paid', (select count(*) from op where paid),
      'paid_value', (select coalesce(json_agg(json_build_object(
        'currency', currency, 'orders', n, 'total', total)), '[]'::json) from paid_val)
    ),
    'weekly', (select coalesce(json_agg(row_to_json(wk)), '[]'::json) from wk)
  );
$function$;

-- Grants restated to match live. create-or-replace preserves the ACL, so this
-- is a no-op today; it is here because the proofs schema has no pg_default_acl
-- for functions and an omitted revoke is how a function becomes callable from
-- the public internet (the 000356 lesson).
revoke execute on function proofs.analytics_reengagement(integer) from public, anon;
grant  execute on function proofs.analytics_reengagement(integer) to authenticated, service_role;
