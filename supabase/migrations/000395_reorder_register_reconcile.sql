-- 000395: keep the reorder register alive after the Xero backfill.
--
-- The register (000389) was seeded from three years of Xero history and then
-- never touched again. Three consequences, all confirmed against live:
--
--   * Nothing refreshed the seeded facts, so a customer who orders tomorrow
--     still looks overdue by their old rhythm, and their remembered purchase
--     goes stale.
--   * Scores were frozen at seed time. Recency is a third of the score, and
--     recency changes every single day — a customer who becomes due next month
--     never rises up the queue.
--   * New customers never joined. 186 contacts have paid through the app and
--     none of them are in the register, so the desk's supply was a fixed
--     pre-June pool that could only shrink.
--
-- Xero was the BACKFILL. From here the app itself is the source of truth for
-- orders, so this reconcile is pure SQL and needs no Xero call. It runs nightly
-- and is safe to run by hand.

alter table proofs.reorder_prospects
  add column last_reconciled_at timestamptz not null default now();

comment on column proofs.reorder_prospects.last_reconciled_at is
  'Watermark for the nightly reconcile (000395). Orders paid after this are new '
  'to the register; everything before it is already counted, which is what stops '
  'an app order being added twice (it also appears in Xero, the seed source).';

-- ── Scoring, in one place ───────────────────────────────────────────────────
--
-- The seed's scoring lived in a one-off script that is not part of this repo,
-- so this is now the ONLY living definition — deliberately, to avoid two
-- implementations drifting. Bands are the seed's, unchanged:
--   frequency (how proven they are) + recency (are they due) + value
--   + a bonus when they are overdue BY THEIR OWN rhythm, which is the signal
--     that beats any absolute threshold.

create or replace function proofs._reorder_score(
  p_orders integer,
  p_last date,
  p_lifetime_gbp numeric,
  p_cadence_days integer
)
returns jsonb
language sql
immutable
set search_path = proofs, public, extensions, pg_temp
as $$
  with f as (
    select
      case when p_orders >= 5 then 30 when p_orders >= 3 then 22
           when p_orders = 2 then 15 else 5 end as freq_pts,
      (current_date - p_last) as days_since
  ),
  r as (
    select f.*,
      case
        when f.days_since between 180 and 730 then 25
        when f.days_since between 120 and 179 then 15
        when f.days_since between 731 and 1095 then 12
        when f.days_since > 1095 then 5
        else 0
      end as rec_pts,
      case
        when p_lifetime_gbp >= 2000 then 20 when p_lifetime_gbp >= 1000 then 15
        when p_lifetime_gbp >= 500 then 10 when p_lifetime_gbp >= 250 then 6
        else 3 end as val_pts,
      case
        when p_cadence_days >= 30
             and f.days_since::numeric / nullif(p_cadence_days, 0) between 1 and 2.5 then 15
        when p_cadence_days >= 30
             and f.days_since::numeric / nullif(p_cadence_days, 0) > 2.5 then 8
        else 0 end as cadence_pts
    from f
  )
  select jsonb_build_object(
    'score', greatest(0, freq_pts + rec_pts + val_pts + cadence_pts),
    'reasons',
      to_jsonb(array_remove(array[
        case when p_orders = 1 then '1 previous order'
             else p_orders || ' previous orders' end,
        'last ordered ~' || round(days_since / 30.4) || ' months ago',
        '~£' || round(coalesce(p_lifetime_gbp, 0)) || ' lifetime',
        case when cadence_pts = 15
             then 'overdue by their own rhythm (~every '
                  || round(p_cadence_days / 30.4) || ' months)' end
      ], null))
  )
  from r;
$$;

revoke execute on function proofs._reorder_score(integer, date, numeric, integer) from public, anon;

-- ── The serve-time guard ────────────────────────────────────────────────────
--
-- The desk must never greet someone with "how are you doing for stock?" a
-- fortnight after their cards arrived. The reconcile below rests a customer for
-- 180 days after an order, but this is the belt to that braces: it is evaluated
-- at the moment of serving, so it holds even for an order placed since the last
-- nightly run.

