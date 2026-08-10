-- 000396: two blemishes the first reconcile run surfaced (000395).
--
-- 1. A redundant variant name. Most variants are the thing worth saying —
--    "(500 micron)", "(3 inks)" — but Standard Paper's variant is literally
--    called "Standard", so the phrase came out as "500 standard paper cards
--    (standard)". Said aloud to a customer that reads like a stutter.
--
-- 2. Test fixtures enrolled themselves. Enrolment sweeps every contact with a
--    paid order, which includes the standing demo customers (Atari Corp, the
--    "Joe Bloggs" fixture — see the Atari note in CLAUDE.md, kept deliberately
--    for staff demos). They can never actually be served, since enrolment
--    rests everyone for 180 days and the desk's own guards would catch them,
--    but they inflate the register and would eventually surface on the new
--    admin page as real customers. Kept OUT rather than deleted, so a future
--    run doesn't simply re-add them.

-- Existing rows.
update proofs.reorder_prospects
set last_spec = regexp_replace(last_spec, '\s*\((standard|default)\)$', '', 'i'),
    updated_at = now()
where last_spec ~* '\((standard|default)\)$';

update proofs.reorder_prospects
set state = 'suppressed',
    outcome_note = 'Test fixture — never contact',
    updated_at = now()
where outcome_note like 'Enrolled%'
  and (
    email ilike '%@example.%'
    or email ilike '%.invalid'
    or customer_name ilike '%atari%'
    or customer_name ilike 'joe bloggs%'
  );

-- And the function, so the nightly run stops reintroducing both.
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
  with app_orders as (
    select
      lower(c.email) as email,
      c.id as contact_id,
      o.paid_at,
      o.quantity,
      m.display_name as material,
      -- A variant only earns its parenthesis when it says something the
      -- material name hasn't already said.
      nullif(mv.display_name, '') as variant
    from proofs.orders o
    join proofs.proofs p on p.id = o.proof_id
    join proofs.contacts c on c.id = p.contact_id
    left join proofs.material_variants mv on mv.id = o.material_variant_id
    left join proofs.materials m on m.id = coalesce(o.material_id, mv.material_id)
    where o.paid_at is not null
      and coalesce(o.order_kind, 'production') = 'production'
      and c.email is not null
      and c.email not ilike '%@example.%'
      and c.email not ilike '%.invalid'
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
    last_spec = case
      when l.quantity >= 25 and l.material is not null
        then to_char(l.quantity, 'FM999,999') || ' ' || lower(l.material) || ' cards'
             || case when l.variant is not null and lower(l.variant) not in ('standard', 'default')
                  then ' (' || lower(l.variant) || ')' else '' end
      else rp.last_spec
    end,
    suppressed_until = greatest(coalesce(rp.suppressed_until, date '1970-01-01'),
                                l.paid_at::date + 180),
    state = case when rp.state = 'suppressed' and rp.outcome_note is not null
                 then rp.state else 'pending' end,
    last_reconciled_at = now(),
    updated_at = now()
  from latest l
  where lower(rp.email) = l.email
    and l.paid_at > rp.last_reconciled_at;
  get diagnostics v_refreshed = row_count;

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
      nullif(mv.display_name, '') as variant
    from proofs.orders o
    join proofs.proofs p on p.id = o.proof_id
    join proofs.contacts c on c.id = p.contact_id
    left join proofs.companies co on co.id = c.company_id
    left join proofs.material_variants mv on mv.id = o.material_variant_id
    left join proofs.materials m on m.id = coalesce(o.material_id, mv.material_id)
    where o.paid_at is not null
      and coalesce(o.order_kind, 'production') = 'production'
      and c.email is not null
      and c.email not ilike '%@example.%'
      and c.email not ilike '%.invalid'
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
           || case when n.variant is not null and lower(n.variant) not in ('standard', 'default')
                then ' (' || lower(n.variant) || ')' else '' end
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
