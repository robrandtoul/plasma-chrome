-- 000375 — tell a customer WHEN their cards went, not that they are still going.
--
-- ⚠ TARGET: the MERGED stock-control project (bjvinrzbdrwebylkmbwy), proofs
-- schema. Apply via the dashboard SQL editor / an MCP apply_migration. Do NOT
-- use `supabase db push`.
--
-- A DPD parcel's journey ends at `on_its_way`, because DPD has never once
-- reported a delivery (000370 — 0 of 122, ever). The rail correctly draws three
-- steps and completes. The COPY, though, was written for a parcel in flight:
-- "Your cards are on their way." Three weeks later that is simply false, and
-- the customer reading it is usually someone who came back precisely because
-- the cards arrived a while ago and they want more — the reorder panel's whole
-- population (000372). Present tense there reads as though we have lost track
-- of an order they are holding in their hand.
--
-- So the terminal stage needs a past tense and a date, and this migration
-- carries the date.
--
-- ── Which stamp ─────────────────────────────────────────────────────────────
-- The REAL dispatch stamp on each route, never the trigger that moved the
-- stage:
--   in-house    → public.orders.customer_shipped_at
--   outsourced  → public.outsourced_orders.shipped_to_customer_at
--
-- ⚠ NOT `public.orders.completed_at`, even though that is what flips an
-- in-house order to `on_its_way`. 000370 deliberately kept `completed_at` as
-- the trigger because 64 live orders predate the shipping module and would
-- otherwise march backwards to "In production" — but completed means MADE, not
-- posted. Printing it as "shipped on" would put a specific date, in the
-- customer's hands, on an event we did not record. Where the real stamp is
-- missing the key is simply absent and the copy drops to a dateless past
-- tense. (Checked at author time: all 69 DPD legs and all 26 FedEx legs linked
-- to a proof-viewer order carry the real stamp, so this is a guard, not a
-- common path.)
--
-- ── On exposing it ──────────────────────────────────────────────────────────
-- 000367's rule for /p/:id is "fact, not capability", and 000371 withheld the
-- tracking NUMBER because its holder can act on the parcel — most carriers
-- allow a redirect — while a broadly-shared proof link is "a convenience, not
-- security". A dispatch date is the opposite kind of thing: inert. Nobody can
-- do anything to a parcel with it. It is the customer's own order, and the one
-- fact that makes the sentence true. Everything 000371 refused stays refused.
--
-- Both surfaces are served by this one change: the pay page reads the whole
-- projection through public_get_order's `tracking_projection`, so it inherits
-- the key; /p/:id reads named keys only and gets an explicit third one below.

