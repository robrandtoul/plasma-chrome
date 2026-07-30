-- 000370 — the customer tracking rail can finally say "Delivered", and stops
-- showing a step it can never reach.
--
-- 000269 removed the `delivered` stage outright, for a good reason at the time:
--
--   "no 'Delivered' — we have no signal for when the customer actually
--    receives it (the outbound carrier isn't synced), so the journey honestly
--    tops out at 'On its way' and the Delivered step stays pending in the UI"
--
-- That is no longer true. Stock Control now syncs the OUTBOUND parcel on both
-- routes: public.orders.customer_delivered_at and
-- public.outsourced_orders.customer_delivered_at, alongside customer_carrier /
-- customer_shipped_at / customer_tracking_number. Live at authoring time: 65
-- delivered stamps across the two tables, and the ordering is clean — zero rows
-- are delivered-but-not-shipped on either table.
--
-- ── The DPD problem, and why this migration is more than one CASE arm ────────
--
-- Delivery sync is carrier-dependent, and the split on live is stark:
--
--     carrier   shipped   delivered
--     fedex          70          65     (93% — reliable)
--     dpd           122           0     (never, on any row, ever)
--
-- DPD is the domestic UK carrier, so simply emitting 'delivered' would leave
-- roughly two thirds of all parcels — every UK order — parked on "On its way"
-- for good, staring at a greyed-out fourth step that will never light up. That
-- is worse than today's honest-but-uniform "nobody ever sees step 4", because
-- the failure would now look specific to the person reading it.
--
-- So the projection also reports whether this parcel's delivery is trackable at
-- all, and the rail renders only the steps it can actually reach: four for a
-- FedEx parcel, three for a DPD one, each ending in a state it can finish in.
--
--   delivery_tracked = true   → a Delivered step exists and will arrive
--   delivery_tracked = false  → journey honestly ends at On its way; hide it
--   delivery_tracked absent   → not shipped yet, carrier unknown, say nothing
--
-- The carrier allow-list is deliberately a literal rather than anything
-- cleverer (e.g. "has this carrier ever reported a delivery?"), because a
-- stateful test would flip the shape of a live customer's progress bar the
-- first time a sync landed. If DPD delivery sync ships, this is a one-word
-- change; until then the honest answer is a shorter bar.
--
-- ⚠ WHAT THIS DELIBERATELY DOES NOT CHANGE. The "On its way" trigger stays
-- `completed_at` for in-house, NOT the newer `customer_shipped_at`. On live,
-- 116 in-house orders are completed but only 52 carry a shipped stamp — the
-- shipping module postdates most of them — so switching would drag 64 orders
-- BACKWARDS from "On its way" to "In production" on a page their customers may
-- already have seen. A progress bar that goes backwards is worse than one
-- that's approximate. Same reason the outsourced trigger stays
-- shipped_to_customer_at.
--
-- Rebuilt from the LIVE pg_get_functiondef, not from 000269's file — the house
-- rule after 000347/000363. Signature unchanged, so CREATE OR REPLACE keeps the
-- grants and the SECURITY DEFINER marking.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via MCP apply_migration / the dashboard SQL editor. Never
-- `supabase db push`.

-- ── Does this carrier tell us when the parcel arrived? ──────────────────────
-- One place for the allow-list, because the answer is read twice below and a
-- drifting copy would give in-house and outsourced parcels different-length
-- progress bars for the same carrier.
--
-- ⚠ EXECUTE is revoked from anon/authenticated per the 000356 lesson: the
-- proofs schema has no pg_default_acl entry for functions, so a new function is
-- born EXECUTE TO PUBLIC, anon holds schema USAGE, and PostgREST serves it —
-- omit the revoke and this is callable from the public internet. It leaks
-- nothing, but the discipline is the point.
create or replace function proofs._carrier_reports_delivery(p_carrier text)
returns boolean
language sql
immutable
set search_path to 'proofs', 'public', 'extensions', 'pg_temp'
as $function$
  select lower(coalesce(p_carrier, '')) = 'fedex';
$function$;

revoke all on function proofs._carrier_reports_delivery(text) from public, anon, authenticated;

comment on function proofs._carrier_reports_delivery(text) is
  'Carriers whose delivery events Stock Control syncs. FedEx only as of 000370 '
  '(live: 65 of 70 shipped FedEx parcels carry customer_delivered_at; 0 of 122 '
  'DPD ones ever have). Drives whether the customer progress bar shows a '
  'Delivered step at all. Add a carrier here the day its sync lands.';

create or replace function proofs._project_order_tracking(
  p_stock_order_number text,
  p_proof_id           uuid,
  p_order_status       text
) returns jsonb
language plpgsql
stable
security definer
set search_path to 'proofs', 'public', 'extensions', 'pg_temp'
as $function$
declare
  v_master   boolean;
  v_config   jsonb;
  v_level    text;
  v_stage    text := null;
  v_tracking text := null;
  v_route    text;
  v_delivery_tracked boolean := null;
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
    select status, completed_at, customer_delivered_at, customer_carrier into ih
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
      -- Delivered first: it is the only one of the three backed by a carrier
      -- event rather than one of our own stamps, so it must win outright.
      v_stage := case
                   when ih.customer_delivered_at is not null then 'delivered'
                   when ih.completed_at is not null          then 'on_its_way'
                   else 'in_production'
                 end;
      if v_stage in ('on_its_way', 'delivered') then
        v_delivery_tracked := proofs._carrier_reports_delivery(ih.customer_carrier);
      end if;
      return jsonb_strip_nulls(jsonb_build_object(
        'level', v_level,
        'stage', v_stage,
        'delivery_tracked', v_delivery_tracked
      ));
    end if;

    select status, supplier_id, shipped_to_customer_at, cancelled_at,
           customer_tracking_number, customer_delivered_at, customer_carrier
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
      -- Outbound leg only, per 000269: shipped_from_supplier_at / arrived_at
      -- are the supplier -> us parcel and mean nothing to the customer.
      v_stage := case
                   when os.customer_delivered_at is not null then 'delivered'
                   when os.shipped_to_customer_at is not null then 'on_its_way'
                   else 'in_production'
                 end;
      if v_stage in ('on_its_way', 'delivered') then
        v_delivery_tracked := proofs._carrier_reports_delivery(os.customer_carrier);
      end if;
      if v_level = 'granular' and os.customer_tracking_number is not null then
        v_tracking := os.customer_tracking_number;
      end if;
      return jsonb_strip_nulls(jsonb_build_object(
        'level', v_level,
        'stage', v_stage,
        'delivery_tracked', v_delivery_tracked,
        'tracking_number', case when v_level = 'granular' then v_tracking else null end
      ));
    end if;
  end if;

  -- Paid, but no Stock Control job yet. No carrier exists, so delivery_tracked
  -- stays absent and the rail shows its full length until we know better.
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
$function$;

comment on function proofs._project_order_tracking(text, uuid, text) is
  'Customer-facing order progress. Stages: paid -> in_production -> on_its_way '
  '-> delivered (000370). Reads the OUTBOUND (us -> customer) leg only — the '
  'inbound supplier parcel''s stamps mean nothing to the customer (000269). '
  '`delivery_tracked` false means this carrier never reports delivery, so the '
  'UI must drop the Delivered step rather than strand the customer on a bar '
  'that cannot finish. ⚠ Do not move the in-house "on its way" trigger off '
  'completed_at: 64 live orders predate customer_shipped_at and would go '
  'backwards.';
