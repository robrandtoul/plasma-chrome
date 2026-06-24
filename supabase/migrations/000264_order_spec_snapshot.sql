-- 000264_order_spec_snapshot.sql
-- Phase 2 of the unified order log (docs/order-log-and-tracking-spec.md).
--
-- An order's spec is read LIVE from the proof's current version + the live
-- catalogue, so it drifts if the proof is revised or a material is renamed after
-- the order. order_spec_snapshot freezes the spec as at order time. It is stamped
-- by the create-order edge function and OVERWRITTEN at place-order (so it equals
-- the spec actually handed to production). Shape is defined once in
-- supabase/functions/_shared/orderSpecSnapshot.ts; the COALESCE paths below must
-- stay in lockstep with it.
--
-- admin_search_orders now PREFERS the snapshot per spec field, falling back to
-- the live join for orders created before this shipped (snapshot null). Signature
-- is unchanged, so CREATE OR REPLACE preserves the existing grants; we re-state
-- them anyway (defensive, idempotent). The finish fallback additionally resolves
-- metal Brushed/Mirror from the variant (variant_type='finish'), which the live
-- join in 000263 missed entirely — an honesty fix for legacy rows too.

alter table proofs.orders add column if not exists order_spec_snapshot jsonb;

create or replace function proofs.admin_search_orders(
  p_search text default '',
  p_status text default null,
  p_from   date default null,
  p_to     date default null,
  p_sort   text default 'date_desc',
  p_limit  int  default 50,
  p_offset int  default 0
) returns jsonb
language plpgsql
security definer
set search_path = proofs, public, extensions, pg_temp
as $$
declare
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_result jsonb;
begin
  if not exists (
    select 1 from proofs.profiles
    where id = auth.uid() and role = 'admin' and deactivated_at is null
  ) then
    raise exception 'Forbidden' using errcode = '42501';
  end if;

  with base as (
    select
      o.id,
      o.payment_reference,
      o.stock_order_number,
      o.status            as order_status,
      o.payment_method,
      o.currency,
      o.custom_quote_total,
      o.amount_cards, o.amount_tooling, o.amount_personalisation,
      o.amount_shipping, o.amount_us_tariff, o.amount_card_discount,
      o.card_discount_type, o.card_discount_value,
      o.xero_invoice_id, o.xero_invoice_error,
      -- Spec fields prefer the frozen snapshot, fall back to the live join.
      coalesce((o.order_spec_snapshot->>'quantity')::int, o.quantity) as quantity,
      o.names_count, o.has_personalisation,
      coalesce(o.order_spec_snapshot->'person_quantities', o.person_quantities) as person_quantities,
      o.order_spec_snapshot,
      o.created_at, o.sent_at, o.paid_at, o.fulfilled_at, o.revised_at, o.expires_at,
      o.pay_link_opened_at, o.date_required,
      o.dropbox_folder_url, o.project_name, o.proof_id,
      o.ship_to_name, o.ship_to_email, o.ship_to_address,
      o.supplier_name     as chosen_supplier,
      coalesce(o.order_spec_snapshot->'company'->>'name', comp.name)   as company_name,
      c.full_name         as contact_name,
      coalesce(o.order_spec_snapshot->'contact'->>'email', c.email)    as contact_email,
      coalesce(o.order_spec_snapshot->'material'->>'code', m.code)            as material_code,
      coalesce(o.order_spec_snapshot->'material'->>'display_name', m.display_name) as material,
      coalesce(o.order_spec_snapshot->'variant'->>'display_name', mv.display_name) as variant,
      coalesce(
        o.order_spec_snapshot->'finish'->>'display_name',
        mo.display_name,
        case when mv.variant_type = 'finish' then mv.display_name end
      )                   as finish,
      case when ih.order_ref is not null then 'in_house'
           when os.customer_order_ref is not null then 'outsourced'
           else null end                       as production_route,
      coalesce(ih.order_ref, os.customer_order_ref) as job_number,
      ih.status           as inhouse_status,
      ih.produced_at, ih.completed_at,
      os.status           as outsourced_status,
      os.supplier_id,
      sup.name            as production_supplier,
      os.in_production_at, os.shipped_from_supplier_at, os.shipped_to_customer_at,
      os.arrived_at, os.cancelled_at as outsourced_cancelled_at,
      os.expected_ship_date, os.expected_arrival_date,
      os.tracking_status, os.tracking_eta, os.customer_tracking_number,
      os.tracking_last_event_at, os.tracking_last_event_description,
      coalesce(o.paid_at, o.created_at) as sort_date
    from proofs.orders o
    left join proofs.proofs pr             on pr.id = o.proof_id
    left join proofs.contacts c            on c.id = pr.contact_id
    left join proofs.companies comp        on comp.id = c.company_id
    left join proofs.material_variants mv  on mv.id = o.material_variant_id
    left join proofs.materials m           on m.id = mv.material_id
    left join proofs.material_options mo   on mo.id = o.material_option_id
    left join public.orders ih             on ih.order_ref = o.stock_order_number
    left join public.outsourced_orders os  on os.customer_order_ref = o.stock_order_number
    left join public.outsourced_suppliers sup on sup.id = os.supplier_id
    where
      (p_status is null or p_status = 'all' or o.status = p_status)
      and (p_from is null or coalesce(o.paid_at, o.created_at)::date >= p_from)
      and (p_to   is null or coalesce(o.paid_at, o.created_at)::date <= p_to)
      and (
        v_search is null
        or comp.name           ilike '%' || v_search || '%'
        or c.full_name         ilike '%' || v_search || '%'
        or c.email             ilike '%' || v_search || '%'
        or o.payment_reference  ilike '%' || v_search || '%'
        or o.stock_order_number ilike '%' || v_search || '%'
        or o.xero_invoice_id    ilike '%' || v_search || '%'
        or o.project_name       ilike '%' || v_search || '%'
      )
  )
  select jsonb_build_object(
    'total', (select count(*) from base),
    'orders', coalesce(
      (select jsonb_agg(to_jsonb(b) - 'sort_date')
       from (
         select * from base
         order by sort_date desc nulls last
         limit greatest(1, least(coalesce(p_limit, 50), 200))
         offset greatest(0, coalesce(p_offset, 0))
       ) b),
      '[]'::jsonb)
  )
  into v_result;

  return v_result;
end;
$$;

revoke execute on function proofs.admin_search_orders(text, text, date, date, text, int, int) from public, anon;
grant  execute on function proofs.admin_search_orders(text, text, date, date, text, int, int) to authenticated;
