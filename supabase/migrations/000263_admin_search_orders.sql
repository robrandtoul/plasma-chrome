-- 000263_admin_search_orders.sql
-- Phase 1 of the unified order log (docs/order-log-and-tracking-spec.md).
--
-- One searchable/paginated record per proof-viewer order, joined to its Stock
-- Control production job — the COMMERCIAL half (proofs.orders) + the PRODUCTION
-- half (public.orders in-house / public.outsourced_orders outsourced), matched on
-- the 6-digit job number (proofs.orders.stock_order_number ↔ order_ref /
-- customer_order_ref). The production half is null until the order is placed.
--
-- SECURITY DEFINER (owned by postgres) so it can read across both schemas and
-- past Stock Control's RLS for this internal, admin-only report. Access is gated
-- two ways: an explicit admin check on auth.uid() inside the function, and EXECUTE
-- granted only to authenticated (revoked from anon/public). No data is mutated.

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
  -- Admin only (the page is RequireAdmin; enforce server-side too).
  if not exists (
    select 1 from proofs.profiles
    where id = auth.uid() and role = 'admin' and deactivated_at is null
  ) then
    raise exception 'Forbidden' using errcode = '42501';
  end if;

  -- Single statement so the `base` CTE is visible to BOTH the total count and
  -- the page slice (a WITH clause only scopes to the one statement it prefixes).
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
      o.quantity, o.names_count, o.has_personalisation, o.person_quantities,
      o.created_at, o.sent_at, o.paid_at, o.fulfilled_at, o.revised_at, o.expires_at,
      o.pay_link_opened_at, o.date_required,
      o.dropbox_folder_url, o.project_name, o.proof_id,
      o.ship_to_name, o.ship_to_email, o.ship_to_address,
      o.supplier_name     as chosen_supplier,
      comp.name           as company_name,
      c.full_name         as contact_name,
      c.email             as contact_email,
      m.code              as material_code,
      m.display_name      as material,
      mv.display_name     as variant,
      mo.display_name     as finish,
      -- production half (null until placed)
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