create or replace function proofs.reorder_prospects_recently_active(p_days integer default 180)
returns setof uuid
language sql
stable
set search_path = proofs, public, extensions, pg_temp
as $$
  select distinct rp.id
  from proofs.reorder_prospects rp
  join proofs.contacts c on lower(c.email) = lower(rp.email)
  join proofs.proofs p on p.contact_id = c.id
  left join proofs.orders o
    on o.proof_id = p.id and o.paid_at > now() - make_interval(days => p_days)
  where rp.email is not null
    and (
      o.id is not null
      -- A live project counts too: they are already talking to us, and an
      -- unsolicited "we made your cards a while back" mid-conversation is
      -- worse than saying nothing.
      or (p.status in ('in_progress', 'dormant')
          and p.created_at > now() - make_interval(days => p_days))
    );
$$;

revoke execute on function proofs.reorder_prospects_recently_active(integer) from public, anon;
grant execute on function proofs.reorder_prospects_recently_active(integer) to authenticated, service_role;

-- ── The reconcile ───────────────────────────────────────────────────────────

create or replace function proofs.reconcile_reorder_register()
returns jsonb
language plpgsql
security definer
set search_path = proofs, public, extensions, pg_temp
as $$
declare
  v_refreshed integer := 0;
  v_enrolled integer := 0;
  v_rescored integer := 0;
