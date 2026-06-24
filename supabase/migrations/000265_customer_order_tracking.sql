-- 000265_customer_order_tracking.sql
-- Phase 3 of the unified order log (docs/order-log-and-tracking-spec.md).
--
-- A coarse, SERVER-COMPUTED customer order-tracking projection, shown on the
-- pay-page "paid" state behind an OFF-by-default master switch with per-route /
-- per-supplier disclosure levels. The customer only ever receives the resolved
-- {level, stage, eta?} — never a raw Stock Control row, status string, or
-- supplier date. Ships dormant: customer_tracking_enabled defaults false, so
-- apply-time behaviour is unchanged for customers.
--
-- Security notes (house pattern):
--  * The two helpers below are revoked from anon/public/authenticated — anon's
--    ONLY entry stays public_get_order, which calls the projection internally.
--    (Were _project_order_tracking anon-callable, anyone could enumerate any
--     job's production status by job number.)
--  * customer_tracking_config is deliberately NOT exposed via public_settings()
--    — the per-route/per-supplier disclosure map (incl. the supplier list) must
--    not reach anon.
--  * This migration also CLOSES a pre-existing leak: public_get_order returned
--    to_jsonb(o) - 'token' (the whole order row), exposing stock_order_number /
--    supplier_id / supplier_name / dropbox_folder_url to anon. The rewrite
--    strips those internal columns too. OrderPayPage (the sole caller) reads
--    none of them.

-- ── Settings (singleton, id=1) ──────────────────────────────────────────────
alter table proofs.settings
  add column if not exists customer_tracking_enabled boolean not null default false,
  add column if not exists customer_tracking_config  jsonb   not null
    default '{"inhouse":"granular","outsourced_default":"broad","suppliers":{}}'::jsonb;

update proofs.settings
   set customer_tracking_config = '{"inhouse":"granular","outsourced_default":"broad","suppliers":{}}'::jsonb
 where id = 1 and customer_tracking_config is null;

-- ── Disclosure resolver (pure) ──────────────────────────────────────────────
-- (master_enabled, config, route, supplier_id) -> 'off' | 'broad' | 'granular'.
-- Master off -> off; in_house -> config.inhouse (default granular); outsourced ->
-- supplier override wins, else outsourced_default (default broad). A malformed
-- config silently degrades to the safe defaults (never throws).
create or replace function proofs._resolve_tracking_level(
  p_master      boolean,
  p_config      jsonb,
  p_route       text,
  p_supplier_id uuid
) returns text
language sql
immutable
set search_path = proofs, public, extensions, pg_temp
as $$
  select case
    when not coalesce(p_master, false) then 'off'
    when p_route = 'in_house' then coalesce(nullif(p_config->>'inhouse', ''), 'granular')
    when p_route = 'outsourced' then coalesce(
      nullif(p_config->'suppliers'->>(p_supplier_id::text), ''),
      nullif(p_config->>'outsourced_default', ''),
      'broad'
    )
    else 'off'
  end;
$$;

revoke all on function proofs._resolve_tracking_level(boolean, jsonb, text, uuid) from public, anon, authenticated;

-- ── Stage projection (cross-schema, server-only) ────────────────────────────
-- Given the order's job number, derive the route by matching Stock Control (one
-- order matches at most one route), resolve the disclosure level, and map the
-- production status/timestamps to a customer-safe stage. Returns ONLY the
-- projected object. SAFETY: 'on_its_way' fires only once genuinely shipped
-- (in-house completed_at / outsourced shipped_*_at), so a slipping supplier
-- shows only "In production"; at broad level no date is ever included.
create or replace function proofs._project_order_tracking(p_stock_order_number text)
returns jsonb
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
  ih       record;
  os       record;
begin
  if p_stock_order_number is null then
    return jsonb_build_object('level', 'off');
  end if;

  select customer_tracking_enabled, customer_tracking_config
    into v_master, v_config
    from proofs.settings where id = 1;

  if not coalesce(v_master, false) then
    return jsonb_build_object('level', 'off');
  end if;

  -- In-house first (a job number matches one route).
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
    -- In-house tops out at completed_at; no shipping/tracking fields, so no ETA
    -- even at granular. 'On its way' only when completed_at is genuinely set.
    v_stage := case when ih.completed_at is not null then 'on_its_way' else 'in_production' end;
    return jsonb_strip_nulls(jsonb_build_object('level', v_level, 'stage', v_stage));
  end if;

  -- Outsourced.
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
    -- Granular adds the ETA (date only). Gated to granular here AND re-gated in
    -- the output object, so a broad projection can never carry a date.
    if v_level = 'granular' and os.tracking_eta is not null then
      v_eta := to_char(os.tracking_eta, 'FMDD Mon YYYY');
    end if;
    return jsonb_strip_nulls(jsonb_build_object(
      'level', v_level,
      'stage', v_stage,
      'eta',   case when v_level = 'granular' then v_eta else null end
    ));
  end if;

  -- Paid but no production job yet -> nothing beyond "Paid".
  return jsonb_build_object('level', 'off');
end;
$$;

revoke all on function proofs._project_order_tracking(text) from public, anon, authenticated;

-- ── public_get_order rewrite ────────────────────────────────────────────────
-- Token validation unchanged (id + secret token). Now strips the internal
-- production columns (leak fix) and appends the computed tracking_projection.
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

  v_proj := proofs._project_order_tracking(o.stock_order_number);

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
