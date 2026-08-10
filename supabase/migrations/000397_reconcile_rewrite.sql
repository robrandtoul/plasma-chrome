-- 000397: rewrite the register reconcile. The 000395/000396 version was wrong
-- in seven ways, found by adversarial review after it had run against live and
-- written 175 rows. Those rows were deleted, the cron job unscheduled, and the
-- register restored to its 2,739 seeded rows before this was written.
--
-- What was wrong, and what fixes it:
--
-- 1. DUPLICATE ENROLMENT (critical). The "is this customer already here?" test
--    compared emails, but 2,244 of 2,739 rows had none, so for 82% of the
--    register it was a NULL comparison that never matched — 100 of the 174
--    enrolled rows duplicated somebody already there. Fixed upstream of this
--    migration by resolving the missing emails from Xero (2,689 now have one),
--    and here by a second guard on the normalised customer name for the 50 that
--    genuinely have none.
--
-- 2. MONEY CONVERTED TWICE (critical). Enrolment stored a GBP-converted figure
--    while labelling the row USD/EUR, and the scoring pass then converted it
--    again — a $2,600 customer scored as if they had spent £1,582. lifetime_value
--    is now always in the row's OWN currency, matching how the seed stored it,
--    and conversion happens once, at scoring time only.
--
-- 3. STATE CLOBBERING. Any new payment reset the row to 'pending', including
--    'converted' — which that same payment had just earned. Now only states
--    that mean "nobody is mid-anything" are reset.
--
-- 4. HALF A REFRESH. cadence_days, lifetime_value, avg_order_value and
--    first_order_on were never updated, so the stale-rhythm problem this job
--    exists to solve survived it. All are refreshed now.
--
-- 5. COMBINED PAYMENTS COUNTED N TIMES. A combined payment (000309) is ONE
--    purchase settled across several order rows, and counting the rows gave a
--    customer three "orders" a day apart and a cadence of zero. An order is now
--    counted per PAYMENT (order_group_id where present, else the order id).
--
-- 6. OFFLINE ORDERS WORTH ZERO. Offline payments carry no Stripe breakdown, and
--    coalescing those NULLs to 0 turned "we don't know" into "worth nothing" —
--    33 customers were recorded at £0 lifetime. Unknown is now NULL and stays
--    NULL, and the score treats it as unknown rather than worthless.
--
-- 7. SHARED EMAILS DOUBLE-ABSORBED. Where two register rows shared an address,
--    one order updated both. Exactly one primary row per address now absorbs it.
--
-- As of 000398, step A finds that row CONTACT-first: it matches on the durable
-- matched_contact_id link, falling back to the email only for register rows that
-- were never linked. Matching on the address alone left the ~20 customers who
-- are on the register under a different email than they use in the app unable to
-- be refreshed, no matter how much they bought.

-- ── Scoring: unknown value is not zero value ────────────────────────────────

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
      -- A customer whose spend we cannot see (offline-paid) is not a customer
      -- worth nothing. Unknown scores the middle band and says so, rather than
      -- ranking them below a one-off £250 buyer.
      case
        when p_lifetime_gbp is null then 6
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
        case when p_lifetime_gbp is not null
             then '~£' || round(p_lifetime_gbp) || ' lifetime' end,
        case when cadence_pts = 15
             then 'overdue by their own rhythm (~every '
                  || round(p_cadence_days / 30.4) || ' months)' end
      ], null))
  )
  from r;
$$;

