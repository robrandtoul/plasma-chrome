-- 000391: Reorder desk hardening — three fixes from the adversarial review of
-- 000389/000390 (2026-08-09), applied before the desk was ever switched on.
--
-- 1. Register rows can no longer be DELETED by designers. The FK on
--    proofs.reengagement_prospect_id is ON DELETE SET NULL, so deleting a
--    contacted prospect would silently strip the outreach marker from its
--    proof — which drops a never-responded unsolicited proof into the ORGANIC
--    funnel numbers as a failed enquiry (exactly what 000390 exists to
--    prevent). Nothing in the UI deletes register rows: a customer leaves the
--    register by suppression, never by deletion.
--
-- 2. One outreach proof per prospect, enforced. The marker is stamped from a
--    URL query param, so a restored tab or double submission could mint two
--    proofs carrying the same prospect id — double-counting the prospect in
--    analytics_reengagement's weekly fan-out. The partial unique index makes
--    the second insert fail loudly instead.
--
-- 3. analytics_reengagement's outreach block mixed windowed and all-time
--    counts (contacted_in_window was windowed; opened/approved/paid were
--    all-time), and the tab's labels say "in this window". The op CTE now
--    joins through prospects contacted inside the window, so every figure in
--    the block shares one clock.

-- 1. No deletion path for register rows.
drop policy "reorder_prospects: authenticated delete" on proofs.reorder_prospects;
revoke delete on proofs.reorder_prospects from authenticated;

-- 2. One outreach proof per prospect.
create unique index proofs_reengagement_prospect_unique
  on proofs.proofs (reengagement_prospect_id)
  where reengagement_prospect_id is not null;

-- 3. Window every outreach figure to the same clock.
create or replace function proofs.analytics_reengagement(p_days integer default 90)
returns json
language sql stable
set search_path = proofs, public, extensions, pg_temp
as $$
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
$$;
