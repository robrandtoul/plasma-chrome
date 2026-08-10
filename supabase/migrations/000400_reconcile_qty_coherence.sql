-- 000400: make the remembered QUANTITY come from the same order as the
-- remembered MATERIAL.
--
-- 000399 gave the re-engagement band structured parts of the last purchase so
-- the price grid can badge the exact column and row the customer bought. It
-- was careful about the variant: on a combined payment (000309) the material
-- label can win from one order and the thickness from another, so it added
-- variant_matches_material and refuses to store a thickness that does not
-- belong to the material being stored. That guard works.
--
-- The quantity never got one. In _recon_payments the material and variant ids
-- are ordered array_agg picks tied to the winning material label, but the
-- quantity is max(o.quantity) across the WHOLE payment -- and a payment is one
-- row per Stripe charge, which since 000309 can span several orders of several
-- materials. So the two fields are computed by independent aggregates over a
-- set that is not guaranteed to be one product.
--
-- Live example, payment 813195a0-c4fb-4e64-9a6f-94270e1e0b3d (The Experience
-- Auto Group, paid 2026-07-14):
--
--   Matte Black Metal x100  +  Carbon Fibre x700
--
-- max(display_name) picks "Matte Black Metal"; max(quantity) picks 700. The
-- register would store material = Matte Black Metal, last_qty = 700, and a
-- Matte Black Metal outreach proof would badge the 700 row as "your last
-- order" -- a quantity that customer has never ordered of that product. The
-- badge is not a hint, it is a claim about their own history, so being wrong
-- is worse than being absent: it invites them to reorder a quantity at a price
-- they were never quoted, and it tells them we have their record confused.
--
-- The fix is the discipline 000399 applied to the variant, one field further:
-- take the quantity from the row whose material label won, using the SAME
-- ordering key, so the number and the name are read off one order row.
--
-- Two things worth stating because they are easy to get wrong on re-reading:
--
--   * The tiebreaker (o.quantity desc nulls last) is not a preference for big
--     numbers. Within a single material every row ties on the first key, and
--     without a second key array_agg's pick among ties is arbitrary -- so a
--     payment holding two orders of the same material would give a different
--     answer run to run. With it, a single-material payment resolves to that
--     material's largest quantity, which is exactly what max() returned, so
--     the change is provably inert there rather than accidentally so. Measured
--     on live before applying: 194 payments, 9 span more than one material,
--     ONE changes (the payment above, 700 -> 100), and zero single-material
--     payments change.
--
--   * It cannot desync from material_id. Material display names are unique, so
--     every row tied on the first key resolves to the same material id -- the
--     tiebreaker reorders rows within a group that all agree about the
--     material.
--
-- ONE line covers both branches. Branch A (the UPDATE, for a customer already
-- on the register) and branch B (the INSERT, for one who has only ever bought
-- through the app) each read the latest payment through a lateral over
-- _recon_payments and take lastp.quantity; neither computes a quantity of its
-- own. Fixing the shared CTE is therefore the whole fix, and is also the only
-- way to fix it without the two branches being able to drift apart later.
--
-- last_spec moves with it, deliberately. The sentence and the parts are
-- written from the same f.quantity under the same guard, exactly so they can
-- never describe different purchases (000399); holding the prose at max()
-- would re-open that gap to protect wording that is simply wrong. What this
-- does NOT touch is the pre-existing label mispairing 000399 documented and
-- left alone -- prose like "100 satin plastic cards (500 micron)" where the
-- thickness came from the other order in the payment. That is a wording
-- decision, and the structured columns are already protected from it by
-- variant_matches_material.
--
-- Re-emitted from the LIVE definition (pg_get_functiondef, 2026-08-09), which
-- was diffed against the 000399 file first and found byte-identical --
-- prosrc md5 36d7e25bc3d34ce610c05cf6a8c8c2c3, 12,517 characters -- so there
-- is no drift to preserve. Everything below is that definition unchanged
-- apart from the quantity pick, marked 000400. No schema change: this
-- migration creates no table and no new function, so the existing grants
-- apply; the revoke/grant pair is restated only because CREATE OR REPLACE on
-- a function keeps its ACL and stating it keeps the file self-contained.

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
    -- 000400: the quantity of the order that supplied the MATERIAL, not the
    -- largest quantity anywhere in the payment. Same ordering key as the
    -- material picks below, so the number and the name always come off the same
    -- order row. The second key is a tiebreaker, not a preference: within one
    -- material every row ties on the first key, so it resolves to that
    -- material's largest quantity -- which is what max() already returned on a
    -- single-material payment, making this change provably inert for 185 of the
    -- 194 live payments rather than incidentally so.
    (array_agg(o.quantity
       order by m.display_name desc nulls last, o.quantity desc nulls last))[1] as quantity,
    max(m.display_name) as material,
    max(nullif(mv.display_name, '')) as variant,
    -- 000399: the ids behind those two labels, each taken from the row whose
    -- label won, so an id can never belong to a different product than the
    -- name printed beside it.
    (array_agg(coalesce(o.material_id, mv.material_id)
       order by m.display_name desc nulls last))[1] as material_id,
    (array_agg(o.material_variant_id
       order by nullif(mv.display_name, '') desc nulls last))[1] as material_variant_id
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
      -- 000399: one read of the latest payment, so every field below describes
      -- the same purchase.
      lastp.quantity,
      lastp.material,
      lastp.variant,
      lastp.material_id,
      lastp.material_variant_id,
      lastp.variant_matches_material
    from _recon_rolled r
    join primary_row pr on pr.email = r.email
    left join lateral (
      select p.quantity, p.material, p.variant, p.material_id, p.material_variant_id,
        -- 000399: does the thickness actually belong to the material we are
        -- about to store? False on a combined payment whose two labels came
        -- from different orders.
        exists (
          select 1 from proofs.material_variants mv2
          where mv2.id = p.material_variant_id
            and mv2.material_id = p.material_id
        ) as variant_matches_material
      from _recon_payments p
      where p.email = r.email
      order by p.paid_at desc, p.payment_key desc
      limit 1
    ) lastp on true
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
    -- 000399: the same purchase, in parts. Same guard as last_spec above, so
    -- the sentence and its parts can never disagree.
    last_qty = case
      when f.quantity >= 25 and f.material is not null then f.quantity
      else rp.last_qty end,
    last_material_id = case
      when f.quantity >= 25 and f.material is not null then f.material_id
      else rp.last_material_id end,
    -- The inner case is the coherence gate: a new purchase replaces the whole
    -- structured set, so where the thickness cannot be trusted to belong to the
    -- material it is cleared rather than left pointing at the OLD purchase's
    -- thickness beside the NEW purchase's material.
    last_variant_id = case
      when f.quantity >= 25 and f.material is not null
        then case when f.variant_matches_material then f.material_variant_id end
      else rp.last_variant_id end,
    last_variant_label = case
      when f.quantity >= 25 and f.material is not null
        then case when f.variant_matches_material then lower(f.variant) end
      else rp.last_variant_label end,
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
    lifetime_value, avg_order_value, cadence_days, last_spec,
    last_qty, last_material_id, last_variant_id, last_variant_label,
    score, score_reasons,
    state, suppressed_until, matched_contact_id, outcome_note, last_reconciled_at
  )
  select
    r.customer_name, r.email, r.currency, r.first_order_on, r.last_order_on, r.payments,
    r.lifetime_raw,
    case when r.lifetime_raw is not null then round(r.lifetime_raw / r.payments, 2) end,
    case when r.payments >= 2
      then nullif(((r.last_order_on - r.first_order_on) / (r.payments - 1))::int, 0) end,
    case when lastp.quantity >= 25 and lastp.material is not null
      then to_char(lastp.quantity, 'FM999,999') || ' ' || lower(lastp.material) || ' cards'
           || case when lastp.variant is not null and lower(lastp.variant) not in ('standard', 'default')
                then ' (' || lower(lastp.variant) || ')' else '' end end,
    -- 000399: the same purchase, in parts.
    case when lastp.quantity >= 25 and lastp.material is not null then lastp.quantity end,
    case when lastp.quantity >= 25 and lastp.material is not null then lastp.material_id end,
    case when lastp.quantity >= 25 and lastp.material is not null
           and lastp.variant_matches_material then lastp.material_variant_id end,
    case when lastp.quantity >= 25 and lastp.material is not null
           and lastp.variant_matches_material then lower(lastp.variant) end,
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
  left join lateral (
    select p.quantity, p.material, p.variant, p.material_id, p.material_variant_id,
      exists (
        select 1 from proofs.material_variants mv2
        where mv2.id = p.material_variant_id
          and mv2.material_id = p.material_id
      ) as variant_matches_material
    from _recon_payments p
    where p.email = r.email
    order by p.paid_at desc, p.payment_key desc
    limit 1
  ) lastp on true
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
