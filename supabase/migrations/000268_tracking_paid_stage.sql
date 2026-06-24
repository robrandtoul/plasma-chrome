-- 000268_tracking_paid_stage.sql
-- Phase 3 follow-up: show the order-tracking strip the moment an order is paid,
-- with a "Paid" stage and the later steps pending — rather than hiding the strip
-- until the order is placed into production.
--
-- _project_order_tracking gains the order's proof_id + status. A placed order
-- still projects its live production stage (unchanged). A PAID-but-not-yet-placed
-- order now returns stage='paid' at the level of the route it will most likely
-- take — predicted from the proof's current version material — so a route the
-- admin set to 'off' still shows nothing (no appear-then-vanish). Signature
-- change → drop the old 1-arg version; public_get_order passes the new args.

-- New 3-arg projection.
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
  v_master boolean;
  v_config jsonb;
  v_level  text;
  v_stage  text := null;
  v_eta    text := null;
  v_route  text;
  ih       record;
  os       record;
begin
  select customer_tracking_enabled, customer_tracking_config
    into v_master, v_config
    from proofs.settings where id = 1;

  if not coalesce(v_master, false) then
    return jsonb_build_object('level', 'off');
  end if;

  -- Placed order: match a Stock Control job by number.
  if p_stock_order_number is not null then
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

    select status, supplier_id, shipped_from_supplier_at, shipped_to_customer_at,
           arrived_at, cancelled_at, tracking_eta
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
      v_stage := case
        when os.arrived_at is not null then 'delivered'
        when os.shipped_to_customer_at is not null or os.shipped_from_supplier_at is not null then 'on_its_way'
        else 'in_production'
      end;
      if v_level = 'granular' and os.tracking_eta is not null then
        v_eta := to_char(os.tracking_eta, 'FMDD Mon YYYY');
      end if;
      return jsonb_strip_nulls(jsonb_build_object(
        'level', v_level,
        'stage', v_stage,
        'eta',   case when v_level = 'granular' then v_eta else null end
      ));
    end if;
  end if;

  -- Paid but not yet in production: show the "Paid" stage with the later steps
  -- pending. Level = the route the order will most likely take, predicted from
  -- the proof's current version material (supplier → outsourced, else in_house),
  -- so a route set to 'off' still shows nothing. supplier_id is unknown until
  -- placement, so outsourced resolves to its route default.
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

-- Point public_get_order at the new signature.
create or replace function proofs.public_get_order(p_order_id uuid, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = proofs, public, extensions, pg_temp
as $$
declare
  o      proofs.orders;
  v_proj jsonb;
begin
  select * into o from proofs.orders
   where id = p_order_id and token = p_token;
  if not found then return null; end if;

  v_proj := proofs._project_order_tracking(o.stock_order_number, o.proof_id, o.status);

  return (to_jsonb(o)
            - 'token'
            - 'stock_order_number'
            - 'supplier_id'
            - 'supplier_name'
            - 'dropbox_folder_url')
         || jsonb_build_object('tracking_projection', v_proj);
end;
$$;

revoke all on function proofs.public_get_order(uuid, text) from public;
grant execute on function proofs.public_get_order(uuid, text) to anon, authenticated;

-- Drop the now-orphaned 1-arg version.
drop function if exists proofs._project_order_tracking(text);