revoke execute on function proofs._reorder_score(integer, date, numeric, integer) from public, anon;

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
  -- One row per PAYMENT, with its value in its own currency and NULL where the
  -- money never went through Stripe. Shared by both halves below.
  create temp table _recon_payments on commit drop as
  select
    lower(c.email) as email,
    max(c.id::text)::uuid as contact_id,
    max(coalesce(nullif(co.name, ''), c.full_name)) as customer_name,
    coalesce(o.order_group_id::text, o.id::text) as payment_key,
    max(o.paid_at) as paid_at,
    mode() within group (order by o.currency) as currency,
    nullif(sum(
      coalesce(o.amount_cards, 0) + coalesce(o.amount_tooling, 0)
      + coalesce(o.amount_personalisation, 0) + coalesce(o.amount_shipping, 0)
      + coalesce(o.amount_us_tariff, 0) - coalesce(o.amount_card_discount, 0)
    ), 0) as total,
    max(o.quantity) as quantity,
    max(m.display_name) as material,
    max(nullif(mv.display_name, '')) as variant
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
    and coalesce(nullif(co.name, ''), c.full_name) not ilike 'joe bloggs%'
    and coalesce(nullif(co.name, ''), c.full_name) not ilike '%atari%'
  group by lower(c.email), coalesce(o.order_group_id::text, o.id::text);

  create temp table _recon_rolled on commit drop as
  select
    email,
    max(contact_id::text)::uuid as contact_id,
    max(customer_name) as customer_name,
    mode() within group (order by currency) as currency,
    min(paid_at)::date as first_order_on,
    max(paid_at)::date as last_order_on,
    count(*)::int as payments,
    -- NULL only when every payment's value is unknown.
    sum(total) as lifetime_raw
  from _recon_payments
  group by email;

  -- A. Customers already on the register who have bought again.
  --    Exactly ONE row per address absorbs it — where two rows share an
  --    address, the one with the most history wins.
  -- The durable link first (000398); email only for rows never linked. Still
  -- exactly one register row per customer, or one order is absorbed twice.
  with matched as (
    select r.email as rkey, rp.id, rp.last_reconciled_at, rp.orders_count, rp.created_at
    from _recon_rolled r
    join proofs.reorder_prospects rp
      on (rp.matched_contact_id is not null and rp.matched_contact_id = r.contact_id)
      or (rp.matched_contact_id is null and rp.email is not null
          and lower(rp.email) = r.email)
  ),
  primary_row as (
    select distinct on (rkey) rkey as email, id, last_reconciled_at
    from matched
    order by rkey, orders_count desc, created_at asc
  ),
  fresh as (
    select
      pr.id,
      r.contact_id,
      r.first_order_on,
      r.last_order_on,
      r.lifetime_raw,
      r.currency,
      (select count(*) from _recon_payments p
        where p.email = r.email and p.paid_at > pr.last_reconciled_at) as new_payments,
      (select sum(p.total) from _recon_payments p
        where p.email = r.email and p.paid_at > pr.last_reconciled_at
          and p.currency = r.currency) as new_value,
      (select p.quantity from _recon_payments p
        where p.email = r.email order by p.paid_at desc limit 1) as quantity,
      (select p.material from _recon_payments p
        where p.email = r.email order by p.paid_at desc limit 1) as material,
      (select p.variant from _recon_payments p
        where p.email = r.email order by p.paid_at desc limit 1) as variant
    from _recon_rolled r
    join primary_row pr on pr.email = r.email
  )
  update proofs.reorder_prospects rp
  set
    first_order_on = least(rp.first_order_on, f.first_order_on),
    last_order_on = greatest(rp.last_order_on, f.last_order_on),
    orders_count = rp.orders_count + f.new_payments,
    matched_contact_id = coalesce(rp.matched_contact_id, f.contact_id),
    -- Kept in the ROW's currency, never converted here (defect 2).
    lifetime_value = case
      when rp.lifetime_value is null and f.new_value is null then null
      else coalesce(rp.lifetime_value, 0) + coalesce(f.new_value, 0) end,
    avg_order_value = case
      when rp.lifetime_value is null and f.new_value is null then null
      else round((coalesce(rp.lifetime_value, 0) + coalesce(f.new_value, 0))
                 / nullif(rp.orders_count + f.new_payments, 0), 2) end,
    -- The rhythm, refreshed: this is the whole point of the job (defect 4).
    cadence_days = case
      when rp.orders_count + f.new_payments >= 2
        -- nullif: two payments on one day is a single buying event, not a
        -- rhythm of zero days. Unknown is the honest answer.
        then nullif(((greatest(rp.last_order_on, f.last_order_on)
               - least(rp.first_order_on, f.first_order_on))
              / (rp.orders_count + f.new_payments - 1))::int, 0)
      else rp.cadence_days end,
    last_spec = case
      when f.quantity >= 25 and f.material is not null
        then to_char(f.quantity, 'FM999,999') || ' ' || lower(f.material) || ' cards'
             || case when f.variant is not null and lower(f.variant) not in ('standard', 'default')
                  then ' (' || lower(f.variant) || ')' else '' end
      else rp.last_spec
    end,
    suppressed_until = greatest(coalesce(rp.suppressed_until, date '1970-01-01'),
                                f.last_order_on + 180),
    -- Only states where nobody is mid-anything are reset. 'converted' in
    -- particular must survive — the payment that reaches this job is usually
    -- the very one that earned it (defect 3).
    state = case when rp.state in ('pending', 'queued', 'closed_no_response')
                 then 'pending' else rp.state end,
    last_reconciled_at = now(),
    updated_at = now()
  from fresh f
  where rp.id = f.id and f.new_payments > 0;
  get diagnostics v_refreshed = row_count;

  -- B. Customers who have only ever bought through the app.
  insert into proofs.reorder_prospects (
    customer_name, email, currency, first_order_on, last_order_on, orders_count,
    lifetime_value, avg_order_value, cadence_days, last_spec, score, score_reasons,
    state, suppressed_until, matched_contact_id, outcome_note, last_reconciled_at
  )
  select
    r.customer_name, r.email, r.currency, r.first_order_on, r.last_order_on, r.payments,
    r.lifetime_raw,
    case when r.lifetime_raw is not null then round(r.lifetime_raw / r.payments, 2) end,
    case when r.payments >= 2
      then nullif(((r.last_order_on - r.first_order_on) / (r.payments - 1))::int, 0) end,
    (select case when p.quantity >= 25 and p.material is not null
       then to_char(p.quantity, 'FM999,999') || ' ' || lower(p.material) || ' cards'
            || case when p.variant is not null and lower(p.variant) not in ('standard', 'default')
                 then ' (' || lower(p.variant) || ')' else '' end end
     from _recon_payments p where p.email = r.email order by p.paid_at desc limit 1),
    (proofs._reorder_score(r.payments, r.last_order_on,
       r.lifetime_raw * case r.currency when 'USD' then 0.78 when 'EUR' then 0.86 else 1 end,
       case when r.payments >= 2
         then nullif(((r.last_order_on - r.first_order_on) / (r.payments - 1))::int, 0) end) ->> 'score')::int,
    coalesce(array(select jsonb_array_elements_text(
      proofs._reorder_score(r.payments, r.last_order_on,
        r.lifetime_raw * case r.currency when 'USD' then 0.78 when 'EUR' then 0.86 else 1 end,
        case when r.payments >= 2
          then nullif(((r.last_order_on - r.first_order_on) / (r.payments - 1))::int, 0) end) -> 'reasons')), '{}'),
    'pending',
    r.last_order_on + 180,
    r.contact_id,
    'Enrolled from an order placed through the app',
    now()
  from _recon_rolled r
  where not exists (
    select 1 from proofs.reorder_prospects rp where lower(rp.email) = r.email
  )
  -- Second guard for the 50 rows with no email at all: a name that normalises
  -- to the same string is the same customer (defect 1).
  and not exists (
    select 1 from proofs.reorder_prospects rp2
    where lower(regexp_replace(rp2.customer_name, '[^a-zA-Z0-9]', '', 'g'))
        = lower(regexp_replace(r.customer_name, '[^a-zA-Z0-9]', '', 'g'))
  );
  get diagnostics v_enrolled = row_count;

  -- C. Re-score everything: recency is a third of the score and moves daily.
  --    ONE conversion, from the row's own currency (defect 2).
  update proofs.reorder_prospects rp
  set
    score = (proofs._reorder_score(rp.orders_count, rp.last_order_on, s.gbp, rp.cadence_days) ->> 'score')::int,
    score_reasons = coalesce(array(select jsonb_array_elements_text(
      proofs._reorder_score(rp.orders_count, rp.last_order_on, s.gbp, rp.cadence_days) -> 'reasons')), '{}'),
    updated_at = now()
  from (
    select id, lifetime_value
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

-- Re-scheduled only after a verified run — see the apply notes for 000397.
select cron.schedule(
  'proofs-reconcile-reorder-register',
  '0 2 * * *',
  $cron$select proofs.reconcile_reorder_register()$cron$
);