begin
  -- A. Existing customers who have bought again through the app.
  with app_orders as (
    select
      lower(c.email) as email,
      c.id as contact_id,
      o.paid_at,
      o.quantity,
      m.display_name as material,
      mv.display_name as variant
    from proofs.orders o
    join proofs.proofs p on p.id = o.proof_id
    join proofs.contacts c on c.id = p.contact_id
    left join proofs.material_variants mv on mv.id = o.material_variant_id
    left join proofs.materials m on m.id = coalesce(o.material_id, mv.material_id)
    where o.paid_at is not null
      and coalesce(o.order_kind, 'production') = 'production'
      and c.email is not null
  ),
  latest as (
    select distinct on (email) *
    from app_orders
    order by email, paid_at desc
  )
  update proofs.reorder_prospects rp
  set
    last_order_on = greatest(rp.last_order_on, l.paid_at::date),
    orders_count = rp.orders_count
      + (select count(*) from app_orders a
         where a.email = l.email and a.paid_at > rp.last_reconciled_at),
    matched_contact_id = coalesce(rp.matched_contact_id, l.contact_id),
    -- Compose from the app's own fields rather than parsing invoice text, and
    -- only when the quantity is one a price tier actually offers (000394).
    last_spec = case
      when l.quantity >= 25 and l.material is not null
        then to_char(l.quantity, 'FM999,999') || ' ' || lower(l.material) || ' cards'
             || coalesce(' (' || lower(l.variant) || ')', '')
      else rp.last_spec
    end,
    -- Rest them: they have just bought.
    suppressed_until = greatest(coalesce(rp.suppressed_until, date '1970-01-01'),
                                l.paid_at::date + 180),
    -- A customer who buys again is back in the pool, whatever the desk had
    -- previously concluded — but never override a deliberate "never contact".
    state = case when rp.state = 'suppressed' and rp.outcome_note is not null
                 then rp.state else 'pending' end,
    last_reconciled_at = now(),
    updated_at = now()
  from latest l
  where lower(rp.email) = l.email
    and l.paid_at > rp.last_reconciled_at;
  get diagnostics v_refreshed = row_count;

  -- B. Customers who have only ever bought through the app: enrol them so the
  --    back book replenishes itself instead of only draining.
  with app_orders as (
    select
      lower(c.email) as email,
      c.id as contact_id,
      coalesce(nullif(co.name, ''), c.full_name) as customer_name,
      o.paid_at,
      o.currency,
      o.quantity,
      coalesce(o.amount_cards, 0) + coalesce(o.amount_tooling, 0)
        + coalesce(o.amount_personalisation, 0) as goods,
      m.display_name as material,
      mv.display_name as variant
    from proofs.orders o
    join proofs.proofs p on p.id = o.proof_id
    join proofs.contacts c on c.id = p.contact_id
    left join proofs.companies co on co.id = c.company_id
    left join proofs.material_variants mv on mv.id = o.material_variant_id
    left join proofs.materials m on m.id = coalesce(o.material_id, mv.material_id)
    where o.paid_at is not null
      and coalesce(o.order_kind, 'production') = 'production'
      and c.email is not null
  ),
  rolled as (
    select
      email,
      max(contact_id::text)::uuid as contact_id,
      max(customer_name) as customer_name,
      mode() within group (order by currency) as currency,
      min(paid_at)::date as first_order_on,
      max(paid_at)::date as last_order_on,
      count(*)::int as orders_count,
      -- Same conversion the seed used, so old and new rows are comparable.
      sum(goods * case currency when 'USD' then 0.78 when 'EUR' then 0.86 else 1 end) as lifetime_gbp,
      case when count(*) >= 2
        then (max(paid_at)::date - min(paid_at)::date) / (count(*) - 1)
      end::int as cadence_days
    from app_orders
    group by email
  ),
  newest as (
    select distinct on (email) email, quantity, material, variant
    from app_orders order by email, paid_at desc
  )
  insert into proofs.reorder_prospects (
    customer_name, email, currency, first_order_on, last_order_on, orders_count,
    lifetime_value, avg_order_value, cadence_days, last_spec, score, score_reasons,
    state, suppressed_until, matched_contact_id, outcome_note, last_reconciled_at
  )
  select
    r.customer_name, r.email, r.currency, r.first_order_on, r.last_order_on, r.orders_count,
    round(r.lifetime_gbp, 2), round(r.lifetime_gbp / r.orders_count, 2), r.cadence_days,
    case when n.quantity >= 25 and n.material is not null
      then to_char(n.quantity, 'FM999,999') || ' ' || lower(n.material) || ' cards'
           || coalesce(' (' || lower(n.variant) || ')', '')
    end,
    (proofs._reorder_score(r.orders_count, r.last_order_on, r.lifetime_gbp, r.cadence_days) ->> 'score')::int,
    coalesce(array(select jsonb_array_elements_text(
      proofs._reorder_score(r.orders_count, r.last_order_on, r.lifetime_gbp, r.cadence_days) -> 'reasons')), '{}'),
    'pending',
    r.last_order_on + 180,
    r.contact_id,
    'Enrolled from an order placed through the app',
    now()
  from rolled r
  join newest n on n.email = r.email
  where not exists (
    select 1 from proofs.reorder_prospects rp where lower(rp.email) = r.email
  );
  get diagnostics v_enrolled = row_count;

  -- C. Re-score everything. Recency is a third of the score and it moves every
  --    day, so a register scored once is wrong the following morning: this is
  --    what lets a customer rise into the queue as they become due.
  update proofs.reorder_prospects rp
  set
    score = (proofs._reorder_score(rp.orders_count, rp.last_order_on, s.gbp, rp.cadence_days) ->> 'score')::int,
    score_reasons = coalesce(array(select jsonb_array_elements_text(
      proofs._reorder_score(rp.orders_count, rp.last_order_on, s.gbp, rp.cadence_days) -> 'reasons')), '{}'),
    updated_at = now()
  from (
    select id, coalesce(lifetime_value, 0)
      * case currency when 'USD' then 0.78 when 'EUR' then 0.86 else 1 end as gbp
    from proofs.reorder_prospects
  ) s
  where s.id = rp.id and rp.last_order_on is not null;
  get diagnostics v_rescored = row_count;

  return jsonb_build_object(
    'refreshed', v_refreshed, 'enrolled', v_enrolled, 'rescored', v_rescored, 'at', now()
  );
end;
$$;

revoke execute on function proofs.reconcile_reorder_register() from public, anon;
grant execute on function proofs.reconcile_reorder_register() to authenticated, service_role;

-- Nightly, before the working day. Unschedule first so re-running is safe.
select cron.unschedule('proofs-reconcile-reorder-register')
where exists (select 1 from cron.job where jobname = 'proofs-reconcile-reorder-register');

select cron.schedule(
  'proofs-reconcile-reorder-register',
  '0 2 * * *',
  $cron$select proofs.reconcile_reorder_register()$cron$
);