-- ── 1. The projection carries the stamp ─────────────────────────────────────
-- Body verbatim from live pg_get_functiondef (2026-07-31) with one select
-- column and one output key added per route.
create or replace function proofs._project_order_tracking(
  p_stock_order_number text,
  p_proof_id uuid,
  p_order_status text
)
returns jsonb
language plpgsql
stable security definer
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
  v_shipped_at timestamptz := null;
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
    select status, completed_at, customer_delivered_at, customer_carrier,
           customer_shipped_at
      into ih
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
        -- The real dispatch stamp only — see the header on why completed_at
        -- must not stand in for it.
        v_shipped_at := ih.customer_shipped_at;
      end if;
      return jsonb_strip_nulls(jsonb_build_object(
        'level', v_level,
        'stage', v_stage,
        'delivery_tracked', v_delivery_tracked,
        'shipped_at', v_shipped_at
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
        -- Here the stage trigger and the dispatch stamp are the same column,
        -- so this is exact by construction.
        v_shipped_at := os.shipped_to_customer_at;
      end if;
      if v_level = 'granular' and os.customer_tracking_number is not null then
        v_tracking := os.customer_tracking_number;
      end if;
      return jsonb_strip_nulls(jsonb_build_object(
        'level', v_level,
        'stage', v_stage,
        'delivery_tracked', v_delivery_tracked,
        'shipped_at', v_shipped_at,
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

-- ── 2. /p/:id gets it as an explicit third key ──────────────────────────────
-- ⚠ Named keys only, never `|| proj` — the rule 000371 set and the reason the
-- tracking number has stayed off this page. Body verbatim from live
-- pg_get_functiondef (2026-07-31, the 000374 definition) plus one key.
create or replace function proofs.public_get_proof_order_state(p_proof_id uuid)
returns jsonb
language sql
stable security definer
set search_path to 'proofs', 'public', 'extensions', 'pg_temp'
as $function$
  with resolved as (
    select
      case when og.id is not null and og.status <> 'cancelled'
           then og.status      else o.status      end as eff_status,
      case when og.id is not null and og.status <> 'cancelled'
           then og.expires_at  else o.expires_at  end as eff_expires_at,
      coalesce(o.paid_at, og.paid_at) as eff_paid_at,
      case when og.id is not null and og.status <> 'cancelled'
           then og.pay_link_resend_requested_at
           else o.pay_link_resend_requested_at end as eff_resend_at,
      o.stock_order_number,
      o.status as own_status
    from proofs.orders o
    left join proofs.order_groups og on og.id = o.order_group_id
    where o.proof_id = p_proof_id
  ),
  ranked as (
    select
      r.*,
      case
        when r.eff_paid_at is not null then 'paid'
        when r.eff_status = 'sent'
             and (r.eff_expires_at is null or r.eff_expires_at > now())
          then 'awaiting_payment'
        when r.eff_status = 'sent' then 'link_expired'
        else null
      end as state
    from resolved r
  ),
  -- This ranking also makes the "no live unpaid link" half of the reorder gate
  -- free: a live link outranks a past payment, so state='paid' already implies
  -- nothing is outstanding.
  winner as (
    select *
    from ranked
    where state is not null
    order by case state
               when 'awaiting_payment' then 1
               when 'paid'             then 2
               when 'link_expired'     then 3
             end,
             coalesce(eff_paid_at, eff_expires_at) desc nulls last
    limit 1
  ),
  projected as (
    select
      w.*,
      case when w.state = 'paid'
           then proofs._project_order_tracking(w.stock_order_number, p_proof_id, w.own_status)
      end as proj,
      case when w.state = 'paid'
           then proofs._reorder_quiet_period_passed(w.stock_order_number)
           else false end as quiet_passed
    from winner w
  )
  select coalesce(
    (
      select jsonb_strip_nulls(jsonb_build_object(
        'state', p.state,
        'expires_at', case when p.state = 'awaiting_payment' then p.eff_expires_at end,
        'resend_requested_at', case when p.state = 'awaiting_payment' then p.eff_resend_at end,
        -- ⚠ Three keys only, hand-picked. Never `|| p.proj`.
        'stage',
          case when p.proj ->> 'level' in ('broad', 'granular')
               then p.proj ->> 'stage' end,
        'delivery_tracked',
          case when p.proj ->> 'level' in ('broad', 'granular')
               then (p.proj ->> 'delivery_tracked')::boolean end,
        -- 000375. A date, not a handle: it makes "shipped on the 12th" sayable
        -- and cannot be used to touch the parcel. Absent until dispatch, and
        -- absent afterwards if the real stamp was never written.
        'shipped_at',
          case when p.proj ->> 'level' in ('broad', 'granular')
               then p.proj ->> 'shipped_at' end,
        'reorder_available',
          (select reorder_enabled from proofs.settings where id = 1)
            and p.state = 'paid'
            and p.quiet_passed
            and pr.status = 'approved',
        'reorder_requested_at', pr.reorder_requested_at,
        'reorder_proof_id', pr.reorder_proof_id
      ))
      from projected p
      cross join lateral (
        select
          pp.status,
          pp.reorder_requested_at,
          (
            select child.id
            from proofs.proofs child
            join proofs.proof_versions cpv
              on cpv.proof_id = child.id and cpv.is_current
            where child.reorder_of_proof_id = p_proof_id
              and child.status <> 'abandoned'
              and (child.status = 'approved' or cpv.last_reply_sent_at is not null)
            order by child.created_at desc
            limit 1
          ) as reorder_proof_id
        from proofs.proofs pp
        where pp.id = p_proof_id
      ) pr
    ),
    jsonb_build_object('state', 'none')
  );
$function$;

-- Grants restated to match live exactly. _project_order_tracking is internal
-- (called only from the two RPCs, which are SECURITY DEFINER); the state RPC
-- is anon-callable by design — it is the customer proof page's own read.
revoke execute on function proofs._project_order_tracking(text, uuid, text) from public, anon, authenticated;
revoke execute on function proofs.public_get_proof_order_state(uuid) from public;
grant  execute on function proofs.public_get_proof_order_state(uuid) to anon, authenticated;
