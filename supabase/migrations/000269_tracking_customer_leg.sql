-- 000269_tracking_customer_leg.sql
-- Fix the outsourced customer-tracking projection to read the CUSTOMER leg only.
--
-- An outsourced order has two parcels: inbound (supplier → PlasmaDesign,
-- public.outsourced_orders.tracking_number) and outbound (PlasmaDesign →
-- customer, customer_tracking_number). Stock Control's synced tracking_status /
-- tracking_eta are for the INBOUND parcel — verified against live data: the two
-- tracking numbers are always different, `arrived` (at Plasma) always precedes
-- `shipped_to_customer`, and tracking_eta is the supplier→Plasma date. So the
-- previous projection was wrong for the customer:
--   * "On its way" fired on shipped_from_supplier_at (the inbound leg);
--   * "Delivered" fired on arrived_at (arrival at Plasma, not the customer);
--   * the granular ETA was the inbound supplier date.
--
-- Corrected, customer-centric mapping (outsourced):
--   * everything up to and including "arrived at Plasma" → In production;
--   * On its way only once we dispatch to the customer (shipped_to_customer_at);
--   * no "Delivered" — we have no signal for when the customer actually receives
--     it (the outbound carrier isn't synced), so the journey honestly tops out at
--     "On its way" and the Delivered step stays pending in the UI;
--   * no inbound ETA. At GRANULAR we instead surface the customer's OUTBOUND
--     tracking number (customer_tracking_number) so they can look it up.
-- In-house is unchanged (no carrier leg; In production → On its way at completed).
-- Same signature as 000268, so CREATE OR REPLACE preserves grants.

create or replace function proofs._project_order_tracking(
  p_stock_order_number text,
  p_proof_id           uuid,
  p_order_status       text
) returns jsonb
language plpgsql
stable
security definer
set search_path = proofs, public, extensions, pg_temp
as $$
declare
  v_master   boolean;
  v_config   jsonb;
  v_level    text;
  v_stage    text := null;
  v_tracking text := null;
  v_route    text;
  ih         record;
  os         record;
begin
  select customer_tracking_enabled, customer_tracking_config
    into v_master, v_config
    from proofs.settings where id = 1;

  if not coalesce(v_master, false) then
    return jsonb_build_object('level', 'off');
  end if;

  if p_stock_order_number is not null then
    -- In-house: no carrier leg; tops out at completed.
    select status, completed_at into ih
      from public.orders
     where order_ref = p_stock_order_number
     limit 1;

    if found then
      if ih.status = 'cancelled' then
        return jsonb_build_object('level', 'off');
      end if;
      v_level := proofs._resolve_tracking_level(v_master, v_config, 'in_house', null);
      if v_level not in ('broad', 'granular') then
        return jsonb_build_object('level', 'off');
      end if;
      v_stage := case when ih.completed_at is not null then 'on_its_way' else 'in_production' end;
      return jsonb_strip_nulls(jsonb_build_object('level', v_level, 'stage', v_stage));
    end if;

    -- Outsourced: the customer only cares about the OUTBOUND leg (us → them).
    select status, supplier_id, shipped_to_customer_at, cancelled_at, customer_tracking_number
      into os
      from public.outsourced_orders
     where customer_order_ref = p_stock_order_number
     limit 1;

    if found then
      if os.status = 'cancelled' or os.cancelled_at is not null then
        return jsonb_build_object('level', 'off');
      end if;
      v_level := proofs._resolve_tracking_level(v_master, v_config, 'outsourced', os.supplier_id);
      if v_level not in ('broad', 'granular') then
        return jsonb_build_object('level', 'off');
      end if;
      -- On its way ONLY once we've dispatched to the customer. Everything before
      -- that (in production / inbound from supplier / arrived at us) is "in
      -- production" to the customer. No "delivered" — we can't see the outbound
      -- carrier's delivery.
      v_stage := case when os.shipped_to_customer_at is not null then 'on_its_way' else 'in_production' end;
      -- Granular surfaces the customer's own (outbound) tracking number, once set.
      if v_level = 'granular' and os.customer_tracking_number is not null then
        v_tracking := os.customer_tracking_number;
      end if;
      return jsonb_strip_nulls(jsonb_build_object(
        'level', v_level,
        'stage', v_stage,
        'tracking_number', case when v_level = 'granular' then v_tracking else null end
      ));
    end if;
  end if;

  -- Paid but not yet in production: show the "Paid" stage with later steps
  -- pending, at the level of the route the order will most likely take.
  if p_order_status = 'paid' then
    select case when m.production_route = 'supplier' then 'outsourced' else 'in_house' end
      into v_route
      from proofs.proof_versions pv
      join proofs.materials m on m.id = pv.material_id
     where pv.proof_id = p_proof_id and pv.is_current = true
     limit 1;
    v_level := proofs._resolve_tracking_level(v_master, v_config, coalesce(v_route, 'in_house'), null);
    if v_level in ('broad', 'granular') then
      return jsonb_build_object('level', v_level, 'stage', 'paid');
    end if;
  end if;

  return jsonb_build_object('level', 'off');
end;
$$;

revoke all on function proofs._project_order_tracking(text, uuid, text) from public, anon, authenticated;
